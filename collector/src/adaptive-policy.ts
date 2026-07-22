export type AdaptiveBand = 'active' | 'recent' | 'idle' | 'failure_backoff'

export interface AdaptiveScheduleState {
  version: 1
  band: AdaptiveBand
  next_eligible_at: string
  last_activity_at: string | null
  last_completed_at: string | null
  consecutive_empty: number
  consecutive_failures: number
  probe: Record<string, string>
}

export interface AdaptivePolicyOptions {
  activeMinutes?: number
  recentMinutes?: number
  idleMinutes?: number
  failureBackoffMinutes?: readonly number[]
  activeEmptyRuns?: number
  recentEmptyRuns?: number
}

export const DEFAULT_ADAPTIVE_POLICY = {
  activeMinutes: 1,
  recentMinutes: 3,
  idleMinutes: 15,
  failureBackoffMinutes: [2, 5, 15, 30] as const,
  activeEmptyRuns: 3,
  recentEmptyRuns: 5,
} satisfies Required<AdaptivePolicyOptions>

export interface AdmissionDecision {
  run: boolean
  reason: 'due' | 'force' | 'activity' | 'not_due'
}

export interface SuccessOutcome {
  activityObserved: boolean
  emitted: number
}

function iso(now: Date): string {
  return now.toISOString()
}

function addMinutes(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString()
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value != null && value > 0 ? value : fallback
}

function policy(options: AdaptivePolicyOptions = {}): Required<AdaptivePolicyOptions> {
  const backoff = options.failureBackoffMinutes ?? DEFAULT_ADAPTIVE_POLICY.failureBackoffMinutes
  if (backoff.length === 0 || backoff.some(item => !Number.isSafeInteger(item) || item < 1)) {
    throw new Error('failureBackoffMinutes must contain positive integers')
  }
  return {
    activeMinutes: positiveInteger(options.activeMinutes, DEFAULT_ADAPTIVE_POLICY.activeMinutes),
    recentMinutes: positiveInteger(options.recentMinutes, DEFAULT_ADAPTIVE_POLICY.recentMinutes),
    idleMinutes: positiveInteger(options.idleMinutes, DEFAULT_ADAPTIVE_POLICY.idleMinutes),
    failureBackoffMinutes: backoff,
    activeEmptyRuns: positiveInteger(options.activeEmptyRuns, DEFAULT_ADAPTIVE_POLICY.activeEmptyRuns),
    recentEmptyRuns: positiveInteger(options.recentEmptyRuns, DEFAULT_ADAPTIVE_POLICY.recentEmptyRuns),
  }
}

function intervalForBand(
  band: AdaptiveBand,
  state: AdaptiveScheduleState,
  options: AdaptivePolicyOptions,
): number {
  const config = policy(options)
  if (band === 'active') return config.activeMinutes
  if (band === 'recent') return config.recentMinutes
  if (band === 'idle') return config.idleMinutes
  const index = Math.min(
    Math.max(state.consecutive_failures - 1, 0),
    config.failureBackoffMinutes.length - 1,
  )
  return config.failureBackoffMinutes[index]
}

export function emptyAdaptiveState(now = new Date()): AdaptiveScheduleState {
  return {
    version: 1,
    band: 'active',
    next_eligible_at: now.toISOString(),
    last_activity_at: null,
    last_completed_at: null,
    consecutive_empty: 0,
    consecutive_failures: 0,
    probe: {},
  }
}

export function decideAdmission(
  state: AdaptiveScheduleState,
  now = new Date(),
  options: { force?: boolean; activityObserved?: boolean } = {},
): AdmissionDecision {
  if (options.force) return { run: true, reason: 'force' }
  if (options.activityObserved) return { run: true, reason: 'activity' }
  const lastCompleted = Date.parse(state.last_completed_at ?? '')
  if (Number.isFinite(lastCompleted) && now.getTime() < lastCompleted) {
    return { run: true, reason: 'due' }
  }
  const next = Date.parse(state.next_eligible_at)
  if (!Number.isFinite(next) || now.getTime() >= next) return { run: true, reason: 'due' }
  return { run: false, reason: 'not_due' }
}

export function recordSuccess(
  previous: AdaptiveScheduleState,
  outcome: SuccessOutcome,
  now = new Date(),
  options: AdaptivePolicyOptions = {},
): AdaptiveScheduleState {
  const config = policy(options)
  const active = outcome.activityObserved || outcome.emitted > 0
  let band: AdaptiveBand = previous.band
  let empty = active ? 0 : previous.consecutive_empty + 1
  if (active) band = 'active'
  else if (previous.band === 'active' && empty >= config.activeEmptyRuns) band = 'recent'
  else if (previous.band === 'recent' && empty >= config.activeEmptyRuns + config.recentEmptyRuns) band = 'idle'
  else if (previous.band === 'failure_backoff') band = 'recent'
  const next: AdaptiveScheduleState = {
    ...previous,
    band,
    last_activity_at: active ? iso(now) : previous.last_activity_at,
    last_completed_at: iso(now),
    consecutive_empty: empty,
    consecutive_failures: 0,
  }
  return { ...next, next_eligible_at: addMinutes(now, intervalForBand(band, next, config)) }
}

export function recordFailure(
  previous: AdaptiveScheduleState,
  now = new Date(),
  options: AdaptivePolicyOptions = {},
): AdaptiveScheduleState {
  const next: AdaptiveScheduleState = {
    ...previous,
    band: 'failure_backoff',
    last_completed_at: iso(now),
    consecutive_failures: previous.consecutive_failures + 1,
  }
  return { ...next, next_eligible_at: addMinutes(now, intervalForBand('failure_backoff', next, options)) }
}

export function promisedIntervalMinutes(
  state: AdaptiveScheduleState,
  options: AdaptivePolicyOptions = {},
): number {
  return intervalForBand(state.band, state, options)
}

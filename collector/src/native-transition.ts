import {
  advanceCheckpoint,
  buildCollectionWindow,
  DEFAULT_OVERLAP_MS,
  type CollectorState,
} from './collector-state.js'
import type { CollectionWindow } from './adapters/types.js'
import type { NativeProvider, SourceAuthorityState } from './server-client.js'

export const FULL_HISTORY_CUTOVER = '1970-01-01T00:00:00.000Z'

function overlapCutover(until: string): string {
  return new Date(Date.parse(until) - DEFAULT_OVERLAP_MS).toISOString()
}

export interface NativeCollectionPlan {
  provider: NativeProvider
  window: CollectionWindow
  bootstrap_since: string | null
  pending_cutover: string | null
  collect_legacy: boolean
}

export function finalizableNativePlans(
  plans: NativeCollectionPlan[],
  successfulSources: ReadonlySet<string>,
): NativeCollectionPlan[] {
  return plans.filter(plan => successfulSources.has(plan.provider)
    && (!plan.collect_legacy || successfulSources.has('cc-switch')))
}

export function planNativeCollection(
  options: {
    authority: SourceAuthorityState
    checkpoint: string | undefined
    until: string
    legacyAvailable: boolean
  },
): NativeCollectionPlan {
  const { authority, checkpoint, until, legacyAvailable } = options
  if (authority.cutover_at) {
    return {
      provider: authority.provider,
      window: buildCollectionWindow(until, { cutoverAt: authority.cutover_at }),
      bootstrap_since: buildCollectionWindow(
        until, { cutoverAt: authority.cutover_at, checkpoint },
      ).since ?? null,
      pending_cutover: null,
      collect_legacy: false,
    }
  }
  const pendingCutover = authority.legacy_history
    ? legacyAvailable ? overlapCutover(until) : authority.legacy_coverage_end ?? until
    : FULL_HISTORY_CUTOVER
  const authorityFloor = authority.legacy_history ? pendingCutover : null
  return {
    provider: authority.provider,
    window: buildCollectionWindow(until, { cutoverAt: authorityFloor }),
    bootstrap_since: buildCollectionWindow(
      until, { cutoverAt: authorityFloor, checkpoint },
    ).since ?? null,
    pending_cutover: pendingCutover,
    collect_legacy: authority.legacy_history && legacyAvailable,
  }
}

interface FinalizeNativeProgressOptions {
  plans: NativeCollectionPlan[]
  state: CollectorState
  deviceId: string
  until: string
  commit: (provider: NativeProvider, cutoverAt: string) => Promise<void>
  stage?: (state: CollectorState) => void
  save: (state: CollectorState) => Promise<void>
}

export async function finalizeNativeProgress(
  options: FinalizeNativeProgressOptions,
): Promise<void> {
  const { plans, state, deviceId, until, commit, stage, save } = options
  for (const plan of plans) {
    if (plan.pending_cutover) await commit(plan.provider, plan.pending_cutover)
  }
  stage?.(state)
  for (const plan of plans) {
    advanceCheckpoint(state, {
      deviceId, provider: plan.provider, checkpoint: until,
    })
  }
  await save(state)
}

export async function finalizeAfterSuccessfulIngest<T>(
  ingest: () => Promise<T>,
  finalize: () => Promise<void>,
): Promise<T> {
  const result = await ingest()
  await finalize()
  return result
}

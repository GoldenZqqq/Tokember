import { createHash } from 'crypto'
import { stat } from 'fs/promises'

const MAX_SOURCES = 32
const MAX_PATHS_PER_SOURCE = 256

export interface ActivityProbePlan {
  source: string
  paths: readonly string[]
}

export interface ActivityProbeResult {
  signatures: Record<string, string>
  activityObserved: boolean
  uncertain: boolean
  changedSources: string[]
  uncertainSources: string[]
  inspected: number
}

type StatPath = (path: string) => Promise<{
  isDirectory(): boolean
  mtimeMs: number
  size: number
}>

const statPathDefault: StatPath = path => stat(path)

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null
}

async function pathSignature(path: string, statPath: StatPath): Promise<{
  value: string
  uncertain: boolean
}> {
  try {
    const info = await statPath(path)
    return {
      value: `${info.isDirectory() ? 'd' : 'f'}:${info.mtimeMs}:${info.size}`,
      uncertain: false,
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { value: 'missing', uncertain: false }
    return { value: 'uncertain', uncertain: true }
  }
}

export async function probeActivity(
  plans: readonly ActivityProbePlan[],
  previous: Readonly<Record<string, string>>,
  statPath: StatPath = statPathDefault,
): Promise<ActivityProbeResult> {
  if (plans.length > MAX_SOURCES) throw new Error('activity probe has too many sources')
  const signatures: Record<string, string> = {}
  const uncertainSources: string[] = []
  let inspected = 0
  for (const plan of plans) {
    if (!/^[a-z0-9-]{1,80}$/.test(plan.source)) throw new Error('invalid activity probe source')
    const paths = [...new Set(plan.paths)].sort()
    if (paths.length > MAX_PATHS_PER_SOURCE) throw new Error('activity probe has too many paths')
    const hash = createHash('sha256')
    let sourceUncertain = false
    for (const path of paths) {
      const result = await pathSignature(path, statPath)
      hash.update(path).update('\0').update(result.value).update('\0')
      sourceUncertain ||= result.uncertain
      inspected += 1
    }
    signatures[plan.source] = hash.digest('hex')
    if (sourceUncertain) uncertainSources.push(plan.source)
  }
  const changedSources = Object.entries(signatures)
    .filter(([source, value]) => previous[source] != null && previous[source] !== value)
    .map(([source]) => source)
    .sort()
  uncertainSources.sort()
  return {
    signatures,
    activityObserved: changedSources.length > 0,
    uncertain: uncertainSources.length > 0,
    changedSources,
    uncertainSources,
    inspected,
  }
}

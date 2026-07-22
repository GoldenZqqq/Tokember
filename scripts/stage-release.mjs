import { resolve } from 'node:path'
import { stageRelease } from './release-lib.mjs'

function argumentsMap(args) {
  const result = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value == null) throw new Error('invalid stage-release arguments')
    result.set(key.slice(2), value)
  }
  return result
}

const args = argumentsMap(process.argv.slice(2))
const metadata = await stageRelease({
  workspaceRoot: resolve(args.get('workspace') ?? '.'),
  outputDir: resolve(args.get('output') ?? 'stage'),
  commit: args.get('commit'),
  builtAt: args.get('built-at'),
  nodeVersion: args.get('node-version') ?? process.version,
  architecture: args.get('architecture') ?? process.arch,
})
console.log(`Staged release ${metadata.release_id}`)

#!/usr/bin/env node
/**
 * Write server image manifest for Release notes / artifacts.
 *
 * Usage:
 *   node scripts/package-image-manifest.mjs \
 *     --output image-manifest.json \
 *     --version 0.1.0 \
 *     --commit <40-char-sha> \
 *     --image linux/amd64=ghcr.io/org/tokember:0.1.0@sha256:... \
 *     --image linux/arm64=ghcr.io/org/tokember:0.1.0@sha256:...
 *
 * Image value may be "tag" or "tag@sha256:hex".
 */
import { writeImageManifestFile } from './release-lib.mjs'
import { resolve } from 'node:path'

function parseArgs(argv) {
  const options = { images: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--output') options.output = argv[++i]
    else if (arg === '--version') options.version = argv[++i]
    else if (arg === '--commit') options.commit = argv[++i]
    else if (arg === '--image') {
      const value = argv[++i] || ''
      const eq = value.indexOf('=')
      if (eq <= 0) throw new Error(`invalid --image ${value}`)
      const platform = value.slice(0, eq)
      const rest = value.slice(eq + 1)
      const at = rest.lastIndexOf('@')
      if (at > 0 && rest.slice(at + 1).startsWith('sha256:')) {
        options.images.push({
          platform,
          tag: rest.slice(0, at),
          digest: rest.slice(at + 1),
        })
      } else {
        options.images.push({ platform, tag: rest, digest: null })
      }
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!options.output || !options.version || !options.commit) {
    throw new Error('--output, --version, and --commit are required')
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const manifest = await writeImageManifestFile(resolve(options.output), {
  version: options.version,
  commit: options.commit,
  images: options.images.map(image => ({
    platform: image.platform,
    tag: image.tag,
    ...(image.digest ? { digest: image.digest } : {}),
  })),
})
console.log(JSON.stringify(manifest, null, 2))

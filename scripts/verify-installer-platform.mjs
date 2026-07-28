#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const INSTALLER_PATH = fileURLToPath(new URL('../collector/install.mjs', import.meta.url))
const PLATFORM_MARKERS = {
  win32: { label: 'Task Scheduler', marker: 'register task tokember-collector' },
  darwin: { label: 'launchd', marker: 'Library/LaunchAgents/com.tokember.collector.plist' },
  linux: { label: 'systemd', marker: 'tokember-collector.timer' },
}

export function assertInstallerPlan(options) {
  const platform = PLATFORM_MARKERS[options.platform]
  if (!platform) throw new Error(`unsupported release-gate platform: ${options.platform}`)
  const interval = options.schedule === 'adaptive' ? 1 : options.schedule === 'fixed' ? 30 : 0
  if (!interval) throw new Error(`unsupported installer schedule: ${options.schedule}`)
  const plan = `DRY-RUN install schedule=${options.schedule} interval=${interval}m`
  if (!options.output.includes(plan)) {
    throw new Error(`installer dry-run missing ${options.schedule} schedule plan on ${options.platform}`)
  }
  if (!options.output.includes(platform.marker)) {
    throw new Error(`installer dry-run missing ${platform.label} scheduler marker on ${options.platform}`)
  }
}

function runDryRun(schedule, options = {}) {
  const platform = options.platform ?? process.platform
  const result = spawnSync(options.nodePath ?? process.execPath, [
    options.installerPath ?? INSTALLER_PATH,
    'dry-run', '--schedule', schedule,
  ], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  process.stdout.write(`[${platform}/${schedule}]\n${output}`)
  if (result.error || result.status !== 0) {
    throw new Error(`installer dry-run failed on ${platform} (${schedule}, exit ${result.status ?? 'spawn'})`)
  }
  assertInstallerPlan({ platform, schedule, output })
}

export function verifyInstallerPlatform(options = {}) {
  const platform = options.platform ?? process.platform
  if (!PLATFORM_MARKERS[platform]) throw new Error(`unsupported release-gate platform: ${platform}`)
  runDryRun('adaptive', options)
  runDryRun('fixed', options)
  process.stdout.write(`installer platform gate passed: ${platform}\n`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    verifyInstallerPlatform()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

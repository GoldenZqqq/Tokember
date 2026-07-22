#!/usr/bin/env node
/**
 * Cross-platform entry for Tokember native collector installers.
 * Dispatches to setup-collector.ps1 (Windows) or setup-collector.sh (Unix).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeDiagnosticReport } from './diagnostics.mjs'

const ACTIONS = new Set(['install', 'upgrade', 'uninstall', 'doctor', 'diagnose', 'collect', 'dry-run', 'help'])

function usage() {
  return `Tokember collector installer

Usage:
  node collector/install.mjs <action> [options]

Actions:
  install     Install or re-register the scheduled collector (default)
  upgrade     Same as install (preserves collector.env and state)
  uninstall   Remove scheduler + generated runners
  doctor      Diagnose runtime, config, sources, and scheduler
  diagnose    Write an anonymous allowlist report (requires --output)
  collect     Run one collection now (--force when adaptive)
  dry-run     Print the plan without changing the system
  help        Show this message

Options:
  --schedule adaptive|fixed   Schedule mode (default adaptive)
  --output <file>             Diagnostic output path (diagnose only)
  --overwrite                 Explicitly replace an existing diagnostic file
  --purge                     With uninstall: also remove collector.env and local log
`
}

function parseArgs(argv) {
  const options = { schedule: 'adaptive', purge: false, output: '', overwrite: false }
  const positionals = []
  let scheduleProvided = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--schedule') {
      scheduleProvided = true
      options.schedule = argv[++i] || ''
      continue
    }
    if (arg.startsWith('--schedule=')) {
      scheduleProvided = true
      options.schedule = arg.slice('--schedule='.length)
      continue
    }
    if (arg === '--output') {
      const value = argv[++i] || ''
      if (!value || value.startsWith('-')) throw new Error('--output requires a file path')
      options.output = value
      continue
    }
    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length)
      continue
    }
    if (arg === '--overwrite') {
      options.overwrite = true
      continue
    }
    if (arg === '--purge') {
      options.purge = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      positionals.push('help')
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }
    positionals.push(arg)
  }
  const action = positionals[0] || 'install'
  if (positionals.length > 1) throw new Error(`Unexpected argument: ${positionals[1]}`)
  if (!ACTIONS.has(action)) {
    throw new Error(`Unknown action: ${action}`)
  }
  if (options.schedule !== 'adaptive' && options.schedule !== 'fixed') {
    throw new Error('--schedule must be adaptive or fixed')
  }
  if (action === 'diagnose' && !options.output) throw new Error('diagnose requires --output <file>')
  if (action === 'diagnose' && (scheduleProvided || options.purge)) {
    throw new Error('--schedule and --purge are not valid for diagnose')
  }
  if (action !== 'diagnose' && (options.output || options.overwrite)) {
    throw new Error('--output and --overwrite are only valid for diagnose')
  }
  return { action, ...options }
}

function run(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true,
    })
    child.on('error', error => {
      if (error && error.code === 'ENOENT') {
        resolve({ code: 127, missing: true })
        return
      }
      console.error(error.message)
      resolve({ code: 1, missing: false })
    })
    child.on('exit', code => resolve({ code: code == null ? 1 : code, missing: false }))
  })
}

async function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    console.error(usage())
    process.exit(2)
  }

  if (parsed.action === 'help') {
    process.stdout.write(usage())
    return
  }

  if (parsed.action === 'diagnose') {
    try {
      await writeDiagnosticReport(parsed.output, { overwrite: parsed.overwrite })
      process.stdout.write('Diagnostic report written.\n')
    } catch {
      console.error('Failed to write diagnostic report.')
      process.exit(1)
    }
    return
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const isWindows = process.platform === 'win32'

  if (isWindows) {
    const script = join(here, 'setup-collector.ps1')
    if (!existsSync(script)) {
      console.error(`Missing ${script}`)
      process.exit(1)
    }
    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-Action', parsed.action,
      '-ScheduleMode', parsed.schedule,
    ]
    if (parsed.purge) psArgs.push('-Purge')

    for (const shell of ['pwsh', 'powershell']) {
      const result = await run(shell, psArgs)
      if (result.missing) continue
      process.exit(result.code)
    }
    console.error('Neither pwsh nor powershell was found on PATH.')
    process.exit(1)
  }

  const script = join(here, 'setup-collector.sh')
  if (!existsSync(script)) {
    console.error(`Missing ${script}`)
    process.exit(1)
  }
  const args = [script, parsed.action, '--schedule', parsed.schedule]
  if (parsed.purge) args.push('--purge')
  const result = await run('bash', args)
  process.exit(result.code)
}

await main()

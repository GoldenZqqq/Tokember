import { isAbsolute, join, parse, resolve } from 'node:path'
import { privilegedDirectory, privilegedWrite } from './host-files.mjs'

const SERVICE_PATTERN = /^[A-Za-z0-9@_.-]+$/

function validatedConfig(input) {
  const appRoot = resolve(input.appRoot)
  const rawNodePath = input.nodePath ?? process.execPath
  const nodePath = resolve(rawNodePath)
  if (!isAbsolute(input.appRoot)
    || appRoot === parse(appRoot).root
    || /[\s"\\]/.test(appRoot)) {
    throw new Error('invalid recovery app root')
  }
  if (!isAbsolute(rawNodePath) || /[\s"\\]/.test(nodePath)) {
    throw new Error('invalid recovery node path')
  }
  if (!SERVICE_PATTERN.test(input.service)) throw new Error('invalid recovery service')
  return { appRoot, service: input.service, nodePath }
}

function quoted(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function buildRecoveryUnits(input) {
  const config = validatedConfig(input)
  const backupRoot = join(config.appRoot, 'backups', 'periodic')
  const cli = join(config.appRoot, 'current', 'scripts', 'recovery.mjs')
  const service = [
    '[Unit]',
    'Description=Tokember verified SQLite backup and restore drill',
    `After=${config.service}.service`,
    'StartLimitIntervalSec=3h',
    'StartLimitBurst=3',
    '',
    '[Service]',
    'Type=oneshot',
    'UMask=0077',
    `WorkingDirectory=${join(config.appRoot, 'current', 'server')}`,
    `ExecStart=${config.nodePath} ${quoted(cli)} cycle --app-root ${quoted(config.appRoot)} --service ${config.service} --keep 28 --timeout-ms 600000 --pages 256 --retries 2`,
    'Nice=10',
    'IOSchedulingClass=best-effort',
    'IOSchedulingPriority=7',
    'TimeoutStartSec=15min',
    'Restart=on-failure',
    'RestartSec=30min',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectHome=read-only',
    'ProtectSystem=strict',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectControlGroups=true',
    'RestrictSUIDSGID=true',
    `ReadWritePaths=${backupRoot}`,
    '',
  ].join('\n')
  const timer = [
    '[Unit]',
    'Description=Run Tokember verified SQLite backup twice daily',
    '',
    '[Timer]',
    'OnCalendar=*-*-* 00,12:00:00',
    'Persistent=true',
    'RandomizedDelaySec=5min',
    'AccuracySec=1min',
    'Unit=tokember-backup.service',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
  return { service, timer, backupRoot }
}

async function systemctl(run, { sudo, args, ignoreFailure = false }) {
  const options = ignoreFailure ? { ignoreFailure: true } : undefined
  if (sudo) return run('sudo', ['systemctl', ...args], options)
  return run('systemctl', args, options)
}

export async function configureRecoveryUnits(config, run) {
  const units = buildRecoveryUnits(config)
  const unitDirectory = config.unitDirectory ?? '/etc/systemd/system'
  let sudo = await privilegedDirectory(units.backupRoot, { run, mode: 0o700 })
  const wasEnabled = (await systemctl(run, {
    sudo, args: ['is-enabled', 'tokember-backup.timer'], ignoreFailure: true,
  })) === 'enabled'
  for (const [name, content] of [
    ['tokember-backup.service', units.service],
    ['tokember-backup.timer', units.timer],
  ]) {
    sudo = await privilegedWrite(join(unitDirectory, name), content, {
      run, appRoot: config.appRoot, mode: 0o644,
    }) || sudo
  }
  await systemctl(run, { sudo, args: ['daemon-reload'] })
  try {
    await systemctl(run, { sudo, args: ['enable', '--now', 'tokember-backup.timer'] })
  } catch (error) {
    if (!wasEnabled) {
      await systemctl(run, {
        sudo, args: ['disable', '--now', 'tokember-backup.timer'], ignoreFailure: true,
      })
    }
    throw error
  }
}

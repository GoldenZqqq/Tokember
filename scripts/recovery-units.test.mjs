import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildRecoveryUnits, configureRecoveryUnits } from './recovery-units.mjs'

test('recovery units schedule a hardened bounded twice-daily cycle', () => {
  const units = buildRecoveryUnits({
    appRoot: '/opt/tokember', service: 'tokember',
    nodePath: '/root/.nvm/versions/node/v22/bin/node',
  })
  assert.match(units.service, /Type=oneshot/)
  assert.match(units.service, /UMask=0077/)
  assert.match(units.service, /Nice=10/)
  assert.match(units.service, /IOSchedulingPriority=7/)
  assert.match(units.service, /TimeoutStartSec=15min/)
  assert.match(units.service, /Restart=on-failure/)
  assert.match(units.service, /RestartSec=30min/)
  assert.match(units.service, /ProtectSystem=strict/)
  assert.match(units.service, /ProtectHome=read-only/)
  assert.match(units.service, /WorkingDirectory=\/opt\/tokember\/current\/server/)
  assert.match(units.service, /ReadWritePaths=\/opt\/tokember\/backups\/periodic/)
  assert.doesNotMatch(units.service, /(WorkingDirectory|ReadWritePaths)="/)
  assert.match(units.service, /ExecStart=\/root\/\.nvm\/versions\/node\/v22\/bin\/node/)
  assert.match(units.service, /recovery\.mjs" cycle --app-root "\/opt\/tokember"/)
  assert.doesNotMatch(units.service, /\/usr\/bin\/env node/)
  assert.match(units.service, /--keep 28 --timeout-ms 600000 --pages 256 --retries 2/)
  assert.match(units.timer, /OnCalendar=\*-\*-\* 00,12:00:00/)
  assert.match(units.timer, /Persistent=true/)
  assert.match(units.timer, /RandomizedDelaySec=5min/)
  assert.doesNotMatch(`${units.service}\n${units.timer}`, /DB_PATH|PASSWORD|SECRET|API_KEY/)
  assert.throws(
    () => buildRecoveryUnits({ appRoot: '/opt/tokember app', service: 'tokember' }),
    /invalid recovery app root/,
  )
  assert.throws(() => buildRecoveryUnits({
    appRoot: '/opt/tokember', service: 'tokember', nodePath: '/opt/node path/node',
  }), /invalid recovery node path/)
  assert.throws(() => buildRecoveryUnits({
    appRoot: '/opt/tokember', service: 'tokember', nodePath: 'node',
  }), /invalid recovery node path/)
})

test('unit installation reloads systemd before enabling the timer as its final action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-recovery-units-'))
  const calls = []
  try {
    const appRoot = join(root, 'app')
    await configureRecoveryUnits({
      appRoot, service: 'ai-burn', unitDirectory: root,
    }, async (command, args) => {
      calls.push([command, ...args])
      return args.includes('is-enabled') ? 'disabled' : ''
    })
    const service = await readFile(join(root, 'tokember-backup.service'), 'utf8')
    const timer = await readFile(join(root, 'tokember-backup.timer'), 'utf8')
    assert.match(service, /After=ai-burn\.service/)
    assert.match(service, /--service ai-burn/)
    assert.match(timer, /Unit=tokember-backup\.service/)
    assert.deepEqual(calls, [
      ['systemctl', 'is-enabled', 'tokember-backup.timer'],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', '--now', 'tokember-backup.timer'],
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('failed first enable cleans up without disabling an existing timer', async () => {
  for (const previouslyEnabled of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'tokember-recovery-units-failure-'))
    const calls = []
    try {
      await assert.rejects(() => configureRecoveryUnits({
        appRoot: join(root, 'app'), service: 'tokember', unitDirectory: root,
      }, async (command, args) => {
        calls.push([command, ...args])
        if (args.includes('is-enabled')) return previouslyEnabled ? 'enabled' : 'disabled'
        if (args.includes('enable')) throw new Error('enable failed')
        return ''
      }), /enable failed/)
      assert.equal(
        calls.some(call => call.includes('disable')),
        !previouslyEnabled,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

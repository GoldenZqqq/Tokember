import assert from 'node:assert/strict'
import test from 'node:test'

import { scanPublicText } from './scan-public-hygiene.mjs'

test('public hygiene rejects deployment identity without returning matched values', () => {
  const text = [
    'server=https://customer.example.site',
    'target=8.8.8.8',
    'path=/opt/1panel/www/sites/customer',
  ].join('\n')
  const findings = scanPublicText('config.txt', text)
  assert.deepEqual(findings.map(item => item.id), [
    'public-site-url', 'non-test-ipv4', 'onepanel-host-path',
  ])
  assert.doesNotMatch(JSON.stringify(findings), /customer|8\.8\.8\.8|1panel/)
})

test('public hygiene allows loopback and documentation address ranges', () => {
  const text = '127.0.0.1 192.0.2.4 198.51.100.8 203.0.113.27'
  assert.deepEqual(scanPublicText('README.md', text), [])
})

test('public hygiene detects secret formats while preserving synthetic fixtures', () => {
  const secret = `tkdc_${'a'.repeat(16)}_${'b'.repeat(20)}`
  const findings = scanPublicText('README.md', secret)
  assert.deepEqual(findings.map(item => item.id), ['device-token-literal'])
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(secret))
  assert.deepEqual(scanPublicText('server/src/security.test.ts', secret), [])
})

test('public hygiene detects embedded credentials and private key headers', () => {
  const findings = scanPublicText('bad.txt', [
    ['https://user', ':password', '@example.com/path'].join(''),
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
  ].join('\n'))
  assert.deepEqual(findings.map(item => item.id), [
    'url-embedded-credential', 'private-key-block',
  ])
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseClaudeCodexSourceMode,
  selectClaudeCodexSource,
} from './source-selection.js'

test('native is the default even when cc-switch is installed', () => {
  assert.equal(parseClaudeCodexSourceMode(undefined), 'native')
  assert.equal(selectClaudeCodexSource('auto', true), 'native')
})

test('auto falls back to native logs when cc-switch is unavailable', () => {
  assert.equal(selectClaudeCodexSource('auto', false), 'native')
})

test('explicit source mode wins and invalid values fail fast', () => {
  assert.equal(selectClaudeCodexSource('native', true), 'native')
  assert.equal(selectClaudeCodexSource('cc-switch', false), 'cc-switch')
  assert.throws(() => parseClaudeCodexSourceMode('both'), /must be one of/)
})

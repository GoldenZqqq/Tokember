import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeModel } from './model-normalize.js'

test('claude dotted spellings merge to the dashed native form', () => {
  assert.equal(normalizeModel('claude-opus-4-8'), 'claude-opus-4-8')
  assert.equal(normalizeModel('claude-opus-4.8'), 'claude-opus-4-8')
  assert.equal(normalizeModel('claude-opus-4.7'), 'claude-opus-4-7')
  assert.equal(normalizeModel('claude-haiku-4.5'), 'claude-haiku-4-5')
})

test('claude dated release ids merge with the short form', () => {
  assert.equal(normalizeModel('claude-opus-4-5-20251101'), 'claude-opus-4-5')
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5')
  assert.equal(normalizeModel('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5')
})

test('claude reversed word order resolves via the table', () => {
  assert.equal(normalizeModel('claude-4.6-sonnet'), 'claude-sonnet-4-6')
})

test('GLM vendor-prefixed form merges with the bare name', () => {
  assert.equal(normalizeModel('z-ai/glm-5.2'), 'GLM-5.2')
  // The bare name is canonical and passes through unchanged.
  assert.equal(normalizeModel('GLM-5.2'), 'GLM-5.2')
})

test('dotted vendor versions are kept EXACTLY as-is (no mechanical transform)', () => {
  // The bug that started this: a blanket dot→dash rule corrupted these.
  assert.equal(normalizeModel('gpt-5.6-sol'), 'gpt-5.6-sol')
  assert.equal(normalizeModel('gpt-5.4'), 'gpt-5.4')
  assert.equal(normalizeModel('deepseek-v4-pro'), 'deepseek-v4-pro')
  assert.equal(normalizeModel('mimo-v2.5-pro'), 'mimo-v2.5-pro')
})

test('placeholders and sentinels pass through untouched', () => {
  assert.equal(normalizeModel('<synthetic>'), '<synthetic>')
  assert.equal(normalizeModel('MODEL_PLACEHOLDER_*'), 'MODEL_PLACEHOLDER_*')
})

test('unknown models pass through untouched (case preserved)', () => {
  assert.equal(normalizeModel('grok-4.5'), 'grok-4.5')
  assert.equal(normalizeModel('some-new-model'), 'some-new-model')
})

test('whitespace is trimmed; empty stays empty', () => {
  assert.equal(normalizeModel(''), '')
  assert.equal(normalizeModel('  claude-opus-4.8  '), 'claude-opus-4-8')
})

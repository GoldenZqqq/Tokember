import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BURN_BLAZE_TOKENS,
  BURN_WARM_TOKENS,
  resolveBurnIntensity,
} from './burn-intensity'

const base = {
  preference: 'auto' as const,
  reducedMotion: false,
  realTotalTokens: 0,
  routeBlocksFx: false,
}

test('settings route and off preference always disable frame', () => {
  assert.equal(resolveBurnIntensity({ ...base, routeBlocksFx: true, realTotalTokens: BURN_BLAZE_TOKENS }), 'off')
  assert.equal(resolveBurnIntensity({ ...base, preference: 'off', realTotalTokens: BURN_BLAZE_TOKENS }), 'off')
})

test('forced on stays warm regardless of tokens', () => {
  assert.equal(resolveBurnIntensity({ ...base, preference: 'on', realTotalTokens: null }), 'warm')
  assert.equal(resolveBurnIntensity({ ...base, preference: 'on', realTotalTokens: BURN_BLAZE_TOKENS }), 'warm')
  assert.equal(resolveBurnIntensity({
    ...base, preference: 'on', reducedMotion: true, realTotalTokens: BURN_BLAZE_TOKENS,
  }), 'warm')
})

test('auto thresholds use real_total_tokens only', () => {
  assert.equal(resolveBurnIntensity({ ...base, realTotalTokens: null }), 'off')
  assert.equal(resolveBurnIntensity({ ...base, realTotalTokens: 0 }), 'idle')
  assert.equal(resolveBurnIntensity({ ...base, realTotalTokens: BURN_WARM_TOKENS - 1 }), 'idle')
  assert.equal(resolveBurnIntensity({ ...base, realTotalTokens: BURN_WARM_TOKENS }), 'warm')
  assert.equal(resolveBurnIntensity({ ...base, realTotalTokens: BURN_BLAZE_TOKENS - 1 }), 'warm')
  assert.equal(resolveBurnIntensity({ ...base, realTotalTokens: BURN_BLAZE_TOKENS }), 'blaze')
})

test('reduced motion caps auto blaze at warm', () => {
  assert.equal(resolveBurnIntensity({
    ...base, reducedMotion: true, realTotalTokens: BURN_BLAZE_TOKENS,
  }), 'warm')
  assert.equal(resolveBurnIntensity({
    ...base, reducedMotion: true, realTotalTokens: BURN_WARM_TOKENS,
  }), 'warm')
  assert.equal(resolveBurnIntensity({
    ...base, reducedMotion: true, realTotalTokens: 1,
  }), 'idle')
})

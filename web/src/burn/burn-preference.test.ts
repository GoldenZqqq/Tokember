import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BURN_FX_STORAGE_KEY,
  parseBurnPreference,
  readBurnPreference,
  writeBurnPreference,
} from './burn-preference'

test('parseBurnPreference accepts known values and defaults to auto', () => {
  assert.equal(parseBurnPreference('auto'), 'auto')
  assert.equal(parseBurnPreference('on'), 'on')
  assert.equal(parseBurnPreference('off'), 'off')
  assert.equal(parseBurnPreference('maybe'), 'auto')
  assert.equal(parseBurnPreference(null), 'auto')
  assert.equal(parseBurnPreference(undefined), 'auto')
})

test('readBurnPreference uses localStorage when available', () => {
  const store = new Map<string, string>()
  const original = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
    },
  })
  try {
    assert.equal(readBurnPreference(), 'auto')
    store.set(BURN_FX_STORAGE_KEY, 'off')
    assert.equal(readBurnPreference(), 'off')
    store.set(BURN_FX_STORAGE_KEY, 'garbage')
    assert.equal(readBurnPreference(), 'auto')
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: original,
    })
  }
})

test('writeBurnPreference persists and dispatches change event', () => {
  const store = new Map<string, string>()
  const originalStorage = globalThis.localStorage
  const originalDispatch = globalThis.dispatchEvent
  let events = 0
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
    },
  })
  Object.defineProperty(globalThis, 'dispatchEvent', {
    configurable: true,
    value: () => { events += 1; return true },
  })
  try {
    writeBurnPreference('on')
    assert.equal(store.get(BURN_FX_STORAGE_KEY), 'on')
    assert.equal(events, 1)
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalStorage,
    })
    Object.defineProperty(globalThis, 'dispatchEvent', {
      configurable: true,
      value: originalDispatch,
    })
  }
})

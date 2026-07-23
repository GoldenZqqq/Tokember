import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { LanguageSwitch } from './LanguageSwitch'
import { LocaleProvider, createTranslator } from './context'
import { catalogs } from './messages'
import {
  LOCALE_STORAGE_KEY,
  parseLocale,
  readLocale,
  writeLocale,
} from './preference'
import { formatServerError } from './server-errors'
import { translate } from './t'

test('parseLocale defaults to en', () => {
  assert.equal(parseLocale(null), 'en')
  assert.equal(parseLocale('zh'), 'zh')
  assert.equal(parseLocale('fr'), 'en')
})

test('readLocale defaults to en without storage', () => {
  const original = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {},
    },
  })
  try {
    assert.equal(readLocale(), 'en')
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: original,
    })
  }
})

test('writeLocale persists preference', () => {
  const store = new Map<string, string>()
  const original = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
    },
  })
  try {
    writeLocale('zh')
    assert.equal(store.get(LOCALE_STORAGE_KEY), 'zh')
    assert.equal(readLocale(), 'zh')
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: original,
    })
  }
})

test('translate resolves en and zh keys with params', () => {
  assert.equal(translate(catalogs.en, 'modelTable.title'), 'Model breakdown')
  assert.equal(translate(catalogs.zh, 'modelTable.title'), '模型明细')
  assert.equal(
    translate(catalogs.en, 'modelTable.billingTiers', { n: 2 }),
    '2 billing tiers',
  )
})

test('translate falls back to en then key', () => {
  assert.equal(
    translate(catalogs.zh, 'modelTable.title', undefined, { fallback: catalogs.en }),
    '模型明细',
  )
  assert.equal(translate(catalogs.en, 'does.not.exist'), 'does.not.exist')
})

test('formatServerError maps legacy Chinese admin errors', () => {
  const t = createTranslator('en')
  assert.equal(formatServerError('价格规则参数无效', t), 'Invalid pricing rule input')
  assert.equal(formatServerError('密码错误', t), 'Incorrect password')
  assert.equal(formatServerError('totally-unknown', t), 'totally-unknown')
})

test('LanguageSwitch renders EN and 中文', () => {
  const html = renderToStaticMarkup(
    createElement(LocaleProvider, null, createElement(LanguageSwitch)),
  )
  assert.match(html, /EN/)
  assert.match(html, /中文/)
})

test('LanguageSwitch keeps responsive visibility outside the control display class', () => {
  const html = renderToStaticMarkup(
    createElement(LocaleProvider, null,
      createElement(LanguageSwitch, { className: 'hidden md:inline-flex' })),
  )
  assert.match(html, /class="hidden md:inline-flex"/)
  assert.match(html, /class="inline-flex overflow-hidden rounded-lg border border-zinc-800"/)
  assert.doesNotMatch(html, /class="inline-flex overflow-hidden[^\"]*hidden/)
})

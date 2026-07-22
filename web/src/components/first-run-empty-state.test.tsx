import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { withLocale } from '../test-utils'
import { FirstRunEmptyState } from './FirstRunEmptyState'

test('first-run empty state explains how to start collecting', () => {
  const html = renderToStaticMarkup(withLocale(createElement(FirstRunEmptyState)))
  assert.match(html, /Collect your first usage/)
})

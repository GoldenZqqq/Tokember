import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../data/api-client'
import { withLocale } from '../test-utils'
import { ReadFeedback } from './ReadFeedback'
import { ResourceView } from './ResourceView'

function render(node: React.ReactElement) {
  return renderToStaticMarkup(withLocale(node))
}

test('terminal resource error renders retry instead of empty data', () => {
  const html = render(createElement(ResourceView, {
    status: 'error', error: new ApiError('network', 'Network unavailable'), empty: false,
    loadingLabel: 'Loading', emptyLabel: 'No data', onRetry: () => {}, children: null,
  }))
  assert.match(html, /Network unavailable/)
  assert.match(html, /Retry/)
  assert.doesNotMatch(html, /No data/)
})

test('stale resource keeps children and labels retained data', () => {
  const html = render(createElement(ResourceView, {
    status: 'stale', error: new ApiError('server', 'Server failed'), empty: false,
    loadingLabel: 'Loading', emptyLabel: 'No data', onRetry: () => {},
    children: createElement('p', null, 'Existing stats'),
  }))
  assert.match(html, /Showing last successful data/)
  assert.match(html, /Existing stats/)
})

test('valid empty resource is distinct from an error', () => {
  const html = render(createElement(ResourceView, {
    status: 'ready', error: null, empty: true,
    loadingLabel: 'Loading', emptyLabel: 'No records in range',
    onRetry: () => {}, children: createElement('p', null, 'Should not appear'),
  }))
  assert.match(html, /No records in range/)
  assert.doesNotMatch(html, /Retry|Should not appear/)
})

test('admin read feedback distinguishes initial and retained-data failures', () => {
  const error = new ApiError('timeout', 'Request timed out')
  const initial = render(createElement(ReadFeedback, {
    loading: false, hasData: false, error, label: 'Loading', onRetry: () => {},
  }))
  const stale = render(createElement(ReadFeedback, {
    loading: false, hasData: true, error, label: 'Loading', onRetry: () => {},
  }))
  assert.match(initial, /Request timed out/)
  assert.doesNotMatch(initial, /last successful|Showing last/)
  assert.match(stale, /Showing last successful data/)
})

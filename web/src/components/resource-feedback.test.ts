import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../data/api-client'
import { ReadFeedback } from './ReadFeedback'
import { ResourceView } from './ResourceView'

test('terminal resource error renders retry instead of empty data', () => {
  const html = renderToStaticMarkup(createElement(ResourceView, {
    status: 'error', error: new ApiError('network', '网络不可用'), empty: false,
    loadingLabel: '加载中', emptyLabel: '没有数据', onRetry: () => {}, children: null,
  }))
  assert.match(html, /网络不可用/)
  assert.match(html, /重试/)
  assert.doesNotMatch(html, /没有数据/)
})

test('stale resource keeps children and labels retained data', () => {
  const html = renderToStaticMarkup(createElement(ResourceView, {
    status: 'stale', error: new ApiError('server', '服务失败'), empty: false,
    loadingLabel: '加载中', emptyLabel: '没有数据', onRetry: () => {},
    children: createElement('p', null, '已有统计'),
  }))
  assert.match(html, /显示上次成功数据/)
  assert.match(html, /已有统计/)
})

test('valid empty resource is distinct from an error', () => {
  const html = renderToStaticMarkup(createElement(ResourceView, {
    status: 'ready', error: null, empty: true,
    loadingLabel: '加载中', emptyLabel: '当前范围没有记录',
    onRetry: () => {}, children: createElement('p', null, '不应出现'),
  }))
  assert.match(html, /当前范围没有记录/)
  assert.doesNotMatch(html, /重试|不应出现/)
})

test('admin read feedback distinguishes initial and retained-data failures', () => {
  const error = new ApiError('timeout', '请求超时')
  const initial = renderToStaticMarkup(createElement(ReadFeedback, {
    loading: false, hasData: false, error, label: '加载', onRetry: () => {},
  }))
  const stale = renderToStaticMarkup(createElement(ReadFeedback, {
    loading: false, hasData: true, error, label: '加载', onRetry: () => {},
  }))
  assert.match(initial, /请求超时/)
  assert.doesNotMatch(initial, /上次成功/)
  assert.match(stale, /显示上次成功数据/)
})

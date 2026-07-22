import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FirstRunEmptyState } from './FirstRunEmptyState'

test('first-run empty state provides safe collector next steps', () => {
  const html = renderToStaticMarkup(<FirstRunEmptyState />)
  assert.match(html, /开始采集你的第一条用量/)
  assert.match(html, /href="#\/settings\?panel=devices"/)
  assert.match(html, /node collector\/install\.mjs doctor/)
  assert.match(html, /node collector\/install\.mjs collect/)
  assert.doesNotMatch(html, /TOKEMBER_(?:API_KEY|DEVICE_TOKEN)|C:\\Users|\/home\//i)
})

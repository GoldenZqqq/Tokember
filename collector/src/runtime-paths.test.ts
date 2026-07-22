import assert from 'node:assert/strict'
import { join } from 'path'
import test from 'node:test'

import {
  resolveLegacyAwareHomeDir,
  resolveLegacyAwareHomePath,
} from './runtime-paths.js'

test('home defaults use ~/.tokember when neither brand path exists', () => {
  const home = 'C:\\Users\\demo'
  const exists = () => false
  assert.equal(
    resolveLegacyAwareHomePath({ fileName: 'collector-state.json', home, exists }),
    join(home, '.tokember', 'collector-state.json'),
  )
  assert.equal(resolveLegacyAwareHomeDir({ home, exists }), join(home, '.tokember'))
})

test('home defaults reuse ~/.ai-burn when only the legacy path exists', () => {
  const home = '/home/demo'
  const exists = (path: string) => path.includes(`${join('.ai-burn')}`)
  assert.equal(
    resolveLegacyAwareHomePath({ fileName: 'adaptive-schedule.json', home, exists }),
    join(home, '.ai-burn', 'adaptive-schedule.json'),
  )
  assert.equal(resolveLegacyAwareHomeDir({ home, exists }), join(home, '.ai-burn'))
})

test('canonical ~/.tokember wins when both brand paths exist', () => {
  const home = '/home/demo'
  const exists = () => true
  assert.equal(
    resolveLegacyAwareHomePath({ fileName: 'collector-observability.json', home, exists }),
    join(home, '.tokember', 'collector-observability.json'),
  )
  assert.equal(resolveLegacyAwareHomeDir({ home, exists }), join(home, '.tokember'))
})

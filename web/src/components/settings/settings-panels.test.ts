import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initialSettingsPanels,
  visitSettingsPanel,
} from './settings-panels'

test('visited settings panels keep stable unique mount order', () => {
  const initial = initialSettingsPanels('pricing')
  const firstCycle = visitSettingsPanel(
    visitSettingsPanel(initial, 'maintenance'),
    'system',
  )
  const secondCycle = visitSettingsPanel(
    visitSettingsPanel(firstCycle, 'pricing'),
    'maintenance',
  )

  assert.deepEqual(initial, ['pricing'])
  assert.deepEqual(firstCycle, ['pricing', 'maintenance', 'system'])
  assert.equal(secondCycle, firstCycle)
})

import { expect, test } from '@playwright/test'

async function loginViewer(
  page: import('@playwright/test').Page,
  expectedHeading = 'Tokember',
): Promise<void> {
  await page.getByLabel('Viewer password').fill('e2e-viewer-password')
  await page.getByRole('button', { name: 'Enter dashboard' }).click()
  await expect(page.getByRole('heading', { name: expectedHeading, exact: true })).toBeVisible()
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }))
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1)
}

async function expectSingleVisibleLanguageSwitch(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('[role="group"][aria-label="Language"]:visible')).toHaveCount(1)
}

async function expectDeviceFilterListsDemoDevice(page: import('@playwright/test').Page): Promise<void> {
  // The device filter is responsive: desktop renders a native <select>
  // (combobox) while narrow/PWA viewports render an icon menu button that opens
  // a listbox. Assert whichever control is visible actually lists the device.
  const nativeSelect = page.getByRole('combobox', { name: 'Filter devices' })
  if ((await nativeSelect.count()) > 0) {
    await expect(nativeSelect).toContainText('Demo Device')
    return
  }
  const menuButton = page.getByRole('button', { name: 'Filter devices' })
  await expect(menuButton).toBeVisible()
  await menuButton.click()
  await expect(page.getByRole('listbox', { name: 'Filter devices' })).toContainText('Demo Device')
  await menuButton.click()
}

async function expectModelCostVisible(page: import('@playwright/test').Page): Promise<void> {
  const card = page.getByRole('heading', { name: 'Model breakdown' }).locator('xpath=../..')
  const scroller = card.locator('.overflow-x-auto')
  const cost = card.getByRole('columnheader', { name: 'Cost' })
  await expect(cost).toBeVisible()
  const [scrollBox, costBox] = await Promise.all([scroller.boundingBox(), cost.boundingBox()])
  if (!scrollBox || !costBox) throw new Error('Model cost column has no measurable layout box')
  expect(costBox.x + costBox.width).toBeLessThanOrEqual(scrollBox.x + scrollBox.width + 1)
}

test('viewer reaches the dashboard and keeps the viewport contained', async ({ page }) => {
  await page.goto('/')
  await loginViewer(page)
  await expect(page.getByRole('heading', { name: 'Today usage trend' })).toBeVisible()
  await expectDeviceFilterListsDemoDevice(page)
  await expectSingleVisibleLanguageSwitch(page)
  await expectModelCostVisible(page)
  await expectNoHorizontalOverflow(page)
})

test('viewer can drill into a source', async ({ page }) => {
  await page.goto('/#/source?provider=codex&range=30')
  await loginViewer(page, 'Codex')
  await expect(page.getByRole('heading', { name: 'Codex' })).toBeVisible()
  await expect(page.getByText('Tool call ledger')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Model distribution' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('admin can inspect device and source health', async ({ page }) => {
  await page.goto('/#/settings?panel=devices')
  await page.getByLabel('Admin password').fill('e2e-admin-password')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await expect(page.getByRole('heading', { name: 'Devices & collector' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Demo Device' })).toBeVisible()
  await expect(page.getByText('Tool sources · 3')).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('first-use empty state gives a real collection path', async ({ page }) => {
  await page.route('**/api/devices', route => route.fulfill({ json: [] }))
  await page.route('**/api/stats?**', async route => {
    const now = new Date().toISOString()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        snapshot: { since: '1970-01-01T00:00:00.000Z', until: now, timezone_offset: 0, max_record_id: 0 },
        totals: {
          total_calls: 0, total_input: 0, total_output: 0,
          total_cache_read: 0, total_cache_creation: 0, real_total_tokens: 0, total_cost: 0,
          pricing_coverage: {
            priced_calls: 0, unpriced_calls: 0, priced_tokens: 0, unpriced_tokens: 0,
            call_ratio: 1, token_ratio: 1,
          },
        },
        byProvider: [], byModel: [], byDevice: [], attribution: [],
        projectOptions: [], byProject: [], bySession: [], daily: [],
      }),
    })
  })
  await page.goto('/')
  await loginViewer(page)
  await expect(page.getByRole('heading', { name: 'Collect your first usage' })).toBeVisible()
  await expect(page.getByText('node collector/install.mjs doctor')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open device settings' })).toHaveAttribute('href', '#/settings?panel=devices')
  await expectNoHorizontalOverflow(page)
})

test('captures the current demo dashboard @screenshot', async ({ page }) => {
  await page.goto('/')
  await loginViewer(page)
  await expect(page.getByRole('heading', { name: 'Today usage trend' })).toBeVisible()
  await page.getByRole('heading', { name: 'Tokember' }).hover()
  await page.screenshot({ path: 'docs/images/dashboard.png', fullPage: true })
})

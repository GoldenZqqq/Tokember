import { expect, test } from '@playwright/test'

async function loginViewer(
  page: import('@playwright/test').Page,
  expectedHeading = 'Tokember',
): Promise<void> {
  await page.getByLabel('查看密码').fill('e2e-viewer-password')
  await page.getByRole('button', { name: '进入 Dashboard' }).click()
  await expect(page.getByRole('heading', { name: expectedHeading, exact: true })).toBeVisible()
}

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }))
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1)
}

test('viewer reaches the dashboard and keeps the viewport contained', async ({ page }) => {
  await page.goto('/')
  await loginViewer(page)
  await expect(page.getByRole('heading', { name: '今日用量趋势' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '筛选设备' })).toContainText('Demo Device')
  await expectNoHorizontalOverflow(page)
})

test('viewer can drill into a source', async ({ page }) => {
  await page.goto('/#/source?provider=codex&range=30')
  await loginViewer(page, 'Codex')
  await expect(page.getByRole('heading', { name: 'Codex' })).toBeVisible()
  await expect(page.getByText('工具调用账本')).toBeVisible()
  await expect(page.getByRole('heading', { name: '模型分布' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('admin can inspect device and source health', async ({ page }) => {
  await page.goto('/#/settings?panel=devices')
  await page.getByLabel('管理员密码').fill('e2e-admin-password')
  await page.getByRole('button', { name: '进入设置中心' }).click()
  await expect(page.getByRole('heading', { name: '设备与采集器' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Demo Device' })).toBeVisible()
  await expect(page.getByText('工具来源 · 3')).toBeVisible()
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
  await expect(page.getByRole('heading', { name: '开始采集你的第一条用量' })).toBeVisible()
  await expect(page.getByText('node collector/install.mjs doctor')).toBeVisible()
  await expect(page.getByRole('link', { name: '打开设备设置' })).toHaveAttribute('href', '#/settings?panel=devices')
  await expectNoHorizontalOverflow(page)
})

test('captures the current demo dashboard @screenshot', async ({ page }) => {
  await page.goto('/')
  await loginViewer(page)
  await expect(page.getByRole('heading', { name: '今日用量趋势' })).toBeVisible()
  await page.getByRole('heading', { name: 'Tokember' }).hover()
  await page.screenshot({ path: 'docs/images/dashboard.png', fullPage: true })
})

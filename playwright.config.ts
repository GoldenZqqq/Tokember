import { defineConfig, devices } from '@playwright/test'

const apiUrl = 'http://127.0.0.1:3157'
const webUrl = 'http://127.0.0.1:4173'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  outputDir: 'test-results/e2e',
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webUrl,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node --import tsx scripts/e2e-server.mjs',
      url: `${apiUrl}/api/health/live`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -w web -- --host 127.0.0.1 --port 4173',
      url: webUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { TOKEMBER_DEV_API: apiUrl },
    },
  ],
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'mobile',
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], viewport: { width: 412, height: 915 } },
    },
  ],
})

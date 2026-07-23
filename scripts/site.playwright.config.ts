import { defineConfig, devices } from '@playwright/test'

const workspaceRoot = process.cwd()
const siteUrl = 'http://127.0.0.1:4174'

export default defineConfig({
  testDir: '.',
  testMatch: 'site.browser.spec.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  outputDir: '../test-results/site',
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: siteUrl,
    locale: 'en-US',
    reducedMotion: 'no-preference',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'python -m http.server 4174 --bind 127.0.0.1 --directory site',
    cwd: workspaceRoot,
    url: siteUrl,
    timeout: 30_000,
    reuseExistingServer: true,
  },
  projects: [
    { name: 'mobile-320', use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 800 } } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 834, height: 1112 } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'wide', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
  ],
})

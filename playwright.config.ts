import { defineConfig } from '@playwright/test'

const requestedPort = Number(process.env.LINERECALL_E2E_PORT ?? '4173')
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65_535) {
  throw new Error('LINERECALL_E2E_PORT must be an integer from 1024 through 65535')
}
const port = requestedPort
const requestedBrowser = process.env.LINERECALL_E2E_BROWSER
const browserName: 'chromium' | 'firefox' | 'webkit' = requestedBrowser === 'firefox' || requestedBrowser === 'webkit'
  ? requestedBrowser
  : 'chromium'
const browserChannel: 'chrome' | 'msedge' = process.env.LINERECALL_E2E_CHANNEL === 'msedge'
  ? 'msedge'
  : 'chrome'
const evidenceName = browserName === 'chromium'
  ? browserChannel === 'msedge' ? 'edge' : 'chrome'
  : browserName

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: `audit/generated/playwright-artifacts-${evidenceName}`,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: `audit/generated/playwright-results-${evidenceName}.json` }],
    ['html', { outputFolder: `audit/generated/playwright-report-${evidenceName}`, open: 'never' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName,
    ...(browserName === 'chromium' ? { channel: browserChannel } : {}),
    bypassCSP: false,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'tsx scripts/e2e/serve-artifact.ts',
    url: `http://127.0.0.1:${port}/linerecall.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
})

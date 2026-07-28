import { defineConfig } from '@playwright/test'

const requestedPort = Number(process.env.LINERECALL_REVIEW_E2E_PORT ?? '4187')
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65_535) {
  throw new Error('LINERECALL_REVIEW_E2E_PORT must be an integer from 1024 through 65535')
}
const requestedBrowser = process.env.LINERECALL_E2E_BROWSER
const browserName: 'chromium' | 'firefox' | 'webkit' = requestedBrowser === 'firefox' || requestedBrowser === 'webkit'
  ? requestedBrowser
  : 'chromium'
const browserChannel: 'chrome' | 'msedge' = process.env.LINERECALL_E2E_CHANNEL === 'msedge'
  ? 'msedge'
  : 'chrome'

export default defineConfig({
  testDir: './tests/e2e-review',
  outputDir: 'audit/generated/playwright-review-fixture-artifacts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: 'audit/generated/playwright-review-fixture-results.json' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${requestedPort}`,
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
    command: `npm run build:review-harness && npx vite preview --config vite.review-harness.config.ts --host 127.0.0.1 --port ${requestedPort} --strictPort`,
    url: `http://127.0.0.1:${requestedPort}/index.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})

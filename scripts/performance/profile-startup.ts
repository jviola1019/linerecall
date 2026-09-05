import { chromium } from '@playwright/test'

const url = process.env.LINERECALL_PROFILE_URL ?? 'http://127.0.0.1:4173/linerecall.html'
const throttle = Number(process.env.LINERECALL_PROFILE_CPU_RATE ?? '4')
if (!Number.isFinite(throttle) || throttle < 1) throw new Error('CPU throttle rate must be at least one')

const browser = await chromium.launch({ channel: 'chrome' })
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  await page.goto(url, { waitUntil: 'commit' })
  await page.locator('h1#opening-search-title').waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('.line-list').waitFor({ state: 'visible', timeout: 60_000 })
  const result = await page.evaluate(() => ({
    observedAt: new Date().toISOString(),
    fullReadyMs: performance.now(),
    measures: Object.fromEntries(
      performance.getEntriesByType('measure')
        .filter((entry) => entry.name.startsWith('linerecall-'))
        .map((entry) => [entry.name, {
          startMs: Math.round(entry.startTime * 10) / 10,
          durationMs: Math.round(entry.duration * 10) / 10,
        }]),
    ),
  }))
  process.stdout.write(`${JSON.stringify({ url, throttle, ...result }, null, 2)}\n`)
  await context.close()
} finally {
  await browser.close()
}

import { test, expect, type Page } from '@playwright/test'
import { APP_PATH, loadReadyApp, revealExpectedMove, startAnyDrill, waitForReadyApp } from './helpers.ts'

async function completeOneAutomaticReview(page: Page): Promise<void> {
  await startAnyDrill(page)
  const expected = await revealExpectedMove(page)
  await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption(expected.uci)
  await page.getByRole('button', { name: 'Play move' }).click()
  await expect(page.getByRole('region', { name: 'Last move recorded as hard' })).toBeVisible()
  await expect(page.getByRole('group', { name: /Choose recall grade/u })).toHaveCount(0)
  await expect(page.getByText(/1\s+(?:reviewed|learner-position reviews? completed)/iu).first()).toBeVisible()
}

test('default storage is visibly session-only and never probes browser durable storage', async ({ page }) => {
  await page.addInitScript(() => {
    const probes = { indexedDb: 0, localStorage: 0 }
    Object.defineProperty(window, '__linerecallStorageProbes', { value: probes, configurable: true })
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get: () => {
        probes.indexedDb += 1
        throw new Error('IndexedDB must not be accessed')
      },
    })
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        probes.localStorage += 1
        throw new Error('localStorage must not be accessed')
      },
    })
  })

  await loadReadyApp(page)
  const storageWarning = page.locator('.global-storage-warning').filter({
    hasText: /Session[-\u2010-\u2015 ]only progress is active/iu,
  })
  await expect(storageWarning).toBeVisible()
  await expect(storageWarning).toHaveAttribute('aria-live', 'polite')
  expect(await page.evaluate(() =>
    (window as Window & { __linerecallStorageProbes?: { indexedDb: number; localStorage: number } })
      .__linerecallStorageProbes
  )).toEqual({ indexedDb: 0, localStorage: 0 })

  await completeOneAutomaticReview(page)
  await page.getByRole('button', { name: 'Progress' }).click()
  await expect(page.getByText(/Storage mode\s*:/iu)).toContainText(/session[-\u2010-\u2015 ]only/iu)
  await expect(page.getByText('Cards reviewed').locator('..').getByRole('strong')).not.toHaveText('0')
  await expect(page.getByRole('button', { name: 'Export progress JSON' })).toBeVisible()

  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('heading', { name: 'Your progress', level: 1 })).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByText('Cards reviewed').locator('..').getByRole('strong')).toHaveText('0')
  expect(await page.evaluate(() =>
    (window as Window & { __linerecallStorageProbes?: { indexedDb: number; localStorage: number } })
      .__linerecallStorageProbes
  )).toEqual({ indexedDb: 0, localStorage: 0 })
})

test('validated JSON export and explicit replacement restore progress after reopening the artifact', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  await loadReadyApp(page)
  await completeOneAutomaticReview(page)
  await page.getByRole('button', { name: 'Progress' }).click()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export progress JSON' }).click()
  const download = await downloadPromise
  const exported = testInfo.outputPath('linerecall-session-progress.json')
  await download.saveAs(exported)

  // Firefox can leave Playwright's reload lifecycle waiting after a completed
  // download. An explicit same-artifact navigation exercises the same fresh
  // in-memory session boundary without depending on that driver edge case.
  await page.goto(APP_PATH, { waitUntil: 'domcontentloaded' })
  await waitForReadyApp(page)
  await page.getByRole('button', { name: 'Progress' }).click()
  await expect(page.getByText('Cards reviewed').locator('..').getByRole('strong')).toHaveText('0')

  const input = page.getByLabel('Choose progress JSON')
  await input.setInputFiles(exported)
  const confirmation = page.getByRole('group', { name: 'Confirm progress import' })
  await expect(confirmation).toBeVisible()
  await expect(confirmation.getByRole('button', { name: 'Replace current progress' })).toBeFocused()
  await confirmation.getByRole('button', { name: 'Replace current progress' }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(input).toBeFocused()
  await expect(page.getByText('Cards reviewed').locator('..').getByRole('strong')).not.toHaveText('0')
})

test('malformed progress never replaces the current in-memory session', async ({ page }) => {
  await loadReadyApp(page)
  await completeOneAutomaticReview(page)
  await page.getByRole('button', { name: 'Progress' }).click()
  const reviewed = page.getByText('Cards reviewed').locator('..').getByRole('strong')
  const before = await reviewed.textContent()

  await page.getByLabel('Choose progress JSON').setInputFiles({
    name: 'hostile.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":1,"cards":{"__proto__":'),
  })
  await expect(page.getByRole('alert')).toContainText(/JSON|valid|parse/iu)
  await expect(page.getByRole('group', { name: 'Confirm progress import' })).toHaveCount(0)
  await expect(reviewed).toHaveText(before ?? '')
})

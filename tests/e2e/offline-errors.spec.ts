import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { APP_PATH, loadReadyApp, openRepertoire } from './helpers.ts'

test('initial unsupported-data failure is visible and retryable without fabricated fallback content', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'DecompressionStream', { value: undefined, configurable: true })
  })
  await page.goto(APP_PATH, { waitUntil: 'domcontentloaded' })
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Opening database unavailable')
  await expect(alert).toContainText(/decompress|browser|database/iu)
  await expect(page.getByText('No unverified or fabricated fallback lines are substituted.')).toBeVisible()
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('alert')).toContainText('Opening database unavailable')
})

test('partition loading/corruption state and retry are explicit', async ({ page }) => {
  await loadReadyApp(page)
  await openRepertoire(page)
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __originalDs?: typeof DecompressionStream }
    scope.__originalDs = globalThis.DecompressionStream
    Object.defineProperty(globalThis, 'DecompressionStream', { value: undefined, configurable: true })
  })
  await page.getByRole('tablist', { name: 'ECO volumes' }).getByRole('tab', { name: /Volume B:/u }).click()
  await page.locator('.eco-list [role="option"]').filter({ hasText: /^B00/u }).first().click()
  await expect(page.getByRole('alert')).toContainText('Opening partition could not be loaded')
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __originalDs?: typeof DecompressionStream }
    Object.defineProperty(globalThis, 'DecompressionStream', { value: scope.__originalDs, configurable: true })
  })
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('.line-list')).toBeVisible()
})

test('data-license corruption state is visible and retryable', async ({ page }) => {
  await loadReadyApp(page)
  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __originalDs?: typeof DecompressionStream }
    scope.__originalDs = globalThis.DecompressionStream
    Object.defineProperty(globalThis, 'DecompressionStream', { value: undefined, configurable: true })
  })
  await page.getByRole('button', { name: 'Data & licenses' }).click()
  await expect(page.getByRole('alert')).toContainText('Data audit unavailable')
  await expect(page.getByRole('alert')).toContainText(/decompress|database|audit/iu)

  await page.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __originalDs?: typeof DecompressionStream }
    Object.defineProperty(globalThis, 'DecompressionStream', { value: scope.__originalDs, configurable: true })
  })
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('heading', { name: /Data.*licenses/iu, level: 1 })).toBeVisible()
})

test('already loaded hosted artifact continues with all network requests blocked', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  await loadReadyApp(page)
  const readyRequestCount = requests.length
  await page.route('**/*', (route) => route.abort('internetdisconnected'))
  await openRepertoire(page)
  await page.getByRole('tablist', { name: 'ECO volumes' }).getByRole('tab', { name: /Volume C:/u }).click()
  await page.locator('.eco-list [role="option"]').filter({ hasText: /^C00/u }).first().click()
  await expect(page.getByRole('heading', { name: 'C00 lines' })).toBeVisible()
  await expect(page.locator('.line-list')).toBeVisible()
  await page.getByRole('button', { name: 'Puzzles' }).click()
  await expect(page.getByRole('heading', { name: 'Puzzles', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Data & licenses' }).click()
  await expect(page.getByRole('heading', { name: /Data.*licenses/iu })).toBeVisible()
  await page.getByRole('button', { name: 'Repertoire' }).click()
  await page.getByRole('searchbox', { name: 'Find an opening' }).fill('Caro')
  await page.getByRole('list', { name: 'Opening families' }).getByRole('button', { name: /^Caro.*Kann/iu }).click()
  await expect(page.getByRole('heading', { name: /^Caro.*Kann$/iu, level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Practice unavailable' })).toBeDisabled()
  expect(requests.length, 'Embedded browse, puzzle, family, and data use made an unexpected network request').toBe(readyRequestCount)
})

test('downloaded self-contained HTML starts directly from file URL with the network disabled', async ({ page }) => {
  await page.route('http://**/*', (route) => route.abort('internetdisconnected'))
  await page.route('https://**/*', (route) => route.abort('internetdisconnected'))
  const url = pathToFileURL(resolve('build/candidate/linerecall.html')).href
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Your opening practice' })).toBeVisible({ timeout: 20_000 })
  const familyAction = page.getByRole('button', { name: 'Open Caro–Kann' })
  await expect(familyAction).toBeVisible()
  await familyAction.click()
  await expect(page.getByRole('heading', { name: /Caro.Kann/u, level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Practice unavailable' })).toBeDisabled()
  await page.getByRole('button', { name: 'Progress' }).click()
  await expect(page.getByRole('heading', { name: 'Your progress' })).toBeVisible()
})

test('empty search state is explicit', async ({ page }) => {
  await loadReadyApp(page)
  await page.getByRole('button', { name: 'Explore' }).click()
  await page.getByLabel('Opening name or ECO code').fill('zzzz-no-opening-can-match-99999')
  await page.getByRole('button', { name: 'Search openings' }).click()
  await expect(page.getByText('No openings found.')).toBeVisible()
})

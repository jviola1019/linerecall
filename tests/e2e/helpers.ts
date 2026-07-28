import { expect, type Page, type TestInfo } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'

export const APP_PATH = '/linerecall.html'

export async function waitForReadyApp(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Ready when you are.', level: 1 })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible({ timeout: 15_000 })
}

export async function loadReadyApp(page: Page): Promise<void> {
  await page.goto(APP_PATH, { waitUntil: 'domcontentloaded' })
  await waitForReadyApp(page)
}

export async function openRepertoire(page: Page): Promise<void> {
  // Legacy browser-focused scenarios use this helper name. The complete ECO
  // browser now lives in Explore; Repertoire has its own pack/syllabus flow.
  await page.getByRole('button', { name: 'Explore', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Explore openings', level: 1 })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.line-list')).toBeVisible({ timeout: 15_000 })
}

export async function openRepertoirePacks(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Repertoire', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Repertoire', level: 1 })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.family-card-grid')).toBeVisible({ timeout: 15_000 })
}

export async function openDataLicenses(page: Page): Promise<void> {
  const utilityButton = page.getByRole('button', { name: 'Data & licenses' })
  if (await utilityButton.isVisible().catch(() => false)) {
    await utilityButton.click()
  } else {
    await page.getByRole('button', { name: 'Today' }).click()
    await expect(page.getByRole('heading', { name: 'Ready when you are.' })).toBeVisible()
    await page.getByRole('button', { name: 'Review data provenance' }).click()
  }
  await expect(page.getByRole('heading', { name: /Data.*licenses/iu })).toBeVisible({ timeout: 15_000 })
}

export async function startAnyDrill(page: Page): Promise<void> {
  const board = page.getByRole('grid', { name: /Chessboard/u })
  // The review snapshot contains several shallow lines. Browser interaction
  // tests use one pinned, deeper fixture so move sequencing, full-line mode,
  // castling-era positions, and progress assertions do not depend on catalog
  // ordering or the Today recommendation.
  await openRepertoire(page)
  const volumeC = page.getByRole('tablist', { name: 'ECO volumes' }).getByRole('tab', { name: /Volume C:/u })
  await volumeC.click()
  const c97 = page.locator('.eco-list [role="option"]').filter({ hasText: /^C97/u }).first()
  await expect(c97).toContainText(/drillable/u)
  await c97.click()
  await expect(page.getByRole('heading', { name: 'C97 lines' })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.line-list')).toBeVisible({ timeout: 15_000 })

  const chigorin = page.locator('.line-list [role="option"]').filter({
    hasText: /Ruy Lopez: Closed, Chigorin Defense.*N=569/isu,
  })
  await expect(chigorin).toHaveCount(1)
  await chigorin.click()
  await expect(page.getByRole('heading', {
    name: 'Ruy Lopez: Closed, Chigorin Defense',
    level: 2,
  })).toBeVisible()

  const trainBlack = page.getByRole('tablist', { name: 'Training side' }).getByRole('tab', { name: 'Train Black' })
  await trainBlack.click()
  const start = page.getByRole('button', { name: 'Start spaced-repetition drill' })
  await expect(start).toBeEnabled()
  await start.click()
  await expect(board).toBeVisible({ timeout: 10_000 })
  const fullLine = page.getByRole('button', { name: 'Practice full line' })
  await expect(fullLine).toBeEnabled()
  await fullLine.click()
  await expect(page.getByRole('button', { name: 'Full line active' })).toBeVisible()
  await expect(board).toBeVisible({ timeout: 10_000 })
}

export async function revealExpectedMove(page: Page): Promise<{ san: string; uci: string }> {
  const hint = page.getByRole('button', { name: 'Show hint' })
  await expect(hint).toBeEnabled()
  await hint.click()
  const hintAfter = page.getByRole('button', { name: /^Hint:/u })
  const text = (await hintAfter.textContent())?.trim() ?? ''
  const san = text.replace(/^Hint:\s*/u, '')
  if (san.length === 0) throw new Error('Hint did not expose the expected SAN move')

  const select = page.getByRole('combobox', { name: 'Legal move picker' })
  const options = select.locator('option')
  for (let index = 0; index < await options.count(); index += 1) {
    const option = options.nth(index)
    const label = (await option.textContent())?.trim() ?? ''
    if (!label.startsWith(`${san}:`)) continue
    const uci = await option.getAttribute('value')
    if (!uci) break
    return { san, uci }
  }
  throw new Error(`The expected hint ${san} is absent from the legal move picker`)
}

export async function playPickerMove(page: Page, uci: string): Promise<void> {
  const picker = page.getByRole('combobox', { name: 'Legal move picker' })
  await picker.selectOption(uci)
  await picker.focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Play move' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('.feedback-content, .review-history, .completion-card').first()).toBeVisible()
}

export async function assertNoSeriousOrCriticalAxe(
  page: Page,
  testInfo: TestInfo,
  label: string,
  options: { disableColorContrast?: boolean } = {},
): Promise<void> {
  let builder = new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
  if (options.disableColorContrast) builder = builder.disableRules('color-contrast')
  const result = await builder.analyze()
  await testInfo.attach(`axe-${label}.json`, {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  const blocking = result.violations.filter((violation) =>
    violation.impact === 'serious' || violation.impact === 'critical'
  )
  expect(blocking, `${label} has serious/critical axe findings`).toEqual([])
  // Axe marks contrast checks "incomplete" when content is a decorative glyph,
  // an ancestor uses a gradient, or a virtualized/scrolling item is partially
  // obscured. Those are retained in the attachment and covered by explicit
  // computed-color probes plus manual review. Every other serious/critical
  // incomplete is a blocking semantic uncertainty.
  const blockingIncomplete = result.incomplete.filter((finding) =>
    finding.id !== 'color-contrast'
    && (finding.impact === 'serious' || finding.impact === 'critical')
  )
  expect(blockingIncomplete, `${label} has unresolved serious/critical non-contrast axe checks`).toEqual([])
}

export async function assertNoPageOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    bodyClient: document.body.clientWidth,
    bodyScroll: document.body.scrollWidth,
    rootClient: document.documentElement.clientWidth,
    rootScroll: document.documentElement.scrollWidth,
  }))
  expect(dimensions.bodyScroll, `${label}: body overflows horizontally`).toBeLessThanOrEqual(dimensions.bodyClient + 1)
  expect(dimensions.rootScroll, `${label}: root overflows horizontally`).toBeLessThanOrEqual(dimensions.rootClient + 1)
}

import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
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
  await expect(page.locator('.pack-library')).toBeVisible({ timeout: 15_000 })
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

async function enabledStartButton(page: Page): Promise<Locator | null> {
  const start = page.getByRole('button', { name: 'Start spaced-repetition drill' })
  if (await start.isVisible().catch(() => false) && await start.isEnabled().catch(() => false)) return start
  const tabs = page.getByRole('tablist', { name: 'Training side' }).getByRole('tab')
  for (let index = 0; index < await tabs.count(); index += 1) {
    await tabs.nth(index).click()
    if (await start.isVisible().catch(() => false) && await start.isEnabled().catch(() => false)) return start
  }
  return null
}

async function waitForViewStageToSettle(page: Page, view: string): Promise<void> {
  const stage = page.locator(`.view-stage[data-view="${view}"]`)
  await expect(stage).toBeVisible()
  await stage.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map(async (animation) => {
      try {
        await Promise.race([
          animation.finished,
          new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
        ])
      } catch {
        // A replaced keyed view cancels its entrance animation. The caller's
        // subsequent visibility/actionability checks still fail closed.
      }
    }))
  })
}

export async function startAnyDrill(page: Page): Promise<void> {
  const board = page.getByRole('grid', { name: /Chessboard/u })
  if (await board.isVisible().catch(() => false)) return

  let todayStart = page.getByRole('button', { name: /Start due review|Continue practice/u })
  if (await todayStart.isVisible().catch(() => false) && await todayStart.isEnabled().catch(() => false)) {
    await waitForViewStageToSettle(page, 'today')
    await todayStart.click()
    await expect(board).toBeVisible({ timeout: 10_000 })
    return
  }

  await page.getByRole('button', { name: 'Today' }).click()
  await expect(page.getByRole('heading', { name: 'Ready when you are.' })).toBeVisible()
  await waitForViewStageToSettle(page, 'today')
  todayStart = page.getByRole('button', { name: /Start due review|Continue practice/u })
  if (await todayStart.isVisible().catch(() => false) && await todayStart.isEnabled().catch(() => false)) {
    await todayStart.click()
    await expect(board).toBeVisible({ timeout: 10_000 })
    return
  }

  await openRepertoire(page)
  const ecoOptions = page.locator('.eco-list [role="option"]')
  const ecoCount = await ecoOptions.count()
  let selectedEco: string | null = null
  for (let index = 0; index < ecoCount; index += 1) {
    const text = await ecoOptions.nth(index).innerText()
    const match = text.match(/\b([1-9][0-9]*) drillable\b/u)
    if (!match) continue
    selectedEco = text.match(/\b[A-E][0-9]{2}\b/u)?.[0] ?? null
    await ecoOptions.nth(index).click()
    break
  }
  if (!selectedEco) throw new Error('The embedded catalog exposes no drillable ECO partition')
  await expect(page.getByRole('heading', { name: `${selectedEco} lines` })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.line-list')).toBeVisible({ timeout: 15_000 })

  const lineOptions = page.locator('.line-list [role="option"]')
  await expect(lineOptions.first()).toBeVisible()
  await lineOptions.first().click()
  const start = await enabledStartButton(page)
  if (!start) throw new Error('The selected ECO advertised drillable variants but its first sorted drillable line could not be opened')
  await start.click()
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

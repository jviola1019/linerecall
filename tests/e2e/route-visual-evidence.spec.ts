import { createHash } from 'node:crypto'
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import {
  assertNoPageOverflow,
  loadReadyApp,
  revealExpectedMove,
  startAnyDrill,
} from './helpers.ts'

type RouteName = 'today' | 'repertoire' | 'puzzles' | 'explore' | 'progress' | 'data'

interface RouteDefinition {
  id: RouteName
  button: string
  heading: string | RegExp
  selector: string
  primary: boolean
}

const ROUTES: readonly RouteDefinition[] = [
  { id: 'today', button: 'Today', heading: 'Ready when you are.', selector: '.today-view', primary: true },
  { id: 'repertoire', button: 'Repertoire', heading: 'Repertoire', selector: '.repertoire-view', primary: true },
  { id: 'puzzles', button: 'Puzzles', heading: 'Puzzles', selector: '.puzzles-route', primary: true },
  { id: 'explore', button: 'Explore', heading: 'Explore openings', selector: '.catalog-view-explore', primary: true },
  { id: 'progress', button: 'Progress', heading: 'Your progress', selector: '.progress-view', primary: true },
  { id: 'data', button: 'Data & licenses', heading: /Data.*Licenses/iu, selector: '.documentation-view', primary: false },
] as const

async function openRoute(page: Page, route: RouteDefinition, assertFocus = false): Promise<void> {
  const routeButton = page.getByRole('button', { name: route.button, exact: true })
  if (route.id === 'data' && !await routeButton.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Ready when you are.', level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Review data provenance' }).click()
  } else {
    await routeButton.click()
  }
  await expect(page.getByRole('heading', { name: route.heading, level: 1 })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator(route.selector)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.view-stage')).toHaveAttribute('data-view', route.id)
  await expect(page.locator('#main-content h1:visible')).toHaveCount(1)
  if (assertFocus) await expect(page.locator('#main-content')).toBeFocused()
  if (route.primary) {
    await expect(page.getByRole('button', { name: route.button, exact: true })).toHaveAttribute('aria-current', 'page')
  } else {
    await expect(page.locator('.primary-nav [aria-current="page"]')).toHaveCount(0)
  }
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const html = page.locator('html')
  const current = await html.getAttribute('data-theme')
  if (current !== theme) {
    await page.getByRole('button', { name: `Switch to ${theme} mode` }).click()
  }
  await expect(html).toHaveAttribute('data-theme', theme)
}

async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<{ name: string; bytes: number; sha256: string }> {
  await page.evaluate(() => scrollTo(0, 0))
  const body = await page.screenshot({ animations: 'disabled', fullPage: false })
  await testInfo.attach(`${name}.png`, { body, contentType: 'image/png' })
  return { name, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') }
}

test('primary destinations are distinct and navigation restores programmatic focus', async ({ page }) => {
  await loadReadyApp(page)
  // Begin away from Today so every assertion observes a real view change.
  for (const route of ROUTES.slice(1)) await openRoute(page, route, true)
  await openRoute(page, ROUTES[0]!, true)

  for (const active of ROUTES) {
    const count = await page.locator(active.selector).count()
    expect(count, `${active.id} leaked into the Today route`).toBe(active.id === 'today' ? 1 : 0)
  }
})

test('review screenshots cover every destination in both themes and both phone widths', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  await loadReadyApp(page)
  const receipts: Array<{
    route: RouteName
    theme: 'dark' | 'light'
    viewport: string
    bytes: number
    sha256: string
  }> = []
  const layouts = [
    { name: 'desktop-1440x900', width: 1440, height: 900, theme: 'dark' as const },
    { name: 'phone-360x800', width: 360, height: 800, theme: 'dark' as const },
    { name: 'phone-390x844', width: 390, height: 844, theme: 'light' as const },
  ]

  for (const layout of layouts) {
    await page.setViewportSize({ width: layout.width, height: layout.height })
    await setTheme(page, layout.theme)
    for (const route of ROUTES) {
      await openRoute(page, route)
      await assertNoPageOverflow(page, `${layout.name} ${route.id}`)
      const receipt = await attachScreenshot(page, testInfo, `${layout.name}-${layout.theme}-${route.id}`)
      receipts.push({ route: route.id, theme: layout.theme, viewport: layout.name, ...receipt })
    }
  }

  for (const route of ROUTES) {
    expect(receipts.some((receipt) => receipt.route === route.id && receipt.theme === 'dark')).toBe(true)
    expect(receipts.some((receipt) => receipt.route === route.id && receipt.theme === 'light')).toBe(true)
  }
  await testInfo.attach('route-screenshot-receipts.json', {
    body: JSON.stringify({
      generatedAt: new Date().toISOString(),
      reviewOnly: true,
      visualApproval: 'not-performed',
      receipts,
    }, null, 2),
    contentType: 'application/json',
  })
})

test('training, annotation, and deviation states produce review-only browser evidence', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await loadReadyApp(page)
  await startAnyDrill(page)
  await assertNoPageOverflow(page, 'desktop training')
  await attachScreenshot(page, testInfo, 'desktop-dark-training')

  await page.getByRole('button', { name: 'Annotate', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Board annotations', level: 3 })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Non-spatial annotation controls' })).toBeVisible()
  await attachScreenshot(page, testInfo, 'desktop-dark-annotation-mode')
  await page.getByRole('button', { name: 'Resume moves', exact: true }).click()

  const expected = await revealExpectedMove(page)
  const picker = page.getByRole('combobox', { name: 'Legal move picker' })
  const deviation = await picker.locator('option').evaluateAll((options, expectedUci) =>
    options.map((option) => (option as HTMLOptionElement).value).find((value) => value !== expectedUci) ?? null,
  expected.uci)
  if (!deviation) throw new Error('The selected learner position has no legal alternative for deviation evidence')
  await picker.selectOption(deviation)
  await page.getByRole('button', { name: 'Play move' }).click()
  await expect(page.locator('.feedback-content')).toBeVisible()
  await attachScreenshot(page, testInfo, 'desktop-dark-deviation-feedback')

  await page.setViewportSize({ width: 390, height: 844 })
  await assertNoPageOverflow(page, 'mobile deviation feedback')
  await expect(page.locator('.drill-thumb-dock')).toBeVisible()
  await attachScreenshot(page, testInfo, 'phone-390x844-dark-deviation-feedback')
})

test('the in-app reduced-motion preference removes piece translation transitions', async ({ page }) => {
  await loadReadyApp(page)
  await page.getByLabel('Reduce interface motion').check()
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced')
  await startAnyDrill(page)
  const expected = await revealExpectedMove(page)
  const from = expected.uci.slice(0, 2)
  const stablePiece = page.locator(`.visual-piece[data-square="${from}"]`)
  const pieceId = await stablePiece.getAttribute('data-piece-id')
  if (!pieceId) throw new Error('The expected moving piece has no stable identity')
  await expect(stablePiece).toHaveCSS('transition-duration', '0s')

  await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption(expected.uci)
  await page.getByRole('button', { name: 'Play move' }).click()
  const movedPiece = page.locator(`.visual-piece[data-piece-id="${pieceId}"]`)
  await expect(movedPiece).toHaveAttribute('data-square', expected.uci.slice(2, 4))
  const transformAnimations = await movedPiece.evaluate((element) => element.getAnimations().filter((animation) =>
    animation instanceof CSSTransition && animation.transitionProperty === 'transform'
  ).length)
  expect(transformAnimations).toBe(0)
})

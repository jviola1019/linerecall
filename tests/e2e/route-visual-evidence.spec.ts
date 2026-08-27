import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function currentUiSourceSha256(): string {
  const listed = execFileSync('git', [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    'src',
    'linerecall.html',
    'vite.config.ts',
    'package.json',
    'package-lock.json',
  ])
  const paths = listed.toString('utf8').split('\0').filter(Boolean).sort((left, right) => left.localeCompare(right, 'en'))
  const hash = createHash('sha256')
  for (const path of paths) {
    const bytes = readFileSync(resolve(path))
    hash.update(path.replaceAll('\\', '/')).update('\0').update(bytes).update('\0')
  }
  return hash.digest('hex')
}

function reviewBuildBinding(): {
  sourceSha256: string
  candidateSha256: string
  releaseId: string
  dataMode: 'synthetic-review'
} {
  const candidate = readFileSync(resolve('build/candidate/linerecall.html'))
  const snapshot = JSON.parse(readFileSync(resolve('src/generated/embedded-snapshot.json'), 'utf8')) as {
    version: number
  }
  return {
    sourceSha256: currentUiSourceSha256(),
    candidateSha256: sha256(candidate),
    releaseId: `review-candidate-v${snapshot.version}`,
    dataMode: 'synthetic-review',
  }
}

const ROUTES: readonly RouteDefinition[] = [
  { id: 'today', button: 'Today', heading: 'Your opening practice', selector: '.today-view', primary: true },
  { id: 'repertoire', button: 'Repertoire', heading: 'Repertoire', selector: '.family-catalog-view', primary: true },
  { id: 'puzzles', button: 'Puzzles', heading: 'Puzzles', selector: '.tactical-puzzle-route', primary: true },
  { id: 'explore', button: 'Explore', heading: 'Explore openings', selector: '.catalog-view-explore', primary: true },
  { id: 'progress', button: 'Progress', heading: 'Your progress', selector: '.progress-view', primary: true },
  { id: 'data', button: 'Data & licenses', heading: /Data.*Licenses/iu, selector: '.documentation-view', primary: false },
] as const

async function openRoute(page: Page, route: RouteDefinition, assertFocus = false): Promise<void> {
  const routeButton = page.getByRole('button', { name: route.button, exact: true })
  if (route.id === 'data' && !await routeButton.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your opening practice', level: 1 })).toBeVisible()
    const viewSources = page.getByRole('button', { name: 'View sources and checks' })
    if (!await viewSources.isVisible().catch(() => false)) {
      await page.locator('.today-data-card summary').click()
    }
    await viewSources.click()
  } else {
    await routeButton.click()
  }
  await expect(page.getByRole('heading', { name: route.heading, level: 1 })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator(route.selector)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.view-stage')).toHaveAttribute('data-view', route.id)
  await expect(page.locator('#main-content h1:visible')).toHaveCount(1)
  await expect(page.locator('.primary-nav button:visible')).toHaveCount(5)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
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
  await page.locator('.view-stage').evaluate(async (stage) => {
    await Promise.all(stage.getAnimations().map(async (animation) => {
      await animation.finished.catch(() => undefined)
    }))
    await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()))
  })
  await expect(page.getByRole('button', { name: 'LineRecall home' })).toBeVisible()
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

test('brand and theme controls stay in the first viewport on content-heavy routes', async ({ page }) => {
  test.setTimeout(90_000)
  await loadReadyApp(page)
  const routes = ROUTES.filter(({ id }) => id === 'repertoire' || id === 'explore' || id === 'data')
  const viewports = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 360, height: 800 },
  ] as const

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    for (const route of routes) {
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
      await openRoute(page, route, true)

      await expect(page.getByRole('button', { name: 'LineRecall home' })).toBeInViewport({ ratio: 1 })
      await expect(page.locator('.theme-toggle')).toBeInViewport({ ratio: 1 })
      await expect(page.locator('#main-content h1:visible')).toHaveCount(1)
    }
  }
})

test('review screenshots cover every destination on desktop and three phone viewports', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  await loadReadyApp(page)
  const receipts: Array<{
    route: RouteName
    theme: 'dark' | 'light'
    viewport: string
    bytes: number
    sha256: string
    sourceSha256: string
    candidateSha256: string
    releaseId: string
    dataMode: 'synthetic-review'
  }> = []
  const buildBinding = reviewBuildBinding()
  const layouts = [
    { name: 'desktop-1440x900', width: 1440, height: 900, theme: 'dark' as const },
    { name: 'phone-320x800', width: 320, height: 800, theme: 'dark' as const },
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
      receipts.push({ route: route.id, theme: layout.theme, viewport: layout.name, ...buildBinding, ...receipt })
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
      ...buildBinding,
      receipts,
    }, null, 2),
    contentType: 'application/json',
  })
})

test('compact route actions stay above mobile navigation at 320, 360, and 390 CSS pixels', async ({ page }) => {
  test.setTimeout(90_000)
  await loadReadyApp(page)

  for (const viewport of [
    { width: 320, height: 800 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await openRoute(page, ROUTES[1]!)
    await assertNoPageOverflow(page, `${viewport.width}px repertoire`)
    await expect(page.getByRole('searchbox', { name: 'Find an opening' })).toBeVisible()
    const repertoireGeometry = await page.evaluate(() => {
      const nav = document.querySelector<HTMLElement>('.primary-nav')?.getBoundingClientRect()
      const search = document.querySelector<HTMLElement>('.family-catalog-controls')?.getBoundingClientRect()
      const firstFamily = document.querySelector<HTMLElement>('.family-card')?.getBoundingClientRect()
      return nav && search && firstFamily ? {
        navTop: nav.top,
        searchBottom: search.bottom,
        firstFamilyTop: firstFamily.top,
        firstFamilyBottom: firstFamily.bottom,
        firstFamilyHeight: firstFamily.height,
      } : null
    })
    expect(repertoireGeometry).not.toBeNull()
    expect(repertoireGeometry!.searchBottom).toBeLessThan(repertoireGeometry!.navTop)
    expect(repertoireGeometry!.firstFamilyTop).toBeLessThan(repertoireGeometry!.navTop)
    expect(repertoireGeometry!.firstFamilyBottom).toBeGreaterThan(0)
    expect(repertoireGeometry!.firstFamilyHeight).toBeGreaterThanOrEqual(44)

    await openRoute(page, ROUTES[2]!)
    await assertNoPageOverflow(page, `${viewport.width}px puzzles`)
    const unavailable = page.locator('.puzzle-unavailable-panel')
    await expect(unavailable).toBeVisible()
    await expect(unavailable.getByRole('button', { name: 'Browse openings' })).toBeVisible()
    await expect(unavailable.getByRole('button', { name: 'See puzzle data status' })).toBeVisible()
    const puzzleGeometry = await page.evaluate(() => {
      const nav = document.querySelector<HTMLElement>('.primary-nav')?.getBoundingClientRect()
      const panel = document.querySelector<HTMLElement>('.puzzle-unavailable-panel')?.getBoundingClientRect()
      return nav && panel ? { navTop: nav.top, panelTop: panel.top, panelBottom: panel.bottom } : null
    })
    expect(puzzleGeometry).not.toBeNull()
    expect(puzzleGeometry!.panelTop).toBeLessThan(puzzleGeometry!.navTop)
    expect(puzzleGeometry!.panelBottom).toBeGreaterThan(0)

    await openRoute(page, ROUTES[4]!)
    await assertNoPageOverflow(page, `${viewport.width}px progress`)
    await expect(page.locator('.progress-summary')).toBeVisible()
  }
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

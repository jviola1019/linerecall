import { test, expect, type Locator, type Page } from '@playwright/test'
import { loadReadyApp, revealExpectedMove, startAnyDrill } from './helpers.ts'

test.use({
  hasTouch: true,
  viewport: { width: 390, height: 844 },
})

async function visibleMoveTargets(
  page: Page,
  uci: string,
): Promise<{
  from: Locator
  to: Locator
  fromBox: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>
  toBox: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>
}> {
  const board = page.getByRole('grid', { name: /Chessboard/u })
  const from = page.getByRole('gridcell', { name: new RegExp(`^${uci.slice(0, 2)},`, 'u') })
  const to = page.getByRole('gridcell', { name: new RegExp(`^${uci.slice(2, 4)},`, 'u') })

  // revealExpectedMove operates a control below the board, which can scroll the
  // mobile viewport. Raw touchscreen/CDP coordinates are viewport-relative and
  // do not auto-scroll like Locator.click(), so restore the complete board
  // before measuring either endpoint.
  await board.scrollIntoViewIfNeeded()
  const fromBox = await from.boundingBox()
  const toBox = await to.boundingBox()
  if (!fromBox || !toBox) throw new Error('Expected touch targets are not rendered')

  const viewport = page.viewportSize()
  if (!viewport) throw new Error('Touch tests require an explicit viewport')
  for (const [name, box] of [['source', fromBox], ['destination', toBox]] as const) {
    expect(box.x, `${name} square starts outside the viewport`).toBeGreaterThanOrEqual(0)
    expect(box.y, `${name} square starts outside the viewport`).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, `${name} square ends outside the viewport`).toBeLessThanOrEqual(viewport.width)
    expect(box.y + box.height, `${name} square ends outside the viewport`).toBeLessThanOrEqual(viewport.height)
  }

  return { from, to, fromBox, toBox }
}

test.describe('touch-context chess input', () => {
  test.beforeEach(async ({ page, browserName }) => {
    // Playwright currently exposes a genuine emulated touchscreen only in its
    // Chromium engine. Firefox/WebKit are covered for the equivalent keyboard,
    // click-click, picker, and Pointer Events paths elsewhere in this suite.
    test.skip(browserName !== 'chromium', 'Playwright touch emulation is unavailable in this browser engine.')
    await loadReadyApp(page)
    await startAnyDrill(page)
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0)
  })

  test('genuine touchscreen taps provide the same click-click move path', async ({ page }) => {
    const expected = await revealExpectedMove(page)
    const { fromBox, toBox } = await visibleMoveTargets(page, expected.uci)

    await page.touchscreen.tap(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2)
    await page.touchscreen.tap(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2)
    await expect(page.getByRole('region', { name: 'Last move recorded as hard' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show hint' })).toBeVisible()
  })

  test('non-draggable board squares preserve vertical page pan while movable pieces reserve drag', async ({ page, context }) => {
    const touchPolicy = await page.evaluate(() => {
      const board = document.querySelector<HTMLElement>('.chessboard')
      const draggable = document.querySelector<HTMLElement>('.board-square[data-draggable="true"]')
      const panSurface = document.querySelector<HTMLElement>('.board-square:not([data-draggable="true"])')
      return {
        board: board ? getComputedStyle(board).touchAction : null,
        draggable: draggable ? getComputedStyle(draggable).touchAction : null,
        panSurface: panSurface ? getComputedStyle(panSurface).touchAction : null,
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
      }
    })
    expect(touchPolicy.board).toContain('pan-y')
    expect(touchPolicy.board).toContain('pinch-zoom')
    expect(touchPolicy.draggable).toBe('none')
    expect(touchPolicy.panSurface).toContain('pan-y')
    expect(touchPolicy.scrollHeight).toBeGreaterThan(touchPolicy.viewportHeight)

    const panSurface = page.locator('.board-square:not([data-draggable="true"])').first()
    const box = await panSurface.boundingBox()
    if (!box) throw new Error('A board page-pan surface is not rendered')
    await page.evaluate(() => window.scrollTo(0, 0))
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const cdp = await context.newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] })
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: start.x, y: start.y - (120 * step) / 8, id: 1 }],
      })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  })

  test('native Chrome touch drag emits touch Pointer Events and submits the audited move', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native Input.dispatchTouchEvent evidence is Chromium-specific; touchscreen tap coverage runs in every engine.')
    const expected = await revealExpectedMove(page)
    const { fromBox, toBox } = await visibleMoveTargets(page, expected.uci)
    await page.evaluate(() => {
      const observed: string[] = []
      ;(window as Window & { __linerecallTouchPointers?: string[] }).__linerecallTouchPointers = observed
      const board = document.querySelector('.chessboard')
      board?.addEventListener('pointerdown', (event) => observed.push(`down:${(event as PointerEvent).pointerType}`), { capture: true })
      board?.addEventListener('pointerup', (event) => observed.push(`up:${(event as PointerEvent).pointerType}`), { capture: true })
    })

    const start = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 }
    const end = { x: toBox.x + toBox.width / 2, y: toBox.y + toBox.height / 2 }
    const cdp = await context.newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] })
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{
          x: start.x + ((end.x - start.x) * step) / 8,
          y: start.y + ((end.y - start.y) * step) / 8,
          id: 1,
        }],
      })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

    await expect(page.getByRole('region', { name: 'Last move recorded as hard' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show hint' })).toBeVisible()
    expect(await page.evaluate(() => (window as Window & { __linerecallTouchPointers?: string[] }).__linerecallTouchPointers)).toEqual([
      'down:touch',
      'up:touch',
    ])
  })
})

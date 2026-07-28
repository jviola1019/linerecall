import { test, expect } from '@playwright/test'
import {
  loadReadyApp,
  playPickerMove,
  revealExpectedMove,
  startAnyDrill,
} from './helpers.ts'

test.describe('production artifact interactions', () => {
  test.beforeEach(async ({ page }) => {
    await loadReadyApp(page)
  })

  test('search, validation, ECO, and move-list navigation work by keyboard', async ({ page }) => {
    await page.getByRole('button', { name: 'Explore' }).click()
    await expect(page.getByRole('heading', { name: 'Explore openings' })).toBeVisible()
    const search = page.getByLabel('Search by opening name, ECO, SAN, or UCI')
    await search.fill('Sicilian')
    await search.press('Enter')
    await expect(page.getByRole('heading', { name: /Search results/u })).toBeVisible()
    await expect(page.locator('.result-list li').first()).toBeVisible()

    const selectedEco = page.locator('.eco-list [role="option"][aria-selected="true"]')
    await selectedEco.focus()
    await page.keyboard.press('ArrowDown')
    const focusedEco = page.locator('.eco-list [role="option"]:focus')
    await expect(focusedEco).toBeVisible()
    const nextEco = (await focusedEco.innerText()).match(/\b[A-E][0-9]{2}\b/u)?.[0]
    if (!nextEco) throw new Error('Focused ECO option does not expose an ECO code')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: `${nextEco} lines` })).toBeVisible()
    await expect(page.locator('.line-list')).toBeVisible()

    const moves = page.locator('.move-list [role="option"]')
    if (await moves.count() < 2) {
      const lineOptions = page.locator('.line-list [role="option"]')
      for (let index = 1; index < await lineOptions.count() && await moves.count() < 2; index += 1) {
        await lineOptions.nth(index).click()
      }
    }
    expect(await moves.count(), 'Selected ECO exposes no line with two moves for roving-focus testing').toBeGreaterThanOrEqual(2)
    const firstMove = moves.first()
    const secondMove = moves.nth(1)
    await firstMove.focus()
    await page.keyboard.press('ArrowRight')
    await expect(secondMove).toBeFocused()

    await page.getByLabel('PGN', { exact: true }).check()
    const pgn = page.getByLabel('Paste a Standard-chess PGN')
    await pgn.fill('[Event "Malformed"]\n\n1. e4 e5 2. ThisIsNotAMove 1-0')
    await pgn.press('Control+Enter')
    await page.getByRole('button', { name: 'Search openings' }).click()
    await expect(page.getByRole('alert')).toContainText(/PGN|move|parse|legal/iu)

    await page.getByLabel('Name / ECO', { exact: true }).check()
    await page.evaluate(() => { (window as Window & { __linerecallXss?: number }).__linerecallXss = 0 })
    await page.getByLabel('Search by opening name, ECO, SAN, or UCI').fill('<img src=x onerror="window.__linerecallXss=1">')
    await page.getByRole('button', { name: 'Search openings' }).click()
    await expect(page.getByText('No audited opening matches found.')).toBeVisible()
    expect(await page.evaluate(() => (window as Window & { __linerecallXss?: number }).__linerecallXss)).toBe(0)
    await expect(page.locator('.search-results img')).toHaveCount(0)
  })

  test('board roving focus, move picker, automatic grading, and progress transfer are keyboard operable', async ({ page }, testInfo) => {
    await startAnyDrill(page)
    const activeSquare = page.locator('[role="gridcell"][tabindex="0"]')
    await activeSquare.focus()
    const before = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
    await page.keyboard.press('ArrowRight')
    const after = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
    expect(after).not.toBe(before)

    const expected = await revealExpectedMove(page)
    await playPickerMove(page, expected.uci)
    await expect(page.getByRole('region', { name: 'Last move recorded as hard' })).toBeVisible()
    await expect(page.getByRole('group', { name: /Choose recall grade/u })).toHaveCount(0)
    await expect(page.getByText(/1 (?:reviewed|learner-position review)/u).first()).toBeVisible()

    await page.getByRole('button', { name: 'Progress' }).click()
    await expect(page.getByRole('heading', { name: 'Your progress' })).toBeVisible()
    await expect(page.getByText('Cards reviewed').locator('..').getByRole('strong')).not.toHaveText('0')

    const invalid = page.getByLabel('Choose progress JSON')
    await invalid.setInputFiles({ name: 'hostile.json', mimeType: 'application/json', buffer: Buffer.from('{"__proto__":') })
    await expect(page.getByRole('alert')).toContainText(/invalid|JSON|parse/iu)

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export progress JSON' }).click()
    const download = await downloadPromise
    const exported = testInfo.outputPath('linerecall-progress.json')
    await download.saveAs(exported)
    await invalid.setInputFiles(exported)
    await expect(page.getByRole('group', { name: 'Confirm progress import' })).toBeVisible()
    await page.getByRole('button', { name: 'Replace current progress' }).click()
    await expect(page.getByRole('group', { name: 'Confirm progress import' })).toHaveCount(0)
  })

  test('click-click submits the audited move', async ({ page }) => {
    test.setTimeout(90_000)
    await startAnyDrill(page)
    const expected = await revealExpectedMove(page)
    const from = expected.uci.slice(0, 2)
    const to = expected.uci.slice(2, 4)
    await page.getByRole('gridcell', { name: new RegExp(`^${from},`, 'u') }).click()
    await page.getByRole('gridcell', { name: new RegExp(`^${to},`, 'u') }).click()
    await expect(page.getByRole('region', { name: 'Last move recorded as hard' })).toBeVisible()
  })

  test('Pointer Events drag submits the audited move', async ({ page }) => {
    test.setTimeout(90_000)
    await startAnyDrill(page)
    const dragMove = await revealExpectedMove(page)
    const dragFrom = page.getByRole('gridcell', { name: new RegExp(`^${dragMove.uci.slice(0, 2)},`, 'u') })
    const dragTo = page.getByRole('gridcell', { name: new RegExp(`^${dragMove.uci.slice(2, 4)},`, 'u') })
    const fromBox = await dragFrom.boundingBox()
    const toBox = await dragTo.boundingBox()
    if (!fromBox || !toBox) throw new Error('Expected board squares are not rendered')
    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(page.getByRole('region', { name: 'Last move recorded as hard' })).toBeVisible()
  })

  test('a visual piece keeps its identity and remains between squares at the 50% animation frame', async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    await startAnyDrill(page)
    const expected = await revealExpectedMove(page)
    const from = expected.uci.slice(0, 2)
    const to = expected.uci.slice(2, 4)
    const fromSquare = page.getByRole('gridcell', { name: new RegExp(`^${from},`, 'u') })
    const toSquare = page.getByRole('gridcell', { name: new RegExp(`^${to},`, 'u') })
    if (!await fromSquare.boundingBox() || !await toSquare.boundingBox()) {
      throw new Error('Expected source and destination squares are not rendered')
    }

    const movingPiece = page.locator(`.visual-piece[data-square="${from}"]`)
    await expect(movingPiece).toHaveCount(1)
    const stablePieceId = await movingPiece.getAttribute('data-piece-id')
    if (!stablePieceId) throw new Error('The moving visual piece has no stable identity')
    await expect(movingPiece).toHaveCSS('transition-duration', /0\.17s/u)

    await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption(expected.uci)
    await page.getByRole('button', { name: 'Play move' }).click()

    const movedPiece = page.locator(`.visual-piece[data-piece-id="${stablePieceId}"]`)
    const animationProperties = await page.evaluate(async ({ pieceId, destination }) => {
      for (let frame = 0; frame < 7; frame += 1) {
        const element = document.querySelector<HTMLElement>(`.visual-piece[data-piece-id="${pieceId}"]`)
        const animations = element?.getAnimations() ?? []
        if (element?.dataset.square === destination && animations.length > 0) {
          const transformAnimations = animations.filter((animation) =>
            animation instanceof CSSTransition && animation.transitionProperty === 'transform'
          )
          for (const animation of transformAnimations) {
            const duration = Number(animation.effect?.getComputedTiming().duration)
            animation.pause()
            animation.currentTime = Number.isFinite(duration) ? duration / 2 : 85
          }
          return animations.map((animation) =>
            animation instanceof CSSTransition ? animation.transitionProperty : animation.constructor.name
          )
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      return []
    }, { pieceId: stablePieceId, destination: to })
    expect(animationProperties, 'The moving piece exposes no pausable transform transition').toContain('transform')
    await expect(movedPiece).toHaveAttribute('data-square', to)

    // Focus restoration may scroll the document after submission; measure all
    // three boxes in the same post-transition viewport coordinate space.
    const sourceBox = await fromSquare.boundingBox()
    const destinationBox = await toSquare.boundingBox()
    const midpointBox = await movedPiece.boundingBox()
    if (!sourceBox || !destinationBox || !midpointBox) throw new Error('The paused route geometry is not rendered')
    const center = (box: { x: number; y: number; width: number; height: number }) => ({
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    })
    const source = center(sourceBox)
    const destination = center(destinationBox)
    const midpoint = center(midpointBox)
    const dx = destination.x - source.x
    const dy = destination.y - source.y
    const lengthSquared = dx * dx + dy * dy
    const routeProgress = ((midpoint.x - source.x) * dx + (midpoint.y - source.y) * dy) / lengthSquared
    const perpendicularDistance = Math.abs(
      dy * midpoint.x - dx * midpoint.y + destination.x * source.y - destination.y * source.x
    ) / Math.sqrt(lengthSquared)
    const tolerance = Math.max(sourceBox.width, sourceBox.height) * 0.2
    // The production curve is deliberately ease-out, so 50% of elapsed time
    // is not the geometric midpoint. It must still be on the route and not at
    // either endpoint.
    expect(routeProgress).toBeGreaterThan(0.01)
    expect(routeProgress).toBeLessThan(0.995)
    expect(perpendicularDistance).toBeLessThanOrEqual(tolerance)
    await testInfo.attach('piece-glide-50-percent.png', {
      body: await page.screenshot({ animations: 'allow' }),
      contentType: 'image/png',
    })
  })

  test('theme, orientation, and unsupported legal deviations remain explicit', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    await startAnyDrill(page)
    const board = page.getByRole('grid', { name: /Chessboard, (?:white|black) orientation/u })
    await expect(board).toBeVisible()
    const currentLabel = await board.getAttribute('aria-label')
    const currentOrientation = currentLabel?.match(/Chessboard, (white|black) orientation/u)?.[1]
    if (currentOrientation !== 'white' && currentOrientation !== 'black') {
      throw new Error('The chessboard does not expose its current orientation')
    }
    const nextOrientation = currentOrientation === 'white' ? 'black' : 'white'
    await page.getByRole('button', { name: 'Flip board' }).click()
    await expect(page.getByRole('grid', { name: `Chessboard, ${nextOrientation} orientation` })).toBeVisible()

    const expected = await revealExpectedMove(page)
    const select = page.getByRole('combobox', { name: 'Legal move picker' })
    const alternatives = await select.locator('option').evaluateAll((options, expectedUci) =>
      options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== expectedUci),
      expected.uci,
    )
    const alternative = alternatives[0]
    if (!alternative) throw new Error('The learner position exposes no legal alternative for deviation testing')
    await playPickerMove(page, alternative)
    await expect(page.locator('.feedback-content')).toHaveAttribute('data-feedback', /playable|inaccuracy|mistake|unverified_deviation|book/u)
    await expect(page.locator('.feedback-content')).toContainText(/Played|Book|sample/u)
  })
})

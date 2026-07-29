import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { assertNoPageOverflow } from '../e2e/helpers.ts'

const MOTION_PATH = '/index.html?surface=board-motion'
const APP_PATH = '/index.html'

async function auditAxeIncludingModerate(
  page: Page,
  testInfo: TestInfo,
  label: string,
): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  const reviewed = {
    violations: result.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.length })),
    incomplete: result.incomplete.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.length })),
  }
  await testInfo.attach(`axe-reviewed-${label}.json`, {
    body: JSON.stringify({ reviewedAutomatically: true, manualAtEvidence: false, ...reviewed }, null, 2),
    contentType: 'application/json',
  })
  expect(
    result.violations.filter(({ impact }) =>
      impact === 'moderate' || impact === 'serious' || impact === 'critical'),
    `${label} has moderate-or-higher axe violations`,
  ).toEqual([])
  expect(
    result.incomplete.filter(({ id, impact }) =>
      id !== 'color-contrast'
      && (impact === 'moderate' || impact === 'serious' || impact === 'critical')),
    `${label} has unresolved moderate-or-higher non-contrast axe checks`,
  ).toEqual([])
}

async function chooseScenario(page: Page, scenario: string): Promise<void> {
  await page.locator('.board-motion-review-controls select').selectOption(scenario, { force: true })
  await expect(page.getByText(/position reset without animation/u)).toBeVisible()
}

async function runTransition(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Run transition' }).click()
}

async function pieceIdAt(page: Page, square: string): Promise<string> {
  const id = await page.locator(`.visual-piece[data-square="${square}"]`).getAttribute('data-piece-id')
  if (!id) throw new Error(`No stable visual piece exists at ${square}`)
  return id
}

async function transformAnimationCount(page: Page, pieceId: string): Promise<number> {
  return page.locator(`.visual-piece[data-piece-id="${pieceId}"]`).evaluate((element) =>
    element.getAnimations().filter((animation) =>
      animation instanceof CSSTransition && animation.transitionProperty === 'transform').length)
}

test.describe('review-only board and tactical audit', () => {
  test('reconciles capture, castling, en passant, promotion, queued moves, reset, and orientation', async ({ page }, testInfo) => {
    test.setTimeout(120_000)
    await page.goto(MOTION_PATH, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Board transition review' })).toBeVisible()
    await expect(page.getByText(/not opening or tactical evidence/u)).toBeVisible()

    const normalId = await pieceIdAt(page, 'e2')
    await runTransition(page)
    const normal = page.locator(`.visual-piece[data-piece-id="${normalId}"]`)
    const normalAnimation = page.evaluate(async (pieceId) => {
      for (let frame = 0; frame < 20; frame += 1) {
        const element = document.querySelector<HTMLElement>(`.visual-piece[data-piece-id="${pieceId}"]`)
        const animation = element?.getAnimations().find((candidate) =>
          candidate instanceof CSSTransition && candidate.transitionProperty === 'transform')
        if (animation) {
          const duration = Number(animation.effect?.getComputedTiming().duration)
          animation.pause()
          animation.currentTime = Number.isFinite(duration) ? duration / 2 : 85
          return true
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      }
      return false
    }, normalId)
    expect(await normalAnimation).toBe(true)
    await expect(normal).toHaveAttribute('data-square', 'e4')
    const [pieceBox, sourceBox, destinationBox] = await Promise.all([
      normal.boundingBox(),
      page.getByRole('gridcell', { name: /^e2,/u }).boundingBox(),
      page.getByRole('gridcell', { name: /^e4,/u }).boundingBox(),
    ])
    if (!pieceBox || !sourceBox || !destinationBox) {
      throw new Error('The paused move and its source/destination squares must be rendered')
    }
    const pieceCenter = {
      x: pieceBox.x + pieceBox.width / 2,
      y: pieceBox.y + pieceBox.height / 2,
    }
    const sourceCenter = {
      x: sourceBox.x + sourceBox.width / 2,
      y: sourceBox.y + sourceBox.height / 2,
    }
    const destinationCenter = {
      x: destinationBox.x + destinationBox.width / 2,
      y: destinationBox.y + destinationBox.height / 2,
    }
    expect(pieceCenter.y).toBeGreaterThan(Math.min(sourceCenter.y, destinationCenter.y) + 1)
    expect(pieceCenter.y).toBeLessThan(Math.max(sourceCenter.y, destinationCenter.y) - 1)
    expect(Math.abs(pieceCenter.x - sourceCenter.x)).toBeLessThan(1)
    await testInfo.attach('review-board-normal-midpoint.png', {
      body: await page.screenshot({ animations: 'allow' }),
      contentType: 'image/png',
    })
    await normal.evaluate((element) => {
      for (const animation of element.getAnimations()) animation.finish()
    })
    await page.waitForTimeout(220)

    await chooseScenario(page, 'capture')
    const capturingId = await pieceIdAt(page, 'e4')
    const capturedId = await pieceIdAt(page, 'd5')
    await runTransition(page)
    await expect(page.locator(`.visual-piece[data-piece-id="${capturingId}"]`)).toHaveAttribute('data-square', 'd5')
    await expect(page.locator(
      `.visual-piece[data-piece-id="${capturedId}"][data-transition-state="captured"]`,
    )).toHaveCount(1)
    await page.waitForTimeout(220)
    await expect(page.locator(`.visual-piece[data-piece-id="${capturedId}"]`)).toHaveCount(0)

    await chooseScenario(page, 'castling')
    const kingId = await pieceIdAt(page, 'e1')
    const rookId = await pieceIdAt(page, 'h1')
    await runTransition(page)
    await expect(page.locator(`.visual-piece[data-piece-id="${kingId}"]`)).toHaveAttribute('data-square', 'g1')
    await expect(page.locator(`.visual-piece[data-piece-id="${rookId}"]`)).toHaveAttribute('data-square', 'f1')
    expect(await transformAnimationCount(page, kingId)).toBeGreaterThan(0)
    expect(await transformAnimationCount(page, rookId)).toBeGreaterThan(0)
    await page.waitForTimeout(220)

    await chooseScenario(page, 'en-passant')
    const enPassantCaptureId = await pieceIdAt(page, 'd5')
    await runTransition(page)
    await expect(page.locator('.visual-piece[data-square="d6"][data-piece-type="wp"]')).toHaveCount(1)
    await expect(page.locator(
      `.visual-piece[data-piece-id="${enPassantCaptureId}"][data-square="d5"][data-transition-state="captured"]`,
    )).toHaveCount(1)
    await page.waitForTimeout(220)
    await expect(page.locator(`.visual-piece[data-piece-id="${enPassantCaptureId}"]`)).toHaveCount(0)

    await chooseScenario(page, 'promotion')
    const pawnId = await pieceIdAt(page, 'a7')
    await runTransition(page)
    const promoted = page.locator(`.visual-piece[data-piece-id="${pawnId}"]`)
    await expect(promoted).toHaveAttribute('data-square', 'a8')
    await expect(promoted).toHaveAttribute('data-transition-state', 'travel')
    await expect(promoted.locator('img')).toHaveCount(2)
    await expect(promoted).toHaveAttribute('data-transition-state', 'crossfade', { timeout: 500 })
    await expect(promoted).toHaveAttribute('data-transition-state', 'settled')
    await expect(promoted).toHaveAttribute('data-piece-type', 'wq')
    await expect(promoted.locator('img')).toHaveCount(1)

    await chooseScenario(page, 'queued')
    const whitePawnId = await pieceIdAt(page, 'e2')
    const blackPawnId = await pieceIdAt(page, 'c7')
    await page.evaluate(({ learnerPieceId, replyPieceId }) => {
      const layer = document.querySelector('.visual-piece-layer')
      if (!layer) throw new Error('The visual piece layer is not rendered')
      type RecordedTransition = {
        pieceId: string
        phase: 'start' | 'end'
        time: number
        learnerActive?: boolean
      }
      const events: RecordedTransition[] = []
      document.body.dataset.queueMotionEvents = '[]'
      const record = (phase: RecordedTransition['phase']) => (event: Event): void => {
        const transition = event as TransitionEvent
        const target = event.target
        if (
          transition.propertyName !== 'transform'
          || !(target instanceof HTMLElement)
        ) return
        const pieceId = target.dataset.pieceId
        if (pieceId !== learnerPieceId && pieceId !== replyPieceId) return
        const learner = document.querySelector<HTMLElement>(
          `.visual-piece[data-piece-id="${learnerPieceId}"]`,
        )
        events.push({
          pieceId,
          phase,
          time: performance.now(),
          ...(pieceId === replyPieceId && phase === 'start'
            ? {
                learnerActive: learner?.getAnimations().some((animation) =>
                  animation instanceof CSSTransition
                  && animation.transitionProperty === 'transform'
                  && (animation.playState === 'running' || animation.pending)) ?? false,
              }
            : {}),
        })
        document.body.dataset.queueMotionEvents = JSON.stringify(events)
      }
      layer.addEventListener('transitionrun', record('start'))
      layer.addEventListener('transitionend', record('end'))
    }, { learnerPieceId: whitePawnId, replyPieceId: blackPawnId })
    await runTransition(page)
    await expect.poll(() => transformAnimationCount(page, whitePawnId)).toBeGreaterThan(0)
    await expect(page.locator(`.visual-piece[data-piece-id="${whitePawnId}"]`)).toHaveAttribute('data-square', 'e4')
    await expect(page.locator(`.visual-piece[data-piece-id="${blackPawnId}"]`)).toHaveAttribute('data-square', 'c7')
    await expect(page.locator(`.visual-piece[data-piece-id="${blackPawnId}"]`)).toHaveAttribute('data-square', 'c5', { timeout: 500 })
    await page.waitForFunction(
      (replyPieceId) => JSON.parse(document.body.dataset.queueMotionEvents ?? '[]')
        .some((event: { pieceId: string; phase: string }) =>
          event.pieceId === replyPieceId && event.phase === 'start'),
      blackPawnId,
    )
    const queueEvents = JSON.parse(
      await page.locator('body').getAttribute('data-queue-motion-events') ?? '[]',
    ) as Array<{ pieceId: string; phase: 'start' | 'end'; time: number; learnerActive?: boolean }>
    const learnerStart = queueEvents.find(({ pieceId, phase }) =>
      pieceId === whitePawnId && phase === 'start')
    const learnerEnd = queueEvents.find(({ pieceId, phase }) =>
      pieceId === whitePawnId && phase === 'end')
    const replyStart = queueEvents.find(({ pieceId, phase }) =>
      pieceId === blackPawnId && phase === 'start')
    expect(learnerStart).toBeDefined()
    expect(learnerEnd).toBeDefined()
    expect(replyStart).toBeDefined()
    expect(replyStart!.time).toBeGreaterThanOrEqual(learnerEnd!.time)
    expect(replyStart!.learnerActive).toBe(false)
    await page.waitForTimeout(220)

    await page.getByRole('button', { name: 'Flip board' }).click()
    await page.waitForTimeout(50)
    await expect(page.getByRole('grid', { name: 'Chessboard, black orientation' })).toBeVisible()
    expect(await page.locator('.visual-piece').evaluateAll((pieces) =>
      pieces.flatMap((piece) => piece.getAnimations().filter((animation) =>
        animation instanceof CSSTransition
        && animation.transitionProperty === 'transform'
        && (animation.playState === 'running' || animation.pending))).length),
    ).toBe(0)

    await page.getByRole('button', { name: 'Run rapid reset and move' }).click()
    const rapidPawn = page.locator('.visual-piece[data-piece-id="wp-e2"]')
    await expect(rapidPawn).toHaveAttribute('data-square', 'e4')
    await expect.poll(() => transformAnimationCount(page, 'wp-e2')).toBeGreaterThan(0)
    await expect(page.locator('.visual-piece-layer')).not.toHaveClass(/visual-piece-layer-static/u)
    await page.waitForTimeout(220)

    await chooseScenario(page, 'normal')
    await page.waitForTimeout(50)
    await expect(page.locator('.visual-piece[data-square="e2"][data-piece-type="wp"]')).toHaveCount(1)
    expect(await page.locator('.visual-piece').evaluateAll((pieces) =>
      pieces.flatMap((piece) => piece.getAnimations().filter((animation) =>
        animation instanceof CSSTransition
        && animation.transitionProperty === 'transform'
        && (animation.playState === 'running' || animation.pending))).length),
    ).toBe(0)
    await auditAxeIncludingModerate(page, testInfo, 'board-motion')
  })

  test('rejects an illegal drag and preserves keyboard and non-spatial move input', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1200 })
    await page.goto(MOTION_PATH, { waitUntil: 'domcontentloaded' })
    const e2 = page.getByRole('gridcell', { name: /^e2,/u })
    const a8 = page.getByRole('gridcell', { name: /^a8,/u })
    await e2.scrollIntoViewIfNeeded()
    const [box, targetBox] = await Promise.all([e2.boundingBox(), a8.boundingBox()])
    if (!box || !targetBox) throw new Error('The drag regression squares are not rendered')
    await expect(e2).toHaveAttribute('data-draggable', 'true')
    // Exact pointercancel dispatch is covered in ui-coverage.test.tsx. A
    // browser-controlled mouse cannot reliably request the operating system's
    // pointer-cancellation path, so this case exercises a genuine invalid drop.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(page.getByText('The dragged piece was not moved to a legal target.')).toBeVisible()
    await expect(page.getByText('None', { exact: true })).toBeVisible()

    await e2.focus()
    await page.keyboard.press('Enter')
    await expect(e2).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByRole('gridcell', { name: /^e3,/u })).toBeFocused()
    await page.keyboard.press('Space')
    await expect(page.getByText(/e2e3 submitted through the real board input/u)).toBeVisible()

    await page.getByRole('button', { name: 'Reset position' }).click()
    const picker = page.getByRole('combobox', { name: 'Legal move picker' })
    await expect(picker).toBeVisible()
    await picker.selectOption('g1f3')
    await page.getByRole('button', { name: 'Play move' }).click()
    await expect(page.getByText(/g1f3 submitted through the real board input/u)).toBeVisible()
    await auditAxeIncludingModerate(page, testInfo, 'board-input-equivalence')
  })

  test('honors reduced motion and remains operable in forced colors', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
    await page.goto(MOTION_PATH, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.visual-piece-layer')).toHaveAttribute('data-motion', 'reduced')
    const pawnId = await pieceIdAt(page, 'e2')
    await page.getByRole('button', { name: 'Run transition' }).click()
    const pawn = page.locator(`.visual-piece[data-piece-id="${pawnId}"]`)
    await expect(pawn).toHaveAttribute('data-square', 'e4')
    await expect(pawn).toHaveCSS('transition-duration', '0s')
    expect(await transformAnimationCount(page, pawnId)).toBe(0)
    expect(await page.evaluate(() => ({
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      forced: matchMedia('(forced-colors: active)').matches,
    }))).toEqual({ reduced: true, forced: true })
    await assertNoPageOverflow(page, 'review board forced colors')
    await auditAxeIncludingModerate(page, testInfo, 'board-forced-colors-reduced-motion')
  })

  test('shows each tactical resource state without substituting opening recall', async ({ page }, testInfo) => {
    const states = [
      ['disabled', 'Tactical puzzles are not released yet'],
      ['loading', 'Loading the audited tactical puzzle shard'],
      ['empty', 'No matching tactical puzzles'],
      ['offline-empty', 'Puzzles unavailable offline'],
      ['rate-limited', 'Puzzle service is rate-limited'],
      ['corrupt', 'Puzzle shard rejected'],
      ['error', 'Puzzles unavailable'],
    ] as const
    for (const [state, copy] of states) {
      await page.goto(`${APP_PATH}?puzzleState=${state}#/puzzles`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText(copy, { exact: false })).toBeVisible()
      await expect(page.getByText(/Find the repertoire move/u)).toHaveCount(0)
      await auditAxeIncludingModerate(page, testInfo, `puzzle-resource-${state}`)
    }
    for (const state of ['stale', 'offline'] as const) {
      await page.goto(`${APP_PATH}?puzzleState=${state}#/puzzles`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: 'Puzzles', level: 1 })).toBeVisible()
      await expect(page.locator('.resource-notice')).toBeVisible()
      await auditAxeIncludingModerate(page, testInfo, `puzzle-resource-${state}`)
    }
  })

  test('replays castling, en passant, promotion, and an alternate mate through the tactical UI', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1200 })

    await page.goto(`${APP_PATH}?puzzleState=ready&puzzleScenario=castling#/puzzles`, { waitUntil: 'domcontentloaded' })
    const castlingKingId = await pieceIdAt(page, 'e1')
    const castlingRookId = await pieceIdAt(page, 'h1')
    await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption('e1g1')
    await page.getByRole('button', { name: 'Play move' }).click()
    await expect(page.locator(`.visual-piece[data-piece-id="${castlingKingId}"]`)).toHaveAttribute('data-square', 'g1')
    await expect(page.locator(`.visual-piece[data-piece-id="${castlingRookId}"]`)).toHaveAttribute('data-square', 'f1')
    await expect(page.getByText(/full audited line is complete/u)).toBeVisible()

    await page.goto(`${APP_PATH}?puzzleState=ready&puzzleScenario=en-passant#/puzzles`, { waitUntil: 'domcontentloaded' })
    const enPassantPawnId = await pieceIdAt(page, 'e5')
    const enPassantCapturedId = await pieceIdAt(page, 'd5')
    await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption('e5d6')
    await page.getByRole('button', { name: 'Play move' }).click()
    await expect(page.locator(`.visual-piece[data-piece-id="${enPassantPawnId}"]`)).toHaveAttribute('data-square', 'd6')
    await expect(page.locator(`.visual-piece[data-piece-id="${enPassantCapturedId}"]`)).toHaveCount(0, { timeout: 500 })
    await expect(page.getByText(/full audited line is complete/u)).toBeVisible()

    await page.goto(`${APP_PATH}?puzzleState=ready&puzzleScenario=promotion#/puzzles`, { waitUntil: 'domcontentloaded' })
    const promotionPawnId = await pieceIdAt(page, 'b7')
    await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption('b7b8q')
    await page.getByRole('button', { name: 'Play move' }).click()
    const promotedPiece = page.locator(`.visual-piece[data-piece-id="${promotionPawnId}"]`)
    await expect(promotedPiece).toHaveAttribute('data-square', 'b8')
    await expect(promotedPiece).toHaveAttribute('data-piece-type', 'wq')
    await expect(promotedPiece.locator('img')).toHaveCount(1)
    await expect(page.getByText(/full audited line is complete/u)).toBeVisible()

    await page.goto(`${APP_PATH}?puzzleState=ready&puzzleScenario=alternate-mate#/puzzles`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption('f7g7')
    await page.getByRole('button', { name: 'Play move' }).click()
    await expect(page.getByText('Solved with another legal mating move.')).toBeVisible()
    await expect(page.getByRole('progressbar', { name: '1 of 1 learner decisions completed' })).toHaveAttribute('value', '1')
    await auditAxeIncludingModerate(page, testInfo, 'puzzle-special-moves')
  })

  test('sequences learner and forced puzzle moves, focuses evidence, and keeps mobile controls above navigation', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto(`${APP_PATH}?puzzleState=ready#/puzzles`, { waitUntil: 'domcontentloaded' })
    const whiteKnightId = await pieceIdAt(page, 'g1')
    const blackKnightId = await pieceIdAt(page, 'b8')
    await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption('g1f3')
    await page.getByRole('button', { name: 'Play move' }).click()
    await expect(page.locator(`.visual-piece[data-piece-id="${whiteKnightId}"]`)).toHaveAttribute('data-square', 'f3')
    await expect(page.locator(`.visual-piece[data-piece-id="${blackKnightId}"]`)).toHaveAttribute('data-square', 'b8')
    await expect(page.getByText(/forced reply is playing now/u)).toBeVisible()
    await expect(page.getByText(/Opponent reply complete/u)).toBeVisible()
    await expect(page.locator(`.visual-piece[data-piece-id="${blackKnightId}"]`)).toHaveAttribute('data-square', 'c6')

    const f1 = page.getByRole('gridcell', { name: /^f1,/u })
    await f1.focus()
    await page.keyboard.press('Enter')
    const b5 = page.getByRole('gridcell', { name: /^b5,/u })
    await b5.focus()
    await page.keyboard.press('Space')
    await expect(page.getByText(/Solved\. The full audited line is complete/u)).toBeVisible()

    const why = page.getByRole('button', { name: 'Why' })
    const dock = page.getByRole('group', { name: 'Puzzle actions' })
    const nav = page.getByRole('navigation', { name: 'Primary navigation' })
    const [dockBox, navBox] = await Promise.all([dock.boundingBox(), nav.boundingBox()])
    if (!dockBox || !navBox) throw new Error('The mobile puzzle controls are not rendered')
    expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(navBox.y + 1)
    await why.click()
    await expect(page.getByRole('complementary', { name: 'Solution complete' })).toBeFocused()
    await expect(page.locator('.global-live-region')).toHaveText('Puzzle evidence opened.')
    await assertNoPageOverflow(page, 'review puzzle mobile')
    await testInfo.attach('review-puzzle-mobile-controls.png', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    })

    const visibleCopy = await page.locator('body').innerText()
    expect(visibleCopy).not.toMatch(
      /\b(?:expected_move|accepted_transposition|unverified_deviation|learner_index)\b|\uFFFD|\u00e2\u20ac\u201d|\u00c2\u00b7/u,
    )
    await auditAxeIncludingModerate(page, testInfo, 'puzzle-ready-mobile')
  })
})

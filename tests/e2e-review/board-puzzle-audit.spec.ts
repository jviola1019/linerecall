import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { assertNoPageOverflow } from '../e2e/helpers.ts'
import { attachReviewScreenshot } from './evidence.ts'

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
  await testInfo.attach(`axe-reviewed-${label}.json`, {
    body: JSON.stringify({
      automatedScan: true,
      manualAtEvidence: false,
      unresolvedContrast: result.incomplete.filter(({ id }) => id === 'color-contrast').length,
      violations: result.violations,
      incomplete: result.incomplete,
    }, null, 2),
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
    await attachReviewScreenshot(page, testInfo, 'review-board-normal-midpoint.png', { animations: 'allow' })
    await normal.evaluate((element) => {
      for (const animation of element.getAnimations()) animation.finish()
    })
    await page.waitForTimeout(220)

    await chooseScenario(page, 'capture')
    const capturingId = await pieceIdAt(page, 'e4')
    const capturedId = await pieceIdAt(page, 'd5')
    await page.evaluate((expectedCapturedId) => {
      const layer = document.querySelector('.visual-piece-layer')
      if (!layer) throw new Error('The visual piece layer is not rendered')
      document.body.dataset.captureStateObserved = 'false'
      const observeCapturedState = (): void => {
        const captured = Array.from(layer.querySelectorAll<HTMLElement>('.visual-piece'))
          .find((piece) => piece.dataset.pieceId === expectedCapturedId)
        if (captured?.dataset.transitionState !== 'captured') return
        document.body.dataset.captureStateObserved = 'true'
        observer.disconnect()
      }
      const observer = new MutationObserver(observeCapturedState)
      observer.observe(layer, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-transition-state'],
      })
      observeCapturedState()
    }, capturedId)
    await runTransition(page)
    await expect(page.locator(`.visual-piece[data-piece-id="${capturingId}"]`)).toHaveAttribute('data-square', 'd5')
    await expect.poll(() => page.evaluate(() => document.body.dataset.captureStateObserved)).toBe('true')
    await page.waitForTimeout(220)
    await expect(page.locator(`.visual-piece[data-piece-id="${capturedId}"]`)).toHaveCount(0)

    await chooseScenario(page, 'castling')
    const kingId = await pieceIdAt(page, 'e1')
    const rookId = await pieceIdAt(page, 'h1')
    await page.evaluate(({ expectedKingId, expectedRookId }) => {
      const layer = document.querySelector('.visual-piece-layer')
      if (!layer) throw new Error('The visual piece layer is not rendered')
      document.body.dataset.castlingMotionEvents = '[]'
      layer.addEventListener('transitionrun', (event) => {
        const transition = event as TransitionEvent
        const target = event.target
        if (transition.propertyName !== 'transform' || !(target instanceof HTMLElement)) return
        const pieceId = target.dataset.pieceId
        if (pieceId !== expectedKingId && pieceId !== expectedRookId) return
        const events = JSON.parse(document.body.dataset.castlingMotionEvents ?? '[]') as Array<{
          pieceId: string
          time: number
        }>
        events.push({ pieceId, time: performance.now() })
        document.body.dataset.castlingMotionEvents = JSON.stringify(events)
      })
    }, { expectedKingId: kingId, expectedRookId: rookId })
    await runTransition(page)
    await expect(page.locator(`.visual-piece[data-piece-id="${kingId}"]`)).toHaveAttribute('data-square', 'g1')
    await expect(page.locator(`.visual-piece[data-piece-id="${rookId}"]`)).toHaveAttribute('data-square', 'f1')
    await page.waitForFunction(({ expectedKingId, expectedRookId }) => {
      const events = JSON.parse(document.body.dataset.castlingMotionEvents ?? '[]') as Array<{ pieceId: string }>
      const seen = new Set(events.map(({ pieceId }) => pieceId))
      return seen.has(expectedKingId) && seen.has(expectedRookId)
    }, { expectedKingId: kingId, expectedRookId: rookId })
    const castlingEvents = JSON.parse(
      await page.locator('body').getAttribute('data-castling-motion-events') ?? '[]',
    ) as Array<{ pieceId: string; time: number }>
    const kingStart = castlingEvents.find(({ pieceId }) => pieceId === kingId)?.time
    const rookStart = castlingEvents.find(({ pieceId }) => pieceId === rookId)?.time
    expect(kingStart).toBeDefined()
    expect(rookStart).toBeDefined()
    expect(Math.abs(kingStart! - rookStart!)).toBeLessThanOrEqual(34)
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
    await page.evaluate((pieceId) => {
      type PromotionPhase = { state: string; imageCount: number }
      const layer = document.querySelector('.visual-piece-layer')
      if (!layer) throw new Error('The visual piece layer is not rendered')
      document.body.dataset.promotionPhases = '[]'
      const record = (): void => {
        const piece = document.querySelector<HTMLElement>(`.visual-piece[data-piece-id="${pieceId}"]`)
        if (!piece) return
        const phases = JSON.parse(document.body.dataset.promotionPhases ?? '[]') as PromotionPhase[]
        const next = {
          state: piece.dataset.transitionState ?? 'missing',
          imageCount: piece.querySelectorAll('img').length,
        }
        const previous = phases.at(-1)
        if (previous?.state === next.state && previous.imageCount === next.imageCount) return
        document.body.dataset.promotionPhases = JSON.stringify([...phases, next])
      }
      new MutationObserver(record).observe(layer, {
        attributes: true,
        attributeFilter: ['class', 'data-square', 'data-transition-state'],
        childList: true,
        subtree: true,
      })
      record()
    }, pawnId)
    await runTransition(page)
    const promoted = page.locator(`.visual-piece[data-piece-id="${pawnId}"]`)
    await expect(promoted).toHaveAttribute('data-square', 'a8')
    await expect(promoted).toHaveAttribute('data-transition-state', 'settled')
    await expect(promoted).toHaveAttribute('data-piece-type', 'wq')
    await expect(promoted.locator('img')).toHaveCount(1)
    const promotionPhases = JSON.parse(
      await page.locator('body').getAttribute('data-promotion-phases') ?? '[]',
    ) as Array<{ state: string; imageCount: number }>
    expect(promotionPhases.some(({ state, imageCount }) => state === 'travel' && imageCount === 2)).toBe(true)
    expect(promotionPhases.some(({ state, imageCount }) => state === 'crossfade' && imageCount === 2)).toBe(true)

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

    await page.evaluate(() => {
      document.body.dataset.rapidTransitionStarted = 'false'
      const layer = document.querySelector('.visual-piece-layer')
      const onTransitionRun = (event: Event): void => {
        const transition = event as TransitionEvent
        const target = event.target
        if (
          transition.propertyName !== 'transform'
          || !(target instanceof HTMLElement)
          || target.dataset.pieceId !== 'wp-e2'
        ) return
        document.body.dataset.rapidTransitionStarted = 'true'
        layer?.removeEventListener('transitionrun', onTransitionRun)
      }
      layer?.addEventListener('transitionrun', onTransitionRun)
    })
    await page.getByRole('button', { name: 'Run rapid reset and move' }).click()
    const rapidPawn = page.locator('.visual-piece[data-piece-id="wp-e2"]')
    await expect(rapidPawn).toHaveAttribute('data-square', 'e4')
    await expect.poll(() => page.evaluate(() => document.body.dataset.rapidTransitionStarted)).toBe('true')
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

  test('animates consecutive rapid resets under CPU throttling', async ({ page, browserName }) => {
    await page.goto(MOTION_PATH, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Board transition review' })).toBeVisible()
    const session = browserName === 'chromium' ? await page.context().newCDPSession(page) : null
    if (session) await session.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.evaluate(() => {
      const layer = document.querySelector('.visual-piece-layer')
      if (!layer) throw new Error('Visual piece layer is missing')
      layer.addEventListener('transitionrun', (event) => {
        const transition = event as TransitionEvent
        const target = event.target
        if (transition.propertyName === 'transform' && target instanceof HTMLElement && target.dataset.pieceId === 'wp-e2') {
          document.body.dataset.rapidTransitionStarted = 'true'
        }
      })
    })
    try {
      for (let iteration = 0; iteration < 8; iteration += 1) {
        if (iteration === 4) await page.getByRole('button', { name: 'Flip board' }).click()
        await page.evaluate(() => { document.body.dataset.rapidTransitionStarted = 'false' })
        await page.getByRole('button', { name: 'Run rapid reset and move' }).click()
        await expect.poll(() => page.evaluate(() => document.body.dataset.rapidTransitionStarted)).toBe('true')
        await expect(page.locator('.visual-piece[data-piece-id="wp-e2"]')).toHaveAttribute('data-square', 'e4')
        await expect(page.locator('.visual-piece-layer')).not.toHaveClass(/visual-piece-layer-static/u)
      }
    } finally {
      if (session) await session.detach()
    }
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
      ['disabled', 'Verified puzzles aren’t included in this build yet.'],
      ['loading', 'Loading puzzles'],
      ['empty', 'No matching tactical puzzles'],
      ['offline-empty', 'Puzzles unavailable offline'],
      ['rate-limited', 'Puzzle service is rate-limited'],
      ['corrupt', 'Puzzles could not be loaded'],
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

  test('separates mobile edge coordinates from pieces in both board orientations', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto(`${APP_PATH}?puzzleState=ready#/puzzles`, { waitUntil: 'domcontentloaded' })
    const board = page.getByRole('grid', { name: 'Chessboard, white orientation' })
    await expect(board).toBeVisible()

    const edgeSnapshot = async (): Promise<{
      orientation: string | undefined
      firstRow: string[]
      lastRow: string[]
      ranks: string[]
      files: string[]
      overlaps: Array<{ square: string; coordinate: string }>
      compared: number
    }> => page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('.chessboard')
      const layer = document.querySelector<HTMLElement>('.visual-piece-layer')
      if (!grid || !layer) throw new Error('The board layers are not rendered')
      const rows = [...grid.querySelectorAll<HTMLElement>('.board-row')]
      const squareName = (square: HTMLElement): string => square.getAttribute('aria-label')?.split(',')[0] ?? ''
      const rowNames = (row: HTMLElement | undefined): string[] => row
        ? [...row.querySelectorAll<HTMLElement>('.board-square')].map(squareName)
        : []
      const overlaps: Array<{ square: string; coordinate: string }> = []
      let compared = 0
      for (const label of grid.querySelectorAll<HTMLElement>('.rank-label, .file-label')) {
        const square = label.closest<HTMLElement>('.board-square')
        if (!square) continue
        const coordinate = squareName(square)
        const piece = layer.querySelector<HTMLElement>(`.visual-piece[data-square="${coordinate}"] .piece`)
        if (!piece) continue
        compared += 1
        const labelBox = label.getBoundingClientRect()
        const pieceBox = piece.getBoundingClientRect()
        const intersects = Math.min(labelBox.right, pieceBox.right) - Math.max(labelBox.left, pieceBox.left) > 0.25
          && Math.min(labelBox.bottom, pieceBox.bottom) - Math.max(labelBox.top, pieceBox.top) > 0.25
        if (intersects) overlaps.push({ square: coordinate, coordinate: label.textContent ?? '' })
      }
      return {
        orientation: layer.dataset.orientation,
        firstRow: rowNames(rows[0]),
        lastRow: rowNames(rows.at(-1)),
        ranks: [...grid.querySelectorAll<HTMLElement>('.rank-label')].map(({ textContent }) => textContent ?? ''),
        files: [...grid.querySelectorAll<HTMLElement>('.file-label')].map(({ textContent }) => textContent ?? ''),
        overlaps,
        compared,
      }
    })

    const white = await edgeSnapshot()
    expect(white).toMatchObject({
      orientation: 'white',
      firstRow: ['a8', 'b8', 'c8', 'd8', 'e8', 'f8', 'g8', 'h8'],
      lastRow: ['a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1'],
      ranks: ['8', '7', '6', '5', '4', '3', '2', '1'],
      files: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      overlaps: [],
    })
    expect(white.compared).toBeGreaterThan(0)

    await page.getByRole('button', { name: 'Flip board' }).click()
    await expect(page.getByRole('grid', { name: 'Chessboard, black orientation' })).toBeVisible()
    const black = await edgeSnapshot()
    expect(black).toMatchObject({
      orientation: 'black',
      firstRow: ['h1', 'g1', 'f1', 'e1', 'd1', 'c1', 'b1', 'a1'],
      lastRow: ['h8', 'g8', 'f8', 'e8', 'd8', 'c8', 'b8', 'a8'],
      ranks: ['1', '2', '3', '4', '5', '6', '7', '8'],
      files: ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'],
      overlaps: [],
    })
    expect(black.compared).toBeGreaterThan(0)

    await testInfo.attach('mobile-board-coordinate-separation.json', {
      body: JSON.stringify({ viewport: { width: 320, height: 800 }, white, black }, null, 2),
      contentType: 'application/json',
    })
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
    await expect(page.getByText(/full line is complete/u)).toBeVisible()

    await page.goto(`${APP_PATH}?puzzleState=ready&puzzleScenario=en-passant#/puzzles`, { waitUntil: 'domcontentloaded' })
    const enPassantPawnId = await pieceIdAt(page, 'e5')
    const enPassantCapturedId = await pieceIdAt(page, 'd5')
    await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption('e5d6')
    await page.getByRole('button', { name: 'Play move' }).click()
    await expect(page.locator(`.visual-piece[data-piece-id="${enPassantPawnId}"]`)).toHaveAttribute('data-square', 'd6')
    await expect(page.locator(`.visual-piece[data-piece-id="${enPassantCapturedId}"]`)).toHaveCount(0, { timeout: 500 })
    await expect(page.getByText(/full line is complete/u)).toBeVisible()

    await page.goto(`${APP_PATH}?puzzleState=ready&puzzleScenario=promotion#/puzzles`, { waitUntil: 'domcontentloaded' })
    const promotionPawnId = await pieceIdAt(page, 'b7')
    await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption('b7b8q')
    await page.getByRole('button', { name: 'Play move' }).click()
    const promotedPiece = page.locator(`.visual-piece[data-piece-id="${promotionPawnId}"]`)
    await expect(promotedPiece).toHaveAttribute('data-square', 'b8')
    await expect(promotedPiece).toHaveAttribute('data-piece-type', 'wq')
    await expect(promotedPiece.locator('img')).toHaveCount(1)
    await expect(page.getByText(/full line is complete/u)).toBeVisible()

    await page.goto(`${APP_PATH}?puzzleState=ready&puzzleScenario=alternate-mate#/puzzles`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption('f7g7')
    await page.getByRole('button', { name: 'Play move' }).click()
    await expect(page.getByText('Solved with another legal mating move.')).toBeVisible()
    await expect(page.getByRole('progressbar', { name: '1 of 1 moves completed' })).toHaveAttribute('value', '1')
    await auditAxeIncludingModerate(page, testInfo, 'puzzle-special-moves')
  })

  test('sequences learner and forced puzzle moves, focuses evidence, and keeps mobile controls above navigation', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto(`${APP_PATH}?puzzleState=ready#/puzzles`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.review-fixture-banner')).toBeVisible()
    await expect(page.locator('.app-header')).toBeVisible()
    const fixtureTop = await page.evaluate(() => {
      const banner = document.querySelector<HTMLElement>('.review-fixture-banner')?.getBoundingClientRect()
      const header = document.querySelector<HTMLElement>('.app-header')?.getBoundingClientRect()
      if (!banner || !header) throw new Error('The mobile fixture header is incomplete')
      return {
        banner: { top: banner.top, bottom: banner.bottom },
        header: { top: header.top },
      }
    })
    expect(Math.abs(fixtureTop.banner.top), 'synthetic fixture banner must touch the viewport top').toBeLessThanOrEqual(1)
    expect(
      Math.abs(fixtureTop.header.top - fixtureTop.banner.bottom),
      'app content must start immediately after the synthetic fixture banner',
    ).toBeLessThanOrEqual(1)
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
    await expect(page.getByText(/Solved\. The full line is complete/u)).toBeVisible()

    const guides = page.getByRole('list', { name: 'Visible board guides' })
    await expect(guides).toContainText('Solution move')
    await expect(guides).not.toContainText('Book move')

    const why = page.getByRole('button', { name: 'Why' })
    const boardFrame = page.locator('.chessboard-overlay-frame')
    const dock = page.getByRole('group', { name: 'Puzzle actions' })
    const nav = page.getByRole('navigation', { name: 'Primary navigation' })
    const [boardBox, dockBox, navBox] = await Promise.all([
      boardFrame.boundingBox(),
      dock.boundingBox(),
      nav.boundingBox(),
    ])
    if (!boardBox || !dockBox || !navBox) throw new Error('The mobile puzzle controls are not rendered')
    expect(boardBox.y + boardBox.height).toBeLessThanOrEqual(dockBox.y + 1)
    expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(navBox.y + 1)
    await why.click()
    await expect(page.getByRole('complementary', { name: 'Solution complete' })).toBeFocused()
    await expect(page.locator('.global-live-region')).toHaveText('Puzzle details opened.')
    const focusedLayout = await page.evaluate(() => {
      const banner = document.querySelector<HTMLElement>('.review-fixture-banner')?.getBoundingClientRect()
      const evidence = document.querySelector<HTMLElement>('.tactical-evidence')?.getBoundingClientRect()
      if (!banner || !evidence) throw new Error('The focused mobile fixture layout is incomplete')
      return {
        banner: { top: banner.top, bottom: banner.bottom },
        evidence: { top: evidence.top },
      }
    })
    expect(Math.abs(focusedLayout.banner.top), 'synthetic fixture banner must stay at the viewport top after focus moves').toBeLessThanOrEqual(1)
    await assertNoPageOverflow(page, 'review puzzle mobile')
    await attachReviewScreenshot(page, testInfo, 'review-puzzle-mobile-controls.png')
    await testInfo.attach('review-puzzle-mobile-layout.json', {
      body: JSON.stringify({
        viewport: page.viewportSize(),
        initial: fixtureTop,
        focused: focusedLayout,
        dock: { top: dockBox.y, bottom: dockBox.y + dockBox.height },
        navigation: { top: navBox.y, bottom: navBox.y + navBox.height },
      }, null, 2),
      contentType: 'application/json',
    })

    const visibleCopy = await page.locator('body').innerText()
    expect(visibleCopy).not.toMatch(
      /\b(?:expected_move|accepted_transposition|unverified_deviation|learner_index)\b|\uFFFD|\u00e2\u20ac\u201d|\u00c2\u00b7/u,
    )
    await auditAxeIncludingModerate(page, testInfo, 'puzzle-ready-mobile')
  })
})

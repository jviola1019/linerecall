import { expect, test, type Page } from '@playwright/test'
import { attachReviewScreenshot } from './evidence.ts'
import {
  assertNoPageOverflow,
  assertNoSeriousOrCriticalAxe,
} from '../e2e/helpers.ts'

const HARNESS_PATH = '/index.html'

async function playMove(page: Page, uci: string): Promise<void> {
  const picker = page.getByRole('combobox', { name: 'Legal move picker' })
  await expect(picker).toBeEnabled()
  await picker.selectOption(uci)
  await page.getByRole('button', { name: 'Play move' }).click()
}

async function expectCompletedPaths(page: Page, count: number): Promise<void> {
  const completedPaths = page.locator('dt', { hasText: /^Practiced$/u }).locator('..')
  await expect(completedPaths.locator('dd')).toHaveText(String(count))
}

test.describe('review-only unified-family fixture', () => {
  test('starts full-family practice directly from its single catalog entry', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto(`${HARNESS_PATH}#/repertoire`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Repertoire', level: 1 })).toBeVisible()
    await page.getByRole('searchbox', { name: 'Find an opening' }).fill('Caro')
    await expect(page.locator('.family-card')).toHaveCount(1)
    const practice = page.getByRole('button', { name: 'Practice all Caro–Kann variations as White' })
    await expect(practice).toBeInViewport({ ratio: 1 })
    const actionBox = await practice.boundingBox()
    const navigationBox = await page.getByRole('navigation', { name: 'Primary navigation' }).boundingBox()
    if (!actionBox || !navigationBox) throw new Error('Family action and mobile navigation must render')
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(navigationBox.y)
    await assertNoPageOverflow(page, 'direct family practice at 320px')
    const navLabels = await page.getByRole('navigation', { name: 'Primary navigation' }).locator('button > span').evaluateAll((labels) =>
      labels.map((label) => {
        const box = label.getBoundingClientRect()
        const button = label.parentElement!.getBoundingClientRect()
        return { left: box.left, right: box.right, parentLeft: button.left, parentRight: button.right, scroll: label.scrollWidth, width: label.clientWidth }
      }))
    for (const label of navLabels) {
      expect(label.left).toBeGreaterThanOrEqual(label.parentLeft)
      expect(label.right).toBeLessThanOrEqual(label.parentRight)
      expect(label.scroll).toBeLessThanOrEqual(label.width + 1)
    }
    await attachReviewScreenshot(page, testInfo, 'review-family-catalog-320.png', {
      path: 'audit/generated/review-family-catalog-320.png',
    })
    await practice.click()
    await expect(page).toHaveURL(/#\/train\/caro-kann\/white$/u)
    await expect(page.getByRole('grid', { name: /Chessboard/u })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start spaced-repetition drill' })).toHaveCount(0)
  })

  test('continues autonomously across both paths without grade buttons', async ({ page }, testInfo) => {
    await page.goto(`${HARNESS_PATH}#/train/caro-kann/white`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('note')).toContainText(/synthetic data.*not production/u)
    await expect(page.getByRole('heading', { name: /Caro.Kann/iu, level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Start full opening' }).click()
    await expect(page.getByText(/Variation 1 of 2/u)).toBeVisible()
    await expect(page.getByRole('button', { name: /^(Again|Hard|Good|Easy)$/u })).toHaveCount(0)

    await playMove(page, 'g1f3')
    await expect(page.getByText(/Variation 1 of 2.*1 of 3 moves played/u)).toBeVisible()
    await playMove(page, 'g2g3')
    await expect(page.getByText(/Variation 1 of 2.*2 of 3 moves played/u)).toBeVisible()
    await playMove(page, 'f1g2')
    await expect(page.getByText(/Variation 2 of 2/u)).toBeVisible()
    await expectCompletedPaths(page, 1)

    await playMove(page, 'g2g3')
    await expect(page.getByText(/Variation 2 of 2.*1 of 3 moves played/u)).toBeVisible()
    await playMove(page, 'g1f3')
    await expect(page.getByText(/Variation 2 of 2.*2 of 3 moves played/u)).toBeVisible()
    await playMove(page, 'f1g2')

    await expect(page.getByRole('heading', { name: 'Every selected variation is complete.' })).toBeVisible()
    await expect(page.locator('.family-training-progress')).toHaveText('2 of 2 variations practiced this round.')
    await expect(page.getByRole('button', { name: /^(Again|Hard|Good|Easy)$/u })).toHaveCount(0)
    await expect(page.getByRole('note')).toBeVisible()
    await attachReviewScreenshot(page, testInfo, 'review-fixture-family-complete.png', {
      animations: 'disabled',
      path: 'audit/generated/review-fixture-family-complete.png',
    })
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'review-fixture-family-training')
  })

  test('solves a ready tactical puzzle while recall progress remains independent', async ({ page }, testInfo) => {
    await page.goto(`${HARNESS_PATH}#/puzzles`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('note')).toContainText(/synthetic data.*not production/u)
    await expect(page.getByRole('heading', { name: 'Puzzles', level: 1 })).toBeVisible()

    await playMove(page, 'g1f3')
    await expect(page.getByText(/Opponent reply complete/u)).toBeVisible()
    await playMove(page, 'f1b5')
    await expect(page.getByText(/Solved\. The full line is complete/u)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Practice again' })).toBeEnabled()
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'review-fixture-ready-puzzle')

    await page.getByRole('button', { name: 'Progress' }).click()
    await expect(page.getByRole('heading', { name: 'Your progress' })).toBeVisible()
    const recallSummary = page.getByText('Moves reviewed').locator('..')
    await expect(recallSummary.locator('strong')).toHaveText('0')
    const tacticalSummary = page.locator('.progress-separated-summary article').filter({ hasText: 'Tactical puzzles' })
    await expect(tacticalSummary.locator('strong')).toHaveText('1')
    const puzzleRow = page.getByRole('row', { name: /Puzzle1/u })
    await expect(puzzleRow).toContainText('33%')
    await expect(puzzleRow).toContainText('1')
    await expect(page.getByText(/Puzzle attempts never change opening recall or variations practiced/u)).toBeVisible()
    await expect(page.getByRole('note')).toBeVisible()
    await attachReviewScreenshot(page, testInfo, 'review-fixture-puzzle-progress.png', {
      animations: 'disabled',
      path: 'audit/generated/review-fixture-puzzle-progress.png',
    })
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'review-fixture-independent-progress')
  })

  test('keeps the unified family board and primary controls usable in one mobile viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${HARNESS_PATH}#/train/caro-kann/white`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Start full opening' }).click()
    await expect(page.getByRole('grid', { name: /Chessboard/u })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Legal move picker' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show hint' })).toBeVisible()
    await expect(page.getByRole('note')).toBeVisible()
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    const [boardBox, toolBox, navigationBox] = await Promise.all([
      page.getByRole('grid', { name: /Chessboard/u }).boundingBox(),
      page.getByRole('toolbar', { name: 'Training tools' }).boundingBox(),
      page.getByRole('navigation', { name: 'Primary navigation' }).boundingBox(),
    ])
    if (!boardBox || !toolBox || !navigationBox) {
      throw new Error('The mobile board, training tools, and navigation must render together')
    }
    expect(boardBox.y).toBeGreaterThanOrEqual(0)
    expect(boardBox.y + boardBox.height).toBeLessThanOrEqual(toolBox.y + 1)
    expect(toolBox.y + toolBox.height).toBeLessThanOrEqual(navigationBox.y + 1)
    await assertNoPageOverflow(page, 'review fixture mobile family training')

    const pauseBox = await page.getByRole('button', { name: 'Pause' }).boundingBox()
    const more = page.locator('summary[aria-label="More session options"]')
    const moreBox = await more.boundingBox()
    for (const [label, box] of [['Pause', pauseBox], ['More session options', moreBox]] as const) {
      if (!box) throw new Error(`${label} must remain visible in mobile family training`)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
    }
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('details.mobile-session-menu')).toHaveAttribute('open', '')
    for (const label of ['Flip board', 'Skip variation', 'Choose variation', 'Stop training']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible()
    }
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('details.mobile-session-menu')).not.toHaveAttribute('open', '')

    const targets = await page.locator(
      'button:visible, summary:visible, select:visible, [role="button"]:visible',
    ).evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, height: rect.height, label: element.getAttribute('aria-label') ?? element.textContent?.trim() }
    }))
    expect(targets.filter(({ width, height }) => width < 44 || height < 44)).toEqual([])
    await attachReviewScreenshot(page, testInfo, 'review-fixture-mobile-family-training.png', {
      animations: 'disabled',
      path: 'audit/generated/review-fixture-mobile-family-training.png',
    })
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'review-fixture-mobile-family-training')
  })
})

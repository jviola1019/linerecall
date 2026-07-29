import { expect, test, type Page } from '@playwright/test'
import { assertNoPageOverflow, assertNoSeriousOrCriticalAxe } from '../e2e/helpers.ts'

const HARNESS_PATH = '/index.html'

async function playMove(page: Page, uci: string): Promise<void> {
  const picker = page.getByRole('combobox', { name: 'Legal move picker' })
  await expect(picker).toBeEnabled()
  await picker.selectOption(uci)
  await page.getByRole('button', { name: 'Play move' }).click()
}

async function expectCompletedPaths(page: Page, count: number): Promise<void> {
  const completedPaths = page.locator('dt', { hasText: /^Completed paths$/u }).locator('..')
  await expect(completedPaths.locator('dd')).toHaveText(String(count))
}

test.describe('review-only unified-family fixture', () => {
  test('continues autonomously across both paths without grade buttons', async ({ page }, testInfo) => {
    await page.goto(`${HARNESS_PATH}#/train/caro-kann/white`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('note')).toContainText(/synthetic data.*not production/u)
    await expect(page.getByRole('heading', { name: /Caro.Kann/iu, level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Start full repertoire' }).click()
    await expect(page.getByText(/Path 1 of 2/u)).toBeVisible()
    await expect(page.getByRole('button', { name: /^(Again|Hard|Good|Easy)$/u })).toHaveCount(0)

    await playMove(page, 'g1f3')
    await expect(page.getByText(/move 3 of 6/u)).toBeVisible()
    await playMove(page, 'g2g3')
    await expect(page.getByText(/move 5 of 6/u)).toBeVisible()
    await playMove(page, 'f1g2')
    await expect(page.getByText(/Path 2 of 2/u)).toBeVisible()
    await expectCompletedPaths(page, 1)

    await playMove(page, 'g2g3')
    await expect(page.getByText(/move 3 of 6/u)).toBeVisible()
    await playMove(page, 'g1f3')
    await expect(page.getByText(/move 5 of 6/u)).toBeVisible()
    await playMove(page, 'f1g2')

    await expect(page.getByRole('heading', { name: 'Every selected path is complete.' })).toBeVisible()
    await expect(page.getByText(/2 of 2 audited paths completed/u)).toBeVisible()
    await expect(page.getByRole('button', { name: /^(Again|Hard|Good|Easy)$/u })).toHaveCount(0)
    await expect(page.getByRole('note')).toBeVisible()
    await testInfo.attach('review-fixture-family-complete.png', {
      body: await page.screenshot({
        animations: 'disabled',
        path: 'audit/generated/review-fixture-family-complete.png',
      }),
      contentType: 'image/png',
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
    await expect(page.getByText(/Solved\. The full audited line is complete/u)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next puzzle' })).toBeEnabled()
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'review-fixture-ready-puzzle')

    await page.getByRole('button', { name: 'Progress' }).click()
    await expect(page.getByRole('heading', { name: 'Your progress' })).toBeVisible()
    const recallSummary = page.getByText('Cards reviewed').locator('..')
    await expect(recallSummary.locator('strong')).toHaveText('0')
    const tacticalSummary = page.locator('.progress-separated-summary article').filter({ hasText: 'Tactical puzzles' })
    await expect(tacticalSummary.locator('strong')).toHaveText('1')
    const puzzleRow = page.getByRole('row', { name: /Puzzle1/u })
    await expect(puzzleRow).toContainText('33%')
    await expect(puzzleRow).toContainText('1')
    await expect(page.getByText(/Puzzle attempts never change opening-recall schedules/u)).toBeVisible()
    await expect(page.getByRole('note')).toBeVisible()
    await testInfo.attach('review-fixture-puzzle-progress.png', {
      body: await page.screenshot({
        animations: 'disabled',
        path: 'audit/generated/review-fixture-puzzle-progress.png',
      }),
      contentType: 'image/png',
    })
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'review-fixture-independent-progress')
  })

  test('keeps the unified family board and primary controls usable in one mobile viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${HARNESS_PATH}#/train/caro-kann/white`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Start full repertoire' }).click()
    await expect(page.getByRole('grid', { name: /Chessboard/u })).toBeVisible()
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
    expect(toolBox.y + toolBox.height).toBeLessThanOrEqual(navigationBox.y + 1)
    await assertNoPageOverflow(page, 'review fixture mobile family training')

    const targets = await page.locator(
      'button:visible, select:visible, [role="button"]:visible',
    ).evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, height: rect.height, label: element.getAttribute('aria-label') ?? element.textContent?.trim() }
    }))
    expect(targets.filter(({ width, height }) => width < 44 || height < 44)).toEqual([])
    await testInfo.attach('review-fixture-mobile-family-training.png', {
      body: await page.screenshot({
        animations: 'disabled',
        path: 'audit/generated/review-fixture-mobile-family-training.png',
      }),
      contentType: 'image/png',
    })
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'review-fixture-mobile-family-training')
  })
})

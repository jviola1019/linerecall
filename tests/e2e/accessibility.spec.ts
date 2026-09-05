import { test, expect } from '@playwright/test'
import {
  assertNoSeriousOrCriticalAxe,
  loadReadyApp,
  openDataLicenses,
  openRepertoire,
  openRepertoirePacks,
  playPickerMove,
  revealExpectedMove,
  startAnyDrill,
} from './helpers.ts'

test.describe('automated accessibility gate', () => {
  test('all primary views have zero serious or critical axe findings', async ({ page }, testInfo) => {
    // Every primary destination is a separate accessibility surface. Retain
    // axe's complete result (including incomplete and moderate findings) in
    // the attachment emitted by the shared helper; only the documented hard
    // impacts are asserted automatically here.
    test.setTimeout(180_000)
    await loadReadyApp(page)
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'today-dark')

    await openRepertoirePacks(page)
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'repertoire-dark')

    await page.getByRole('button', { name: 'Puzzles', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Puzzles', level: 1 })).toBeVisible()
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'puzzles-dark')

    await openRepertoire(page)
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'explore-dark')

    await page.getByRole('button', { name: 'Progress' }).click()
    await expect(page.getByRole('heading', { name: 'Your progress' })).toBeVisible()
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'progress-dark')

    await openDataLicenses(page)
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'data-dark')

    await startAnyDrill(page)
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'drill-dark')
  })

  test('light, reduced-motion, and forced-colors modes retain accessible semantics', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' })
    await loadReadyApp(page)
    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    // axe's authored-color algorithm does not model forced system colors. Run all
    // semantic rules here and verify the actual forced-color rendering separately.
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'today-forced-colors-reduced-motion', { disableColorContrast: true })
    const forcedColors = await page.evaluate(() => {
      const body = getComputedStyle(document.body)
      const heading = getComputedStyle(document.querySelector('h1') as HTMLElement)
      return {
        active: matchMedia('(forced-colors: active)').matches,
        bodyColor: body.color,
        bodyBackground: body.backgroundColor,
        headingColor: heading.color,
        adjustment: body.forcedColorAdjust,
      }
    })
    expect(forcedColors.active).toBe(true)
    // WebKit applies forced-color emulation but does not expose the
    // forcedColorAdjust computed-style property through JavaScript.
    if (forcedColors.adjustment !== undefined) expect(forcedColors.adjustment).toBe('auto')
    expect(forcedColors.bodyColor).toBe(forcedColors.headingColor)
    expect(forcedColors.bodyColor).not.toBe(forcedColors.bodyBackground)
    const duration = await page.locator('.app-shell').evaluate((element) =>
      getComputedStyle(element).transitionDuration
    )
    expect(duration === '0s' || duration === '0.00001s').toBeTruthy()
  })

  test('authored light mode, move feedback, and the mobile statistics dialog pass automated semantics', async ({ page }, testInfo) => {
    test.setTimeout(150_000)
    await page.setViewportSize({ width: 390, height: 844 })
    await loadReadyApp(page)
    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'today-light')

    await page.getByRole('button', { name: 'Progress' }).click()
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'progress-light')
    await openDataLicenses(page)
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'data-light')

    await startAnyDrill(page)
    const expected = await revealExpectedMove(page)
    const statistics = page.getByRole('button', { name: 'View line statistics' })
    await statistics.click()
    await expect(page.getByRole('dialog', { name: 'Line statistics' })).toBeVisible()
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'mobile-statistics-dialog-light')
    await page.getByRole('button', { name: 'Close statistics' }).click()

    await playPickerMove(page, expected.uci)
    await assertNoSeriousOrCriticalAxe(page, testInfo, 'move-feedback-light')
  })
})

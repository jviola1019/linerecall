import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import {
  APP_PATH,
  assertNoPageOverflow,
  loadReadyApp,
  openRepertoire,
  revealExpectedMove,
  startAnyDrill,
  waitForReadyApp,
} from './helpers.ts'

const VIEWPORTS = [
  { name: 'phone-360', width: 360, height: 800 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const

test('phone, tablet, and desktop layouts do not overflow and expose audited target sizes', async ({ page }, testInfo) => {
  await loadReadyApp(page)
  await openRepertoire(page)
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.waitForTimeout(50)
    await assertNoPageOverflow(page, viewport.name)
    if (viewport.width <= 900) {
      const nav = await page.locator('.primary-nav').evaluate((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return { position: style.position, bottom: rect.bottom, top: rect.top }
      })
      expect(nav.position, `${viewport.name}: mobile primary nav is not fixed`).toBe('fixed')
      expect(Math.abs(viewport.height - nav.bottom), `${viewport.name}: mobile primary nav is not at viewport bottom`).toBeLessThanOrEqual(2)
      expect(nav.top, `${viewport.name}: mobile primary nav occupies the top of the viewport`).toBeGreaterThan(viewport.height / 2)
      const boundedBrowsers = await page.evaluate(() => {
        const sample = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector)
          if (!element) return null
          const style = getComputedStyle(element)
          return {
            display: style.display,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
          }
        }
        return { eco: sample('.eco-list'), lines: sample('.line-list') }
      })
      for (const [label, list] of Object.entries(boundedBrowsers)) {
        expect(list, `${viewport.name}: ${label} list is missing`).not.toBeNull()
        expect(list?.display, `${viewport.name}: ${label} list does not reflow vertically`).toBe('grid')
        expect(list?.overflowX, `${viewport.name}: ${label} list remains a horizontal carousel`).toBe('hidden')
        expect(list?.overflowY, `${viewport.name}: ${label} list is not vertically scrollable`).toBe('auto')
        expect(list?.scrollWidth ?? 0, `${viewport.name}: ${label} list has non-exempt horizontal overflow`).toBeLessThanOrEqual((list?.clientWidth ?? 0) + 1)
        expect(list?.scrollHeight ?? 0, `${viewport.name}: ${label} list is not a bounded viewport`).toBeGreaterThanOrEqual(list?.clientHeight ?? 0)
      }
    }
  }

  await startAnyDrill(page)
  const targetEvidence: Array<Record<string, unknown>> = []
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.waitForTimeout(50)
    await assertNoPageOverflow(page, `${viewport.name} drill`)
    const sample = await page.evaluate(() => {
      const visible = (element: Element): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }
      const controls = [...document.querySelectorAll('button:not(.board-square), select, input:not([type="hidden"]), textarea, a[href], summary')]
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            tag: element.tagName,
            name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 80) ?? '',
            width: Math.round(rect.width * 10) / 10,
            height: Math.round(rect.height * 10) / 10,
          }
        })
      const boardSquares = [...document.querySelectorAll('.board-square')].filter(visible).map((element) => {
        const rect = element.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      })
      const picker = document.querySelector('.move-picker select')
      const play = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Play move')
      const pickerRect = picker?.getBoundingClientRect()
      const playRect = play?.getBoundingClientRect()
      return {
        controls,
        undersizedControls: controls.filter((control) => control.width + 0.5 < 44 || control.height + 0.5 < 44),
        boardSquareCount: boardSquares.length,
        minimumBoardSquare: {
          width: Math.min(...boardSquares.map((square) => square.width)),
          height: Math.min(...boardSquares.map((square) => square.height)),
        },
        picker: pickerRect ? { width: pickerRect.width, height: pickerRect.height } : null,
        play: playRect ? { width: playRect.width, height: playRect.height } : null,
      }
    })
    expect(sample.undersizedControls, `${viewport.name}: visible non-spatial controls below 44×44 CSS pixels`).toEqual([])
    expect(sample.boardSquareCount, `${viewport.name}: board square count`).toBe(64)
    expect(sample.minimumBoardSquare.width, `${viewport.name}: spatial board target width`).toBeGreaterThanOrEqual(24)
    expect(sample.minimumBoardSquare.height, `${viewport.name}: spatial board target height`).toBeGreaterThanOrEqual(24)
    expect(sample.picker?.width, `${viewport.name}: legal-move picker width`).toBeGreaterThanOrEqual(44)
    expect(sample.picker?.height, `${viewport.name}: legal-move picker height`).toBeGreaterThanOrEqual(44)
    expect(sample.play?.width, `${viewport.name}: Play move width`).toBeGreaterThanOrEqual(44)
    expect(sample.play?.height, `${viewport.name}: Play move height`).toBeGreaterThanOrEqual(44)
    targetEvidence.push({ viewport, ...sample })
  }
  const darkSquareCoordinateContrast = await page.evaluate(() => {
    const channels = (value: string): number[] => value.match(/[\d.]+/gu)?.slice(0, 3).map(Number) ?? []
    const luminance = (value: string): number => {
      const linear = channels(value).map((channel) => {
        const normalized = channel / 255
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      })
      return (0.2126 * (linear[0] ?? 0)) + (0.7152 * (linear[1] ?? 0)) + (0.0722 * (linear[2] ?? 0))
    }
    return [...document.querySelectorAll<HTMLElement>('.dark-square .rank-label, .dark-square .file-label')].map((label) => {
      const foreground = getComputedStyle(label).color
      const square = label.closest<HTMLElement>('.dark-square')
      const background = square ? getComputedStyle(square).backgroundColor : 'rgb(0, 0, 0)'
      const foregroundLuminance = luminance(foreground)
      const backgroundLuminance = luminance(background)
      return {
        foreground,
        background,
        ratio: (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
          / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
      }
    })
  })
  expect(darkSquareCoordinateContrast.length, 'no dark-square coordinate labels were rendered').toBeGreaterThan(0)
  expect(
    darkSquareCoordinateContrast.every(({ ratio }) => ratio >= 4.5),
    `dark-square coordinate contrast is below 4.5:1: ${JSON.stringify(darkSquareCoordinateContrast)}`,
  ).toBe(true)
  await testInfo.attach('dark-square-coordinate-contrast.json', {
    body: JSON.stringify(darkSquareCoordinateContrast, null, 2),
    contentType: 'application/json',
  })
  await testInfo.attach('computed-target-sizes.json', {
    body: JSON.stringify(targetEvidence, null, 2),
    contentType: 'application/json',
  })
})

test('an open mobile statistics sheet remains visible and closable after desktop reflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await loadReadyApp(page)
  await startAnyDrill(page)
  await page.getByRole('button', { name: 'View statistics (counts as hint)' }).click()
  const dialog = page.getByRole('dialog', { name: 'Line statistics' })
  const close = dialog.getByRole('button', { name: 'Close statistics' })
  await expect(dialog).toBeVisible()
  await expect(close).toBeFocused()
  // The portalled dialog is a direct body child, so the background root is
  // the inert boundary. Descendants inherit inertness without duplicating the
  // attribute on `.app-shell`.
  await expect(page.locator('#root')).toHaveAttribute('inert', '')

  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(dialog).toBeVisible()
  await expect(close).toBeVisible()
  await close.click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '')
  await expect(page.locator('.drill-header h1')).toBeFocused()
  await expect(page.locator('.mobile-stats-trigger')).toBeHidden()
})

test('320 CSS-pixel reflow preserves board and equivalent-picker targets at 200%/400% equivalents', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await loadReadyApp(page)
  await assertNoPageOverflow(page, '320 CSS-pixel reflow')
  await startAnyDrill(page)
  await assertNoPageOverflow(page, '320 CSS-pixel drill reflow')
  const targetSample = await page.evaluate(() => {
    const squares = [...document.querySelectorAll<HTMLElement>('.board-square')].map((element) => element.getBoundingClientRect())
    const picker = document.querySelector<HTMLSelectElement>('.move-picker select')?.getBoundingClientRect()
    const play = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Play move')?.getBoundingClientRect()
    const visibleControls = [...document.querySelectorAll<HTMLElement>('button:not(.board-square), select, input:not([type="hidden"]), textarea, a[href], summary')]
      .map((element) => ({ element, style: getComputedStyle(element), rect: element.getBoundingClientRect() }))
      .filter(({ style, rect }) => style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0)
      .map(({ element, rect }) => ({ name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 80) ?? '', width: rect.width, height: rect.height }))
    return {
      boardSquareCount: squares.length,
      minimumBoardWidth: Math.min(...squares.map((rect) => rect.width)),
      minimumBoardHeight: Math.min(...squares.map((rect) => rect.height)),
      picker: picker ? { width: picker.width, height: picker.height } : null,
      play: play ? { width: play.width, height: play.height } : null,
      undersizedControls: visibleControls.filter((control) => control.width + 0.5 < 44 || control.height + 0.5 < 44),
    }
  })
  expect(targetSample.boardSquareCount).toBe(64)
  expect(targetSample.minimumBoardWidth).toBeGreaterThanOrEqual(24)
  expect(targetSample.minimumBoardHeight).toBeGreaterThanOrEqual(24)
  expect(targetSample.picker?.width).toBeGreaterThanOrEqual(44)
  expect(targetSample.picker?.height).toBeGreaterThanOrEqual(44)
  expect(targetSample.play?.width).toBeGreaterThanOrEqual(44)
  expect(targetSample.play?.height).toBeGreaterThanOrEqual(44)
  expect(targetSample.undersizedControls, '320 CSS-pixel reflow: visible non-spatial controls below 44×44').toEqual([])
  await testInfo.attach('computed-target-sizes-320.json', {
    body: JSON.stringify(targetSample, null, 2),
    contentType: 'application/json',
  })

  for (const scale of [2, 4]) {
    await page.setViewportSize({ width: Math.round(1440 / scale), height: Math.round(900 / scale) })
    await page.waitForTimeout(50)
    await assertNoPageOverflow(page, `${scale * 100}% browser-zoom reflow equivalent`)
  }
})

test('WCAG text-spacing overrides preserve content and reflow at 320 CSS pixels', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await loadReadyApp(page)
  // Emulate a user-origin text-spacing override without weakening the
  // artifact's hash-only CSP. Playwright's addStyleTag creates an author
  // inline stylesheet, which the production CSP correctly blocks; CSSOM
  // declarations model the same spacing values and cover later SPA nodes.
  await page.evaluate(() => {
    const applySpacing = (root: ParentNode): void => {
      const elements = root instanceof HTMLElement
        ? [root, ...root.querySelectorAll<HTMLElement>('*')]
        : [...root.querySelectorAll<HTMLElement>('*')]
      for (const element of elements) {
        if (!element.classList.contains('piece')) {
          element.style.setProperty('line-height', '1.5', 'important')
          element.style.setProperty('letter-spacing', '0.12em', 'important')
          element.style.setProperty('word-spacing', '0.16em', 'important')
        }
        if (element.tagName === 'P') element.style.setProperty('margin-bottom', '2em', 'important')
      }
    }
    applySpacing(document)
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) applySpacing(node)
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true })
  })
  await page.waitForTimeout(50)
  await assertNoPageOverflow(page, 'WCAG text spacing, opening browser')

  const visibleClipping = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(
    'button:not(.board-square), p, h1, h2, h3, h4, label, legend, summary, dt, dd, small',
  )].filter((element) => {
    if (element.closest('.sr-only') || element.classList.contains('sr-only')) return false
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) return false
    const clipsInline = style.overflowX === 'hidden' || style.overflowX === 'clip'
    const clipsBlock = style.overflowY === 'hidden' || style.overflowY === 'clip'
    return (clipsInline && element.scrollWidth > element.clientWidth + 1)
      || (clipsBlock && element.scrollHeight > element.clientHeight + 1)
  }).map((element) => ({
    tag: element.tagName,
    className: element.className,
    text: element.textContent?.trim().slice(0, 120) ?? '',
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  })))
  expect(visibleClipping, 'visible text was clipped after the WCAG text-spacing override').toEqual([])

  await startAnyDrill(page)
  await assertNoPageOverflow(page, 'WCAG text spacing, drill')
  await expect(page.getByRole('combobox', { name: 'Legal move picker' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Show hint/u })).toBeVisible()
  await testInfo.attach('wcag-text-spacing.json', {
    body: JSON.stringify({ viewport: { width: 320, height: 800 }, visibleClipping }, null, 2),
    contentType: 'application/json',
  })
})

test('focused controls are not obscured by sticky or fixed interface regions', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await loadReadyApp(page)
  await openRepertoire(page)

  const evidence: Array<Record<string, unknown>> = []
  const verify = async (selector: string, label: string): Promise<void> => {
    const locator = page.locator(selector).first()
    await locator.focus()
    await expect(locator).toBeFocused()
    // Programmatic focus does not consistently perform the browser's normal
    // keyboard-focus scrolling. Reveal it before checking authored overlap;
    // focus remains on the target.
    await locator.scrollIntoViewIfNeeded()
    const observation = await locator.evaluate((element, accessibleLabel) => {
      if (!(element instanceof HTMLElement)) throw new Error('Focused target is not an HTML element')
      const rect = element.getBoundingClientRect()
      const intersects = (left: DOMRect, right: DOMRect): boolean =>
        left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top
      const blockers = [...document.querySelectorAll<HTMLElement>('body *')].filter((candidate) => {
        if (candidate === element || candidate.contains(element) || element.contains(candidate)) return false
        const style = getComputedStyle(candidate)
        if (style.position !== 'fixed' && style.position !== 'sticky') return false
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
        return intersects(rect, candidate.getBoundingClientRect())
      }).map((candidate) => ({
        tag: candidate.tagName,
        className: candidate.className,
        position: getComputedStyle(candidate).position,
      }))
      return {
        label: accessibleLabel,
        rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
        viewport: { width: innerWidth, height: innerHeight },
        blockers,
      }
    }, label)
    expect(observation.rect.top, `${label}: focus target is above the viewport`).toBeGreaterThanOrEqual(0)
    expect(observation.rect.left, `${label}: focus target is left of the viewport`).toBeGreaterThanOrEqual(0)
    expect(observation.rect.bottom, `${label}: focus target is below the viewport`).toBeLessThanOrEqual(observation.viewport.height)
    expect(observation.rect.right, `${label}: focus target is right of the viewport`).toBeLessThanOrEqual(observation.viewport.width)
    expect(observation.blockers, `${label}: focus target is obscured by authored sticky/fixed content`).toEqual([])
    evidence.push(observation)
  }

  await verify('input[type="search"]', 'opening search')
  await verify('.eco-volume-tabs [role="tab"]', 'ECO volume tab')
  await verify('.eco-list [role="option"]', 'ECO option')
  await verify('.line-list [role="option"]', 'opening line option')

  await startAnyDrill(page)
  await verify('.board-square:not(:disabled)', 'keyboard chessboard square')
  await verify('.move-picker select', 'non-spatial legal-move picker')
  await verify('.prompt-card button', 'show-hint control')
  await verify('.mobile-stats-trigger', 'mobile statistics trigger')

  await testInfo.attach('focus-not-obscured.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
})

test('phone training and puzzle controls remain in flow below the board', async ({ page }) => {
  for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await loadReadyApp(page)
    await startAnyDrill(page)

    const drillLayout = await page.locator('.board-column').evaluate((column) => {
      const board = column.querySelector<HTMLElement>('.chessboard-overlay-frame')
      const dock = column.querySelector<HTMLElement>('.drill-thumb-dock')
      if (!board || !dock) throw new Error('The mobile drill board or tool dock is missing')
      const boardRect = board.getBoundingClientRect()
      const dockRect = dock.getBoundingClientRect()
      return {
        position: getComputedStyle(dock).position,
        boardBottom: boardRect.bottom,
        dockTop: dockRect.top,
      }
    })
    expect(drillLayout.position).toBe('static')
    expect(drillLayout.dockTop).toBeGreaterThanOrEqual(drillLayout.boardBottom - 1)

    await page.getByRole('button', { name: 'Puzzles', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Puzzles', level: 1 })).toBeVisible()
    const puzzleActions = page.locator('.puzzle-board-actions')
    if (await puzzleActions.count() > 0) {
      const puzzleLayout = await page.locator('.puzzle-board-column').evaluate((column) => {
        const board = column.querySelector<HTMLElement>('.chessboard-overlay-frame')
        const actions = column.querySelector<HTMLElement>('.puzzle-board-actions')
        if (!board || !actions) throw new Error('The mobile puzzle board or controls are missing')
        const boardRect = board.getBoundingClientRect()
        const actionRect = actions.getBoundingClientRect()
        return {
          position: getComputedStyle(actions).position,
          boardBottom: boardRect.bottom,
          actionTop: actionRect.top,
        }
      })
      expect(puzzleLayout.position).toBe('static')
      expect(puzzleLayout.actionTop).toBeGreaterThanOrEqual(puzzleLayout.boardBottom - 1)
    }
  }
})

test('candidate size, mobile-throttled shell/FCP/full-ready observations, and CLS meet hard thresholds', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'CPU throttling requires the Chromium DevTools Protocol; cross-browser layout and normal-CPU timing run separately.')
  await page.setViewportSize({ width: 390, height: 844 })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.addInitScript(() => {
    const state = {
      cls: 0,
      fullReadyMs: null as number | null,
      shifts: [] as Array<{
        value: number
        startTime: number
        sources: Array<{ element: string; previous: string; current: string }>
      }>,
    }
    ;(window as Window & { __linerecallMetrics?: typeof state }).__linerecallMetrics = state
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number
          hadRecentInput: boolean
          sources?: Array<{ node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }>
        }
        if (!shift.hadRecentInput) {
          state.cls += shift.value
          state.shifts.push({
            value: shift.value,
            startTime: shift.startTime,
            sources: (shift.sources ?? []).map((source) => {
              const element = source.node instanceof Element ? source.node : null
              const label = element
                ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.classList.length ? `.${[...element.classList].join('.')}` : ''}`
                : 'unavailable'
              const rectangle = (value: DOMRectReadOnly): string =>
                [value.x, value.y, value.width, value.height].map((part) => Math.round(part * 10) / 10).join(',')
              return { element: label, previous: rectangle(source.previousRect), current: rectangle(source.currentRect) }
            }),
          })
        }
      }
    }).observe({ type: 'layout-shift', buffered: true })
    const readyObserver = new MutationObserver(() => {
      if (
        state.fullReadyMs === null
        && document.querySelector('h1#today-title')
        && document.querySelector('.start-card .primary-action')
      ) {
        state.fullReadyMs = performance.now()
        readyObserver.disconnect()
      }
    })
    readyObserver.observe(document, { childList: true, subtree: true })
  })

  await page.goto(APP_PATH, { waitUntil: 'commit' })
  await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible()
  await waitForReadyApp(page)
  await page.waitForTimeout(100)
  const browserMetrics = await page.evaluate(() => {
    const shellMark = performance.getEntriesByName('linerecall-shell-interactive', 'mark')[0]
    const firstContentfulPaint = performance.getEntriesByName('first-contentful-paint', 'paint')[0]
    const state = (window as Window & {
      __linerecallMetrics?: {
        cls: number
        fullReadyMs: number | null
        shifts: Array<{ value: number; startTime: number; sources: Array<{ element: string; previous: string; current: string }> }>
      }
    }).__linerecallMetrics
    return {
      shellInteractiveMs: shellMark?.startTime ?? Number.NaN,
      firstContentfulPaintMs: firstContentfulPaint?.startTime ?? Number.NaN,
      fullDataReadyMs: state?.fullReadyMs ?? Number.NaN,
      cls: state?.cls ?? Number.NaN,
      layoutShifts: state?.shifts ?? [],
      dataPhases: Object.fromEntries(
        performance.getEntriesByType('measure')
          .filter((entry) => entry.name.startsWith('linerecall-'))
          .map((entry) => [entry.name, Math.round(entry.duration * 10) / 10]),
      ),
    }
  })
  const candidateBytes = (await stat(resolve('build/candidate/linerecall.html'))).size
  const metrics = { candidateBytes, ...browserMetrics, cpuThrottleRate: 4 }
  await testInfo.attach('performance-mobile-shell.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  })

  expect(candidateBytes).toBeLessThanOrEqual(10 * 1024 * 1024)
  expect(browserMetrics.shellInteractiveMs).toBeLessThanOrEqual(2_000)
  expect(browserMetrics.firstContentfulPaintMs).toBeLessThanOrEqual(2_000)
  expect(browserMetrics.fullDataReadyMs).toBeGreaterThanOrEqual(browserMetrics.shellInteractiveMs)
  expect(browserMetrics.cls).toBeLessThanOrEqual(0.1)
})

test('normal-CPU uncached ECO partitions and move-feedback p95 meet hard thresholds', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    const state = {
      moveStartedAt: null as number | null,
      moveBoardSignature: null as string | null,
      moveSamples: [] as number[],
      moveClickHandlerSamples: [] as number[],
      partitionEco: null as string | null,
      partitionStartedAt: null as number | null,
      partitionSamples: [] as Array<{ eco: string; milliseconds: number }>,
    }
    ;(window as Window & { __linerecallInteractionMetrics?: typeof state })
      .__linerecallInteractionMetrics = state
    const boardSignature = (): string => [...document.querySelectorAll('.board-square')]
      .map((square) => square.getAttribute('aria-label') ?? '')
      .join('|')
    const observer = new MutationObserver(() => {
      if (
        state.moveStartedAt !== null
        && (
          document.querySelector('.completion-card')
          || (state.moveBoardSignature !== null && boardSignature() !== state.moveBoardSignature)
        )
      ) {
        state.moveSamples.push(performance.now() - state.moveStartedAt)
        state.moveStartedAt = null
        state.moveBoardSignature = null
      }
      const heading = document.querySelector('#opening-lines-title')?.textContent?.trim()
      if (
        state.partitionEco !== null
        && state.partitionStartedAt !== null
        && heading === `${state.partitionEco} lines`
        && document.querySelector('.line-list')
      ) {
        state.partitionSamples.push({
          eco: state.partitionEco,
          milliseconds: performance.now() - state.partitionStartedAt,
        })
        state.partitionEco = null
        state.partitionStartedAt = null
      }
    })
    observer.observe(document, { attributes: true, childList: true, subtree: true })
  })
  await loadReadyApp(page)
  await openRepertoire(page)

  const partitionSamples: Array<{ eco: string; milliseconds: number }> = []
  for (const eco of ['B00', 'C00', 'D00', 'E00']) {
    await page.getByRole('tablist', { name: 'ECO volumes' }).getByRole('tab', { name: new RegExp(`Volume ${eco[0]}:`) }).click()
    await page.evaluate((targetEco) => {
      const option = [...document.querySelectorAll<HTMLButtonElement>('.eco-list [role="option"]')]
        .find((element) => element.textContent?.trim().startsWith(targetEco))
      if (!option) throw new Error(`ECO ${targetEco} is not rendered`)
      const state = (window as Window & {
        __linerecallInteractionMetrics?: {
          partitionEco: string | null
          partitionStartedAt: number | null
        }
      }).__linerecallInteractionMetrics
      if (!state) throw new Error('Partition instrumentation is unavailable')
      state.partitionEco = targetEco
      state.partitionStartedAt = performance.now()
      option.click()
    }, eco)
    await expect(page.getByRole('heading', { name: `${eco} lines` })).toBeVisible()
    await expect(page.locator('.line-list')).toBeVisible()
    const sample = await page.evaluate((targetEco) => {
      const samples = (window as Window & {
        __linerecallInteractionMetrics?: {
          partitionSamples: Array<{ eco: string; milliseconds: number }>
        }
      }).__linerecallInteractionMetrics?.partitionSamples ?? []
      return samples.find((entry) => entry.eco === targetEco) ?? null
    }, eco)
    if (!sample) throw new Error(`ECO ${eco} did not record a completed partition load`)
    partitionSamples.push(sample)
  }

  await startAnyDrill(page)
  for (let index = 0; index < 12; index += 1) {
    const showHint = page.getByRole('button', { name: 'Show hint' })
    const practiceAll = page.getByRole('button', { name: 'Practice all positions' })
    await expect(showHint.or(practiceAll)).toBeVisible()
    if (await practiceAll.isVisible().catch(() => false)) {
      await practiceAll.click()
      await expect(showHint).toBeVisible()
    }
    const expected = await revealExpectedMove(page)
    await page.getByRole('combobox', { name: 'Legal move picker' }).selectOption(expected.uci)
    await page.evaluate(() => {
      const state = (window as Window & {
        __linerecallInteractionMetrics?: {
          moveStartedAt: number | null
          moveBoardSignature: string | null
          moveSamples: number[]
          moveClickHandlerSamples: number[]
        }
      }).__linerecallInteractionMetrics
      const play = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Play move')
      if (!state || !play) throw new Error('Move feedback instrumentation is unavailable')
      const startedAt = performance.now()
      state.moveStartedAt = startedAt
      state.moveBoardSignature = [...document.querySelectorAll('.board-square')]
        .map((square) => square.getAttribute('aria-label') ?? '')
        .join('|')
      play.click()
      state.moveClickHandlerSamples.push(performance.now() - startedAt)
    })
    await expect.poll(() => page.evaluate(() =>
      (window as Window & { __linerecallInteractionMetrics?: { moveSamples: number[] } })
        .__linerecallInteractionMetrics?.moveSamples.length ?? 0
    )).toBe(index + 1)
    await expect(page.getByRole('group', { name: /Choose recall grade/u })).toHaveCount(0)
  }
  const moveSamples = await page.evaluate(() =>
    (window as Window & { __linerecallInteractionMetrics?: { moveSamples: number[] } })
      .__linerecallInteractionMetrics?.moveSamples ?? []
  )
  const moveClickHandlerSamples = await page.evaluate(() =>
    (window as Window & { __linerecallInteractionMetrics?: { moveClickHandlerSamples: number[] } })
      .__linerecallInteractionMetrics?.moveClickHandlerSamples ?? []
  )
  const sorted = [...moveSamples].sort((left, right) => left - right)
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  const moveP95Ms = sorted[p95Index] ?? Number.POSITIVE_INFINITY
  const metrics = { partitionSamples, moveSamples, moveClickHandlerSamples, moveP95Ms, cpuThrottleRate: 1 }
  await testInfo.attach('performance-normal-interactions.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  })

  expect(partitionSamples).toHaveLength(4)
  for (const sample of partitionSamples) {
    expect(sample.milliseconds, `${sample.eco} partition load`).toBeLessThanOrEqual(500)
  }
  expect(moveSamples).toHaveLength(12)
  expect(moveClickHandlerSamples).toHaveLength(12)
  expect(moveP95Ms).toBeLessThanOrEqual(100)
})

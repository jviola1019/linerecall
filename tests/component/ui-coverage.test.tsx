// @vitest-environment jsdom

import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { DecompressionStream as NodeDecompressionStream } from 'node:stream/web'
import { Chess } from 'chess.js'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { ChessBoard } from '../../src/app/components/ChessBoard.tsx'
import { OpeningBrowser, type PartitionResource } from '../../src/app/components/OpeningBrowser.tsx'
import { DrillView } from '../../src/app/components/DrillView.tsx'
import { ProgressView } from '../../src/app/components/ProgressView.tsx'
import { DataLicenses } from '../../src/app/components/DataLicenses.tsx'
import { EvidenceTable, MoveComparison } from '../../src/app/components/EvidenceTable.tsx'
import { App } from '../../src/app/App.tsx'
import { EmbeddedOpeningDataSource } from '../../src/data/embedded-opening-data-source.ts'
import type { EmbeddedSnapshotPayload } from '../../src/data/embedded-contract.ts'
import type { OpeningDataCore, OpeningDataSource } from '../../src/data/opening-data-source.ts'
import embeddedSnapshot from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import { buildPositionGraph, type PositionGraph } from '../../src/domain/deviation.ts'
import type { DataManifest, MoveEvidence, OpeningPartition, PositionNode, VerifiedLine } from '../../src/domain/opening-data.ts'
import { createCard, createEmptyProgress, scheduleReview, type ProgressV1 } from '../../src/domain/progress.ts'
import { exportProgressJson } from '../../src/infrastructure/progress-repository.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true })
Object.defineProperty(globalThis, 'DecompressionStream', { value: NodeDecompressionStream, configurable: true })
Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true })
Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true })

let core: OpeningDataCore
let audit: DataManifest
let c20: OpeningPartition
let a00: OpeningPartition
let drillLine: VerifiedLine

beforeAll(async () => {
  const source = new EmbeddedOpeningDataSource(embeddedSnapshot as EmbeddedSnapshotPayload)
  core = await source.initialize()
  ;[audit, c20, a00] = await Promise.all([source.loadAudit(), source.loadPartition('C20'), source.loadPartition('A00')])
  drillLine = c20.verifiedLines.find((line) => line.drillEligible)!
  if (!drillLine) throw new Error('C20 has no drill fixture')
}, 30_000)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.documentElement.dataset.theme = 'dark'
  window.history.replaceState(null, '', '#/today')
})

function browserProps(partition: PartitionResource = { status: 'ready', value: c20, error: null }) {
  return {
    catalog: core.catalog,
    searchEntries: core.searchEntries,
    selectedEco: 'C20',
    selectedLineId: drillLine.sourceLineId,
    selectedVariantId: drillLine.id,
    partition,
    onSelectEco: vi.fn(),
    onSelectLine: vi.fn(),
    onSelectVariant: vi.fn(),
    onSelectSearchResult: vi.fn(),
    onOpenFamily: vi.fn(),
    onRetryPartition: vi.fn(),
    onAnnouncement: vi.fn(),
  }
}

describe('chessboard interaction branches', () => {
  test('keeps a stable visual piece identity during movement and exposes the selected motion policy', async () => {
    const position = new Chess()
    const { container, rerender } = render(
      <ChessBoard fen={position.fen()} orientation="white" onMove={vi.fn()} />,
    )
    const startingPawn = container.querySelector<HTMLElement>('.visual-piece[data-square="e2"]')
    expect(startingPawn).not.toBeNull()
    const pawnId = startingPawn?.dataset.pieceId

    position.move('e4')
    rerender(
      <ChessBoard
        fen={position.fen()}
        orientation="white"
        lastMove={{ uci: 'e2e4', status: 'book' }}
        onMove={vi.fn()}
      />,
    )
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>('.visual-piece[data-square="e4"]')?.dataset.pieceId).toBe(pawnId)
    })
    expect(container.querySelector('.visual-piece-layer')).toHaveAttribute('data-motion', 'animated')
    expect(screen.getByRole('gridcell', { name: /e4, White pawn, Book move/u })).toBeTruthy()

    position.move('c5')
    rerender(
      <ChessBoard
        fen={position.fen()}
        orientation="white"
        reducedMotion
        lastMove={{ uci: 'c7c5', status: 'playable' }}
        onMove={vi.fn()}
      />,
    )
    await waitFor(() => expect(container.querySelector('.visual-piece[data-square="c5"]')).not.toBeNull())
    expect(container.querySelector('.visual-piece-layer')).toHaveAttribute('data-motion', 'reduced')
    expect(screen.getByRole('gridcell', { name: /c5, Black pawn, Playable alternative/u })).toBeTruthy()
  })

  test('supports complete roving keyboard behavior, reselection, and status markers', async () => {
    const user = userEvent.setup()
    const announce = vi.fn()
    const onMove = vi.fn()
    render(
      <ChessBoard
        fen={new Chess().fen()}
        orientation="white"
        hintUci="e2e4"
        lastMove={{ uci: 'g1f3', status: 'playable' }}
        onMove={onMove}
        onAnnouncement={announce}
      />,
    )
    const board = screen.getByRole('grid')
    expect(board).toHaveAccessibleDescription(/Playable alternative route from g1 to f3\./u)
    expect(board).toHaveAccessibleDescription(/Hint route from e2 to e4\./u)
    expect(document.querySelectorAll('.movement-guide-source').length).toBeGreaterThanOrEqual(2)
    expect(document.querySelectorAll('.movement-guide-destination').length).toBeGreaterThanOrEqual(2)
    expect(document.querySelector('.movement-guide-route[data-guide-role="hint"] .movement-guide-arrowhead')).not.toBeNull()
    expect(screen.getByRole('gridcell', { name: /g1, White knight, Playable alternative source/u })).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: /e4, empty, hint destination/u })).toBeTruthy()
    const e2 = screen.getByRole('gridcell', { name: /e2, White pawn/u })
    e2.focus()
    await user.keyboard('{Home}')
    expect(document.activeElement).toHaveAccessibleName(/^a8,/u)
    await user.keyboard('{End}')
    expect(document.activeElement).toHaveAccessibleName(/^h1,/u)
    await user.keyboard('{ArrowRight}{ArrowDown}{ArrowLeft}{ArrowUp}')

    e2.focus()
    await user.keyboard('{Enter}')
    expect(e2).toHaveAttribute('aria-selected', 'true')
    await user.keyboard(' ')
    expect(announce).toHaveBeenCalledWith('e2 deselected.')
    await user.click(e2)
    await user.click(screen.getByRole('gridcell', { name: /d2, White pawn/u }))
    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/d2.*selected/u))
    await user.click(screen.getByRole('gridcell', { name: /d4, empty, legal target/u }))
    expect(onMove).toHaveBeenCalledWith('d2d4')
    expect(screen.getByRole('gridcell', { name: /^e2,/u })).toHaveAttribute('data-hint', 'true')
    expect(screen.getByRole('gridcell', { name: /^f3,/u })).toHaveAttribute('data-move-status', 'playable')
  })

  test('handles pointer drag success, short drags, outside drops, and suppressed clicks', async () => {
    const onMove = vi.fn()
    const announce = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} orientation="white" onMove={onMove} onAnnouncement={announce} />)
    const board = screen.getByRole('grid', { name: /Chessboard/u })
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 800, width: 800, height: 800, toJSON: () => ({}),
    })
    const e2 = screen.getByRole('gridcell', { name: /e2, White pawn/u })
    fireEvent.pointerDown(e2, { button: 1, pointerId: 1, clientX: 450, clientY: 650 })
    fireEvent.pointerUp(e2, { pointerId: 1, clientX: 450, clientY: 450 })
    expect(onMove).not.toHaveBeenCalled()
    fireEvent.pointerDown(e2, { button: 0, pointerId: 2, clientX: 450, clientY: 650 })
    fireEvent.pointerUp(e2, { pointerId: 2, clientX: 451, clientY: 651 })
    expect(onMove).not.toHaveBeenCalled()
    fireEvent.pointerDown(e2, { button: 0, pointerId: 3, clientX: 450, clientY: 650 })
    fireEvent.pointerUp(e2, { pointerId: 3, clientX: 900, clientY: 900 })
    expect(announce).toHaveBeenCalledWith('The dragged piece was not moved to a legal target.')
    fireEvent.click(e2)
    expect(e2).toHaveAttribute('aria-selected', 'false')
    fireEvent.pointerDown(e2, { button: 0, pointerId: 8, clientX: 450, clientY: 650 })
    fireEvent.pointerCancel(e2, { pointerId: 8 })
    expect(announce).toHaveBeenCalledWith('Drag cancelled. The position was kept.')
    fireEvent.click(e2)
    expect(e2).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(e2)
    expect(e2).toHaveAttribute('aria-selected', 'false')
    fireEvent.pointerDown(e2, { button: 0, pointerId: 4, clientX: 450, clientY: 650 })
    fireEvent.pointerUp(e2, { pointerId: 4, clientX: 450, clientY: 450 })
    expect(onMove).toHaveBeenCalledWith('e2e4')
  })

  test('traps promotion focus, supports escape/cancel, and restores focus after selection', async () => {
    const user = userEvent.setup()
    const onMove = vi.fn()
    const fen = '8/P7/8/8/8/8/7p/4K2k w - - 0 1'
    render(<ChessBoard fen={fen} orientation="black" onMove={onMove} />)
    const promote = async (): Promise<HTMLElement> => {
      await user.click(screen.getByRole('gridcell', { name: /a7, White pawn/u }))
      await user.click(screen.getByRole('gridcell', { name: /a8, empty, legal target/u }))
      return screen.getByRole('dialog', { name: 'Choose promotion piece' })
    }
    const reopen = async (): Promise<HTMLElement> => {
      await user.click(screen.getByRole('gridcell', { name: /a8, empty, legal target/u }))
      return screen.getByRole('dialog', { name: 'Choose promotion piece' })
    }
    let dialog = await promote()
    const boardBackground = document.querySelector('.board-region')?.parentElement
    expect(boardBackground).toHaveAttribute('inert', '')
    expect(boardBackground).toHaveAttribute('aria-hidden', 'true')
    const buttons = within(dialog).getAllByRole('button')
    buttons.at(-1)!.focus()
    await user.keyboard('{Tab}')
    expect(document.activeElement).toBe(buttons[0])
    buttons[0]!.focus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(document.activeElement).toBe(buttons.at(-1))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(boardBackground).not.toHaveAttribute('inert')
    expect(boardBackground).not.toHaveAttribute('aria-hidden')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: /a8, empty, legal target/u })))

    dialog = await reopen()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('gridcell', { name: /a8, empty, legal target/u })))
    dialog = await reopen()
    await user.click(within(dialog).getByRole('button', { name: 'Knight' }))
    expect(onMove).toHaveBeenCalledWith('a7a8n')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Chess move input' })))
  })

  test('renders a no-move picker and ignores disabled board input', async () => {
    const onMove = vi.fn()
    const mate = '7k/5Q2/7K/8/8/8/8/8 b - - 0 1'
    const { rerender } = render(<ChessBoard fen={mate} orientation="black" onMove={onMove} />)
    expect(screen.getByRole('combobox', { name: 'Legal move picker' })).toBeDisabled()
    rerender(<ChessBoard fen={new Chess().fen()} orientation="white" disabled onMove={onMove} />)
    fireEvent.pointerDown(screen.getByRole('gridcell', { name: /e2, White pawn/u }), { button: 0 })
    fireEvent.pointerUp(screen.getByRole('gridcell', { name: /e2, White pawn/u }))
    expect(onMove).not.toHaveBeenCalled()
  })

  test('moves the roving tab stop to a legal side-to-move piece when the prior square cannot move', async () => {
    render(<ChessBoard fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1" orientation="black" onMove={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('gridcell', { name: /e7, Black pawn/u })).toHaveAttribute('tabindex', '0'))
    expect(screen.getByRole('gridcell', { name: /e2, White pawn/u })).toHaveAttribute('tabindex', '-1')
  })
})

describe('opening browser resource and keyboard branches', () => {
  test('renders idle, error fallback/retry, and validated empty states', async () => {
    const user = userEvent.setup()
    const props = browserProps({ status: 'idle', value: null, error: null })
    const { rerender } = render(<OpeningBrowser {...props} />)
    expect(screen.getByRole('status')).toHaveTextContent(/Loading C20/u)
    const errorProps = browserProps({ status: 'error', value: null, error: null })
    rerender(<OpeningBrowser {...errorProps} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/did not pass validation/u)
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(errorProps.onRetryPartition).toHaveBeenCalled()
    const empty: OpeningPartition = { ...c20, lines: [], verifiedLines: [] }
    rerender(<OpeningBrowser {...browserProps({ status: 'ready', value: empty, error: null })} />)
    expect(screen.getByText('The validated partition is empty.')).toBeTruthy()
  })

  test('covers ECO, line, move, and variant roving controls plus empty filters', async () => {
    const user = userEvent.setup()
    const props = browserProps()
    render(<OpeningBrowser {...props} />)
    const ecoFilter = screen.getByRole('searchbox', { name: 'Filter ECO codes' })
    await user.type(ecoFilter, 'zzzz-not-an-eco')
    expect(screen.getByText('No ECO codes match that filter.')).toBeTruthy()
    await user.clear(ecoFilter)
    const ecoOptions = screen.getByRole('listbox', { name: 'ECO opening codes' })
    const selectedEco = within(ecoOptions).getByRole('option', { selected: true })
    selectedEco.focus()
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End', 'x']) fireEvent.keyDown(document.activeElement!, { key })

    const lines = screen.getByRole('listbox', { name: 'C20 opening lines' })
    const selectedLine = within(lines).getByRole('option', { selected: true })
    selectedLine.focus()
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End', 'x']) fireEvent.keyDown(document.activeElement!, { key })
    expect(props.onSelectLine).toHaveBeenCalled()

    const moves = screen.getByRole('listbox', { name: /Opening moves/u })
    const firstMove = within(moves).getAllByRole('option')[0]!
    firstMove.focus()
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'x']) fireEvent.keyDown(document.activeElement!, { key })

    const tabs = within(screen.getByRole('tablist', { name: 'Historical side evidence' })).getAllByRole('tab')
    if (tabs.length > 1) {
      tabs[0]!.focus()
      for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'x']) fireEvent.keyDown(document.activeElement!, { key })
      await waitFor(() => expect(props.onSelectVariant).toHaveBeenCalled())
    }
  })

  test('keeps a filtered ECO list keyboard-enterable when the selected code is hidden', async () => {
    const user = userEvent.setup()
    render(<OpeningBrowser {...browserProps()} />)
    await user.type(screen.getByRole('searchbox', { name: 'Filter ECO codes' }), 'C00')
    const list = screen.getByRole('listbox', { name: 'ECO opening codes' })
    const options = within(list).getAllByRole('option')
    expect(options.length).toBeGreaterThan(0)
    expect(options[0]).toHaveAttribute('tabindex', '0')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
  })

  test('reveals an externally selected ECO by clearing a stale rail filter', async () => {
    const user = userEvent.setup()
    const props = browserProps()
    const { rerender } = render(<OpeningBrowser {...props} />)
    const filter = screen.getByRole('searchbox', { name: 'Filter ECO codes' })
    await user.type(filter, 'C00')
    expect(within(screen.getByRole('listbox', { name: 'ECO opening codes' })).queryByRole('option', { name: /^C20/u })).toBeNull()

    rerender(<OpeningBrowser {...props} selectedEco="C21" />)
    await waitFor(() => expect(filter).toHaveValue(''))
    expect(within(screen.getByRole('listbox', { name: 'ECO opening codes' })).getByRole('option', { name: /^C21/u })).toHaveAttribute('aria-selected', 'true')

    await user.type(filter, 'C99')
    rerender(<OpeningBrowser {...props} selectedEco="B37" />)
    await waitFor(() => expect(screen.getByRole('tab', { name: /Volume B:/u })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByRole('searchbox', { name: 'Filter ECO codes' })).toHaveValue('')
    expect(within(screen.getByRole('listbox', { name: 'ECO opening codes' })).getByRole('option', { name: /^B37/u })).toHaveAttribute('aria-selected', 'true')
  })

  test('partitions all 500 ECO codes into accessible A-E volume tabs', async () => {
    const user = userEvent.setup()
    render(<OpeningBrowser {...browserProps()} />)
    const tablist = screen.getByRole('tablist', { name: 'ECO volumes' })
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs).toHaveLength(5)
    expect(tabs.map((tab) => tab.getAttribute('aria-controls'))).toEqual(expect.arrayContaining([
      expect.stringMatching(/-panel-A$/u),
      expect.stringMatching(/-panel-B$/u),
      expect.stringMatching(/-panel-C$/u),
      expect.stringMatching(/-panel-D$/u),
      expect.stringMatching(/-panel-E$/u),
    ]))

    const reached = new Set<string>()
    for (const tab of tabs) {
      await user.click(tab)
      const panel = screen.getByRole('tabpanel', { name: /^[A-E] 100 .+ Volume [A-E]:/u })
      expect(tab).toHaveAccessibleName(/^[A-E] 100 .+ Volume [A-E]: .+ \(100 ECO codes\)$/u)
      expect(panel).toHaveAttribute('aria-labelledby', tab.id)
      const options = within(panel).getAllByRole('option')
      expect(options).toHaveLength(100)
      for (const option of options) {
        const code = option.querySelector('.eco-pill')?.textContent
        if (code) reached.add(code)
      }
    }
    expect(reached.size).toBe(500)
    expect([...reached].sort()).toEqual(core.catalog.map((entry) => entry.eco).sort())
    const searchableEcos = new Set(core.searchEntries.map((entry) => entry.eco))
    expect(core.catalog.every((entry) => searchableEcos.has(entry.eco))).toBe(true)

    await user.type(screen.getByRole('searchbox', { name: /Opening name or ECO code/u }), 'A00')
    await user.click(screen.getByRole('button', { name: 'Search openings' }))
    const resultList = document.querySelector('.result-list')
    expect(resultList?.querySelector('.eco-pill')).toHaveTextContent('A00')
  })

  test('uses roving tab focus and follows externally selected ECO volumes', async () => {
    const user = userEvent.setup()
    const props = browserProps()
    const { rerender } = render(<OpeningBrowser {...props} />)
    const volumeTabs = (): HTMLElement[] => within(screen.getByRole('tablist', { name: 'ECO volumes' })).getAllByRole('tab')
    const selectedVolume = (): HTMLElement => within(screen.getByRole('tablist', { name: 'ECO volumes' })).getByRole('tab', { selected: true })

    expect(selectedVolume()).toHaveAccessibleName(/Volume C:/u)
    selectedVolume().focus()
    await user.keyboard('{ArrowRight}')
    expect(selectedVolume()).toHaveAccessibleName(/Volume D:/u)
    expect(selectedVolume()).toHaveFocus()
    await user.keyboard('{Home}')
    expect(selectedVolume()).toHaveAccessibleName(/Volume A:/u)

    const keyboardReached = new Set<string>()
    for (let volumeIndex = 0; volumeIndex < 5; volumeIndex += 1) {
      const options = within(screen.getByRole('listbox', { name: 'ECO opening codes' })).getAllByRole('option')
      expect(options).toHaveLength(100)
      options[0]!.focus()
      for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
        expect(document.activeElement).toBe(options[optionIndex])
        const code = options[optionIndex]!.querySelector('.eco-pill')?.textContent
        if (code) keyboardReached.add(code)
        if (optionIndex + 1 < options.length) fireEvent.keyDown(options[optionIndex]!, { key: 'ArrowDown' })
      }
      selectedVolume().focus()
      if (volumeIndex + 1 < 5) await user.keyboard('{ArrowRight}')
    }
    expect(keyboardReached.size).toBe(500)
    expect(selectedVolume()).toHaveAccessibleName(/Volume E:/u)

    await user.keyboard('{Home}')
    expect(selectedVolume()).toHaveAccessibleName(/Volume A:/u)
    await user.keyboard('{ArrowLeft}')
    expect(selectedVolume()).toHaveAccessibleName(/Volume E:/u)
    await user.keyboard('{ArrowRight}')
    expect(selectedVolume()).toHaveAccessibleName(/Volume A:/u)
    await user.keyboard('{End}')
    expect(selectedVolume()).toHaveAccessibleName(/Volume E:/u)
    expect(volumeTabs().filter((tab) => tab.tabIndex === 0)).toHaveLength(1)

    rerender(<OpeningBrowser {...props} selectedEco="B37" />)
    await waitFor(() => expect(selectedVolume()).toHaveAccessibleName(/Volume B:/u))
    const list = screen.getByRole('listbox', { name: 'ECO opening codes' })
    expect(within(list).getByRole('option', { name: /^B37/u })).toHaveAttribute('aria-selected', 'true')
  }, 15_000)

  test('clears stale search errors while editing and supports the documented PGN shortcut', async () => {
    const user = userEvent.setup()
    render(<OpeningBrowser {...browserProps()} />)
    await user.click(screen.getByRole('radio', { name: 'Paste PGN' }))
    const pgn = screen.getByRole('textbox', { name: /Standard-chess PGN/u })
    await user.type(pgn, '<script>')
    await user.click(screen.getByRole('button', { name: 'Search openings' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(pgn).toHaveAttribute('aria-invalid', 'true')
    expect(pgn.getAttribute('aria-describedby')).toMatch(/-help.*-error/u)

    fireEvent.change(pgn, { target: { value: '[Event "Test"]\n[Result "*"]\n\n1. e4 e5 *' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(pgn).not.toHaveAttribute('aria-invalid')
    fireEvent.keyDown(pgn, { key: 'Enter', ctrlKey: true })
    expect(await screen.findByRole('heading', { name: /Search results/u })).toBeTruthy()
  })

  test('shows no-result search and browse-only historical evidence explanations', async () => {
    const user = userEvent.setup()
    const nonVerified = c20.lines.find((line) => line.verifiedVariantIds.length === 0)!
    expect(nonVerified).toBeTruthy()
    const props = { ...browserProps(), selectedLineId: nonVerified.sourceLineId, selectedVariantId: null }
    const { rerender } = render(<OpeningBrowser {...props} />)
    await user.type(screen.getByRole('searchbox', { name: /Opening name or ECO code/u }), 'definitely-no-match-xyz')
    await user.click(screen.getByRole('button', { name: 'Search openings' }))
    expect(screen.getByText('No openings found.')).toBeTruthy()
    expect(screen.getByRole('note')).toHaveTextContent(nonVerified.backtestEligible ? /no side-specific record/u : /does not meet/u)
    expect(screen.getByRole('button', { name: 'Open opening family' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Start spaced-repetition drill' })).toBeNull()

    const quarantined = c20.verifiedLines.find((line) => !line.drillEligible)
    if (quarantined) {
      rerender(<OpeningBrowser {...browserProps()} selectedLineId={quarantined.sourceLineId} selectedVariantId={quarantined.id} />)
      expect(screen.getByText('Historical record quarantined')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Open opening family' })).toBeEnabled()
    }
  })

  test('renders hostile opening source names only as text without creating or executing markup', () => {
    const hostileName = '<img src=x onerror="window.__linerecallHostile=1"><script>window.__linerecallHostile=2</script>'
    const hostileLine = { ...c20.lines[0]!, name: hostileName, verifiedVariantIds: [] }
    const hostilePartition: OpeningPartition = { ...c20, lines: [hostileLine], verifiedLines: [] }
    ;(window as Window & { __linerecallHostile?: number }).__linerecallHostile = 0
    const { rerender } = render(
      <OpeningBrowser
        {...browserProps({ status: 'ready', value: hostilePartition, error: null })}
        selectedLineId={hostileLine.sourceLineId}
        selectedVariantId={null}
      />,
    )
    expect(screen.getAllByText(hostileName).length).toBeGreaterThan(0)
    expect(document.querySelector('.opening-lines img, .opening-lines script')).toBeNull()
    expect((window as Window & { __linerecallHostile?: number }).__linerecallHostile).toBe(0)

    rerender(<DataLicenses audit={audit} selectedLine={hostileLine} />)
    const hostileHeading = screen.getAllByRole('heading', { level: 3 }).find((heading) => heading.textContent?.includes(hostileName))
    expect(hostileHeading).toBeTruthy()
    expect(document.querySelector('.documentation-view img, .documentation-view script')).toBeNull()
    expect((window as Window & { __linerecallHostile?: number }).__linerecallHostile).toBe(0)
  })
})

function evidenceVariant(classification: MoveEvidence['classification'], score: MoveEvidence['score']): VerifiedLine {
  const baseNode = drillLine.nodes[0]!
  const chess = new Chess(baseNode.fen)
  const legalAlternatives = chess.moves({ verbose: true })
    .map((move) => `${move.from}${move.to}${move.promotion ?? ''}`)
  const alternative = legalAlternatives.find((uci) => uci === 'a2a3')
    ?? legalAlternatives.find((uci) => uci !== baseNode.expectedMoveUci)!
  const expected = baseNode.moves.find((move) => move.expected)!
  const altEvidence: MoveEvidence = {
    ...expected,
    uci: alternative,
    san: new Chess(baseNode.fen).move({ from: alternative.slice(0, 2), to: alternative.slice(2, 4) }).san,
    classification,
    expected: false,
    acceptedBookTransposition: classification === 'book',
    sampleSize: score === null ? 0 : 150,
    score,
    centipawnLoss: classification === 'playable' ? 25 : classification === 'inaccuracy' ? 75 : classification === 'mistake' ? 125 : null,
    principalVariationUci: score === null ? [] : [alternative, baseNode.expectedMoveUci],
    independentlyEngineAnalyzed: score !== null,
  }
  const node: PositionNode = { ...baseNode, moves: [expected, altEvidence] }
  return { ...drillLine, id: `${drillLine.id}-${classification}-${score?.value ?? 'none'}`, nodes: [node] }
}

describe('drill feedback and completion branches', () => {
  test('returns the analysis panel to the next prompt after automatic grading', async () => {
    const user = userEvent.setup()
    const continuousLine = c20.verifiedLines.find((line) => line.drillEligible && line.nodes.length > 1)
    expect(continuousLine, 'C20 fixture must contain a multi-position drill').toBeTruthy()
    if (!continuousLine) return

    render(
      <DrillView
        line={continuousLine}
        graph={buildPositionGraph([continuousLine])}
        progress={createEmptyProgress()}
        orientation="white"
        onSetOrientation={vi.fn()}
        onReview={vi.fn()}
        onAnnouncement={vi.fn()}
        onReturnToBrowser={vi.fn()}
      />,
    )

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Legal move picker' }),
      continuousLine.nodes[0]!.expectedMoveUci,
    )
    await user.click(screen.getByRole('button', { name: 'Play move' }))

    expect(await screen.findByRole('button', { name: 'Show hint' })).toBeTruthy()
    expect(document.querySelector('.feedback-content')).toBeNull()
    expect(screen.getByText(/Last move recorded as good/u)).toBeTruthy()
  })

  test('keeps every analysis tab control bound to a persistent tab panel', async () => {
    const user = userEvent.setup()
    render(
      <DrillView
        line={drillLine}
        graph={buildPositionGraph([drillLine])}
        progress={createEmptyProgress()}
        orientation="white"
        onSetOrientation={vi.fn()}
        onReview={vi.fn()}
        onAnnouncement={vi.fn()}
        onReturnToBrowser={vi.fn()}
      />,
    )

    for (const name of ['Line', 'Alternatives', 'Evidence']) {
      const tab = screen.getByRole('tab', { name })
      const panelId = tab.getAttribute('aria-controls')
      expect(panelId).toBeTruthy()
      expect(document.getElementById(panelId ?? '')).not.toBeNull()
      await user.click(tab)
      expect(tab).toHaveAttribute('aria-selected', 'true')
      expect(document.getElementById(panelId ?? '')).not.toHaveAttribute('hidden')
    }
  })

  test('treats pre-move statistics as a hint, traps sheet focus, and restores its trigger', async () => {
    const user = userEvent.setup()
    const announce = vi.fn()
    render(
      <DrillView
        line={drillLine}
        graph={buildPositionGraph([drillLine])}
        progress={createEmptyProgress()}
        orientation="white"
        onSetOrientation={vi.fn()}
        onReview={vi.fn()}
        onAnnouncement={announce}
        onReturnToBrowser={vi.fn()}
      />,
    )
    const trigger = await screen.findByRole('button', { name: 'View statistics (counts as hint)' })
    expect(trigger).toHaveAccessibleDescription(/correct move defaults to Hard/u)
    expect(trigger).not.toHaveAttribute('aria-controls')
    await user.click(trigger)
    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/count as a hint.*defaults to Hard/u))
    const dialog = screen.getByRole('dialog', { name: 'Line statistics' })
    expect(trigger).toHaveAttribute('aria-controls', dialog.id)
    const close = within(dialog).getByRole('button', { name: 'Close statistics' })
    await waitFor(() => expect(close).toHaveFocus())
    expect(within(dialog).getByRole('table', { name: /Terminal trained-side results/u })).toBeTruthy()
    expect(within(dialog).getByText(drillLine.terminalSampleSize.toLocaleString('en-US'))).toBeTruthy()

    const lastFocusable = within(dialog).getByRole('region', { name: /horizontally scrollable/u })
    lastFocusable.focus()
    await user.keyboard('{Tab}')
    expect(close).toHaveFocus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(lastFocusable).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Line statistics' })).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())

    const firstNode = drillLine.nodes[0]!
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), firstNode.expectedMoveUci)
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    expect(await screen.findByText(/Last move recorded as hard/u)).toBeTruthy()
    expect(screen.queryByRole('group', { name: /Choose recall grade/u })).toBeNull()
  })

  test('renders empty drill and no-due completion, then practices all', async () => {
    const user = userEvent.setup()
    const emptyProps = {
      line: null,
      graph: buildPositionGraph([]),
      progress: createEmptyProgress(),
      orientation: 'white' as const,
      onSetOrientation: vi.fn(),
      onReview: vi.fn(),
      onAnnouncement: vi.fn(),
      onReturnToBrowser: vi.fn(),
    }
    const { rerender } = render(<DrillView {...emptyProps} />)
    await user.click(screen.getByRole('button', { name: 'Browse openings' }))
    expect(emptyProps.onReturnToBrowser).toHaveBeenCalled()

    const progress = createEmptyProgress()
    for (const node of drillLine.nodes) {
      progress.cards[`${drillLine.id}::${node.id}`] = {
        ...createCard(`${drillLine.id}::${node.id}`, drillLine.id, node.id, new Date()),
        dueAt: '2999-01-01T00:00:00.000Z',
        intervalDays: 6,
      }
    }
    rerender(<DrillView {...emptyProps} line={drillLine} progress={progress} />)
    expect(await screen.findByText('No cards are due right now.')).toBeTruthy()
    expect(screen.getByText(/Scheduled reviews/u)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Practice all positions' }))
    expect(await screen.findByRole('tablist', { name: 'Position analysis' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Line', selected: true })).toBeTruthy()
  })

  test('renders a3 as unverified when the exact e4 repertoire graph contains no converging continuation', async () => {
    const user = userEvent.setup()
    const templateNode = drillLine.nodes[0]!
    const templateExpected = templateNode.moves.find((move) => move.expected)!
    const start = new Chess()
    const expected: MoveEvidence = {
      ...templateExpected,
      uci: 'e2e4',
      san: 'e4',
      classification: 'book',
      expected: true,
      acceptedBookTransposition: false,
      principalVariationUci: ['e2e4'],
    }
    const contradictory: MoveEvidence = {
      ...expected,
      uci: 'a2a3',
      san: 'a3',
      expected: false,
      acceptedBookTransposition: true,
    }
    const node: PositionNode = {
      ...templateNode,
      id: 'component-e4-vs-a3:ply-0',
      ply: 0,
      epd: start.fen().split(' ').slice(0, 4).join(' '),
      fen: start.fen(),
      sideToMove: 'white',
      expectedMoveUci: 'e2e4',
      nextNodeId: null,
      moves: [expected, contradictory],
      engine: {
        ...templateNode.engine,
        bestMoveUci: 'e2e4',
        expectedMoveCentipawnLoss: 0,
        topVariations: templateNode.engine.topVariations.map((variation, index) => ({
          ...variation,
          multipv: index + 1,
          movesUci: ['e2e4'],
        })),
      },
    }
    const line: VerifiedLine = {
      ...drillLine,
      id: 'component-e4-vs-a3',
      name: 'E4 contradiction guard',
      trainedSide: 'white',
      uci: ['e2e4', 'e7e5'],
      nodes: [node],
    }
    const onReview = vi.fn()
    render(
      <DrillView
        line={line}
        graph={buildPositionGraph([line])}
        progress={createEmptyProgress()}
        orientation="white"
        onSetOrientation={vi.fn()}
        onReview={onReview}
        onAnnouncement={vi.fn()}
        onReturnToBrowser={vi.fn()}
      />,
    )

    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'a2a3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))

    expect(await screen.findByRole('heading', { level: 3, name: 'Unverified deviation' })).toBeTruthy()
    expect(screen.getByText('This legal move lacks enough audited engine or game evidence for a stronger label.')).toBeTruthy()
    expect(screen.getByText('a3')).toBeTruthy()
    expect(screen.getByText('e4 (e2e4)')).toBeTruthy()
    expect(onReview).not.toHaveBeenCalled()
  })

  test.each([
    ['book', { kind: 'centipawn', value: 20 }],
    ['playable', { kind: 'centipawn', value: -15 }],
    ['inaccuracy', { kind: 'mate', value: 3 }],
    ['mistake', { kind: 'mate', value: -2 }],
    ['unverified_deviation', null],
  ] as const)('renders %s evidence, requires correction, and auto-records Again', async (classification, score) => {
    const user = userEvent.setup()
    const line = evidenceVariant(classification, score)
    const onReview = vi.fn()
    const onSetOrientation = vi.fn()
    render(
      <DrillView
        line={line}
        graph={buildPositionGraph([line])}
        progress={createEmptyProgress()}
        orientation="black"
        onSetOrientation={onSetOrientation}
        onReview={onReview}
        onAnnouncement={vi.fn()}
        onReturnToBrowser={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Flip board' }))
    expect(onSetOrientation).toHaveBeenCalledWith('white')
    const alt = line.nodes[0]!.moves[1]!
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), alt.uci)
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    const expectedLabel = classification === 'book' || classification === 'unverified_deviation'
      ? 'Unverified deviation'
      : classification === 'playable'
        ? 'Playable alternative'
        : classification === 'inaccuracy'
          ? 'Inaccuracy'
          : 'Mistake'
    expect(await screen.findByRole('heading', { level: 3, name: expectedLabel })).toBeTruthy()
    expect(onReview).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: /Choose recall grade/u })).toBeNull()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), line.nodes[0]!.expectedMoveUci)
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    expect(onReview).toHaveBeenCalledOnce()
    expect(await screen.findByText(/Last move recorded as again/u)).toBeTruthy()
  })

  test('moves focus from the drill heading directly to the next actionable state after automatic grading', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(
      <DrillView
        line={drillLine}
        graph={buildPositionGraph([drillLine])}
        progress={createEmptyProgress()}
        orientation="white"
        onSetOrientation={vi.fn()}
        onReview={onReview}
        onAnnouncement={vi.fn()}
        onReturnToBrowser={vi.fn()}
      />,
    )
    const heading = await screen.findByRole('heading', { level: 1, name: drillLine.name })
    await waitFor(() => expect(heading).toHaveFocus())
    const expected = drillLine.nodes[0]!.expectedMoveUci
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), expected)
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    expect(onReview).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('group', { name: /Choose recall grade/u })).toBeNull()
    await waitFor(() => {
      const active = document.activeElement
      expect(active?.matches('[role="gridcell"], .completion-card h1')).toBe(true)
    })
  })

  test('keeps explicit keyboard grading available only when manual pacing is opted in', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    render(
      <DrillView
        line={drillLine}
        graph={buildPositionGraph([drillLine])}
        progress={createEmptyProgress()}
        orientation="white"
        onSetOrientation={vi.fn()}
        onReview={onReview}
        manualGrading
        onSetManualGrading={vi.fn()}
        onAnnouncement={vi.fn()}
        onReturnToBrowser={vi.fn()}
      />,
    )

    expect(screen.getByRole('checkbox', { name: 'Pause after each move' })).toBeChecked()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Legal move picker' }),
      drillLine.nodes[0]!.expectedMoveUci,
    )
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    const controls = await screen.findByRole('group', { name: 'Choose recall grade' })
    const good = within(controls).getByRole('button', { name: /Good/u })
    await waitFor(() => expect(good).toHaveFocus())
    await user.keyboard('3')
    expect(onReview).toHaveBeenCalledOnce()
  })
})

describe('progress, evidence, licenses, and App branches', () => {
  test('validates progress warning/error, oversize, valid confirm/cancel, sort, and singular labels', async () => {
    const user = userEvent.setup()
    const progress = createEmptyProgress(new Date('2026-07-11T00:00:00.000Z'))
    const one = scheduleReview(createCard('same::node-a', 'same', 'node-a', new Date('2026-07-10T00:00:00.000Z')), 'good', new Date('2026-07-11T00:00:00.000Z')).card
    const two = { ...createCard('other::node-b', 'other', 'node-b', new Date('2026-07-10T00:00:00.000Z')), dueAt: '2000-01-01T00:00:00.000Z' }
    progress.cards = { [two.cardId]: two, [one.cardId]: one }
    const onImport = vi.fn()
    const onAnnouncement = vi.fn()
    render(
      <ProgressView
        progress={progress}
        variantSummaries={core.variantSummaries}
        searchEntries={core.searchEntries}
        repositoryKind="cloud"
        storageWarning="Read warning"
        saveError="Save warning"
        onImport={onImport}
        onAnnouncement={onAnnouncement}
      />,
    )
    expect(screen.getByText('cloud account')).toBeTruthy()
    expect(screen.getByRole('alert')).toHaveTextContent('Save warning')
    expect(screen.getByText('1 day')).toBeTruthy()
    expect(screen.getByText('New')).toBeTruthy()
    expect(screen.getAllByText('Unknown imported opening').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Not available in the current opening library').length).toBeGreaterThan(0)

    const input = screen.getByLabelText('Choose progress JSON')
    const huge = new File([new Uint8Array(1_048_577)], 'huge.json', { type: 'application/json' })
    await user.upload(input, huge)
    expect(await screen.findByText(/exceeds the 1 MB limit/u)).toBeTruthy()
    const valid = new File([exportProgressJson(progress)], 'valid.json', { type: 'application/json' })
    await user.upload(input, new File([exportProgressJson(progress)], 'valid-again.json', { type: 'application/json' }))
    expect(await screen.findByRole('group', { name: 'Confirm progress import' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Confirm progress import' })).toBeNull()
    await user.upload(input, valid)
    await user.click(await screen.findByRole('button', { name: 'Replace current progress' }))
    expect(onImport).toHaveBeenCalled()
  })

  test('covers compact evidence, move comparisons, and release/provenance alternatives', () => {
    const expected = drillLine.nodes[0]!.moves.find((move) => move.expected)!
    const zeroBands = expected.bands.map((band) => ({ ...band, n: 0, whiteWins: 0, draws: 0, blackWins: 0, wins: 0, losses: 0, winRate: null, drawRate: null, lossRate: null, lowSample: false }))
    const { rerender } = render(<EvidenceTable bands={zeroBands} caption="Compact" compact />)
    expect(screen.getByRole('table')).toHaveClass('compact-table')
    rerender(<MoveComparison played={null} expected={{ ...expected, bands: zeroBands }} />)
    expect(screen.getByRole('columnheader', { name: /Played: No verified evidence/u })).toBeTruthy()
    expect(screen.getAllByText('No games').length).toBeGreaterThan(0)
    const lowBands = expected.bands.map((band) => ({ ...band, lowSample: true, n: Math.min(99, Math.max(1, band.n)) }))
    rerender(<MoveComparison played={{ ...expected, expected: false, bands: lowBands }} expected={{ ...expected, bands: lowBands }} />)
    expect(screen.getAllByText('low sample for played move').length).toBeGreaterThan(0)
    expect(screen.getAllByText('low sample for book move').length).toBeGreaterThan(0)

    const failedAudit = { ...audit, releaseEligible: false }
    rerender(<DataLicenses audit={failedAudit} selectedLine={null} />)
    expect(screen.getByText('Legacy browse snapshot failed validation')).toBeTruthy()
    expect(screen.getByText(/Select any opening line/u)).toBeTruthy()

    const browsableOnly = c20.lines.find((line) => line.verifiedVariantIds.length === 0)!
    rerender(<DataLicenses audit={audit} selectedLine={browsableOnly} />)
    const browsableHeading = screen.getByRole('heading', { level: 3, name: /browsable taxonomy line/u })
    expect(browsableHeading).toHaveTextContent(browsableOnly.name)
    const provenanceSection = browsableHeading.closest('section')
    if (!(provenanceSection instanceof HTMLElement)) throw new Error('Selected-line provenance section missing')
    expect(within(provenanceSection).getByText('Terminal sample').closest('div')).toHaveTextContent(browsableOnly.terminalSampleSize.toLocaleString('en-US'))
    expect(screen.getByText(`${audit.provenance.find((entry) => entry.id === browsableOnly.provenanceRef)!.taxonomy.sourceFile}:${audit.provenance.find((entry) => entry.id === browsableOnly.provenanceRef)!.taxonomy.sourceRow}`)).toBeTruthy()
    expect(screen.getByText(/No learner decision-node engine checks/u)).toBeTruthy()
  })

  test('allows the same validated progress file to be reselected and restores focus after confirmation', async () => {
    const user = userEvent.setup()
    const progress = createEmptyProgress()
    const onImport = vi.fn()
    render(
      <ProgressView
        progress={progress}
        variantSummaries={core.variantSummaries}
        searchEntries={core.searchEntries}
        repositoryKind="memory"
        storageWarning={null}
        saveError={null}
        onImport={onImport}
        onAnnouncement={vi.fn()}
      />,
    )
    const input = screen.getByLabelText('Choose progress JSON')
    const file = new File([exportProgressJson(progress)], 'same-progress.json', { type: 'application/json' })
    await user.upload(input, file)
    const replace = await screen.findByRole('button', { name: 'Replace current progress' })
    await waitFor(() => expect(replace).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(input).toHaveFocus())
    await user.upload(input, file)
    const replaceAgain = await screen.findByRole('button', { name: 'Replace current progress' })
    await user.click(replaceAgain)
    expect(onImport).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(input).toHaveFocus())
  })

  test('initializes the App from light mode, retries partition errors, searches, and opens the canonical family', async () => {
    document.documentElement.dataset.theme = 'light'
    const user = userEvent.setup()
    let partitionAttempts = 0
    const dataSource: OpeningDataSource = {
      initialize: vi.fn(async () => ({ ...core, catalog: core.catalog.filter((entry) => entry.eco !== 'A00') })),
      loadPartition: vi.fn(async (eco) => {
        partitionAttempts += 1
        if (partitionAttempts === 1) throw 'partition rejected'
        return eco === 'C20' ? c20 : { ...c20, eco, lines: c20.lines.map((line) => ({ ...line, eco })), verifiedLines: c20.verifiedLines.map((line) => ({ ...line, eco })) }
      }),
      loadAudit: vi.fn(async () => audit),
    }
    render(<App dataSource={dataSource} />)
    expect(screen.getByRole('button', { name: /Switch to dark mode/u })).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'Your opening practice' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Explore' }))
    expect(await screen.findByText('Opening partition could not be loaded')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'Explore openings', level: 1 })).toBeTruthy()
    const search = screen.getByRole('searchbox', { name: /Opening name or ECO code/u })
    await user.type(search, drillLine.name)
    await user.click(screen.getByRole('button', { name: 'Search openings' }))
    const resultsHeading = await screen.findByRole('heading', { name: /Search results/u })
    const results = resultsHeading.closest('.search-results')
    if (!(results instanceof HTMLElement)) throw new Error('Search results container missing')
    const result = within(results).getAllByRole('button').find((button) =>
      button.querySelector('.eco-pill')?.textContent === 'C20' &&
      button.querySelector('strong')?.textContent === drillLine.name
    )
    if (!result) throw new Error('Expected drill line search result missing')
    await user.click(result)
    await waitFor(() => expect(dataSource.loadPartition).toHaveBeenCalledWith('C20', expect.any(AbortSignal)))
    const lineList = await screen.findByRole('listbox', { name: 'C20 opening lines' })
    const lineOption = within(lineList).getAllByRole('option').find((option) => option.textContent?.includes(drillLine.name))
    if (!lineOption) throw new Error('Expected C20 drill line option missing')
    await user.click(lineOption)
    const family = core.reviewFamilyCatalog.families.find((candidate) =>
      candidate.taxonomyLineIds.includes(drillLine.sourceLineId))
    if (!family) throw new Error('Expected canonical family assignment missing')
    expect(core.reviewFamilyCatalog.families.filter((candidate) =>
      candidate.taxonomyLineIds.includes(drillLine.sourceLineId))).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Start spaced-repetition drill' })).toBeNull()
    await user.click(await screen.findByRole('button', { name: 'Open opening family' }))
    expect(window.location.hash).toBe(`#/repertoire/${family.id}`)
    expect(await screen.findByRole('heading', { level: 1, name: family.canonicalName })).toBeTruthy()
  }, 20_000)

  test('shows provenance for a newly selected browsable-only line instead of a stale drill line', async () => {
    const user = userEvent.setup()
    const browsableOnly = c20.lines.find((line) => line.verifiedVariantIds.length === 0)!
    let resolveC21!: (partition: OpeningPartition) => void
    const delayedC21 = new Promise<OpeningPartition>((resolve) => { resolveC21 = resolve })
    const focusedCore: OpeningDataCore = {
      ...core,
      catalog: core.catalog.filter((entry) => entry.eco === 'C20' || entry.eco === 'C21'),
    }
    const dataSource: OpeningDataSource = {
      initialize: vi.fn(async () => focusedCore),
      loadPartition: vi.fn(async (eco) => eco === 'C21' ? delayedC21 : c20),
      loadAudit: vi.fn(async () => audit),
    }
    render(<App dataSource={dataSource} />)
    await screen.findByRole('heading', { name: 'Your opening practice' })
    await user.click(screen.getByRole('button', { name: 'Explore' }))
    await screen.findByRole('listbox', { name: 'C20 opening lines' })
    const lineList = await screen.findByRole('listbox', { name: 'C20 opening lines' })
    const browsableOption = within(lineList).getAllByRole('option').find((option) => option.textContent?.includes(browsableOnly.name))
    if (!browsableOption) throw new Error('Browsable-only provenance fixture is absent from the C20 line list')
    await user.click(browsableOption)
    await user.click(screen.getByRole('button', { name: 'Data & licenses' }))

    const provenanceHeading = await screen.findByRole('heading', { level: 3, name: /browsable taxonomy line/u })
    expect(provenanceHeading).toHaveTextContent(browsableOnly.name)
    expect(provenanceHeading).toHaveTextContent(/browsable taxonomy line/u)
    expect(provenanceHeading).not.toHaveTextContent(drillLine.name)

    await user.click(screen.getByRole('button', { name: 'Explore' }))
    const ecoList = await screen.findByRole('listbox', { name: 'ECO opening codes' })
    await user.click(within(ecoList).getByRole('option', { name: /^C21/u }))
    expect(await screen.findByText(/Loading C21 opening data/u)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Data & licenses' }))
    expect(screen.queryByRole('heading', { level: 3, name: /browsable taxonomy line/u })).toBeNull()
    expect(screen.getByText(/Select any opening line/u)).toBeTruthy()
    resolveC21({
      ...c20,
      eco: 'C21',
      lines: c20.lines.map((line) => ({ ...line, eco: 'C21' })),
      verifiedLines: c20.verifiedLines.map((line) => ({ ...line, eco: 'C21' })),
    })
  }, 20_000)

  test('ignores a stale partition result after the user selects a newer ECO', async () => {
    const user = userEvent.setup()
    let resolveC20!: (partition: OpeningPartition) => void
    const delayedC20 = new Promise<OpeningPartition>((resolve) => { resolveC20 = resolve })
    let a00Loads = 0
    const focusedCore: OpeningDataCore = {
      ...core,
      catalog: core.catalog.filter((entry) => entry.eco === 'A00' || entry.eco === 'C20'),
    }
    const dataSource: OpeningDataSource = {
      initialize: vi.fn(async () => focusedCore),
      loadPartition: vi.fn(async (eco) => {
        if (eco === 'C20') return delayedC20
        if (eco === 'A00') {
          a00Loads += 1
          return a00
        }
        throw new Error(`Unexpected ECO ${eco}`)
      }),
      loadAudit: vi.fn(async () => audit),
    }
    render(<App dataSource={dataSource} />)
    await screen.findByRole('heading', { name: 'Your opening practice' })
    await user.click(screen.getByRole('button', { name: 'Explore' }))
    const initialList = await screen.findByRole('listbox', { name: 'A00 opening lines' }, { timeout: 10_000 })
    const initialText = within(initialList).getAllByRole('option').map((option) => option.textContent)
    const volumeTabs = screen.getByRole('tablist', { name: 'ECO volumes' })
    await user.click(within(volumeTabs).getByRole('tab', { name: /Volume C:/u }))
    await user.click(within(screen.getByRole('listbox', { name: 'ECO opening codes' })).getByRole('option', { name: /^C20/u }))
    expect(await screen.findByText(/Loading C20 opening data/u)).toBeTruthy()
    await user.click(within(volumeTabs).getByRole('tab', { name: /Volume A:/u }))
    await user.click(within(screen.getByRole('listbox', { name: 'ECO opening codes' })).getByRole('option', { name: /^A00/u }))
    const currentList = await screen.findByRole('listbox', { name: 'A00 opening lines' }, { timeout: 10_000 })
    expect(a00Loads).toBe(2)
    resolveC20(c20)
    await Promise.resolve()
    await waitFor(() => {
      expect(within(currentList).getAllByRole('option').map((option) => option.textContent)).toEqual(initialText)
    })
  }, 20_000)
})

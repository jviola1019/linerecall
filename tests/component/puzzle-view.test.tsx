// @vitest-environment jsdom

import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { DecompressionStream as NodeDecompressionStream } from 'node:stream/web'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { PuzzleView } from '../../src/app/components/PuzzleView.tsx'
import { EmbeddedOpeningDataSource } from '../../src/data/embedded-opening-data-source.ts'
import type { EmbeddedSnapshotPayload } from '../../src/data/embedded-contract.ts'
import embeddedSnapshot from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import { openingPuzzlesFromVerifiedLine, type OpeningPuzzle } from '../../src/domain/opening-puzzles.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true })
Object.defineProperty(globalThis, 'DecompressionStream', { value: NodeDecompressionStream, configurable: true })
Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true })

let puzzles: OpeningPuzzle[]

beforeAll(async () => {
  const source = new EmbeddedOpeningDataSource(embeddedSnapshot as EmbeddedSnapshotPayload)
  const partition = await source.loadPartition('C20')
  const line = partition.verifiedLines
    .filter((candidate) => candidate.drillEligible && !candidate.quarantined)
    .sort((left, right) => right.nodes.length - left.nodes.length)[0]
  if (!line) throw new Error('C20 test fixture has no drillable line')
  puzzles = openingPuzzlesFromVerifiedLine(line)
}, 30_000)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function readyProps() {
  return {
    resource: { status: 'ready' as const, puzzles },
    orientation: 'white' as const,
    onSetOrientation: vi.fn(),
    onRetry: vi.fn(),
  }
}

describe('opening puzzle resource states', () => {
  test('renders idle, loading, empty, external error, and corrupt-data states', () => {
    const props = readyProps()
    const { rerender } = render(<PuzzleView {...props} resource={{ status: 'idle' }} />)
    expect(screen.getByRole('heading', { name: 'Choose a verified opening' })).toBeTruthy()

    rerender(<PuzzleView {...props} resource={{ status: 'loading' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Validating opening puzzles')

    rerender(<PuzzleView {...props} resource={{ status: 'ready', puzzles: [] }} />)
    expect(screen.getByRole('heading', { name: 'No verified puzzles in this variation' })).toBeTruthy()

    rerender(<PuzzleView {...props} resource={{ status: 'error', error: 'Snapshot checksum failed' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Snapshot checksum failed')

    const corrupt = [{ ...puzzles[0]!, expectedMoveUci: 'e2e9' }] as unknown as OpeningPuzzle[]
    rerender(<PuzzleView {...props} resource={{ status: 'ready', puzzles: corrupt }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/failed .* runtime validation check/u)
  })
})

describe('opening puzzle flow', () => {
  test('auto-grades a correct board move without mandatory grade buttons', async () => {
    const user = userEvent.setup()
    const onSolved = vi.fn()
    render(<PuzzleView {...readyProps()} onSolved={onSolved} />)

    await user.click(screen.getByRole('checkbox', { name: /Continue automatically/u }))
    const expected = puzzles[0]!
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), expected.expectedMoveUci)
    await user.click(screen.getByRole('button', { name: 'Play move' }))

    expect(await screen.findByRole('heading', { name: 'Recalled' })).toBeTruthy()
    expect(screen.getByText(/Auto-grade:/u)).toHaveTextContent('good')
    expect(onSolved).toHaveBeenCalledOnce()
    expect(onSolved.mock.calls[0]?.[0].result.autoGrade).toBe('good')
    expect(screen.queryByRole('button', { name: /Again|Hard|Good|Easy/u })).toBeNull()
    expect(screen.getByRole('button', { name: 'Next position' })).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Completed puzzle grades' })).toBeTruthy()
  })

  test('flow mode advances to the next audited position without a grade prompt', async () => {
    const user = userEvent.setup()
    render(<PuzzleView {...readyProps()} autoAdvanceMs={500} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), puzzles[0]!.expectedMoveUci)
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    expect(await screen.findByText(/Position 2 of 2/u, {}, { timeout: 2_000 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Again|Hard|Good|Easy/u })).toBeNull()
  })

  test('shows a textual hint arrow and all stored continuation lines', async () => {
    const user = userEvent.setup()
    render(<PuzzleView {...readyProps()} />)
    const expected = puzzles[0]!
    await user.click(screen.getByRole('button', { name: 'Show hint' }))

    expect(screen.getAllByText(new RegExp(`Study arrow from ${expected.expectedMoveUci.slice(0, 2)} to ${expected.expectedMoveUci.slice(2, 4)}`, 'u')).length).toBeGreaterThan(0)
    expect(screen.getByText(`Stored continuation analysis (${expected.engineVariations.length})`)).toBeTruthy()
    for (const variation of expected.engineVariations) {
      expect(screen.getByText(`UCI: ${variation.movesUci.join(' ')}`)).toBeTruthy()
    }
  })

  test('keeps the SVG overlay outside the ARIA grid and supports keyboard annotations', async () => {
    const user = userEvent.setup()
    const { container } = render(<PuzzleView {...readyProps()} />)
    const grid = screen.getByRole('grid')
    const frame = grid.parentElement
    expect(frame).toHaveClass('chessboard-overlay-frame')
    expect(within(grid).queryByRole('group', { name: 'Board annotation canvas' })).toBeNull()
    expect(container.querySelector('.board-annotation-layer')).toHaveAttribute('aria-hidden', 'true')

    await user.click(screen.getByRole('button', { name: 'Annotate' }))
    const canvas = screen.getByRole('group', { name: 'Board annotation canvas' })
    canvas.focus()
    await user.keyboard('{Enter}{ArrowUp}{Enter}')
    expect(screen.getByText('Study arrow from e4 to e5')).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: /e4,/u })).toBeDisabled()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: 'Board annotation canvas' })).toBeNull()
    expect(screen.getByRole('gridcell', { name: /e4,/u })).not.toBeDisabled()
    expect(screen.getByText('Study arrow from e4 to e5')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Annotate' })).toHaveFocus()
  })

  test('supports primary-pointer drawing and the non-spatial annotation controls', async () => {
    const user = userEvent.setup()
    render(<PuzzleView {...readyProps()} />)
    await user.click(screen.getByRole('button', { name: 'Annotate' }))
    const canvas = screen.getByRole('group', { name: 'Board annotation canvas' })
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, right: 800, bottom: 800, left: 0, width: 800, height: 800,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 1, clientX: 150, clientY: 50 })
    expect(screen.getByText('Study arrow from a8 to b8')).toBeTruthy()

    await user.selectOptions(screen.getByRole('combobox', { name: 'From square' }), 'd4')
    await user.click(screen.getByRole('button', { name: 'Toggle circle' }))
    expect(screen.getByText('Study circle on d4')).toBeTruthy()
  })
})

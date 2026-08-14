// @vitest-environment jsdom

import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { TacticalPuzzleView } from '../../src/app/components/TacticalPuzzleView.tsx'
import { MAX_PUZZLE_ATTEMPT_ELAPSED_MS } from '../../src/domain/puzzle-progress.ts'
import type { TacticalPuzzleResource } from '../../src/data/tactical-puzzle-resource.ts'
import { createSyntheticTacticalPuzzle } from '../fixtures/synthetic-tactical-puzzle.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('tactical puzzle route', () => {
  test('does not substitute opening recall when no tactical shard is promoted', () => {
    render(
      <TacticalPuzzleView
        resource={{ status: 'disabled', reason: 'No tactical shard has passed release verification.' }}
        orientation="white"
      />,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Puzzles' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Tactical puzzles are not released yet' })).toBeVisible()
    expect(screen.queryByText(/Find the repertoire move/u)).not.toBeInTheDocument()
  })

  test('applies the learner move and forced reply as separate board transitions', async () => {
    const user = userEvent.setup()
    const onAttempt = vi.fn()
    const onAnnouncement = vi.fn()
    const puzzle = createSyntheticTacticalPuzzle()
    render(
      <TacticalPuzzleView
        resource={{ status: 'ready', puzzles: [puzzle] }}
        orientation="white"
        reducedMotion={false}
        onAttempt={onAttempt}
        onAnnouncement={onAnnouncement}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Why' }))
    expect(screen.getByRole('complementary', { name: 'Your move' })).toHaveFocus()
    expect(onAnnouncement).toHaveBeenCalledWith('Puzzle evidence opened.')
    expect(screen.getByRole('status', { name: 'Puzzle status: Your move' })).toHaveTextContent('No hint')
    expect(screen.getByText('Why this puzzle appears here')).toBeVisible()

    const picker = screen.getByRole('combobox', { name: 'Legal move picker' })
    await user.selectOptions(picker, 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    expect(screen.getByText(/forced reply is playing/u)).toBeVisible()
    expect(await screen.findByText(/Opponent reply complete/u)).toBeVisible()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'f1b5')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    await waitFor(() => expect(onAttempt).toHaveBeenCalledOnce())
    expect(screen.getByRole('status', { name: 'Puzzle status: Solved' })).toBeVisible()
    expect(onAttempt.mock.calls[0]?.[0]).toMatchObject({
      puzzleId: puzzle.puzzleId,
      outcome: 'solved',
      incorrectAttempts: 0,
      usedHint: false,
    })
  })

  test('does not mark an attempt recorded until persistence succeeds and retries the same event ID', async () => {
    const user = userEvent.setup()
    const puzzle = createSyntheticTacticalPuzzle()
    const events: Array<{ eventId: string }> = []
    const onAttempt = vi.fn(async (event: { eventId: string }) => {
      events.push(event)
      if (events.length === 1) throw new Error('storage unavailable')
    })
    render(
      <TacticalPuzzleView
        resource={{ status: 'ready', puzzles: [puzzle] }}
        orientation="white"
        reducedMotion
        onAttempt={onAttempt}
      />,
    )

    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    await screen.findByText(/Opponent reply complete/u)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'f1b5')
    await user.click(screen.getByRole('button', { name: 'Play move' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be saved/u)
    expect(screen.getByRole('button', { name: 'Next puzzle' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Retry save' }))
    await waitFor(() => expect(onAttempt).toHaveBeenCalledTimes(2))
    expect(events[0]?.eventId).toBe(events[1]?.eventId)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next puzzle' })).toBeEnabled())
  })

  test('locks board input while abandonment is saving', async () => {
    const user = userEvent.setup()
    let resolveSave: () => void = () => undefined
    const onAttempt = vi.fn(() => new Promise<void>((resolve) => {
      resolveSave = resolve
    }))
    render(
      <TacticalPuzzleView
        resource={{ status: 'ready', puzzles: [createSyntheticTacticalPuzzle()] }}
        orientation="white"
        reducedMotion
        onAttempt={onAttempt}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Skip puzzle' }))
    await waitFor(() => expect(onAttempt).toHaveBeenCalledOnce())
    expect(screen.getByRole('combobox', { name: 'Legal move picker' })).toBeDisabled()
    expect(screen.getByRole('gridcell', { name: /^g1,/u })).toHaveAttribute('aria-disabled', 'true')
    resolveSave()
  })

  test('caps elapsed time at the versioned progress-contract limit', async () => {
    const user = userEvent.setup()
    let now = Date.parse('2026-07-28T12:00:00.000Z')
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const onAttempt = vi.fn()
    const puzzle = createSyntheticTacticalPuzzle(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      ['e7e5', 'g1f3'],
      'Elapsed1',
    )
    render(
      <TacticalPuzzleView
        resource={{ status: 'ready', puzzles: [puzzle] }}
        orientation="white"
        reducedMotion
        onAttempt={onAttempt}
      />,
    )

    now += MAX_PUZZLE_ATTEMPT_ELAPSED_MS + 60_000
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    await waitFor(() => expect(onAttempt).toHaveBeenCalledOnce())
    expect(onAttempt.mock.calls[0]?.[0]).toMatchObject({
      elapsedMs: MAX_PUZZLE_ATTEMPT_ELAPSED_MS,
    })
  })

  test('renders explicit rate-limit and corrupt-shard states', () => {
    const { rerender } = render(
      <TacticalPuzzleView
        resource={{
          status: 'rate-limited',
          retryAt: '2026-07-28T12:01:00.000Z',
          retryAfterSeconds: 60,
          reason: 'Provider cooldown is active.',
        }}
        orientation="white"
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/Retry after 60 seconds/u)
    rerender(
      <TacticalPuzzleView
        resource={{ status: 'corrupt', reason: 'The signed shard failed record validation.' }}
        orientation="white"
      />,
    )
    expect(screen.getByRole('heading', { name: 'Puzzle shard rejected' })).toBeVisible()
  })

  test('fails closed when an untrusted resource bypasses compile-time typing', () => {
    render(
      <TacticalPuzzleView
        resource={{
          status: 'ready',
          puzzles: [{ puzzleId: '<script>alert(1)</script>' }],
        } as unknown as TacticalPuzzleResource}
        orientation="white"
      />,
    )
    expect(screen.getByRole('heading', { name: 'Puzzle shard rejected' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(/failed runtime validation/u)
    expect(document.querySelector('script')).toBeNull()
  })
})

// @vitest-environment jsdom

import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { TacticalPuzzleView } from '../../src/app/components/TacticalPuzzleView.tsx'
import { MAX_PUZZLE_ATTEMPT_ELAPSED_MS } from '../../src/domain/puzzle-progress.ts'
import type { TacticalPuzzleResource } from '../../src/data/tactical-puzzle-resource.ts'
import {
  createSyntheticPuzzleResource,
  createSyntheticTacticalPuzzle,
} from '../fixtures/synthetic-tactical-puzzle.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('tactical puzzle route', () => {
  test('does not substitute opening recall when no tactical shard is promoted', async () => {
    const user = userEvent.setup()
    const onBrowseOpenings = vi.fn()
    const onOpenData = vi.fn()
    render(
      <TacticalPuzzleView
        resource={{ status: 'disabled', reason: 'No tactical shard has passed release verification.' }}
        orientation="white"
        onBrowseOpenings={onBrowseOpenings}
        onOpenData={onOpenData}
      />,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Puzzles' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Verified puzzles aren’t included in this build yet.' })).toBeVisible()
    expect(screen.queryByText(/Find the repertoire move/u)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Browse openings' }))
    await user.click(screen.getByRole('button', { name: 'See puzzle data status' }))
    expect(onBrowseOpenings).toHaveBeenCalledOnce()
    expect(onOpenData).toHaveBeenCalledOnce()
  })

  test('applies the learner move and forced reply as separate board transitions', async () => {
    const user = userEvent.setup()
    const onAttempt = vi.fn()
    const onAnnouncement = vi.fn()
    const puzzle = createSyntheticTacticalPuzzle()
    const resource = createSyntheticPuzzleResource([puzzle])
    render(
      <TacticalPuzzleView
        resource={resource}
        orientation="white"
        reducedMotion={false}
        onAttempt={onAttempt}
        onAnnouncement={onAnnouncement}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Why' }))
    expect(screen.getByRole('complementary', { name: 'Your move' })).toHaveFocus()
    expect(onAnnouncement).toHaveBeenCalledWith('Puzzle details opened.')
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
    const resource = createSyntheticPuzzleResource([puzzle])
    const events: Array<{ eventId: string }> = []
    const onAttempt = vi.fn(async (event: { eventId: string }) => {
      events.push(event)
      if (events.length === 1) throw new Error('storage unavailable')
    })
    render(
      <TacticalPuzzleView
        resource={resource}
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
    expect(screen.getByRole('button', { name: 'Practice again' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Retry save' }))
    await waitFor(() => expect(onAttempt).toHaveBeenCalledTimes(2))
    expect(events[0]?.eventId).toBe(events[1]?.eventId)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Practice again' })).toBeEnabled())
  })

  test('locks board input while abandonment is saving', async () => {
    const user = userEvent.setup()
    let resolveSave: () => void = () => undefined
    const onAttempt = vi.fn(() => new Promise<void>((resolve) => {
      resolveSave = resolve
    }))
    const puzzle = createSyntheticTacticalPuzzle()
    render(
      <TacticalPuzzleView
        resource={createSyntheticPuzzleResource([puzzle])}
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
    const resource = createSyntheticPuzzleResource([puzzle])
    render(
      <TacticalPuzzleView
        resource={resource}
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
    const now = Date.parse('2026-08-23T12:00:00.000Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const rendered = render(
      <TacticalPuzzleView
        resource={{
          status: 'rate-limited',
          retryAt: new Date(now + 1_000).toISOString(),
          retryAfterSeconds: 1,
          reason: 'Provider cooldown is active.',
        }}
        orientation="white"
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Try again in 1 second.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
    rendered.unmount()
    const expired = render(
      <TacticalPuzzleView
        resource={{
          status: 'rate-limited',
          retryAt: new Date(now - 1_000).toISOString(),
          retryAfterSeconds: 1,
          reason: 'Provider cooldown is active.',
        }}
        orientation="white"
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByText('Retry is available now.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expired.unmount()
    render(
      <TacticalPuzzleView
        resource={{ status: 'corrupt', reason: 'The signed shard failed record validation.' }}
        orientation="white"
      />,
    )
    expect(screen.getByRole('heading', { name: 'Puzzles could not be loaded' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  test('does not offer a fake retry when the containing app has no reload operation', () => {
    render(
      <TacticalPuzzleView
        resource={{
          status: 'rate-limited',
          retryAt: '2026-08-23T12:01:00.000Z',
          retryAfterSeconds: 60,
          reason: 'Provider cooldown is active.',
        }}
        orientation="white"
      />,
    )
    expect(screen.getByText('This build cannot reload puzzle data.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  test('keeps stale and offline records visibly bound to their verified release', () => {
    const puzzle = createSyntheticTacticalPuzzle()
    const staleResource = createSyntheticPuzzleResource([puzzle], {
      identity: 'stale-puzzle',
      status: 'stale',
      staleAt: '2026-07-29T12:00:00.000Z',
      reason: 'A newer release is pending.',
    })
    const { rerender } = render(
      <TacticalPuzzleView
        resource={staleResource}
        orientation="white"
      />,
    )
    expect(screen.getByText(/Using verified puzzle data marked stale on Jul 29, 2026\./u)).toBeVisible()
    expect(screen.getByText(staleResource.release.releaseId)).toBeVisible()

    rerender(
      <TacticalPuzzleView
        resource={createSyntheticPuzzleResource([puzzle], {
          identity: 'offline-puzzle',
          status: 'offline',
          reason: 'No network connection. The verified in-session shard is still available.',
        })}
        orientation="white"
      />,
    )
    expect(screen.getByText(/Offline mode/u)).toBeVisible()
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
    expect(screen.getByRole('heading', { name: 'Puzzles could not be loaded' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(/did not pass its integrity checks/u)
    expect(document.querySelector('script')).toBeNull()
  })

  test('resets the board session when a verified puzzle collection is replaced', async () => {
    const first = createSyntheticTacticalPuzzle()
    const second = createSyntheticTacticalPuzzle(
      'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      ['e7e6', 'd2d4'],
      'Puzzle2',
    )
    const { rerender } = render(
      <TacticalPuzzleView
        resource={createSyntheticPuzzleResource([first])}
        orientation="white"
        reducedMotion
        onAttempt={vi.fn()}
      />,
    )

    rerender(
      <TacticalPuzzleView
        resource={createSyntheticPuzzleResource([second])}
        orientation="white"
        reducedMotion
        onAttempt={vi.fn()}
      />,
    )
    expect(screen.getByRole('status', { name: 'Puzzle status: Your move' })).toBeVisible()
    const picker = screen.getByRole('combobox', { name: 'Legal move picker' })
    expect(picker.querySelector('option[value="d2d4"]')).not.toBeNull()
    expect(screen.getByRole('gridcell', { name: /^e6, Black pawn/u })).toBeVisible()
    expect(screen.getByRole('gridcell', { name: /^e5, empty/u })).toBeVisible()
  })

  test('advances through a bounded puzzle queue before offering a restart', async () => {
    const user = userEvent.setup()
    const puzzles = [
      createSyntheticTacticalPuzzle(undefined, undefined, 'Puzzle1'),
      createSyntheticTacticalPuzzle(undefined, undefined, 'Puzzle2'),
    ]
    render(
      <TacticalPuzzleView
        resource={createSyntheticPuzzleResource(puzzles)}
        orientation="white"
        reducedMotion
        onAttempt={vi.fn()}
      />,
    )

    const solveCurrent = async (): Promise<void> => {
      await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'g1f3')
      await user.click(screen.getByRole('button', { name: 'Play move' }))
      await screen.findByText(/Opponent reply complete/u)
      await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'f1b5')
      await user.click(screen.getByRole('button', { name: 'Play move' }))
    }

    await solveCurrent()
    expect(await screen.findByText(/1 solved this round/u)).toBeVisible()
    const next = screen.getByRole('button', { name: 'Next puzzle' })
    await waitFor(() => expect(next).toBeEnabled())
    await user.click(next)
    expect(screen.getAllByText(/Puzzle 2 of 2/u)[0]).toBeVisible()

    await solveCurrent()
    expect(await screen.findByText(/2 solved this round/u)).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restart queue' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Restart queue' }))
    expect(screen.getAllByText(/Puzzle 1 of 2/u)[0]).toBeVisible()
    expect(screen.getByText(/0 solved this round/u)).toBeVisible()
  })

  test('remounts from the full verified collection identity when only a middle record changes', async () => {
    const user = userEvent.setup()
    const first = createSyntheticTacticalPuzzle(undefined, undefined, 'Puzzle1')
    const middle = createSyntheticTacticalPuzzle(undefined, undefined, 'Puzzle2')
    const last = createSyntheticTacticalPuzzle(undefined, undefined, 'Puzzle3')
    const initial = [first, middle, last]
    const { rerender } = render(
      <TacticalPuzzleView
        resource={createSyntheticPuzzleResource(initial, { identity: 'initial-collection' })}
        orientation="white"
        reducedMotion
        onAttempt={vi.fn()}
      />,
    )

    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    await screen.findByText(/Opponent reply complete/u)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'f1b5')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next puzzle' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Next puzzle' }))
    expect(screen.getAllByText(/Puzzle 2 of 3/u)[0]).toBeVisible()

    const replacementMiddle = createSyntheticTacticalPuzzle(
      undefined,
      ['e7e6', 'd2d4'],
      'Puzzle2B',
    )
    const replacement = [first, replacementMiddle, last]
    rerender(
      <TacticalPuzzleView
        resource={createSyntheticPuzzleResource(replacement, { identity: 'replacement-collection' })}
        orientation="white"
        reducedMotion
        onAttempt={vi.fn()}
      />,
    )
    expect(screen.getAllByText(/Puzzle 1 of 3/u)[0]).toBeVisible()
    expect(screen.getByText(/0 solved this round/u)).toBeVisible()
  })
})

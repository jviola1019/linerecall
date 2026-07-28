// @vitest-environment jsdom

import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { TacticalPuzzleView } from '../../src/app/components/TacticalPuzzleView.tsx'
import type { TacticalPuzzleResource } from '../../src/data/tactical-puzzle-resource.ts'
import { createSyntheticTacticalPuzzle } from '../fixtures/synthetic-tactical-puzzle.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true })

afterEach(() => cleanup())

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
    const puzzle = createSyntheticTacticalPuzzle()
    render(
      <TacticalPuzzleView
        resource={{ status: 'ready', puzzles: [puzzle] }}
        orientation="white"
        reducedMotion={false}
        onAttempt={onAttempt}
      />,
    )

    const picker = screen.getByRole('combobox', { name: 'Legal move picker' })
    await user.selectOptions(picker, 'g1f3')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    expect(screen.getByText(/forced reply is playing/u)).toBeVisible()
    expect(await screen.findByText(/Opponent reply complete/u)).toBeVisible()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Legal move picker' }), 'f1b5')
    await user.click(screen.getByRole('button', { name: 'Play move' }))
    await waitFor(() => expect(onAttempt).toHaveBeenCalledOnce())
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

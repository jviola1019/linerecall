// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ProgressView } from '../../src/app/components/ProgressView.tsx'
import type { OpeningVariantSummary } from '../../src/data/opening-data-source.ts'
import type { OpeningSearchEntry } from '../../src/domain/input-validation.ts'
import { createEmptyProgress, type CardProgress } from '../../src/domain/progress.ts'

const sourceLineId = 'tax_bbbbbbbbbbbbbbbbbbbbbbbb'
const variantId = `${sourceLineId}:white`
const variants: OpeningVariantSummary[] = [{
  id: variantId,
  sourceLineId,
  eco: 'C20',
  name: 'Audited King Pawn Line',
  trainedSide: 'white',
  cardCount: 1,
}]
const searchEntries: OpeningSearchEntry[] = [{
  sourceLineId,
  eco: 'C20',
  name: 'Audited King Pawn Line',
  pgn: '1. e4 e5',
  uci: ['e2e4', 'e7e5'],
  terminalEpd: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
  terminalSampleSize: 1_000,
  backtestEligible: true,
  verifiedVariantIds: [variantId],
}]

function card(cardId: string, nodeId: string, dueAt: string): CardProgress {
  return {
    cardId,
    lineId: variantId,
    nodeId,
    repetitions: 1,
    intervalDays: 30,
    easeFactor: 2.5,
    dueAt,
    lastReviewedAt: '2026-07-11T12:00:00.000Z',
    reviewCount: 1,
    lapseCount: 0,
  }
}

function view(progress: ReturnType<typeof createEmptyProgress>): React.JSX.Element {
  return (
    <ProgressView
      progress={progress}
      variantSummaries={variants}
      searchEntries={searchEntries}
      repositoryKind="memory"
      storageWarning={null}
      saveError={null}
      onImport={vi.fn()}
      onAnnouncement={vi.fn()}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('audited progress aggregation UI', () => {
  test('announces excluded stale node records while preserving them in raw history', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-12T12:00:00.000Z'))
    const progress = createEmptyProgress()
    progress.cards.valid = card('valid', `${variantId}:ply-0`, '2026-08-10T12:00:00.000Z')
    progress.cards.stale = card('stale', 'plausible-but-unaudited-node', '2000-01-01T00:00:00.000Z')
    render(view(progress))

    expect(screen.getByRole('status')).toHaveTextContent(/1 stored card record was excluded from progress totals/u)
    expect(screen.getByRole('status')).toHaveTextContent(/does not match a current audited learner position or it duplicates one/u)
    expect(screen.getByRole('status')).toHaveTextContent(/raw review history remains below/u)
    expect(screen.getByText('Cards reviewed').parentElement).toHaveTextContent(/^1Cards reviewed$/u)
    expect(screen.getByRole('table', { name: '2 stored cards' })).toHaveTextContent('plausible-but-unaudited-node')
    const variationRow = within(screen.getByRole('table', { name: /trained-side variation in started openings/u }))
      .getByRole('row', { name: /Audited King Pawn Line/u })
    expect(within(variationRow).getAllByRole('cell')[1]).toHaveTextContent(/^1$/u)
  })

  test('updates due-now at the nearest deadline and cleans timers on card changes and unmount', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const progress = createEmptyProgress()
    progress.cards.valid = card('valid', `${variantId}:ply-0`, '2026-07-11T12:00:01.000Z')
    const rendered = render(view(progress))

    const dueCell = (): HTMLElement => {
      const row = within(screen.getByRole('table', { name: /trained-side variation in started openings/u }))
        .getByRole('row', { name: /Audited King Pawn Line/u })
      return within(row).getAllByRole('cell')[2]!
    }
    expect(dueCell()).toHaveTextContent(/^0$/u)
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(999))
    expect(dueCell()).toHaveTextContent(/^0$/u)
    act(() => vi.advanceTimersByTime(1))
    expect(dueCell()).toHaveTextContent(/^1$/u)
    expect(vi.getTimerCount()).toBe(0)

    const later = createEmptyProgress()
    later.cards.valid = card('valid', `${variantId}:ply-0`, '2026-07-11T12:01:00.000Z')
    rendered.rerender(view(later))
    expect(vi.getTimerCount()).toBe(1)
    rendered.rerender(view(createEmptyProgress()))
    expect(vi.getTimerCount()).toBe(0)
    rendered.rerender(view(later))
    expect(vi.getTimerCount()).toBe(1)
    rendered.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

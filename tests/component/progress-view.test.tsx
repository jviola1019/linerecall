// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
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

    expect(screen.getByRole('status')).toHaveTextContent(/1 stored position was excluded/u)
    expect(screen.getByRole('status')).toHaveTextContent(/does not match the current opening library or it duplicates another record/u)
    expect(screen.getByRole('status')).toHaveTextContent(/original review history remains below/u)
    const progressSummary = screen.getByRole('heading', { name: 'Progress summary' }).closest('section')
    expect(progressSummary).not.toBeNull()
    expect(within(progressSummary!).getByText('Moves reviewed').parentElement).toHaveTextContent(/^1Moves reviewed$/u)
    expect(screen.getByRole('table', { name: '2 stored moves' })).toHaveTextContent('plausible-but-unaudited-node')
    const variationRow = within(screen.getByRole('table', { name: /opening side with review history/u }))
      .getByRole('row', { name: /Audited King Pawn Line/u })
    expect(within(variationRow).getAllByRole('cell')[1]).toHaveTextContent(/^1$/u)
  })

  test('uses one compact first-run state with a direct opening action', async () => {
    const user = userEvent.setup()
    const onBrowseRepertoire = vi.fn()
    render(
      <ProgressView
        progress={createEmptyProgress()}
        variantSummaries={variants}
        searchEntries={searchEntries}
        repositoryKind="memory"
        storageWarning={null}
        saveError={null}
        onImport={vi.fn()}
        onBrowseRepertoire={onBrowseRepertoire}
        onAnnouncement={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Your first session will build this page.' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'No opening progress yet' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'No reviews yet' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Choose an opening' }))
    expect(onBrowseRepertoire).toHaveBeenCalledOnce()
  })

  test('renders opening families as compact resume rows instead of a horizontal table', async () => {
    const user = userEvent.setup()
    const onStartTrainingTarget = vi.fn()
    const target = {
      familyId: 'caro-kann',
      side: 'black' as const,
      mode: 'review' as const,
      reason: 'due' as const,
    }
    render(
      <ProgressView
        progress={createEmptyProgress()}
        variantSummaries={variants}
        searchEntries={searchEntries}
        repositoryKind="memory"
        storageWarning={null}
        saveError={null}
        familySummaries={[{
          releaseId: 'review-v1',
          familyId: 'caro-kann',
          canonicalName: 'Caro–Kann',
          ecoCodes: ['B10', 'B19'],
          readiness: 'ready',
          readySides: ['black'],
          totalPaths: 14,
          completedPaths: 3,
          dueCards: 2,
          learnerDepthRange: [10, 18],
          lastReviewedAt: '2026-08-26T12:00:00.000Z',
        }]}
        nextTrainingTarget={target}
        trainingTargetsByFamily={{ 'caro-kann': target }}
        onStartTrainingTarget={onStartTrainingTarget}
        onImport={vi.fn()}
        onAnnouncement={vi.fn()}
      />,
    )

    const familyList = screen.getByRole('list', { name: 'Opening family coverage' })
    expect(within(familyList).getByText('3 of 14 variations')).toBeVisible()
    expect(familyList.querySelector('.progress-family-recall')).toHaveTextContent(/^2moves due$/u)
    expect(within(familyList).getByRole('progressbar', { name: 'Caro–Kann: 21% of variations practiced' })).toBeVisible()
    expect(screen.queryByRole('region', { name: /Opening family coverage, horizontally scrollable/u })).not.toBeInTheDocument()
    await user.click(within(familyList).getByRole('button', { name: 'Review' }))
    expect(onStartTrainingTarget).toHaveBeenCalledWith(target)
  })

  test('keeps due review actions attached to each opening family', async () => {
    const user = userEvent.setup()
    const onStartTrainingTarget = vi.fn()
    const caroTarget = {
      familyId: 'caro-kann',
      side: 'black' as const,
      mode: 'review' as const,
      reason: 'due' as const,
    }
    const sicilianTarget = {
      familyId: 'sicilian-defence',
      side: 'white' as const,
      mode: 'review' as const,
      reason: 'due' as const,
    }

    render(
      <ProgressView
        progress={createEmptyProgress()}
        variantSummaries={variants}
        searchEntries={searchEntries}
        repositoryKind="memory"
        storageWarning={null}
        saveError={null}
        familySummaries={[
          {
            releaseId: 'review-v1',
            familyId: 'caro-kann',
            canonicalName: 'Caro-Kann',
            ecoCodes: ['B10', 'B19'],
            readiness: 'ready',
            readySides: ['black'],
            totalPaths: 14,
            completedPaths: 3,
            dueCards: 2,
          },
          {
            releaseId: 'review-v1',
            familyId: 'sicilian-defence',
            canonicalName: 'Sicilian Defence',
            ecoCodes: ['B20', 'B99'],
            readiness: 'ready',
            readySides: ['white'],
            totalPaths: 32,
            completedPaths: 5,
            dueCards: 4,
          },
        ]}
        nextTrainingTarget={caroTarget}
        trainingTargetsByFamily={{
          'caro-kann': caroTarget,
          'sicilian-defence': sicilianTarget,
        }}
        onStartTrainingTarget={onStartTrainingTarget}
        onImport={vi.fn()}
        onAnnouncement={vi.fn()}
      />,
    )

    const familyList = screen.getByRole('list', { name: 'Opening family coverage' })
    const sicilianRow = within(familyList).getByText('Sicilian Defence').closest('li')
    expect(sicilianRow).not.toBeNull()
    await user.click(within(sicilianRow!).getByRole('button', { name: 'Review' }))
    expect(onStartTrainingTarget).toHaveBeenCalledWith(sicilianTarget)
  })

  test('updates due-now at the nearest deadline and cleans timers on card changes and unmount', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'))
    const progress = createEmptyProgress()
    progress.cards.valid = card('valid', `${variantId}:ply-0`, '2026-07-11T12:00:01.000Z')
    const rendered = render(view(progress))

    const dueCell = (): HTMLElement => {
      const row = within(screen.getByRole('table', { name: /opening side with review history/u }))
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

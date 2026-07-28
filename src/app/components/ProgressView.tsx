import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type { OpeningVariantSummary } from '../../data/opening-data-source.ts'
import type { OpeningSearchEntry } from '../../domain/input-validation.ts'
import { masteryPercent, type ProgressRepository, type ProgressV1 } from '../../domain/progress.ts'
import { puzzleMasteryPercent, type PuzzleProgress } from '../../domain/puzzle-progress.ts'
import {
  summarizeProgress,
  type VariationProgressSummary,
} from '../../domain/progress-summary.ts'
import {
  MAX_PROGRESS_IMPORT_BYTES,
  exportProgressJson,
  importProgressJson,
} from '../../infrastructure/progress-repository.ts'

export interface ProgressViewProps {
  progress: ProgressV1
  variantSummaries: readonly OpeningVariantSummary[]
  searchEntries: readonly OpeningSearchEntry[]
  repositoryKind: ProgressRepository['kind']
  storageWarning: string | null
  saveError: string | null
  puzzleProgress?: PuzzleProgress
  familyCompletionCount?: Readonly<Record<string, number>>
  onImport: (progress: ProgressV1) => void
  onAnnouncement: (message: string) => void
}

function variationIdentity(variation: VariationProgressSummary | undefined): React.JSX.Element {
  if (!variation) {
    return <><span>Unknown imported opening</span><br /><small>Unknown ECO · Unknown training side</small></>
  }
  const side = variation.trainedSide === null
    ? 'Unknown training side'
    : `Train ${variation.trainedSide === 'white' ? 'White' : 'Black'}`
  return (
    <>
      <span>{variation.name}</span><br />
      <small>{variation.eco ?? 'Unknown ECO'} · {side}</small>
      {!variation.availableInCurrentSnapshot ? <><br /><small>Not in the current audited drill snapshot</small></> : null}
    </>
  )
}

function downloadProgress(progress: ProgressV1): void {
  const blob = new Blob([exportProgressJson(progress)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `linerecall-progress-${new Date().toISOString().slice(0, 10)}.json`
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  // Firefox and WebKit can begin the download after click() returns. Keeping the
  // temporary anchor and bounded object URL alive avoids racing that browser task.
  setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(url)
  }, 60_000)
}

const MAX_DUE_TIMER_DELAY_MS = 2_147_483_647

export function ProgressView({
  progress,
  variantSummaries,
  searchEntries,
  repositoryKind,
  storageWarning,
  saveError,
  puzzleProgress,
  familyCompletionCount = {},
  onImport,
  onAnnouncement,
}: ProgressViewProps): React.JSX.Element {
  const cards = useMemo(() => Object.values(progress.cards).sort((left, right) => {
    const leftTime = left.lastReviewedAt ? Date.parse(left.lastReviewedAt) : 0
    const rightTime = right.lastReviewedAt ? Date.parse(right.lastReviewedAt) : 0
    return rightTime - leftTime || left.lineId.localeCompare(right.lineId, 'en')
  }), [progress.cards])
  const [dueClock, setDueClock] = useState(0)
  const summaries = useMemo(
    () => summarizeProgress(
      cards,
      variantSummaries,
      searchEntries,
      new Date(),
      progress.openingStreaks,
      progress.variationStreaks,
    ),
    [cards, dueClock, progress.openingStreaks, progress.variationStreaks, searchEntries, variantSummaries],
  )
  const variationById = useMemo(
    () => new Map(summaries.variations.map((variation) => [variation.id, variation] as const)),
    [summaries.variations],
  )
  const puzzleEntries = useMemo(
    () => Object.values(puzzleProgress?.puzzles ?? {}).sort((left, right) =>
      (right.lastAttemptAt ?? '').localeCompare(left.lastAttemptAt ?? '', 'en')),
    [puzzleProgress],
  )
  const completedFamilyPaths = Object.values(familyCompletionCount).reduce((total, count) => total + count, 0)
  const [candidate, setCandidate] = useState<ProgressV1 | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const importErrorId = useId()
  const importInputRef = useRef<HTMLInputElement>(null)
  const confirmImportRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const now = Date.now()
    let nearestFutureDue = Number.POSITIVE_INFINITY
    for (const card of cards) {
      const dueAt = Date.parse(card.dueAt)
      if (dueAt > now && dueAt < nearestFutureDue) nearestFutureDue = dueAt
    }
    if (!Number.isFinite(nearestFutureDue)) return
    const delay = Math.min(MAX_DUE_TIMER_DELAY_MS, Math.max(0, nearestFutureDue - now))
    const timer = setTimeout(() => setDueClock((current) => current + 1), delay)
    return () => clearTimeout(timer)
  }, [cards, dueClock])

  useEffect(() => {
    if (candidate) confirmImportRef.current?.focus()
  }, [candidate])

  const chooseImport = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    setCandidate(null)
    setFileName(null)
    setImportError(null)
    const file = event.currentTarget.files?.[0]
    if (!file) return
    event.currentTarget.value = ''
    if (file.size > MAX_PROGRESS_IMPORT_BYTES) {
      setImportError('Progress file exceeds the 1 MB limit.')
      return
    }
    try {
      const parsed = importProgressJson(await file.text())
      setCandidate(parsed)
      setFileName(file.name)
      onAnnouncement(`Validated ${file.name}. Confirm replacement to import ${Object.keys(parsed.cards).length} cards.`)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Progress file is invalid.'
      setImportError(message)
    }
  }

  return (
    <div className="progress-view">
      <header className="documentation-header">
        <p className="eyebrow">Spaced repetition</p>
        <h1>Your progress</h1>
        <p>Each learner-side decision position is scheduled as a separate SM-2 card.</p>
      </header>

      {storageWarning ? <div className="persistent-warning" role="status"><strong>Storage:</strong> {storageWarning}</div> : null}
      {saveError ? <div className="persistent-warning error-warning" role="alert"><span aria-hidden="true">!</span> {saveError}</div> : null}

      <section className="progress-summary" aria-labelledby="progress-summary-title">
        <h2 id="progress-summary-title" className="sr-only">Progress summary</h2>
        <div><strong>{summaries.reviewedCards}</strong><span>Cards reviewed</span></div>
        <div><strong>{summaries.dueCards}</strong><span>Due now</span></div>
        <div><strong>{summaries.mastery}%</strong><span>Mean mastery</span></div>
        <div><strong>{progress.streak.current}</strong><span>Day streak</span></div>
      </section>
      <section className="progress-separated-summary" aria-label="Family coverage and tactical progress">
        <article>
          <p className="eyebrow">Family coverage</p>
          <strong>{completedFamilyPaths}</strong>
          <span>audited paths completed</span>
        </article>
        <article>
          <p className="eyebrow">Tactical puzzles</p>
          <strong>{puzzleEntries.reduce((total, entry) => total + entry.solves, 0)}</strong>
          <span>solutions · separate mastery</span>
        </article>
      </section>
      <p className="field-help">
        Mastery includes every learner position in each started opening; unreviewed cards count as 0%.
        Streaks count consecutive local calendar days with completed reviews globally and within each opening and trained-side variation.
      </p>
      {summaries.excludedCards > 0 ? (
        <div className="persistent-warning" role="status">
          <span aria-hidden="true">!</span>{' '}
          {summaries.excludedCards} stored {summaries.excludedCards === 1 ? 'card record was' : 'card records were'} excluded from progress totals because {summaries.excludedCards === 1 ? 'it does' : 'they do'} not match a current audited learner position or {summaries.excludedCards === 1 ? 'it duplicates' : 'they duplicate'} one. The raw review history remains below.
        </div>
      ) : null}

      <section className="card-history" aria-labelledby="puzzle-progress-title">
        <h2 id="puzzle-progress-title">Puzzle progress</h2>
        <p className="field-help">Puzzle attempts never change opening-recall schedules or family coverage.</p>
        {puzzleEntries.length === 0 ? (
          <p className="field-help">Audited tactical results appear here after a promoted puzzle shard is available.</p>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Puzzle progress, horizontally scrollable">
            <table className="stats-table">
              <caption>{puzzleEntries.length} attempted tactical {puzzleEntries.length === 1 ? 'puzzle' : 'puzzles'}</caption>
              <thead>
                <tr><th scope="col">Puzzle</th><th scope="col">Mastery</th><th scope="col">Solved</th><th scope="col">Clean solves</th><th scope="col">Hints</th><th scope="col">Incorrect moves</th><th scope="col">Abandoned</th></tr>
              </thead>
              <tbody>
                {puzzleEntries.map((entry) => (
                  <tr key={entry.puzzleId}>
                    <th scope="row"><code>{entry.puzzleId}</code></th>
                    <td>{puzzleMasteryPercent(entry)}%</td>
                    <td>{entry.solves}</td>
                    <td>{entry.cleanSolves}</td>
                    <td>{entry.hintsUsed}</td>
                    <td>{entry.incorrectMoves}</td>
                    <td>{entry.abandoned}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="transfer-panel" aria-labelledby="transfer-title">
        <div>
          <h2 id="transfer-title">Keep a portable copy</h2>
          <p>
            Storage mode: <strong>{repositoryKind === 'cloud' ? 'cloud account' : repositoryKind === 'artifact' ? 'personal Artifact storage' : 'session only'}</strong>.
            Exported JSON is versioned and strictly validated on import.
          </p>
        </div>
        <div className="transfer-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              downloadProgress(progress)
              onAnnouncement('Progress JSON export prepared.')
            }}
          >
            Export progress JSON
          </button>
          <label className="file-button">
            <span>Choose progress JSON</span>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              aria-invalid={importError ? true : undefined}
              aria-describedby={importError ? importErrorId : undefined}
              onChange={(event) => { void chooseImport(event) }}
            />
          </label>
        </div>
        {importError ? <p id={importErrorId} className="field-error" role="alert">{importError}</p> : null}
        {candidate ? (
          <div className="import-confirmation" role="group" aria-label="Confirm progress import">
            <p><strong>{fileName}</strong> is valid: {Object.keys(candidate.cards).length} cards, {candidate.streak.current}-day streak. Importing replaces current progress and settings.</p>
            <div className="inline-controls">
              <button
                ref={confirmImportRef}
                type="button"
                onClick={() => {
                  onImport(candidate)
                  setCandidate(null)
                  setFileName(null)
                  onAnnouncement('Progress and settings imported and queued for saving.')
                  queueMicrotask(() => importInputRef.current?.focus())
                }}
              >
                Replace current progress
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setCandidate(null)
                  setFileName(null)
                  queueMicrotask(() => importInputRef.current?.focus())
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="card-history" aria-labelledby="opening-progress-title">
        <h2 id="opening-progress-title">Opening progress</h2>
        {summaries.openings.length === 0 ? (
          <div className="resource-state empty-state">
            <span className="state-icon" aria-hidden="true">○</span>
            <h3>No opening progress yet</h3>
            <p>Complete a learner-position review to begin tracking an opening.</p>
          </div>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Opening progress, horizontally scrollable">
            <table className="stats-table">
              <caption>{summaries.openings.length} started {summaries.openings.length === 1 ? 'opening' : 'openings'}</caption>
              <thead>
                <tr><th scope="col">Opening</th><th scope="col">Mastery</th><th scope="col">Reviewed cards</th><th scope="col">Due now</th><th scope="col">Total cards</th><th scope="col">Streak</th><th scope="col">Last reviewed (UTC)</th></tr>
              </thead>
              <tbody>
                {summaries.openings.map((opening) => (
                  <tr key={opening.id}>
                    <th scope="row"><span>{opening.name}</span><br /><small>{opening.eco ?? 'Unknown ECO'}</small></th>
                    <td>{opening.mastery}%</td>
                    <td>{opening.reviewedCards}</td>
                    <td>{opening.dueCards}</td>
                    <td>{opening.totalCards}</td>
                    <td>{opening.streak} {opening.streak === 1 ? 'day' : 'days'}</td>
                    <td>{opening.lastReviewedAt ?? 'Not reviewed'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card-history" aria-labelledby="variation-progress-title">
        <h2 id="variation-progress-title">Training-side variation progress</h2>
        {summaries.variations.length === 0 ? (
          <p className="field-help">White- and Black-side variation totals appear after the first review in an opening.</p>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Training-side variation progress, horizontally scrollable">
            <table className="stats-table">
              <caption>{summaries.variations.length} trained-side {summaries.variations.length === 1 ? 'variation' : 'variations'} in started openings</caption>
              <thead>
                <tr><th scope="col">Opening / trained side</th><th scope="col">Mastery</th><th scope="col">Reviewed cards</th><th scope="col">Due now</th><th scope="col">Total cards</th><th scope="col">Streak</th><th scope="col">Last reviewed (UTC)</th></tr>
              </thead>
              <tbody>
                {summaries.variations.map((variation) => (
                  <tr key={variation.id}>
                    <th scope="row">{variationIdentity(variation)}</th>
                    <td>{variation.mastery}%</td>
                    <td>{variation.reviewedCards}</td>
                    <td>{variation.dueCards}</td>
                    <td>{variation.totalCards}</td>
                    <td>{variation.streak} {variation.streak === 1 ? 'day' : 'days'}</td>
                    <td>{variation.lastReviewedAt ?? 'Not reviewed'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card-history" aria-labelledby="card-history-title">
        <h2 id="card-history-title">Review history</h2>
        {cards.length === 0 ? (
          <div className="resource-state empty-state">
            <span className="state-icon" aria-hidden="true">○</span>
            <h3>No reviews yet</h3>
            <p>Start a line from Repertoire. New cards begin at 0% mastery.</p>
          </div>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Review card history, horizontally scrollable">
            <table className="stats-table">
              <caption>{cards.length} stored {cards.length === 1 ? 'card' : 'cards'}</caption>
              <thead>
                <tr><th scope="col">Variation / node</th><th scope="col">Mastery</th><th scope="col">Interval</th><th scope="col">Reviews</th><th scope="col">Lapses</th><th scope="col">Last reviewed (UTC)</th><th scope="col">Due (UTC)</th></tr>
              </thead>
              <tbody>
                {cards.map((card) => (
                  <tr key={card.cardId}>
                    <th scope="row">{variationIdentity(variationById.get(card.lineId))}<br /><code>{card.lineId}</code><br /><small>{card.nodeId}</small></th>
                    <td>{masteryPercent(card)}%</td>
                    <td>{card.intervalDays} {card.intervalDays === 1 ? 'day' : 'days'}</td>
                    <td>{card.reviewCount}</td>
                    <td>{card.lapseCount}</td>
                    <td>{card.lastReviewedAt ?? 'New'}</td>
                    <td>{card.dueAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

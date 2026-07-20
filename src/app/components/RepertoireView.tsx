import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { OpeningPartition, VerifiedLine } from '../../domain/opening-data.ts'
import type { OpeningVariantSummary } from '../../data/opening-data-source.ts'
import { EmptyState, ErrorState, LoadingState } from './ResourceState.tsx'

export interface RepertoirePartitionResource {
  status: 'idle' | 'loading' | 'ready' | 'error'
  value: OpeningPartition | null
  error: string | null
}

interface RepertoireViewProps {
  summaries: readonly OpeningVariantSummary[]
  partition: RepertoirePartitionResource
  selectedLineId: string | null
  selectedVariantId: string | null
  onSelectPack: (summary: OpeningVariantSummary) => void
  onSelectVariant: (variantId: string) => void
  onStartDrill: (line: VerifiedLine) => void
  onRetry: () => void
  graphTraining?: ReactNode
}

const PAGE_SIZE = 30

function packDepthLabel(cardCount: number): string {
  return cardCount >= 10 ? 'Extended line' : 'Primer'
}

export function RepertoireView({
  summaries,
  partition,
  selectedLineId,
  selectedVariantId,
  onSelectPack,
  onSelectVariant,
  onStartDrill,
  onRetry,
  graphTraining,
}: RepertoireViewProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [side, setSide] = useState<'all' | 'white' | 'black'>('all')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en-US')
    return summaries
      .filter((summary) => side === 'all' || summary.trainedSide === side)
      .filter((summary) => needle === '' || `${summary.eco} ${summary.name}`.toLocaleLowerCase('en-US').includes(needle))
      .sort((left, right) =>
        Number(right.cardCount >= 10) - Number(left.cardCount >= 10)
        || right.cardCount - left.cardCount
        || left.eco.localeCompare(right.eco, 'en')
        || left.name.localeCompare(right.name, 'en')
        || left.trainedSide.localeCompare(right.trainedSide, 'en')
      )
  }, [query, side, summaries])
  useEffect(() => setVisibleCount(PAGE_SIZE), [query, side])

  const selectedLine = partition.value?.lines.find((line) => line.sourceLineId === selectedLineId) ?? null
  const selectedVariants = partition.value?.verifiedLines
    .filter((line) => line.sourceLineId === selectedLineId)
    .sort((left, right) => right.nodes.length - left.nodes.length || left.trainedSide.localeCompare(right.trainedSide, 'en')) ?? []
  const selectedVariant = selectedVariants.find((variant) => variant.id === selectedVariantId)
    ?? selectedVariants.find((variant) => variant.drillEligible)
    ?? selectedVariants[0]
    ?? null

  return (
    <section className="repertoire-view" aria-labelledby="repertoire-title">
      <header className="repertoire-heading">
        <div>
          <p className="eyebrow">Practice library</p>
          <h1 id="repertoire-title">Repertoire</h1>
          <p>Choose a side and line, then practice every verified learner position in one continuous session.</p>
        </div>
        <dl className="repertoire-totals" aria-label="Repertoire totals">
          <div><dt>Training sides</dt><dd>{summaries.length.toLocaleString('en-US')}</dd></div>
          <div><dt>White</dt><dd>{summaries.filter((item) => item.trainedSide === 'white').length.toLocaleString('en-US')}</dd></div>
          <div><dt>Black</dt><dd>{summaries.filter((item) => item.trainedSide === 'black').length.toLocaleString('en-US')}</dd></div>
        </dl>
      </header>

      {graphTraining ? (
        <section className="repertoire-graph-entry" aria-labelledby="repertoire-graph-title">
          <div className="section-row">
            <div>
              <p className="eyebrow">Family practice</p>
              <h2 id="repertoire-graph-title">Complete repertoire graphs</h2>
            </div>
          </div>
          {graphTraining}
        </section>
      ) : null}

      <div className="repertoire-controls">
        <label>
          <span>Find a repertoire</span>
          <input
            type="search"
            maxLength={128}
            value={query}
            placeholder="Caro–Kann, B12, Queen's Gambit…"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <fieldset className="segmented-control">
          <legend>Training side</legend>
          {(['all', 'white', 'black'] as const).map((value) => (
            <label key={value}>
              <input type="radio" name="repertoire-side" value={value} checked={side === value} onChange={() => setSide(value)} />
              <span>{value === 'all' ? 'Both sides' : `Train ${value[0]?.toUpperCase()}${value.slice(1)}`}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <div className="repertoire-workspace">
        <section className="pack-library" aria-labelledby="pack-library-title">
          <div className="section-row">
            <h2 id="pack-library-title">Study lines</h2>
            <span>{filtered.length.toLocaleString('en-US')} matches</span>
          </div>
          {filtered.length === 0 ? <EmptyState title="No matching repertoires" detail="Try another name, ECO code, or training side." /> : (
            <div className="pack-grid" role="group" aria-label="Repertoire study lines">
              {filtered.slice(0, visibleCount).map((summary) => (
                <button
                  type="button"
                  className="pack-card"
                  data-selected={selectedLineId === summary.sourceLineId && selectedVariant?.trainedSide === summary.trainedSide || undefined}
                  aria-pressed={selectedLineId === summary.sourceLineId && selectedVariant?.trainedSide === summary.trainedSide}
                  key={summary.id}
                  onClick={() => onSelectPack(summary)}
                >
                  <span className="pack-card-topline"><span className="eco-pill">{summary.eco}</span><span>{packDepthLabel(summary.cardCount)}</span></span>
                  <strong>{summary.name}</strong>
                  <span>Train {summary.trainedSide} · {summary.cardCount} learner {summary.cardCount === 1 ? 'move' : 'moves'}</span>
                </button>
              ))}
            </div>
          )}
          {visibleCount < filtered.length ? (
            <button type="button" className="secondary-button load-more-button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, filtered.length - visibleCount)} more
            </button>
          ) : null}
        </section>

        <aside className="pack-syllabus" aria-labelledby="pack-syllabus-title">
          <p className="eyebrow">Selected syllabus</p>
          <h2 id="pack-syllabus-title">{selectedLine?.name ?? 'Choose a line'}</h2>
          {partition.status === 'loading' || partition.status === 'idle' ? <LoadingState label="Loading verified line…" /> : null}
          {partition.status === 'error' ? <ErrorState title="Repertoire unavailable" detail={partition.error ?? 'The repertoire partition could not be validated.'} onRetry={onRetry} /> : null}
          {partition.status === 'ready' && !selectedLine ? <EmptyState title="No line selected" detail="Choose a study line from the library." /> : null}
          {partition.status === 'ready' && selectedLine && selectedVariants.length === 0 ? (
            <div className="inline-warning" role="note">
              This taxonomy line is available to explore but has no released engine-verified training path.
            </div>
          ) : null}
          {selectedVariant ? (
            <>
              <p className="syllabus-summary">{selectedVariant.eco} · Train {selectedVariant.trainedSide} · terminal sample N={selectedVariant.terminalSampleSize.toLocaleString('en-US')}</p>
              <div className="syllabus-variants" role="group" aria-label="Verified training sides">
                {selectedVariants.map((variant) => (
                  <button
                    type="button"
                    aria-pressed={variant.id === selectedVariant.id}
                    key={variant.id}
                    onClick={() => onSelectVariant(variant.id)}
                  >
                    <span><strong>Train {variant.trainedSide}</strong><small>{variant.nodes.length} learner decisions</small></span>
                    <span className={`eligibility-badge ${variant.drillEligible ? 'eligible' : 'quarantined'}`}>
                      {variant.drillEligible ? 'Ready' : 'Held'}
                    </span>
                  </button>
                ))}
              </div>
              <ol className="syllabus-moves" aria-label="Learner move syllabus" tabIndex={0}>
                {selectedVariant.nodes.map((node, index) => {
                  const expected = node.moves.find((move) => move.uci === node.expectedMoveUci)
                  return <li key={node.id}><span>{index + 1}</span><strong>{expected?.san ?? node.expectedMoveUci}</strong><small>ply {node.ply + 1}</small></li>
                })}
              </ol>
              {selectedVariant.nodes.length < 10 ? (
                <p className="inline-warning" role="note">Primer depth. It will not be labeled Core until a verified path reaches ten learner decisions and the branch-coverage audit passes.</p>
              ) : null}
              <button
                type="button"
                className="primary-action"
                disabled={!selectedVariant.drillEligible}
                onClick={() => onStartDrill(selectedVariant)}
              >
                Practice this line
              </button>
            </>
          ) : null}
        </aside>
      </div>
    </section>
  )
}

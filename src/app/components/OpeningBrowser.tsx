import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import {
  INPUT_LIMITS,
  parseMoveSequence,
  parsePgnForSearch,
  searchOpenings,
  type OpeningSearchEntry,
  type OpeningSearchMatch,
} from '../../domain/input-validation.ts'
import type {
  OpeningCatalogEntry,
  OpeningPartition,
  VerifiedLine,
} from '../../domain/opening-data.ts'
import { EvidenceTable } from './EvidenceTable.tsx'
import { EmptyState, ErrorState, LoadingState } from './ResourceState.tsx'

export type SearchMode = 'text' | 'moves' | 'pgn'
type BrowsableLine = OpeningPartition['lines'][number]
type EcoVolumeCode = 'A' | 'B' | 'C' | 'D' | 'E'

const ECO_VOLUMES: ReadonlyArray<{ code: EcoVolumeCode; name: string }> = [
  { code: 'A', name: 'Flank openings' },
  { code: 'B', name: 'Semi-open games other than the French Defence' },
  { code: 'C', name: 'Open games and the French Defence' },
  { code: 'D', name: 'Closed and semi-closed games' },
  { code: 'E', name: 'Indian defences' },
]

function ecoVolumeFor(eco: string): EcoVolumeCode {
  const prefix = eco.slice(0, 1)
  return prefix === 'A' || prefix === 'B' || prefix === 'C' || prefix === 'D' || prefix === 'E'
    ? prefix
    : 'A'
}

export interface PartitionResource {
  status: 'idle' | 'loading' | 'ready' | 'error'
  value: OpeningPartition | null
  error: string | null
}

export interface OpeningBrowserProps {
  catalog: readonly OpeningCatalogEntry[]
  searchEntries: readonly OpeningSearchEntry[]
  selectedEco: string
  selectedLineId: string | null
  selectedVariantId: string | null
  partition: PartitionResource
  onSelectEco: (eco: string) => void
  onSelectLine: (lineId: string) => void
  onSelectVariant: (variantId: string) => void
  onSelectSearchResult: (match: OpeningSearchMatch) => void
  onOpenFamily: (sourceLineId: string) => void
  onRetryPartition: () => void
  onAnnouncement: (message: string) => void
}

function applyUci(chess: Chess, uci: string): string {
  const promotion = uci[4] as PieceSymbol | undefined
  const move = chess.move({
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    ...(promotion ? { promotion } : {}),
  })
  if (!move) throw new Error(`Illegal audited move ${uci}`)
  return move.san
}

function MoveList({ line }: { line: BrowsableLine }): React.JSX.Element {
  const moves = useMemo(() => {
    const chess = new Chess()
    return line.uci.map((uci, index) => ({ uci, san: applyUci(chess, uci), ply: index }))
  }, [line])
  const [focused, setFocused] = useState(0)
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => setFocused(0), [line.sourceLineId])
  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(0, index - 1)
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(moves.length - 1, index + 1)
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = moves.length - 1
    if (next === null) return
    event.preventDefault()
    setFocused(next)
    refs.current[next]?.focus()
  }
  return (
    <div className="move-list" role="listbox" aria-label="Opening moves; use arrow keys to navigate">
      {moves.map((move, index) => (
        <button
          ref={(node) => { refs.current[index] = node }}
          type="button"
          role="option"
          aria-selected={focused === index}
          tabIndex={focused === index ? 0 : -1}
          key={`${move.ply}-${move.uci}`}
          onFocus={() => setFocused(index)}
          onKeyDown={(event) => handleKey(event, index)}
        >
          <span className="move-number">{move.ply % 2 === 0 ? `${Math.floor(move.ply / 2) + 1}.` : '…'}</span>
          <span>{move.san}</span>
        </button>
      ))}
    </div>
  )
}

function SearchPanel({
  entries,
  onSelect,
  announce,
}: {
  entries: readonly OpeningSearchEntry[]
  onSelect: (match: OpeningSearchMatch) => void
  announce: (message: string) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<SearchMode>('text')
  const [value, setValue] = useState('')
  const [results, setResults] = useState<OpeningSearchMatch[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const updateValue = (next: string): void => {
    setValue(next)
    setError(null)
    setResults(null)
  }

  const submit = (): void => {
    setError(null)
    try {
      const matches = mode === 'text'
        ? searchOpenings(entries, value)
        : searchOpenings(entries, '', mode === 'moves' ? parseMoveSequence(value) : parsePgnForSearch(value))
      setResults(matches)
      announce(matches.length === 0 ? 'No opening matches found.' : `${matches.length} opening matches found.`)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Search could not be parsed.'
      setError(message)
      setResults(null)
    }
  }

  const inputId = `opening-search-${mode}`
  return (
    <section className="search-panel" aria-labelledby="opening-search-title">
      <div className="section-heading-row">
        <div>
          <p className="eyebrow">Audited repertoire</p>
          <h2 id="opening-search-title">Find an opening</h2>
        </div>
      </div>
      <fieldset className="segmented-control">
        <legend className="sr-only">Search input type</legend>
        {(['text', 'moves', 'pgn'] as const).map((option) => (
          <label key={option}>
            <input
              type="radio"
              name="search-mode"
              value={option}
              checked={mode === option}
              onChange={() => {
                setMode(option)
                setValue('')
                setResults(null)
                setError(null)
              }}
            />
            <span>{option === 'text' ? 'Name / ECO' : option === 'moves' ? 'Moves' : 'PGN'}</span>
          </label>
        ))}
      </fieldset>
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label htmlFor={inputId}>
          {mode === 'text' ? 'Search by opening name, ECO, SAN, or UCI' : mode === 'moves' ? 'Paste a SAN or UCI move sequence' : 'Paste a Standard-chess PGN'}
        </label>
        {mode === 'pgn' ? (
          <textarea
            id={inputId}
            rows={5}
            maxLength={INPUT_LIMITS.pgnBytes}
            value={value}
            onChange={(event) => updateValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                submit()
              }
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${inputId}-help${error ? ` ${inputId}-error` : ''}`}
          />
        ) : (
          <input
            id={inputId}
            type="search"
            maxLength={mode === 'text' ? INPUT_LIMITS.searchCharacters : INPUT_LIMITS.moveSequenceCharacters}
            value={value}
            onChange={(event) => updateValue(event.currentTarget.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${inputId}-help${error ? ` ${inputId}-error` : ''}`}
          />
        )}
        <p id={`${inputId}-help`} className="field-help">
          {mode === 'pgn' ? 'Maximum 32 KB, 200 plies, and 64 headers. Press Control or Command + Enter to search. This search never changes the audited repertoire.' : 'Input is validated before it is parsed.'}
        </p>
        {error ? <p id={`${inputId}-error`} className="field-error" role="alert">{error}</p> : null}
        <button type="submit" disabled={value.trim() === ''}>Search openings</button>
      </form>
      {results !== null ? (
        <div className="search-results">
          <h2>Search results <span className="count-badge">{results.length}</span></h2>
          {results.length === 0 ? <p>No audited opening matches found.</p> : (
            <ul className="result-list">
              {results.map((match) => (
                <li key={match.sourceLineId}>
                  <button type="button" onClick={() => onSelect(match)}>
                    <span className="eco-pill">{match.eco}</span>
                    <span><strong>{match.name}</strong><small>{match.matchKind.replaceAll('_', ' ')} · N={match.terminalSampleSize.toLocaleString('en-US')}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  )
}

function EcoRail({
  catalog,
  selectedEco,
  onSelect,
}: {
  catalog: readonly OpeningCatalogEntry[]
  selectedEco: string
  onSelect: (eco: string) => void
}): React.JSX.Element {
  const tabGroupId = useId()
  const filterId = `${tabGroupId}-filter`
  const [filter, setFilter] = useState('')
  const [activeVolume, setActiveVolume] = useState<EcoVolumeCode>(() => ecoVolumeFor(selectedEco))
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const volumeRefs = useRef(new Map<EcoVolumeCode, HTMLButtonElement>())
  const volumeCatalog = useMemo(() => new Map(ECO_VOLUMES.map((volume) => [
    volume.code,
    catalog.filter((entry) => entry.eco.startsWith(volume.code)),
  ])), [catalog])
  useEffect(() => {
    setActiveVolume(ecoVolumeFor(selectedEco))
    // A selection can arrive from the global search rather than this filtered
    // rail. Clear a stale local filter so the newly selected ECO is visible,
    // selected, and the roving tab stop describes the same state as detail.
    setFilter('')
  }, [selectedEco])
  const activeVolumeMetadata = ECO_VOLUMES.find((volume) => volume.code === activeVolume) ?? ECO_VOLUMES[0]!
  const activeCatalog = volumeCatalog.get(activeVolume) ?? []
  const visible = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase('en-US')
    if (needle === '') return activeCatalog
    return activeCatalog.filter((entry) => `${entry.eco} ${entry.names.join(' ')}`.toLocaleLowerCase('en-US').includes(needle))
  }, [activeCatalog, filter])
  const rovingEco = visible.some((entry) => entry.eco === selectedEco)
    ? selectedEco
    : visible[0]?.eco
  const selectVolumeByIndex = (index: number): void => {
    const volume = ECO_VOLUMES[index]
    if (!volume) return
    setActiveVolume(volume.code)
    queueMicrotask(() => volumeRefs.current.get(volume.code)?.focus())
  }
  const handleVolumeKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = (index - 1 + ECO_VOLUMES.length) % ECO_VOLUMES.length
    if (event.key === 'ArrowRight') next = (index + 1) % ECO_VOLUMES.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = ECO_VOLUMES.length - 1
    if (next === null) return
    event.preventDefault()
    selectVolumeByIndex(next)
  }
  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = Math.max(0, index - 1)
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = Math.min(visible.length - 1, index + 1)
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = visible.length - 1
    if (next === null) return
    event.preventDefault()
    const entry = visible[next]
    if (entry) refs.current.get(entry.eco)?.focus()
  }
  return (
    <aside className="eco-rail" aria-labelledby="eco-browser-title">
      <h2 id="eco-browser-title">ECO codes</h2>
      <div className="eco-volume-tabs" role="tablist" aria-label="ECO volumes" aria-orientation="horizontal">
        {ECO_VOLUMES.map((volume, index) => {
          const count = volumeCatalog.get(volume.code)?.length ?? 0
          return (
            <button
              ref={(node) => {
                if (node) volumeRefs.current.set(volume.code, node)
                else volumeRefs.current.delete(volume.code)
              }}
              type="button"
              role="tab"
              id={`${tabGroupId}-tab-${volume.code}`}
              aria-controls={`${tabGroupId}-panel-${volume.code}`}
              aria-selected={activeVolume === volume.code}
              aria-label={`${volume.code} ${count} — Volume ${volume.code}: ${volume.name} (${count} ECO codes)`}
              tabIndex={activeVolume === volume.code ? 0 : -1}
              key={volume.code}
              onKeyDown={(event) => handleVolumeKey(event, index)}
              onClick={() => setActiveVolume(volume.code)}
            >
              <span className="eco-volume-code" aria-hidden="true">{volume.code}</span>
              <span className="eco-volume-count" aria-hidden="true">{count}</span>
            </button>
          )
        })}
      </div>
      {ECO_VOLUMES.map((volume) => (
        <div
          role="tabpanel"
          id={`${tabGroupId}-panel-${volume.code}`}
          aria-labelledby={`${tabGroupId}-tab-${volume.code}`}
          hidden={activeVolume !== volume.code}
          key={volume.code}
        >
          {activeVolume === volume.code ? (
            <>
              <p className="eco-volume-summary">
                <strong>Volume {activeVolumeMetadata.code}</strong>
                <span>{activeVolumeMetadata.name} · {activeCatalog.length} ECO codes</span>
              </p>
              <label htmlFor={filterId} className="sr-only">Filter ECO codes</label>
              <input
                id={filterId}
                type="search"
                maxLength={128}
                placeholder={`Filter ${activeCatalog.length} codes`}
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value)}
              />
              <div className="eco-list" role="listbox" aria-label="ECO opening codes">
                {visible.map((entry, index) => (
                  <button
                    ref={(node) => {
                      if (node) refs.current.set(entry.eco, node)
                      else refs.current.delete(entry.eco)
                    }}
                    type="button"
                    role="option"
                    aria-selected={entry.eco === selectedEco}
                    tabIndex={entry.eco === rovingEco ? 0 : -1}
                    key={entry.eco}
                    onKeyDown={(event) => handleKey(event, index)}
                    onClick={() => onSelect(entry.eco)}
                  >
                    <span className="eco-pill">{entry.eco}</span>
                    <span className="eco-copy"><strong>{entry.names[0]}</strong><small>{entry.lineCount} {entry.lineCount === 1 ? 'line' : 'lines'} · {entry.drillableVariantCount} historical side records</small></span>
                  </button>
                ))}
              </div>
              {visible.length === 0 ? <p className="field-help">No ECO codes match that filter.</p> : null}
            </>
          ) : null}
        </div>
      ))}
    </aside>
  )
}

function LineDetail({
  line,
  variants,
  selectedVariantId,
  onSelectVariant,
  onOpenFamily,
}: {
  line: BrowsableLine
  variants: readonly VerifiedLine[]
  selectedVariantId: string | null
  onSelectVariant: (variantId: string) => void
  onOpenFamily: (sourceLineId: string) => void
}): React.JSX.Element {
  const tabGroupId = useId()
  const variantRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedVariant = variants.find((variant) => variant.id === selectedVariantId)
    ?? variants.find((variant) => variant.drillEligible)
    ?? variants[0]
    ?? null
  const selectedVariantIndex = selectedVariant
    ? variants.findIndex((variant) => variant.id === selectedVariant.id)
    : -1
  const selectVariantByIndex = (index: number): void => {
    const variant = variants[index]
    if (!variant) return
    onSelectVariant(variant.id)
    queueMicrotask(() => variantRefs.current[index]?.focus())
  }
  const handleVariantKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + variants.length) % variants.length
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % variants.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = variants.length - 1
    if (next === null) return
    event.preventDefault()
    selectVariantByIndex(next)
  }
  return (
    <article className="line-detail" aria-labelledby="line-detail-title">
      <div className="line-title-row">
        <div>
          <p className="eyebrow"><span className="eco-pill">{line.eco}</span> Backtested line</p>
          <h2 id="line-detail-title">{line.name}</h2>
        </div>
        <span className={`eligibility-badge ${line.backtestEligible ? 'eligible' : 'insufficient'}`}>
          <span aria-hidden="true">{line.backtestEligible ? '✓' : '⚠'}</span>
          {line.backtestEligible ? 'N≥500' : 'Insufficient sample'}
        </span>
      </div>
      <p className="pgn-line"><span className="sr-only">Moves: </span>{line.pgn}</p>
      <MoveList line={line} />
      <p className="sample-summary">Terminal-position sample: <strong>{line.terminalSampleSize.toLocaleString('en-US')} games</strong>.</p>

      {variants.length > 0 ? (
        <section className="variant-section" aria-labelledby="verified-variants-title">
          <h3 id="verified-variants-title">Historical side evidence</h3>
          <p className="field-help">These archived side records are available for comparison. Practice uses the canonical family graph.</p>
          <div className="variant-tabs" role="tablist" aria-label="Historical side evidence">
            {variants.map((variant, index) => (
              <button
                ref={(node) => { variantRefs.current[index] = node }}
                type="button"
                role="tab"
                id={`${tabGroupId}-tab-${index}`}
                aria-controls={`${tabGroupId}-panel`}
                aria-selected={selectedVariant?.id === variant.id}
                tabIndex={selectedVariant?.id === variant.id ? 0 : -1}
                key={variant.id}
                onKeyDown={(event) => handleVariantKey(event, index)}
                onClick={() => onSelectVariant(variant.id)}
              >
                {variant.trainedSide === 'white' ? 'White perspective' : 'Black perspective'}
              </button>
            ))}
          </div>
          {selectedVariant ? (
            <div
              className="variant-detail"
              role="tabpanel"
              id={`${tabGroupId}-panel`}
              aria-labelledby={`${tabGroupId}-tab-${selectedVariantIndex}`}
            >
              <div className="status-row">
                <span className={`eligibility-badge ${selectedVariant.drillEligible ? 'eligible' : 'quarantined'}`}>
                  <span aria-hidden="true">{selectedVariant.drillEligible ? '✓' : '⊘'}</span>
                  {selectedVariant.drillEligible ? 'Historical check passed' : 'Historical record quarantined'}
                </span>
                <span>Scid cross-check: {selectedVariant.crosscheckStatus.replaceAll('_', ' ')}</span>
              </div>
              {selectedVariant.quarantineReasons.length > 0 ? (
                <div className="inline-warning" role="note"><strong>Not released for practice:</strong> {selectedVariant.quarantineReasons.join(' ')}</div>
              ) : null}
              <EvidenceTable bands={selectedVariant.terminalStats} caption={`${selectedVariant.trainedSide} trained-side terminal results`} />
            </div>
          ) : null}
        </section>
      ) : (
        <div className="inline-warning" role="note">
          {line.backtestEligible
            ? 'This line has enough historical games to browse, but no side-specific record is included in this historical snapshot.'
            : 'This line does not meet the N=500 terminal-position threshold. Its evidence remains available for reference.'}
        </div>
      )}

      <button
        type="button"
        className="primary-action"
        onClick={() => onOpenFamily(line.sourceLineId)}
      >
        Open opening family
      </button>

      <details className="terminal-stats-details">
        <summary>All terminal results for both sides</summary>
        <EvidenceTable bands={line.terminalWhiteStats} caption="White perspective" compact />
        <EvidenceTable bands={line.terminalBlackStats} caption="Black perspective" compact />
      </details>
    </article>
  )
}

export function OpeningBrowser(props: OpeningBrowserProps): React.JSX.Element {
  const partition = props.partition.value
  const historicallyVerifiedSourceIds = useMemo(() => new Set(
    partition?.verifiedLines
      .filter((line) => line.drillEligible)
      .map((line) => line.sourceLineId) ?? [],
  ), [partition])
  const orderedLines = useMemo(() => [...(partition?.lines ?? [])].sort((left, right) => {
    const verifiedDifference = Number(historicallyVerifiedSourceIds.has(right.sourceLineId)) - Number(historicallyVerifiedSourceIds.has(left.sourceLineId))
    if (verifiedDifference !== 0) return verifiedDifference
    const eligibleDifference = Number(right.backtestEligible) - Number(left.backtestEligible)
    if (eligibleDifference !== 0) return eligibleDifference
    return left.name.localeCompare(right.name, 'en') || left.sourceLineId.localeCompare(right.sourceLineId, 'en')
  }), [historicallyVerifiedSourceIds, partition])
  const selectedLine = partition?.lines.find((line) => line.sourceLineId === props.selectedLineId) ?? orderedLines[0] ?? null
  const variants = selectedLine
    ? partition?.verifiedLines.filter((line) => line.sourceLineId === selectedLine.sourceLineId) ?? []
    : []
  const lineRefs = useRef(new Map<string, HTMLButtonElement>())
  const handleLineKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = Math.max(0, index - 1)
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = Math.min(orderedLines.length - 1, index + 1)
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = orderedLines.length - 1
    if (next === null) return
    const line = orderedLines[next]
    if (!line) return
    event.preventDefault()
    props.onSelectLine(line.sourceLineId)
    queueMicrotask(() => lineRefs.current.get(line.sourceLineId)?.focus())
  }
  return (
    <div className="browser-view">
      <SearchPanel entries={props.searchEntries} onSelect={props.onSelectSearchResult} announce={props.onAnnouncement} />
      <div className="browser-workspace">
        <EcoRail catalog={props.catalog} selectedEco={props.selectedEco} onSelect={props.onSelectEco} />
        <section className="opening-lines" aria-labelledby="opening-lines-title">
          <h2 id="opening-lines-title">{props.selectedEco} lines</h2>
          {props.partition.status === 'loading' || props.partition.status === 'idle' ? <LoadingState label={`Loading ${props.selectedEco} opening data…`} /> : null}
          {props.partition.status === 'error' ? (
            <ErrorState title="Opening partition could not be loaded" detail={props.partition.error ?? 'The embedded data did not pass validation.'} onRetry={props.onRetryPartition} />
          ) : null}
          {props.partition.status === 'ready' && partition?.lines.length === 0 ? (
            <EmptyState title="No opening lines" detail="The validated partition is empty." />
          ) : null}
          {props.partition.status === 'ready' && partition && partition.lines.length > 0 ? (
            <div className="lines-and-detail">
              <div className="line-list" role="listbox" aria-label={`${props.selectedEco} opening lines`}>
                {orderedLines.map((line, index) => (
                  <button
                    ref={(node) => {
                      if (node) lineRefs.current.set(line.sourceLineId, node)
                      else lineRefs.current.delete(line.sourceLineId)
                    }}
                    type="button"
                    role="option"
                    aria-selected={line.sourceLineId === selectedLine?.sourceLineId}
                    tabIndex={line.sourceLineId === selectedLine?.sourceLineId ? 0 : -1}
                    key={line.sourceLineId}
                    onKeyDown={(event) => handleLineKey(event, index)}
                    onClick={() => props.onSelectLine(line.sourceLineId)}
                  >
                    <strong>{line.name}</strong>
                    <small>N={line.terminalSampleSize.toLocaleString('en-US')} · {line.backtestEligible ? `${line.verifiedVariantIds.length} side records` : 'below threshold'}</small>
                  </button>
                ))}
              </div>
              {selectedLine ? (
                <LineDetail
                  line={selectedLine}
                  variants={variants}
                  selectedVariantId={props.selectedVariantId}
                  onSelectVariant={props.onSelectVariant}
                  onOpenFamily={props.onOpenFamily}
                />
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}

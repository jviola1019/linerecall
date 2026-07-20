import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Square } from 'chess.js'
import { applyLegalMove, type BoardOrientation } from '../../domain/board.ts'
import {
  type BoardAnnotation,
  type BoardAnnotationTone,
} from '../../domain/board-annotations.ts'
import {
  OPENING_PUZZLE_LIMITATION,
  createPuzzleAttemptContext,
  gradePuzzleMove,
  markPuzzleHintUsed,
  safeParseOpeningPuzzleList,
  type OpeningPuzzle,
  type PuzzleAttemptContext,
  type PuzzleMoveResult,
} from '../../domain/opening-puzzles.ts'
import { BoardAnnotationOverlay, BoardAnnotationPanel } from './BoardAnnotations.tsx'
import { ChessBoard, moveStatusPresentation } from './ChessBoard.tsx'
import { MoveComparison } from './EvidenceTable.tsx'
import { EmptyState, ErrorState, LoadingState } from './ResourceState.tsx'
import './puzzle.css'

export type PuzzleResource =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; puzzles: readonly OpeningPuzzle[] }

export interface PuzzleSolvedEvent {
  puzzle: OpeningPuzzle
  result: PuzzleMoveResult
  context: PuzzleAttemptContext
}

export interface PuzzleViewProps {
  resource: PuzzleResource
  orientation: BoardOrientation
  onSetOrientation: (orientation: BoardOrientation) => void
  reducedMotion?: boolean
  onRetry: () => void
  onSolved?: (event: PuzzleSolvedEvent) => void
  onCompleted?: (events: readonly PuzzleSolvedEvent[]) => void
  onExit?: () => void
  onAnnouncement?: (message: string) => void
  autoAdvanceMs?: number
}

const DEFAULT_AUTO_ADVANCE_MS = 2_200

function engineScoreLabel(score: OpeningPuzzle['engineVariations'][number]['score']): string {
  if (score.kind === 'mate') return `Mate ${score.value > 0 ? `+${score.value}` : score.value}`
  const pawns = score.value / 100
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`
}

function expectedEvidence(puzzle: OpeningPuzzle): OpeningPuzzle['moves'][number] {
  const evidence = puzzle.moves.find((move) => move.expected && move.uci === puzzle.expectedMoveUci)
  if (!evidence) throw new Error('The validated puzzle has no expected move evidence')
  return evidence
}

function sanContinuation(fen: string, movesUci: readonly string[]): string {
  let currentFen = fen
  const san: string[] = []
  for (const moveUci of movesUci) {
    const move = applyLegalMove(currentFen, moveUci)
    san.push(move.san)
    currentFen = move.fen
  }
  return san.join(' ')
}

function hintAnnotation(puzzle: OpeningPuzzle): BoardAnnotation {
  return {
    kind: 'arrow',
    from: puzzle.expectedMoveUci.slice(0, 2) as Square,
    to: puzzle.expectedMoveUci.slice(2, 4) as Square,
    tone: 'study',
  }
}

function resultHeading(result: PuzzleMoveResult): { icon: string; label: string } {
  if (result.verdict === 'solved') {
    return { icon: '✓', label: 'Recalled' }
  }
  const presentation = moveStatusPresentation(result.classification)
  return { icon: presentation.icon, label: presentation.label }
}

function PuzzleEvidence({
  puzzle,
  result,
  hintVisible,
}: {
  puzzle: OpeningPuzzle
  result: PuzzleMoveResult | null
  hintVisible: boolean
}): React.JSX.Element {
  const expected = expectedEvidence(puzzle)
  const analysisLines = useMemo(() => puzzle.engineVariations.map((variation) => ({
    variation,
    san: sanContinuation(puzzle.fen, variation.movesUci),
  })), [puzzle])
  if (!result && !hintVisible) {
    return (
      <div className="puzzle-prompt">
        <span className="puzzle-prompt-mark" aria-hidden="true">?</span>
        <h2>Find the repertoire move</h2>
        <p>Play directly on the board or use the equivalent legal-move picker. Feedback and grading happen automatically.</p>
      </div>
    )
  }

  const heading = result ? resultHeading(result) : { icon: '→', label: 'Hint shown' }
  return (
    <div
      className="puzzle-feedback"
      data-verdict={result?.classification ?? 'hint'}
    >
      <div className="puzzle-feedback-heading">
        <span className="puzzle-verdict-icon" aria-hidden="true">{heading.icon}</span>
        <div>
          <p className="eyebrow">Move feedback</p>
          <h2>{heading.label}</h2>
        </div>
        {result?.autoGrade ? (
          <span className="puzzle-auto-grade">Auto-grade: <strong>{result.autoGrade}</strong></span>
        ) : null}
      </div>
      <p>{result?.message ?? `Study arrow shown for ${expected.san} (${expected.uci}).`}</p>

      <dl className="puzzle-evidence-facts">
        <div><dt>Repertoire</dt><dd>{expected.san} · {expected.uci}</dd></div>
        <div><dt>Games</dt><dd>{expected.sampleSize.toLocaleString('en-US')}</dd></div>
        <div><dt>Stored difference</dt><dd>{expected.centipawnLoss === null ? 'Not recorded' : `${expected.centipawnLoss} cp`}</dd></div>
        <div><dt>Engine evidence</dt><dd>{puzzle.engineVariations.length} stored line{puzzle.engineVariations.length === 1 ? '' : 's'}</dd></div>
      </dl>

      {result ? <MoveComparison played={result.evidence} expected={expected} /> : null}

      <details className="puzzle-analysis" open={result?.verdict === 'solved'}>
        <summary>Stored continuation analysis ({puzzle.engineVariations.length})</summary>
        <p className="field-help">
          Scores and UCI moves are reproduced from the audited offline Stockfish record. They are evidence, not generated coaching prose.
        </p>
        <ol aria-label="Stored engine continuation lines">
          {analysisLines.map(({ variation, san }) => (
            <li key={`${variation.multipv}:${variation.movesUci.join('-')}`}>
              <div className="puzzle-analysis-meta">
                <strong>Line {variation.multipv}</strong>
                <span>{engineScoreLabel(variation.score)}</span>
                <span>{variation.bound} bound</span>
                <span>{variation.nodes === null ? 'nodes not recorded' : `${variation.nodes.toLocaleString('en-US')} nodes`}</span>
              </div>
              <code>{san}</code>
              <small>UCI: {variation.movesUci.join(' ')}</small>
            </li>
          ))}
        </ol>
      </details>
    </div>
  )
}

function ReadyPuzzleSession({
  puzzles,
  orientation,
  onSetOrientation,
  onSolved,
  onCompleted,
  onExit,
  onAnnouncement,
  autoAdvanceMs,
  reducedMotion,
}: {
  puzzles: readonly OpeningPuzzle[]
  orientation: BoardOrientation
  onSetOrientation: (orientation: BoardOrientation) => void
  onSolved: ((event: PuzzleSolvedEvent) => void) | undefined
  onCompleted: ((events: readonly PuzzleSolvedEvent[]) => void) | undefined
  onExit: (() => void) | undefined
  onAnnouncement: ((message: string) => void) | undefined
  autoAdvanceMs: number
  reducedMotion: boolean
}): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [attempt, setAttempt] = useState<PuzzleAttemptContext>(() => createPuzzleAttemptContext())
  const [result, setResult] = useState<PuzzleMoveResult | null>(null)
  const [hintVisible, setHintVisible] = useState(false)
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotations, setAnnotations] = useState<BoardAnnotation[]>([])
  const [annotationTone, setAnnotationTone] = useState<BoardAnnotationTone>('study')
  const [flowMode, setFlowMode] = useState(true)
  const [completed, setCompleted] = useState(false)
  const [events, setEvents] = useState<PuzzleSolvedEvent[]>([])
  const [announcement, setAnnouncement] = useState('')
  const annotationButtonRef = useRef<HTMLButtonElement>(null)
  const completionHeadingRef = useRef<HTMLHeadingElement>(null)
  const puzzle = puzzles[index]

  if (!puzzle) throw new Error('Puzzle session index is outside the validated puzzle list')

  const announce = useCallback((message: string): void => {
    if (onAnnouncement) onAnnouncement(message)
    else setAnnouncement(message)
  }, [onAnnouncement])

  const systemAnnotations = useMemo<BoardAnnotation[]>(
    () => hintVisible ? [hintAnnotation(puzzle)] : [],
    [hintVisible, puzzle],
  )

  const displayedFen = useMemo(() => {
    if (result?.verdict !== 'solved') return puzzle.fen
    return applyLegalMove(puzzle.fen, result.moveUci).fen
  }, [puzzle.fen, result])

  const advance = useCallback((): void => {
    if (index >= puzzles.length - 1) {
      setCompleted(true)
      announce(`Puzzle set complete. ${events.length} positions recalled.`)
      onCompleted?.(events)
      return
    }
    setIndex((current) => current + 1)
    setAttempt(createPuzzleAttemptContext())
    setResult(null)
    setHintVisible(false)
    setAnnotationMode(false)
    setAnnotations([])
    announce(`Puzzle ${index + 2} of ${puzzles.length}.`)
  }, [announce, events, index, onCompleted, puzzles.length])

  useEffect(() => {
    if (result?.verdict !== 'solved' || !flowMode || completed) return
    const timer = globalThis.setTimeout(advance, autoAdvanceMs)
    return () => globalThis.clearTimeout(timer)
  }, [advance, autoAdvanceMs, completed, flowMode, result?.verdict])

  useEffect(() => {
    if (completed) queueMicrotask(() => completionHeadingRef.current?.focus())
  }, [completed])

  const handleMove = (uci: string): void => {
    if (result?.verdict === 'solved') return
    const nextResult = gradePuzzleMove(puzzle, uci, attempt)
    setResult(nextResult)
    setAttempt(nextResult.nextContext)
    announce(nextResult.message)
    if (nextResult.verdict !== 'solved') return
    const solvedEvent = { puzzle, result: nextResult, context: nextResult.nextContext }
    setEvents((current) => [...current, solvedEvent])
    onSolved?.(solvedEvent)
  }

  const showHint = (): void => {
    const nextAttempt = markPuzzleHintUsed(attempt)
    setAttempt(nextAttempt)
    setHintVisible(true)
    const expected = expectedEvidence(puzzle)
    announce(`Hint shown. Study arrow from ${puzzle.expectedMoveUci.slice(0, 2)} to ${puzzle.expectedMoveUci.slice(2, 4)} for ${expected.san}.`)
  }

  const restart = (): void => {
    setIndex(0)
    setAttempt(createPuzzleAttemptContext())
    setResult(null)
    setHintVisible(false)
    setAnnotationMode(false)
    setAnnotations([])
    setEvents([])
    setCompleted(false)
    announce(`Puzzle set restarted. Puzzle 1 of ${puzzles.length}.`)
  }

  if (completed) {
    const good = events.filter((event) => event.result.autoGrade === 'good').length
    const hard = events.filter((event) => event.result.autoGrade === 'hard').length
    const again = events.filter((event) => event.result.autoGrade === 'again').length
    return (
      <section className="puzzle-completion" aria-labelledby="puzzle-completion-title">
        <span className="completion-mark" aria-hidden="true">✓</span>
        <p className="eyebrow">Opening recall complete</p>
        <h2 ref={completionHeadingRef} id="puzzle-completion-title" tabIndex={-1}>{events.length} positions reviewed</h2>
        <p>Grades were assigned from your attempts automatically: {good} good, {hard} hard, {again} again.</p>
        <div className="inline-controls">
          <button type="button" onClick={restart}>Run this set again</button>
          {onExit ? <button type="button" className="secondary-button" onClick={onExit}>Return to openings</button> : null}
        </div>
        {!onAnnouncement ? <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p> : null}
      </section>
    )
  }

  const lastMove = result
    ? { uci: result.moveUci, status: result.classification }
    : null

  return (
    <section className="puzzle-view" aria-labelledby="puzzle-title">
      <header className="puzzle-header">
        <div>
          <p className="eyebrow">Opening recall · {puzzle.eco}</p>
          <h2 id="puzzle-title">{puzzle.openingName}</h2>
          <p>Play for {puzzle.trainedSide}. Position {index + 1} of {puzzles.length}.</p>
        </div>
        <div className="puzzle-header-actions">
          <label className="puzzle-flow-toggle">
            <input
              type="checkbox"
              checked={flowMode}
              onChange={(event) => setFlowMode(event.currentTarget.checked)}
            />
            Continue automatically after a correct move
          </label>
          {onExit ? <button type="button" className="text-button" onClick={onExit}>Exit puzzles</button> : null}
        </div>
      </header>

      <progress
        className="puzzle-progress-track"
        aria-label="Puzzle set progress"
        max={puzzles.length}
        value={index + (result?.verdict === 'solved' ? 1 : 0)}
      >
        {index + (result?.verdict === 'solved' ? 1 : 0)} of {puzzles.length}
      </progress>

      <details className="puzzle-limitation">
        <summary><strong>Dataset scope</strong><span>Opening recall—not an unverified tactics corpus</span></summary>
        <p>{OPENING_PUZZLE_LIMITATION}</p>
      </details>

      <div className="puzzle-workspace">
        <div className="puzzle-board-column">
          <div className="puzzle-board-toolbar">
            <span>Board input</span>
            <div className="inline-controls">
              <button
                type="button"
                className="secondary-button"
                onClick={() => onSetOrientation(orientation === 'white' ? 'black' : 'white')}
              >
                Flip board
              </button>
              <button
                ref={annotationButtonRef}
                type="button"
                className="secondary-button"
                aria-pressed={annotationMode}
                onClick={() => {
                  setAnnotationMode((current) => !current)
                  announce(annotationMode ? 'Annotation mode closed.' : 'Annotation mode opened. Board move input is paused.')
                }}
              >
                {annotationMode ? 'Resume moves' : 'Annotate'}
              </button>
            </div>
          </div>
          <ChessBoard
            fen={displayedFen}
            orientation={orientation}
            disabled={annotationMode || result?.verdict === 'solved'}
            reducedMotion={reducedMotion}
            hintUci={hintVisible ? puzzle.expectedMoveUci : null}
            lastMove={lastMove}
            boardOverlay={(
              <BoardAnnotationOverlay
                annotations={annotations}
                systemAnnotations={systemAnnotations}
                orientation={orientation}
                editing={annotationMode}
                tone={annotationTone}
                onChange={setAnnotations}
                onAnnouncement={announce}
                onExitEditing={() => {
                  setAnnotationMode(false)
                  queueMicrotask(() => annotationButtonRef.current?.focus())
                }}
              />
            )}
            onMove={handleMove}
            onAnnouncement={announce}
          />
          <div className="puzzle-board-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={hintVisible || result?.verdict === 'solved'}
              onClick={showHint}
            >
              {hintVisible ? 'Hint shown' : 'Show hint'}
            </button>
            {result?.verdict === 'solved' ? (
              <button type="button" onClick={advance}>Next position</button>
            ) : null}
          </div>
        </div>

        <div className="puzzle-side-column">
          <PuzzleEvidence puzzle={puzzle} result={result} hintVisible={hintVisible} />
          <BoardAnnotationPanel
            annotations={annotations}
            systemAnnotations={systemAnnotations}
            orientation={orientation}
            editing={annotationMode}
            tone={annotationTone}
            onToneChange={setAnnotationTone}
            onChange={setAnnotations}
            onAnnouncement={announce}
          />
        </div>
      </div>

      <section className="puzzle-session-log" aria-labelledby="puzzle-session-log-title">
        <h2 id="puzzle-session-log-title">This set</h2>
        {events.length === 0 ? <p>No positions completed yet.</p> : (
          <ol aria-label="Completed puzzle grades">
            {events.map((event, eventIndex) => (
              <li key={event.puzzle.id}>
                <span>Position {eventIndex + 1}: {expectedEvidence(event.puzzle).san}</span>
                <strong>{event.result.autoGrade}</strong>
              </li>
            ))}
          </ol>
        )}
      </section>

      {!onAnnouncement ? <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p> : null}
    </section>
  )
}

export function PuzzleView({
  resource,
  orientation,
  onSetOrientation,
  onRetry,
  onSolved,
  onCompleted,
  onExit,
  onAnnouncement,
  reducedMotion = false,
  autoAdvanceMs = DEFAULT_AUTO_ADVANCE_MS,
}: PuzzleViewProps): React.JSX.Element {
  const frame = (content: React.JSX.Element): React.JSX.Element => (
    <section className="puzzles-route" aria-labelledby="puzzles-route-title">
      <header className="puzzles-route-header">
        <p className="eyebrow">Opening positions</p>
        <h1 id="puzzles-route-title">Puzzles</h1>
        <p>Review the validated positions available in this candidate. Puzzle progress stays separate from opening recall.</p>
      </header>
      {content}
    </section>
  )

  if (resource.status === 'idle') {
    return frame(<EmptyState title="Choose a verified opening" detail="Select a drill-eligible variation to create opening-recall puzzles from its audited learner positions." />)
  }
  if (resource.status === 'loading') return frame(<LoadingState label="Validating opening puzzles…" />)
  if (resource.status === 'error') {
    return frame(<ErrorState title="Opening puzzles unavailable" detail={resource.error} onRetry={onRetry} />)
  }

  const parsed = safeParseOpeningPuzzleList(resource.puzzles)
  if (!parsed.success) {
    return frame(
      <ErrorState
        title="Opening puzzle data rejected"
        detail={`The loaded puzzle set failed ${parsed.error.issues.length} runtime validation check${parsed.error.issues.length === 1 ? '' : 's'}. No unverified position was opened.`}
        onRetry={onRetry}
      />
    )
  }
  if (parsed.data.length === 0) {
    return frame(<EmptyState title="No verified puzzles in this variation" detail="The variation remains browsable, but it has no eligible learner decision nodes in the audited snapshot." />)
  }
  const safeDelay = Number.isFinite(autoAdvanceMs)
    ? Math.max(500, Math.min(30_000, Math.round(autoAdvanceMs)))
    : DEFAULT_AUTO_ADVANCE_MS
  return frame(
    <ReadyPuzzleSession
      key={parsed.data.map((puzzle) => puzzle.id).join('|')}
      puzzles={parsed.data}
      orientation={orientation}
      onSetOrientation={onSetOrientation}
      onSolved={onSolved}
      onCompleted={onCompleted}
      onExit={onExit}
      onAnnouncement={onAnnouncement}
      autoAdvanceMs={safeDelay}
      reducedMotion={reducedMotion}
    />
  )
}

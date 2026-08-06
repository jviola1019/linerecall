import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { applyLegalMove, type BoardOrientation } from '../../domain/board.ts'
import type { PositionGraph } from '../../domain/deviation.ts'
import type { VerifiedLine } from '../../domain/opening-data.ts'
import {
  masteryPercent,
  type CardProgress,
  type ProgressV1,
  type ReviewGrade,
} from '../../domain/progress.ts'
import {
  completeTrainingReview,
  createTrainingSession,
  submitTrainingMove,
  useHint,
  type TrainingSessionState,
} from '../../domain/training-session.ts'
import { ChessBoard, moveStatusPresentation, type BoardMoveStatus } from './ChessBoard.tsx'
import { BoardAnnotationOverlay, BoardAnnotationPanel } from './BoardAnnotations.tsx'
import { EvidenceTable, MoveComparison } from './EvidenceTable.tsx'
import { EmptyState } from './ResourceState.tsx'
import type { BoardAnnotation, BoardAnnotationTone } from '../../domain/board-annotations.ts'

export interface DrillViewProps {
  line: VerifiedLine | null
  graph: PositionGraph
  progress: ProgressV1
  orientation: BoardOrientation
  onSetOrientation: (orientation: BoardOrientation) => void
  onReview: (card: CardProgress, commit: ReviewCommitMetadata) => string | undefined
  manualGrading?: boolean
  reducedMotion?: boolean
  onSetManualGrading?: (enabled: boolean) => void
  onAnnouncement: (message: string) => void
  onReturnToBrowser: () => void
}

export interface ReviewCommitMetadata {
  kind: 'review' | 'correction'
  grade: ReviewGrade
  lineId: string
  nodeId: string
  occurredAt: string
  correctsEventId?: string
}

const GRADES: ReadonlyArray<{ grade: ReviewGrade; key: string; label: string; detail: string }> = [
  { grade: 'again', key: '1', label: 'Again', detail: 'Reset; repeat this session' },
  { grade: 'hard', key: '2', label: 'Hard', detail: 'Quality 3' },
  { grade: 'good', key: '3', label: 'Good', detail: 'Quality 4' },
  { grade: 'easy', key: '4', label: 'Easy', detail: 'Quality 5' },
]

type AnalysisTab = 'line' | 'alternatives' | 'evidence'
const ANALYSIS_TABS: ReadonlyArray<{ id: AnalysisTab; label: string }> = [
  { id: 'line', label: 'Line' },
  { id: 'alternatives', label: 'Alternatives' },
  { id: 'evidence', label: 'Evidence' },
]

interface LastReviewRecord {
  nodeId: string
  feedback: NonNullable<TrainingSessionState['feedback']>
  grade: ReviewGrade
  beforeCard: CardProgress | null
  reviewEventId?: string
}

function ReviewHistory({ review, onChange }: {
  review: LastReviewRecord
  onChange: (grade: ReviewGrade) => void
}): React.JSX.Element {
  return (
    <section className="review-history" aria-labelledby="last-review-title">
      <div>
        <p className="eyebrow">Review log</p>
        <strong id="last-review-title">Last move recorded as {review.grade}</strong>
      </div>
      <details>
        <summary>Adjust last grade</summary>
        <div className="grade-buttons" role="group" aria-label="Adjust last recall grade">
          {GRADES.map((item) => (
            <button
              type="button"
              key={item.grade}
              aria-pressed={review.grade === item.grade}
              onClick={() => onChange(item.grade)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </details>
    </section>
  )
}

function dueNodeIds(line: VerifiedLine, progress: ProgressV1, now: Date): string[] {
  return line.nodes
    .filter((node) => {
      const card = progress.cards[`${line.id}::${node.id}`]
      return !card || Date.parse(card.dueAt) <= now.getTime()
    })
    .map((node) => node.id)
}

function scoreLabel(score: { kind: 'centipawn' | 'mate'; value: number } | null): string {
  if (score === null) return 'not independently analyzed'
  return score.kind === 'mate' ? `mate ${score.value > 0 ? '+' : ''}${score.value}` : `${score.value > 0 ? '+' : ''}${score.value} cp`
}

function principalVariationSan(fen: string, uciMoves: readonly string[]): string[] {
  const chess = new Chess(fen)
  const san: string[] = []
  for (const uci of uciMoves.slice(0, 10)) {
    try {
      const move = chess.move({
        from: uci.slice(0, 2) as Square,
        to: uci.slice(2, 4) as Square,
        ...(uci[4] ? { promotion: uci[4] as PieceSymbol } : {}),
      })
      san.push(move.san)
    } catch {
      return [...san, `${uci} (unavailable)`]
    }
  }
  return san
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'exact_book': return 'You recalled the expected repertoire move.'
    case 'accepted_book_transposition': return 'This is an accepted book transposition.'
    case 'playable_alternative': return 'Independent engine and game evidence classify this as playable.'
    case 'engine_inaccuracy': return 'Independent analysis measured a 51–99 centipawn loss.'
    case 'engine_mistake': return 'Independent analysis measured at least a 100 centipawn loss or a losing mate transition.'
    case 'known_line_unverified': return 'This move occurs in a known line, but this selected repertoire has insufficient evidence for a stronger label.'
    case 'unsupported_unverified': return 'This legal move lacks enough audited engine or game evidence for a stronger label.'
    case 'illegal_move': return 'That move is illegal in this position.'
    default: return 'Move evidence is unavailable.'
  }
}

export function DrillView({
  line,
  graph,
  progress,
  orientation,
  onSetOrientation,
  onReview,
  manualGrading = false,
  reducedMotion = false,
  onSetManualGrading,
  onAnnouncement,
  onReturnToBrowser,
}: DrillViewProps): React.JSX.Element {
  const [session, setSession] = useState<TrainingSessionState | null>(null)
  const [answeredFen, setAnsweredFen] = useState<string | null>(null)
  const [grade, setGrade] = useState<ReviewGrade>('good')
  const [practiceAll, setPracticeAll] = useState(false)
  const [reviewsCompleted, setReviewsCompleted] = useState(0)
  const [lastReview, setLastReview] = useState<LastReviewRecord | null>(null)
  const [mobileStatsOpen, setMobileStatsOpen] = useState(false)
  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>('line')
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotations, setAnnotations] = useState<BoardAnnotation[]>([])
  const [annotationTone, setAnnotationTone] = useState<BoardAnnotationTone>('study')
  const drillRootRef = useRef<HTMLDivElement>(null)
  const drillHeadingRef = useRef<HTMLHeadingElement>(null)
  const completionHeadingRef = useRef<HTMLHeadingElement>(null)
  const mobileStatsTriggerRef = useRef<HTMLButtonElement>(null)
  const mobileStatsCloseRef = useRef<HTMLButtonElement>(null)
  const mobileStatsDialogRef = useRef<HTMLDivElement>(null)
  const gradeButtonRefs = useRef(new Map<ReviewGrade, HTMLButtonElement>())
  const analysisTabRefs = useRef(new Map<AnalysisTab, HTMLButtonElement>())
  const focusedLineRef = useRef<string | null>(null)
  const previousPhaseRef = useRef<TrainingSessionState['phase'] | null>(null)
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (completionTimerRef.current !== null) {
      clearTimeout(completionTimerRef.current)
      completionTimerRef.current = null
    }
    if (!line) {
      setSession(null)
      return
    }
    const due = dueNodeIds(line, progress, new Date())
    setSession(createTrainingSession(line, practiceAll ? undefined : due))
    setAnsweredFen(null)
    setReviewsCompleted(0)
    setLastReview(null)
    setMobileStatsOpen(false)
    setAnalysisTab('line')
    setAnnotationMode(false)
    setAnnotations([])
  }, [line, practiceAll])

  useEffect(() => () => {
    if (completionTimerRef.current !== null) clearTimeout(completionTimerRef.current)
  }, [])

  useEffect(() => {
    if (!mobileStatsOpen) return
    const backdrop = mobileStatsDialogRef.current?.parentElement ?? null
    const background = [...document.body.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({ element, wasInert: element.inert }))
    for (const { element } of background) element.inert = true
    queueMicrotask(() => mobileStatsCloseRef.current?.focus())
    return () => {
      for (const { element, wasInert } of background) element.inert = wasInert
    }
  }, [mobileStatsOpen])

  useEffect(() => {
    if (!line) {
      focusedLineRef.current = null
      previousPhaseRef.current = null
      return
    }
    if (session && focusedLineRef.current !== line.id) {
      focusedLineRef.current = line.id
      queueMicrotask(() => drillHeadingRef.current?.focus())
    }
  }, [line, session])

  useEffect(() => {
    if (!session) return
    const previous = previousPhaseRef.current
    previousPhaseRef.current = session.phase
    if (manualGrading && session.phase === 'answer_ready' && previous === 'awaiting_move') {
      queueMicrotask(() => gradeButtonRefs.current.get(session.suggestedGrade ?? 'good')?.focus())
      return
    }
    if (session.phase === 'complete' && previous !== 'complete') {
      queueMicrotask(() => completionHeadingRef.current?.focus())
      return
    }
    if (session.phase === 'awaiting_move' && (previous === 'answer_ready' || previous === 'complete')) {
      queueMicrotask(() => {
        drillRootRef.current
          ?.querySelector<HTMLButtonElement>('[role="gridcell"][tabindex="0"]:not(:disabled)')
          ?.focus()
      })
    }
  }, [manualGrading, session])

  if (!line) {
    return (
      <div className="drill-view">
        <EmptyState title="Choose a drillable variation" detail="Open the ECO browser, select an engine-checked training side, and start a drill." />
        <button type="button" onClick={onReturnToBrowser}>Browse openings</button>
      </div>
    )
  }
  if (!session) return <div className="drill-view" role="status">Preparing drill…</div>

  const node = line.nodes.find((candidate) => candidate.id === session.currentNodeId) ?? null
  const cards = line.nodes.map((candidate) => progress.cards[`${line.id}::${candidate.id}`]).filter((card): card is CardProgress => card !== undefined)
  const mastery = cards.length === 0 ? 0 : Math.round(cards.reduce((sum, card) => sum + masteryPercent(card), 0) / line.nodes.length)

  const adjustLastGrade = (selectedGrade: ReviewGrade): void => {
    if (!lastReview || !line.nodes.some((candidate) => candidate.id === lastReview.nodeId)) return
    const reviewState: TrainingSessionState = {
      lineId: line.id,
      queue: [lastReview.nodeId],
      currentNodeId: lastReview.nodeId,
      phase: 'answer_ready',
      feedback: lastReview.feedback,
      usedHint: selectedGrade === 'hard',
      incorrectAttempts: selectedGrade === 'again' ? 1 : 0,
      suggestedGrade: selectedGrade,
      opponentAutoMoveUci: null,
    }
    const reviewedAt = new Date()
    const replacement = completeTrainingReview({
      state: reviewState,
      line,
      existingCard: lastReview.beforeCard,
      grade: selectedGrade,
      now: reviewedAt,
    })
    onReview(replacement.card, {
      kind: 'correction',
      grade: selectedGrade,
      lineId: line.id,
      nodeId: lastReview.nodeId,
      occurredAt: reviewedAt.toISOString(),
      ...(lastReview.reviewEventId ? { correctsEventId: lastReview.reviewEventId } : {}),
    })
    setSession((current) => {
      if (!current) return current
      const withoutReviewed = current.queue.filter((nodeId) => nodeId !== lastReview.nodeId)
      const queue = replacement.repeatAtSessionEnd ? [...withoutReviewed, lastReview.nodeId] : withoutReviewed
      if (current.phase !== 'complete') return { ...current, queue }
      return {
        ...current,
        queue,
        currentNodeId: queue[0] ?? null,
        phase: queue.length > 0 ? 'awaiting_move' : 'complete',
      }
    })
    setLastReview((current) => current ? { ...current, grade: selectedGrade } : current)
    onAnnouncement(`Last recall grade changed to ${selectedGrade}.`)
  }

  if (session.phase === 'complete' || node === null) {
    const due = dueNodeIds(line, progress, new Date()).length
    return (
      <div ref={drillRootRef} className="drill-view completion-card">
        <span className="completion-mark" aria-hidden="true">✓</span>
        <p className="eyebrow">Session complete</p>
        <h1 ref={completionHeadingRef} tabIndex={-1}>{line.name}</h1>
        <p>{reviewsCompleted > 0 ? `${reviewsCompleted} learner-position reviews completed.` : 'No cards are due right now.'}</p>
        <p>Current variation mastery: <strong>{mastery}%</strong></p>
        {!manualGrading && lastReview ? <ReviewHistory review={lastReview} onChange={adjustLastGrade} /> : null}
        <div className="inline-controls">
          <button type="button" onClick={() => { setPracticeAll(true); setSession(createTrainingSession(line)); }}>Practice all positions</button>
          <button type="button" className="secondary-button" onClick={onReturnToBrowser}>Return to browser</button>
        </div>
        {due === 0 ? <p className="field-help">Scheduled reviews will reappear when they are due.</p> : null}
      </div>
    )
  }

  const expected = node.moves.find((move) => move.uci === node.expectedMoveUci)
  if (!expected) throw new Error(`Audited node ${node.id} is missing its expected move`)
  // Once automatic grading advances the queue, the analysis panel must describe
  // the position that is currently on the board. The prior result remains
  // available in ReviewHistory; keeping it in this panel hid the next hint and
  // made continuous practice look stalled between otherwise automatic moves.
  const feedback = session.feedback
  const feedbackNode = node
  const presentation = feedback ? moveStatusPresentation(feedback.classification as BoardMoveStatus) : null
  // Automatic grading clears session.feedback as it advances to the next
  // learner position. Keep the just-validated move available to the visual
  // layer so it can prioritize the exact legal animation sequence instead of
  // searching every possible two-ply continuation.
  const boardMoveFeedback = feedback?.legal
    ? feedback
    : lastReview?.feedback.legal
      ? lastReview.feedback
      : null
  const boardFen = answeredFen ?? node.fen
  const hintUci = session.usedHint ? node.expectedMoveUci : null
  const selectAnalysisTab = (tab: AnalysisTab): void => {
    setAnalysisTab(tab)
    onAnnouncement(`${ANALYSIS_TABS.find((item) => item.id === tab)?.label ?? tab} analysis opened.`)
  }
  const handleAnalysisTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + ANALYSIS_TABS.length) % ANALYSIS_TABS.length
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % ANALYSIS_TABS.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = ANALYSIS_TABS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const next = ANALYSIS_TABS[nextIndex]
    if (!next) return
    selectAnalysisTab(next.id)
    queueMicrotask(() => analysisTabRefs.current.get(next.id)?.focus())
  }

  const playMove = (uci: string): void => {
    if (session.phase !== 'awaiting_move') return
    const next = submitTrainingMove({ state: session, line, graph, moveUci: uci })
    const moveFeedback = next.feedback
    if (!moveFeedback?.legal) {
      setSession(next)
      onAnnouncement('Illegal move. Choose a legal move and try again.')
      return
    }
    const status = moveStatusPresentation(moveFeedback.classification as BoardMoveStatus)
    if (next.phase === 'awaiting_move') {
      setSession(next)
      setAnsweredFen(null)
      onAnnouncement(`${status.label}. ${reasonLabel(moveFeedback.reason)} Play the repertoire move to continue; this card will repeat.`)
      return
    }
    const suggested = next.suggestedGrade ?? 'good'
    if (manualGrading) {
      setGrade(suggested)
      setSession(next)
      setAnsweredFen(applyLegalMove(node.fen, uci).fen)
      onAnnouncement(`${status.label}. ${reasonLabel(moveFeedback.reason)} Suggested grade: ${suggested}.`)
      return
    }
    const cardId = `${line.id}::${node.id}`
    const beforeCard = progress.cards[cardId] ?? null
    const reviewedAt = new Date()
    const completed = completeTrainingReview({
      state: next,
      line,
      existingCard: beforeCard,
      grade: suggested,
      now: reviewedAt,
    })
    const reviewEventId = onReview(completed.card, {
      kind: 'review',
      grade: suggested,
      lineId: line.id,
      nodeId: node.id,
      occurredAt: reviewedAt.toISOString(),
    })
    setReviewsCompleted((count) => count + 1)
    setAnnotations([])
    setAnnotationMode(false)
    setLastReview({
      nodeId: node.id,
      feedback: moveFeedback,
      grade: suggested,
      beforeCard,
      ...(reviewEventId ? { reviewEventId } : {}),
    })
    if (completionTimerRef.current !== null) clearTimeout(completionTimerRef.current)
    if (completed.state.phase === 'complete') {
      // Keep the board mounted at the legally applied destination long enough
      // for the final piece translation to finish before the completion view
      // replaces it. Reduced-motion users receive the completed state at once.
      setSession(next)
      setAnsweredFen(applyLegalMove(node.fen, uci).fen)
      completionTimerRef.current = setTimeout(() => {
        completionTimerRef.current = null
        setSession(completed.state)
        setAnsweredFen(null)
      }, reducedMotion ? 0 : 180)
    } else {
      setSession(completed.state)
      setAnsweredFen(null)
    }
    onAnnouncement(
      completed.state.phase === 'complete'
        ? `${status.label}. ${suggested} recorded automatically. Session complete.`
        : `${status.label}. ${suggested} recorded automatically.${completed.state.opponentAutoMoveUci ? ` Opponent move ${completed.state.opponentAutoMoveUci} played.` : ''} Continue with the next position.`,
    )
  }

  const applyGrade = (selectedGrade: ReviewGrade): void => {
    const cardId = `${line.id}::${node.id}`
    const reviewedAt = new Date()
    const completed = completeTrainingReview({
      state: session,
      line,
      existingCard: progress.cards[cardId] ?? null,
      grade: selectedGrade,
      now: reviewedAt,
    })
    const reviewEventId = onReview(completed.card, {
      kind: 'review',
      grade: selectedGrade,
      lineId: line.id,
      nodeId: node.id,
      occurredAt: reviewedAt.toISOString(),
    })
    setReviewsCompleted((count) => count + 1)
    if (session.feedback) {
      setLastReview({
        nodeId: node.id,
        feedback: session.feedback,
        grade: selectedGrade,
        beforeCard: progress.cards[cardId] ?? null,
        ...(reviewEventId ? { reviewEventId } : {}),
      })
    }
    setSession(completed.state)
    setAnsweredFen(null)
    const nextNode = line.nodes.find((candidate) => candidate.id === completed.state.currentNodeId)
    const auto = completed.state.opponentAutoMoveUci
    onAnnouncement(
      completed.state.phase === 'complete'
        ? `Grade ${selectedGrade} saved. Session complete.`
        : `Grade ${selectedGrade} saved.${auto ? ` Opponent move ${auto} played.` : ''} ${nextNode ? 'Your next position is ready.' : ''}`,
    )
  }

  const gradeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const choice = GRADES.find((item) => item.key === event.key)
    if (!choice || session.phase !== 'answer_ready') return
    event.preventDefault()
    setGrade(choice.grade)
    applyGrade(choice.grade)
  }

  const closeMobileStats = (): void => {
    const restoreToTrigger = typeof window.matchMedia !== 'function'
      || window.matchMedia('(max-width: 900px)').matches
    setMobileStatsOpen(false)
    queueMicrotask(() => {
      if (restoreToTrigger) mobileStatsTriggerRef.current?.focus()
      else drillHeadingRef.current?.focus()
    })
  }

  const openMobileStats = (): void => {
    const countsAsHint = session.phase === 'awaiting_move' && !session.usedHint
    if (countsAsHint) setSession(useHint(session))
    setMobileStatsOpen(true)
    onAnnouncement(
      countsAsHint
        ? 'Line statistics opened. They reveal the expected move and count as a hint, so a correct move defaults to Hard.'
        : 'Line statistics opened.',
    )
  }

  const mobileStatsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMobileStats()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(mobileStatsDialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => !element.hasAttribute('hidden'))
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div ref={drillRootRef} className="drill-view">
      <header className="drill-header">
        <div>
          <p className="eyebrow"><span className="eco-pill">{line.eco}</span> Train {line.trainedSide}</p>
          <h1 ref={drillHeadingRef} tabIndex={-1}>{line.name}</h1>
        </div>
        <div className="drill-metrics" role="group" aria-label="Session progress">
          <span><strong>{reviewsCompleted}</strong> reviewed</span>
          <span><strong>{session.queue.length}</strong> remaining</span>
          <span><strong>{mastery}%</strong> mastery</span>
        </div>
        <div className="drill-header-actions">
          <button
            type="button"
            className="secondary-button"
            aria-pressed={practiceAll}
            disabled={practiceAll}
            onClick={() => setPracticeAll(true)}
          >
            {practiceAll ? 'Full line active' : 'Practice full line'}
          </button>
          <label className="flow-mode-toggle">
            <input
              type="checkbox"
              checked={manualGrading}
              onChange={(event) => onSetManualGrading?.(event.currentTarget.checked)}
              disabled={!onSetManualGrading || session.phase === 'answer_ready'}
            />
            Pause after each move
          </label>
        </div>
      </header>

      <button
        ref={mobileStatsTriggerRef}
        type="button"
        className="secondary-button mobile-stats-trigger"
        aria-haspopup="dialog"
        aria-expanded={mobileStatsOpen}
        aria-controls={mobileStatsOpen ? 'mobile-line-statistics' : undefined}
        aria-describedby={session.phase === 'awaiting_move' ? 'mobile-stats-hint-help' : undefined}
        onClick={openMobileStats}
      >
        {session.phase === 'awaiting_move' && !session.usedHint ? 'View statistics (counts as hint)' : 'View line statistics'}
      </button>
      {session.phase === 'awaiting_move' ? (
        <p id="mobile-stats-hint-help" className="field-help mobile-stats-help">
          Statistics reveal the expected move and engine evidence. Viewing them before answering counts as a hint, so a correct move defaults to Hard.
        </p>
      ) : null}

      <div className="drill-workspace">
        <div className="board-column">
          <div className="board-toolbar">
            <span>Move {Math.floor(node.ply / 2) + 1}{node.ply % 2 === 0 ? ', White' : ', Black'} to play</span>
            <div className="inline-controls">
              <button
                type="button"
                className="text-button"
                aria-pressed={annotationMode}
                onClick={() => {
                  setAnnotationMode((current) => !current)
                  onAnnouncement(annotationMode ? 'Annotation mode closed.' : 'Annotation mode opened. Move input is paused.')
                }}
              >
                {annotationMode ? 'Resume moves' : 'Annotate'}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => onSetOrientation(orientation === 'white' ? 'black' : 'white')}
              >
                Flip board
              </button>
            </div>
          </div>
          <ChessBoard
            fen={boardFen}
            orientation={orientation}
            disabled={session.phase !== 'awaiting_move' || annotationMode}
            reducedMotion={reducedMotion}
            hintUci={hintUci}
            lastMove={boardMoveFeedback ? { uci: boardMoveFeedback.playedMoveUci, status: boardMoveFeedback.classification } : null}
            boardOverlay={(
              <BoardAnnotationOverlay
                annotations={annotations}
                orientation={orientation}
                editing={annotationMode}
                tone={annotationTone}
                onChange={setAnnotations}
                onAnnouncement={onAnnouncement}
                onExitEditing={() => setAnnotationMode(false)}
              />
            )}
            onMove={playMove}
            onAnnouncement={onAnnouncement}
          />
          {annotationMode ? (
            <BoardAnnotationPanel
              annotations={annotations}
              orientation={orientation}
              editing
              tone={annotationTone}
              onToneChange={setAnnotationTone}
              onChange={setAnnotations}
              onAnnouncement={onAnnouncement}
            />
          ) : null}
          <div className="drill-thumb-dock" role="toolbar" aria-label="Training tools">
            <button
              type="button"
              disabled={session.usedHint || session.phase !== 'awaiting_move'}
              onClick={() => {
                setSession(useHint(session))
                onAnnouncement(`Hint: the book move is ${expected.san}.`)
              }}
            >Hint</button>
            <button type="button" onClick={() => selectAnalysisTab('alternatives')}>Lines</button>
            <button type="button" onClick={openMobileStats}>Why</button>
            <button
              type="button"
              aria-pressed={annotationMode}
              onClick={() => {
                setAnnotationMode((current) => !current)
                onAnnouncement(annotationMode ? 'Annotation mode closed.' : 'Annotation mode opened. Move input is paused.')
              }}
            >Annotate</button>
          </div>
        </div>

        <aside className="feedback-panel" aria-labelledby="feedback-title">
          <div className="analysis-heading-row">
            <h2 id="feedback-title">Analysis</h2>
            <div className="analysis-tabs" role="tablist" aria-label="Position analysis">
              {ANALYSIS_TABS.map((tab, index) => (
                <button
                  ref={(element) => {
                    if (element) analysisTabRefs.current.set(tab.id, element)
                    else analysisTabRefs.current.delete(tab.id)
                  }}
                  type="button"
                  role="tab"
                  id={`analysis-tab-${tab.id}`}
                  aria-selected={analysisTab === tab.id}
                  aria-controls={`analysis-panel-${tab.id}`}
                  tabIndex={analysisTab === tab.id ? 0 : -1}
                  key={tab.id}
                  onKeyDown={(event) => handleAnalysisTabKey(event, index)}
                  onClick={() => selectAnalysisTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          {!feedback ? (
            <>
              <div
                id="analysis-panel-line"
                role="tabpanel"
                aria-labelledby="analysis-tab-line"
                hidden={analysisTab !== 'line'}
                className="prompt-card"
              >
                <span className="state-icon" aria-hidden="true">?</span>
                <p>Recall the repertoire move. Legal moves are enforced by chess.js.</p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={session.usedHint}
                  onClick={() => {
                    setSession(useHint(session))
                    onAnnouncement(`Hint: the book move is ${expected.san}, ${expected.uci}.`)
                  }}
                >
                  {session.usedHint ? `Hint: ${expected.san}` : 'Show hint'}
                </button>
              </div>
              <div
                id="analysis-panel-alternatives"
                role="tabpanel"
                aria-labelledby="analysis-tab-alternatives"
                hidden={analysisTab !== 'alternatives'}
                className="prompt-card"
              >
                <p>Play a move first. Continuations will be labeled as engine forecasts, not backtested play.</p>
              </div>
              <div
                id="analysis-panel-evidence"
                role="tabpanel"
                aria-labelledby="analysis-tab-evidence"
                hidden={analysisTab !== 'evidence'}
                className="prompt-card"
              >
                <p>Play a move first. The comparison will use only stored game and engine evidence.</p>
              </div>
            </>
          ) : null}
          {feedback && presentation ? (
            <div className="feedback-content" data-feedback={feedback.classification}>
              <div
                id="analysis-panel-line"
                role="tabpanel"
                aria-labelledby="analysis-tab-line"
                hidden={analysisTab !== 'line'}
              >
                <div className="classification-heading">
                  <span className="classification-icon" aria-hidden="true">{presentation.icon}</span>
                  <div><p className="eyebrow">Classification</p><h3>{presentation.label}</h3></div>
                </div>
                <p>{reasonLabel(feedback.reason)}</p>
                <dl className="evidence-facts evidence-facts-compact">
                  <div><dt>Played</dt><dd>{feedback.playedMoveSan ?? feedback.playedMoveUci}</dd></div>
                  <div><dt>Book</dt><dd>{feedback.expectedEvidence.san} ({feedback.expectedEvidence.uci})</dd></div>
                </dl>
                {feedback.evidence && feedback.evidence.principalVariationUci.length > 0 ? (
                  <p className="pv-line"><strong>Engine forecast:</strong> {feedback.evidence.principalVariationUci.join(' ')}</p>
                ) : <p className="field-help">No independent principal variation is available for this move.</p>}
              </div>
              <div
                id="analysis-panel-alternatives"
                role="tabpanel"
                aria-labelledby="analysis-tab-alternatives"
                hidden={analysisTab !== 'alternatives'}
                className="forecast-lines"
              >
                <h3>Engine continuations</h3>
                <p className="field-help">Forecasts are Stockfish analysis, not backtested continuations.</p>
                <ol>
                  {feedbackNode.engine.topVariations.map((variation) => (
                    <li key={variation.multipv}>
                      <span>PV {variation.multipv}</span>
                      <strong>{scoreLabel(variation.score)}</strong>
                      <span>{principalVariationSan(feedbackNode.fen, variation.movesUci).join(' ')}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <div
                id="analysis-panel-evidence"
                role="tabpanel"
                aria-labelledby="analysis-tab-evidence"
                hidden={analysisTab !== 'evidence'}
              >
                <h3>Move evidence</h3>
                <dl className="evidence-facts">
                  <div><dt>Engine loss</dt><dd>{feedback.evidence?.centipawnLoss === null || feedback.evidence?.centipawnLoss === undefined ? 'Not verified' : `${feedback.evidence.centipawnLoss} cp`}</dd></div>
                  <div><dt>Played score</dt><dd>{scoreLabel(feedback.evidence?.score ?? null)}</dd></div>
                  <div><dt>Played sample</dt><dd>{feedback.evidence ? feedback.evidence.sampleSize.toLocaleString('en-US') : 'No audited sample'}</dd></div>
                  <div><dt>Book sample</dt><dd>{feedback.expectedEvidence.sampleSize.toLocaleString('en-US')}</dd></div>
                </dl>
                <MoveComparison played={feedback.evidence} expected={feedback.expectedEvidence} />
              </div>
            </div>
          ) : null}
        </aside>
      </div>

      {manualGrading && session.phase === 'answer_ready' ? (
        <div className="review-controls" role="group" aria-labelledby="review-grade-title" onKeyDown={gradeKeyDown}>
          <div className="review-copy">
            <strong id="review-grade-title">Choose recall grade</strong>
            <span>Suggested: {session.suggestedGrade}. Keys 1–4 submit.</span>
          </div>
          <div className="grade-buttons">
            {GRADES.map((item) => (
              <button
                ref={(node) => {
                  if (node) gradeButtonRefs.current.set(item.grade, node)
                  else gradeButtonRefs.current.delete(item.grade)
                }}
                type="button"
                key={item.grade}
                className={grade === item.grade ? 'selected-grade' : ''}
                aria-pressed={grade === item.grade}
                title={item.detail}
                onClick={() => { setGrade(item.grade); applyGrade(item.grade) }}
              >
                <kbd>{item.key}</kbd> {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!manualGrading && lastReview ? <ReviewHistory review={lastReview} onChange={adjustLastGrade} /> : null}

      {mobileStatsOpen ? createPortal((
        <div
          className="mobile-stats-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeMobileStats()
          }}
        >
          <div
            ref={mobileStatsDialogRef}
            id="mobile-line-statistics"
            className="mobile-stats-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-line-statistics-title"
            onKeyDown={mobileStatsKeyDown}
          >
            <div className="mobile-stats-sheet-header">
              <div>
                <p className="eyebrow">Audited line evidence</p>
                <h2 id="mobile-line-statistics-title">Line statistics</h2>
              </div>
              <button ref={mobileStatsCloseRef} type="button" className="secondary-button" onClick={closeMobileStats}>
                Close statistics
              </button>
            </div>
            <p>
              {line.eco} · {line.name}. Terminal sample: <strong>{line.terminalSampleSize.toLocaleString('en-US')}</strong> games;
              results are shown from the trained {line.trainedSide} side.
            </p>
            <EvidenceTable bands={line.terminalStats} caption="Terminal trained-side results by rating band" />
            <dl className="audit-grid mobile-node-audit">
              <div><dt>Learner position</dt><dd>Ply {node.ply + 1}</dd></div>
              <div><dt>Expected move</dt><dd>{expected.san} ({expected.uci})</dd></div>
              <div><dt>Engine best move</dt><dd>{node.engine.bestMoveUci}</dd></div>
              <div><dt>Expected-move loss</dt><dd>{node.engine.expectedMoveCentipawnLoss} cp</dd></div>
              <div><dt>Engine analyzed</dt><dd>{node.engine.analyzedAt}</dd></div>
              <div><dt>Cross-check</dt><dd>{line.crosscheckStatus.replaceAll('_', ' ')}</dd></div>
            </dl>
            <p className="field-help">Low-sample warnings identify bands with fewer than 100 games. Statistics describe this corpus and are not forecasts.</p>
          </div>
        </div>
      ), document.body) : null}
    </div>
  )
}

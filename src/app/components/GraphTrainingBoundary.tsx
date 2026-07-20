import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoardOrientation } from '../../domain/board.ts'
import {
  GRAPH_TRAINING_CONTRACT_ID,
  applyPendingOpponentGraphMove,
  continueGraphTrainingSession,
  createAutonomousGraphTrainingPlan,
  createExplicitGraphSessionSelection,
  createGraphTrainingPathCompletion,
  createGraphTrainingSession,
  expectedGraphTrainingMoves,
  graphTrainingFen,
  listGraphTrainingPaths,
  markGraphTrainingHint,
  prepareGraphTrainingAdapter,
  submitGraphTrainingMove,
  summarizeGraphTrainingCoverage,
  type AutonomousGraphTrainingPlan,
  type GraphTrainingAdapter,
  type GraphTrainingEnvelope,
  type GraphTrainingPathCompletionV1,
  type GraphTrainingReviewInference,
  type GraphTrainingSessionState,
} from '../../domain/graph-training-session.ts'
import { ChessBoard, type BoardMoveStatus } from './ChessBoard.tsx'
import { EmptyState, ErrorState, LoadingState } from './ResourceState.tsx'

export type GraphTrainingResource =
  | { status: 'disabled'; reason: string }
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; envelope: GraphTrainingEnvelope }

export interface GraphTrainingBoundaryProps {
  resource: GraphTrainingResource
  dueCardIds: readonly string[]
  orientation: BoardOrientation
  reducedMotion?: boolean
  manualPacing?: boolean
  onSetOrientation?: (orientation: BoardOrientation) => void
  onInferredReview?: (review: GraphTrainingReviewInference) => void
  onPathCompleted?: (completion: GraphTrainingPathCompletionV1) => void | Promise<void>
  onAnnouncement?: (message: string) => void
  onRetry?: () => void
}

interface PreparedResource {
  envelope: GraphTrainingEnvelope
  adapter: GraphTrainingAdapter | null
  error: string | null
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The graph could not be validated.'
}

function pathLabel(summary: ReturnType<typeof listGraphTrainingPaths>[number]): string {
  const family = summary.familyTags.join(' / ')
  return `${family} — ${summary.learnerDecisionCount} learner moves, terminal ply ${summary.terminalPly}`
}

function acceptedMoveStatus(state: GraphTrainingSessionState): BoardMoveStatus | undefined {
  const classification = state.lastFeedback?.classification
  return classification === 'book' || classification === 'playable' ? classification : undefined
}

function GraphTrainingWorkspace({
  adapter,
  dueCardIds,
  orientation,
  reducedMotion = false,
  manualPacing = false,
  onSetOrientation,
  onInferredReview,
  onPathCompleted,
  onAnnouncement,
}: Omit<GraphTrainingBoundaryProps, 'resource' | 'onRetry'> & { adapter: GraphTrainingAdapter }): React.JSX.Element {
  const paths = useMemo(() => listGraphTrainingPaths(adapter), [adapter])
  const [selectedPathId, setSelectedPathId] = useState(paths[0]?.id ?? '')
  const [session, setSession] = useState<GraphTrainingSessionState | null>(null)
  const [autonomousPlan, setAutonomousPlan] = useState<AutonomousGraphTrainingPlan | null>(null)
  const [activeBatchIndex, setActiveBatchIndex] = useState(0)
  const [completedBeforeBatch, setCompletedBeforeBatch] = useState<string[]>([])
  const [manualPacingEnabled, setManualPacingEnabled] = useState(manualPacing)
  const [localAnnouncement, setLocalAnnouncement] = useState('')
  const reportedCompletionKeys = useRef(new Set<string>())
  const pendingCompletionKeys = useRef(new Set<string>())
  const announce = (value: string): void => {
    setLocalAnnouncement(value)
    onAnnouncement?.(value)
  }

  useEffect(() => {
    if (!paths.some(({ id }) => id === selectedPathId)) setSelectedPathId(paths[0]?.id ?? '')
  }, [paths, selectedPathId])

  useEffect(() => setManualPacingEnabled(manualPacing), [manualPacing])

  useEffect(() => {
    if (!session || !onPathCompleted) return
    for (const pathId of session.completedPathIds) {
      const key = `${session.releaseId}\0${session.packId}\0${pathId}`
      if (reportedCompletionKeys.current.has(key) || pendingCompletionKeys.current.has(key)) continue
      try {
        const completion = createGraphTrainingPathCompletion({
          adapter,
          state: session,
          pathId,
          completedAt: new Date().toISOString(),
        })
        pendingCompletionKeys.current.add(key)
        void Promise.resolve(onPathCompleted(completion)).then(() => {
          pendingCompletionKeys.current.delete(key)
          reportedCompletionKeys.current.add(key)
        }).catch((error: unknown) => {
          pendingCompletionKeys.current.delete(key)
          announce(`Path completion could not be saved: ${message(error)}`)
        })
      } catch (error) {
        announce(`Path completion could not be recorded: ${message(error)}`)
      }
    }
  }, [adapter, onPathCompleted, session?.completedPathIds, session?.releaseId])

  useEffect(() => {
    if (manualPacingEnabled || session?.phase !== 'opponent_move_ready') return
    const timeout = setTimeout(() => {
      setSession((current) => {
        if (!current || current.phase !== 'opponent_move_ready') return current
        const next = applyPendingOpponentGraphMove(adapter, current)
        announce(`${next.lastTransition?.moveUci ?? 'Opponent move'} played for the opponent.`)
        return next
      })
    }, reducedMotion ? 0 : 190)
    return () => clearTimeout(timeout)
  }, [adapter, manualPacingEnabled, reducedMotion, session?.phase, session?.currentNodeId])

  useEffect(() => {
    if (manualPacingEnabled || session?.phase !== 'path_complete') return
    const timeout = setTimeout(() => {
      setSession((current) => {
        if (!current || current.phase !== 'path_complete') return current
        const next = continueGraphTrainingSession(adapter, current)
        announce(next.phase === 'session_complete' ? 'Path batch complete.' : 'Next audited path started.')
        return next
      })
    }, reducedMotion ? 0 : 240)
    return () => clearTimeout(timeout)
  }, [adapter, manualPacingEnabled, reducedMotion, session?.phase, session?.activePathId])

  useEffect(() => {
    if (manualPacingEnabled || session?.phase !== 'session_complete' || !autonomousPlan) return
    const nextBatchIndex = activeBatchIndex + 1
    const nextPathIds = autonomousPlan.pathIdBatches[nextBatchIndex]
    if (!nextPathIds) return
    const timeout = setTimeout(() => {
      const completed = [...new Set([...completedBeforeBatch, ...session.completedPathIds])]
      const selection = createExplicitGraphSessionSelection({
        adapter,
        pathIds: nextPathIds,
        dueCardIds: session.dueCardIds,
        coverageCycleOrdinal: autonomousPlan.coverageCycleOrdinal,
      })
      setCompletedBeforeBatch(completed)
      setActiveBatchIndex(nextBatchIndex)
      setSession(createGraphTrainingSession({ adapter, selection }))
      announce(`Continuing with audited path batch ${nextBatchIndex + 1} of ${autonomousPlan.pathIdBatches.length}.`)
    }, reducedMotion ? 0 : 240)
    return () => clearTimeout(timeout)
  }, [
    activeBatchIndex,
    adapter,
    autonomousPlan,
    completedBeforeBatch,
    manualPacingEnabled,
    reducedMotion,
    session,
  ])

  const startSelected = (): void => {
    try {
      const selection = createExplicitGraphSessionSelection({ adapter, pathIds: [selectedPathId], dueCardIds })
      const plan: AutonomousGraphTrainingPlan = {
        releaseId: adapter.graph.releaseId,
        packId: adapter.graph.pack.id,
        coverageCycleOrdinal: 0,
        totalPathIds: [...selection.includedPathIds],
        pathIdBatches: [[...selection.includedPathIds]],
      }
      setAutonomousPlan(plan)
      setActiveBatchIndex(0)
      setCompletedBeforeBatch([])
      setSession(createGraphTrainingSession({ adapter, selection, preferredPathId: selectedPathId }))
      announce('One audited path is ready.')
    } catch (error) {
      announce(message(error))
    }
  }

  const startAll = (): void => {
    try {
      const plan = createAutonomousGraphTrainingPlan({ adapter, dueCardIds })
      const firstPathIds = plan.pathIdBatches[0]
      if (!firstPathIds) throw new Error('No audited path is available for autonomous practice')
      const selection = createExplicitGraphSessionSelection({
        adapter,
        pathIds: firstPathIds,
        dueCardIds,
        coverageCycleOrdinal: plan.coverageCycleOrdinal,
      })
      setAutonomousPlan(plan)
      setActiveBatchIndex(0)
      setCompletedBeforeBatch([])
      setSession(createGraphTrainingSession({ adapter, selection }))
      announce(`${plan.totalPathIds.length} audited paths queued. Branches will continue automatically.`)
    } catch (error) {
      announce(message(error))
    }
  }

  const playOpponentMove = (): void => {
    setSession((current) => {
      if (!current || current.phase !== 'opponent_move_ready') return current
      const next = applyPendingOpponentGraphMove(adapter, current)
      announce(`${next.lastTransition?.moveUci ?? 'Opponent move'} played for the opponent.`)
      return next
    })
  }

  const continuePath = (): void => {
    setSession((current) => {
      if (!current || current.phase !== 'path_complete') return current
      const next = continueGraphTrainingSession(adapter, current)
      announce(next.phase === 'session_complete' ? 'Path batch complete.' : 'Next audited path started.')
      return next
    })
  }

  const continueBatch = (): void => {
    if (!session || session.phase !== 'session_complete' || !autonomousPlan) return
    const nextBatchIndex = activeBatchIndex + 1
    const nextPathIds = autonomousPlan.pathIdBatches[nextBatchIndex]
    if (!nextPathIds) return
    const completed = [...new Set([...completedBeforeBatch, ...session.completedPathIds])]
    const selection = createExplicitGraphSessionSelection({
      adapter,
      pathIds: nextPathIds,
      dueCardIds: session.dueCardIds,
      coverageCycleOrdinal: autonomousPlan.coverageCycleOrdinal,
    })
    setCompletedBeforeBatch(completed)
    setActiveBatchIndex(nextBatchIndex)
    setSession(createGraphTrainingSession({ adapter, selection }))
    announce(`Continuing with audited path batch ${nextBatchIndex + 1} of ${autonomousPlan.pathIdBatches.length}.`)
  }

  if (paths.length === 0) {
    return <EmptyState title="No selectable graph paths" detail="The validated pack contains no audited training paths." />
  }

  if (!session) {
    return (
      <section className="graph-training-catalog" aria-labelledby="graph-path-title">
        <header>
          <p className="eyebrow">Validated family graph</p>
          <h2 id="graph-path-title">Practice every audited branch</h2>
          <p>Full repertoire practice continues through each branch without hiding less common continuations.</p>
        </header>
        <label>
          <span>Path</span>
          <select value={selectedPathId} onChange={(event) => setSelectedPathId(event.currentTarget.value)}>
            {paths.map((path) => <option key={path.id} value={path.id}>{pathLabel(path)}</option>)}
          </select>
        </label>
        <dl className="graph-path-facts">
          <div><dt>Audited paths</dt><dd>{paths.length.toLocaleString('en-US')}</dd></div>
          <div><dt>Pack tier</dt><dd>{adapter.graph.pack.tier === 'core' ? 'Core' : 'Primer'}</dd></div>
          <div><dt>Coverage</dt><dd>{Math.round(adapter.graph.pack.coverage * 100)}%</dd></div>
        </dl>
        <div className="inline-controls">
          <button type="button" className="primary-action" onClick={startAll}>Start full repertoire</button>
          <button type="button" className="secondary-button" onClick={startSelected}>Practice selected path</button>
        </div>
        <label className="toggle-row">
          <input type="checkbox" checked={manualPacingEnabled} onChange={(event) => setManualPacingEnabled(event.currentTarget.checked)} />
          <span>Pause after each move</span>
        </label>
        {paths.length > 1_000 ? <p className="field-help">Paths continue in bounded batches; all {paths.length.toLocaleString('en-US')} remain in this run.</p> : null}
        <p className="sr-only" aria-live="polite" aria-atomic="true">{localAnnouncement}</p>
      </section>
    )
  }

  const runPathIds = autonomousPlan?.totalPathIds ?? session.selection.includedPathIds
  const overallCompletedPathIds = [...new Set([...completedBeforeBatch, ...session.completedPathIds])]
  const coverage = summarizeGraphTrainingCoverage({ adapter, includedPathIds: runPathIds, completedPathIds: overallCompletedPathIds })
  const hasNextBatch = Boolean(autonomousPlan?.pathIdBatches[activeBatchIndex + 1])

  if (session.phase === 'session_complete' && !hasNextBatch) {
    return (
      <section className="graph-training-complete" aria-labelledby="graph-complete-title">
        <p className="eyebrow">Session complete</p>
        <h2 id="graph-complete-title">Every selected path is complete.</h2>
        <p>{coverage.completedPathCount.toLocaleString('en-US')} of {coverage.totalPathCount.toLocaleString('en-US')} audited paths completed. Warm-ups were not rescheduled.</p>
        <button type="button" className="primary-action" onClick={() => { setSession(null); setAutonomousPlan(null) }}>Choose another repertoire</button>
        <p className="sr-only" aria-live="polite" aria-atomic="true">{localAnnouncement}</p>
      </section>
    )
  }

  if (session.phase === 'session_complete' && hasNextBatch) {
    return (
      <section className="graph-training-complete" aria-labelledby="graph-batch-title">
        <p className="eyebrow">Path batch complete</p>
        <h2 id="graph-batch-title">More audited paths are ready.</h2>
        <p>{coverage.completedPathCount.toLocaleString('en-US')} of {coverage.totalPathCount.toLocaleString('en-US')} paths completed.</p>
        {manualPacingEnabled
          ? <button type="button" className="primary-action" onClick={continueBatch}>Continue to next path batch</button>
          : <p role="status">The next batch will begin automatically.</p>}
        <p className="sr-only" aria-live="polite" aria-atomic="true">{localAnnouncement}</p>
      </section>
    )
  }

  const path = adapter.pathsById.get(session.activePathId)!
  const expected = expectedGraphTrainingMoves(adapter, session)
  const fen = graphTrainingFen(adapter, session)
  const waitingForLearner = session.phase === 'awaiting_learner_move' || session.phase === 'correction_required'
  const moveStatus = acceptedMoveStatus(session)
  const statusText = session.phase === 'correction_required'
    ? 'Correction needed'
    : session.phase === 'opponent_move_ready'
      ? 'Opponent reply'
      : session.phase === 'path_complete'
        ? 'Path complete'
        : session.selection.warmupNodeIds.includes(session.currentNodeId)
          ? 'Warm-up position'
          : session.repeatCardIds.includes(`${session.packId}::${session.currentNodeId}`)
            ? 'Repeat card'
            : session.dueCardIds.includes(`${session.packId}::${session.currentNodeId}`)
              ? 'Due card'
              : 'Practice position'
  const activePathOrdinal = Math.max(0, runPathIds.indexOf(path.id)) + 1

  const handleMove = (moveUci: string): void => {
    try {
      const next = submitGraphTrainingMove({ adapter, state: session, moveUci })
      setSession(next)
      const feedback = next.lastFeedback
      if (feedback?.review) onInferredReview?.(feedback.review)
      if (!feedback?.accepted) announce('That move is not an audited continuation here. Correct the position to continue.')
      else if (feedback.switchedPath) announce('Alternate audited branch accepted. Continuing from its exact resulting position.')
      else if (feedback.review) announce(`${feedback.review.grade} recorded for this ${feedback.review.source} card.`)
      else announce('Warm-up move accepted. Its schedule was not changed.')
    } catch (error) {
      announce(message(error))
    }
  }

  return (
    <section className="graph-training-workspace" aria-labelledby="graph-training-title" data-feature-contract={GRAPH_TRAINING_CONTRACT_ID}>
      <header className="graph-training-header">
        <div>
          <p className="eyebrow">{path.familyTags.join(' / ')}</p>
          <h2 id="graph-training-title">Continuous graph practice</h2>
          <p>Path {activePathOrdinal} of {coverage.totalPathCount} · {statusText} · move {Math.min(session.activePathNodeIndex + 1, path.nodeIds.length)} of {path.nodeIds.length}</p>
        </div>
        <div className="inline-controls">
          {onSetOrientation ? (
            <button type="button" className="secondary-button" onClick={() => onSetOrientation(orientation === 'white' ? 'black' : 'white')}>
              Flip board
            </button>
          ) : null}
          <button type="button" className="secondary-button" onClick={() => setSession(null)}>End session</button>
        </div>
      </header>
      <div className="graph-training-board">
        <ChessBoard
          fen={fen}
          orientation={orientation}
          disabled={!waitingForLearner}
          reducedMotion={reducedMotion}
          hintUci={session.usedHint ? expected[0]?.uci ?? null : null}
          lastMove={session.lastTransition && moveStatus ? { uci: session.lastTransition.moveUci, status: moveStatus } : null}
          onMove={handleMove}
          onAnnouncement={announce}
        />
      </div>
      <aside className="graph-training-context" aria-labelledby="graph-context-title">
        <p className="eyebrow">Current branch</p>
        <h3 id="graph-context-title">{path.familyTags.join(' / ')}</h3>
        <p>{statusText}</p>
        {waitingForLearner ? (
          <>
            <button
              type="button"
              className="secondary-button"
              disabled={session.usedHint || expected.length === 0}
              onClick={() => {
                setSession(markGraphTrainingHint(adapter, session))
                announce(expected.length > 0 ? 'Hint route shown.' : 'No audited route is available.')
              }}
            >
              Show hint
            </button>
            <details>
              <summary>Audited moves ({expected.length})</summary>
              <ul className="graph-move-list">
                {expected.map((edge) => (
                  <li key={edge.id}><code>{edge.san}</code><span>{Math.round(edge.evidence.conditionalUsage * 100)}% conditional usage</span></li>
                ))}
              </ul>
            </details>
          </>
        ) : session.phase === 'opponent_move_ready' && manualPacingEnabled ? (
          <button type="button" className="primary-action" onClick={playOpponentMove}>Play opponent reply</button>
        ) : session.phase === 'path_complete' && manualPacingEnabled ? (
          <button type="button" className="primary-action" onClick={continuePath}>Continue to next path</button>
        ) : <p>The next position is applied only after the current piece transition has time to finish.</p>}
        {session.lastFeedback ? (
          <div className={`graph-feedback graph-feedback-${session.lastFeedback.accepted ? 'accepted' : 'correction'}`} role={session.lastFeedback.accepted ? 'status' : 'alert'}>
            <strong>{session.lastFeedback.accepted ? 'Move accepted' : 'Correction required'}</strong>
            <span>{session.lastFeedback.classification} · {session.lastFeedback.reason.replaceAll('_', ' ')}</span>
          </div>
        ) : null}
        <dl className="graph-session-facts">
          <div><dt>Total paths</dt><dd>{coverage.totalPathCount}</dd></div>
          <div><dt>Completed paths</dt><dd>{coverage.completedPathCount}</dd></div>
          <div><dt>Remaining paths</dt><dd>{coverage.remainingPathCount}</dd></div>
          <div><dt>Due cards</dt><dd>{session.dueCardIds.length}</dd></div>
          <div><dt>Session repeats</dt><dd>{session.repeatCardIds.length}</dd></div>
        </dl>
        <details>
          <summary>Variation families ({coverage.families.length})</summary>
          <ul className="graph-move-list">
            {coverage.families.map((family) => (
              <li key={family.family}>
                <span>{family.family}</span>
                <span>{family.completedPathCount} of {family.totalPathCount} paths completed</span>
              </li>
            ))}
          </ul>
        </details>
      </aside>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{localAnnouncement}</p>
    </section>
  )
}

export function GraphTrainingBoundary({
  resource,
  dueCardIds,
  orientation,
  reducedMotion = false,
  manualPacing = false,
  onSetOrientation,
  onInferredReview,
  onPathCompleted,
  onAnnouncement,
  onRetry,
}: GraphTrainingBoundaryProps): React.JSX.Element {
  const [prepared, setPrepared] = useState<PreparedResource | null>(null)

  useEffect(() => {
    if (resource.status !== 'ready') {
      setPrepared(null)
      return
    }
    let active = true
    setPrepared({ envelope: resource.envelope, adapter: null, error: null })
    void prepareGraphTrainingAdapter(resource.envelope).then((adapter) => {
      if (active) setPrepared({ envelope: resource.envelope, adapter, error: null })
    }).catch((error: unknown) => {
      if (active) setPrepared({ envelope: resource.envelope, adapter: null, error: message(error) })
    })
    return () => { active = false }
  }, [resource])

  if (resource.status === 'disabled') {
    return <EmptyState title="Deep graph practice is not enabled" detail={resource.reason} />
  }
  if (resource.status === 'idle' || resource.status === 'loading') {
    return <LoadingState label="Loading the validated repertoire graph…" />
  }
  if (resource.status === 'error') {
    return <ErrorState title="Repertoire graph unavailable" detail={resource.error} onRetry={onRetry ?? (() => undefined)} />
  }
  if (!prepared || prepared.envelope !== resource.envelope || (!prepared.adapter && !prepared.error)) {
    return <LoadingState label="Validating graph positions, paths, and evidence…" />
  }
  if (prepared.error || !prepared.adapter) {
    return <ErrorState title="Repertoire graph rejected" detail={prepared.error ?? 'The graph failed validation.'} onRetry={onRetry ?? (() => undefined)} />
  }
  return (
    <GraphTrainingWorkspace
      adapter={prepared.adapter}
      dueCardIds={dueCardIds}
      orientation={orientation}
      reducedMotion={reducedMotion}
      manualPacing={manualPacing}
      {...(onSetOrientation ? { onSetOrientation } : {})}
      {...(onInferredReview ? { onInferredReview } : {})}
      {...(onPathCompleted ? { onPathCompleted } : {})}
      {...(onAnnouncement ? { onAnnouncement } : {})}
    />
  )
}

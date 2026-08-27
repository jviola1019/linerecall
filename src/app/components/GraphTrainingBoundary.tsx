import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import type { BoardOrientation } from '../../domain/board.ts'
import {
  GRAPH_TRAINING_CONTRACT_ID,
  applyPendingOpponentGraphMove,
  continueGraphTrainingSession,
  createAutonomousGraphTrainingPlan,
  createBoundedGraphTrainingPlan,
  createExplicitGraphSessionSelection,
  createFamilyTrainingCursorSnapshot,
  createGraphTrainingPathCompletion,
  createGraphTrainingSession,
  coverageCycleOrdinalFromId,
  deferGraphTrainingPathToCycleEnd,
  expectedGraphTrainingMoves,
  graphTrainingFen,
  graphTrainingPathLearningProgress,
  listGraphTrainingPaths,
  markGraphTrainingHint,
  nextNonemptyGraphTrainingBatch,
  overrideLastGraphTrainingReviewGrade,
  prepareGraphTrainingAdapter,
  removeTransferredPathFromFutureBatches,
  restoreGraphTrainingCycleFromCursor,
  skipCurrentGraphTrainingPath,
  submitGraphTrainingMove,
  summarizeGraphTrainingCoverage,
  type AutonomousGraphTrainingPlan,
  type GraphTrainingAdapter,
  type GraphTrainingEnvelope,
  type GraphTrainingPathCompletionV1,
  type GraphTrainingReviewInference,
  type GraphTrainingSessionState,
} from '../../domain/graph-training-session.ts'
import type { ReviewGrade } from '../../domain/progress.ts'
import {
  FamilyTrainingCursorWriteQueue,
  type FamilyTrainingJournalRepository,
} from '../../domain/family-training-journal.ts'
import type { BoardAnnotation, BoardAnnotationTone } from '../../domain/board-annotations.ts'
import { BoardAnnotationOverlay, BoardAnnotationPanel } from './BoardAnnotations.tsx'
import { ChessBoard, type BoardMoveStatus } from './ChessBoard.tsx'
import { EmptyState, ErrorState, LoadingState } from './ResourceState.tsx'
import './training-puzzle.css'

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
  onStop?: () => void
  autoStartFull?: boolean
  onAutoStartConsumed?: () => void
  autoStartPathGroupId?: string | null
  autoStartPathGroupContinuation?: boolean
  onAutoStartPathGroupConsumed?: () => void
  onCoverageScopeChange?: (
    scope: 'full' | 'selection',
    detail?: { pathGroupId?: string; continuation?: boolean },
  ) => void
  onCoverageCycleStarted?: (cycle: {
    packId: string
    coverageCycleId: string
  }) => void | Promise<void>
  onNamedVariationCycleStarted?: (cycle: {
    packId: string
    coverageCycleId: string
    pathGroupId: string
    continuation: boolean
  }) => void | Promise<void>
  onRestartFullCoverage?: (options?: { autoStart?: boolean }) => void | Promise<void>
  onRetry?: () => void
  familyId?: string
  journalRepository?: FamilyTrainingJournalRepository
  expectedCoverageCycleId?: string | null
  pathDisplayNameById?: Readonly<Record<string, string>>
  pathGroupByPathId?: Readonly<Record<string, GraphTrainingPathGroup>>
  pathGroups?: readonly GraphTrainingPathGroup[]
}

export interface GraphTrainingPathGroup {
  id: string
  label: string
  pathIds: readonly string[]
  familyPathCount?: number
}

interface PreparedResource {
  envelope: GraphTrainingEnvelope
  adapter: GraphTrainingAdapter | null
  error: string | null
}

interface CompletionWriteFailure {
  key: string
  completion: GraphTrainingPathCompletionV1
  message: string
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The graph could not be validated.'
}

function pathDisplayName(
  summary: ReturnType<typeof listGraphTrainingPaths>[number],
  pathDisplayNameById: Readonly<Record<string, string>> | undefined,
): string {
  return pathDisplayNameById?.[summary.id] ?? summary.familyTags.join(' / ')
}

function pathLabel(
  summary: ReturnType<typeof listGraphTrainingPaths>[number],
  pathDisplayNameById: Readonly<Record<string, string>> | undefined,
): string {
  return `${pathDisplayName(summary, pathDisplayNameById)} — ${summary.learnerDecisionCount} moves to learn`
}

function acceptedMoveStatus(state: GraphTrainingSessionState): BoardMoveStatus | undefined {
  const classification = state.lastFeedback?.classification
  return classification === 'book' || classification === 'playable' ? classification : undefined
}

const PATH_PAGE_SIZE = 40
const PATH_GROUP_PAGE_SIZE = 50
const NORMAL_VISUAL_SETTLE_MS = 190
const PROMOTION_VISUAL_SETTLE_MS = 360

function visualSettleDelay(moveUci: string | null | undefined, baseDelay = NORMAL_VISUAL_SETTLE_MS): number {
  return moveUci?.length === 5 ? PROMOTION_VISUAL_SETTLE_MS : baseDelay
}

function feedbackLabel(value: string): string {
  const labels: Record<string, string> = {
    book: 'Book move',
    playable: 'Playable alternative',
    inaccuracy: 'Inaccuracy',
    mistake: 'Mistake',
    unverified: 'Unverified move',
    expected_move: 'Expected continuation',
    accepted_transposition: 'Accepted transposition',
    accepted_alternate_path: 'Known alternate line',
    unsupported_move: 'Outside this opening course',
  }
  return labels[value] ?? value.replaceAll('_', ' ').replace(/^./u, (character) => character.toUpperCase())
}

function terminalLabel(value: string): string {
  const labels: Record<string, string> = {
    evidence_terminal: 'Evidence end',
    depth_capped: 'Depth limit reached',
    insufficient_sample: 'Sample threshold reached',
    quarantined: 'Quarantined',
  }
  return labels[value] ?? feedbackLabel(value)
}

function cohortSourceLabel(source: 'broadcast' | 'lichess-standard'): string {
  return source === 'broadcast' ? 'Official broadcasts' : 'Lichess rated games'
}

function principalVariationSan(epd: string, uciMoves: readonly string[]): string[] {
  const chess = new Chess(`${epd} 0 1`)
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
  onStop,
  autoStartFull = false,
  onAutoStartConsumed,
  autoStartPathGroupId,
  autoStartPathGroupContinuation = true,
  onAutoStartPathGroupConsumed,
  onCoverageScopeChange,
  onCoverageCycleStarted,
  onNamedVariationCycleStarted,
  onRestartFullCoverage,
  familyId,
  journalRepository,
  expectedCoverageCycleId,
  pathDisplayNameById,
  pathGroupByPathId,
  pathGroups,
}: Omit<GraphTrainingBoundaryProps, 'resource' | 'onRetry'> & { adapter: GraphTrainingAdapter }): React.JSX.Element {
  const paths = useMemo(() => listGraphTrainingPaths(adapter), [adapter])
  const availablePathGroups = useMemo(() => {
    const candidates = pathGroups
      ? [...pathGroups]
      : [...new Map(Object.values(pathGroupByPathId ?? {}).map((group) => [group.id, group])).values()]
    const seen = new Set<string>()
    return candidates.filter((group) => {
      if (seen.has(group.id)) return false
      seen.add(group.id)
      return group.pathIds.length > 0
    })
  }, [pathGroupByPathId, pathGroups])
  const [selectedPathId, setSelectedPathId] = useState(paths[0]?.id ?? '')
  const [selectedPathGroupId, setSelectedPathGroupId] = useState(availablePathGroups[0]?.id ?? '')
  const [pathQuery, setPathQuery] = useState('')
  const [visiblePathCount, setVisiblePathCount] = useState(PATH_PAGE_SIZE)
  const [pathGroupQuery, setPathGroupQuery] = useState('')
  const [pathGroupPage, setPathGroupPage] = useState(0)
  const [session, setSession] = useState<GraphTrainingSessionState | null>(null)
  const [autonomousPlan, setAutonomousPlan] = useState<AutonomousGraphTrainingPlan | null>(null)
  const [activeBatchIndex, setActiveBatchIndex] = useState(0)
  const [completedBeforeBatch, setCompletedBeforeBatch] = useState<string[]>([])
  const [authoritativeDueCardIds, setAuthoritativeDueCardIds] = useState<string[]>([])
  const [nextCoverageCycleOrdinal, setNextCoverageCycleOrdinal] = useState(0)
  const [manualPacingEnabled, setManualPacingEnabled] = useState(manualPacing)
  const [pendingManualReview, setPendingManualReview] = useState<GraphTrainingReviewInference | null>(null)
  const [revealedNodeId, setRevealedNodeId] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [analysisTab, setAnalysisTab] = useState<'line' | 'alternatives' | 'evidence'>('line')
  const [annotationMode, setAnnotationMode] = useState(false)
  const [annotations, setAnnotations] = useState<BoardAnnotation[]>([])
  const [annotationTone, setAnnotationTone] = useState<BoardAnnotationTone>('study')
  const [localAnnouncement, setLocalAnnouncement] = useState('')
  const [restorePending, setRestorePending] = useState(Boolean(familyId && journalRepository))
  const [restoreAttempt, setRestoreAttempt] = useState(0)
  const [persistenceError, setPersistenceError] = useState<string | null>(null)
  const [queuedCursorCount, setQueuedCursorCount] = useState(0)
  const [exitPending, setExitPending] = useState(false)
  const [startPending, setStartPending] = useState(false)
  const [boardTransitionLocked, setBoardTransitionLocked] = useState(false)
  const [generationRestoreBlocked, setGenerationRestoreBlocked] = useState(false)
  const [completionWriteFailure, setCompletionWriteFailure] = useState<CompletionWriteFailure | null>(null)
  const [completionCommitRevision, setCompletionCommitRevision] = useState(0)
  const reportedCompletionKeys = useRef(new Set<string>())
  const pendingCompletionKeys = useRef(new Set<string>())
  const autoStartHandled = useRef(false)
  const autoStartPathGroupHandled = useRef(false)
  const analysisContextRef = useRef<HTMLElement>(null)
  const analysisTabRefs = useRef(new Map<'line' | 'alternatives' | 'evidence', HTMLButtonElement>())
  const availablePathGroupsRef = useRef(availablePathGroups)
  availablePathGroupsRef.current = availablePathGroups
  const cursorWriter = useMemo(
    () => journalRepository ? new FamilyTrainingCursorWriteQueue(journalRepository) : null,
    [journalRepository],
  )
  const persistPathCompletion = useCallback(async (
    completion: GraphTrainingPathCompletionV1,
    key: string,
  ): Promise<void> => {
    if (!onPathCompleted || reportedCompletionKeys.current.has(key) || pendingCompletionKeys.current.has(key)) return
    pendingCompletionKeys.current.add(key)
    try {
      await onPathCompleted(completion)
      reportedCompletionKeys.current.add(key)
      setCompletionWriteFailure((current) => current?.key === key ? null : current)
      setCompletionCommitRevision((revision) => revision + 1)
    } catch (error) {
      const detail = message(error)
      setCompletionWriteFailure({ key, completion, message: detail })
      setLocalAnnouncement(`Path completion could not be saved: ${detail}`)
      onAnnouncement?.(`Path completion could not be saved: ${detail}`)
    } finally {
      pendingCompletionKeys.current.delete(key)
    }
  }, [onAnnouncement, onPathCompleted])
  const announce = (value: string): void => {
    setLocalAnnouncement(value)
    onAnnouncement?.(value)
  }
  const announceLocal = (value: string): void => {
    // Routine autoplay belongs to this workspace live region. Keeping it
    // local prevents a later opponent transition from erasing a higher-value
    // global storage or validation announcement.
    setLocalAnnouncement(value)
  }

  const toggleAnnotationMode = (): void => {
    setAnnotationMode((current) => {
      announce(current
        ? 'Annotate mode off. Moves resumed.'
        : 'Annotate mode on. Moves are paused.')
      return !current
    })
  }

  const openMobileAnalysis = (tab: 'line' | 'alternatives' | 'evidence'): void => {
    setAnalysisTab(tab)
    const context = analysisContextRef.current
    context?.focus({ preventScroll: true })
    requestAnimationFrame(() => {
      analysisContextRef.current?.scrollIntoView?.({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'start',
      })
    })
    announce(tab === 'evidence'
      ? 'Move evidence opened.'
      : tab === 'alternatives'
        ? 'Known alternative lines opened.'
        : 'Current line opened.')
  }

  const handleAnalysisTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: 'line' | 'alternatives' | 'evidence',
  ): void => {
    const tabs = ['line', 'alternatives', 'evidence'] as const
    const currentIndex = tabs.indexOf(currentTab)
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = tabs.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const next = tabs[nextIndex]!
    setAnalysisTab(next)
    analysisTabRefs.current.get(next)?.focus()
  }

  useEffect(() => {
    if (!paths.some(({ id }) => id === selectedPathId)) setSelectedPathId(paths[0]?.id ?? '')
  }, [paths, selectedPathId])
  useEffect(() => {
    if (!availablePathGroups.some(({ id }) => id === selectedPathGroupId)) {
      setSelectedPathGroupId(availablePathGroups[0]?.id ?? '')
    }
  }, [availablePathGroups, selectedPathGroupId])

  useEffect(() => setVisiblePathCount(PATH_PAGE_SIZE), [pathQuery])
  useEffect(() => setPathGroupPage(0), [pathGroupQuery])

  useEffect(() => setManualPacingEnabled(manualPacing), [manualPacing])
  useEffect(() => {
    if (manualPacingEnabled || !pendingManualReview) return
    onInferredReview?.(pendingManualReview)
    announce(`${pendingManualReview.grade} recorded for this ${pendingManualReview.source} card.`)
    setPendingManualReview(null)
  }, [manualPacingEnabled, pendingManualReview])
  useEffect(() => {
    setRevealedNodeId(null)
  }, [session?.currentNodeId])

  useEffect(() => {
    let active = true
    if (Boolean(familyId) !== Boolean(journalRepository)) {
      setRestorePending(false)
      setPersistenceError('Family progress needs both a family identifier and a progress repository.')
      return () => { active = false }
    }
    if (!familyId || !journalRepository) {
      setRestorePending(false)
      return () => { active = false }
    }
    setRestorePending(true)
    setGenerationRestoreBlocked(false)
    setPersistenceError(null)
    const cursorScope = {
      releaseId: adapter.graph.releaseId,
      familyId,
      packId: adapter.graph.pack.id,
      side: adapter.graph.pack.side,
    } as const
    const cursorRequest = typeof expectedCoverageCycleId === 'string'
      ? journalRepository.loadCursor({
          ...cursorScope,
          coverageCycleId: expectedCoverageCycleId,
        })
      : journalRepository.loadLatestCursor(cursorScope)
    void cursorRequest.then((cursor) => {
      if (!active) return
      if (expectedCoverageCycleId === null) {
        if (cursor) {
          const ordinal = coverageCycleOrdinalFromId(adapter.graph.pack.id, cursor.coverageCycleId)
          setNextCoverageCycleOrdinal(ordinal + 1)
        }
        setRestorePending(false)
        announce(cursor
          ? 'An older course-section checkpoint was left untouched; this practice run will start a new section.'
          : 'This course section is ready to join the active opening run.')
        return
      }
      if (!cursor) {
        if (typeof expectedCoverageCycleId === 'string') {
          setGenerationRestoreBlocked(true)
          setPersistenceError('The active opening run references a course-section checkpoint that is unavailable.')
          announce('Opening practice is blocked because its saved course section is unavailable.')
        }
        setRestorePending(false)
        return
      }
      const restored = restoreGraphTrainingCycleFromCursor({ adapter, familyId, cursor })
      const ordinal = coverageCycleOrdinalFromId(adapter.graph.pack.id, cursor.coverageCycleId)
      for (const pathId of cursor.completedPathIds) {
        reportedCompletionKeys.current.add(
          `${cursor.releaseId}\0${adapter.graph.pack.id}\0${cursor.coverageCycleId}\0${pathId}`,
        )
      }
      setAutonomousPlan(restored.plan)
      setSession(restored.session)
      setActiveBatchIndex(restored.activeBatchIndex)
      setCompletedBeforeBatch(restored.completedBeforeBatch)
      setAuthoritativeDueCardIds(restored.authoritativeDueCardIds)
      setNextCoverageCycleOrdinal(ordinal + 1)
      if (restored.plan.totalPathIds.length === adapter.graph.paths.length) {
        onCoverageScopeChange?.('full')
      } else {
        const restoredPathIds = new Set(restored.plan.totalPathIds)
        const restoredGroup = availablePathGroupsRef.current.find((group) =>
          group.pathIds.length === restoredPathIds.size
          && group.pathIds.every((pathId) => restoredPathIds.has(pathId)))
        onCoverageScopeChange?.('selection', restoredGroup
          ? { pathGroupId: restoredGroup.id, continuation: true }
          : undefined)
      }
      setRestorePending(false)
      announce(cursor.pendingPathIds.length > 0
        ? `Resumed family coverage with ${cursor.pendingPathIds.length} unfinished paths.`
        : 'Restored the completed practice round.')
    }).catch((error: unknown) => {
      if (!active) return
      setRestorePending(false)
      setGenerationRestoreBlocked(true)
      setPersistenceError(`Saved family coverage could not be restored: ${message(error)}`)
      announce(`Saved family coverage could not be restored: ${message(error)}`)
    })
    return () => { active = false }
  }, [adapter, expectedCoverageCycleId, familyId, journalRepository, restoreAttempt])

  useEffect(() => {
    if (
      restorePending
      || !cursorWriter
      || !familyId
      || !session
      || !autonomousPlan
      || pendingManualReview
    ) return
    try {
      const cursor = createFamilyTrainingCursorSnapshot({
        adapter,
        familyId,
        plan: autonomousPlan,
        activeBatchIndex,
        completedBeforeBatch,
        session,
        authoritativeDueCardIds,
      })
      void cursorWriter.enqueue(cursor).then((result) => {
        setQueuedCursorCount(result.pendingCount)
        if (result.error) {
          setPersistenceError(`Family progress is waiting to be saved: ${result.error.message}`)
          announce(`Family progress is waiting to be saved. ${result.pendingCount} update${result.pendingCount === 1 ? '' : 's'} queued.`)
        } else {
          setPersistenceError(null)
        }
      })
    } catch (error) {
      setPersistenceError(`Family progress snapshot was rejected: ${message(error)}`)
    }
  }, [
    activeBatchIndex,
    adapter,
    authoritativeDueCardIds,
    autonomousPlan,
    completedBeforeBatch,
    cursorWriter,
    familyId,
    restorePending,
    session,
    pendingManualReview,
  ])

  useEffect(() => {
    if (!session || !onPathCompleted || pendingManualReview) return
    for (const pathId of session.completedPathIds) {
      const key = `${session.releaseId}\0${session.packId}\0${session.selection.coverageCycleId}\0${pathId}`
      if (reportedCompletionKeys.current.has(key) || pendingCompletionKeys.current.has(key)) continue
      try {
        const completion = createGraphTrainingPathCompletion({
          adapter,
          state: session,
          pathId,
          completedAt: new Date().toISOString(),
        })
        void persistPathCompletion(completion, key)
      } catch (error) {
        announce(`Path completion could not be recorded: ${message(error)}`)
      }
    }
  }, [adapter, onPathCompleted, pendingManualReview, persistPathCompletion, session?.completedPathIds, session?.releaseId])

  useEffect(() => {
    if (paused || manualPacingEnabled || pendingManualReview || session?.phase !== 'opponent_move_ready') return
    const timeout = setTimeout(() => {
      setSession((current) => {
        if (!current || current.phase !== 'opponent_move_ready') return current
        const next = applyPendingOpponentGraphMove(adapter, current)
        setBoardTransitionLocked(true)
        announceLocal(`${next.lastTransition?.moveUci ?? 'Opponent move'} played for the opponent.`)
        return next
      })
    }, reducedMotion ? 0 : visualSettleDelay(session.lastTransition?.moveUci))
    return () => clearTimeout(timeout)
  }, [adapter, manualPacingEnabled, paused, pendingManualReview, reducedMotion, session?.phase, session?.currentNodeId, session?.lastTransition?.moveUci])

  useEffect(() => {
    if (!boardTransitionLocked) return
    if (reducedMotion) {
      setBoardTransitionLocked(false)
      return
    }
    const timeout = setTimeout(
      () => setBoardTransitionLocked(false),
      visualSettleDelay(session?.lastTransition?.moveUci),
    )
    return () => clearTimeout(timeout)
  }, [boardTransitionLocked, reducedMotion, session?.lastTransition?.moveUci])

  useEffect(() => {
    if (paused || manualPacingEnabled || pendingManualReview || session?.phase !== 'path_complete') return
    const completionKey = `${session.releaseId}\0${session.packId}\0${session.selection.coverageCycleId}\0${session.activePathId}`
    if (onPathCompleted && !reportedCompletionKeys.current.has(completionKey)) return
    const timeout = setTimeout(() => {
      setSession((current) => {
        if (!current || current.phase !== 'path_complete') return current
        const next = continueGraphTrainingSession(adapter, current)
        announceLocal(next.phase === 'session_complete' ? 'Variation set complete.' : 'Next variation started.')
        return next
      })
    }, reducedMotion ? 0 : visualSettleDelay(session.lastTransition?.moveUci, 240))
    return () => clearTimeout(timeout)
  }, [adapter, completionCommitRevision, manualPacingEnabled, onPathCompleted, paused, pendingManualReview, reducedMotion, session?.phase, session?.activePathId, session?.lastTransition?.moveUci])

  useEffect(() => {
    if (paused || manualPacingEnabled || pendingManualReview || session?.phase !== 'session_complete' || !autonomousPlan) return
    const nextBatch = nextNonemptyGraphTrainingBatch(autonomousPlan, activeBatchIndex)
    if (!nextBatch) return
    const timeout = setTimeout(() => {
      const completed = [...new Set([...completedBeforeBatch, ...session.completedPathIds])]
      const selection = createExplicitGraphSessionSelection({
        adapter,
        pathIds: nextBatch.pathIds,
        dueCardIds: session.dueCardIds,
        coverageCycleOrdinal: autonomousPlan.coverageCycleOrdinal,
      })
      setCompletedBeforeBatch(completed)
      setActiveBatchIndex(nextBatch.batchIndex)
      setSession(createGraphTrainingSession({ adapter, selection }))
      announce(`Continuing with variation set ${nextBatch.batchIndex + 1} of ${autonomousPlan.pathIdBatches.length}.`)
    }, reducedMotion ? 0 : 240)
    return () => clearTimeout(timeout)
  }, [
    activeBatchIndex,
    adapter,
    autonomousPlan,
    completedBeforeBatch,
    manualPacingEnabled,
    paused,
    pendingManualReview,
    reducedMotion,
    session,
  ])

  const startSelected = (): void => {
    try {
      const cycleOrdinal = nextCoverageCycleOrdinal
      const selection = createExplicitGraphSessionSelection({
        adapter,
        pathIds: [selectedPathId],
        dueCardIds,
        coverageCycleOrdinal: cycleOrdinal,
      })
      const plan: AutonomousGraphTrainingPlan = {
        releaseId: adapter.graph.releaseId,
        packId: adapter.graph.pack.id,
        coverageCycleOrdinal: cycleOrdinal,
        totalPathIds: [...selection.includedPathIds],
        pathIdBatches: [[...selection.includedPathIds]],
      }
      setAutonomousPlan(plan)
      setActiveBatchIndex(0)
      setCompletedBeforeBatch([])
      setAuthoritativeDueCardIds([...dueCardIds])
      setNextCoverageCycleOrdinal(cycleOrdinal + 1)
      setSession(createGraphTrainingSession({ adapter, selection, preferredPathId: selectedPathId }))
      onCoverageScopeChange?.('selection')
      announce('One variation is ready.')
    } catch (error) {
      announce(message(error))
    }
  }

  const startSelectedVariation = async (
    pathGroupId = selectedPathGroupId,
    continuation = false,
  ): Promise<boolean> => {
    if (startPending) return false
    const group = availablePathGroups.find(({ id }) => id === pathGroupId)
      ?? pathGroupByPathId?.[selectedPathId]
    const selectedPathIds = [...new Set(group?.pathIds ?? [selectedPathId])]
    try {
      const cycleOrdinal = nextCoverageCycleOrdinal
      const plan = createBoundedGraphTrainingPlan({
        adapter,
        pathIds: selectedPathIds,
        dueCardIds,
        coverageCycleOrdinal: cycleOrdinal,
      })
      const firstPathIds = plan.pathIdBatches[0]
      if (!firstPathIds) throw new Error('The selected variation has no practice paths')
      const selection = createExplicitGraphSessionSelection({
        adapter,
        pathIds: firstPathIds,
        dueCardIds,
        coverageCycleOrdinal: cycleOrdinal,
      })
      if (!group && onNamedVariationCycleStarted) {
        throw new Error('Named-variation persistence requires an exact promoted branch')
      }
      setStartPending(true)
      if (group) {
        await onNamedVariationCycleStarted?.({
          packId: adapter.graph.pack.id,
          coverageCycleId: selection.coverageCycleId,
          pathGroupId: group.id,
          continuation,
        })
      }
      setAutonomousPlan(plan)
      setActiveBatchIndex(0)
      setCompletedBeforeBatch([])
      setAuthoritativeDueCardIds([...dueCardIds])
      setNextCoverageCycleOrdinal(cycleOrdinal + 1)
      setSession(createGraphTrainingSession({
        adapter,
        selection,
        preferredPathId: selectedPathId,
      }))
      onCoverageScopeChange?.('selection', group
        ? { pathGroupId: group.id, continuation }
        : undefined)
      announce(`${selectedPathIds.length} ${selectedPathIds.length === 1 ? 'path' : 'paths'} queued for ${group?.label ?? 'this variation'}.`)
      return true
    } catch (error) {
      setPersistenceError(`Named variation could not start: ${message(error)}`)
      announce(message(error))
      return false
    } finally {
      setStartPending(false)
    }
  }

  const startAll = (): void => {
    if (startPending) return
    try {
      const cycleOrdinal = nextCoverageCycleOrdinal
      const plan = createAutonomousGraphTrainingPlan({
        adapter,
        dueCardIds,
        coverageCycleOrdinal: cycleOrdinal,
      })
      const firstPathIds = plan.pathIdBatches[0]
      if (!firstPathIds) throw new Error('No path is available for continuous practice')
      const selection = createExplicitGraphSessionSelection({
        adapter,
        pathIds: firstPathIds,
        dueCardIds,
        coverageCycleOrdinal: plan.coverageCycleOrdinal,
      })
      const begin = (): void => {
        setAutonomousPlan(plan)
        setActiveBatchIndex(0)
        setCompletedBeforeBatch([])
        setAuthoritativeDueCardIds([...dueCardIds])
        setNextCoverageCycleOrdinal(cycleOrdinal + 1)
        setSession(createGraphTrainingSession({ adapter, selection }))
        onCoverageScopeChange?.('full')
        announce(`${plan.totalPathIds.length} paths queued. Variations will continue automatically.`)
      }
      const replacesBoundCycle = typeof expectedCoverageCycleId === 'string'
      if (replacesBoundCycle && !onRestartFullCoverage) {
        throw new Error('A bound full-family cycle cannot be replaced without starting a new family generation')
      }
      if (!onCoverageCycleStarted && !replacesBoundCycle) {
        begin()
        return
      }
      setStartPending(true)
      const restartGeneration = replacesBoundCycle
        ? Promise.resolve(onRestartFullCoverage?.({ autoStart: false }))
        : Promise.resolve()
      void restartGeneration.then(() =>
        onCoverageCycleStarted?.({
          packId: adapter.graph.pack.id,
          coverageCycleId: selection.coverageCycleId,
        }),
      ).then(() => {
        setPersistenceError(null)
        begin()
      }).catch((error: unknown) => {
        setPersistenceError(`Family practice could not start: ${message(error)}`)
        announce('Practice did not start because progress could not be saved.')
      }).finally(() => {
        setStartPending(false)
      })
    } catch (error) {
      announce(message(error))
    }
  }

  useEffect(() => {
    if (!autoStartFull) {
      autoStartHandled.current = false
      return
    }
    if (restorePending || generationRestoreBlocked || autoStartHandled.current) return
    autoStartHandled.current = true
    if (!session || session.phase === 'session_complete') startAll()
    onAutoStartConsumed?.()
  }, [autoStartFull, generationRestoreBlocked, onAutoStartConsumed, restorePending, session])

  useEffect(() => {
    if (!autoStartPathGroupId) {
      autoStartPathGroupHandled.current = false
      return
    }
    if (
      restorePending
      || generationRestoreBlocked
      || autoStartPathGroupHandled.current
      || (session && session.phase !== 'session_complete')
    ) return
    autoStartPathGroupHandled.current = true
    setSelectedPathGroupId(autoStartPathGroupId)
    void startSelectedVariation(autoStartPathGroupId, autoStartPathGroupContinuation).then((started) => {
      if (started) onAutoStartPathGroupConsumed?.()
      else autoStartPathGroupHandled.current = false
    })
  }, [
    autoStartPathGroupId,
    autoStartPathGroupContinuation,
    generationRestoreBlocked,
    onAutoStartPathGroupConsumed,
    restorePending,
    session,
  ])

  const playOpponentMove = (): void => {
    if (pendingManualReview) {
      announce('Choose a recall grade before the opponent reply.')
      return
    }
    setSession((current) => {
      if (!current || current.phase !== 'opponent_move_ready') return current
      const next = applyPendingOpponentGraphMove(adapter, current)
      setBoardTransitionLocked(true)
      announceLocal(`${next.lastTransition?.moveUci ?? 'Opponent move'} played for the opponent.`)
      return next
    })
  }

  const continuePath = (): void => {
    if (pendingManualReview) {
      announce('Choose a recall grade before the next variation.')
      return
    }
    setSession((current) => {
      if (!current || current.phase !== 'path_complete') return current
      const completionKey = `${current.releaseId}\0${current.packId}\0${current.selection.coverageCycleId}\0${current.activePathId}`
      if (onPathCompleted && !reportedCompletionKeys.current.has(completionKey)) {
        announce('The next variation will start after this completion is saved.')
        return current
      }
      const next = continueGraphTrainingSession(adapter, current)
      announceLocal(next.phase === 'session_complete' ? 'Variation set complete.' : 'Next variation started.')
      return next
    })
  }

  const continueBatch = (): void => {
    if (!session || session.phase !== 'session_complete' || !autonomousPlan) return
    const nextBatch = nextNonemptyGraphTrainingBatch(autonomousPlan, activeBatchIndex)
    if (!nextBatch) return
    const completed = [...new Set([...completedBeforeBatch, ...session.completedPathIds])]
    const selection = createExplicitGraphSessionSelection({
      adapter,
      pathIds: nextBatch.pathIds,
      dueCardIds: session.dueCardIds,
      coverageCycleOrdinal: autonomousPlan.coverageCycleOrdinal,
    })
    setCompletedBeforeBatch(completed)
    setActiveBatchIndex(nextBatch.batchIndex)
    setSession(createGraphTrainingSession({ adapter, selection }))
    announce(`Continuing with variation set ${nextBatch.batchIndex + 1} of ${autonomousPlan.pathIdBatches.length}.`)
  }

  const skipPath = (): void => {
    if (!session) return
    const hasPendingPathInBatch = session.pendingPathIds.some((pathId) =>
      pathId !== session.activePathId && !session.completedPathIds.includes(pathId))
    if (hasPendingPathInBatch) {
      try {
        setSession(skipCurrentGraphTrainingPath(adapter, session))
        announce('Variation moved to the end of this practice round.')
      } catch (error) {
        announce(message(error))
      }
      return
    }
    if (!autonomousPlan) {
      announce('No unfinished variation is available to skip to.')
      return
    }
    try {
      const deferredPlan = deferGraphTrainingPathToCycleEnd({
        plan: autonomousPlan,
        activeBatchIndex,
        pathId: session.activePathId,
      })
      const nextBatch = nextNonemptyGraphTrainingBatch(deferredPlan, activeBatchIndex)
      if (!nextBatch) throw new Error('No unfinished variation is available to skip to')
      const completed = [...new Set([...completedBeforeBatch, ...session.completedPathIds])]
      const selection = createExplicitGraphSessionSelection({
        adapter,
        pathIds: nextBatch.pathIds,
        dueCardIds: session.dueCardIds,
        coverageCycleOrdinal: deferredPlan.coverageCycleOrdinal,
      })
      setAutonomousPlan(deferredPlan)
      setCompletedBeforeBatch(completed)
      setActiveBatchIndex(nextBatch.batchIndex)
      setSession(createGraphTrainingSession({ adapter, selection }))
      announce('Variation moved behind the remaining path batches.')
    } catch (error) {
      announce(message(error))
    }
  }

  const retryPersistence = (): void => {
    if (cursorWriter?.pendingCount) {
      void cursorWriter.flush().then((result) => {
        setQueuedCursorCount(result.pendingCount)
        if (result.error) {
          setPersistenceError(`Family progress is waiting to be saved: ${result.error.message}`)
        } else {
          setPersistenceError(null)
          announce('Queued family progress was saved.')
        }
      })
      return
    }
    setRestoreAttempt((attempt) => attempt + 1)
  }

  const persistBeforeExit = async (
    action: () => void | Promise<void>,
    successAnnouncement: string,
  ): Promise<void> => {
    if (exitPending) return
    if (pendingManualReview) {
      announce('Choose a recall grade before leaving this position.')
      return
    }
    if (!cursorWriter || !familyId || !session || !autonomousPlan) {
      await action()
      announce(successAnnouncement)
      return
    }
    setExitPending(true)
    try {
      const cursor = createFamilyTrainingCursorSnapshot({
        adapter,
        familyId,
        plan: autonomousPlan,
        activeBatchIndex,
        completedBeforeBatch,
        session,
        authoritativeDueCardIds,
      })
      const result = await cursorWriter.enqueue(cursor)
      setQueuedCursorCount(result.pendingCount)
      if (result.error || result.pendingCount > 0) {
        const failure = result.error?.message ?? 'The latest practice progress is still waiting to save.'
        setPersistenceError(`Family progress is waiting to be saved: ${failure}`)
        announce('Training stayed open because the latest family progress was not saved.')
        return
      }
      setPersistenceError(null)
      await action()
      announce(successAnnouncement)
    } catch (error) {
      setPersistenceError(`Family progress could not be prepared for exit: ${message(error)}`)
      announce('Training stayed open because the latest family progress was not saved.')
    } finally {
      setExitPending(false)
    }
  }

  const persistenceNotice = persistenceError ? (
    <div className="inline-warning error-warning" role="alert">
      <strong>Family progress is not fully saved.</strong>
      <span>{persistenceError}</span>
      {queuedCursorCount > 0 ? <span>{queuedCursorCount} progress change{queuedCursorCount === 1 ? '' : 's'} waiting to be saved.</span> : null}
      {(journalRepository && familyId) ? (
        <button type="button" className="secondary-button" onClick={retryPersistence}>Retry saving progress</button>
      ) : null}
    </div>
  ) : null

  const completionNotice = completionWriteFailure ? (
    <div className="inline-warning error-warning" role="alert">
      <strong>This completed variation is not saved yet.</strong>
      <span>{completionWriteFailure.message}</span>
      <button
        type="button"
        className="secondary-button"
        onClick={() => { void persistPathCompletion(completionWriteFailure.completion, completionWriteFailure.key) }}
      >
        Retry this variation
      </button>
    </div>
  ) : null

  if (restorePending) {
    return <LoadingState label="Restoring saved family coverage…" />
  }

  if (paths.length === 0) {
    return <EmptyState title="No practice lines available" detail="This part of the opening has no variations ready to practice." />
  }

  if (!session) {
    const normalizedQuery = pathQuery.trim().toLocaleLowerCase('en-US')
    const filteredPaths = normalizedQuery === ''
      ? paths
      : paths.filter((path) => pathLabel(path, pathDisplayNameById).toLocaleLowerCase('en-US').includes(normalizedQuery))
    const visiblePaths = filteredPaths.slice(0, visiblePathCount)
    const normalizedPathGroupQuery = pathGroupQuery.trim().toLocaleLowerCase('en-US')
    const filteredPathGroups = normalizedPathGroupQuery === ''
      ? availablePathGroups
      : availablePathGroups.filter(({ label }) =>
          label.toLocaleLowerCase('en-US').includes(normalizedPathGroupQuery))
    const pathGroupPageCount = Math.max(1, Math.ceil(filteredPathGroups.length / PATH_GROUP_PAGE_SIZE))
    const boundedPathGroupPage = Math.min(pathGroupPage, pathGroupPageCount - 1)
    const pathGroupPageStart = boundedPathGroupPage * PATH_GROUP_PAGE_SIZE
    const visiblePathGroups = filteredPathGroups.slice(
      pathGroupPageStart,
      pathGroupPageStart + PATH_GROUP_PAGE_SIZE,
    )
    return (
      <section className="graph-training-catalog" aria-labelledby="graph-path-title">
        {persistenceNotice}
        <header>
          <p className="eyebrow">Choose what to practice</p>
          <h2 id="graph-path-title">Practice this opening</h2>
          <p>Choose once. LineRecall continues through every included variation without stopping for grades.</p>
        </header>
        <div className="practice-scope-grid" aria-label="Practice scope options">
          <article data-scope="family">
            <strong>Full family</strong>
            <span>Every available variation, including less common branches.</span>
          </article>
          <article data-scope="variation">
            <strong>Named variation</strong>
            <span>Every distinct route assigned to one named branch.</span>
          </article>
          <article data-scope="path">
            <strong>Single path</strong>
            <span>One exact line for focused study.</span>
          </article>
        </div>
        <label className="graph-path-search">
          <span>Find a variation</span>
          <input
            type="search"
            value={pathQuery}
            maxLength={128}
            placeholder="Name or branch"
            onChange={(event) => setPathQuery(event.currentTarget.value)}
          />
        </label>
        <p className="field-help" role="status">
          {filteredPaths.length.toLocaleString('en-US')} matching line{filteredPaths.length === 1 ? '' : 's'}.
        </p>
        <ul className="graph-path-picker" aria-label="Variation paths">
          {visiblePaths.map((path) => (
            <li key={path.id}>
              <button
                type="button"
                className="graph-path-option"
                aria-pressed={selectedPathId === path.id}
                onClick={() => setSelectedPathId(path.id)}
              >
                <span>{pathDisplayName(path, pathDisplayNameById)}</span>
                <small>{path.learnerDecisionCount} moves to learn</small>
              </button>
            </li>
          ))}
        </ul>
        {visiblePaths.length < filteredPaths.length ? (
          <button
            type="button"
            className="text-button"
            onClick={() => setVisiblePathCount((count) => Math.min(count + PATH_PAGE_SIZE, filteredPaths.length))}
          >
            Show {Math.min(PATH_PAGE_SIZE, filteredPaths.length - visiblePaths.length)} more lines
          </button>
        ) : null}
        {availablePathGroups.length > 0 ? (
          <section className="graph-variation-chooser" aria-labelledby="graph-variation-chooser-title">
            <h3 id="graph-variation-chooser-title">Named variation</h3>
            <label className="graph-path-search">
              <span>Find a named variation</span>
              <input
                type="search"
                value={pathGroupQuery}
                maxLength={128}
                placeholder="Search by name"
                onChange={(event) => setPathGroupQuery(event.currentTarget.value)}
              />
            </label>
            <p className="field-help" role="status">
              {filteredPathGroups.length === 0
                ? 'No named variations match.'
                : `Showing ${pathGroupPageStart + 1}–${pathGroupPageStart + visiblePathGroups.length} of ${filteredPathGroups.length} named variations.`}
            </p>
            <ul className="graph-path-group-picker" aria-label="Named variations">
              {visiblePathGroups.map((group) => (
                <li key={group.id}>
                  <button
                    type="button"
                    aria-pressed={selectedPathGroupId === group.id}
                    onClick={() => setSelectedPathGroupId(group.id)}
                  >
                    <strong>{group.label}</strong>
                    <span>
                      {group.pathIds.length} {group.pathIds.length === 1 ? 'route' : 'routes'} here
                      {group.familyPathCount && group.familyPathCount !== group.pathIds.length
                        ? ` · ${group.familyPathCount} across the opening`
                        : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {pathGroupPageCount > 1 ? (
              <nav className="graph-path-group-pagination" aria-label="Named variation result pages">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={boundedPathGroupPage === 0}
                  onClick={() => setPathGroupPage((page) => Math.max(0, page - 1))}
                >
                  Previous
                </button>
                <span>Page {boundedPathGroupPage + 1} of {pathGroupPageCount}</span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={boundedPathGroupPage + 1 >= pathGroupPageCount}
                  onClick={() => setPathGroupPage((page) => Math.min(pathGroupPageCount - 1, page + 1))}
                >
                  Next
                </button>
              </nav>
            ) : null}
          </section>
        ) : null}
        <div className="inline-controls">
          <button type="button" className="primary-action" disabled={startPending} onClick={startAll}>
            {startPending ? 'Saving practice…' : 'Start full opening'}
          </button>
          {availablePathGroups.length > 0 ? (
            <button type="button" className="secondary-button" disabled={startPending} onClick={() => { void startSelectedVariation() }}>
              {startPending ? 'Saving variation…' : 'Practice selected variation'}
            </button>
          ) : null}
          <button type="button" className="secondary-button" onClick={startSelected}>Practice selected line</button>
        </div>
        <label className="toggle-row">
          <input type="checkbox" checked={manualPacingEnabled} onChange={(event) => setManualPacingEnabled(event.currentTarget.checked)} />
          <span><strong>Manual pacing</strong> · pause after each move and opponent reply</span>
        </label>
        <p className="field-help">Move evidence and engine checks are documented in Data &amp; Licenses.</p>
        {paths.length > 1_000 ? <p className="field-help">Variations continue in smaller groups; all {paths.length.toLocaleString('en-US')} remain available.</p> : null}
        <p className="sr-only" aria-live="polite" aria-atomic="true">{localAnnouncement}</p>
      </section>
    )
  }

  const runPathIds = autonomousPlan?.totalPathIds ?? session.selection.includedPathIds
  const overallCompletedPathIds = [...new Set([...completedBeforeBatch, ...session.completedPathIds])]
  const coverage = summarizeGraphTrainingCoverage({ adapter, includedPathIds: runPathIds, completedPathIds: overallCompletedPathIds })
  const hasNextBatch = autonomousPlan
    ? nextNonemptyGraphTrainingBatch(autonomousPlan, activeBatchIndex) !== null
    : false

  if (session.phase === 'session_complete' && !hasNextBatch) {
    return (
      <section className="graph-training-complete" aria-labelledby="graph-complete-title">
        {persistenceNotice}
        {completionNotice}
        <p className="eyebrow">Session complete</p>
        <h2 id="graph-complete-title">Every selected variation is complete.</h2>
        <p>{coverage.completedPathCount.toLocaleString('en-US')} of {coverage.totalPathCount.toLocaleString('en-US')} variations practiced. Warm-up moves did not change your review schedule.</p>
        <div className="inline-controls">
          <button
            type="button"
            className="primary-action"
            disabled={exitPending}
            onClick={() => {
              if (!onRestartFullCoverage) {
                startAll()
                return
              }
              void persistBeforeExit(
                onRestartFullCoverage,
                'The completed cycle was saved. Starting a new full-family cycle.',
              )
            }}
          >
            Start a new practice round
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={exitPending}
            onClick={() => {
              void persistBeforeExit(() => {
                setSession(null)
                setAutonomousPlan(null)
              }, 'Variation chooser opened. Saved progress was kept.')
            }}
          >
            Choose variations
          </button>
        </div>
        <p className="sr-only" aria-live="polite" aria-atomic="true">{localAnnouncement}</p>
      </section>
    )
  }

  if (session.phase === 'session_complete' && hasNextBatch) {
    return (
      <section className="graph-training-complete" aria-labelledby="graph-batch-title">
        {persistenceNotice}
        {completionNotice}
        <p className="eyebrow">Path batch complete</p>
        <h2 id="graph-batch-title">More variations are ready.</h2>
        <p>{coverage.completedPathCount.toLocaleString('en-US')} of {coverage.totalPathCount.toLocaleString('en-US')} variations practiced.</p>
        {manualPacingEnabled
          ? <button type="button" className="primary-action" onClick={continueBatch}>Continue to next path batch</button>
          : <p role="status">The next batch will begin automatically.</p>}
        <p className="sr-only" aria-live="polite" aria-atomic="true">{localAnnouncement}</p>
      </section>
    )
  }

  const path = adapter.pathsById.get(session.activePathId)!
  const pathLearning = graphTrainingPathLearningProgress(adapter, session)
  const expected = expectedGraphTrainingMoves(adapter, session)
  const currentNode = adapter.nodesById.get(session.currentNodeId)!
  const lineRevealed = session.usedHint || revealedNodeId === session.currentNodeId
  const currentEdges = currentNode.outgoingEdgeIds
    .map((edgeId) => adapter.edgesById.get(edgeId))
    .filter((edge) => edge !== undefined)
  const continuationEdges = path.edgeIds
    .slice(session.activePathNodeIndex, session.activePathNodeIndex + 10)
    .map((edgeId) => adapter.edgesById.get(edgeId))
    .filter((edge) => edge !== undefined)
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
  const canSkipPath = session.pendingPathIds.some((pathId) =>
    pathId !== session.activePathId && !session.completedPathIds.includes(pathId))
    || Boolean(autonomousPlan && nextNonemptyGraphTrainingBatch(autonomousPlan, activeBatchIndex))
  const activeCompletionKey = `${session.releaseId}\0${session.packId}\0${session.selection.coverageCycleId}\0${session.activePathId}`
  const activePathCompletionSaved = session.phase !== 'path_complete'
    || !onPathCompleted
    || reportedCompletionKeys.current.has(activeCompletionKey)

  const handleMove = (moveUci: string): void => {
    try {
      const next = submitGraphTrainingMove({ adapter, state: session, moveUci })
      const feedback = next.lastFeedback
      // React batches both updates from this input event. The functional plan
      // update avoids a stale closure while keeping the inferred review ahead
      // of the post-commit cursor writer effect.
      setSession(next)
      if (feedback?.switchedPath) {
        setAutonomousPlan((current) => current ? removeTransferredPathFromFutureBatches({
          plan: current,
          activeBatchIndex,
          transferredPathId: next.activePathId,
        }) : current)
      }
      if (feedback?.review) {
        if (manualPacingEnabled) setPendingManualReview(feedback.review)
        else onInferredReview?.(feedback.review)
      }
      if (!feedback?.accepted) announce('That move is not part of this practice line. Correct the position to continue.')
      else if (feedback.switchedPath) announce('Known alternate line accepted. Continuing from the resulting position.')
      else if (feedback.review && manualPacingEnabled) announce(`Move accepted. Confirm the suggested ${feedback.review.grade} grade to continue.`)
      else if (feedback.review) announce(`${feedback.review.grade} recorded for this ${feedback.review.source} card.`)
      else announce('Warm-up move accepted. Its schedule was not changed.')
    } catch (error) {
      announce(message(error))
    }
  }

  const confirmManualGrade = (grade: ReviewGrade): void => {
    if (!pendingManualReview) return
    try {
      const adjusted = overrideLastGraphTrainingReviewGrade(session, grade)
      const review = adjusted.lastFeedback?.review
      if (!review) throw new Error('The accepted move no longer has a review to confirm')
      setSession(adjusted)
      setPendingManualReview(null)
      onInferredReview?.(review)
      announce(`${grade} recorded. Continue when ready.`)
    } catch (error) {
      announce(message(error))
    }
  }

  const revealCurrentLine = (): void => {
    setSession(markGraphTrainingHint(adapter, session))
    setRevealedNodeId(session.currentNodeId)
    announce(expected.length > 0 ? 'Current line revealed. This move will be graded Hard.' : 'No continuation is available.')
  }

  return (
    <section className="graph-training-workspace" aria-labelledby="graph-training-title" data-feature-contract={GRAPH_TRAINING_CONTRACT_ID}>
      {persistenceNotice}
      {completionNotice}
      <header className="graph-training-header">
        <div>
          <p className="eyebrow">{pathDisplayName(path, pathDisplayNameById)}</p>
          <h2 id="graph-training-title">Opening practice</h2>
          <p>
            Variation {activePathOrdinal} of {coverage.totalPathCount} · {statusText} ·{' '}
            {pathLearning.completedLearnerDecisions} of {pathLearning.totalLearnerDecisions} moves recalled this run
            {pathLearning.currentLearnerDecision === null
              ? ''
              : ` · decision ${pathLearning.currentLearnerDecision} next`}
          </p>
          <p className="field-help">This line has {pathLearning.totalLearnerDecisions} moves to recall.</p>
          <progress
            className="family-coverage-progress"
            max={Math.max(1, coverage.totalPathCount)}
            value={coverage.completedPathCount}
            aria-label={`${coverage.completedPathCount} of ${coverage.totalPathCount} variations completed`}
          />
        </div>
        <div className="inline-controls desktop-session-controls">
          {onSetOrientation ? (
            <button type="button" className="secondary-button" aria-label="Flip board" onClick={() => onSetOrientation(orientation === 'white' ? 'black' : 'white')}>
              <span className="control-label-wide">Flip board</span><span className="control-label-compact" aria-hidden="true">Flip</span>
            </button>
          ) : null}
          <button
            type="button"
            className="secondary-button"
            aria-label={paused ? 'Resume' : 'Pause'}
            aria-pressed={paused}
            onClick={() => {
              setPaused((current) => !current)
              announce(paused ? 'Training resumed.' : 'Training paused. The current position was kept.')
            }}
          >
            <span className="control-label-wide">{paused ? 'Resume' : 'Pause'}</span><span className="control-label-compact" aria-hidden="true">{paused ? 'Resume' : 'Pause'}</span>
          </button>
          <button
            type="button"
            className="secondary-button"
            aria-label="Skip variation"
            disabled={!canSkipPath}
            onClick={skipPath}
          >
            <span className="control-label-wide">Skip variation</span><span className="control-label-compact" aria-hidden="true">Skip</span>
          </button>
          <button
            type="button"
            className="secondary-button"
            aria-label="Choose variation"
            disabled={exitPending}
            onClick={() => {
              void persistBeforeExit(() => {
                setSession(null)
                setAutonomousPlan(null)
                setPaused(false)
              }, 'Variation chooser opened. Saved progress was kept.')
            }}
          >
            <span className="control-label-wide">Choose variation</span><span className="control-label-compact" aria-hidden="true">Choose</span>
          </button>
          {onStop ? (
            <button
              type="button"
              className="secondary-button"
              aria-label="Stop training"
              disabled={exitPending}
              onClick={() => { void persistBeforeExit(onStop, 'Training stopped after progress was saved.') }}
            >
              <span className="control-label-wide">Stop training</span><span className="control-label-compact" aria-hidden="true">Stop</span>
            </button>
          ) : null}
        </div>
        <div className="mobile-session-controls">
          <button
            type="button"
            className="secondary-button"
            aria-label={paused ? 'Resume' : 'Pause'}
            aria-pressed={paused}
            onClick={() => {
              setPaused((current) => !current)
              announce(paused ? 'Training resumed.' : 'Training paused. The current position was kept.')
            }}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <details className="mobile-session-menu">
            <summary aria-label="More session options">More</summary>
            <div className="mobile-session-menu-panel" role="group" aria-label="Session options">
              {onSetOrientation ? (
                <button type="button" className="secondary-button" aria-label="Flip board" onClick={() => onSetOrientation(orientation === 'white' ? 'black' : 'white')}>
                  Flip board
                </button>
              ) : null}
              <button
                type="button"
                className="secondary-button"
                aria-label="Skip variation"
                disabled={!canSkipPath}
                onClick={skipPath}
              >
                Skip variation
              </button>
              <button
                type="button"
                className="secondary-button"
                aria-label="Choose variation"
                disabled={exitPending}
                onClick={() => {
                  void persistBeforeExit(() => {
                    setSession(null)
                    setAutonomousPlan(null)
                    setPaused(false)
                  }, 'Variation chooser opened. Saved progress was kept.')
                }}
              >
                Choose variation
              </button>
              {onStop ? (
                <button
                  type="button"
                  className="secondary-button"
                  aria-label="Stop training"
                  disabled={exitPending}
                  onClick={() => { void persistBeforeExit(onStop, 'Training stopped after progress was saved.') }}
                >
                  Stop training
                </button>
              ) : null}
            </div>
          </details>
        </div>
      </header>
      <div className="graph-training-board">
        <ChessBoard
          fen={fen}
          orientation={orientation}
          disabled={paused || boardTransitionLocked || !waitingForLearner || annotationMode}
          reducedMotion={reducedMotion}
          hintUci={session.usedHint ? expected[0]?.uci ?? null : null}
          lastMove={session.lastTransition && moveStatus ? { uci: session.lastTransition.moveUci, status: moveStatus } : null}
          boardOverlay={(
            <BoardAnnotationOverlay
              annotations={annotations}
              orientation={orientation}
              editing={annotationMode}
              tone={annotationTone}
              onChange={setAnnotations}
              onAnnouncement={announce}
              onExitEditing={() => setAnnotationMode(false)}
            />
          )}
          boardControls={(
            <div className="graph-thumb-dock" role="toolbar" aria-label="Training tools">
              <button
                type="button"
                disabled={boardTransitionLocked || !waitingForLearner || session.usedHint || expected.length === 0 || annotationMode}
                onClick={() => {
                  setSession(markGraphTrainingHint(adapter, session))
                  announce(expected.length > 0 ? 'Hint route shown.' : 'No hint route is available.')
                }}
              >
                Hint
              </button>
              <button type="button" onClick={() => openMobileAnalysis('alternatives')}>Lines</button>
              <button type="button" onClick={() => openMobileAnalysis('evidence')}>Why</button>
              <button
                type="button"
                aria-pressed={annotationMode}
                disabled={boardTransitionLocked || !waitingForLearner}
                onClick={toggleAnnotationMode}
              >
                {annotationMode ? 'Resume' : 'Annotate'}
              </button>
            </div>
          )}
          onMove={handleMove}
          onAnnouncement={announce}
        />
        {annotationMode ? (
          <BoardAnnotationPanel
            annotations={annotations}
            orientation={orientation}
            editing
            tone={annotationTone}
            onToneChange={setAnnotationTone}
            onChange={setAnnotations}
            onAnnouncement={announce}
          />
        ) : null}
      </div>
      <aside
        ref={analysisContextRef}
        className="graph-training-context"
        aria-labelledby="graph-context-title"
        tabIndex={-1}
      >
        <p className="eyebrow">Current branch</p>
        <h3 id="graph-context-title">{pathDisplayName(path, pathDisplayNameById)}</h3>
        <p>{paused ? 'Paused' : statusText}</p>
        <div className="analysis-tabs" role="tablist" aria-label="Position analysis">
          {(['line', 'alternatives', 'evidence'] as const).map((tab) => (
            <button
              ref={(node) => {
                if (node) analysisTabRefs.current.set(tab, node)
                else analysisTabRefs.current.delete(tab)
              }}
              type="button"
              role="tab"
              key={tab}
              aria-selected={analysisTab === tab}
              aria-controls={`graph-analysis-${tab}`}
              tabIndex={analysisTab === tab ? 0 : -1}
              onClick={() => setAnalysisTab(tab)}
              onKeyDown={(event) => handleAnalysisTabKeyDown(event, tab)}
            >
              {tab === 'line' ? 'Line' : tab === 'alternatives' ? 'Alternatives' : 'Evidence'}
            </button>
          ))}
        </div>
        <section
          id={`graph-analysis-${analysisTab}`}
          className="graph-analysis-panel"
          role="tabpanel"
          aria-label={`${analysisTab} analysis`}
        >
          {analysisTab === 'line' ? (
            <>
              <h4>Current continuation</h4>
              {!lineRevealed && waitingForLearner ? (
                <div className="graph-answer-gate">
                  <p>The next moves stay hidden during recall.</p>
                  <button type="button" className="secondary-button" onClick={revealCurrentLine}>Reveal line</button>
                </div>
              ) : continuationEdges.length > 0 ? (
                <ol className="graph-continuation-line">
                  {continuationEdges.map((edge) => (
                    <li key={edge.id}>
                      <code>{edge.san}</code>
                      <span>{edge.role === 'book' ? 'Book' : edge.role === 'playable' ? 'Playable' : 'Exploratory'}</span>
                    </li>
                  ))}
                </ol>
              ) : <p>This recorded line ends here.</p>}
              {path.edgeIds.length - session.activePathNodeIndex > continuationEdges.length ? (
                <p className="field-help">Showing the next {continuationEdges.length} moves on the board.</p>
              ) : null}
            </>
          ) : analysisTab === 'alternatives' ? (
            <>
              <h4>Known moves from this position</h4>
              {!lineRevealed && waitingForLearner ? (
                <div className="graph-answer-gate">
                  <p>Alternatives stay hidden until you request help.</p>
                  <button type="button" className="secondary-button" onClick={revealCurrentLine}>Reveal moves</button>
                </div>
              ) : currentEdges.length > 0 ? (
                <ul className="graph-alternative-list">
                  {currentEdges.map((edge) => {
                    const cohort = edge.evidence.cohorts.find(
                      ({ cohortId }) => cohortId === edge.evidence.selectionCohortId,
                    )
                    return (
                      <li key={edge.id}>
                        <span><code>{edge.san}</code> · {edge.role === 'book' ? 'Book' : edge.role === 'playable' ? 'Playable' : 'Exploratory'}</span>
                        <span>
                          {Math.round(edge.evidence.conditionalUsage * 100)}% usage
                          {cohort ? ` · ${cohort.aggregate.moveN.toLocaleString('en-US')} games` : ''}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              ) : <p>No further game-backed moves are stored here.</p>}
            </>
          ) : (
            <>
              <h4>Move evidence</h4>
              {!lineRevealed && waitingForLearner ? (
                <div className="graph-answer-gate">
                  <p>Move evidence stays hidden until you reveal this position.</p>
                  <button type="button" className="secondary-button" onClick={revealCurrentLine}>Reveal evidence</button>
                </div>
              ) : currentEdges.length > 0 ? (
                <div className="graph-evidence-scroll" tabIndex={0} aria-label="Move evidence table">
                  <table className="graph-evidence-table">
                    <thead>
                      <tr>
                        <th scope="col">Move</th>
                        <th scope="col">Role</th>
                        <th scope="col">Games</th>
                        <th scope="col">W / D / L</th>
                        <th scope="col">Score</th>
                        <th scope="col">Usage</th>
                        <th scope="col">Engine</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentEdges.map((edge) => {
                        const selectedCohort = edge.evidence.cohorts.find(
                          ({ cohortId }) => cohortId === edge.evidence.selectionCohortId,
                        )
                        return <tr key={edge.id}>
                          <th scope="row"><code>{edge.san}</code></th>
                          <td>{edge.role === 'book' ? 'Book' : edge.role === 'playable' ? 'Playable' : 'Exploratory'}</td>
                          <td>
                            {selectedCohort ? selectedCohort.aggregate.moveN.toLocaleString('en-US') : 'Unavailable'}
                            {selectedCohort && selectedCohort.aggregate.moveN < 500
                              ? <small className="sample-warning">Low sample</small>
                              : null}
                          </td>
                          <td>{selectedCohort
                            ? `${selectedCohort.aggregate.wins.toLocaleString('en-US')} / ${selectedCohort.aggregate.draws.toLocaleString('en-US')} / ${selectedCohort.aggregate.losses.toLocaleString('en-US')}`
                            : 'Unavailable'}</td>
                          <td>{selectedCohort?.aggregate.score !== null && selectedCohort?.aggregate.score !== undefined
                            ? `${Math.round(selectedCohort.aggregate.score * 1_000) / 10}%`
                            : 'No games'}</td>
                          <td>{Math.round(edge.evidence.conditionalUsage * 100)}%</td>
                          <td>{edge.evidence.engine.status === 'verified'
                            ? edge.evidence.engine.centipawnLoss === null
                              ? 'Mate result checked'
                              : edge.evidence.engine.centipawnLoss === 0
                                ? 'Matches best'
                                : `${(edge.evidence.engine.centipawnLoss / 100).toFixed(2)} pawns from best`
                            : edge.evidence.engine.status === 'quarantined' ? 'Not used for practice' : 'Not checked'}</td>
                        </tr>
                      })}
                    </tbody>
                  </table>
                </div>
              ) : <p>No game results are stored for this position.</p>}
              {lineRevealed && currentEdges.length > 0 ? (
                <div className="engine-forecast-list">
                  <h5>Engine forecasts</h5>
                  <p>Forecasts are engine analysis, not backtested continuations.</p>
                  {currentEdges.filter(({ evidence }) => evidence.engine.check !== null).slice(0, 5).map((edge) => {
                    const check = edge.evidence.engine.check!
                    const selectedCohort = edge.evidence.cohorts.find(
                      ({ cohortId }) => cohortId === edge.evidence.selectionCohortId,
                    )
                    return (
                      <details key={`forecast:${edge.id}`}>
                        <summary>
                          <code>{edge.san}</code>
                          <span>{check.centipawnLoss === null
                            ? 'Mate comparison'
                            : check.centipawnLoss === 0
                              ? 'Matches best'
                              : `${(check.centipawnLoss / 100).toFixed(2)} pawns from best`}</span>
                        </summary>
                        <p><strong>Analyzed line:</strong> {principalVariationSan(currentNode.epd, check.movePrincipalVariationUci).join(' ')}</p>
                        <p><strong>Best line:</strong> {principalVariationSan(currentNode.epd, check.bestPrincipalVariationUci).join(' ')}</p>
                        {selectedCohort ? (
                          <p>
                            <strong>Game group:</strong> {cohortSourceLabel(selectedCohort.source)}, {selectedCohort.timeControl}, through {selectedCohort.cutoff}.
                          </p>
                        ) : null}
                      </details>
                    )
                  })}
                  {currentEdges.every(({ evidence }) => evidence.engine.check === null)
                    ? <p>No exact engine forecast is stored for moves at this position.</p>
                    : null}
                </div>
              ) : null}
              <p className="field-help">W/D/L is shown from your side. Source groups stay separate. Percentages describe historical play, not a promised result.</p>
            </>
          )}
        </section>
        {pendingManualReview ? (
          <fieldset className="manual-grade-controls">
            <legend>Choose recall grade</legend>
            <p>Suggested: <strong>{pendingManualReview.grade}</strong>. Choose once to save this move.</p>
            <div
              className="grade-buttons"
              onKeyDown={(event) => {
                const grade = ({ '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' } as const)[event.key as '1' | '2' | '3' | '4']
                if (!grade) return
                event.preventDefault()
                confirmManualGrade(grade)
              }}
            >
              {([
                ['again', 'Again', '1'],
                ['hard', 'Hard', '2'],
                ['good', 'Good', '3'],
                ['easy', 'Easy', '4'],
              ] as const).map(([grade, label, key]) => (
                <button
                  type="button"
                  key={grade}
                  className={pendingManualReview.grade === grade ? 'selected-grade' : undefined}
                  aria-pressed={pendingManualReview.grade === grade}
                  onClick={() => confirmManualGrade(grade)}
                >
                  <kbd>{key}</kbd> {label}
                </button>
              ))}
            </div>
          </fieldset>
        ) : paused ? (
          <p role="status">Resume when you are ready. No move or review has been recorded.</p>
        ) : boardTransitionLocked ? (
          <p role="status">The opponent piece is finishing its move before input resumes.</p>
        ) : waitingForLearner ? (
          <>
            <button
              type="button"
              className="secondary-button"
              disabled={session.usedHint || expected.length === 0}
              onClick={() => {
                setSession(markGraphTrainingHint(adapter, session))
                announce(expected.length > 0 ? 'Hint route shown.' : 'No hint route is available.')
              }}
            >
              Show hint
            </button>
            {lineRevealed ? (
              <details>
                <summary>Expected moves ({expected.length})</summary>
                <ul className="graph-move-list">
                  {expected.map((edge) => (
                    <li key={edge.id}><code>{edge.san}</code><span>{Math.round(edge.evidence.conditionalUsage * 100)}% conditional usage</span></li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : session.phase === 'opponent_move_ready' && manualPacingEnabled ? (
          <button type="button" className="primary-action" disabled={pendingManualReview !== null} onClick={playOpponentMove}>Play opponent reply</button>
        ) : session.phase === 'path_complete' && manualPacingEnabled ? (
          <button type="button" className="primary-action" disabled={pendingManualReview !== null || !activePathCompletionSaved} onClick={continuePath}>
            {activePathCompletionSaved ? 'Continue to next variation' : 'Saving completed variation…'}
          </button>
        ) : <p>The next position is applied only after the current piece transition has time to finish.</p>}
        {session.lastFeedback ? (
          <div className={`graph-feedback graph-feedback-${session.lastFeedback.accepted ? 'accepted' : 'correction'}`} role={session.lastFeedback.accepted ? 'status' : 'alert'}>
            <strong>{session.lastFeedback.accepted ? 'Move accepted' : 'Correction required'}</strong>
            <span>{feedbackLabel(session.lastFeedback.classification)} · {feedbackLabel(session.lastFeedback.reason)}</span>
          </div>
        ) : null}
        <dl className="graph-session-facts">
          <div><dt>Total variations</dt><dd>{coverage.totalPathCount}</dd></div>
          <div><dt>Practiced</dt><dd>{coverage.completedPathCount}</dd></div>
          <div><dt>Remaining</dt><dd>{coverage.remainingPathCount}</dd></div>
          <div><dt>This run</dt><dd>{pathLearning.completedLearnerDecisions} of {pathLearning.totalLearnerDecisions} moves recalled</dd></div>
          <div><dt>Moves in line</dt><dd>{pathLearning.totalLearnerDecisions}</dd></div>
          <div><dt>Line status</dt><dd>{terminalLabel(pathLearning.terminalStatus)}</dd></div>
          <div><dt>Moves due</dt><dd>{session.dueCardIds.length}</dd></div>
          <div><dt>Repeats</dt><dd>{session.repeatCardIds.length}</dd></div>
        </dl>
        <details>
          <summary>Named groups ({coverage.families.length})</summary>
          <ul className="graph-move-list">
            {coverage.families.map((family) => (
              <li key={family.family}>
                <span>{family.family}</span>
                <span>{family.completedPathCount} of {family.totalPathCount} variations practiced</span>
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
  onStop,
  autoStartFull = false,
  onAutoStartConsumed,
  autoStartPathGroupId,
  autoStartPathGroupContinuation = true,
  onAutoStartPathGroupConsumed,
  onCoverageScopeChange,
  onCoverageCycleStarted,
  onNamedVariationCycleStarted,
  onRestartFullCoverage,
  onRetry,
  familyId,
  journalRepository,
  expectedCoverageCycleId,
  pathDisplayNameById,
  pathGroupByPathId,
  pathGroups,
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
    return <EmptyState title="Guided practice is not ready" detail={resource.reason} />
  }
  if (resource.status === 'idle' || resource.status === 'loading') {
    return <LoadingState label="Loading opening practice…" />
  }
  if (resource.status === 'error') {
    return <ErrorState title="Opening practice unavailable" detail={resource.error} onRetry={onRetry ?? (() => undefined)} />
  }
  if (!prepared || prepared.envelope !== resource.envelope || (!prepared.adapter && !prepared.error)) {
    return <LoadingState label="Checking positions and move evidence…" />
  }
  if (prepared.error || !prepared.adapter) {
    return <ErrorState title="Opening practice could not be loaded" detail={prepared.error ?? 'The practice data failed validation.'} onRetry={onRetry ?? (() => undefined)} />
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
      {...(onStop ? { onStop } : {})}
      autoStartFull={autoStartFull}
      {...(onAutoStartConsumed ? { onAutoStartConsumed } : {})}
      {...(autoStartPathGroupId ? { autoStartPathGroupId } : {})}
      autoStartPathGroupContinuation={autoStartPathGroupContinuation}
      {...(onAutoStartPathGroupConsumed ? { onAutoStartPathGroupConsumed } : {})}
      {...(onCoverageScopeChange ? { onCoverageScopeChange } : {})}
      {...(onCoverageCycleStarted ? { onCoverageCycleStarted } : {})}
      {...(onNamedVariationCycleStarted ? { onNamedVariationCycleStarted } : {})}
      {...(onRestartFullCoverage ? { onRestartFullCoverage } : {})}
      {...(familyId ? { familyId } : {})}
      {...(journalRepository ? { journalRepository } : {})}
      {...(expectedCoverageCycleId !== undefined ? { expectedCoverageCycleId } : {})}
      {...(pathDisplayNameById ? { pathDisplayNameById } : {})}
      {...(pathGroupByPathId ? { pathGroupByPathId } : {})}
      {...(pathGroups ? { pathGroups } : {})}
    />
  )
}

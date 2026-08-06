import { useEffect, useMemo, useRef, useState } from 'react'
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
  listGraphTrainingPaths,
  markGraphTrainingHint,
  nextNonemptyGraphTrainingBatch,
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
import {
  FamilyTrainingCursorWriteQueue,
  type FamilyTrainingJournalRepository,
} from '../../domain/family-training-journal.ts'
import type { BoardAnnotation, BoardAnnotationTone } from '../../domain/board-annotations.ts'
import { BoardAnnotationOverlay, BoardAnnotationPanel } from './BoardAnnotations.tsx'
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
  onStop?: () => void
  autoStartFull?: boolean
  onAutoStartConsumed?: () => void
  autoStartPathGroupId?: string | null
  onAutoStartPathGroupConsumed?: () => void
  onCoverageScopeChange?: (
    scope: 'full' | 'selection',
    detail?: { pathGroupId?: string; continuation?: boolean },
  ) => void
  onCoverageCycleStarted?: (cycle: {
    packId: string
    coverageCycleId: string
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
  return `${pathDisplayName(summary, pathDisplayNameById)} — ${summary.learnerDecisionCount} learner moves, terminal ply ${summary.terminalPly}`
}

function acceptedMoveStatus(state: GraphTrainingSessionState): BoardMoveStatus | undefined {
  const classification = state.lastFeedback?.classification
  return classification === 'book' || classification === 'playable' ? classification : undefined
}

const PATH_PAGE_SIZE = 40

function feedbackLabel(value: string): string {
  const labels: Record<string, string> = {
    book: 'Book move',
    playable: 'Playable alternative',
    inaccuracy: 'Inaccuracy',
    mistake: 'Mistake',
    unverified: 'Unverified move',
    expected_move: 'Expected continuation',
    accepted_transposition: 'Accepted transposition',
    accepted_alternate_path: 'Alternate audited branch',
    unsupported_move: 'Outside the audited graph',
  }
  return labels[value] ?? value.replaceAll('_', ' ').replace(/^./u, (character) => character.toUpperCase())
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
  onAutoStartPathGroupConsumed,
  onCoverageScopeChange,
  onCoverageCycleStarted,
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
  const [session, setSession] = useState<GraphTrainingSessionState | null>(null)
  const [autonomousPlan, setAutonomousPlan] = useState<AutonomousGraphTrainingPlan | null>(null)
  const [activeBatchIndex, setActiveBatchIndex] = useState(0)
  const [completedBeforeBatch, setCompletedBeforeBatch] = useState<string[]>([])
  const [authoritativeDueCardIds, setAuthoritativeDueCardIds] = useState<string[]>([])
  const [nextCoverageCycleOrdinal, setNextCoverageCycleOrdinal] = useState(0)
  const [manualPacingEnabled, setManualPacingEnabled] = useState(manualPacing)
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
  const [generationRestoreBlocked, setGenerationRestoreBlocked] = useState(false)
  const reportedCompletionKeys = useRef(new Set<string>())
  const pendingCompletionKeys = useRef(new Set<string>())
  const autoStartHandled = useRef(false)
  const autoStartPathGroupHandled = useRef(false)
  const analysisContextRef = useRef<HTMLElement>(null)
  const availablePathGroupsRef = useRef(availablePathGroups)
  availablePathGroupsRef.current = availablePathGroups
  const cursorWriter = useMemo(
    () => journalRepository ? new FamilyTrainingCursorWriteQueue(journalRepository) : null,
    [journalRepository],
  )
  const announce = (value: string): void => {
    setLocalAnnouncement(value)
    onAnnouncement?.(value)
  }

  const toggleAnnotationMode = (): void => {
    setAnnotationMode((current) => {
      announce(current
        ? 'Annotation mode closed. Move input resumed.'
        : 'Annotation mode opened. Move input is paused.')
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

  useEffect(() => {
    if (!paths.some(({ id }) => id === selectedPathId)) setSelectedPathId(paths[0]?.id ?? '')
  }, [paths, selectedPathId])
  useEffect(() => {
    if (!availablePathGroups.some(({ id }) => id === selectedPathGroupId)) {
      setSelectedPathGroupId(availablePathGroups[0]?.id ?? '')
    }
  }, [availablePathGroups, selectedPathGroupId])

  useEffect(() => setVisiblePathCount(PATH_PAGE_SIZE), [pathQuery])

  useEffect(() => setManualPacingEnabled(manualPacing), [manualPacing])

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
          ? 'An older pack cursor was left untouched; this family generation will start a new pack cycle.'
          : 'This pack is ready to join the active family generation.')
        return
      }
      if (!cursor) {
        if (typeof expectedCoverageCycleId === 'string') {
          setGenerationRestoreBlocked(true)
          setPersistenceError('The active family generation references a pack cursor that is unavailable.')
          announce('Family training is blocked because its bound pack cursor is unavailable.')
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
        : 'Restored the completed family coverage cycle.')
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
  ])

  useEffect(() => {
    if (!session || !onPathCompleted) return
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
    if (paused || manualPacingEnabled || session?.phase !== 'opponent_move_ready') return
    const timeout = setTimeout(() => {
      setSession((current) => {
        if (!current || current.phase !== 'opponent_move_ready') return current
        const next = applyPendingOpponentGraphMove(adapter, current)
        announce(`${next.lastTransition?.moveUci ?? 'Opponent move'} played for the opponent.`)
        return next
      })
    }, reducedMotion ? 0 : 190)
    return () => clearTimeout(timeout)
  }, [adapter, manualPacingEnabled, paused, reducedMotion, session?.phase, session?.currentNodeId])

  useEffect(() => {
    if (paused || manualPacingEnabled || session?.phase !== 'path_complete') return
    const timeout = setTimeout(() => {
      setSession((current) => {
        if (!current || current.phase !== 'path_complete') return current
        const next = continueGraphTrainingSession(adapter, current)
        announce(next.phase === 'session_complete' ? 'Path batch complete.' : 'Next audited path started.')
        return next
      })
    }, reducedMotion ? 0 : 240)
    return () => clearTimeout(timeout)
  }, [adapter, manualPacingEnabled, paused, reducedMotion, session?.phase, session?.activePathId])

  useEffect(() => {
    if (paused || manualPacingEnabled || session?.phase !== 'session_complete' || !autonomousPlan) return
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
      announce(`Continuing with audited path batch ${nextBatch.batchIndex + 1} of ${autonomousPlan.pathIdBatches.length}.`)
    }, reducedMotion ? 0 : 240)
    return () => clearTimeout(timeout)
  }, [
    activeBatchIndex,
    adapter,
    autonomousPlan,
    completedBeforeBatch,
    manualPacingEnabled,
    paused,
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
      announce('One audited path is ready.')
    } catch (error) {
      announce(message(error))
    }
  }

  const startSelectedVariation = (
    pathGroupId = selectedPathGroupId,
    continuation = false,
  ): boolean => {
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
      if (!firstPathIds) throw new Error('The selected variation has no audited paths')
      const selection = createExplicitGraphSessionSelection({
        adapter,
        pathIds: firstPathIds,
        dueCardIds,
        coverageCycleOrdinal: cycleOrdinal,
      })
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
      announce(`${selectedPathIds.length} audited path${selectedPathIds.length === 1 ? '' : 's'} queued for ${group?.label ?? 'this variation'}.`)
      return true
    } catch (error) {
      announce(message(error))
      return false
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
      if (!firstPathIds) throw new Error('No audited path is available for autonomous practice')
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
        announce(`${plan.totalPathIds.length} audited paths queued. Branches will continue automatically.`)
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
        setPersistenceError(`Family coverage generation could not be saved: ${message(error)}`)
        announce('Full-family training did not start because its coverage generation was not saved.')
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
    if (startSelectedVariation(autoStartPathGroupId, true)) {
      onAutoStartPathGroupConsumed?.()
    }
  }, [
    autoStartPathGroupId,
    generationRestoreBlocked,
    onAutoStartPathGroupConsumed,
    restorePending,
    session,
  ])

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
    announce(`Continuing with audited path batch ${nextBatch.batchIndex + 1} of ${autonomousPlan.pathIdBatches.length}.`)
  }

  const skipPath = (): void => {
    if (!session) return
    const hasPendingPathInBatch = session.pendingPathIds.some((pathId) =>
      pathId !== session.activePathId && !session.completedPathIds.includes(pathId))
    if (hasPendingPathInBatch) {
      try {
        setSession(skipCurrentGraphTrainingPath(adapter, session))
        announce('Variation moved to the end of this coverage cycle.')
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
        const failure = result.error?.message ?? 'The latest cursor remains queued.'
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
      {queuedCursorCount > 0 ? <span>{queuedCursorCount} cursor update{queuedCursorCount === 1 ? '' : 's'} queued in this session.</span> : null}
      {(journalRepository && familyId) ? (
        <button type="button" className="secondary-button" onClick={retryPersistence}>Retry saving progress</button>
      ) : null}
    </div>
  ) : null

  if (restorePending) {
    return <LoadingState label="Restoring saved family coverage…" />
  }

  if (paths.length === 0) {
    return <EmptyState title="No selectable graph paths" detail="The validated pack contains no audited training paths." />
  }

  if (!session) {
    const normalizedQuery = pathQuery.trim().toLocaleLowerCase('en-US')
    const filteredPaths = normalizedQuery === ''
      ? paths
      : paths.filter((path) => pathLabel(path, pathDisplayNameById).toLocaleLowerCase('en-US').includes(normalizedQuery))
    const visiblePaths = filteredPaths.slice(0, visiblePathCount)
    return (
      <section className="graph-training-catalog" aria-labelledby="graph-path-title">
        {persistenceNotice}
        <header>
          <p className="eyebrow">Validated family graph</p>
          <h2 id="graph-path-title">Practice every audited branch</h2>
          <p>Full repertoire practice continues through each branch without hiding less common continuations.</p>
        </header>
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
          {filteredPaths.length.toLocaleString('en-US')} matching path{filteredPaths.length === 1 ? '' : 's'}.
        </p>
        <ul className="graph-path-picker" aria-label="Audited variation paths">
          {visiblePaths.map((path) => (
            <li key={path.id}>
              <button
                type="button"
                className="graph-path-option"
                aria-pressed={selectedPathId === path.id}
                onClick={() => setSelectedPathId(path.id)}
              >
                <span>{pathDisplayName(path, pathDisplayNameById)}</span>
                <small>{path.learnerDecisionCount} learner moves · terminal ply {path.terminalPly}</small>
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
            Show {Math.min(PATH_PAGE_SIZE, filteredPaths.length - visiblePaths.length)} more paths
          </button>
        ) : null}
        <dl className="graph-path-facts">
          <div><dt>Audited paths</dt><dd>{paths.length.toLocaleString('en-US')}</dd></div>
          <div><dt>Pack tier</dt><dd>{adapter.graph.pack.tier === 'core' ? 'Core' : 'Primer'}</dd></div>
          <div><dt>Coverage</dt><dd>{Math.round(adapter.graph.pack.coverage * 100)}%</dd></div>
        </dl>
        {availablePathGroups.length > 0 ? (
          <label className="graph-path-search">
            <span>Named variation</span>
            <select
              value={selectedPathGroupId}
              onChange={(event) => setSelectedPathGroupId(event.currentTarget.value)}
            >
              {availablePathGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.label} · {group.pathIds.length} in this pack
                  {group.familyPathCount && group.familyPathCount !== group.pathIds.length
                    ? ` · ${group.familyPathCount} across the family`
                    : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="inline-controls">
          <button type="button" className="primary-action" disabled={startPending} onClick={startAll}>
            {startPending ? 'Saving coverage cycle…' : 'Start full repertoire'}
          </button>
          {availablePathGroups.length > 0 ? (
            <button type="button" className="secondary-button" onClick={() => { startSelectedVariation() }}>
              Practice selected variation
            </button>
          ) : null}
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
  const hasNextBatch = autonomousPlan
    ? nextNonemptyGraphTrainingBatch(autonomousPlan, activeBatchIndex) !== null
    : false

  if (session.phase === 'session_complete' && !hasNextBatch) {
    return (
      <section className="graph-training-complete" aria-labelledby="graph-complete-title">
        {persistenceNotice}
        <p className="eyebrow">Session complete</p>
        <h2 id="graph-complete-title">Every selected path is complete.</h2>
        <p>{coverage.completedPathCount.toLocaleString('en-US')} of {coverage.totalPathCount.toLocaleString('en-US')} audited paths completed. Warm-ups were not rescheduled.</p>
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
            Start a new coverage cycle
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={exitPending}
            onClick={() => {
              void persistBeforeExit(() => {
                setSession(null)
                setAutonomousPlan(null)
              }, 'Variation chooser opened. The saved cursor was kept.')
            }}
          >
            Choose paths
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
  const currentNode = adapter.nodesById.get(session.currentNodeId)!
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
      {persistenceNotice}
      <header className="graph-training-header">
        <div>
          <p className="eyebrow">{pathDisplayName(path, pathDisplayNameById)}</p>
          <h2 id="graph-training-title">Continuous graph practice</h2>
          <p>Path {activePathOrdinal} of {coverage.totalPathCount} · {statusText} · move {Math.min(session.activePathNodeIndex + 1, path.nodeIds.length)} of {path.nodeIds.length}</p>
        </div>
        <div className="inline-controls">
          {onSetOrientation ? (
            <button type="button" className="secondary-button" onClick={() => onSetOrientation(orientation === 'white' ? 'black' : 'white')}>
              Flip board
            </button>
          ) : null}
          <button
            type="button"
            className="secondary-button"
            aria-pressed={paused}
            onClick={() => {
              setPaused((current) => !current)
              announce(paused ? 'Training resumed.' : 'Training paused. The current position was kept.')
            }}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!canSkipPath}
            onClick={skipPath}
          >
            Skip variation
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={exitPending}
            onClick={() => {
              void persistBeforeExit(() => {
                setSession(null)
                setAutonomousPlan(null)
                setPaused(false)
              }, 'Variation chooser opened. The saved cursor was kept.')
            }}
          >
            Choose variation
          </button>
          {onStop ? (
            <button
              type="button"
              className="secondary-button"
              disabled={exitPending}
              onClick={() => { void persistBeforeExit(onStop, 'Training stopped after progress was saved.') }}
            >
              Stop training
            </button>
          ) : null}
        </div>
      </header>
      <div className="graph-training-board">
        <ChessBoard
          fen={fen}
          orientation={orientation}
          disabled={paused || !waitingForLearner || annotationMode}
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
          onMove={handleMove}
          onAnnouncement={announce}
        />
        <div className="graph-thumb-dock" role="toolbar" aria-label="Training tools">
          <button
            type="button"
            disabled={!waitingForLearner || session.usedHint || expected.length === 0 || annotationMode}
            onClick={() => {
              setSession(markGraphTrainingHint(adapter, session))
              announce(expected.length > 0 ? 'Hint route shown.' : 'No audited route is available.')
            }}
          >
            Hint
          </button>
          <button type="button" onClick={() => openMobileAnalysis('alternatives')}>Lines</button>
          <button type="button" onClick={() => openMobileAnalysis('evidence')}>Why</button>
          <button
            type="button"
            aria-pressed={annotationMode}
            disabled={!waitingForLearner}
            onClick={toggleAnnotationMode}
          >
            {annotationMode ? 'Resume' : 'Annotate'}
          </button>
        </div>
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
              type="button"
              role="tab"
              key={tab}
              aria-selected={analysisTab === tab}
              aria-controls={`graph-analysis-${tab}`}
              onClick={() => setAnalysisTab(tab)}
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
              <h4>Current audited continuation</h4>
              {continuationEdges.length > 0 ? (
                <ol className="graph-continuation-line">
                  {continuationEdges.map((edge) => (
                    <li key={edge.id}>
                      <code>{edge.san}</code>
                      <span>{edge.role === 'book' ? 'Book' : edge.role === 'playable' ? 'Playable' : 'Exploratory'}</span>
                    </li>
                  ))}
                </ol>
              ) : <p>This path has reached its evidence-defined end.</p>}
              {path.edgeIds.length - session.activePathNodeIndex > continuationEdges.length ? (
                <p className="field-help">Showing the next {continuationEdges.length} plies of this empirical path.</p>
              ) : null}
            </>
          ) : analysisTab === 'alternatives' ? (
            <>
              <h4>Known moves from this position</h4>
              {currentEdges.length > 0 ? (
                <ul className="graph-alternative-list">
                  {currentEdges.map((edge) => (
                    <li key={edge.id}>
                      <span><code>{edge.san}</code> · {edge.role === 'book' ? 'Book' : edge.role === 'playable' ? 'Playable' : 'Exploratory'}</span>
                      <span>{Math.round(edge.evidence.conditionalUsage * 100)}% usage</span>
                    </li>
                  ))}
                </ul>
              ) : <p>No sampled continuation is stored at this terminal.</p>}
            </>
          ) : (
            <>
              <h4>Audited move evidence</h4>
              {currentEdges.length > 0 ? (
                <div className="graph-evidence-scroll" tabIndex={0} aria-label="Move evidence table">
                  <table className="graph-evidence-table">
                    <thead>
                      <tr><th scope="col">Move</th><th scope="col">Role</th><th scope="col">Games</th><th scope="col">Usage</th><th scope="col">Engine</th></tr>
                    </thead>
                    <tbody>
                      {currentEdges.map((edge) => (
                        <tr key={edge.id}>
                          <th scope="row"><code>{edge.san}</code></th>
                          <td>{edge.role === 'book' ? 'Book' : edge.role === 'playable' ? 'Playable' : 'Exploratory'}</td>
                          <td>{edge.evidence.cohorts.reduce((total, cohort) => total + cohort.n, 0).toLocaleString('en-US')}</td>
                          <td>{Math.round(edge.evidence.conditionalUsage * 100)}%</td>
                          <td>{edge.evidence.engine.status === 'verified'
                            ? `${edge.evidence.engine.centipawnLoss ?? 0} cp loss`
                            : edge.evidence.engine.status === 'quarantined' ? 'Quarantined' : 'Unverified'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p>No empirical move evidence is stored at this terminal.</p>}
              <p className="field-help">Game counts remain separated by source cohort in the signed graph. Percentages describe historical play, not a promised result.</p>
            </>
          )}
        </section>
        {paused ? (
          <p role="status">Resume when you are ready. No move or review has been recorded.</p>
        ) : waitingForLearner ? (
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
            <span>{feedbackLabel(session.lastFeedback.classification)} · {feedbackLabel(session.lastFeedback.reason)}</span>
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
  onStop,
  autoStartFull = false,
  onAutoStartConsumed,
  autoStartPathGroupId,
  onAutoStartPathGroupConsumed,
  onCoverageScopeChange,
  onCoverageCycleStarted,
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
      {...(onStop ? { onStop } : {})}
      autoStartFull={autoStartFull}
      {...(onAutoStartConsumed ? { onAutoStartConsumed } : {})}
      {...(autoStartPathGroupId ? { autoStartPathGroupId } : {})}
      {...(onAutoStartPathGroupConsumed ? { onAutoStartPathGroupConsumed } : {})}
      {...(onCoverageScopeChange ? { onCoverageScopeChange } : {})}
      {...(onCoverageCycleStarted ? { onCoverageCycleStarted } : {})}
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

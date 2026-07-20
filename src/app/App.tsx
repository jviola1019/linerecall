import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import type { OpeningSearchMatch } from '../domain/input-validation.ts'
import type { DataManifest, OpeningPartition, VerifiedLine } from '../domain/opening-data.ts'
import {
  createEmptyProgress,
  localDateKey,
  updateReviewStreak,
  updateScopedReviewStreaks,
  CardProgressSchema,
  type CardProgress,
  type ProgressRepository,
  type ProgressV1,
} from '../domain/progress.ts'
import type { OpeningDataCore, OpeningDataSource } from '../data/opening-data-source.ts'
import { positionGraphFromWire } from '../data/position-graph.ts'
import type { PositionGraph } from '../domain/deviation.ts'
import {
  DebouncedProgressWriter,
  MemoryProgressRepository,
  selectProgressRepository,
} from '../infrastructure/progress-repository.ts'
import { DataLicenses } from './components/DataLicenses.tsx'
import { DrillView, type ReviewCommitMetadata } from './components/DrillView.tsx'
import { OpeningBrowser, type PartitionResource } from './components/OpeningBrowser.tsx'
import { ProgressView } from './components/ProgressView.tsx'
import { PuzzleView, type PuzzleResource, type PuzzleSolvedEvent } from './components/PuzzleView.tsx'
import { RepertoireView } from './components/RepertoireView.tsx'
import { GraphTrainingBoundary, type GraphTrainingResource } from './components/GraphTrainingBoundary.tsx'
import type {
  GraphTrainingPathCompletionV1,
  GraphTrainingReviewInference,
} from '../domain/graph-training-session.ts'
import { ErrorState, LoadingState } from './components/ResourceState.tsx'
import { openingPuzzlesFromVerifiedLine } from '../domain/opening-puzzles.ts'
import { resolveRuntimeLocale } from '../i18n/registry.ts'

type AppView = 'today' | 'repertoire' | 'puzzles' | 'explore' | 'drill' | 'progress' | 'data'

interface AppState {
  view: AppView
  coreStatus: 'loading' | 'ready' | 'error'
  core: OpeningDataCore | null
  coreError: string | null
  coreRetry: number
  selectedEco: string
  requestedLineId: string | null
  requestedVariantId: string | null
  selectedLineId: string | null
  selectedVariantId: string | null
  partition: PartitionResource
  partitionRetry: number
  audit: { status: 'idle' | 'loading' | 'ready' | 'error'; value: DataManifest | null; error: string | null }
  auditRetry: number
  drillLine: VerifiedLine | null
}

type AppAction =
  | { type: 'core_loading' }
  | { type: 'core_ready'; core: OpeningDataCore }
  | { type: 'core_error'; error: string }
  | { type: 'retry_core' }
  | { type: 'navigate'; view: AppView }
  | { type: 'select_eco'; eco: string; lineId?: string; variantId?: string }
  | { type: 'partition_loading' }
  | { type: 'partition_ready'; partition: OpeningPartition }
  | { type: 'partition_error'; error: string }
  | { type: 'retry_partition' }
  | { type: 'audit_loading' }
  | { type: 'audit_ready'; audit: DataManifest }
  | { type: 'audit_error'; error: string }
  | { type: 'retry_audit' }
  | { type: 'select_line'; lineId: string; firstVariantId: string | null }
  | { type: 'select_variant'; variantId: string }
  | { type: 'start_drill'; line: VerifiedLine }

const INITIAL_STATE: AppState = {
  view: 'today',
  coreStatus: 'loading',
  core: null,
  coreError: null,
  coreRetry: 0,
  selectedEco: 'C92',
  requestedLineId: null,
  requestedVariantId: null,
  selectedLineId: null,
  selectedVariantId: null,
  partition: { status: 'idle', value: null, error: null },
  partitionRetry: 0,
  audit: { status: 'idle', value: null, error: null },
  auditRetry: 0,
  drillLine: null,
}

const EMPTY_POSITION_GRAPH: PositionGraph = {
  edgesByPosition: new Map(),
  edgesByPositionMove: new Map(),
}

function firstVariantFor(partition: OpeningPartition, lineId: string | null): string | null {
  if (!lineId) return null
  const variants = partition.verifiedLines
    .filter((line) => line.sourceLineId === lineId)
    .sort((left, right) =>
      Number(right.drillEligible) - Number(left.drillEligible)
      || right.nodes.length - left.nodes.length
      || right.terminalSampleSize - left.terminalSampleSize
      || left.id.localeCompare(right.id, 'en')
    )
  return variants[0]?.id ?? null
}

function defaultLineFor(partition: OpeningPartition): OpeningPartition['lines'][number] | null {
  const strongest = partition.verifiedLines
    .filter((line) => line.drillEligible)
    .sort((left, right) =>
      right.nodes.length - left.nodes.length
      || right.terminalSampleSize - left.terminalSampleSize
      || left.id.localeCompare(right.id, 'en')
    )[0]
  return partition.lines.find((line) => line.sourceLineId === strongest?.sourceLineId)
    ?? partition.lines.find((line) => line.backtestEligible)
    ?? partition.lines.find((line) => line.uci.length > 1)
    ?? partition.lines[0]
    ?? null
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'core_loading': return { ...state, coreStatus: 'loading', coreError: null }
    case 'core_ready': {
      const selectedEco = action.core.catalog.some((entry) => entry.eco === state.selectedEco)
        ? state.selectedEco
        : action.core.catalog[0]?.eco ?? 'A00'
      return { ...state, coreStatus: 'ready', core: action.core, coreError: null, selectedEco }
    }
    case 'core_error': return { ...state, coreStatus: 'error', core: null, coreError: action.error }
    case 'retry_core': return { ...state, coreRetry: state.coreRetry + 1 }
    case 'navigate': return { ...state, view: action.view }
    case 'select_eco': return {
      ...state,
      selectedEco: action.eco,
      requestedLineId: action.lineId ?? null,
      requestedVariantId: action.variantId ?? null,
      selectedLineId: null,
      selectedVariantId: null,
      partition: { status: 'loading', value: null, error: null },
      partitionRetry: state.partitionRetry + 1,
    }
    case 'partition_loading': return { ...state, partition: { status: 'loading', value: null, error: null } }
    case 'partition_ready': {
      const requested = state.requestedLineId
      const selectedLine = action.partition.lines.find((line) => line.sourceLineId === requested)
        ?? defaultLineFor(action.partition)
      const selectedLineId = selectedLine?.sourceLineId ?? null
      const requestedVariant = action.partition.verifiedLines.find((line) =>
        line.id === state.requestedVariantId && line.sourceLineId === selectedLineId
      )
      return {
        ...state,
        partition: { status: 'ready', value: action.partition, error: null },
        selectedLineId,
        selectedVariantId: requestedVariant?.id ?? firstVariantFor(action.partition, selectedLineId),
        requestedLineId: null,
        requestedVariantId: null,
      }
    }
    case 'partition_error': return { ...state, partition: { status: 'error', value: null, error: action.error } }
    case 'retry_partition': return { ...state, partitionRetry: state.partitionRetry + 1 }
    case 'audit_loading': return { ...state, audit: { status: 'loading', value: null, error: null } }
    case 'audit_ready': return { ...state, audit: { status: 'ready', value: action.audit, error: null } }
    case 'audit_error': return { ...state, audit: { status: 'error', value: null, error: action.error } }
    case 'retry_audit': return { ...state, auditRetry: state.auditRetry + 1 }
    case 'select_line': return { ...state, selectedLineId: action.lineId, selectedVariantId: action.firstVariantId }
    case 'select_variant': return { ...state, selectedVariantId: action.variantId }
    case 'start_drill': return { ...state, view: 'drill', drillLine: action.line }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected data error occurred.'
}

function NavGlyph({ name }: { name: 'today' | 'book' | 'puzzle' | 'search' | 'progress' }): React.JSX.Element {
  const path = {
    today: 'M5 4.5h14v15H5z M8 2.5v4 M16 2.5v4 M5 9h14',
    book: 'M4 5.5c3-1 5-.5 8 1.5v13c-3-2-5-2.5-8-1.5z M20 5.5c-3-1-5-.5-8 1.5v13c3-2 5-2.5 8-1.5z',
    puzzle: 'M9 4h5v4a2 2 0 1 0 4 0V4h2v7h-4a2 2 0 1 0 0 4h4v5h-7v-4a2 2 0 1 0-4 0v4H4v-7h4a2 2 0 1 0 0-4H4V4z',
    search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M15.5 15.5 21 21',
    progress: 'M5 19V11 M12 19V5 M19 19v-9',
  }[name]
  return (
    <svg className="nav-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  )
}

export interface AppProps {
  dataSource: OpeningDataSource
  repositorySelector?: () => Promise<{ repository: ProgressRepository; warning: string | null }>
  accountControl?: ReactNode
  onReviewCommit?: (commit: ReviewCommitMetadata & { card: CardProgress }) => string | undefined
  onPuzzleSolved?: (event: PuzzleSolvedEvent) => void
  subscribeProgressCards?: (
    listener: (cards: readonly CardProgress[]) => void,
    onError: (error: Error) => void,
  ) => () => void
  graphTrainingResource?: GraphTrainingResource
  graphTrainingDueCardIds?: readonly string[]
  onGraphReviewInference?: (review: GraphTrainingReviewInference) => void
  onGraphPathCompleted?: (completion: GraphTrainingPathCompletionV1) => void
}

const DEFAULT_GRAPH_TRAINING_RESOURCE: GraphTrainingResource = {
  status: 'disabled',
  reason: 'No receipt-bound v3 repertoire graph is promoted in this offline candidate. Legacy v2 lines are never adapted into the v3 trainer.',
}

export function App({
  dataSource,
  repositorySelector = selectProgressRepository,
  accountControl,
  onReviewCommit,
  onPuzzleSolved,
  subscribeProgressCards,
  graphTrainingResource = DEFAULT_GRAPH_TRAINING_RESOURCE,
  graphTrainingDueCardIds = [],
  onGraphReviewInference,
  onGraphPathCompleted,
}: AppProps): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  const [progress, setProgress] = useState<ProgressV1>(() => {
    const initial = createEmptyProgress()
    if (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light') {
      initial.settings.theme = 'light'
    }
    return initial
  })
  const [repositoryKind, setRepositoryKind] = useState<ProgressRepository['kind']>('memory')
  const [progressHydration, setProgressHydration] = useState<'loading' | 'ready'>('loading')
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState({ message: '', sequence: 0 })
  const writerRef = useRef<DebouncedProgressWriter | null>(null)
  const mainRef = useRef<HTMLElement>(null)
  const focusViewAfterNavigationRef = useRef(false)

  const announce = (message: string): void => setAnnouncement((current) => ({ message, sequence: current.sequence + 1 }))

  useEffect(() => {
    const controller = new AbortController()
    dispatch({ type: 'core_loading' })
    let frame: number | null = null
    let idle: number | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const initialize = (): void => {
      void dataSource.initialize(controller.signal).then((core) => {
        if (controller.signal.aborted) return
        dispatch({ type: 'core_ready', core })
        announce(`Opening database ready: ${core.search.l.length.toLocaleString('en-US')} browsable lines.`)
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return
        const message = errorMessage(error)
        dispatch({ type: 'core_error', error: message })
      })
    }
    if (typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => {
        if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(initialize, { timeout: 250 })
        else timer = setTimeout(initialize, 0)
      })
    } else {
      timer = setTimeout(initialize, 0)
    }
    return () => {
      controller.abort()
      if (frame !== null) cancelAnimationFrame(frame)
      if (idle !== null && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle)
      if (timer !== null) clearTimeout(timer)
    }
  }, [dataSource, state.coreRetry])

  useEffect(() => {
    if (state.coreStatus !== 'ready') return
    const controller = new AbortController()
    dispatch({ type: 'partition_loading' })
    void dataSource.loadPartition(state.selectedEco, controller.signal).then((partition) => {
      if (controller.signal.aborted) return
      dispatch({ type: 'partition_ready', partition })
      announce(`${state.selectedEco} loaded: ${partition.lines.length} opening lines.`)
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      const message = errorMessage(error)
      dispatch({ type: 'partition_error', error: message })
    })
    return () => controller.abort()
  }, [dataSource, state.coreStatus, state.selectedEco, state.partitionRetry])

  useEffect(() => {
    if (state.coreStatus !== 'ready' || state.view !== 'data' || state.audit.status === 'ready') return
    const controller = new AbortController()
    dispatch({ type: 'audit_loading' })
    void dataSource.loadAudit(controller.signal).then((audit) => {
      if (controller.signal.aborted) return
      dispatch({ type: 'audit_ready', audit })
      announce('Data provenance and license records loaded.')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      const message = errorMessage(error)
      dispatch({ type: 'audit_error', error: message })
    })
    return () => controller.abort()
  }, [dataSource, state.auditRetry, state.coreStatus, state.view])

  useEffect(() => {
    let active = true
    let writer: DebouncedProgressWriter | null = null
    void repositorySelector().then(async ({ repository: selectedRepository, warning: selectionWarning }) => {
      if (!active) return
      let repository = selectedRepository
      let warning = selectionWarning
      let saved: ProgressV1 | null = null
      try {
        saved = await repository.load()
      } catch (error) {
        if (!active) return
        const message = errorMessage(error)
        repository = new MemoryProgressRepository()
        warning = `Saved progress could not be read (${message}). Persistent data was left untouched; this session uses memory only. Export JSON to keep new progress.`
      }
      if (!active) return
      setRepositoryKind(repository.kind)
      setStorageWarning(warning)
      if (saved) setProgress(saved)
      writer = new DebouncedProgressWriter(repository, (error) => {
        setSaveError(`Progress could not be saved: ${error.message}. Export JSON before leaving.`)
      })
      writerRef.current = writer
      setProgressHydration('ready')
      announce(saved ? 'Saved progress loaded.' : 'Progress storage ready.')
    }).catch((error: unknown) => {
      if (!active) return
      const message = errorMessage(error)
      const repository = new MemoryProgressRepository()
      setRepositoryKind('memory')
      setStorageWarning(`Progress storage initialization failed (${message}). This session uses memory only; export JSON to keep progress.`)
      writer = new DebouncedProgressWriter(repository, (saveFailure) => {
        setSaveError(`Progress could not be saved: ${saveFailure.message}. Export JSON before leaving.`)
      })
      writerRef.current = writer
      setProgressHydration('ready')
    })
    return () => {
      active = false
      if (writerRef.current === writer) writerRef.current = null
      void writer?.flush()
    }
  }, [repositorySelector])

  useEffect(() => {
    document.documentElement.dataset.theme = progress.settings.theme
  }, [progress.settings.theme])

  useEffect(() => {
    document.documentElement.dataset.motion = progress.settings.reducedMotion ? 'reduced' : 'full'
  }, [progress.settings.reducedMotion])

  useEffect(() => {
    const locale = resolveRuntimeLocale(progress.settings.locale)
    document.documentElement.lang = locale.id
    document.documentElement.dir = locale.direction
    document.title = locale.message('app.documentTitle')
  }, [progress.settings.locale])

  useEffect(() => {
    if (!subscribeProgressCards || progressHydration !== 'ready') return
    return subscribeProgressCards((cards) => {
      try {
        const verified = cards.map((card) => CardProgressSchema.parse(card))
        setProgress((current) => {
          const nextCards: Record<string, CardProgress> = { ...current.cards }
          for (const card of verified) nextCards[card.cardId] = card
          return { ...current, updatedAt: new Date().toISOString(), cards: nextCards }
        })
        setSaveError(null)
        announce(`Cloud schedule updated for ${verified.length} card${verified.length === 1 ? '' : 's'}.`)
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error('Cloud card projection was invalid')
        setSaveError(`Cloud schedule was rejected: ${failure.message}. Existing progress was kept.`)
      }
    }, (error) => {
      setSaveError(`Cloud schedule could not be refreshed: ${error.message}. Unsynced reviews remain in memory; export before leaving.`)
    })
  }, [progressHydration, subscribeProgressCards])

  const saveProgress = (next: ProgressV1): void => {
    if (progressHydration !== 'ready' || writerRef.current === null) {
      announce('Progress is still loading; no change was made.')
      return
    }
    setProgress(next)
    writerRef.current?.schedule(next)
  }

  const updateSettings = (settings: Partial<ProgressV1['settings']>): void => {
    const next = {
      ...progress,
      updatedAt: new Date().toISOString(),
      settings: { ...progress.settings, ...settings },
    }
    saveProgress(next)
  }

  const handleReview = (card: CardProgress, commit: ReviewCommitMetadata): string | undefined => {
    const now = new Date()
    const reviewLocalDate = localDateKey(now)
    const scopedStreaks = updateScopedReviewStreaks(progress, card.lineId, reviewLocalDate)
    const next = {
      ...progress,
      updatedAt: now.toISOString(),
      cards: { ...progress.cards, [card.cardId]: card },
      streak: updateReviewStreak(progress.streak, reviewLocalDate),
      ...scopedStreaks,
    }
    saveProgress(next)
    return onReviewCommit?.({ ...commit, card })
  }

  const partition = state.partition.value
  const selectedLine = partition?.lines.find((line) => line.sourceLineId === state.selectedLineId) ?? null
  const selectedVariant = partition?.verifiedLines.find((line) => line.id === state.selectedVariantId) ?? null
  const selectedForProvenance = selectedVariant ?? selectedLine
  const positionGraph = useMemo(
    () => state.core && state.drillLine
      ? positionGraphFromWire(state.core.search)
      : EMPTY_POSITION_GRAPH,
    [state.core, state.drillLine],
  )

  const selectLine = (lineId: string): void => {
    const firstVariantId = partition ? firstVariantFor(partition, lineId) : null
    dispatch({ type: 'select_line', lineId, firstVariantId })
    const name = partition?.lines.find((line) => line.sourceLineId === lineId)?.name
    if (name) announce(`${name} selected.`)
  }

  const selectSearchResult = (match: OpeningSearchMatch): void => {
    dispatch({ type: 'select_eco', eco: match.eco, lineId: match.sourceLineId })
    dispatch({ type: 'navigate', view: 'explore' })
    announce(`Loading ${match.eco}, ${match.name}.`)
  }

  const selectRepertoirePack = (summary: OpeningDataCore['variantSummaries'][number]): void => {
    dispatch({
      type: 'select_eco',
      eco: summary.eco,
      lineId: summary.sourceLineId,
      variantId: summary.id,
    })
    announce(`Loading ${summary.name}, training ${summary.trainedSide}.`)
  }

  const navItems: ReadonlyArray<{ view: AppView; label: string; icon: 'today' | 'book' | 'puzzle' | 'search' | 'progress' }> = [
    { view: 'today', label: 'Today', icon: 'today' },
    { view: 'repertoire', label: 'Repertoire', icon: 'book' },
    { view: 'puzzles', label: 'Puzzles', icon: 'puzzle' },
    { view: 'explore', label: 'Explore', icon: 'search' },
    { view: 'progress', label: 'Progress', icon: 'progress' },
  ]
  const readyCore = state.coreStatus === 'ready' ? state.core : null
  const appReady = readyCore !== null && progressHydration === 'ready'
  const dueCount = Object.values(progress.cards).filter((card) => Date.parse(card.dueAt) <= Date.now()).length
  const suggestedLine = selectedVariant?.drillEligible
    ? selectedVariant
    : partition?.verifiedLines.find((line) => line.drillEligible) ?? null

  const puzzleResource = useMemo<PuzzleResource>(() => {
    if (!suggestedLine) return { status: 'idle' }
    try {
      return { status: 'ready', puzzles: openingPuzzlesFromVerifiedLine(suggestedLine) }
    } catch (error) {
      return { status: 'error', error: errorMessage(error) }
    }
  }, [suggestedLine])

  const commitViewChange = (update: () => void): void => {
    // Navigation is intentionally committed synchronously. The native View
    // Transition API is still inconsistent across current browser engines and
    // can leave an input-blocking pseudo-element active. The keyed view stage
    // supplies the same restrained motion in CSS, including reduced-motion and
    // forced-colors fallbacks, without putting application state behind a
    // browser animation callback.
    update()
  }

  const navigateTo = (view: AppView, label: string): void => {
    focusViewAfterNavigationRef.current = true
    commitViewChange(() => dispatch({ type: 'navigate', view }))
    announce(`${label} view opened.`)
  }

  const startTraining = (line: VerifiedLine): void => {
    focusViewAfterNavigationRef.current = true
    commitViewChange(() => dispatch({ type: 'start_drill', line }))
    if (progress.settings.boardOrientation !== line.trainedSide) {
      updateSettings({ boardOrientation: line.trainedSide })
    }
    announce(`Starting ${line.name}, training ${line.trainedSide}. Flow grading is ${progress.settings.manualGrading ? 'paused for confirmation' : 'automatic'}.`)
  }

  useEffect(() => {
    if (!appReady || !focusViewAfterNavigationRef.current) return
    focusViewAfterNavigationRef.current = false
    queueMicrotask(() => mainRef.current?.focus())
  }, [appReady, state.view])

  useEffect(() => {
    if (!appReady || (state.view !== 'repertoire' && state.view !== 'explore') || state.partition.status !== 'ready') return
    try {
      globalThis.performance?.mark?.('linerecall-browse-react-commit')
      if (globalThis.performance?.getEntriesByName?.('linerecall-data-startup-start', 'mark').length > 0) {
        globalThis.performance.measure('linerecall-data-to-browse-commit', 'linerecall-data-startup-start', 'linerecall-browse-react-commit')
      }
    } catch {
      // Timing evidence is diagnostic only and must never affect app behavior.
    }
  }, [appReady, state.partition.status, state.view])

  const storageStatusMessage = saveError
    ? `Save failed: ${saveError}`
    : progressHydration === 'loading'
      ? 'Checking progress storage…'
      : storageWarning
        ?? (repositoryKind === 'cloud'
          ? 'Cloud progress sync is active.'
          : repositoryKind === 'artifact'
            ? 'Personal Artifact progress storage is active.'
            : 'Session-only progress is active. Export JSON before leaving.')
  const storageBarMessage = state.view === 'progress' && !saveError
    ? 'Progress storage details and transfer controls are shown below.'
    : storageStatusMessage

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="app-header">
        <button type="button" className="brand-button" onClick={() => navigateTo('today', 'Today')} aria-label="LineRecall home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 44 44" focusable="false">
              <path className="brand-grid" d="M4 14.5h36M4 29.5h36M14.5 4v36M29.5 4v36" />
              <path className="brand-route" d="M8.5 33.5 17 24l8 4.5L35.5 10" />
              <circle cx="8.5" cy="33.5" r="2.5" />
              <circle cx="17" cy="24" r="2.5" />
              <path className="brand-arrow" d="m30.5 10 5 0 0 5" />
            </svg>
          </span>
          <span className="brand-copy"><strong>LineRecall</strong><small>Opening study</small></span>
        </button>
        <nav className="primary-nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <button
              type="button"
              key={item.view}
              disabled={!appReady}
              aria-current={state.view === item.view ? 'page' : undefined}
              onClick={() => navigateTo(item.view, item.label)}
            >
              <NavGlyph name={item.icon} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <span className="offline-badge">
            <span className="status-dot" aria-hidden="true" /> {readyCore ? 'Offline data ready' : 'Verifying data'}
          </span>
          <button
            type="button"
            className="theme-toggle"
            aria-label={`Switch to ${progress.settings.theme === 'dark' ? 'light' : 'dark'} mode`}
            aria-pressed={progress.settings.theme === 'light'}
            disabled={progressHydration !== 'ready'}
            onClick={() => updateSettings({ theme: progress.settings.theme === 'dark' ? 'light' : 'dark' })}
          >
            <svg className="theme-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              {progress.settings.theme === 'dark'
                ? <path d="M12 3a9 9 0 1 0 9 9c-4.8 2.1-10.1-3.2-9-9z" />
                : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M19 5l-1.5 1.5 M6.5 17.5 5 19" /></>}
            </svg>
            <span className="theme-label">{progress.settings.theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </button>
          <div className="account-control" role="group" aria-label="Account and sync">
            {accountControl ?? (
              <button type="button" className="utility-button" disabled title="Accounts require the connected hosted service">Sign in</button>
            )}
          </div>
          <button type="button" className="utility-button" disabled={!appReady} onClick={() => navigateTo('data', 'Data and licenses')}>Data &amp; licenses</button>
        </div>
      </header>

      <div
        className={`global-storage-warning storage-status-bar${saveError ? ' error-warning' : ''}`}
        role={saveError ? 'alert' : undefined}
        aria-live={saveError ? 'assertive' : 'polite'}
        aria-atomic="true"
        title={storageBarMessage}
      >
        <span className="storage-message">
          <strong>{saveError ? 'Progress:' : 'Storage:'}</strong> {storageBarMessage}
        </span>
        {appReady && !saveError ? (
          <button type="button" className="text-button" onClick={() => navigateTo('progress', 'Progress')}>Manage</button>
        ) : <span className="storage-status-spacer" aria-hidden="true" />}
      </div>

      <main ref={mainRef} id="main-content" tabIndex={-1} className={appReady ? undefined : 'startup-state'}>
        <div key={`${state.view}-${state.coreRetry}`} className="view-stage" data-view={state.view}>
        {state.coreStatus === 'loading' ? (
          <>
            <LoadingState label="Verifying the offline opening database…" />
            <p className="field-help">Checksums and runtime schemas are checked before any line is shown.</p>
          </>
        ) : null}
        {state.coreStatus === 'error' ? (
          <>
            <ErrorState
              title="Opening database unavailable"
              detail={state.coreError ?? 'The embedded snapshot could not be validated.'}
              onRetry={() => dispatch({ type: 'retry_core' })}
            />
            <p className="field-help">No unverified or fabricated fallback lines are substituted.</p>
          </>
        ) : null}
        {readyCore && progressHydration === 'loading' ? (
          <>
            <LoadingState label="Loading saved progress…" />
            <p className="field-help">Training and settings remain read-only until persistent progress has been checked.</p>
          </>
        ) : null}
        {appReady && state.view === 'today' ? (
          <section className="today-view" aria-labelledby="today-title">
            <div className="today-heading">
              <div>
                <p className="eyebrow">Study queue</p>
                <h1 id="today-title">Ready when you are.</h1>
                <p>{dueCount > 0 ? `${dueCount} learner positions are due.` : 'Your scheduled reviews are clear. Continue a line or explore something new.'}</p>
              </div>
              <div className="streak-summary" role="group" aria-label={`${progress.streak.current} day review streak`}>
                <strong>{progress.streak.current}</strong>
                <span>day streak</span>
              </div>
            </div>
            <div className="today-grid">
              <article className="start-card">
                <p className="eyebrow">Next session</p>
                <h2>{suggestedLine?.name ?? 'Choose a repertoire'}</h2>
                <p>{suggestedLine ? `${suggestedLine.eco} · Train ${suggestedLine.trainedSide} · ${suggestedLine.nodes.length} learner decisions` : 'Select an engine-checked variation from the repertoire catalog.'}</p>
                {suggestedLine ? (
                  <button type="button" className="primary-action" onClick={() => startTraining(suggestedLine)}>
                    {dueCount > 0 ? 'Start due review' : 'Continue practice'}
                  </button>
                ) : (
                  <button type="button" className="primary-action" onClick={() => navigateTo('repertoire', 'Repertoire')}>Browse repertoires</button>
                )}
              </article>
              <article className="today-detail-card">
                <p className="eyebrow">Flow mode</p>
                <h2>Play the line without interruptions</h2>
                <p>Correct moves schedule automatically. Hints become Hard; corrections become Again. You can adjust the latest grade from the review log.</p>
                <label className="flow-mode-toggle">
                  <input
                    type="checkbox"
                    checked={progress.settings.manualGrading}
                    onChange={(event) => updateSettings({ manualGrading: event.currentTarget.checked })}
                  />
                  Pause to choose grades manually
                </label>
                <label className="flow-mode-toggle">
                  <input
                    type="checkbox"
                    checked={progress.settings.reducedMotion}
                    onChange={(event) => updateSettings({ reducedMotion: event.currentTarget.checked })}
                  />
                  Reduce interface motion
                </label>
              </article>
              <article className="today-detail-card evidence-note">
                <p className="eyebrow">Evidence status</p>
                <h2>Current audited snapshot</h2>
                <p>{readyCore.search.l.length.toLocaleString('en-US')} taxonomy lines are available offline. Deeper Core packs and Q2 club-player evidence remain blocked until their new data gates pass.</p>
                <button type="button" className="text-button" onClick={() => navigateTo('data', 'Data and licenses')}>Review data provenance</button>
              </article>
            </div>
          </section>
        ) : null}
        {appReady && state.view === 'repertoire' ? (
          <RepertoireView
            summaries={readyCore.variantSummaries}
            partition={state.partition}
            selectedLineId={selectedLine?.sourceLineId ?? state.selectedLineId}
            selectedVariantId={selectedVariant?.id ?? state.selectedVariantId}
            onSelectPack={selectRepertoirePack}
            onSelectVariant={(variantId) => dispatch({ type: 'select_variant', variantId })}
            onStartDrill={startTraining}
            onRetry={() => dispatch({ type: 'retry_partition' })}
            graphTraining={(
              <GraphTrainingBoundary
                resource={graphTrainingResource}
                dueCardIds={graphTrainingDueCardIds}
                orientation={progress.settings.boardOrientation}
                reducedMotion={progress.settings.reducedMotion}
                manualPacing={progress.settings.manualGrading}
                onSetOrientation={(boardOrientation) => updateSettings({ boardOrientation })}
                onAnnouncement={announce}
                {...(onGraphReviewInference ? { onInferredReview: onGraphReviewInference } : {})}
                {...(onGraphPathCompleted ? { onPathCompleted: onGraphPathCompleted } : {})}
              />
            )}
          />
        ) : null}
        {appReady && state.view === 'explore' ? (
          <section className="catalog-view catalog-view-explore" aria-label="Opening explorer">
            <header className="section-intro">
              <p className="eyebrow">Reference library</p>
              <h1>Explore openings</h1>
              <p>Search all 500 ECO codes by name, ECO, SAN/UCI sequence, or a bounded Standard PGN.</p>
            </header>
            <OpeningBrowser
              catalog={readyCore.catalog}
              searchEntries={readyCore.searchEntries}
              selectedEco={state.selectedEco}
              selectedLineId={selectedLine?.sourceLineId ?? state.selectedLineId}
              selectedVariantId={selectedVariant?.id ?? state.selectedVariantId}
              partition={state.partition}
              onSelectEco={(eco) => { dispatch({ type: 'select_eco', eco }) }}
              onSelectLine={selectLine}
              onSelectVariant={(variantId) => dispatch({ type: 'select_variant', variantId })}
              onSelectSearchResult={selectSearchResult}
              onStartDrill={startTraining}
              onRetryPartition={() => dispatch({ type: 'retry_partition' })}
              onAnnouncement={announce}
            />
          </section>
        ) : null}
        {appReady && state.view === 'puzzles' ? (
          <PuzzleView
            resource={puzzleResource}
            orientation={progress.settings.boardOrientation}
            onSetOrientation={(boardOrientation) => updateSettings({ boardOrientation })}
            onRetry={() => dispatch({ type: 'retry_partition' })}
            {...(onPuzzleSolved ? { onSolved: onPuzzleSolved } : {})}
            onExit={() => navigateTo('repertoire', 'Repertoire')}
            onAnnouncement={announce}
            reducedMotion={progress.settings.reducedMotion}
          />
        ) : null}
        {appReady && state.view === 'drill' ? (
          <DrillView
            line={state.drillLine}
            graph={positionGraph}
            progress={progress}
            orientation={progress.settings.boardOrientation}
            onSetOrientation={(boardOrientation) => updateSettings({ boardOrientation })}
            onReview={handleReview}
            manualGrading={progress.settings.manualGrading}
            reducedMotion={progress.settings.reducedMotion}
            onSetManualGrading={(manualGrading) => updateSettings({ manualGrading })}
            onAnnouncement={announce}
            onReturnToBrowser={() => navigateTo('repertoire', 'Repertoire')}
          />
        ) : null}
        {appReady && state.view === 'progress' ? (
          <ProgressView
            progress={progress}
            variantSummaries={readyCore.variantSummaries}
            searchEntries={readyCore.searchEntries}
            repositoryKind={repositoryKind}
            storageWarning={storageWarning}
            saveError={saveError}
            onImport={(imported) => saveProgress(imported)}
            onAnnouncement={announce}
          />
        ) : null}
        {appReady && state.view === 'data' && (state.audit.status === 'idle' || state.audit.status === 'loading') ? (
          <LoadingState label="Loading data provenance and licenses…" />
        ) : null}
        {appReady && state.view === 'data' && state.audit.status === 'error' ? (
          <ErrorState
            title="Data audit unavailable"
            detail={state.audit.error ?? 'The embedded audit record could not be validated.'}
            onRetry={() => dispatch({ type: 'retry_audit' })}
          />
        ) : null}
        {appReady && state.view === 'data' && state.audit.status === 'ready' && state.audit.value ? (
          <DataLicenses audit={state.audit.value} selectedLine={selectedForProvenance} />
        ) : null}
        </div>
      </main>

      <div className="global-live-region sr-only" aria-live="polite" aria-atomic="true" key={announcement.sequence}>
        {announcement.message}
      </div>
    </div>
  )
}

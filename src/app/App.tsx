import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import type { OpeningSearchMatch } from '../domain/input-validation.ts'
import type { DataManifest, OpeningPartition } from '../domain/opening-data.ts'
import {
  createEmptyProgress,
  createCard,
  localDateKey,
  scheduleReview,
  updateReviewStreak,
  CardProgressSchema,
  ProgressV1Schema,
  type CardProgress,
  type ProgressRepository,
  type ProgressV1,
} from '../domain/progress.ts'
import {
  supportsOpeningFamilies,
  type OpeningDataCore,
  type OpeningDataSource,
} from '../data/opening-data-source.ts'
import {
  DebouncedProgressWriter,
  MemoryProgressRepository,
  selectProgressRepository,
} from '../infrastructure/progress-repository.ts'
import { DataLicenses } from './components/DataLicenses.tsx'
import type { ReviewCommitMetadata } from '../domain/review-commit.ts'
import { OpeningBrowser, type PartitionResource } from './components/OpeningBrowser.tsx'
import { ProgressView } from './components/ProgressView.tsx'
import {
  OpeningFamilyView,
  type FamilyGraphResources,
  type FamilyGraphResourceSet,
} from './components/OpeningFamilyView.tsx'
import { TacticalPuzzleView } from './components/TacticalPuzzleView.tsx'
import type {
  GraphTrainingPathCompletionV1,
  GraphTrainingReviewInference,
} from '../domain/graph-training-session.ts'
import {
  GRAPH_TRAINING_CONTRACT_ID,
  GraphTrainingPathCompletionV1Schema,
} from '../domain/graph-training-session.ts'
import { ErrorState, LoadingState } from './components/ResourceState.tsx'
import { resolveRuntimeLocale } from '../i18n/registry.ts'
import type { TacticalPuzzleResource } from '../data/tactical-puzzle-resource.ts'
import type { PuzzleAttemptEventV1, PuzzleProgress, PuzzleProgressRepository } from '../domain/puzzle-progress.ts'
import { PuzzleProgressV1Schema, createEmptyPuzzleProgress } from '../domain/puzzle-progress.ts'
import {
  MemoryPuzzleProgressRepository,
  persistPuzzleAttempt,
} from '../infrastructure/puzzle-progress-repository.ts'
import {
  FamilyCoverageEventV1Schema,
  OpeningFamilyManifestV1Schema,
  validateFamilyPackGraphOwnership,
} from '../domain/opening-family.ts'
import {
  countUniqueCompletedFamilyPaths,
  MemoryFamilyTrainingJournalRepository,
  supportsFamilyTrainingJournalTransfer,
  type FamilyTrainingJournalSnapshotV1,
  type FamilyTrainingJournalRepository,
} from '../domain/family-training-journal.ts'
import {
  PortableProgressBundleV1Schema,
  createPortableProgressBundle,
  exportPortableProgressJson,
  type PortableProgressImport,
} from '../infrastructure/portable-progress-bundle.ts'
import {
  appHashForRoute,
  parseAppHash,
  type AppHashRoute,
} from './hash-route.ts'

type AppView = 'today' | 'repertoire' | 'family' | 'train' | 'puzzles' | 'explore' | 'progress' | 'data'
type PrimaryView = 'today' | 'repertoire' | 'puzzles' | 'explore' | 'progress'

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
  selectedFamilyId: string | null
  selectedFamilySide: 'white' | 'black'
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
  | { type: 'apply_route'; route: AppHashRoute }
  | { type: 'select_family_side'; familyId: string; side: 'white' | 'black' }

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
  selectedFamilyId: null,
  selectedFamilySide: 'white',
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
    case 'apply_route': {
      if (action.route.view === 'family') {
        return { ...state, view: 'family', selectedFamilyId: action.route.familyId }
      }
      if (action.route.view === 'train') {
        return {
          ...state,
          view: 'train',
          selectedFamilyId: action.route.familyId,
          selectedFamilySide: action.route.side,
        }
      }
      return { ...state, view: action.route.view }
    }
    case 'select_family_side': return {
      ...state,
      selectedFamilyId: action.familyId,
      selectedFamilySide: action.side,
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected data error occurred.'
}

function eventId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
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
  onTacticalPuzzleAttempt?: (event: PuzzleAttemptEventV1) => void | Promise<void>
  subscribeProgressCards?: (
    listener: (cards: readonly CardProgress[]) => void,
    onError: (error: Error) => void,
  ) => () => void
  subscribePuzzleProgress?: (
    listener: (progress: PuzzleProgress) => void,
    onError: (error: Error) => void,
  ) => () => void
  tacticalPuzzleResource?: TacticalPuzzleResource
  puzzleProgressRepository?: PuzzleProgressRepository
  familyGraphResources?: FamilyGraphResources
  familyTrainingJournal?: FamilyTrainingJournalRepository
  graphTrainingDueCardIds?: readonly string[]
  onGraphReviewInference?: (review: GraphTrainingReviewInference) => void
  onGraphPathCompleted?: (completion: GraphTrainingPathCompletionV1) => void | Promise<void>
}

const DEFAULT_TACTICAL_PUZZLE_RESOURCE: TacticalPuzzleResource = {
  status: 'disabled',
  reason: 'No tactical shard has passed digest, legality, opening-association, and Stockfish release verification. Opening-recall prompts are not substituted here.',
}

const DEFAULT_FAMILY_GRAPH_RESOURCES: FamilyGraphResources = {}

type FamilyLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function mergeFamilyGraphResources(
  loaded: FamilyGraphResources,
  supplied: FamilyGraphResources,
): FamilyGraphResources {
  const merged: Record<string, FamilyGraphResourceSet> = { ...loaded }
  for (const [familyId, suppliedSet] of Object.entries(supplied)) {
    const loadedSet = loaded[familyId]
    merged[familyId] = {
      ...(loadedSet ?? {}),
      ...suppliedSet,
      ...(
        loadedSet?.packResources || suppliedSet.packResources
          ? {
              packResources: {
                ...(loadedSet?.packResources ?? {}),
                ...(suppliedSet.packResources ?? {}),
              },
            }
          : {}
      ),
    }
  }
  return merged
}

function validatedFamilyGraphs(
  resources: FamilyGraphResourceSet | undefined,
  side?: 'white' | 'black',
): Array<ReturnType<typeof validateFamilyPackGraphOwnership>['graph']> {
  const manifestResult = OpeningFamilyManifestV1Schema.safeParse(resources?.manifest)
  if (!manifestResult.success) return []
  const manifest = manifestResult.data
  const sideCounts = manifest.packRefs.reduce((counts, ref) => {
    counts[ref.side] += 1
    return counts
  }, { white: 0, black: 0 })
  return manifest.packRefs.flatMap((ref) => {
    if (side !== undefined && ref.side !== side) return []
    const resource = resources?.packResources?.[ref.packId]
      ?? (sideCounts[ref.side] === 1 ? resources?.[ref.side] : undefined)
    if (resource?.status !== 'ready') return []
    try {
      return [validateFamilyPackGraphOwnership({
        manifest,
        packId: ref.packId,
        graph: resource.envelope.graph,
      }).graph]
    } catch {
      return []
    }
  })
}

function familySideFullyReady(
  resources: FamilyGraphResourceSet | undefined,
  side: 'white' | 'black',
): boolean {
  const manifestResult = OpeningFamilyManifestV1Schema.safeParse(resources?.manifest)
  if (!manifestResult.success) return false
  const expected = manifestResult.data.packRefs.filter((ref) => ref.side === side)
  return expected.length > 0 && validatedFamilyGraphs(resources, side).length === expected.length
}

function familyCompletionCountsFromSnapshot(
  snapshot: FamilyTrainingJournalSnapshotV1,
  resources: FamilyGraphResources,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [familyId, resourceSet] of Object.entries(resources)) {
    const manifest = OpeningFamilyManifestV1Schema.safeParse(resourceSet.manifest)
    if (!manifest.success || manifest.data.id !== familyId) continue
    counts[familyId] = countUniqueCompletedFamilyPaths(snapshot.coverageEvents.filter((event) =>
      event.releaseId === manifest.data.releaseId && event.familyId === familyId))
  }
  return counts
}

export function App({
  dataSource,
  repositorySelector = selectProgressRepository,
  accountControl,
  onReviewCommit,
  onTacticalPuzzleAttempt,
  subscribeProgressCards,
  subscribePuzzleProgress,
  tacticalPuzzleResource = DEFAULT_TACTICAL_PUZZLE_RESOURCE,
  puzzleProgressRepository,
  familyGraphResources = DEFAULT_FAMILY_GRAPH_RESOURCES,
  familyTrainingJournal,
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
  const [puzzleProgress, setPuzzleProgress] = useState<PuzzleProgress>(() => createEmptyPuzzleProgress())
  const [familyCompletionCount, setFamilyCompletionCount] = useState<Record<string, number>>({})
  const [loadedFamilyGraphResources, setLoadedFamilyGraphResources] = useState<FamilyGraphResources>({})
  const [familyLoadStates, setFamilyLoadStates] = useState<Record<string, FamilyLoadState>>({})
  const [familyLoadRetries, setFamilyLoadRetries] = useState<Record<string, number>>({})
  const [announcement, setAnnouncement] = useState({ message: '', sequence: 0 })
  const writerRef = useRef<DebouncedProgressWriter | null>(null)
  const progressRef = useRef(progress)
  const graphReviewWriteChainRef = useRef<Promise<void>>(Promise.resolve())
  const fallbackPuzzleProgressRepositoryRef = useRef<PuzzleProgressRepository>(new MemoryPuzzleProgressRepository())
  const fallbackFamilyTrainingJournalRef = useRef<FamilyTrainingJournalRepository>(
    new MemoryFamilyTrainingJournalRepository(),
  )
  const activePuzzleProgressRepository = puzzleProgressRepository ?? fallbackPuzzleProgressRepositoryRef.current
  const activeFamilyTrainingJournal = familyTrainingJournal ?? fallbackFamilyTrainingJournalRef.current
  const effectiveFamilyGraphResources = useMemo(
    () => mergeFamilyGraphResources(loadedFamilyGraphResources, familyGraphResources),
    [familyGraphResources, loadedFamilyGraphResources],
  )
  const mainRef = useRef<HTMLElement>(null)
  const focusViewAfterNavigationRef = useRef(false)

  const announce = (message: string): void => setAnnouncement((current) => ({ message, sequence: current.sequence + 1 }))

  useEffect(() => {
    progressRef.current = progress
  }, [progress])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const applyLocation = (focus: boolean): void => {
      const route = parseAppHash(window.location.hash)
      if (focus) focusViewAfterNavigationRef.current = true
      dispatch({ type: 'apply_route', route })
    }
    if (window.location.hash === '') {
      window.history.replaceState(null, '', appHashForRoute({ view: 'today' }))
    }
    applyLocation(false)
    const onHistoryNavigation = (): void => applyLocation(true)
    window.addEventListener('hashchange', onHistoryNavigation)
    window.addEventListener('popstate', onHistoryNavigation)
    return () => {
      window.removeEventListener('hashchange', onHistoryNavigation)
      window.removeEventListener('popstate', onHistoryNavigation)
    }
  }, [])

  useEffect(() => {
    setLoadedFamilyGraphResources({})
    setFamilyLoadStates({})
  }, [dataSource])

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
    if (
      state.coreStatus !== 'ready'
      || !state.core
      || !state.selectedFamilyId
      || !supportsOpeningFamilies(dataSource)
      || familyGraphResources[state.selectedFamilyId] !== undefined
    ) return

    const familyId = state.selectedFamilyId
    const reviewFamily = state.core.reviewFamilyCatalog.families.find(({ id }) => id === familyId)
    if (!reviewFamily) return
    const controller = new AbortController()
    setFamilyLoadStates((current) => ({ ...current, [familyId]: { status: 'loading' } }))

    const load = async (): Promise<void> => {
      const catalog = await dataSource.loadFamilyCatalog(controller.signal)
      const catalogEntry = catalog.families.find(({ id }) => id === familyId)
      if (
        !catalogEntry
        || catalogEntry.canonicalName !== reviewFamily.canonicalName
        || !sameOrderedStrings(catalogEntry.aliases, reviewFamily.aliases)
        || !sameOrderedStrings(catalogEntry.ecoCodes, reviewFamily.ecoCodes)
        || catalogEntry.taxonomyLineCount !== reviewFamily.taxonomyLineIds.length
      ) {
        throw new Error('The promoted family catalog does not match the audited taxonomy registry')
      }
      const manifest = await dataSource.loadFamilyManifest(familyId, controller.signal)
      if (!sameOrderedStrings(manifest.taxonomyLineIds, reviewFamily.taxonomyLineIds)) {
        throw new Error('The promoted family manifest owns a different taxonomy-line inventory')
      }
      const loadingResources = Object.fromEntries(
        manifest.packRefs.map(({ packId }) => [packId, { status: 'loading' as const }]),
      )
      if (controller.signal.aborted) return
      setLoadedFamilyGraphResources((current) => ({
        ...current,
        [familyId]: {
          manifest,
          packResources: loadingResources,
        },
      }))

      let nextPack = 0
      let failed = false
      const workers = Array.from(
        { length: Math.min(4, manifest.packRefs.length) },
        async (): Promise<void> => {
          while (!controller.signal.aborted) {
            const index = nextPack
            nextPack += 1
            const packRef = manifest.packRefs[index]
            if (!packRef) return
            try {
              const graph = await dataSource.loadRepertoirePack(packRef, controller.signal)
              if (controller.signal.aborted) return
              const resource = {
                status: 'ready' as const,
                envelope: {
                  contractId: GRAPH_TRAINING_CONTRACT_ID,
                  graph,
                },
              }
              setLoadedFamilyGraphResources((current) => ({
                ...current,
                [familyId]: {
                  manifest,
                  packResources: {
                    ...(current[familyId]?.packResources ?? {}),
                    [packRef.packId]: resource,
                  },
                },
              }))
            } catch (cause) {
              if (controller.signal.aborted) return
              failed = true
              const resource = {
                status: 'error' as const,
                error: errorMessage(cause),
              }
              setLoadedFamilyGraphResources((current) => ({
                ...current,
                [familyId]: {
                  manifest,
                  packResources: {
                    ...(current[familyId]?.packResources ?? {}),
                    [packRef.packId]: resource,
                  },
                },
              }))
            }
          }
        },
      )
      await Promise.all(workers)
      if (!controller.signal.aborted) {
        setFamilyLoadStates((current) => ({
          ...current,
          [familyId]: failed
            ? { status: 'error', message: 'One or more promoted family packs failed checksum or graph validation.' }
            : { status: 'ready' },
        }))
      }
    }

    void load().catch((cause: unknown) => {
      if (controller.signal.aborted) return
      const message = errorMessage(cause)
      setFamilyLoadStates((current) => ({
        ...current,
        [familyId]: { status: 'error', message },
      }))
      announce(`Audited family data could not be loaded: ${message}`)
    })
    return () => controller.abort()
  }, [
    dataSource,
    familyGraphResources,
    familyLoadRetries,
    state.core,
    state.coreStatus,
    state.selectedFamilyId,
  ])

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
      if (saved) {
        progressRef.current = saved
        setProgress(saved)
      }
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
    let active = true
    void activePuzzleProgressRepository.load().then((saved) => {
      if (active && saved) setPuzzleProgress(saved)
    }).catch((error: unknown) => {
      if (active) setSaveError(`Puzzle progress could not be read: ${errorMessage(error)}. This does not affect opening recall progress.`)
    })
    return () => { active = false }
  }, [activePuzzleProgressRepository])

  useEffect(() => {
    if (!state.selectedFamilyId || state.coreStatus !== 'ready' || !state.core) return
    let active = true
    const familyId = state.selectedFamilyId
    const resourceSet = effectiveFamilyGraphResources[familyId]
    const manifest = OpeningFamilyManifestV1Schema.safeParse(resourceSet?.manifest)
    // Family completion is release-scoped. The review catalog timestamp is
    // not a release identifier and must never be sent to a journal adapter
    // while the promoted manifest is still loading.
    if (!manifest.success || manifest.data.id !== familyId) return
    const releaseId = manifest.data.releaseId
    void activeFamilyTrainingJournal.listCoverageEvents({
      releaseId,
      familyId,
    }).then((events) => {
      if (!active) return
      setFamilyCompletionCount((current) => ({
        ...current,
        [familyId]: countUniqueCompletedFamilyPaths(events),
      }))
    }).catch((error: unknown) => {
      if (active) setSaveError(`Family completion history could not be read: ${errorMessage(error)}`)
    })
    return () => { active = false }
  }, [
    activeFamilyTrainingJournal,
    effectiveFamilyGraphResources,
    state.core,
    state.coreStatus,
    state.selectedFamilyId,
  ])

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
          const next = { ...current, updatedAt: new Date().toISOString(), cards: nextCards }
          progressRef.current = next
          return next
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

  useEffect(() => {
    if (!subscribePuzzleProgress) return
    return subscribePuzzleProgress((canonical) => {
      try {
        const verified = PuzzleProgressV1Schema.parse(canonical)
        setPuzzleProgress(verified)
        setSaveError(null)
        announce('Cloud puzzle progress updated.')
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error('Cloud puzzle projection was invalid')
        setSaveError(`Cloud puzzle progress was rejected: ${failure.message}. Existing puzzle progress was kept.`)
      }
    }, (error) => {
      setSaveError(`Cloud puzzle progress could not be refreshed: ${error.message}. Unsynced attempts remain in memory.`)
    })
  }, [subscribePuzzleProgress])

  const saveProgress = (next: ProgressV1): void => {
    if (progressHydration !== 'ready' || writerRef.current === null) {
      announce('Progress is still loading; no change was made.')
      return
    }
    progressRef.current = next
    setProgress(next)
    writerRef.current?.schedule(next)
  }

  const replaceOpeningProgress = async (next: ProgressV1): Promise<void> => {
    if (progressHydration !== 'ready' || writerRef.current === null) {
      throw new Error('Progress is still loading; no data was replaced')
    }
    const validated = ProgressV1Schema.parse(next)
    await writerRef.current.saveImmediately(validated)
    progressRef.current = validated
    setProgress(validated)
    setSaveError(null)
  }

  const exportPortableTrainingData = async (): Promise<string> => {
    if (!supportsFamilyTrainingJournalTransfer(activeFamilyTrainingJournal)) {
      throw new Error('This family-journal storage adapter cannot export a complete portable bundle')
    }
    const familyJournal = await activeFamilyTrainingJournal.exportSnapshot()
    return exportPortableProgressJson(createPortableProgressBundle({
      openingProgress: progressRef.current,
      puzzleProgress,
      familyJournal,
    }))
  }

  const replacePortableTrainingData = async (
    candidate: Extract<PortableProgressImport, { kind: 'bundle-v1' }>,
  ): Promise<void> => {
    if (progressHydration !== 'ready' || writerRef.current === null) {
      throw new Error('Progress is still loading; no data was replaced')
    }
    if (!supportsFamilyTrainingJournalTransfer(activeFamilyTrainingJournal)) {
      throw new Error('This family-journal storage adapter cannot replace a complete portable bundle')
    }
    const bundle = PortableProgressBundleV1Schema.parse(candidate.bundle)
    const previousOpening = ProgressV1Schema.parse(progressRef.current)
    const previousPuzzle = PuzzleProgressV1Schema.parse(puzzleProgress)
    const previousFamily = await activeFamilyTrainingJournal.exportSnapshot()

    try {
      await activeFamilyTrainingJournal.replaceSnapshot(bundle.familyJournal)
      await activePuzzleProgressRepository.save(bundle.puzzleProgress)
      await writerRef.current.saveImmediately(bundle.openingProgress)
    } catch (caught) {
      const rollbackFailures: string[] = []
      try {
        await activeFamilyTrainingJournal.replaceSnapshot(previousFamily)
      } catch (rollbackError) {
        rollbackFailures.push(`family journal: ${errorMessage(rollbackError)}`)
      }
      try {
        await activePuzzleProgressRepository.save(previousPuzzle)
      } catch (rollbackError) {
        rollbackFailures.push(`puzzle progress: ${errorMessage(rollbackError)}`)
      }
      try {
        await writerRef.current.saveImmediately(previousOpening)
      } catch (rollbackError) {
        rollbackFailures.push(`opening progress: ${errorMessage(rollbackError)}`)
      }
      const rollbackDetail = rollbackFailures.length === 0
        ? 'Previous stored data was restored.'
        : `Storage rollback needs attention (${rollbackFailures.join('; ')}). Export the current session before leaving.`
      throw new Error(`Training bundle could not be imported: ${errorMessage(caught)}. ${rollbackDetail}`)
    }

    progressRef.current = bundle.openingProgress
    setProgress(bundle.openingProgress)
    setPuzzleProgress(bundle.puzzleProgress)
    setFamilyCompletionCount(familyCompletionCountsFromSnapshot(bundle.familyJournal, effectiveFamilyGraphResources))
    setSaveError(null)
  }

  const updateSettings = (settings: Partial<ProgressV1['settings']>): void => {
    const current = progressRef.current
    const next = {
      ...current,
      updatedAt: new Date().toISOString(),
      settings: { ...current.settings, ...settings },
    }
    saveProgress(next)
  }

  const handleTacticalPuzzleAttempt = async (event: PuzzleAttemptEventV1): Promise<void> => {
    const next = await persistPuzzleAttempt(activePuzzleProgressRepository, event)
    setPuzzleProgress(next)
    await onTacticalPuzzleAttempt?.(event)
    announce(event.outcome === 'solved' ? 'Tactical puzzle progress saved.' : 'Puzzle skip saved without changing opening mastery.')
  }

  const commitGraphReviewInference = async (review: GraphTrainingReviewInference): Promise<void> => {
    if (progressHydration !== 'ready' || writerRef.current === null) {
      throw new Error('Progress storage is not ready')
    }
    if (!state.selectedFamilyId) throw new Error('Graph review has no active opening family')
    const ownedGraph = validatedFamilyGraphs(effectiveFamilyGraphResources[state.selectedFamilyId])
      .find(({ pack }) => pack.id === review.packId)
    const ownedNode = ownedGraph?.nodes.find(({ id }) => id === review.nodeId)
    const ownedEdge = ownedGraph?.edges.find(({ id }) => id === review.edgeId)
    if (
      !ownedGraph
      || !ownedNode
      || ownedNode.cardId !== review.cardId
      || !ownedNode.learnerTurn
      || !ownedEdge
      || ownedEdge.fromNodeId !== review.nodeId
      || ownedEdge.uci !== review.moveUci
    ) {
      throw new Error('Graph review does not belong to the active promoted family graph')
    }
    const now = new Date()
    const current = progressRef.current
    const existing = current.cards[review.cardId]
      ?? createCard(review.cardId, review.packId, review.nodeId, now)
    const card = scheduleReview(existing, review.grade, now).card
    const next = ProgressV1Schema.parse({
      ...current,
      updatedAt: now.toISOString(),
      cards: { ...current.cards, [card.cardId]: card },
      streak: updateReviewStreak(current.streak, localDateKey(now)),
    })
    if (onReviewCommit) {
      const queuedEventId = onReviewCommit({
        kind: 'review',
        grade: review.grade,
        lineId: review.packId,
        nodeId: review.nodeId,
        occurredAt: now.toISOString(),
        card,
      })
      if (!queuedEventId) throw new Error('The connected review queue did not accept this review')
    }
    await writerRef.current.saveImmediately(next)
    progressRef.current = next
    setProgress(next)
    onGraphReviewInference?.(review)
    setSaveError(null)
    announce(`${review.grade} review saved for this ${review.source} card.`)
  }

  const handleGraphReviewInference = (review: GraphTrainingReviewInference): void => {
    graphReviewWriteChainRef.current = graphReviewWriteChainRef.current
      .then(() => commitGraphReviewInference(review))
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error('Graph review could not be saved')
        setSaveError(`Graph review could not be saved: ${failure.message}. The move remains visible but was not reported as recorded.`)
        announce('Graph review was not saved. Progress storage needs attention.')
      })
  }

  const handleFamilyPathCompleted = async (
    familyId: string,
    completion: GraphTrainingPathCompletionV1,
  ): Promise<void> => {
    const completionRecord = GraphTrainingPathCompletionV1Schema.parse(completion)
    const family = state.core?.reviewFamilyCatalog.families.find(({ id }) => id === familyId)
    if (!family) throw new Error('Path completion references an opening family outside the active catalog')
    const resourceSet = effectiveFamilyGraphResources[familyId]
    const manifestResult = OpeningFamilyManifestV1Schema.safeParse(resourceSet?.manifest)
    if (!manifestResult.success || manifestResult.data.id !== familyId) {
      throw new Error('Path completion has no validated opening-family manifest')
    }
    const ownedGraph = validatedFamilyGraphs(resourceSet)
      .find((graph) =>
        graph.releaseId === completionRecord.releaseId
        && graph.pack.id === completionRecord.packId)
    if (!ownedGraph) throw new Error('Path completion does not belong to a promoted family graph resource')
    const ownedPath = ownedGraph.paths.find(({ id }) => id === completionRecord.pathId)
    if (
      !ownedPath
      || ownedPath.packId !== completionRecord.packId
      || JSON.stringify(ownedPath.familyTags) !== JSON.stringify(completionRecord.familyTags)
    ) throw new Error('Path completion does not match the promoted family graph path')
    if (supportsOpeningFamilies(dataSource)) {
      const manifest = await dataSource.loadFamilyManifest(familyId)
      if (
        !manifest.packRefs.some(({ packId }) => packId === completionRecord.packId)
        || !manifest.pathMemberships.some(({ packId, pathId }) =>
          packId === completionRecord.packId && pathId === completionRecord.pathId)
      ) throw new Error('Path completion is absent from the validated opening-family manifest')
    }
    const event = FamilyCoverageEventV1Schema.parse({
      schemaVersion: 1,
      eventId: eventId(),
      releaseId: completionRecord.releaseId,
      familyId,
      packId: completionRecord.packId,
      pathId: completionRecord.pathId,
      coverageCycleId: completionRecord.coverageCycleId,
      completedAt: completionRecord.completedAt,
    })
    const result = await activeFamilyTrainingJournal.appendCoverageEvent(event)
    if (result === 'duplicate') return
    const events = await activeFamilyTrainingJournal.listCoverageEvents({
      releaseId: completionRecord.releaseId,
      familyId,
    })
    setFamilyCompletionCount((current) => ({
      ...current,
      [familyId]: countUniqueCompletedFamilyPaths(events),
    }))
    try {
      await onGraphPathCompleted?.(completionRecord)
    } catch (error) {
      // The append-only family journal is authoritative. An optional host
      // observer must not turn a committed completion into a retry that can
      // repeat an external side effect.
      setSaveError(`A connected completion observer failed: ${errorMessage(error)}. The local family completion remains saved.`)
    }
  }

  const partition = state.partition.value
  const selectedLine = partition?.lines.find((line) => line.sourceLineId === state.selectedLineId) ?? null
  const selectedVariant = partition?.verifiedLines.find((line) => line.id === state.selectedVariantId) ?? null
  const selectedForProvenance = selectedVariant ?? selectedLine

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

  const navItems: ReadonlyArray<{ view: PrimaryView; label: string; icon: 'today' | 'book' | 'puzzle' | 'search' | 'progress' }> = [
    { view: 'today', label: 'Today', icon: 'today' },
    { view: 'repertoire', label: 'Repertoire', icon: 'book' },
    { view: 'puzzles', label: 'Puzzles', icon: 'puzzle' },
    { view: 'explore', label: 'Explore', icon: 'search' },
    { view: 'progress', label: 'Progress', icon: 'progress' },
  ]
  const readyCore = state.coreStatus === 'ready' ? state.core : null
  const appReady = readyCore !== null && progressHydration === 'ready'
  const todayActive = state.view === 'today'
  const dueCount = todayActive
    ? Object.values(progress.cards).filter((card) => Date.parse(card.dueAt) <= Date.now()).length
    : 0
  const suggestedFamily = todayActive
    ? readyCore?.reviewFamilyCatalog.families.find((family) =>
      validatedFamilyGraphs(effectiveFamilyGraphResources[family.id]).length > 0)
      ?? readyCore?.reviewFamilyCatalog.families.find(({ id }) => id === 'caro-kann')
      ?? readyCore?.reviewFamilyCatalog.families[0]
      ?? null
    : null
  const suggestedFamilySide = suggestedFamily?.availableSides[0] ?? 'white'
  const suggestedFamilyGraphReady = suggestedFamily
    ? familySideFullyReady(effectiveFamilyGraphResources[suggestedFamily.id], suggestedFamilySide)
    : false
  const effectiveGraphDueCardIds = useMemo(() => {
    if (state.view !== 'train') return [...graphTrainingDueCardIds]
    if (!state.selectedFamilyId) return [...graphTrainingDueCardIds]
    const graphs = validatedFamilyGraphs(
      effectiveFamilyGraphResources[state.selectedFamilyId],
      state.selectedFamilySide,
    )
    if (graphs.length === 0) return [...graphTrainingDueCardIds]
    const graphCardIds = new Set(
      graphs.flatMap((graph) => graph.nodes.flatMap(({ cardId }) => cardId ? [cardId] : [])),
    )
    const due = new Set(
      graphTrainingDueCardIds.filter((cardId) => graphCardIds.has(cardId)),
    )
    const now = Date.now()
    for (const cardId of graphCardIds) {
      const card = progress.cards[cardId]
      if (!card || Date.parse(card.dueAt) <= now) due.add(cardId)
    }
    return [...due].sort((left, right) => left.localeCompare(right, 'en'))
  }, [
    effectiveFamilyGraphResources,
    graphTrainingDueCardIds,
    progress.cards,
    state.selectedFamilyId,
    state.selectedFamilySide,
    state.view,
  ])
  const activeNavView = state.view === 'family' || state.view === 'train' ? 'repertoire' : state.view
  const selectedFamilyLoadState = state.selectedFamilyId
    ? familyLoadStates[state.selectedFamilyId] ?? { status: 'idle' as const }
    : { status: 'idle' as const }

  const commitViewChange = (update: () => void): void => {
    // Navigation is intentionally committed synchronously. The native View
    // Transition API is still inconsistent across current browser engines and
    // can leave an input-blocking pseudo-element active. The keyed view stage
    // supplies the same restrained motion in CSS, including reduced-motion and
    // forced-colors fallbacks, without putting application state behind a
    // browser animation callback.
    update()
  }

  const navigateRoute = (route: AppHashRoute, label: string): void => {
    focusViewAfterNavigationRef.current = true
    if (typeof window !== 'undefined') window.history.pushState(null, '', appHashForRoute(route))
    commitViewChange(() => dispatch({ type: 'apply_route', route }))
    announce(`${label} view opened.`)
  }

  const navigateTo = (
    view: Exclude<AppView, 'family' | 'train'>,
    label: string,
  ): void => navigateRoute({ view }, label)

  const openFamily = (familyId: string): void => {
    const family = readyCore?.reviewFamilyCatalog.families.find(({ id }) => id === familyId)
    if (!family) {
      announce('That opening family is not part of this audited taxonomy release.')
      return
    }
    navigateRoute({ view: 'family', familyId }, family.canonicalName)
  }

  const openFamilyForSourceLine = (sourceLineId: string): void => {
    const matches = readyCore?.reviewFamilyCatalog.families.filter((family) =>
      family.taxonomyLineIds.includes(sourceLineId)) ?? []
    if (matches.length !== 1) {
      announce(matches.length === 0
        ? 'This taxonomy line has no canonical opening-family assignment in the audited release.'
        : 'This taxonomy line has conflicting opening-family assignments. Navigation was stopped.')
      return
    }
    openFamily(matches[0]!.id)
  }

  const selectFamilySide = (familyId: string, side: 'white' | 'black'): void => {
    dispatch({ type: 'select_family_side', familyId, side })
    announce(`Train ${side} selected for ${familyId}.`)
  }

  const startFamilyTraining = (familyId: string, side: 'white' | 'black'): void => {
    if (progress.settings.boardOrientation !== side) updateSettings({ boardOrientation: side })
    navigateRoute({ view: 'train', familyId, side }, `${familyId} training`)
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
              aria-current={activeNavView === item.view ? 'page' : undefined}
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
                <h2>{suggestedFamily?.canonicalName ?? 'Choose a repertoire'}</h2>
                <p>{suggestedFamily
                  ? `${suggestedFamily.ecoCodes[0]}–${suggestedFamily.ecoCodes.at(-1)} · ${suggestedFamily.taxonomyLineIds.length} named lines · Train ${suggestedFamilySide}`
                  : 'Choose one canonical opening family from the repertoire catalog.'}</p>
                {suggestedFamily ? (
                  <button
                    type="button"
                    className="primary-action"
                    onClick={() => suggestedFamilyGraphReady
                      ? startFamilyTraining(suggestedFamily.id, suggestedFamilySide)
                      : openFamily(suggestedFamily.id)}
                  >
                    {suggestedFamilyGraphReady && dueCount > 0 ? 'Start due review' : suggestedFamilyGraphReady ? 'Continue family' : 'Open family'}
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
        {appReady && (state.view === 'repertoire' || state.view === 'family' || state.view === 'train') ? (
          <>
            {state.selectedFamilyId && selectedFamilyLoadState.status === 'loading' ? (
              <p className="resource-notice" role="status">Loading checksum-verified family packs…</p>
            ) : null}
            {state.selectedFamilyId && selectedFamilyLoadState.status === 'error' ? (
              <div className="resource-notice error-warning" role="alert">
                <span>{selectedFamilyLoadState.message}</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setFamilyLoadRetries((current) => ({
                    ...current,
                    [state.selectedFamilyId!]: (current[state.selectedFamilyId!] ?? 0) + 1,
                  }))}
                >
                  Retry family data
                </button>
              </div>
            ) : null}
            <OpeningFamilyView
              mode={state.view === 'repertoire' ? 'catalog' : state.view === 'family' ? 'detail' : 'training'}
              families={readyCore.reviewFamilyCatalog.families}
              {...(state.selectedFamilyId ? { selectedFamilyId: state.selectedFamilyId } : {})}
              selectedSide={state.selectedFamilySide}
              graphResources={effectiveFamilyGraphResources}
              familyTrainingJournal={activeFamilyTrainingJournal}
              dueCardIds={effectiveGraphDueCardIds}
              orientation={progress.settings.boardOrientation}
              reducedMotion={progress.settings.reducedMotion}
              manualPacing={progress.settings.manualGrading}
              completionCountByFamily={familyCompletionCount}
              onSelectFamily={openFamily}
              onSelectSide={selectFamilySide}
              onStartTraining={startFamilyTraining}
              onBackToCatalog={() => navigateTo('repertoire', 'Repertoire')}
              onOpenExplore={(family) => {
                dispatch({ type: 'select_eco', eco: family.ecoCodes[0]! })
                navigateTo('explore', 'Explore')
              }}
              onSetOrientation={(boardOrientation) => updateSettings({ boardOrientation })}
              onInferredReview={handleGraphReviewInference}
              onPathCompleted={handleFamilyPathCompleted}
              onAnnouncement={(message) => {
                if (!/ recorded for this (?:due|repeat) card\.$/iu.test(message)) announce(message)
              }}
            />
          </>
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
              onOpenFamily={openFamilyForSourceLine}
              onRetryPartition={() => dispatch({ type: 'retry_partition' })}
              onAnnouncement={announce}
            />
          </section>
        ) : null}
        {appReady && state.view === 'puzzles' ? (
          <TacticalPuzzleView
            resource={tacticalPuzzleResource}
            orientation={progress.settings.boardOrientation}
            onSetOrientation={(boardOrientation) => updateSettings({ boardOrientation })}
            onRetry={() => announce('No alternate tactical shard is available in this build.')}
            onAttempt={handleTacticalPuzzleAttempt}
            onAnnouncement={announce}
            reducedMotion={progress.settings.reducedMotion}
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
            puzzleProgress={puzzleProgress}
            familyCompletionCount={familyCompletionCount}
            onImport={replaceOpeningProgress}
            onPortableExport={exportPortableTrainingData}
            onPortableImport={replacePortableTrainingData}
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

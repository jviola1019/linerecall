import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoardOrientation } from '../../domain/board.ts'
import type {
  GraphTrainingPathCompletionV1,
  GraphTrainingReviewInference,
} from '../../domain/graph-training-session.ts'
import type { ReviewOpeningFamilyEntryV1 } from '../../data/review-family-catalog.ts'
import {
  type RepertoireGraphDocument,
} from '../../domain/repertoire.ts'
import {
  OpeningFamilyManifestV1Schema,
  summarizeFamilyBranchRoutes,
  validateFamilyPackGraphOwnership,
  type FamilyPackRefV1,
  type OpeningFamilyManifestV1,
} from '../../domain/opening-family.ts'
import {
  latestFamilyCoverageGeneration,
  type FamilyCoverageGenerationV1,
  type FamilyTrainingJournalRepository,
} from '../../domain/family-training-journal.ts'
import { restoreFamilyCoverageScope } from '../../domain/family-coverage-scope.ts'
import {
  GraphTrainingBoundary,
  type GraphTrainingPathGroup,
  type GraphTrainingResource,
} from './GraphTrainingBoundary.tsx'
import { EmptyState } from './ResourceState.tsx'
import type { FamilyCatalogSummaryV2 } from '../../domain/family-catalog-summary.ts'
import './training-puzzle.css'

export interface FamilyGraphResourceSet {
  /**
   * This manifest must come from the checksum-validated family data source.
   * Runtime rendering validates its strict schema and graph ownership again.
   */
  manifest?: unknown
  /** Pack resources are keyed by the pack IDs declared by the manifest. */
  packResources?: Readonly<Record<string, GraphTrainingResource>>
  /**
   * Compatibility aliases used by the current App readiness selector. They
   * may provide one pack per side, but never replace manifest packResources
   * when a side owns multiple packs.
   */
  white?: GraphTrainingResource
  black?: GraphTrainingResource
}

export type FamilyGraphResources = Readonly<Record<
  string,
  FamilyGraphResourceSet
>>

interface OpeningFamilyViewProps {
  mode: 'catalog' | 'detail' | 'training'
  families: readonly ReviewOpeningFamilyEntryV1[]
  selectedFamilyId?: string
  selectedSide?: 'white' | 'black'
  graphResources?: FamilyGraphResources
  dueCardIds?: readonly string[]
  orientation: BoardOrientation
  reducedMotion?: boolean
  manualPacing?: boolean
  completionCountByFamily?: Readonly<Record<string, number>>
  familySummaries?: readonly FamilyCatalogSummaryV2[]
  trainingMode?: 'learn' | 'review'
  familyTrainingJournal?: FamilyTrainingJournalRepository
  onSelectFamily: (familyId: string) => void
  onSelectSide: (familyId: string, side: 'white' | 'black') => void
  onStartTraining: (
    familyId: string,
    side: 'white' | 'black',
    intent?: 'resume' | 'full',
  ) => void
  onStartBranchTraining?: (
    familyId: string,
    side: 'white' | 'black',
    branchId: string,
  ) => void
  trainingEntryIntent?: 'resume' | 'full' | null
  trainingEntryBranchId?: string | null
  onTrainingEntryIntentConsumed?: () => void
  onBackToCatalog: () => void
  onOpenExplore: (family: ReviewOpeningFamilyEntryV1) => void
  onSetOrientation?: (orientation: BoardOrientation) => void
  onInferredReview?: (review: GraphTrainingReviewInference) => void
  onPathCompleted?: (familyId: string, completion: GraphTrainingPathCompletionV1) => void | Promise<void>
  onAnnouncement?: (message: string) => void
}

const FAMILY_PAGE_SIZE = 24
const BRANCH_PAGE_SIZE = 40

function randomEventId(): string {
  return globalThis.crypto.randomUUID()
}

function ecoRangeLabel(ecoCodes: readonly string[]): string {
  if (ecoCodes.length === 1) return ecoCodes[0]!
  const first = ecoCodes[0]!
  const last = ecoCodes.at(-1)!
  return first[0] === last[0] ? `${first}–${last}` : `${first}, ${last}`
}

function availableSide(
  availableSides: readonly ('white' | 'black')[],
  requested: 'white' | 'black' | undefined,
): 'white' | 'black' {
  if (requested && availableSides.includes(requested)) return requested
  return availableSides[0] ?? 'white'
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function manifestPathDisplayNames(
  manifest: OpeningFamilyManifestV1,
  packId: string,
): Readonly<Record<string, string>> {
  const branchesById = new Map(manifest.branches.map((branch) => [branch.id, branch]))
  const hierarchyName = (branchId: string): string => {
    const names: string[] = []
    const visited = new Set<string>()
    let currentId: string | undefined = branchId
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const branch = branchesById.get(currentId)
      if (!branch) break
      names.unshift(branch.canonicalName)
      currentId = branch.parentId
    }
    return names.join(' / ')
  }
  const memberships = manifest.pathMemberships.filter((membership) => membership.packId === packId)
  const baseNames = memberships.map((membership) => ({
    pathId: membership.pathId,
    name: hierarchyName(membership.primaryBranchId),
  }))
  const totals = new Map<string, number>()
  for (const { name } of baseNames) totals.set(name, (totals.get(name) ?? 0) + 1)
  const ordinals = new Map<string, number>()
  return Object.fromEntries(baseNames.map(({ pathId, name }) => {
    const ordinal = (ordinals.get(name) ?? 0) + 1
    ordinals.set(name, ordinal)
    const total = totals.get(name) ?? 1
    return [pathId, total > 1 ? `${name} · Route ${ordinal} of ${total}` : name]
  }))
}

interface FamilyBranchPracticeScope {
  id: string
  label: string
  pathIdsByPack: Readonly<Record<string, string[]>>
  pathKeys: string[]
}

interface ActiveFamilyBranchCycle {
  branchId: string
  label: string
  pathKeys: string[]
  completedPathKeys: string[]
}

function manifestFamilyBranchPracticeScopes(
  manifest: OpeningFamilyManifestV1,
  side: 'white' | 'black',
): FamilyBranchPracticeScope[] {
  const branchesById = new Map(manifest.branches.map((branch) => [branch.id, branch]))
  const sidePackIds = new Set(
    manifest.packRefs.filter((pack) => pack.side === side).map((pack) => pack.packId),
  )
  const hierarchyName = (branchId: string): string => {
    const names: string[] = []
    const visited = new Set<string>()
    let currentId: string | undefined = branchId
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const branch = branchesById.get(currentId)
      if (!branch) break
      names.unshift(branch.canonicalName)
      currentId = branch.parentId
    }
    return names.join(' / ')
  }
  const pathsByBranchAndPack = new Map<string, Map<string, Set<string>>>()
  for (const membership of manifest.pathMemberships) {
    if (!sidePackIds.has(membership.packId)) continue
    const branchIds = new Set([
      membership.primaryBranchId,
      ...membership.secondaryBranchIds,
    ])
    for (const branchId of branchIds) {
      const pathsByPack = pathsByBranchAndPack.get(branchId) ?? new Map<string, Set<string>>()
      const pathIds = pathsByPack.get(membership.packId) ?? new Set<string>()
      pathIds.add(membership.pathId)
      pathsByPack.set(membership.packId, pathIds)
      pathsByBranchAndPack.set(branchId, pathsByPack)
    }
  }

  return [...pathsByBranchAndPack.entries()].map(([branchId, pathsByPack]) => {
    const pathIdsByPack = Object.fromEntries(
      [...pathsByPack.entries()].map(([packId, pathIds]) => [packId, [...pathIds]]),
    )
    const pathKeys = Object.entries(pathIdsByPack).flatMap(([packId, pathIds]) =>
      pathIds.map((pathId) => `${packId}\0${pathId}`))
    return {
      id: branchId,
      label: hierarchyName(branchId),
      pathIdsByPack,
      pathKeys,
    }
  }).sort((left, right) =>
    right.pathKeys.length - left.pathKeys.length
    || left.label.localeCompare(right.label, 'en')
    || left.id.localeCompare(right.id, 'en'))
}

function packPracticeGroups(
  scopes: readonly FamilyBranchPracticeScope[],
  packId: string,
): GraphTrainingPathGroup[] {
  return scopes.flatMap((scope) => {
    const pathIds = scope.pathIdsByPack[packId]
    return pathIds && pathIds.length > 0
      ? [{
          id: scope.id,
          label: scope.label,
          pathIds,
          familyPathCount: scope.pathKeys.length,
        }]
      : []
  })
}

interface ResolvedFamilyPack {
  ref: FamilyPackRefV1
  resource: GraphTrainingResource
  graph: RepertoireGraphDocument | null
}

interface ResolvedFamilyResources {
  manifest: OpeningFamilyManifestV1 | null
  packs: ResolvedFamilyPack[]
  issues: string[]
}

function resolveFamilyResources(
  family: ReviewOpeningFamilyEntryV1,
  resources: FamilyGraphResourceSet | undefined,
): ResolvedFamilyResources {
  if (resources?.manifest === undefined) return { manifest: null, packs: [], issues: [] }
  const parsedManifest = OpeningFamilyManifestV1Schema.safeParse(resources.manifest)
  if (!parsedManifest.success) {
    return { manifest: null, packs: [], issues: ['The family manifest failed strict validation.'] }
  }
  const manifest = parsedManifest.data
  const issues: string[] = []
  if (
    manifest.id !== family.id
    || manifest.canonicalName !== family.canonicalName
    || !sameStrings(manifest.aliases, family.aliases)
    || !sameStrings(manifest.ecoCodes, family.ecoCodes)
    || !sameStrings(manifest.taxonomyLineIds, family.taxonomyLineIds)
  ) {
    issues.push('The promoted manifest does not match this canonical family catalog entry.')
  }
  const approvedPackIds = new Set(manifest.packRefs.map(({ packId }) => packId))
  for (const packId of Object.keys(resources.packResources ?? {})) {
    if (!approvedPackIds.has(packId)) issues.push(`Unexpected pack resource ${packId}.`)
  }

  const sidePackCounts = manifest.packRefs.reduce((counts, { side }) => {
    counts[side] += 1
    return counts
  }, { white: 0, black: 0 })
  const packs = manifest.packRefs.map((ref): ResolvedFamilyPack => {
    let resource = resources.packResources?.[ref.packId]
    const compatibilityResource = resources[ref.side]
    if (resource === undefined && sidePackCounts[ref.side] === 1 && compatibilityResource !== undefined) {
      resource = compatibilityResource
    }
    resource ??= {
      status: 'disabled',
      reason: `Pack ${ref.packId} has not been loaded from its approved content reference.`,
    }
    if (resource.status !== 'ready') return { ref, resource, graph: null }
    try {
      const validated = validateFamilyPackGraphOwnership({
        manifest,
        packId: ref.packId,
        graph: resource.envelope.graph,
      })
      return { ref, resource, graph: validated.graph }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `Pack ${ref.packId} failed ownership validation.`)
      return {
        ref,
        resource: { status: 'error', error: `Pack ${ref.packId} does not match its signed family manifest.` },
        graph: null,
      }
    }
  })
  return { manifest, packs, issues }
}

function familyFullyReady(resources: ResolvedFamilyResources): boolean {
  return resources.manifest !== null
    && resources.issues.length === 0
    && resources.packs.length > 0
    && resources.packs.every(({ resource, graph }) => resource.status === 'ready' && graph !== null)
}

function familyPathTotal(resources: ResolvedFamilyResources): number | null {
  if (!familyFullyReady(resources)) return null
  return resources.packs.reduce((total, { graph }) => total + (graph?.paths.length ?? 0), 0)
}

function readyTrainingSides(resources: ResolvedFamilyResources): Array<'white' | 'black'> {
  if (!resources.manifest || resources.issues.length > 0) return []
  return (['white', 'black'] as const).filter((side) => {
    const expected = resources.manifest!.packRefs.filter((ref) => ref.side === side)
    return expected.length > 0 && expected.every((ref) => {
      const pack = resources.packs.find(({ ref: candidate }) => candidate.packId === ref.packId)
      return pack?.resource.status === 'ready' && pack.graph !== null
    })
  })
}

function selectedSideStatus(
  packs: readonly ResolvedFamilyPack[],
  familyIssues: readonly string[],
): {
  label: string
  tone: 'ready' | 'pending' | 'error'
} {
  if (familyIssues.length > 0 || packs.some(({ resource }) => resource.status === 'error')) {
    return { label: 'Practice unavailable', tone: 'error' }
  }
  if (packs.length > 0 && packs.every(({ resource, graph }) => resource.status === 'ready' && graph !== null)) {
    return { label: 'Practice ready', tone: 'ready' }
  }
  return { label: 'Study only', tone: 'pending' }
}

function packLabel(pack: ResolvedFamilyPack, index: number): string {
  const level = pack.graph?.pack.tier === 'core' ? 'Core' : pack.graph ? 'Primer' : 'Pending'
  const eco = pack.graph?.pack.ecoCodes.join(', ')
  const paths = pack.graph?.paths.length
  return `Section ${index + 1} · ${level}${eco ? ` · ${eco}` : ''}${paths !== undefined ? ` · ${paths} paths` : ''}`
}

export function OpeningFamilyView({
  mode,
  families,
  selectedFamilyId,
  selectedSide,
  graphResources = {},
  dueCardIds = [],
  orientation,
  reducedMotion = false,
  manualPacing = false,
  completionCountByFamily = {},
  familySummaries = [],
  trainingMode = 'learn',
  familyTrainingJournal,
  onSelectFamily,
  onSelectSide,
  onStartTraining,
  onStartBranchTraining,
  trainingEntryIntent = null,
  trainingEntryBranchId = null,
  onTrainingEntryIntentConsumed,
  onBackToCatalog,
  onOpenExplore,
  onSetOrientation,
  onInferredReview,
  onPathCompleted,
  onAnnouncement,
}: OpeningFamilyViewProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [sideFilter, setSideFilter] = useState<'all' | 'white' | 'black'>('all')
  const [catalogScope, setCatalogScope] = useState<'mine' | 'all'>('all')
  const catalogScopeTouchedRef = useRef(false)
  const [visibleCount, setVisibleCount] = useState(FAMILY_PAGE_SIZE)
  const [branchQuery, setBranchQuery] = useState('')
  const [branchPage, setBranchPage] = useState(0)
  const [selectedPackByScope, setSelectedPackByScope] = useState<Record<string, string>>({})
  const [completedTrainingPathCount, setCompletedTrainingPathCount] = useState(0)
  const [completionHistoryError, setCompletionHistoryError] = useState<string | null>(null)
  const [completionHistoryHydrationKey, setCompletionHistoryHydrationKey] = useState<string | null>(null)
  const [autoStartPackId, setAutoStartPackId] = useState<string | null>(null)
  const [autoStartBranch, setAutoStartBranch] = useState<{
    packId: string
    branchId: string
    continuation: boolean
  } | null>(null)
  const [activeBranchCycle, setActiveBranchCycle] = useState<ActiveFamilyBranchCycle | null>(null)
  const [, bumpFamilyGenerationRevision] = useState(0)
  const completedTrainingPathsRef = useRef(new Set<string>())
  const fullFamilyCoverageActiveRef = useRef(false)
  const activeBranchCycleRef = useRef<ActiveFamilyBranchCycle | null>(null)
  const activeFamilyGenerationRef = useRef<FamilyCoverageGenerationV1 | null>(null)
  const completionScopeToken = useMemo(
    () => Symbol(`${mode}:${selectedFamilyId ?? 'none'}:${selectedSide ?? 'default'}`),
    [mode, selectedFamilyId, selectedSide],
  )
  const activeCompletionScopeTokenRef = useRef<symbol | null>(null)
  useEffect(() => {
    activeCompletionScopeTokenRef.current = completionScopeToken
    return () => {
      if (activeCompletionScopeTokenRef.current === completionScopeToken) {
        activeCompletionScopeTokenRef.current = null
      }
    }
  }, [completionScopeToken])
  const resolvedResources = useMemo(() => new Map(
    families.map((family) => [
      family.id,
      resolveFamilyResources(family, graphResources[family.id]),
    ]),
  ), [families, graphResources])
  const familySummaryById = useMemo(
    () => new Map(familySummaries.map((summary) => [summary.familyId, summary] as const)),
    [familySummaries],
  )
  const hasMyOpenings = useMemo(
    () => familySummaries.some((summary) =>
      summary.dueCards > 0
      || summary.completedPaths > 0
      || summary.lastReviewedAt !== undefined),
    [familySummaries],
  )
  const filteredFamilies = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en-US')
    const priority = (familyId: string): number => {
      const summary = familySummaryById.get(familyId)
      if (summary && summary.dueCards > 0) return 0
      if (summary && (summary.completedPaths > 0 || summary.lastReviewedAt)) return 1
      if (summary?.readiness === 'ready') return 2
      return 3
    }
    return families
      .filter((family) => {
        if (catalogScope === 'all') return true
        const summary = familySummaryById.get(family.id)
        return Boolean(summary && (
          summary.dueCards > 0
          || summary.completedPaths > 0
          || summary.lastReviewedAt !== undefined
        ))
      })
      .filter((family) => {
        if (sideFilter === 'all') return true
        const summary = familySummaryById.get(family.id)
        return summary?.readiness === 'ready' && summary.readySides.includes(sideFilter)
      })
      .filter((family) => needle === '' || [
        family.canonicalName,
        ...family.aliases,
        ...family.ecoCodes,
      ].join(' ').toLocaleLowerCase('en-US').includes(needle))
      .sort((left, right) =>
        priority(left.id) - priority(right.id)
        || (familySummaryById.get(right.id)?.dueCards ?? 0) - (familySummaryById.get(left.id)?.dueCards ?? 0)
        || (familySummaryById.get(right.id)?.lastReviewedAt ?? '').localeCompare(familySummaryById.get(left.id)?.lastReviewedAt ?? '', 'en')
        || left.canonicalName.localeCompare(right.canonicalName, 'en'))
  }, [catalogScope, families, familySummaryById, query, sideFilter])

  useEffect(() => {
    if (!catalogScopeTouchedRef.current) setCatalogScope(hasMyOpenings ? 'mine' : 'all')
  }, [hasMyOpenings])
  useEffect(() => setVisibleCount(FAMILY_PAGE_SIZE), [catalogScope, query, sideFilter])
  useEffect(() => {
    setBranchQuery('')
    setBranchPage(0)
  }, [selectedFamilyId, selectedSide])
  useEffect(() => {
    completedTrainingPathsRef.current = new Set<string>()
    fullFamilyCoverageActiveRef.current = false
    activeFamilyGenerationRef.current = null
    setCompletedTrainingPathCount(0)
    setCompletionHistoryError(null)
    setCompletionHistoryHydrationKey(null)
    setAutoStartPackId(null)
    setAutoStartBranch(null)
    activeBranchCycleRef.current = null
    setActiveBranchCycle(null)
  }, [mode, selectedFamilyId, selectedSide])
  useEffect(() => {
    let active = true
    if (mode !== 'training' || !selectedFamilyId || !familyTrainingJournal) {
      return () => { active = false }
    }
    const family = families.find(({ id }) => id === selectedFamilyId)
    const resources = resolvedResources.get(selectedFamilyId)
    if (!family || !resources?.manifest || resources.issues.length > 0) {
      return () => { active = false }
    }
    const manifest = resources.manifest
    const promotedSides = [...new Set(manifest.packRefs.map(({ side }) => side))]
    const side = availableSide(
      promotedSides.length > 0 ? promotedSides : family.availableSides,
      selectedSide,
    )
    const packs = resources.packs.filter(({ ref }) => ref.side === side)
    const hydrationKey = `${manifest.releaseId}\0${family.id}\0${side}`
    void Promise.all([
      familyTrainingJournal.listCoverageEvents({
        releaseId: manifest.releaseId,
        familyId: family.id,
      }),
      familyTrainingJournal.listCycleEvents({
        releaseId: manifest.releaseId,
        familyId: family.id,
        side,
      }),
    ]).then(async ([events, cycleEvents]) => {
      if (!active) return
      const generation = latestFamilyCoverageGeneration(cycleEvents)
      if (
        generation
        && (
          generation.releaseId !== manifest.releaseId
          || generation.familyId !== family.id
          || generation.side !== side
        )
      ) throw new Error('Saved family coverage generation belongs to another family scope')
      const boundCursors = generation
        ? await Promise.all(Object.entries(generation.packCycleIds).map(async ([packId, coverageCycleId]) => {
            const pack = packs.find(({ ref }) => ref.packId === packId)
            if (!pack) throw new Error(`Saved family coverage binds unavailable pack ${packId}.`)
            const cursor = await familyTrainingJournal.loadCursor({
              releaseId: generation.releaseId,
              familyId: generation.familyId,
              side: generation.side,
              packId,
              coverageCycleId,
            })
            if (!cursor) throw new Error(`Saved practice progress is incomplete for ${packId}.`)
            return cursor
          }))
        : []
      if (!active) return
      const restoredScope = generation
        ? restoreFamilyCoverageScope({
            manifest,
            side,
            generation,
            packs: packs.map(({ ref, graph }) => ({
              packId: ref.packId,
              pathIds: (graph?.paths ?? []).map(({ id }) => id),
            })),
            cursors: boundCursors,
            coverageEvents: events,
          })
        : null
      activeFamilyGenerationRef.current = generation
      const completed = new Set(restoredScope?.completedPathKeys ?? [])
      completedTrainingPathsRef.current = completed
      fullFamilyCoverageActiveRef.current = restoredScope?.kind === 'full'
      setCompletedTrainingPathCount(completed.size)
      if (restoredScope?.kind === 'branch') {
        const branch = manifestFamilyBranchPracticeScopes(manifest, side)
          .find(({ id }) => id === restoredScope.branchId)
        if (!branch || !sameStrings(branch.pathKeys, restoredScope.pathKeys)) {
          throw new Error('Saved named-branch coverage no longer matches the promoted manifest.')
        }
        const restoredBranch: ActiveFamilyBranchCycle = {
          branchId: branch.id,
          label: branch.label,
          pathKeys: [...branch.pathKeys],
          completedPathKeys: [...restoredScope.completedPathKeys],
        }
        activeBranchCycleRef.current = restoredBranch
        setActiveBranchCycle(restoredBranch)
      } else {
        activeBranchCycleRef.current = null
        setActiveBranchCycle(null)
      }
      setCompletionHistoryError(null)
      setCompletionHistoryHydrationKey(hydrationKey)
      if (trainingEntryBranchId) {
        const requestedBranch = manifestFamilyBranchPracticeScopes(manifest, side)
          .find(({ id }) => id === trainingEntryBranchId)
        const firstBranchPack = requestedBranch
          ? packs.find(({ ref, resource, graph }) =>
              resource.status === 'ready'
              && graph !== null
              && (requestedBranch.pathIdsByPack[ref.packId]?.length ?? 0) > 0)
          : undefined
        if (!requestedBranch || !firstBranchPack) {
          throw new Error('That variation is not available for this side in the current opening library.')
        }
        activeFamilyGenerationRef.current = generation
        activeBranchCycleRef.current = null
        setActiveBranchCycle(null)
        completedTrainingPathsRef.current = new Set<string>()
        setCompletedTrainingPathCount(0)
        fullFamilyCoverageActiveRef.current = false
        const packScope = `${family.id}:${side}`
        setSelectedPackByScope((current) => ({
          ...current,
          [packScope]: firstBranchPack.ref.packId,
        }))
        setAutoStartPackId(null)
        setAutoStartBranch({
          packId: firstBranchPack.ref.packId,
          branchId: requestedBranch.id,
          continuation: false,
        })
        onTrainingEntryIntentConsumed?.()
        return
      }
      const restoredBranch = restoredScope?.kind === 'branch'
        ? manifestFamilyBranchPracticeScopes(manifest, side)
          .find(({ id }) => id === restoredScope.branchId)
        : null
      const firstUnfinishedPack = packs.find(({ ref, graph }) => {
        const pathIds = restoredBranch
          ? restoredBranch.pathIdsByPack[ref.packId] ?? []
          : (graph?.paths ?? []).map(({ id }) => id)
        return pathIds.some((pathId) => !completed.has(`${ref.packId}\0${pathId}`))
      })
      const firstReadyPack = packs.find(({ resource, graph }) =>
        resource.status === 'ready' && graph !== null && graph.paths.length > 0)
      const startNewFullCycle = trainingEntryIntent !== null
        && firstReadyPack !== undefined
        && (
          generation === null
          || firstUnfinishedPack === undefined
          || (trainingEntryIntent === 'full' && restoredScope?.kind === 'branch')
        )
      if (startNewFullCycle) {
        const generationId = randomEventId()
        const generationOrdinal = (generation?.generationOrdinal ?? -1) + 1
        await familyTrainingJournal.appendCycleEvent({
          schemaVersion: 1,
          eventId: randomEventId(),
          releaseId: manifest.releaseId,
          familyId: family.id,
          side,
          generationId,
          generationOrdinal,
          kind: 'cycle_started',
          occurredAt: new Date().toISOString(),
        })
        if (!active) return
        activeFamilyGenerationRef.current = {
          releaseId: manifest.releaseId,
          familyId: family.id,
          side,
          generationId,
          generationOrdinal,
          packCycleIds: {},
        }
        completedTrainingPathsRef.current = new Set<string>()
        fullFamilyCoverageActiveRef.current = true
        activeBranchCycleRef.current = null
        setActiveBranchCycle(null)
        setCompletedTrainingPathCount(0)
        const packScope = `${family.id}:${side}`
        setSelectedPackByScope((current) => ({ ...current, [packScope]: firstReadyPack.ref.packId }))
        setAutoStartBranch(null)
        setAutoStartPackId(firstReadyPack.ref.packId)
        onTrainingEntryIntentConsumed?.()
        return
      }
      if (!firstUnfinishedPack) {
        onTrainingEntryIntentConsumed?.()
        return
      }
      const completedBoundPackExists = packs.some(({ ref, graph }) =>
        generation?.packCycleIds[ref.packId] !== undefined
        && (restoredBranch?.pathIdsByPack[ref.packId]
          ?? (graph?.paths ?? []).map(({ id }) => id))
          .every((pathId) => completed.has(`${ref.packId}\0${pathId}`)))
      const unboundStartedGeneration = generation !== null
        && Object.keys(generation.packCycleIds).length === 0
      const packScope = `${family.id}:${side}`
      setSelectedPackByScope((current) => {
        const currentPack = packs.find(({ ref }) => ref.packId === current[packScope])
        const currentPathIds = currentPack
          ? restoredBranch?.pathIdsByPack[currentPack.ref.packId]
            ?? (currentPack.graph?.paths ?? []).map(({ id }) => id)
          : []
        const currentHasUnfinishedPath = currentPack
          ? currentPathIds.some((pathId) => !completed.has(`${currentPack.ref.packId}\0${pathId}`))
          : false
        return currentHasUnfinishedPath
          ? current
          : { ...current, [packScope]: firstUnfinishedPack.ref.packId }
      })
      if (restoredBranch) {
        if (generation?.packCycleIds[firstUnfinishedPack.ref.packId] === undefined) {
          setAutoStartBranch({
            packId: firstUnfinishedPack.ref.packId,
            branchId: restoredBranch.id,
            continuation: true,
          })
        }
      } else if (completedBoundPackExists || unboundStartedGeneration) {
        fullFamilyCoverageActiveRef.current = true
        setAutoStartPackId(firstUnfinishedPack.ref.packId)
      }
      onTrainingEntryIntentConsumed?.()
    }).catch((error: unknown) => {
      if (!active) return
      const detail = error instanceof Error ? error.message : 'The completion history repository failed.'
      setCompletionHistoryError(`Saved family completion could not be read: ${detail}`)
      setCompletionHistoryHydrationKey(null)
    })
    return () => { active = false }
  }, [
    families,
    familyTrainingJournal,
    mode,
    resolvedResources,
    selectedFamilyId,
    selectedSide,
    trainingEntryBranchId,
    trainingEntryIntent,
  ])

  if (mode === 'catalog') {
    const visibleFamilies = filteredFamilies.slice(0, visibleCount)
    return (
      <section className="family-catalog-view" aria-labelledby="repertoire-title">
        <header className="family-catalog-heading">
          <div>
            <h1 id="repertoire-title">Repertoire</h1>
            <p>Choose an opening. Its sides, variations, and progress stay together.</p>
          </div>
          <dl className="family-catalog-totals" aria-label="Repertoire family totals">
            <div><dt>Families</dt><dd>{families.length}</dd></div>
            <div><dt>Reference lines</dt><dd>{families.reduce((total, family) => total + family.taxonomyLineIds.length, 0).toLocaleString('en-US')}</dd></div>
            <div><dt>Ready to train</dt><dd>{familySummaries.length > 0
              ? familySummaries.filter(({ readiness }) => readiness === 'ready').length
              : [...resolvedResources.values()].filter((resources) => readyTrainingSides(resources).length > 0).length}</dd></div>
          </dl>
        </header>
        <div className="family-catalog-scope" role="group" aria-label="Repertoire view">
          <button
            type="button"
            aria-pressed={catalogScope === 'mine'}
            onClick={() => {
              catalogScopeTouchedRef.current = true
              setCatalogScope('mine')
            }}
          >
            My openings
          </button>
          <button
            type="button"
            aria-pressed={catalogScope === 'all'}
            onClick={() => {
              catalogScopeTouchedRef.current = true
              setCatalogScope('all')
            }}
          >
            All openings
          </button>
        </div>
        <div className="family-catalog-controls">
          <label>
            <span>Find an opening</span>
            <input
              type="search"
              maxLength={128}
              value={query}
              placeholder="Caro–Kann, B12, Sicilian…"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <fieldset className="segmented-control">
            <legend>Filter by practice side</legend>
            {(['all', 'white', 'black'] as const).map((side) => (
              <button
                type="button"
                key={side}
                aria-pressed={sideFilter === side}
                onClick={() => setSideFilter(side)}
              >
                {side === 'all' ? 'Any side' : side === 'white' ? 'White' : 'Black'}
              </button>
            ))}
          </fieldset>
        </div>
        <p className="field-help" role="status">{filteredFamilies.length} {filteredFamilies.length === 1 ? 'opening' : 'openings'} shown.</p>
        <ul className="family-card-grid" aria-label="Opening families">
          {visibleFamilies.map((family) => {
            const readyResources = resolvedResources.get(family.id) ?? { manifest: null, packs: [], issues: [] }
            const summary = familySummaryById.get(family.id)
            const completed = summary?.completedPaths ?? completionCountByFamily[family.id] ?? 0
            const resourceSides = readyTrainingSides(readyResources)
            const trainableSides = summary?.readiness === 'ready' ? summary.readySides : resourceSides
            const ready = summary?.readiness === 'ready' || resourceSides.length > 0
            const totalPaths = summary?.readiness === 'ready'
              ? summary.totalPaths
              : ready
                ? readyResources.packs.reduce((total, { graph }) => total + (graph?.paths.length ?? 0), 0)
                : null
            const readinessLabel = summary?.readiness === 'loading'
              ? 'Checking'
              : summary?.readiness === 'error' || summary?.readiness === 'corrupt'
                ? 'Unavailable'
                : summary?.readiness === 'unknown'
                  ? 'Checking'
                  : ready ? 'Ready' : 'Study only'
            const trainingLabel = trainableSides.length === 2
              ? 'White & Black'
              : trainableSides.length === 1
                ? `${trainableSides[0] === 'white' ? 'White' : 'Black'}`
                : null
            return (
              <li key={family.id}>
                <button type="button" className="family-card" onClick={() => onSelectFamily(family.id)}>
                  <span className="family-card-topline">
                    <strong>{family.canonicalName}</strong>
                    <span className={`family-graph-status ${ready ? 'ready' : summary?.readiness === 'error' || summary?.readiness === 'corrupt' ? 'error' : 'pending'}`}>
                      <span aria-hidden="true">{ready ? '✓' : '○'}</span> {readinessLabel}
                    </span>
                  </span>
                  <span className="family-eco">{ecoRangeLabel(family.ecoCodes)}</span>
                  <span className="family-card-meta">
                    {trainingLabel ? `${trainingLabel} · ` : ''}{family.taxonomyLineIds.length} reference lines
                    {summary?.learnerDepthRange ? ` · ${summary.learnerDepthRange[0]}–${summary.learnerDepthRange[1]} moves` : ''}
                  </span>
                  <span className="family-card-progress">
                    <span>{totalPaths !== null && totalPaths > 0
                      ? `${Math.min(completed, totalPaths)} of ${totalPaths} variations practiced${summary && summary.dueCards > 0 ? ` · ${summary.dueCards} due` : ''}`
                      : 'View opening'}</span>
                    {totalPaths !== null && totalPaths > 0 ? (
                      <progress
                        max={totalPaths}
                        value={Math.min(completed, totalPaths)}
                        aria-label={`${Math.min(completed, totalPaths)} of ${totalPaths} ${family.canonicalName} variations practiced`}
                      />
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {visibleFamilies.length === 0 ? (
          <>
            <EmptyState
              title={catalogScope === 'mine' ? 'No openings started yet' : 'No openings match'}
              detail={catalogScope === 'mine' ? 'Choose an opening from the full library to begin.' : 'Try another name, ECO code, alias, or side.'}
            />
            {catalogScope === 'mine' ? (
              <button
                type="button"
                className="primary-action family-show-more"
                onClick={() => {
                  catalogScopeTouchedRef.current = true
                  setCatalogScope('all')
                }}
              >
                Browse all openings
              </button>
            ) : null}
          </>
        ) : null}
        {visibleFamilies.length < filteredFamilies.length ? (
          <button type="button" className="secondary-button family-show-more" onClick={() => setVisibleCount((count) => count + FAMILY_PAGE_SIZE)}>
            Show more openings
          </button>
        ) : null}
      </section>
    )
  }

  const family = families.find(({ id }) => id === selectedFamilyId)
  if (!family) {
    return (
      <section className="family-detail-view">
        <EmptyState title="Opening family not found" detail="The link is invalid or belongs to another data release." />
        <button type="button" className="primary-action" onClick={onBackToCatalog}>Back to Repertoire</button>
      </section>
    )
  }
  const familyResources = resolvedResources.get(family.id) ?? { manifest: null, packs: [], issues: [] }
  const promotedSides = familyResources.manifest
    ? [...new Set(familyResources.manifest.packRefs.map(({ side: packSide }) => packSide))]
    : []
  const availableSides = promotedSides.length > 0 ? promotedSides : family.availableSides
  const side = availableSide(availableSides, selectedSide)
  const sidePacks = familyResources.packs.filter(({ ref }) => ref.side === side)
  const sideReady = familyResources.issues.length === 0
    && sidePacks.length > 0
    && sidePacks.every(({ resource: packResource, graph }) => packResource.status === 'ready' && graph !== null)
  const packScope = `${family.id}:${side}`
  const selectedPackId = selectedPackByScope[packScope]
  const selectedPack = sidePacks.find(({ ref }) => ref.packId === selectedPackId) ?? sidePacks[0] ?? null
  const selectedPackDueCardIds = selectedPack
    ? dueCardIds.filter((cardId) => cardId.startsWith(`${selectedPack.ref.packId}::`))
    : []
  const expectedPackCoverageCycleId = familyTrainingJournal && selectedPack
    ? activeFamilyGenerationRef.current?.packCycleIds[selectedPack.ref.packId] ?? null
    : undefined
  const expectedHistoryHydrationKey = familyResources.manifest
    ? `${familyResources.manifest.releaseId}\0${family.id}\0${side}`
    : null
  const completionHistoryPending = mode === 'training'
    && Boolean(familyTrainingJournal)
    && expectedHistoryHydrationKey !== null
    && completionHistoryHydrationKey !== expectedHistoryHydrationKey
    && completionHistoryError === null
  const status = selectedSideStatus(sidePacks, familyResources.issues)
  const trainingResource: GraphTrainingResource = completionHistoryError
    ? { status: 'error', error: completionHistoryError }
    : completionHistoryPending
      ? { status: 'loading' }
      : sideReady && selectedPack
        ? selectedPack.resource
        : familyResources.issues.length > 0
      ? { status: 'error', error: familyResources.issues[0]! }
      : {
          status: 'disabled',
          reason: 'Guided practice for this opening and side is not ready yet.',
        }
  const pathDisplayNameById = familyResources.manifest && selectedPack
    ? manifestPathDisplayNames(familyResources.manifest, selectedPack.ref.packId)
    : undefined
  const familyBranchPracticeScopes = familyResources.manifest
    ? manifestFamilyBranchPracticeScopes(familyResources.manifest, side)
    : []
  const selectedPackPathGroups = selectedPack
    ? packPracticeGroups(familyBranchPracticeScopes, selectedPack.ref.packId)
    : []
  let branchRoutes = familyResources.manifest && sideReady
    ? summarizeFamilyBranchRoutes({
        manifest: familyResources.manifest,
        side,
        paths: sidePacks.flatMap(({ ref, graph }) => (graph?.paths ?? []).map((path) => ({
          packId: ref.packId,
          pathId: path.id,
          learnerDecisionCount: path.learnerDecisionCount,
          terminalStatus: path.terminalStatus,
        }))),
      })
    : []
  if (familyResources.issues.length > 0) branchRoutes = []
  const normalizedBranchQuery = branchQuery.trim().toLocaleLowerCase('en-US')
  const filteredBranchRoutes = normalizedBranchQuery === ''
    ? branchRoutes
    : branchRoutes.filter(({ searchText }) => searchText.includes(normalizedBranchQuery))
  const branchPageCount = Math.max(1, Math.ceil(filteredBranchRoutes.length / BRANCH_PAGE_SIZE))
  const boundedBranchPage = Math.min(branchPage, branchPageCount - 1)
  const branchPageStart = boundedBranchPage * BRANCH_PAGE_SIZE
  const visibleBranchRoutes = filteredBranchRoutes.slice(
    branchPageStart,
    branchPageStart + BRANCH_PAGE_SIZE,
  )
  const sidePaths = sidePacks.flatMap(({ graph }) => graph?.paths ?? [])
  const depthRange = sideReady && sidePaths.length > 0
    ? {
        minimum: Math.min(...sidePaths.map(({ learnerDecisionCount }) => learnerDecisionCount)),
        maximum: Math.max(...sidePaths.map(({ learnerDecisionCount }) => learnerDecisionCount)),
      }
    : null
  const packLevels = sideReady
    ? [...new Set(sidePacks.flatMap(({ graph }) => graph ? [graph.pack.tier === 'core' ? 'Core' : 'Primer'] : []))]
    : []
  const averageBranchCoverage = sideReady && sidePacks.length > 0
    ? Math.round(
        sidePacks.reduce((total, { graph }) => total + (graph?.pack.coverage ?? 0), 0)
        / sidePacks.length
        * 100,
      )
    : null
  const linkedPuzzleShardCount = familyResources.manifest?.puzzleShardRefs.length ?? null
  const familyTotalPathCount = familyPathTotal(familyResources)
  const completedFamilyPathCount = completionCountByFamily[family.id] ?? 0
  const boundedCompletedFamilyPathCount = familyTotalPathCount === null
    ? completedFamilyPathCount
    : Math.min(completedFamilyPathCount, familyTotalPathCount)

  const selectPack = (packId: string): void => {
    fullFamilyCoverageActiveRef.current = false
    activeBranchCycleRef.current = null
    setActiveBranchCycle(null)
    setAutoStartPackId(null)
    setAutoStartBranch(null)
    setSelectedPackByScope((current) => ({ ...current, [packScope]: packId }))
    onAnnouncement?.(`Selected course section ${sidePacks.findIndex(({ ref }) => ref.packId === packId) + 1}.`)
  }

  const handleCoverageScopeChange = (
    scope: 'full' | 'selection',
    detail?: { pathGroupId?: string; continuation?: boolean },
  ): void => {
    if (scope === 'full') {
      fullFamilyCoverageActiveRef.current = true
      activeBranchCycleRef.current = null
      setActiveBranchCycle(null)
      setAutoStartBranch(null)
      return
    }
    fullFamilyCoverageActiveRef.current = false
    const branch = detail?.pathGroupId
      ? familyBranchPracticeScopes.find(({ id }) => id === detail.pathGroupId)
      : undefined
    if (!branch) {
      activeBranchCycleRef.current = null
      setActiveBranchCycle(null)
      setAutoStartBranch(null)
      return
    }
    if (detail?.continuation && activeBranchCycleRef.current?.branchId === branch.id) return
    const nextCycle: ActiveFamilyBranchCycle = {
      branchId: branch.id,
      label: branch.label,
      pathKeys: [...branch.pathKeys],
      completedPathKeys: [],
    }
    activeBranchCycleRef.current = nextCycle
    setActiveBranchCycle(nextCycle)
    setAutoStartBranch(null)
  }

  const bindPackToActiveGeneration = async (
    packId: string,
    packCoverageCycleId: string,
  ): Promise<void> => {
    if (!familyTrainingJournal || !familyResources.manifest) return
    let generation = activeFamilyGenerationRef.current
    if (!generation) {
      const generationId = randomEventId()
      const startedAt = new Date().toISOString()
      await familyTrainingJournal.appendCycleEvent({
        schemaVersion: 1,
        eventId: randomEventId(),
        releaseId: familyResources.manifest.releaseId,
        familyId: family.id,
        side,
        generationId,
        generationOrdinal: 0,
        kind: 'cycle_started',
        occurredAt: startedAt,
      })
      generation = {
        releaseId: familyResources.manifest.releaseId,
        familyId: family.id,
        side,
        generationId,
        generationOrdinal: 0,
        packCycleIds: {},
      }
      activeFamilyGenerationRef.current = generation
    }
    const priorBinding = generation.packCycleIds[packId]
    if (priorBinding && priorBinding !== packCoverageCycleId) {
      throw new Error('The active family generation already binds this pack to another cycle')
    }
    if (priorBinding === packCoverageCycleId) return
    await familyTrainingJournal.appendCycleEvent({
      schemaVersion: 1,
      eventId: randomEventId(),
      releaseId: generation.releaseId,
      familyId: generation.familyId,
      side: generation.side,
      generationId: generation.generationId,
      generationOrdinal: generation.generationOrdinal,
      kind: 'pack_bound',
      packId,
      packCoverageCycleId,
      occurredAt: new Date().toISOString(),
    })
    activeFamilyGenerationRef.current = {
      ...generation,
      packCycleIds: { ...generation.packCycleIds, [packId]: packCoverageCycleId },
    }
    bumpFamilyGenerationRevision((revision) => revision + 1)
  }

  const startNamedVariationCycle = async (cycle: {
    packId: string
    coverageCycleId: string
    pathGroupId: string
    continuation: boolean
  }): Promise<void> => {
    if (!familyTrainingJournal || !familyResources.manifest) {
      throw new Error('A family progress repository is required to save named-variation coverage')
    }
    const branch = familyBranchPracticeScopes.find(({ id }) => id === cycle.pathGroupId)
    if (!branch || !(branch.pathIdsByPack[cycle.packId]?.length)) {
      throw new Error('The named variation does not own a path in this promoted pack')
    }
    if (cycle.continuation) {
      if (activeBranchCycleRef.current?.branchId !== branch.id) {
        throw new Error('Named-variation continuation does not match the active family branch')
      }
      await bindPackToActiveGeneration(cycle.packId, cycle.coverageCycleId)
      return
    }

    const previousGeneration = activeFamilyGenerationRef.current
    const generationId = randomEventId()
    const generationOrdinal = (previousGeneration?.generationOrdinal ?? -1) + 1
    const occurredAt = new Date().toISOString()
    // The binding is staged first. If the second append fails, it is an orphan
    // and latestFamilyCoverageGeneration ignores it; the prior generation stays
    // authoritative instead of exposing a half-started branch cycle.
    await familyTrainingJournal.appendCycleEvent({
      schemaVersion: 1,
      eventId: randomEventId(),
      releaseId: familyResources.manifest.releaseId,
      familyId: family.id,
      side,
      generationId,
      generationOrdinal,
      kind: 'pack_bound',
      packId: cycle.packId,
      packCoverageCycleId: cycle.coverageCycleId,
      occurredAt,
    })
    await familyTrainingJournal.appendCycleEvent({
      schemaVersion: 1,
      eventId: randomEventId(),
      releaseId: familyResources.manifest.releaseId,
      familyId: family.id,
      side,
      generationId,
      generationOrdinal,
      kind: 'cycle_started',
      occurredAt,
    })
    activeFamilyGenerationRef.current = {
      releaseId: familyResources.manifest.releaseId,
      familyId: family.id,
      side,
      generationId,
      generationOrdinal,
      packCycleIds: { [cycle.packId]: cycle.coverageCycleId },
    }
    const nextBranchCycle: ActiveFamilyBranchCycle = {
      branchId: branch.id,
      label: branch.label,
      pathKeys: [...branch.pathKeys],
      completedPathKeys: [],
    }
    activeBranchCycleRef.current = nextBranchCycle
    setActiveBranchCycle(nextBranchCycle)
    completedTrainingPathsRef.current = new Set<string>()
    setCompletedTrainingPathCount(0)
    fullFamilyCoverageActiveRef.current = false
    bumpFamilyGenerationRevision((revision) => revision + 1)
  }

  const restartFullFamilyCoverage = async (
    options?: { autoStart?: boolean },
  ): Promise<void> => {
    const firstPack = sidePacks.find(({ resource, graph }) =>
      resource.status === 'ready' && graph !== null)
    if (!firstPack) {
      onAnnouncement?.('No new variation is available for this practice round.')
      return
    }
    if (!familyTrainingJournal || !familyResources.manifest) {
      throw new Error('A family progress repository is required to start a coherent coverage generation')
    }
    const previousGeneration = activeFamilyGenerationRef.current
    const generationId = randomEventId()
    const generationOrdinal = (previousGeneration?.generationOrdinal ?? -1) + 1
    await familyTrainingJournal.appendCycleEvent({
      schemaVersion: 1,
      eventId: randomEventId(),
      releaseId: familyResources.manifest.releaseId,
      familyId: family.id,
      side,
      generationId,
      generationOrdinal,
      kind: 'cycle_started',
      occurredAt: new Date().toISOString(),
    })
    activeFamilyGenerationRef.current = {
      releaseId: familyResources.manifest.releaseId,
      familyId: family.id,
      side,
      generationId,
      generationOrdinal,
      packCycleIds: {},
    }
    completedTrainingPathsRef.current = new Set<string>()
    fullFamilyCoverageActiveRef.current = true
    setCompletedTrainingPathCount(0)
    setSelectedPackByScope((current) => ({ ...current, [packScope]: firstPack.ref.packId }))
    setAutoStartPackId(options?.autoStart === false ? null : firstPack.ref.packId)
    onAnnouncement?.('Starting a new full-opening practice run.')
  }

  const recordSuccessfulCompletion = (completion: GraphTrainingPathCompletionV1): void => {
    const branchCycle = activeBranchCycleRef.current
    if (branchCycle) {
      const pathKey = `${completion.packId}\0${completion.pathId}`
      if (!branchCycle.pathKeys.includes(pathKey) || branchCycle.completedPathKeys.includes(pathKey)) return
      const updatedBranchCycle: ActiveFamilyBranchCycle = {
        ...branchCycle,
        completedPathKeys: [...branchCycle.completedPathKeys, pathKey],
      }
      activeBranchCycleRef.current = updatedBranchCycle
      setActiveBranchCycle(updatedBranchCycle)
      const branch = familyBranchPracticeScopes.find(({ id }) => id === branchCycle.branchId)
      const completedKeys = new Set(updatedBranchCycle.completedPathKeys)
      const currentPackFinished = (branch?.pathIdsByPack[completion.packId] ?? []).every((pathId) =>
        completedKeys.has(`${completion.packId}\0${pathId}`))
      if (!currentPackFinished || !branch) return
      const nextPack = sidePacks.find(({ ref }) =>
        (branch.pathIdsByPack[ref.packId] ?? []).some((pathId) =>
          !completedKeys.has(`${ref.packId}\0${pathId}`)))
      if (nextPack && nextPack.ref.packId !== completion.packId) {
        setAutoStartBranch({ packId: nextPack.ref.packId, branchId: branch.id, continuation: true })
        setSelectedPackByScope((current) => ({ ...current, [packScope]: nextPack.ref.packId }))
        onAnnouncement?.(`Continuing ${branch.label} in the next course section.`)
      }
      return
    }
    const generation = activeFamilyGenerationRef.current
    const boundPackCycleId = generation?.packCycleIds[completion.packId]
    const countsTowardActiveFullCycle = fullFamilyCoverageActiveRef.current
      && (
        !familyTrainingJournal
        || (
          boundPackCycleId !== undefined
          && boundPackCycleId === completion.coverageCycleId
        )
      )
    if (!countsTowardActiveFullCycle) return
    completedTrainingPathsRef.current.add(`${completion.packId}\0${completion.pathId}`)
    setCompletedTrainingPathCount(completedTrainingPathsRef.current.size)
    const currentGraph = sidePacks.find(({ ref }) => ref.packId === completion.packId)?.graph
    const currentPackFinished = currentGraph?.paths.every(({ id }) =>
      completedTrainingPathsRef.current.has(`${completion.packId}\0${id}`)) ?? false
    if (!currentPackFinished || !fullFamilyCoverageActiveRef.current) return
    const currentPackIndex = sidePacks.findIndex(({ ref }) => ref.packId === completion.packId)
    const orderedCandidates = [
      ...sidePacks.slice(currentPackIndex + 1),
      ...sidePacks.slice(0, Math.max(0, currentPackIndex)),
    ]
    const nextPack = orderedCandidates.find(({ graph }) =>
      graph?.paths.some(({ id }) => !completedTrainingPathsRef.current.has(`${graph.pack.id}\0${id}`)))
    if (nextPack) {
      setAutoStartPackId(nextPack.ref.packId)
      setSelectedPackByScope((current) => ({ ...current, [packScope]: nextPack.ref.packId }))
      onAnnouncement?.('Section complete. Continuing with the next unfinished variation.')
    }
  }

  const handlePathCompleted = async (
    completion: GraphTrainingPathCompletionV1,
  ): Promise<void> => {
    if (activeCompletionScopeTokenRef.current !== completionScopeToken) return
    const completionPack = sidePacks.find(({ ref }) => ref.packId === completion.packId)
    if (
      !familyResources.manifest
      || completion.releaseId !== familyResources.manifest.releaseId
      || !completionPack?.graph
      || completionPack.graph.releaseId !== completion.releaseId
      || completionPack.graph.pack.side !== side
    ) {
      throw new Error('Completed variation does not belong to this opening, side, and release')
    }
    const capturedGeneration = activeFamilyGenerationRef.current
    if (familyTrainingJournal && (
      !capturedGeneration
      || capturedGeneration.releaseId !== completion.releaseId
      || capturedGeneration.familyId !== family.id
      || capturedGeneration.side !== side
      || capturedGeneration.packCycleIds[completion.packId] !== completion.coverageCycleId
    )) {
      throw new Error('Completed variation does not belong to the active practice round')
    }

    await onPathCompleted?.(family.id, completion)

    // A completion that finishes after route, side, or generation changes may
    // remain durably recorded for its original scope, but it must never mutate
    // the newly rendered training run.
    if (activeCompletionScopeTokenRef.current !== completionScopeToken) return
    if (familyTrainingJournal) {
      const currentGeneration = activeFamilyGenerationRef.current
      if (
        !currentGeneration
        || currentGeneration.generationId !== capturedGeneration?.generationId
        || currentGeneration.packCycleIds[completion.packId] !== completion.coverageCycleId
      ) return
    }
    recordSuccessfulCompletion(completion)
  }

  if (mode === 'training') {
    return (
      <section className="family-training-view" aria-labelledby="family-training-page-title">
        <header className="family-detail-header family-training-header">
          <button
            type="button"
            className="text-button"
            aria-label={`Back to ${family.canonicalName}`}
            onClick={() => onSelectFamily(family.id)}
          >
            <span aria-hidden="true">←</span>
            <span className="family-training-back-label">{family.canonicalName}</span>
          </button>
          <div>
            <p className="eyebrow">{ecoRangeLabel(family.ecoCodes)} · {trainingMode === 'review' ? 'Review' : 'Learn'} {side}</p>
            <h1 id="family-training-page-title">{family.canonicalName}</h1>
            <p className="family-training-description">
              {trainingMode === 'review'
                ? 'Due moves come first. Context moves keep each variation connected without changing their schedules.'
                : 'Finish one variation and the next begins automatically. All available branches stay inside this opening.'}
            </p>
            <p className="family-training-progress" role="status">
              {activeBranchCycle
                ? `${activeBranchCycle.completedPathKeys.length.toLocaleString('en-US')} of ${activeBranchCycle.pathKeys.length.toLocaleString('en-US')} routes practiced in ${activeBranchCycle.label}.`
                : `${Math.min(completedTrainingPathCount, sidePaths.length).toLocaleString('en-US')} of ${sidePaths.length.toLocaleString('en-US')} variations practiced this round.`}
            </p>
            <progress
              className="family-training-progress-track"
              max={Math.max(1, activeBranchCycle?.pathKeys.length ?? sidePaths.length)}
              value={activeBranchCycle?.completedPathKeys.length ?? Math.min(completedTrainingPathCount, sidePaths.length)}
              aria-label={activeBranchCycle
                ? `${activeBranchCycle.completedPathKeys.length} of ${activeBranchCycle.pathKeys.length} routes practiced in ${activeBranchCycle.label}`
                : `${Math.min(completedTrainingPathCount, sidePaths.length)} of ${sidePaths.length} family variations practiced`}
            />
          </div>
        </header>
        {sidePacks.length > 1 ? (
          <details className="family-course-details">
            <summary>More course details</summary>
            <p>Practice moves between these parts automatically.</p>
            <div className="family-pack-tabs" role="group" aria-label="Course parts">
              {sidePacks.map((pack, index) => (
                <button
                  type="button"
                  key={pack.ref.packId}
                  aria-pressed={selectedPack?.ref.packId === pack.ref.packId}
                  disabled={pack.resource.status !== 'ready' || pack.graph === null}
                  onClick={() => selectPack(pack.ref.packId)}
                >
                  {packLabel(pack, index)}
                </button>
              ))}
            </div>
          </details>
        ) : null}
        {completionHistoryError ? (
          <div className="inline-warning error-warning" role="alert">
            <strong>Saved family completion is unavailable.</strong>
            <span>{completionHistoryError}</span>
          </div>
        ) : null}
        <GraphTrainingBoundary
          key={selectedPack?.ref.packId ?? `${family.id}:${side}:pending`}
          resource={trainingResource}
          dueCardIds={selectedPackDueCardIds}
          orientation={orientation}
          reducedMotion={reducedMotion}
          manualPacing={manualPacing}
          {...(onSetOrientation ? { onSetOrientation } : {})}
          {...(onInferredReview ? { onInferredReview } : {})}
          onPathCompleted={handlePathCompleted}
          onStop={() => onSelectFamily(family.id)}
          autoStartFull={autoStartPackId === selectedPack?.ref.packId}
          onAutoStartConsumed={() => {
            if (autoStartPackId === selectedPack?.ref.packId) setAutoStartPackId(null)
          }}
          autoStartPathGroupId={
            autoStartBranch?.packId === selectedPack?.ref.packId
              ? autoStartBranch?.branchId ?? null
              : null
          }
          autoStartPathGroupContinuation={
            autoStartBranch?.packId === selectedPack?.ref.packId
              ? autoStartBranch?.continuation ?? true
              : true
          }
          onAutoStartPathGroupConsumed={() => {
            if (autoStartBranch?.packId === selectedPack?.ref.packId) setAutoStartBranch(null)
          }}
          onCoverageScopeChange={handleCoverageScopeChange}
          onCoverageCycleStarted={({ packId, coverageCycleId }) =>
            bindPackToActiveGeneration(packId, coverageCycleId)}
          {...(familyTrainingJournal ? {
            onNamedVariationCycleStarted: startNamedVariationCycle,
          } : {})}
          onRestartFullCoverage={restartFullFamilyCoverage}
          {...(onAnnouncement ? { onAnnouncement } : {})}
          {...(familyTrainingJournal ? {
            familyId: family.id,
            journalRepository: familyTrainingJournal,
          } : {})}
          {...(expectedPackCoverageCycleId !== undefined ? {
            expectedCoverageCycleId: expectedPackCoverageCycleId,
          } : {})}
          {...(pathDisplayNameById ? { pathDisplayNameById } : {})}
          pathGroups={selectedPackPathGroups}
        />
      </section>
    )
  }

  return (
    <section className="family-detail-view" aria-labelledby="family-detail-title">
      <header className="family-detail-header">
        <button type="button" className="text-button" onClick={onBackToCatalog}>← Repertoire</button>
        <div className="family-detail-heading-row">
          <div>
            <p className="eyebrow">{ecoRangeLabel(family.ecoCodes)}</p>
            <h1 id="family-detail-title">{family.canonicalName}</h1>
            <p>Every side, variation, move order, and linked tactic for this opening stays in one place.</p>
          </div>
          <span className={`family-graph-status ${status.tone}`}><span aria-hidden="true">{status.tone === 'ready' ? '✓' : '○'}</span> {status.label}</span>
        </div>
      </header>
      <section className="family-learning-progress" aria-labelledby="family-learning-progress-title">
        <div>
          <p className="eyebrow">Learning progress</p>
          <h2 id="family-learning-progress-title">
            {familyTotalPathCount === null
              ? `${completedFamilyPathCount} variations practiced`
              : `${boundedCompletedFamilyPathCount} of ${familyTotalPathCount} variations practiced`}
          </h2>
          <p>{familyTotalPathCount === null
            ? 'Practice will appear when this opening is ready.'
            : boundedCompletedFamilyPathCount === familyTotalPathCount
              ? 'You have practiced every available variation in this family.'
              : 'Finish one variation and the next unfinished variation starts automatically.'}</p>
        </div>
        {familyTotalPathCount !== null && familyTotalPathCount > 0 ? (
          <progress
            max={familyTotalPathCount}
            value={boundedCompletedFamilyPathCount}
            aria-label={`${boundedCompletedFamilyPathCount} of ${familyTotalPathCount} ${family.canonicalName} variations practiced`}
          />
        ) : null}
      </section>
      <section className="family-side-panel" aria-labelledby="family-side-title">
        <div>
          <p className="eyebrow">Practice side</p>
          <h2 id="family-side-title">Choose your side</h2>
        </div>
        <div className="family-side-tabs" role="group" aria-label="Practice side">
          {availableSides.map((available) => (
            <button
              type="button"
              key={available}
              aria-pressed={side === available}
              onClick={() => onSelectSide(family.id, available)}
            >
              {available === 'white' ? 'White' : 'Black'}
            </button>
          ))}
        </div>
        <div className="family-primary-actions">
          <button
            type="button"
            className="primary-action"
            disabled={!sideReady}
            onClick={() => onStartTraining(family.id, side, 'full')}
          >
            {sideReady ? 'Practice all variations' : 'Practice unavailable'}
          </button>
          <button type="button" className="secondary-button" onClick={() => onOpenExplore(family)}>Browse reference lines</button>
        </div>
        {sidePacks.length > 1 ? (
          <details className="family-course-details">
            <summary>More course details</summary>
            <p>These parts form one opening course. Practice moves between them automatically.</p>
            <div className="family-pack-tabs" role="group" aria-label="Course parts">
              {sidePacks.map((pack, index) => (
                <button
                  type="button"
                  key={pack.ref.packId}
                  aria-pressed={selectedPack?.ref.packId === pack.ref.packId}
                  disabled={pack.resource.status === 'error'}
                  onClick={() => selectPack(pack.ref.packId)}
                >
                  {packLabel(pack, index)}
                </button>
              ))}
            </div>
          </details>
        ) : null}
        {!sideReady ? (
          <p className="resource-notice">Practice is not available for this side yet. You can still browse its reference lines.</p>
        ) : null}
        {familyResources.issues.length > 0 ? (
          <p className="resource-notice" role="alert">{familyResources.issues[0]}</p>
        ) : null}
      </section>
      <dl className="family-detail-facts" aria-label={`${family.canonicalName} practice facts`}>
        <div><dt>Reference lines</dt><dd>{family.taxonomyLineIds.length}</dd></div>
        <div><dt>{side === 'white' ? 'White' : 'Black'} variations</dt><dd>{sideReady ? sidePaths.length : 'Not ready'}</dd></div>
        <div><dt>Moves to recall</dt><dd>{depthRange ? `${depthRange.minimum}–${depthRange.maximum}` : 'Pending'}</dd></div>
        <div><dt>Lesson depth</dt><dd>{packLevels.length > 0 ? packLevels.join(' and ') : 'Pending'}</dd></div>
        <div><dt>Response coverage</dt><dd>{averageBranchCoverage === null ? 'Pending' : `${averageBranchCoverage}%`}</dd></div>
        <div><dt>Linked tactics</dt><dd>{linkedPuzzleShardCount ?? 'Pending'}</dd></div>
      </dl>
      <section className="family-practice-guide" aria-labelledby="family-practice-guide-title">
        <div>
          <p className="eyebrow">How practice works</p>
          <h2 id="family-practice-guide-title">Practice every variation</h2>
          <p>
            Finish one line and the next unfinished line begins. There is no grade screen between normal moves.
          </p>
        </div>
        <ol>
          <li><span>01</span><strong>Play</strong><small>Recall each move on the board.</small></li>
          <li><span>02</span><strong>Move on</strong><small>Opponent replies play automatically, including real branch changes.</small></li>
          <li><span>03</span><strong>Finish</strong><small>Practice every available variation and keep a clear completed / total count.</small></li>
        </ol>
        <details className="practice-criteria family-practice-criteria">
          <summary>What is included</summary>
          <p>
            Only lines with enough game evidence and a completed engine check become recall moves. Full methods are in Data &amp; Licenses.
          </p>
        </details>
      </section>
      <section className="family-syllabus" aria-labelledby="family-syllabus-title">
        <div>
          <p className="eyebrow">Family syllabus</p>
          <h2 id="family-syllabus-title">Named variations</h2>
        </div>
        {sideReady ? (
          <>
            <label className="family-branch-search">
              <span>Find a variation</span>
              <input
                type="search"
                maxLength={128}
                value={branchQuery}
                placeholder="Advance, Panov, Classical…"
                onChange={(event) => {
                  setBranchQuery(event.currentTarget.value)
                  setBranchPage(0)
                }}
              />
            </label>
            <p className="field-help" role="status">
              {filteredBranchRoutes.length === 0
                ? 'No named variations match.'
                : `Showing ${branchPageStart + 1}–${branchPageStart + visibleBranchRoutes.length} of ${filteredBranchRoutes.length} named variations.`}
            </p>
            <ul className="family-branch-list" aria-label={`${family.canonicalName} variation syllabus`}>
              {visibleBranchRoutes.map((branch) => (
                <li key={branch.key}>
                  <span className="family-branch-name">
                    <strong>{branch.canonicalName}</strong>
                    <small>{branch.routeCount} route{branch.routeCount === 1 ? '' : 's'} · {branch.minimumDepth === branch.maximumDepth
                      ? `${branch.minimumDepth} learner moves`
                      : `${branch.minimumDepth}–${branch.maximumDepth} learner moves`}</small>
                  </span>
                  <button
                    type="button"
                    className="secondary-button family-branch-practice"
                    disabled={!onStartBranchTraining || branch.branchIds.length === 0}
                    aria-label={`Practice ${branch.canonicalName}`}
                    onClick={() => {
                      const branchId = branch.branchIds[0]
                      if (branchId) onStartBranchTraining?.(family.id, side, branchId)
                    }}
                  >
                    Practice
                  </button>
                </li>
              ))}
            </ul>
            {branchPageCount > 1 ? (
              <nav className="family-branch-pagination" aria-label="Variation result pages">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={boundedBranchPage === 0}
                  onClick={() => setBranchPage((page) => Math.max(0, page - 1))}
                >
                  Previous
                </button>
                <span>Page {boundedBranchPage + 1} of {branchPageCount}</span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={boundedBranchPage + 1 >= branchPageCount}
                  onClick={() => setBranchPage((page) => Math.min(branchPageCount - 1, page + 1))}
                >
                  Next
                </button>
              </nav>
            ) : null}
          </>
        ) : (
          <p>
            Named variations and practice will appear when this opening is ready.
          </p>
        )}
      </section>
    </section>
  )
}

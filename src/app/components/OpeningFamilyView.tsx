import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  familyTrainingJournal?: FamilyTrainingJournalRepository
  onSelectFamily: (familyId: string) => void
  onSelectSide: (familyId: string, side: 'white' | 'black') => void
  onStartTraining: (familyId: string, side: 'white' | 'black') => void
  onBackToCatalog: () => void
  onOpenExplore: (family: ReviewOpeningFamilyEntryV1) => void
  onSetOrientation?: (orientation: BoardOrientation) => void
  onInferredReview?: (review: GraphTrainingReviewInference) => void
  onPathCompleted?: (familyId: string, completion: GraphTrainingPathCompletionV1) => void | Promise<void>
  onAnnouncement?: (message: string) => void
}

const FAMILY_PAGE_SIZE = 36
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

function selectedSideStatus(
  packs: readonly ResolvedFamilyPack[],
  familyIssues: readonly string[],
): {
  label: string
  tone: 'ready' | 'pending' | 'error'
} {
  if (familyIssues.length > 0 || packs.some(({ resource }) => resource.status === 'error')) {
    return { label: 'Graph unavailable', tone: 'error' }
  }
  if (packs.length > 0 && packs.every(({ resource, graph }) => resource.status === 'ready' && graph !== null)) {
    return { label: packs.length === 1 ? 'Audited graph ready' : `${packs.length} audited packs ready`, tone: 'ready' }
  }
  return { label: 'Graph awaiting promotion', tone: 'pending' }
}

function packLabel(pack: ResolvedFamilyPack, index: number): string {
  const level = pack.graph?.pack.tier === 'core' ? 'Core' : pack.graph ? 'Primer' : 'Pending'
  const eco = pack.graph?.pack.ecoCodes.join(', ')
  const paths = pack.graph?.paths.length
  return `${level} pack ${index + 1}${eco ? ` · ${eco}` : ''}${paths !== undefined ? ` · ${paths} paths` : ''}`
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
  familyTrainingJournal,
  onSelectFamily,
  onSelectSide,
  onStartTraining,
  onBackToCatalog,
  onOpenExplore,
  onSetOrientation,
  onInferredReview,
  onPathCompleted,
  onAnnouncement,
}: OpeningFamilyViewProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [sideFilter, setSideFilter] = useState<'all' | 'white' | 'black'>('all')
  const [visibleCount, setVisibleCount] = useState(FAMILY_PAGE_SIZE)
  const [branchQuery, setBranchQuery] = useState('')
  const [visibleBranchCount, setVisibleBranchCount] = useState(BRANCH_PAGE_SIZE)
  const [selectedPackByScope, setSelectedPackByScope] = useState<Record<string, string>>({})
  const [completedTrainingPathCount, setCompletedTrainingPathCount] = useState(0)
  const [completionHistoryError, setCompletionHistoryError] = useState<string | null>(null)
  const [completionHistoryHydrationKey, setCompletionHistoryHydrationKey] = useState<string | null>(null)
  const [autoStartPackId, setAutoStartPackId] = useState<string | null>(null)
  const [autoStartBranch, setAutoStartBranch] = useState<{ packId: string; branchId: string } | null>(null)
  const [activeBranchCycle, setActiveBranchCycle] = useState<ActiveFamilyBranchCycle | null>(null)
  const [, bumpFamilyGenerationRevision] = useState(0)
  const [completionPersistenceFailure, setCompletionPersistenceFailure] = useState<{
    completion: GraphTrainingPathCompletionV1
    message: string
  } | null>(null)
  const completedTrainingPathsRef = useRef(new Set<string>())
  const fullFamilyCoverageActiveRef = useRef(false)
  const activeBranchCycleRef = useRef<ActiveFamilyBranchCycle | null>(null)
  const activeFamilyGenerationRef = useRef<FamilyCoverageGenerationV1 | null>(null)
  const pathCompletionHandlerRef = useRef<
    ((completion: GraphTrainingPathCompletionV1) => Promise<void>) | null
  >(null)
  const stablePathCompletionHandler = useCallback(async (
    completion: GraphTrainingPathCompletionV1,
  ): Promise<void> => {
    await pathCompletionHandlerRef.current?.(completion)
  }, [])
  const resolvedResources = useMemo(() => new Map(
    families.map((family) => [
      family.id,
      resolveFamilyResources(family, graphResources[family.id]),
    ]),
  ), [families, graphResources])
  const filteredFamilies = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en-US')
    return families
      .filter((family) => sideFilter === 'all' || family.availableSides.includes(sideFilter))
      .filter((family) => needle === '' || [
        family.canonicalName,
        ...family.aliases,
        ...family.ecoCodes,
      ].join(' ').toLocaleLowerCase('en-US').includes(needle))
      .sort((left, right) =>
        Number(right.legacyVariantCount > 0) - Number(left.legacyVariantCount > 0)
        || right.taxonomyLineIds.length - left.taxonomyLineIds.length
        || left.canonicalName.localeCompare(right.canonicalName, 'en'))
  }, [families, query, sideFilter])

  useEffect(() => setVisibleCount(FAMILY_PAGE_SIZE), [query, sideFilter])
  useEffect(() => {
    setBranchQuery('')
    setVisibleBranchCount(BRANCH_PAGE_SIZE)
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
    setCompletionPersistenceFailure(null)
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
            if (!cursor) throw new Error(`Saved family coverage is missing the bound cursor for pack ${packId}.`)
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
      if (!firstUnfinishedPack) return
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
          })
        }
      } else if (completedBoundPackExists || unboundStartedGeneration) {
        fullFamilyCoverageActiveRef.current = true
        setAutoStartPackId(firstUnfinishedPack.ref.packId)
      }
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
  ])

  if (mode === 'catalog') {
    const visibleFamilies = filteredFamilies.slice(0, visibleCount)
    return (
      <section className="family-catalog-view" aria-labelledby="repertoire-title">
        <header className="family-catalog-heading">
          <div>
            <p className="eyebrow">Opening families</p>
            <h1 id="repertoire-title">Repertoire</h1>
            <p>Choose one opening. Its sides, named variations, paths, and completion history stay together.</p>
          </div>
          <dl className="family-catalog-totals" aria-label="Repertoire family totals">
            <div><dt>Families</dt><dd>{families.length}</dd></div>
            <div><dt>Taxonomy lines</dt><dd>{families.reduce((total, family) => total + family.taxonomyLineIds.length, 0).toLocaleString('en-US')}</dd></div>
            <div><dt>Promoted graphs</dt><dd>{[...resolvedResources.values()].filter(familyFullyReady).length}</dd></div>
          </dl>
        </header>
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
            <legend>Filter by learner side</legend>
            {(['all', 'white', 'black'] as const).map((side) => (
              <button
                type="button"
                key={side}
                aria-pressed={sideFilter === side}
                onClick={() => setSideFilter(side)}
              >
                {side === 'all' ? 'Both sides' : side === 'white' ? 'White' : 'Black'}
              </button>
            ))}
          </fieldset>
        </div>
        <p className="field-help" role="status">{filteredFamilies.length} opening families match.</p>
        <ul className="family-card-grid" aria-label="Opening families">
          {visibleFamilies.map((family) => {
            const readyResources = resolvedResources.get(family.id) ?? { manifest: null, packs: [], issues: [] }
            const ready = familyFullyReady(readyResources)
            const completed = completionCountByFamily[family.id] ?? 0
            const totalPaths = familyPathTotal(readyResources)
            return (
              <li key={family.id}>
                <button type="button" className="family-card" onClick={() => onSelectFamily(family.id)}>
                  <span className="family-card-topline">
                    <strong>{family.canonicalName}</strong>
                    <span className={`family-graph-status ${ready ? 'ready' : 'pending'}`}>
                      <span aria-hidden="true">{ready ? '✓' : '○'}</span> {ready ? 'Graph ready' : 'Taxonomy'}
                    </span>
                  </span>
                  <span className="family-eco">{ecoRangeLabel(family.ecoCodes)}</span>
                  <span className="family-card-meta">
                    {family.taxonomyLineIds.length} named lines · {family.availableSides.length === 2 ? 'White and Black' : `Train ${family.availableSides[0] ?? 'unavailable'}`}
                  </span>
                  <span className="family-card-progress">
                    {totalPaths !== null && totalPaths > 0
                      ? `${Math.min(completed, totalPaths)} of ${totalPaths} audited paths completed`
                      : `${completed} audited paths completed`}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {visibleFamilies.length === 0 ? (
          <EmptyState title="No opening families match" detail="Try another name, ECO code, alias, or learner side." />
        ) : null}
        {visibleFamilies.length < filteredFamilies.length ? (
          <button type="button" className="secondary-button family-show-more" onClick={() => setVisibleCount((count) => count + FAMILY_PAGE_SIZE)}>
            Show more families
          </button>
        ) : null}
      </section>
    )
  }

  const family = families.find(({ id }) => id === selectedFamilyId)
  if (!family) {
    return (
      <section className="family-detail-view">
        <EmptyState title="Opening family not found" detail="The family link is invalid or belongs to another audited release." />
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
          reason: 'Every pack for this family and learner side must pass its manifest and graph gates before full-family training starts.',
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
  const visibleBranchRoutes = filteredBranchRoutes.slice(0, visibleBranchCount)
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
  const evidenceTerminalCount = sideReady
    ? sidePaths.filter(({ terminalStatus }) => terminalStatus === 'evidence_terminal').length
    : null
  const depthCappedCount = sideReady
    ? sidePaths.filter(({ terminalStatus }) => terminalStatus === 'depth_capped').length
    : null

  const selectPack = (packId: string): void => {
    fullFamilyCoverageActiveRef.current = false
    activeBranchCycleRef.current = null
    setActiveBranchCycle(null)
    setAutoStartPackId(null)
    setAutoStartBranch(null)
    setSelectedPackByScope((current) => ({ ...current, [packScope]: packId }))
    onAnnouncement?.(`Selected repertoire pack ${sidePacks.findIndex(({ ref }) => ref.packId === packId) + 1}.`)
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
      onAnnouncement?.('No audited pack is available for a new family coverage cycle.')
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
    setCompletionPersistenceFailure(null)
    setSelectedPackByScope((current) => ({ ...current, [packScope]: firstPack.ref.packId }))
    setAutoStartPackId(options?.autoStart === false ? null : firstPack.ref.packId)
    onAnnouncement?.('Starting a new full-family coverage cycle.')
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
        setAutoStartBranch({ packId: nextPack.ref.packId, branchId: branch.id })
        setSelectedPackByScope((current) => ({ ...current, [packScope]: nextPack.ref.packId }))
        onAnnouncement?.(`Continuing ${branch.label} in the next audited pack.`)
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
      onAnnouncement?.('Pack complete. Continuing with the next audited pack.')
    }
  }

  pathCompletionHandlerRef.current = async (completion): Promise<void> => {
    try {
      await onPathCompleted?.(family.id, completion)
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : 'The completion repository rejected the event.'
      setCompletionPersistenceFailure({ completion, message: failureMessage })
      throw error
    }
    setCompletionPersistenceFailure(null)
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
            <p className="eyebrow">{ecoRangeLabel(family.ecoCodes)} · Train {side}</p>
            <h1 id="family-training-page-title">{family.canonicalName}</h1>
            <p className="family-training-description">
              Paths continue automatically through {sidePacks.length} audited pack{sidePacks.length === 1 ? '' : 's'}.
              Every eligible branch remains available.
            </p>
            <p className="family-training-progress" role="status">
              {activeBranchCycle
                ? `${activeBranchCycle.completedPathKeys.length.toLocaleString('en-US')} of ${activeBranchCycle.pathKeys.length.toLocaleString('en-US')} ${activeBranchCycle.label} paths completed.`
                : `${Math.min(completedTrainingPathCount, sidePaths.length).toLocaleString('en-US')} of ${sidePaths.length.toLocaleString('en-US')} variations completed in this coverage run.`}
            </p>
            <progress
              className="family-training-progress-track"
              max={Math.max(1, activeBranchCycle?.pathKeys.length ?? sidePaths.length)}
              value={activeBranchCycle?.completedPathKeys.length ?? Math.min(completedTrainingPathCount, sidePaths.length)}
              aria-label={activeBranchCycle
                ? `${activeBranchCycle.completedPathKeys.length} of ${activeBranchCycle.pathKeys.length} ${activeBranchCycle.label} paths completed`
                : `${Math.min(completedTrainingPathCount, sidePaths.length)} of ${sidePaths.length} family variations completed`}
            />
          </div>
        </header>
        {sidePacks.length > 1 ? (
          <div className="family-pack-tabs" role="group" aria-label="Repertoire pack">
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
        ) : null}
        {completionHistoryError ? (
          <div className="inline-warning error-warning" role="alert">
            <strong>Saved family completion is unavailable.</strong>
            <span>{completionHistoryError}</span>
          </div>
        ) : null}
        {completionPersistenceFailure ? (
          <div className="inline-warning error-warning" role="alert">
            <strong>Path completion was not saved.</strong>
            <span>{completionPersistenceFailure.message}</span>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void stablePathCompletionHandler(completionPersistenceFailure.completion).catch(() => undefined)
              }}
            >
              Retry saving completion
            </button>
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
          onPathCompleted={stablePathCompletionHandler}
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
            <p>One workspace for every audited side, variation, transposition, and linked tactic in this opening family.</p>
          </div>
          <span className={`family-graph-status ${status.tone}`}><span aria-hidden="true">{status.tone === 'ready' ? '✓' : '○'}</span> {status.label}</span>
        </div>
      </header>
      <dl className="family-detail-facts">
        <div><dt>Named taxonomy lines</dt><dd>{family.taxonomyLineIds.length}</dd></div>
        <div><dt>Audited {side} paths</dt><dd>{sideReady ? sidePaths.length : 'Pending'}</dd></div>
        <div><dt>Decision depth</dt><dd>{depthRange ? `${depthRange.minimum}–${depthRange.maximum}` : 'Pending'}</dd></div>
        <div><dt>Pack level</dt><dd>{packLevels.length > 0 ? packLevels.join(' and ') : 'Pending'}</dd></div>
        <div><dt>Branch coverage</dt><dd>{averageBranchCoverage === null ? 'Pending' : `${averageBranchCoverage}%`}</dd></div>
        <div><dt>Linked puzzle shards</dt><dd>{linkedPuzzleShardCount ?? 'Pending'}</dd></div>
        <div><dt>Family paths completed</dt><dd>{completionCountByFamily[family.id] ?? 0}</dd></div>
      </dl>
      <section className="family-side-panel" aria-labelledby="family-side-title">
        <div>
          <p className="eyebrow">Learner side</p>
          <h2 id="family-side-title">Choose your repertoire</h2>
        </div>
        <div className="family-side-tabs" role="group" aria-label="Learner side">
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
            onClick={() => onStartTraining(family.id, side)}
          >
            {sideReady ? 'Start full family' : 'Training graph pending audit'}
          </button>
          <button type="button" className="secondary-button" onClick={() => onOpenExplore(family)}>Browse all taxonomy lines</button>
        </div>
        {sidePacks.length > 1 ? (
          <div className="family-pack-tabs" role="group" aria-label="Repertoire pack">
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
        ) : null}
        {!sideReady ? (
          <p className="resource-notice">The full family interface is ready, but this review snapshot has no promoted v3 graph. No shallow legacy rows are substituted.</p>
        ) : null}
        {familyResources.issues.length > 0 ? (
          <p className="resource-notice" role="alert">{familyResources.issues[0]}</p>
        ) : null}
      </section>
      <section className="family-practice-guide" aria-labelledby="family-practice-guide-title">
        <div>
          <p className="eyebrow">Practice flow</p>
          <h2 id="family-practice-guide-title">One run, every audited path</h2>
          <p>
            LineRecall completes one variation, records it, and begins the next unfinished variation without a grade screen between moves.
          </p>
        </div>
        <ol>
          <li><span>01</span><strong>Recall</strong><small>Play each learner move on the board.</small></li>
          <li><span>02</span><strong>Continue</strong><small>Opponent replies and branch changes follow the real graph.</small></li>
          <li><span>03</span><strong>Cover</strong><small>Finish every eligible route and keep a completed / total count.</small></li>
        </ol>
        <dl className="family-practice-evidence">
          <div><dt>Evidence terminals</dt><dd>{evidenceTerminalCount ?? 'Pending'}</dd></div>
          <div><dt>Depth-capped paths</dt><dd>{depthCappedCount ?? 'Pending'}</dd></div>
          <div><dt>Required learner sample</dt><dd>N ≥ 500</dd></div>
          <div><dt>Safety ceiling</dt><dd>Ply 100</dd></div>
        </dl>
        <p className="field-help">
          Playable and exploratory alternatives remain visible in analysis. They are not counted as required book recall unless the released graph marks them eligible.
        </p>
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
                  setVisibleBranchCount(BRANCH_PAGE_SIZE)
                }}
              />
            </label>
            <p className="field-help" role="status">
              {filteredBranchRoutes.length} named variation{filteredBranchRoutes.length === 1 ? '' : 's'} · {sidePaths.length} distinct path{sidePaths.length === 1 ? '' : 's'} across {sidePacks.length} pack{sidePacks.length === 1 ? '' : 's'}.
            </p>
            <ul className="family-branch-list" aria-label={`${family.canonicalName} variation syllabus`}>
              {visibleBranchRoutes.map((branch) => (
                <li key={branch.key}>
                  <strong>{branch.canonicalName}</strong>
                  <span>{branch.routeCount} route{branch.routeCount === 1 ? '' : 's'}</span>
                  <span>{branch.minimumDepth === branch.maximumDepth
                    ? `${branch.minimumDepth} learner moves`
                    : `${branch.minimumDepth}–${branch.maximumDepth} learner moves`}</span>
                  <span>{branch.terminalStatuses.map((terminal) => terminal.replaceAll('_', ' ')).join(', ')}</span>
                </li>
              ))}
            </ul>
            {visibleBranchRoutes.length < filteredBranchRoutes.length ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => setVisibleBranchCount((count) => count + BRANCH_PAGE_SIZE)}
              >
                Show more variations
              </button>
            ) : null}
          </>
        ) : (
          <p>
            The promoted manifest supplies the searchable branch hierarchy, exact path totals, evidence terminals,
            transpositions, and linked puzzles. This taxonomy-only review catalog intentionally does not invent them.
          </p>
        )}
      </section>
    </section>
  )
}

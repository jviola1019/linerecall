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
import type { FamilyTrainingJournalRepository } from '../../domain/family-training-journal.ts'
import {
  GraphTrainingBoundary,
  type GraphTrainingResource,
} from './GraphTrainingBoundary.tsx'
import { EmptyState } from './ResourceState.tsx'

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
  return `${level} pack ${index + 1}${eco ? ` · ${eco}` : ''}`
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
  const [completionPersistenceFailure, setCompletionPersistenceFailure] = useState<{
    completion: GraphTrainingPathCompletionV1
    message: string
  } | null>(null)
  const completedTrainingPathsRef = useRef(new Set<string>())
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
    setCompletionPersistenceFailure(null)
  }, [mode, selectedFamilyId, selectedSide])

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
  const status = selectedSideStatus(sidePacks, familyResources.issues)
  const trainingResource: GraphTrainingResource = sideReady && selectedPack
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

  const selectPack = (packId: string): void => {
    setSelectedPackByScope((current) => ({ ...current, [packScope]: packId }))
    completedTrainingPathsRef.current = new Set<string>()
    onAnnouncement?.(`Selected repertoire pack ${sidePacks.findIndex(({ ref }) => ref.packId === packId) + 1}.`)
  }

  const recordSuccessfulCompletion = (completion: GraphTrainingPathCompletionV1): void => {
    completedTrainingPathsRef.current.add(completion.pathId)
    const currentGraph = sidePacks.find(({ ref }) => ref.packId === completion.packId)?.graph
    const currentPackFinished = currentGraph?.paths.every(({ id }) =>
      completedTrainingPathsRef.current.has(id)) ?? false
    if (!currentPackFinished) return
    const currentPackIndex = sidePacks.findIndex(({ ref }) => ref.packId === completion.packId)
    const orderedCandidates = [
      ...sidePacks.slice(currentPackIndex + 1),
      ...sidePacks.slice(0, Math.max(0, currentPackIndex)),
    ]
    const nextPack = orderedCandidates.find(({ graph }) =>
      graph?.paths.some(({ id }) => !completedTrainingPathsRef.current.has(id)))
    if (nextPack) {
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
        <header className="family-detail-header">
          <button type="button" className="text-button" onClick={() => onSelectFamily(family.id)}>← {family.canonicalName}</button>
          <div>
            <p className="eyebrow">{ecoRangeLabel(family.ecoCodes)} · Train {side}</p>
            <h1 id="family-training-page-title">{family.canonicalName}</h1>
            <p>
              Paths continue automatically through {sidePacks.length} audited pack{sidePacks.length === 1 ? '' : 's'}.
              Every eligible branch remains available.
            </p>
          </div>
        </header>
        {sidePacks.length > 1 ? (
          <div className="family-pack-tabs" role="tablist" aria-label="Repertoire pack">
            {sidePacks.map((pack, index) => (
              <button
                type="button"
                role="tab"
                key={pack.ref.packId}
                aria-selected={selectedPack?.ref.packId === pack.ref.packId}
                disabled={pack.resource.status !== 'ready' || pack.graph === null}
                onClick={() => selectPack(pack.ref.packId)}
              >
                {packLabel(pack, index)}
              </button>
            ))}
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
          dueCardIds={dueCardIds}
          orientation={orientation}
          reducedMotion={reducedMotion}
          manualPacing={manualPacing}
          {...(onSetOrientation ? { onSetOrientation } : {})}
          {...(onInferredReview ? { onInferredReview } : {})}
          onPathCompleted={stablePathCompletionHandler}
          {...(onAnnouncement ? { onAnnouncement } : {})}
          {...(familyTrainingJournal ? {
            familyId: family.id,
            journalRepository: familyTrainingJournal,
          } : {})}
          {...(pathDisplayNameById ? { pathDisplayNameById } : {})}
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
        <div><dt>Family paths completed</dt><dd>{completionCountByFamily[family.id] ?? 0}</dd></div>
      </dl>
      <section className="family-side-panel" aria-labelledby="family-side-title">
        <div>
          <p className="eyebrow">Learner side</p>
          <h2 id="family-side-title">Choose your repertoire</h2>
        </div>
        <div className="family-side-tabs" role="tablist" aria-label="Learner side">
          {availableSides.map((available) => (
            <button
              type="button"
              role="tab"
              key={available}
              aria-selected={side === available}
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
          <div className="family-pack-tabs" role="tablist" aria-label="Repertoire pack">
            {sidePacks.map((pack, index) => (
              <button
                type="button"
                role="tab"
                key={pack.ref.packId}
                aria-selected={selectedPack?.ref.packId === pack.ref.packId}
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

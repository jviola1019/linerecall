import {
  FamilyCoverageEventV1Schema,
  FamilyTrainingCursorV1Schema,
  OpeningFamilyManifestV1Schema,
  type FamilyCoverageEventV1,
  type FamilyTrainingCursorV1,
  type OpeningFamilyManifestV1,
  resolveFamilyBranchGroups,
} from './opening-family.ts'
import type { FamilyCoverageGenerationV1 } from './family-training-journal.ts'

export interface FamilyCoveragePackPaths {
  packId: string
  pathIds: readonly string[]
}

export type RestoredFamilyCoverageScope =
  | {
      kind: 'full'
      completedPathKeys: string[]
    }
  | {
      kind: 'branch'
      branchId: string
      pathKeys: string[]
      completedPathKeys: string[]
    }

function unique(values: readonly string[], label: string): Set<string> {
  const result = new Set(values)
  if (result.size !== values.length) throw new Error(`${label} contains duplicate paths`)
  return result
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function pathKey(packId: string, pathId: string): string {
  return `${packId}\0${pathId}`
}

function legacyBranchPathIdsByPack(
  manifest: OpeningFamilyManifestV1,
  sidePackIds: ReadonlySet<string>,
): Map<string, Map<string, Set<string>>> {
  const result = new Map<string, Map<string, Set<string>>>()
  for (const membership of manifest.pathMemberships) {
    if (!sidePackIds.has(membership.packId)) continue
    for (const branchId of new Set([membership.primaryBranchId, ...membership.secondaryBranchIds])) {
      const byPack = result.get(branchId) ?? new Map<string, Set<string>>()
      const paths = byPack.get(membership.packId) ?? new Set<string>()
      paths.add(membership.pathId)
      byPack.set(membership.packId, paths)
      result.set(branchId, byPack)
    }
  }
  return result
}

/**
 * Reconstructs the durable scope of the latest family generation without a
 * browser-only mode flag. Exact pack-cycle bindings select immutable cursor
 * snapshots; manifest memberships then prove whether those snapshots describe
 * the full family or one named branch. Any state with more than one valid
 * interpretation fails closed.
 */
export function restoreFamilyCoverageScope(options: {
  manifest: OpeningFamilyManifestV1
  side: 'white' | 'black'
  generation: FamilyCoverageGenerationV1
  packs: readonly FamilyCoveragePackPaths[]
  cursors: readonly FamilyTrainingCursorV1[]
  coverageEvents: readonly FamilyCoverageEventV1[]
}): RestoredFamilyCoverageScope {
  const manifest = OpeningFamilyManifestV1Schema.parse(options.manifest)
  const { generation, side } = options
  if (
    generation.releaseId !== manifest.releaseId
    || generation.familyId !== manifest.id
    || generation.side !== side
  ) {
    throw new Error('Saved family generation belongs to another release, family, or side')
  }

  const sidePackIds = new Set(
    manifest.packRefs.filter((pack) => pack.side === side).map((pack) => pack.packId),
  )
  const packs = new Map<string, Set<string>>()
  for (const pack of options.packs) {
    if (!sidePackIds.has(pack.packId)) {
      throw new Error(`Coverage restore received an unexpected pack: ${pack.packId}`)
    }
    if (packs.has(pack.packId)) throw new Error(`Coverage restore received pack ${pack.packId} twice`)
    packs.set(pack.packId, unique(pack.pathIds, `Pack ${pack.packId}`))
  }
  for (const packId of sidePackIds) {
    if (!packs.has(packId)) throw new Error(`Coverage restore is missing pack ${packId}`)
  }

  const bindingEntries = Object.entries(generation.packCycleIds)
  if (bindingEntries.length === 0) {
    if (options.cursors.length > 0) {
      throw new Error('An unbound family generation cannot own pack cursors')
    }
    return { kind: 'full', completedPathKeys: [] }
  }

  const cursorByPack = new Map<string, FamilyTrainingCursorV1>()
  for (const input of options.cursors) {
    const cursor = FamilyTrainingCursorV1Schema.parse(input)
    const packId = cursor.coverageCycleId.slice(0, cursor.coverageCycleId.indexOf('::coverage:'))
    if (cursorByPack.has(packId)) throw new Error(`Coverage restore received two cursors for pack ${packId}`)
    cursorByPack.set(packId, cursor)
  }

  const selectedByPack = new Map<string, Set<string>>()
  for (const [packId, coverageCycleId] of bindingEntries) {
    if (!sidePackIds.has(packId)) throw new Error(`Family generation binds an unexpected pack: ${packId}`)
    const cursor = cursorByPack.get(packId)
    if (!cursor || cursor.coverageCycleId !== coverageCycleId) {
      throw new Error(`Family generation is missing its exact cursor for pack ${packId}`)
    }
    if (
      cursor.releaseId !== generation.releaseId
      || cursor.familyId !== generation.familyId
      || cursor.side !== generation.side
    ) {
      throw new Error(`Pack cursor ${packId} belongs to another family generation scope`)
    }
    const selected = unique(
      [...cursor.completedPathIds, ...cursor.pendingPathIds],
      `Pack cursor ${packId}`,
    )
    if (selected.size === 0) throw new Error(`Pack cursor ${packId} has no selected paths`)
    const graphPaths = packs.get(packId)!
    if ([...selected].some((pathId) => !graphPaths.has(pathId))) {
      throw new Error(`Pack cursor ${packId} references a path outside the promoted graph`)
    }
    selectedByPack.set(packId, selected)
  }
  if (cursorByPack.size !== selectedByPack.size) {
    throw new Error('Coverage restore received a cursor outside the active family generation')
  }

  const completionKeys = new Set<string>()
  for (const input of options.coverageEvents) {
    const event = FamilyCoverageEventV1Schema.parse(input)
    const boundCycle = generation.packCycleIds[event.packId]
    if (boundCycle !== event.coverageCycleId) continue
    const selected = selectedByPack.get(event.packId)
    if (!selected?.has(event.pathId)) {
      throw new Error('A bound family completion references a path outside its saved cursor')
    }
    completionKeys.add(pathKey(event.packId, event.pathId))
  }
  for (const [packId, cursor] of cursorByPack) {
    for (const completedPathId of cursor.completedPathIds) {
      if (!completionKeys.has(pathKey(packId, completedPathId))) {
        throw new Error('A saved cursor completion is missing its append-only coverage event')
      }
    }
  }

  // A full-family interpretation is valid only when every promoted side pack
  // is bound and each cursor selected that pack's complete graph. A single
  // fully-selected bound pack is not evidence that the whole family ran.
  const fullMatches = selectedByPack.size === packs.size
    && [...selectedByPack].every(([packId, selected]) => sameSet(selected, packs.get(packId)!))
  const branchGroups = resolveFamilyBranchGroups({ manifest, side })
  const groupedBranchMatches = branchGroups.filter(({ pathIdsByPack }) =>
    [...selectedByPack].every(([packId, selected]) => {
      const branchPaths = pathIdsByPack[packId]
      return branchPaths !== undefined && sameSet(selected, new Set(branchPaths))
    }))
  const legacyBranchMatches = [...legacyBranchPathIdsByPack(manifest, sidePackIds)].filter(([, pathsByPack]) =>
    [...selectedByPack].every(([packId, selected]) => {
      const branchPaths = pathsByPack.get(packId)
      return branchPaths !== undefined && sameSet(selected, branchPaths)
    }))

  // Bound packs may be a prefix of a full-family run. A matching named scope
  // is ambiguous only when its COMPLETE inventory differs from the family.
  // Identical all-pack inventories have the same remaining practice obligation.
  const boundPacksAreComplete = [...selectedByPack].every(([packId, selected]) =>
    sameSet(selected, packs.get(packId)!))
  if (fullMatches) {
    return { kind: 'full', completedPathKeys: [...completionKeys] }
  }
  if (boundPacksAreComplete) {
    const allPathKeys = new Set([...packs].flatMap(([packId, paths]) =>
      [...paths].map((pathId) => pathKey(packId, pathId))))
    const smallerScopeExists = groupedBranchMatches.some(({ pathKeys }) => !sameSet(new Set(pathKeys), allPathKeys))
      || legacyBranchMatches.some(([, byPack]) => !sameSet(new Set([...byPack].flatMap(([packId, paths]) =>
        [...paths].map((pathId) => pathKey(packId, pathId)))), allPathKeys))
    if (smallerScopeExists) throw new Error('Saved family coverage is ambiguous between full-family and named-branch practice')
    return { kind: 'full', completedPathKeys: [...completionKeys] }
  }
  // Prefer an exact legacy branch match when restoring an older journal. A
  // pre-grouping cycle must keep its original branch identity and path set;
  // newly grouped cycles use the stable representative ID below.
  if (legacyBranchMatches.length > 1) {
    throw new Error('Saved family coverage matches more than one named branch')
  }
  if (legacyBranchMatches.length === 1) {
    const [branchId, pathsByPack] = legacyBranchMatches[0]!
    const pathKeys = [...pathsByPack].flatMap(([packId, pathIds]) =>
      [...pathIds].map((pathId) => pathKey(packId, pathId)))
    return {
      kind: 'branch',
      branchId,
      pathKeys,
      completedPathKeys: pathKeys.filter((key) => completionKeys.has(key)),
    }
  }
  if (groupedBranchMatches.length !== 1) {
    throw new Error(groupedBranchMatches.length === 0
      ? 'Saved family coverage does not match a promoted named branch'
      : 'Saved family coverage matches more than one named branch')
  }
  const branch = groupedBranchMatches[0]!
  const pathKeys = [...branch.pathKeys]
  return {
    kind: 'branch',
    // Return the canonical representative so journals written with any
    // duplicate-label alias restore into the same grouped scope.
    branchId: branch.id,
    pathKeys,
    completedPathKeys: pathKeys.filter((key) => completionKeys.has(key)),
  }
}

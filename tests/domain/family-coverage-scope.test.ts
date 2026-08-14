import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  restoreFamilyCoverageScope,
} from '../../src/domain/family-coverage-scope.ts'
import type {
  FamilyCoverageEventV1,
  FamilyTrainingCursorV1,
} from '../../src/domain/opening-family.ts'
import type { FamilyCoverageGenerationV1 } from '../../src/domain/family-training-journal.ts'
import reviewFamilyCatalog from '../../src/generated/review-family-catalog.json' with { type: 'json' }
import { validateReviewOpeningFamilyCatalog } from '../../src/data/review-family-catalog.ts'
import { createSyntheticFamilyPromotion } from '../fixtures/synthetic-family-promotion.ts'

const family = validateReviewOpeningFamilyCatalog(reviewFamilyCatalog).families
  .find(({ id }) => id === 'caro-kann')!

function cursor(options: {
  releaseId: string
  familyId: string
  packId: string
  cycleOrdinal: number
  completedPathIds?: string[]
  pendingPathIds?: string[]
}): FamilyTrainingCursorV1 {
  return {
    schemaVersion: 1,
    releaseId: options.releaseId,
    familyId: options.familyId,
    side: 'white',
    coverageCycleId: `${options.packId}::coverage:${options.cycleOrdinal}`,
    authoritativeDueCardIds: [],
    reviewedCardIds: [],
    completedPathIds: options.completedPathIds ?? [],
    pendingPathIds: options.pendingPathIds ?? [],
    batchIndex: 0,
  }
}

function completion(options: {
  releaseId: string
  familyId: string
  packId: string
  pathId: string
  cycleOrdinal: number
}): FamilyCoverageEventV1 {
  return {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    releaseId: options.releaseId,
    familyId: options.familyId,
    packId: options.packId,
    pathId: options.pathId,
    coverageCycleId: `${options.packId}::coverage:${options.cycleOrdinal}`,
    completedAt: '2026-08-13T12:00:00.000Z',
  }
}

describe('family coverage scope reconstruction', () => {
  test('restores one cross-pack named branch and preserves exact completed path keys', async () => {
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const manifest = structuredClone(promotion.manifest)
    const first = promotion.graphs[0]!
    const second = promotion.graphs[1]!
    const sharedBranchId = manifest.pathMemberships.find(({ packId, pathId }) =>
      packId === first.pack.id && pathId === first.paths[0]!.id)!.primaryBranchId
    manifest.pathMemberships.find(({ packId, pathId }) =>
      packId === second.pack.id && pathId === second.paths[0]!.id)!.secondaryBranchIds = [sharedBranchId]
    const generation: FamilyCoverageGenerationV1 = {
      releaseId: manifest.releaseId,
      familyId: manifest.id,
      side: 'white',
      generationId: '10000000-0000-4000-8000-000000000001',
      generationOrdinal: 3,
      packCycleIds: {
        [first.pack.id]: `${first.pack.id}::coverage:4`,
        [second.pack.id]: `${second.pack.id}::coverage:2`,
      },
    }
    const firstCompletion = completion({
      releaseId: manifest.releaseId,
      familyId: manifest.id,
      packId: first.pack.id,
      pathId: first.paths[0]!.id,
      cycleOrdinal: 4,
    })
    const restored = restoreFamilyCoverageScope({
      manifest,
      side: 'white',
      generation,
      packs: promotion.graphs.map((graph) => ({
        packId: graph.pack.id,
        pathIds: graph.paths.map(({ id }) => id),
      })),
      cursors: [
        cursor({
          releaseId: manifest.releaseId,
          familyId: manifest.id,
          packId: first.pack.id,
          cycleOrdinal: 4,
          completedPathIds: [first.paths[0]!.id],
        }),
        cursor({
          releaseId: manifest.releaseId,
          familyId: manifest.id,
          packId: second.pack.id,
          cycleOrdinal: 2,
          pendingPathIds: [second.paths[0]!.id],
        }),
      ],
      coverageEvents: [firstCompletion],
    })
    assert.equal(restored.kind, 'branch')
    if (restored.kind !== 'branch') return
    assert.equal(restored.branchId, sharedBranchId)
    assert.deepEqual(restored.completedPathKeys, [
      `${first.pack.id}\0${first.paths[0]!.id}`,
    ])
    assert.deepEqual(new Set(restored.pathKeys), new Set([
      `${first.pack.id}\0${first.paths[0]!.id}`,
      `${second.pack.id}\0${second.paths[0]!.id}`,
    ]))
  })

  test('fails closed when overlapping branch memberships explain the same saved cursors', async () => {
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const manifest = structuredClone(promotion.manifest)
    const [first, second] = promotion.graphs
    const firstMembership = manifest.pathMemberships.find(({ packId, pathId }) =>
      packId === first!.pack.id && pathId === first!.paths[0]!.id)!
    const secondMembership = manifest.pathMemberships.find(({ packId, pathId }) =>
      packId === second!.pack.id && pathId === second!.paths[0]!.id)!
    const shared = firstMembership.primaryBranchId
    const conflicting = 'signed-overlap-branch'
    manifest.branches.push({
      schemaVersion: 1,
      id: conflicting,
      familyId: manifest.id,
      canonicalName: 'Overlapping synthetic branch',
      aliases: [],
    })
    firstMembership.secondaryBranchIds = [conflicting]
    secondMembership.secondaryBranchIds = [shared, conflicting]
    const generation: FamilyCoverageGenerationV1 = {
      releaseId: manifest.releaseId,
      familyId: manifest.id,
      side: 'white',
      generationId: '20000000-0000-4000-8000-000000000001',
      generationOrdinal: 1,
      packCycleIds: {
        [first!.pack.id]: `${first!.pack.id}::coverage:1`,
        [second!.pack.id]: `${second!.pack.id}::coverage:1`,
      },
    }
    assert.throws(() => restoreFamilyCoverageScope({
      manifest,
      side: 'white',
      generation,
      packs: promotion.graphs.map((graph) => ({ packId: graph.pack.id, pathIds: graph.paths.map(({ id }) => id) })),
      cursors: [first!, second!].map((graph) => cursor({
        releaseId: manifest.releaseId,
        familyId: manifest.id,
        packId: graph.pack.id,
        cycleOrdinal: 1,
        pendingPathIds: [graph.paths[0]!.id],
      })),
      coverageEvents: [],
    }), /more than one named branch/u)
  })

  test('fails closed when a saved pack selection is both full-family and a named branch', async () => {
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 1 })
    const manifest = structuredClone(promotion.manifest)
    const graph = promotion.graphs[0]!
    const branchId = manifest.pathMemberships[0]!.primaryBranchId
    for (const membership of manifest.pathMemberships) {
      if (membership.primaryBranchId !== branchId) membership.secondaryBranchIds = [branchId]
    }
    const generation: FamilyCoverageGenerationV1 = {
      releaseId: manifest.releaseId,
      familyId: manifest.id,
      side: 'white',
      generationId: '30000000-0000-4000-8000-000000000001',
      generationOrdinal: 0,
      packCycleIds: { [graph.pack.id]: `${graph.pack.id}::coverage:0` },
    }
    assert.throws(() => restoreFamilyCoverageScope({
      manifest,
      side: 'white',
      generation,
      packs: [{ packId: graph.pack.id, pathIds: graph.paths.map(({ id }) => id) }],
      cursors: [cursor({
        releaseId: manifest.releaseId,
        familyId: manifest.id,
        packId: graph.pack.id,
        cycleOrdinal: 0,
        pendingPathIds: graph.paths.map(({ id }) => id),
      })],
      coverageEvents: [],
    }), /ambiguous between full-family and named-branch/u)
  })

  test('rejects corrupt generation, pack, cursor, and completion boundaries', async () => {
    const promotion = await createSyntheticFamilyPromotion(family, { packCount: 2 })
    const manifest = structuredClone(promotion.manifest)
    const [first, second] = promotion.graphs as [typeof promotion.graphs[number], typeof promotion.graphs[number]]
    const firstPath = first.paths[0]!
    const secondPath = second.paths[0]!
    const sharedBranchId = manifest.pathMemberships.find(({ packId, pathId }) =>
      packId === first.pack.id && pathId === firstPath.id)!.primaryBranchId
    manifest.pathMemberships.find(({ packId, pathId }) =>
      packId === second.pack.id && pathId === secondPath.id)!.secondaryBranchIds = [sharedBranchId]
    const generation: FamilyCoverageGenerationV1 = {
      releaseId: manifest.releaseId,
      familyId: manifest.id,
      side: 'white',
      generationId: '40000000-0000-4000-8000-000000000001',
      generationOrdinal: 2,
      packCycleIds: {
        [first.pack.id]: `${first.pack.id}::coverage:2`,
        [second.pack.id]: `${second.pack.id}::coverage:2`,
      },
    }
    const packs = promotion.graphs.map((graph) => ({
      packId: graph.pack.id,
      pathIds: graph.paths.map(({ id }) => id),
    }))
    const cursors = [first, second].map((graph) => cursor({
      releaseId: manifest.releaseId,
      familyId: manifest.id,
      packId: graph.pack.id,
      cycleOrdinal: 2,
      pendingPathIds: [graph.paths[0]!.id],
    }))
    type RestoreInput = Parameters<typeof restoreFamilyCoverageScope>[0]
    const input = (): RestoreInput => ({
      manifest: structuredClone(manifest),
      side: 'white',
      generation: structuredClone(generation),
      packs: structuredClone(packs),
      cursors: structuredClone(cursors),
      coverageEvents: [],
    })
    const rejects = (mutate: (value: RestoreInput) => void, pattern: RegExp): void => {
      const value = input()
      mutate(value)
      assert.throws(() => restoreFamilyCoverageScope(value), pattern)
    }

    rejects((value) => { value.generation.releaseId = 'release_wrong' }, /another release, family, or side/u)
    rejects((value) => {
      value.packs = [...value.packs, { packId: 'unexpected_pack', pathIds: [firstPath.id] }]
    }, /unexpected pack/u)
    rejects((value) => { value.packs = [...value.packs, value.packs[0]!] }, /received pack .* twice/u)
    rejects((value) => {
      value.packs = value.packs.map((pack, index) => index === 0
        ? { ...pack, pathIds: [pack.pathIds[0]!, pack.pathIds[0]!] }
        : pack)
    }, /duplicate paths/u)
    rejects((value) => { value.packs = value.packs.slice(0, 1) }, /missing pack/u)
    rejects((value) => { value.cursors = [value.cursors[0]!, value.cursors[0]!] }, /two cursors/u)
    rejects((value) => { value.cursors = [] }, /missing its exact cursor/u)
    rejects((value) => { value.cursors[0]!.coverageCycleId = `${first.pack.id}::coverage:9` }, /missing its exact cursor/u)
    rejects((value) => { value.cursors[0]!.releaseId = 'release_wrong' }, /another family generation scope/u)
    rejects((value) => {
      value.cursors[0]!.pendingPathIds = []
    }, /has no selected paths/u)
    rejects((value) => {
      value.cursors[0]!.pendingPathIds = [secondPath.id]
    }, /outside the promoted graph/u)
    rejects((value) => {
      value.generation.packCycleIds = {
        unexpected_pack: 'unexpected_pack::coverage:2',
      }
      value.cursors = [cursor({
        releaseId: manifest.releaseId,
        familyId: manifest.id,
        packId: 'unexpected_pack',
        cycleOrdinal: 2,
        pendingPathIds: [firstPath.id],
      })]
    }, /binds an unexpected pack/u)
    rejects((value) => {
      value.generation.packCycleIds = {
        [first.pack.id]: `${first.pack.id}::coverage:2`,
      }
    }, /cursor outside the active family generation/u)
    rejects((value) => {
      value.coverageEvents = [completion({
        releaseId: manifest.releaseId,
        familyId: manifest.id,
        packId: first.pack.id,
        pathId: first.paths[1]!.id,
        cycleOrdinal: 2,
      })]
    }, /completion references a path outside/u)
    rejects((value) => {
      value.cursors[0]!.completedPathIds = [firstPath.id]
      value.cursors[0]!.pendingPathIds = []
    }, /completion is missing its append-only/u)

    const unbound = input()
    unbound.generation.packCycleIds = {}
    unbound.cursors = []
    assert.deepEqual(restoreFamilyCoverageScope(unbound), { kind: 'full', completedPathKeys: [] })
    unbound.cursors = [cursors[0]!]
    assert.throws(() => restoreFamilyCoverageScope(unbound), /unbound family generation cannot own/u)

    const full = input()
    full.cursors = [first, second].map((graph) => cursor({
      releaseId: manifest.releaseId,
      familyId: manifest.id,
      packId: graph.pack.id,
      cycleOrdinal: 2,
      pendingPathIds: graph.paths.map(({ id }) => id),
    }))
    assert.equal(restoreFamilyCoverageScope(full).kind, 'full')

    const unmatched = input()
    unmatched.cursors[1]!.pendingPathIds = [second.paths[1]!.id]
    assert.throws(() => restoreFamilyCoverageScope(unmatched), /does not match a promoted named branch/u)
  })
})

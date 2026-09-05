import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemorySyncStore } from '../src/adapters/memory.js'
import {
  FamilyTrainingCursorV1Schema,
  FamilyTrainingSyncRequestV1Schema,
  type FamilyCoverageEventV1,
  type FamilyCoverageCycleEventV1,
} from '../src/family-training-contracts.js'
import { ApiError } from '../src/errors.js'
import { DEVICE_ID, NOW } from './helpers.js'

const RELEASE = 'release-2026q2'
const FAMILY = 'caro-kann'
const PACK = 'caro_kann_black'
const CYCLE = `${PACK}::coverage:0`
const GENERATION = '0198a5c0-1000-7000-8000-000000000100'

function pathId(index: number): string {
  return `path_${index.toString(16).padStart(20, '0')}`
}

function cardId(index: number): string {
  return `${PACK}::pos_${index.toString(16).padStart(16, '0')}`
}

function coverage(index: number, eventSuffix = index + 1): FamilyCoverageEventV1 {
  return {
    schemaVersion: 1,
    eventId: `0198a5c0-1000-7000-8000-${eventSuffix.toString().padStart(12, '0')}`,
    releaseId: RELEASE,
    familyId: FAMILY,
    packId: PACK,
    pathId: pathId(index),
    coverageCycleId: CYCLE,
    completedAt: '2026-07-14T11:59:00.000Z',
  }
}

const cycleStart: FamilyCoverageCycleEventV1 = {
  schemaVersion: 1,
  eventId: '0198a5c0-1000-7000-8000-000000000200',
  releaseId: RELEASE,
  familyId: FAMILY,
  side: 'black',
  kind: 'cycle_started',
  generationId: GENERATION,
  generationOrdinal: 0,
  occurredAt: '2026-07-14T11:58:00.000Z',
}

const packBound: FamilyCoverageCycleEventV1 = {
  schemaVersion: 1,
  eventId: '0198a5c0-1000-7000-8000-000000000201',
  releaseId: RELEASE,
  familyId: FAMILY,
  side: 'black',
  kind: 'pack_bound',
  generationId: GENERATION,
  generationOrdinal: 0,
  packId: PACK,
  packCoverageCycleId: CYCLE,
  occurredAt: '2026-07-14T11:58:01.000Z',
}

function largeStore(pathCount = 1_005): { store: InMemorySyncStore; paths: string[]; cards: string[] } {
  const paths = Array.from({ length: pathCount }, (_, index) => pathId(index))
  const cards = Array.from({ length: pathCount }, (_, index) => cardId(index))
  return {
    paths,
    cards,
    store: new InMemorySyncStore({
      supportedSnapshots: [RELEASE],
      familyMembership: {
        [RELEASE]: [{ familyId: FAMILY, packId: PACK, side: 'black', pathIds: paths }],
      },
      snapshotMembership: {
        [RELEASE]: cards.map((id, index) => ({
          packId: PACK,
          nodeId: `pos_${index.toString(16).padStart(16, '0')}`,
          cardId: id,
        })),
      },
    }),
  }
}

describe('unified family cloud journal', () => {
  it('validates cross-field cursor invariants and bounded event batches', () => {
    assert.throws(() => FamilyTrainingCursorV1Schema.parse({
      schemaVersion: 1,
      releaseId: RELEASE,
      familyId: FAMILY,
      side: 'black',
      coverageCycleId: CYCLE,
      authoritativeDueCardIds: [cardId(0)],
      reviewedCardIds: [cardId(1)],
      completedPathIds: [pathId(0)],
      pendingPathIds: [pathId(0)],
      batchIndex: 0,
    }))
    assert.throws(() => FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      coverageEvents: Array.from({ length: 250 }, (_, index) => coverage(index, index + 1)),
      cycleEvents: [cycleStart],
    }), /At most 250/u)
  })

  it('syncs more than 1,000 paths without truncation and makes retries idempotent', async () => {
    const { store, paths, cards } = largeStore()
    const cursor = FamilyTrainingCursorV1Schema.parse({
      schemaVersion: 1,
      releaseId: RELEASE,
      familyId: FAMILY,
      side: 'black',
      coverageCycleId: CYCLE,
      authoritativeDueCardIds: cards,
      reviewedCardIds: [],
      completedPathIds: [],
      pendingPathIds: paths,
      batchIndex: 0,
    })
    const request = FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      coverageEvents: [coverage(0), coverage(1)],
      cycleEvents: [cycleStart, packBound],
      cursorMutation: {
        mutationId: '0198a5c0-1000-7000-8000-000000000300',
        baseVersion: 0,
        value: cursor,
      },
    })

    const first = await store.syncFamilyTraining('user-a', request, NOW)
    const retry = await store.syncFamilyTraining('user-a', request, NOW)
    assert.deepEqual(first.acceptedCoverageEventIds, [coverage(0).eventId, coverage(1).eventId])
    assert.deepEqual(retry.acceptedCoverageEventIds, first.acceptedCoverageEventIds)
    assert.equal(first.cursor?.value.pendingPathIds.length, 1_005)
    assert.equal(retry.cursorStatus, 'duplicate')
    assert.equal(retry.cursor?.version, 1)

    const restored = await store.loadFamilyCursor('user-a', {
      releaseId: RELEASE, familyId: FAMILY, side: 'black', packId: PACK,
    }, NOW)
    assert.equal(restored.cursor?.value.pendingPathIds.at(-1), paths.at(-1))
    assert.equal(restored.cursor?.value.authoritativeDueCardIds.length, 1_005)

    const otherTenant = await store.loadFamilyCursor('user-b', {
      releaseId: RELEASE, familyId: FAMILY, side: 'black', packId: PACK,
    }, NOW)
    assert.equal(otherTenant.cursor, null)
    assert.equal((await store.pageFamilyCoverage('user-b', {
      releaseId: RELEASE, familyId: FAMILY, cursor: 0n, limit: 250,
    }, NOW)).records.length, 0)
  })

  it('preserves pending paths across cursor versions and rejects stale or regressive writes', async () => {
    const { store, paths, cards } = largeStore()
    const initial = FamilyTrainingCursorV1Schema.parse({
      schemaVersion: 1, releaseId: RELEASE, familyId: FAMILY, side: 'black', coverageCycleId: CYCLE,
      authoritativeDueCardIds: cards, reviewedCardIds: [], completedPathIds: [], pendingPathIds: paths, batchIndex: 0,
    })
    await store.syncFamilyTraining('user-a', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      cursorMutation: { mutationId: '0198a5c0-1000-7000-8000-000000000310', baseVersion: 0, value: initial },
    }), NOW)
    const advanced = FamilyTrainingCursorV1Schema.parse({
      ...initial,
      reviewedCardIds: [cards[0]],
      completedPathIds: [paths[0]],
      pendingPathIds: paths.slice(1),
      batchIndex: 1,
    })
    const saved = await store.syncFamilyTraining('user-a', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      cursorMutation: { mutationId: '0198a5c0-1000-7000-8000-000000000311', baseVersion: 1, value: advanced },
    }), NOW)
    assert.equal(saved.cursor?.value.pendingPathIds.length, 1_004)
    assert.equal(saved.cursor?.value.pendingPathIds.at(-1), paths.at(-1))

    await assert.rejects(
      () => store.syncFamilyTraining('user-a', FamilyTrainingSyncRequestV1Schema.parse({
        deviceId: DEVICE_ID,
        cursorMutation: {
          mutationId: '0198a5c0-1000-7000-8000-000000000312',
          baseVersion: 1,
          value: { ...advanced, batchIndex: 2 },
        },
      }), NOW),
      (error: unknown) => error instanceof ApiError && error.code === 'family_cursor_version_conflict',
    )
    const regressive = FamilyTrainingCursorV1Schema.parse({ ...advanced, pendingPathIds: paths.slice(2), batchIndex: 2 })
    await assert.rejects(
      () => store.syncFamilyTraining('user-a', FamilyTrainingSyncRequestV1Schema.parse({
        deviceId: DEVICE_ID,
        cursorMutation: { mutationId: '0198a5c0-1000-7000-8000-000000000313', baseVersion: 2, value: regressive },
      }), NOW),
      (error: unknown) => error instanceof ApiError && error.code === 'family_cursor_regression',
    )
  })

  it('does not double-count logical completions and pages immutable history', async () => {
    const { store } = largeStore(3)
    const firstEvent = coverage(0)
    const secondEvent = coverage(1)
    const response = await store.syncFamilyTraining('user-a', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      coverageEvents: [firstEvent, secondEvent],
    }), NOW)
    assert.equal(response.acceptedCoverageEventIds.length, 2)
    const duplicateLogical = await store.syncFamilyTraining('user-a', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      coverageEvents: [{ ...firstEvent, eventId: '0198a5c0-1000-7000-8000-000000000099' }],
    }), NOW)
    assert.equal(duplicateLogical.rejectedRecords[0]?.code, 'duplicate_logical_record')

    const page1 = await store.pageFamilyCoverage('user-a', {
      releaseId: RELEASE, familyId: FAMILY, cursor: 0n, limit: 1,
    }, NOW)
    const page2 = await store.pageFamilyCoverage('user-a', {
      releaseId: RELEASE, familyId: FAMILY, cursor: BigInt(page1.nextCursor), limit: 1,
    }, NOW)
    assert.equal(page1.hasMore, true)
    assert.equal(page2.hasMore, false)
    assert.deepEqual([page1.records[0]?.event.pathId, page2.records[0]?.event.pathId], [pathId(0), pathId(1)])
  })

  it('rejects unsupported, unknown, conflicting, future, and duplicate family records independently', async () => {
    const { store } = largeStore(2)
    const futureCoverage = { ...coverage(0, 501), completedAt: '2026-07-14T12:06:00.000Z' }
    const initial = await store.syncFamilyTraining('user-branches', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      coverageEvents: [
        { ...coverage(0, 502), releaseId: 'retired-release' },
        { ...coverage(9, 503) },
        futureCoverage,
      ],
      cycleEvents: [
        { ...cycleStart, eventId: '0198a5c0-1000-7000-8000-000000000504', releaseId: 'retired-release' },
        { ...cycleStart, eventId: '0198a5c0-1000-7000-8000-000000000505', familyId: 'unknown-family' },
        { ...packBound, eventId: '0198a5c0-1000-7000-8000-000000000506' },
        { ...cycleStart, eventId: '0198a5c0-1000-7000-8000-000000000507', occurredAt: '2026-07-14T12:06:00.000Z' },
      ],
    }), NOW)
    assert.deepEqual(initial.rejectedRecords.map(({ code }) => code), [
      'unsupported_release',
      'unknown_family_membership',
      'future_timestamp_normalized',
      'unsupported_release',
      'unknown_family_membership',
      'unknown_family_membership',
      'future_timestamp_normalized',
    ])

    const conflicts = await store.syncFamilyTraining('user-branches', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      coverageEvents: [
        { ...futureCoverage, completedAt: '2026-07-14T11:57:00.000Z' },
        { ...coverage(0, 508), completedAt: futureCoverage.completedAt },
      ],
      cycleEvents: [
        { ...cycleStart, eventId: '0198a5c0-1000-7000-8000-000000000507', occurredAt: '2026-07-14T11:57:00.000Z' },
        { ...cycleStart, eventId: '0198a5c0-1000-7000-8000-000000000509', occurredAt: '2026-07-14T11:57:00.000Z' },
        { ...packBound, eventId: '0198a5c0-1000-7000-8000-000000000510', occurredAt: '2026-07-14T12:06:00.000Z' },
        { ...packBound, eventId: '0198a5c0-1000-7000-8000-000000000511' },
      ],
    }), NOW)
    assert.deepEqual(conflicts.rejectedRecords.map(({ code }) => code), [
      'conflicting_event_id',
      'duplicate_logical_record',
      'conflicting_event_id',
      'duplicate_logical_record',
      'future_timestamp_normalized',
      'duplicate_logical_record',
    ])
  })

  it('enforces cursor mutation identity, cycle monotonicity, due-set stability, and bounded pages', async () => {
    const { store, paths, cards } = largeStore(2)
    const base = FamilyTrainingCursorV1Schema.parse({
      schemaVersion: 1,
      releaseId: RELEASE,
      familyId: FAMILY,
      side: 'black',
      coverageCycleId: CYCLE,
      authoritativeDueCardIds: cards,
      reviewedCardIds: [],
      completedPathIds: [],
      pendingPathIds: paths,
      batchIndex: 0,
    })
    const firstMutation = '0198a5c0-1000-7000-8000-000000000520'
    await store.syncFamilyTraining('user-cursor-branches', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      cursorMutation: { mutationId: firstMutation, baseVersion: 0, value: base },
    }), NOW)

    const alias = await store.syncFamilyTraining('user-cursor-branches', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      cursorMutation: {
        mutationId: '0198a5c0-1000-7000-8000-000000000521',
        baseVersion: 1,
        value: base,
      },
    }), NOW)
    assert.equal(alias.cursorStatus, 'duplicate')
    assert.equal((await store.loadFamilyCursor('user-cursor-branches', {
      releaseId: RELEASE, familyId: FAMILY, side: 'black', packId: PACK, coverageCycleId: CYCLE,
    }, NOW)).cursor?.version, 1)

    await assert.rejects(() => store.syncFamilyTraining('user-cursor-branches', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      cursorMutation: {
        mutationId: firstMutation,
        baseVersion: 1,
        value: { ...base, batchIndex: 1 },
      },
    }), NOW), (error: unknown) => error instanceof ApiError && error.code === 'family_cursor_mutation_conflict')

    const nextCycle = FamilyTrainingCursorV1Schema.parse({
      ...base,
      coverageCycleId: `${PACK}::coverage:1`,
      authoritativeDueCardIds: [],
      reviewedCardIds: [],
      completedPathIds: [],
      pendingPathIds: paths,
      batchIndex: 0,
    })
    await store.syncFamilyTraining('user-cursor-branches', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      cursorMutation: {
        mutationId: '0198a5c0-1000-7000-8000-000000000522',
        baseVersion: 1,
        value: nextCycle,
      },
    }), NOW)
    await assert.rejects(() => store.syncFamilyTraining('user-cursor-branches', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      cursorMutation: {
        mutationId: '0198a5c0-1000-7000-8000-000000000523',
        baseVersion: 2,
        value: base,
      },
    }), NOW), (error: unknown) => error instanceof ApiError && error.code === 'family_cursor_regression')

    const dueStore = largeStore(2).store
    await dueStore.syncFamilyTraining('user-due-branches', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      cursorMutation: {
        mutationId: '0198a5c0-1000-7000-8000-000000000524',
        baseVersion: 0,
        value: base,
      },
    }), NOW)
    await assert.rejects(() => dueStore.syncFamilyTraining('user-due-branches', FamilyTrainingSyncRequestV1Schema.parse({
      deviceId: DEVICE_ID,
      cursorMutation: {
        mutationId: '0198a5c0-1000-7000-8000-000000000525',
        baseVersion: 1,
        value: { ...base, authoritativeDueCardIds: cards.slice(0, 1) },
      },
    }), NOW), (error: unknown) => error instanceof ApiError && error.code === 'family_cursor_regression')

    await assert.rejects(
      () => store.pageFamilyCycles('user-cursor-branches', {
        releaseId: RELEASE, familyId: FAMILY, side: 'black', cursor: 0n, limit: 0,
      }, NOW),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_cursor',
    )
  })
})

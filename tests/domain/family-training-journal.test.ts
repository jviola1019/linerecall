import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FamilyCoverageEventV1Schema,
  FamilyTrainingCursorWriteQueue,
  FamilyTrainingCursorV1Schema,
  MemoryFamilyTrainingJournalRepository,
  countUniqueCompletedFamilyPaths,
  type FamilyCoverageEventV1,
  type FamilyTrainingCursorV1,
} from '../../src/domain/family-training-journal.ts'

const PATH_A = 'path_00000000000000000001'
const PATH_B = 'path_00000000000000000002'
const CARD_A = 'caro_kann_black::pos_0000000000000001'
const CARD_B = 'caro_kann_black::pos_0000000000000002'

function coverageEvent(overrides: Partial<FamilyCoverageEventV1> = {}): FamilyCoverageEventV1 {
  return {
    schemaVersion: 1,
    eventId: '00000000-0000-4000-8000-000000000001',
    releaseId: 'release-2026-07-28',
    familyId: 'caro-kann',
    packId: 'caro_kann_black',
    pathId: PATH_A,
    coverageCycleId: 'caro_kann_black::coverage:0',
    completedAt: '2026-07-28T12:00:00.000Z',
    ...overrides,
  }
}

function cursor(overrides: Partial<FamilyTrainingCursorV1> = {}): FamilyTrainingCursorV1 {
  return {
    schemaVersion: 1,
    releaseId: 'release-2026-07-28',
    familyId: 'caro-kann',
    side: 'black',
    coverageCycleId: 'caro_kann_black::coverage:0',
    authoritativeDueCardIds: [CARD_A, CARD_B],
    reviewedCardIds: [CARD_A],
    completedPathIds: [PATH_A],
    pendingPathIds: [PATH_B],
    batchIndex: 0,
    ...overrides,
  }
}

test('family coverage and cursor contracts reject duplicate or inconsistent state', () => {
  assert.equal(FamilyCoverageEventV1Schema.safeParse(coverageEvent()).success, true)
  assert.equal(FamilyCoverageEventV1Schema.safeParse({
    ...coverageEvent(),
    eventId: '<script>',
  }).success, false)
  assert.equal(FamilyTrainingCursorV1Schema.safeParse(cursor()).success, true)
  assert.equal(FamilyTrainingCursorV1Schema.safeParse(cursor({
    authoritativeDueCardIds: [CARD_A, CARD_A],
  })).success, false)
  assert.equal(FamilyTrainingCursorV1Schema.safeParse(cursor({
    reviewedCardIds: ['other_pack::pos_0000000000000003'],
  })).success, false)
  assert.equal(FamilyTrainingCursorV1Schema.safeParse(cursor({
    pendingPathIds: [PATH_A],
  })).success, false)
})

test('coverage events append idempotently by event and logical path completion', async () => {
  const repository = new MemoryFamilyTrainingJournalRepository()
  const original = coverageEvent()
  assert.equal(await repository.appendCoverageEvent(original), 'appended')
  assert.equal(await repository.appendCoverageEvent(structuredClone(original)), 'duplicate')
  const duplicateEventId = '00000000-0000-4000-8000-000000000002'
  assert.equal(await repository.appendCoverageEvent(coverageEvent({
    eventId: duplicateEventId,
    completedAt: '2026-07-28T12:01:00.000Z',
  })), 'duplicate')
  await assert.rejects(
    () => repository.appendCoverageEvent(coverageEvent({ pathId: PATH_B })),
    /event ID was reused/u,
  )
  await assert.rejects(
    () => repository.appendCoverageEvent(coverageEvent({ eventId: duplicateEventId, pathId: PATH_B })),
    /event ID was reused/u,
  )

  const events = await repository.listCoverageEvents({
    releaseId: original.releaseId,
    familyId: original.familyId,
  })
  assert.deepEqual(events, [original])
  events[0]!.pathId = PATH_B
  assert.deepEqual(
    await repository.listCoverageEvents({ releaseId: original.releaseId, familyId: original.familyId }),
    [original],
  )
  assert.deepEqual(
    await repository.listCoverageEvents({ releaseId: 'another-release', familyId: original.familyId }),
    [],
  )
})

test('family completion totals count a path once across coverage cycles', () => {
  const firstCycle = coverageEvent()
  const laterCycle = coverageEvent({
    eventId: '00000000-0000-4000-8000-000000000003',
    coverageCycleId: 'caro_kann_black::coverage:1',
    completedAt: '2026-07-29T12:00:00.000Z',
  })
  const secondPath = coverageEvent({
    eventId: '00000000-0000-4000-8000-000000000004',
    pathId: PATH_B,
    completedAt: '2026-07-28T12:02:00.000Z',
  })
  assert.equal(countUniqueCompletedFamilyPaths([firstCycle, laterCycle, secondPath]), 2)
})

test('cursor snapshots append without overwriting history and exact retries are no-ops', async () => {
  const repository = new MemoryFamilyTrainingJournalRepository()
  const initial = cursor()
  assert.equal(await repository.appendCursor(initial), 'appended')
  assert.equal(await repository.appendCursor(structuredClone(initial)), 'duplicate')

  const advanced = cursor({
    reviewedCardIds: [CARD_A, CARD_B],
    completedPathIds: [PATH_A, PATH_B],
    pendingPathIds: [],
    batchIndex: 1,
  })
  assert.equal(await repository.appendCursor(advanced), 'appended')
  const loaded = await repository.loadLatestCursor({
    releaseId: advanced.releaseId,
    familyId: advanced.familyId,
    side: advanced.side,
  })
  assert.deepEqual(loaded, advanced)
  loaded!.pendingPathIds.push(PATH_A)
  assert.deepEqual(await repository.loadLatestCursor({
    releaseId: advanced.releaseId,
    familyId: advanced.familyId,
    side: advanced.side,
  }), advanced)
  assert.equal(await repository.loadLatestCursor({
    releaseId: advanced.releaseId,
    familyId: advanced.familyId,
    side: 'white',
  }), null)
})

test('cursor writer retains failed snapshots in order and retries without losing updates', async () => {
  const appended: FamilyTrainingCursorV1[] = []
  let available = false
  const queue = new FamilyTrainingCursorWriteQueue({
    appendCursor: async (value) => {
      if (!available) throw new Error('storage temporarily unavailable')
      appended.push(structuredClone(value))
      return 'appended'
    },
  })
  const initial = cursor()
  const advanced = cursor({
    reviewedCardIds: [CARD_A, CARD_B],
    completedPathIds: [PATH_A, PATH_B],
    pendingPathIds: [],
    batchIndex: 1,
  })

  const first = await queue.enqueue(initial)
  assert.equal(first.pendingCount, 1)
  assert.match(first.error?.message ?? '', /temporarily unavailable/u)
  const second = await queue.enqueue(advanced)
  assert.equal(second.pendingCount, 2)
  assert.equal(queue.pendingCount, 2)

  available = true
  const retried = await queue.flush()
  assert.deepEqual(retried, { savedCount: 2, pendingCount: 0, error: null })
  assert.deepEqual(appended, [initial, advanced])
  assert.equal(queue.pendingCount, 0)
})

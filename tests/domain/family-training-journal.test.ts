import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FamilyCoverageEventV1Schema,
  FamilyCoverageCycleEventV1Schema,
  FamilyTrainingCursorWriteQueue,
  FamilyTrainingJournalSnapshotV1Schema,
  FamilyTrainingCursorV1Schema,
  MemoryFamilyTrainingJournalRepository,
  countUniqueCompletedFamilyPaths,
  latestFamilyCoverageGeneration,
  reconcileFamilyCursorCompletions,
  supportsFamilyTrainingJournalTransfer,
  type FamilyCoverageEventV1,
  type FamilyCoverageCycleEventV1,
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

function cycleEvent(
  overrides: Record<string, unknown> = {},
): FamilyCoverageCycleEventV1 {
  return FamilyCoverageCycleEventV1Schema.parse({
    schemaVersion: 1,
    eventId: '20000000-0000-4000-8000-000000000001',
    releaseId: 'release-2026-07-28',
    familyId: 'caro-kann',
    side: 'black',
    generationId: '20000000-0000-4000-8000-000000000002',
    generationOrdinal: 0,
    kind: 'cycle_started',
    occurredAt: '2026-07-28T11:59:00.000Z',
    ...overrides,
  })
}

test('durable completion replay repairs an interrupted cursor without changing due ownership or mastery', () => {
  const before = cursor({ completedPathIds: [], pendingPathIds: [PATH_A, PATH_B] })
  const event = coverageEvent()
  const repaired = reconcileFamilyCursorCompletions(before, [event, structuredClone(event)])
  assert.deepEqual(repaired.completedPathIds, [PATH_A])
  assert.deepEqual(repaired.pendingPathIds, [PATH_B])
  assert.deepEqual(repaired.authoritativeDueCardIds, before.authoritativeDueCardIds)
  assert.deepEqual(repaired.reviewedCardIds, before.reviewedCardIds)
  assert.deepEqual(before.completedPathIds, [])
  assert.deepEqual(reconcileFamilyCursorCompletions(repaired, [event]), repaired)
  for (const unrelated of [
    coverageEvent({ releaseId: 'another-release' }),
    coverageEvent({ familyId: 'sicilian-defence' }),
    coverageEvent({ coverageCycleId: 'caro_kann_black::coverage:1' }),
    coverageEvent({ packId: 'other_pack', coverageCycleId: 'other_pack::coverage:0' }),
  ]) assert.deepEqual(reconcileFamilyCursorCompletions(before, [unrelated]), before)
  assert.throws(() => reconcileFamilyCursorCompletions(cursor(), []), /missing its append-only event/u)
  assert.throws(() => reconcileFamilyCursorCompletions(before, [coverageEvent({ pathId: 'path_00000000000000000003' })]), /outside the selected/u)
})

test('portable journals reject duplicate IDs, logical records, and cursor scopes', () => {
  const empty = { schemaVersion: 1, coverageEvents: [], cycleEvents: [], latestCursors: [] }
  for (const invalid of [
    { coverageEvents: [coverageEvent(), coverageEvent({ pathId: PATH_B })] },
    { cycleEvents: [cycleEvent(), cycleEvent()] },
    { cycleEvents: [cycleEvent(), cycleEvent({ eventId: '20000000-0000-4000-8000-000000000099' })] },
    { latestCursors: [cursor(), cursor({ batchIndex: 1 })] },
  ]) assert.equal(FamilyTrainingJournalSnapshotV1Schema.safeParse({ ...empty, ...invalid }).success, false)
  assert.equal(FamilyCoverageCycleEventV1Schema.safeParse({
    ...cycleEvent(), kind: 'pack_bound', packId: 'caro_kann_black', packCoverageCycleId: 'other_pack::coverage:0',
  }).success, false)
})

test('journal lookup rejects invalid sides and generation replay rejects contradictory bindings', async () => {
  const repository = new MemoryFamilyTrainingJournalRepository()
  const scope = { releaseId: cursor().releaseId, familyId: 'caro-kann', packId: 'caro_kann_black', side: 'invalid' as never }
  await assert.rejects(repository.loadLatestCursor(scope), /side must be/u)
  await assert.rejects(repository.listCycleEvents(scope), /side must be/u)
  assert.equal(latestFamilyCoverageGeneration([]), null)
  const start = cycleEvent()
  const bound = cycleEvent({ kind: 'pack_bound', packId: 'caro_kann_black', packCoverageCycleId: 'caro_kann_black::coverage:0' })
  for (const changed of [
    { releaseId: 'another-release' }, { familyId: 'sicilian-defence' }, { side: 'white' }, { generationOrdinal: 1 },
  ]) assert.throws(() => latestFamilyCoverageGeneration([start, cycleEvent({ ...bound, ...changed })]), /conflicts with its generation/u)
  assert.throws(() => latestFamilyCoverageGeneration([
    start, bound, cycleEvent({ ...bound, packCoverageCycleId: 'caro_kann_black::coverage:1' }),
  ]), /multiple cycles/u)
  assert.throws(() => latestFamilyCoverageGeneration([
    start, cycleEvent({ generationId: '20000000-0000-4000-8000-000000000099' }),
  ]), /conflicting identities/u)
})

test('concurrent cursor flushes share a write and retain non-Error failures for retry', async () => {
  let finish!: () => void
  let fail = false
  const pending = new Promise<void>((resolve) => { finish = resolve })
  const queue = new FamilyTrainingCursorWriteQueue({ appendCursor: async () => {
    await pending
    if (fail) throw 'unstructured adapter failure'
    return 'appended'
  } })
  const initial = queue.enqueue(cursor())
  assert.equal(queue.flush(), initial)
  assert.equal(queue.enqueue(cursor()), initial)
  assert.equal(queue.pendingCount, 1)
  finish()
  assert.equal((await initial).savedCount, 1)
  fail = true
  const rejected = await queue.enqueue(cursor({ batchIndex: 1 }))
  assert.match(rejected.error?.message ?? '', /could not be saved/u)
  assert.equal(rejected.pendingCount, 1)
  fail = false
  assert.equal((await queue.flush()).pendingCount, 0)
})

test('family coverage and cursor contracts reject duplicate or inconsistent state', () => {
  assert.equal(FamilyCoverageEventV1Schema.safeParse(coverageEvent()).success, true)
  assert.equal(FamilyCoverageEventV1Schema.safeParse({
    ...coverageEvent(),
    eventId: '<script>',
  }).success, false)
  assert.equal(FamilyCoverageEventV1Schema.safeParse(coverageEvent({
    packId: 'another_pack',
  })).success, false)
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
  assert.equal(FamilyTrainingCursorV1Schema.safeParse(cursor({
    coverageCycleId: 'another_pack::coverage:0',
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

test('coverage-cycle event IDs cannot be reused with different canonical content', async () => {
  const repository = new MemoryFamilyTrainingJournalRepository()
  const original = cycleEvent()
  assert.equal(await repository.appendCycleEvent(original), 'appended')
  await assert.rejects(
    () => repository.appendCycleEvent({
      ...original,
      occurredAt: '2026-07-28T12:01:00.000Z',
    }),
    /event ID was reused with different content/u,
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

test('family generation binds independent pack ordinals without discarding either pack', async () => {
  const repository = new MemoryFamilyTrainingJournalRepository()
  const started = cycleEvent()
  const firstBinding = cycleEvent({
    eventId: '20000000-0000-4000-8000-000000000003',
    kind: 'pack_bound',
    packId: 'caro_kann_black',
    packCoverageCycleId: 'caro_kann_black::coverage:7',
    occurredAt: '2026-07-28T12:00:00.000Z',
  }) as Extract<FamilyCoverageCycleEventV1, { kind: 'pack_bound' }>
  const secondBinding = cycleEvent({
    eventId: '20000000-0000-4000-8000-000000000004',
    kind: 'pack_bound',
    packId: 'caro_kann_black_secondary',
    packCoverageCycleId: 'caro_kann_black_secondary::coverage:2',
    occurredAt: '2026-07-28T12:01:00.000Z',
  }) as Extract<FamilyCoverageCycleEventV1, { kind: 'pack_bound' }>
  for (const event of [started, firstBinding, secondBinding]) {
    assert.equal(FamilyCoverageCycleEventV1Schema.safeParse(event).success, true)
    assert.equal(await repository.appendCycleEvent(event), 'appended')
  }
  const events = await repository.listCycleEvents({
    releaseId: started.releaseId,
    familyId: started.familyId,
    side: started.side,
  })
  assert.deepEqual(latestFamilyCoverageGeneration(events)?.packCycleIds, {
    caro_kann_black: 'caro_kann_black::coverage:7',
    caro_kann_black_secondary: 'caro_kann_black_secondary::coverage:2',
  })
  assert.equal(await repository.appendCycleEvent({
    ...structuredClone(secondBinding),
    eventId: '20000000-0000-4000-8000-000000000005',
  }), 'duplicate')
  await assert.rejects(
    () => repository.appendCycleEvent({
      ...structuredClone(secondBinding),
      eventId: '20000000-0000-4000-8000-000000000006',
      packCoverageCycleId: 'caro_kann_black_secondary::coverage:3',
    }),
    /rebound/u,
  )
})

test('a new family generation starts empty instead of inheriting prior pack bindings', () => {
  const first = cycleEvent()
  const oldBinding = cycleEvent({
    eventId: '20000000-0000-4000-8000-000000000007',
    kind: 'pack_bound',
    packId: 'caro_kann_black',
    packCoverageCycleId: 'caro_kann_black::coverage:7',
  })
  const next = cycleEvent({
    eventId: '20000000-0000-4000-8000-000000000008',
    generationId: '20000000-0000-4000-8000-000000000009',
    generationOrdinal: 1,
    occurredAt: '2026-07-29T12:00:00.000Z',
  })
  const generation = latestFamilyCoverageGeneration([first, oldBinding, next])
  assert.equal(generation?.generationOrdinal, 1)
  assert.deepEqual(generation?.packCycleIds, {})
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
    packId: 'caro_kann_black',
    side: advanced.side,
  })
  assert.deepEqual(loaded, advanced)
  loaded!.pendingPathIds.push(PATH_A)
  assert.deepEqual(await repository.loadLatestCursor({
    releaseId: advanced.releaseId,
    familyId: advanced.familyId,
    packId: 'caro_kann_black',
    side: advanced.side,
  }), advanced)
  assert.equal(await repository.loadLatestCursor({
    releaseId: advanced.releaseId,
    familyId: advanced.familyId,
    packId: 'caro_kann_black',
    side: 'white',
  }), null)
  await assert.rejects(
    () => repository.loadLatestCursor({
      releaseId: advanced.releaseId,
      familyId: advanced.familyId,
      packId: '<script>',
      side: advanced.side,
    }),
    /Invalid string/u,
  )
})

test('same-side graph packs keep independent latest cursors', async () => {
  const repository = new MemoryFamilyTrainingJournalRepository()
  const primary = cursor()
  const secondaryPackId = 'caro_kann_black_secondary'
  const secondaryCard = `${secondaryPackId}::pos_0000000000000003`
  const secondary = cursor({
    coverageCycleId: `${secondaryPackId}::coverage:0`,
    authoritativeDueCardIds: [secondaryCard],
    reviewedCardIds: [],
    completedPathIds: [],
    pendingPathIds: [PATH_B],
  })
  assert.equal(await repository.appendCursor(primary), 'appended')
  assert.equal(await repository.appendCursor(secondary), 'appended')

  assert.deepEqual(await repository.loadLatestCursor({
    releaseId: primary.releaseId,
    familyId: primary.familyId,
    packId: 'caro_kann_black',
    side: 'black',
  }), primary)
  assert.deepEqual(await repository.loadLatestCursor({
    releaseId: secondary.releaseId,
    familyId: secondary.familyId,
    packId: secondaryPackId,
    side: 'black',
  }), secondary)
})

test('loadCursor returns the exact cycle cursor and rejects a mismatched requested pack', async () => {
  const repository = new MemoryFamilyTrainingJournalRepository()
  const saved = cursor()
  await repository.appendCursor(saved)
  assert.deepEqual(await repository.loadCursor({
    releaseId: saved.releaseId,
    familyId: saved.familyId,
    side: saved.side,
    packId: 'caro_kann_black',
    coverageCycleId: saved.coverageCycleId,
  }), saved)
  assert.equal(await repository.loadCursor({
    releaseId: saved.releaseId,
    familyId: saved.familyId,
    side: saved.side,
    packId: 'caro_kann_black',
    coverageCycleId: 'caro_kann_black::coverage:9',
  }), null)
  await assert.rejects(
    () => repository.loadCursor({
      releaseId: saved.releaseId,
      familyId: saved.familyId,
      side: saved.side,
      packId: 'another_pack',
      coverageCycleId: saved.coverageCycleId,
    }),
    /belongs to another graph pack/u,
  )
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

test('memory journal exports and atomically replaces a strict resumable snapshot', async () => {
  const source = new MemoryFamilyTrainingJournalRepository()
  const started = cycleEvent()
  const binding = cycleEvent({
    eventId: '20000000-0000-4000-8000-000000000020',
    kind: 'pack_bound',
    packId: 'caro_kann_black',
    packCoverageCycleId: 'caro_kann_black::coverage:0',
  })
  await source.appendCycleEvent(started)
  await source.appendCycleEvent(binding)
  await source.appendCoverageEvent(coverageEvent())
  await source.appendCursor(cursor())
  const latest = cursor({
    reviewedCardIds: [CARD_A, CARD_B],
    completedPathIds: [PATH_A, PATH_B],
    pendingPathIds: [],
    batchIndex: 1,
  })
  await source.appendCursor(latest)

  assert.equal(supportsFamilyTrainingJournalTransfer(source), true)
  assert.equal(supportsFamilyTrainingJournalTransfer({
    kind: 'cloud',
    appendCoverageEvent: async () => 'appended',
    appendCycleEvent: async () => 'appended',
    appendCursor: async () => 'appended',
    listCoverageEvents: async () => [],
    listCycleEvents: async () => [],
    loadLatestCursor: async () => null,
    loadCursor: async () => null,
  }), false)

  const snapshot = await source.exportSnapshot()
  assert.equal(FamilyTrainingJournalSnapshotV1Schema.safeParse(snapshot).success, true)
  assert.deepEqual(snapshot.latestCursors, [latest])
  snapshot.coverageEvents[0]!.pathId = PATH_B
  assert.deepEqual((await source.exportSnapshot()).coverageEvents, [coverageEvent()])

  const target = new MemoryFamilyTrainingJournalRepository()
  await target.appendCoverageEvent(coverageEvent({
    eventId: '00000000-0000-4000-8000-000000000030',
    pathId: PATH_B,
  }))
  await target.replaceSnapshot(await source.exportSnapshot())
  assert.deepEqual(await target.exportSnapshot(), await source.exportSnapshot())
  assert.deepEqual(await target.loadLatestCursor({
    releaseId: latest.releaseId,
    familyId: latest.familyId,
    packId: 'caro_kann_black',
    side: latest.side,
  }), latest)

  const beforeInvalidReplacement = await target.exportSnapshot()
  await assert.rejects(
    () => target.replaceSnapshot({
      ...beforeInvalidReplacement,
      coverageEvents: [beforeInvalidReplacement.coverageEvents[0]!, {
        ...beforeInvalidReplacement.coverageEvents[0]!,
        eventId: '00000000-0000-4000-8000-000000000031',
      }],
    }),
    /Logical path completions must be unique/u,
  )
  assert.deepEqual(await target.exportSnapshot(), beforeInvalidReplacement)
})

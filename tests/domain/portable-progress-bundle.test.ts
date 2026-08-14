import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FamilyTrainingJournalSnapshotV1Schema,
  MemoryFamilyTrainingJournalRepository,
} from '../../src/domain/family-training-journal.ts'
import { createCard, createEmptyProgress } from '../../src/domain/progress.ts'
import {
  applyPuzzleAttemptEvent,
  createEmptyPuzzleProgress,
} from '../../src/domain/puzzle-progress.ts'
import {
  PORTABLE_PROGRESS_BUNDLE_FORMAT,
  PortableProgressBundleV1Schema,
  createPortableProgressBundle,
  exportPortableProgressJson,
  importPortableProgressJson,
} from '../../src/infrastructure/portable-progress-bundle.ts'
import { exportProgressJson } from '../../src/infrastructure/progress-repository.ts'

function populatedOpeningProgress() {
  const now = new Date('2026-08-06T12:00:00.000Z')
  const progress = createEmptyProgress(now)
  const lineId = 'tax_aaaaaaaaaaaaaaaaaaaaaaaa:white'
  const nodeId = 'pos_0000000000000001'
  const card = createCard(`${lineId}::${nodeId}`, lineId, nodeId, now)
  progress.cards[card.cardId] = card
  return progress
}

function populatedPuzzleProgress() {
  return applyPuzzleAttemptEvent(createEmptyPuzzleProgress(new Date('2026-08-06T12:00:00.000Z')), {
    eventId: '10000000-0000-4000-8000-000000000001',
    puzzleId: 'OpeningPuzzle1',
    occurredAt: '2026-08-06T12:01:00.000Z',
    outcome: 'solved',
    incorrectAttempts: 0,
    usedHint: false,
    elapsedMs: 3_200,
  })
}

async function populatedFamilySnapshot() {
  const repository = new MemoryFamilyTrainingJournalRepository()
  await repository.appendCoverageEvent({
    schemaVersion: 1,
    eventId: '20000000-0000-4000-8000-000000000001',
    releaseId: 'release-2026-08-06',
    familyId: 'caro-kann',
    packId: 'caro_kann_black',
    pathId: 'path_00000000000000000001',
    coverageCycleId: 'caro_kann_black::coverage:0',
    completedAt: '2026-08-06T12:02:00.000Z',
  })
  await repository.appendCursor({
    schemaVersion: 1,
    releaseId: 'release-2026-08-06',
    familyId: 'caro-kann',
    side: 'black',
    coverageCycleId: 'caro_kann_black::coverage:0',
    authoritativeDueCardIds: ['caro_kann_black::pos_0000000000000001'],
    reviewedCardIds: [],
    completedPathIds: ['path_00000000000000000001'],
    pendingPathIds: ['path_00000000000000000002'],
    batchIndex: 1,
  })
  return repository.exportSnapshot()
}

test('portable JSON round-trips all three progress namespaces exactly', async () => {
  const openingProgress = populatedOpeningProgress()
  const puzzleProgress = populatedPuzzleProgress()
  const familyJournal = await populatedFamilySnapshot()
  const bundle = createPortableProgressBundle({
    openingProgress,
    puzzleProgress,
    familyJournal,
    exportedAt: new Date('2026-08-06T13:00:00.000Z'),
  })
  assert.equal(bundle.format, PORTABLE_PROGRESS_BUNDLE_FORMAT)
  const imported = importPortableProgressJson(exportPortableProgressJson(bundle))
  assert.equal(imported.kind, 'bundle-v1')
  if (imported.kind !== 'bundle-v1') throw new Error('Expected a complete bundle')
  assert.deepEqual(imported.bundle, bundle)
  assert.deepEqual(imported.bundle.openingProgress, openingProgress)
  assert.deepEqual(imported.bundle.puzzleProgress, puzzleProgress)
  assert.deepEqual(imported.bundle.familyJournal, familyJournal)
})

test('legacy progress-only JSON is identified without manufacturing replacement puzzle or family state', () => {
  const openingProgress = populatedOpeningProgress()
  const imported = importPortableProgressJson(exportProgressJson(openingProgress))
  assert.deepEqual(imported, { kind: 'legacy-progress-only', progress: openingProgress })
  assert.equal(Object.hasOwn(imported, 'puzzleProgress'), false)
  assert.equal(Object.hasOwn(imported, 'familyJournal'), false)
})

test('portable parser rejects size, NUL, malformed Unicode, reserved keys, and invalid versions', async () => {
  assert.throws(() => importPortableProgressJson('x'.repeat(1024 * 1024 + 1)), /1 MB/u)
  assert.throws(() => importPortableProgressJson('{"x":"\u0000"}'), /NUL/u)
  assert.throws(
    () => importPortableProgressJson(`{"x":"${String.fromCharCode(0xd800)}"}`),
    /malformed Unicode/u,
  )
  assert.throws(
    () => importPortableProgressJson('{"format":"linerecall-portable-progress","__proto__":{},"version":1}'),
    /reserved object key/u,
  )
  assert.throws(
    () => importPortableProgressJson('{"format":"linerecall-portable-progress","version":99}'),
    /unsupported version or invalid fields/u,
  )

  const bundle = createPortableProgressBundle({
    openingProgress: populatedOpeningProgress(),
    puzzleProgress: populatedPuzzleProgress(),
    familyJournal: await populatedFamilySnapshot(),
    exportedAt: new Date('2026-08-06T13:00:00.000Z'),
  })
  assert.equal(PortableProgressBundleV1Schema.safeParse({ ...bundle, extra: true }).success, false)
  assert.equal(FamilyTrainingJournalSnapshotV1Schema.safeParse({
    ...bundle.familyJournal,
    latestCursors: [
      bundle.familyJournal.latestCursors[0]!,
      bundle.familyJournal.latestCursors[0]!,
    ],
  }).success, false)
})

test('portable export rejects invalid clocks and invalid nested progress rather than normalizing it', async () => {
  const familyJournal = await populatedFamilySnapshot()
  assert.throws(() => createPortableProgressBundle({
    openingProgress: populatedOpeningProgress(),
    puzzleProgress: populatedPuzzleProgress(),
    familyJournal,
    exportedAt: new Date(Number.NaN),
  }), /export time is invalid/u)
  assert.equal(PortableProgressBundleV1Schema.safeParse({
    format: PORTABLE_PROGRESS_BUNDLE_FORMAT,
    version: 1,
    exportedAt: '2026-08-06T13:00:00.000Z',
    openingProgress: populatedOpeningProgress(),
    puzzleProgress: { ...populatedPuzzleProgress(), version: 2 },
    familyJournal,
  }).success, false)
})

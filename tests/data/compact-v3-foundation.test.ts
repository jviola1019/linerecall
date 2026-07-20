import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ADAPTIVE_EVIDENCE_MAX_PLY,
  COMPACT_MINIMUM_FREE_RESERVE_BYTES,
  COMPACT_STORAGE_MODEL,
  CompactArchiveCheckpointSchema,
  CompactPassReceiptSchema,
  CompactPreflightPlanSchema,
  type CompactPassReceipt,
  type CompactPreflightPlan,
} from '../../scripts/data/compact-v3-contracts.ts'
import {
  CompactCandidatePass,
  CompactExactPass,
  SqliteCandidateIndex,
  SqliteCompactExactStore,
  assessCompactV3Storage,
  classifyBookTerminal,
  compactPreflightExitCode,
  compactReplayObservations,
  evidenceFingerprint,
  receiptDigest,
  resumeAction,
  shouldRetainExactObservation,
  type CompactEvidenceIdentity,
} from '../../scripts/data/compact-v3-foundation.ts'

const archive = {
  archiveId: 'standard-2026-04',
  sourceId: 'lichess-standard-rated-q2-2026' as const,
  sourceManifestSha256: '9'.repeat(64),
  licenseSpdxId: 'CC0-1.0' as const,
  cutoff: '2026-06-30',
  month: '2026-04',
  filename: 'lichess_db_standard_rated_2026-04.pgn.zst',
  url: 'https://database.lichess.org/standard/lichess_db_standard_rated_2026-04.pgn.zst',
  compressedBytes: 29_325_351_334,
  sha256: 'a'.repeat(64),
  retrievedAt: '2026-07-16T11:00:00.000Z',
  etagObserved: 'fixture-etag',
  lastModifiedObserved: 'Thu, 16 Jul 2026 10:00:00 GMT',
}

const limits = {
  completeBaselineMaxPly: 30 as const,
  adaptiveEvidenceMaxPly: 100 as const,
  adaptiveCandidateMinimumSample: 100 as const,
  archiveConcurrency: 1 as const,
  minimumFreeReserveBytes: COMPACT_MINIMUM_FREE_RESERVE_BYTES,
  countMinWidth: 1,
  countMinDepth: 2,
  maximumCandidates: 10,
}

const bounds = {
  candidateSketchMaxBytes: 8,
  candidateIndexMaxBytes: 4_096,
  baselineShardMaxBytes: 16_384,
  adaptiveShardMaxBytes: 8_192,
  exactWorkMaxBytes: 16_384,
  checkpointMaxBytes: 4_096,
  atomicPromotionMaxBytes: 16_384,
  inputStagingMaxBytes: 0,
  retainedCorpusMaxBytes: 32_768,
}

function preflightPlan(status: 'pending' | 'approved'): CompactPreflightPlan {
  return CompactPreflightPlanSchema.parse({
    schemaVersion: 3,
    storageModel: COMPACT_STORAGE_MODEL,
    archive,
    limits,
    bounds,
    benchmark: status === 'approved' ? {
      status,
      method: 'complete-broadcast-replay-with-enforced-hard-caps',
      receiptSha256: 'b'.repeat(64),
      measuredAt: '2026-07-16T12:00:00.000Z',
      acceptedGames: 800_176,
      observations: 40_000_000,
      peakResidentBytes: 1_000_000_000,
      peakAdditionalStorageBytes: 60_000,
      note: 'Fixture representing an explicitly approved complete replay.',
    } : {
      status,
      method: 'complete-broadcast-replay-with-enforced-hard-caps',
      receiptSha256: null,
      measuredAt: null,
      acceptedGames: 0,
      observations: 0,
      peakResidentBytes: 0,
      peakAdditionalStorageBytes: 0,
      note: 'The required complete broadcast replay has not run.',
    },
  })
}

function passReceipt(pass: 'candidate' | 'exact'): CompactPassReceipt {
  const base = {
    schemaVersion: 3 as const,
    storageModel: COMPACT_STORAGE_MODEL,
    executionPurpose: 'evidence-candidate' as const,
    releaseEligible: false as const,
    archive,
    limits,
    startedAt: '2026-07-16T12:00:00.000Z',
    completedAt: '2026-07-16T12:05:00.000Z',
    compressedInput: { bytes: archive.compressedBytes, sha256: archive.sha256, verified: true as const },
    output: { path: `v3/${archive.archiveId}/${pass}.sqlite`, bytes: 1_024, sha256: 'c'.repeat(64) },
    recordsSeen: 10,
    accepted: 8,
    deduplicated: 1,
    rejected: { malformed_pgn: 1 },
    toolchain: {
      node: '24.4.1',
      chessJs: '1.4.0',
      zstd: 'node-zstd',
      sourceSnapshotSha256: 'd'.repeat(64),
    },
  }
  return CompactPassReceiptSchema.parse(pass === 'candidate' ? {
    ...base,
    pass,
    priorCandidateStateSha256: null,
    nextCandidateStateSha256: 'f'.repeat(64),
    adaptiveObservationsSeen: 1_000,
    candidateRows: 12,
    candidateFalsePositivesAllowed: true,
    candidateFalseNegativesAllowed: false,
    hardCapReached: false,
  } : {
    ...base,
    pass,
    finalCandidateSetReceiptSha256: 'e'.repeat(64),
    completeBaselineObservationsRetained: 700,
    adaptiveCandidateObservationsRetained: 200,
    adaptiveNoncandidateObservationsRejected: 100,
    normalizedPositionRows: 50,
    normalizedEdgeRows: 60,
    hardCapReached: false,
  })
}

test('v3 provenance receipts bind exact approved input and reconcile accounting', () => {
  const candidate = passReceipt('candidate')
  assert.equal(candidate.pass, 'candidate')
  assert.match(receiptDigest(candidate), /^[a-f0-9]{64}$/u)
  assert.throws(() => CompactPassReceiptSchema.parse({
    ...candidate,
    compressedInput: { ...candidate.compressedInput, sha256: 'f'.repeat(64) },
  }), /match the approved source archive/u)
  assert.throws(() => CompactPassReceiptSchema.parse({ ...candidate, recordsSeen: 11 }), /must reconcile/u)
  assert.throws(() => CompactPassReceiptSchema.parse({
    ...candidate,
    output: { ...candidate.output, path: '../escape.sqlite' },
  }), /canonical relative POSIX/u)
  assert.throws(() => CompactPassReceiptSchema.parse({
    ...candidate,
    archive: { ...candidate.archive, licenseSpdxId: 'CC-BY-SA-4.0' },
  }), /requires CC0-1.0/u)
})

test('archive checkpoints resume only at atomic pass boundaries', () => {
  const candidate = passReceipt('candidate')
  const exact = passReceipt('exact')
  const base = {
    schemaVersion: 3 as const,
    archive,
    updatedAt: '2026-07-16T12:06:00.000Z',
    resumePolicy: 'archive-pass-atomic-replay-from-start' as const,
  }
  assert.equal(resumeAction({ ...base, candidateReceipt: null, exactReceipt: null }), 'candidate')
  assert.equal(resumeAction({ ...base, candidateReceipt: candidate, exactReceipt: null }), 'exact')
  assert.equal(resumeAction({ ...base, candidateReceipt: candidate, exactReceipt: exact }), 'complete')
  assert.throws(() => CompactArchiveCheckpointSchema.parse({
    ...base,
    candidateReceipt: null,
    exactReceipt: exact,
  }), /requires a candidate receipt/u)
})

test('candidate pass remains bounded, permits false positives, and cannot omit a true threshold crossing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-candidates-'))
  const index = new SqliteCandidateIndex(join(directory, 'candidates.sqlite'), 10)
  try {
    const pass = new CompactCandidatePass(index, 1, 2)
    const a: CompactEvidenceIdentity = { kind: 'position', epd: '8/8/8/8/8/8/4K3/7k w - -' }
    const b: CompactEvidenceIdentity = { kind: 'position', epd: '8/8/8/8/8/8/3K4/7k b - -' }
    pass.beginArchive()
    assert.deepEqual(pass.observe({ identity: a, cohortId: 'cohort_test-blitz', ply: 30 }), {
      retained: false, estimate: null,
    })
    for (let count = 0; count < 99; count += 1) {
      pass.observe({ identity: a, cohortId: 'cohort_test-blitz', ply: 31 })
    }
    // A one-cell sketch deliberately collides. B is a harmless false positive;
    // A is still retained when its real sample reaches one hundred.
    assert.equal(pass.observe({ identity: b, cohortId: 'cohort_test-blitz', ply: 31 }).retained, true)
    assert.equal(pass.observe({ identity: a, cohortId: 'cohort_test-blitz', ply: 31 }).retained, true)
    assert.equal(index.size, 2)
    assert.equal(pass.observationsSeen, 101)
    const snapshot = pass.commitArchive()
    assert.equal(snapshot.length, 20)
    assert.equal(shouldRetainExactObservation({ identity: a, cohortId: 'cohort_test-blitz', ply: 30 }, index), true)
    assert.equal(shouldRetainExactObservation({ identity: a, cohortId: 'cohort_test-blitz', ply: 31 }, index), true)
    assert.equal(shouldRetainExactObservation({
      identity: { kind: 'position', epd: '8/8/8/8/8/8/2K5/7k w - -' },
      cohortId: 'cohort_test-blitz',
      ply: 31,
    }, index), false)
  } finally {
    index.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('candidate hard caps fail closed instead of dropping a retained identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-cap-'))
  const index = new SqliteCandidateIndex(join(directory, 'candidates.sqlite'), 1)
  try {
    const pass = new CompactCandidatePass(index, 1, 2)
    const first = { kind: 'position' as const, epd: '8/8/8/8/8/8/4K3/7k w - -' }
    const second = { kind: 'position' as const, epd: '8/8/8/8/8/8/3K4/7k b - -' }
    pass.beginArchive()
    for (let count = 0; count < 100; count += 1) {
      pass.observe({ identity: first, cohortId: 'cohort_test-rapid', ply: 31 })
    }
    assert.throws(
      () => pass.observe({ identity: second, cohortId: 'cohort_test-rapid', ply: 31 }),
      /hard cap reached/u,
    )
    assert.equal(index.size, 1)
    pass.rollbackArchive()
    assert.equal(index.size, 0)
  } finally {
    index.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('candidate sketch snapshots preserve cross-archive threshold counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-resume-'))
  const index = new SqliteCandidateIndex(join(directory, 'candidates.sqlite'), 10)
  const identity = { kind: 'position' as const, epd: '8/8/8/8/8/8/4K3/7k w - -' }
  try {
    const april = new CompactCandidatePass(index, 1_024, 4)
    april.beginArchive()
    for (let count = 0; count < 50; count += 1) {
      april.observe({ identity, cohortId: 'cohort_test-blitz', ply: 40 })
    }
    const aprilState = april.commitArchive()
    assert.equal(index.size, 0)

    const may = new CompactCandidatePass(index, 1_024, 4, aprilState)
    may.beginArchive()
    for (let count = 0; count < 49; count += 1) {
      may.observe({ identity, cohortId: 'cohort_test-blitz', ply: 40 })
    }
    assert.equal(index.size, 0)
    assert.equal(may.observe({ identity, cohortId: 'cohort_test-blitz', ply: 40 }).retained, true)
    may.commitArchive()
    assert.equal(index.size, 1)
  } finally {
    index.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('legal replay observations use absolute reached ply and deduplicate visits within a game', () => {
  const moves = [
    { from: 'g1', to: 'f3' },
    { from: 'g8', to: 'f6' },
    { from: 'f3', to: 'g1' },
    { from: 'f6', to: 'g8' },
    { from: 'g1', to: 'f3' },
  ] as const
  const observations = compactReplayObservations(moves)
  const edges = observations.filter((observation) => observation.identity.kind === 'edge')
  assert.deepEqual(edges.map(({ ply }) => ply), [1, 2, 3, 4])
  assert.equal(observations.some(({ ply }) => ply === 5), false)
  assert.throws(() => compactReplayObservations(moves, ADAPTIVE_EVIDENCE_MAX_PLY + 1), /maximum ply/u)
})

test('exact store normalizes positions and edges to numeric IDs while retaining raw outcomes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-exact-'))
  const store = new SqliteCompactExactStore(join(directory, 'exact.sqlite'))
  const root = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
  const after = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -'
  const common = {
    cohortId: 'cohort_test-classical',
    month: '2026-04',
    timeControl: 'classical' as const,
    ratingBand: '2000-2199' as const,
    ratingDetail: '' as const,
  }
  try {
    store.beginArchive()
    store.add({ ...common, identity: { kind: 'position', epd: root }, ply: 0, result: '1-0' })
    store.add({ ...common, identity: { kind: 'position', epd: root }, ply: 0, result: '1/2-1/2' })
    store.add({
      ...common,
      identity: { kind: 'edge', fromEpd: root, uci: 'e2e4', toEpd: after },
      san: 'e4',
      ply: 1,
      result: '1-0',
    })
    store.commitArchive()
    const positions = store.database.prepare('SELECT position_id AS id, epd FROM positions ORDER BY position_id').all() as unknown as Array<{ id: number; epd: string }>
    const edges = store.database.prepare('SELECT edge_id AS id, from_position_id AS fromId, to_position_id AS toId FROM edges').all() as unknown as Array<{ id: number; fromId: number; toId: number }>
    const outcome = store.database.prepare("SELECT n, white_wins AS whiteWins, draws FROM outcomes WHERE kind = 'position'").get() as { n: number; whiteWins: number; draws: number }
    assert.equal(positions.length, 2)
    assert.equal(edges.length, 1)
    assert.ok(Number.isInteger(edges[0]!.fromId) && Number.isInteger(edges[0]!.toId))
    assert.deepEqual({ ...outcome }, { n: 2, whiteWins: 1, draws: 1 })
    assert.notEqual(evidenceFingerprint({ kind: 'position', epd: root }), evidenceFingerprint({
      kind: 'edge', fromEpd: root, uci: 'e2e4', toEpd: after,
    }))
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('exact pass retains complete baseline evidence and only selected adaptive candidates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-two-pass-'))
  const candidateIndex = new SqliteCandidateIndex(join(directory, 'candidates.sqlite'), 10)
  const exactStore = new SqliteCompactExactStore(join(directory, 'exact.sqlite'))
  const selected = { kind: 'position' as const, epd: '8/8/8/8/8/8/4K3/7k w - -' }
  const other = { kind: 'position' as const, epd: '8/8/8/8/8/8/3K4/7k b - -' }
  const evidence = {
    cohortId: 'cohort_test-rapid',
    month: '2026-04',
    timeControl: 'rapid' as const,
    ratingBand: '<1800' as const,
    ratingDetail: '<1200' as const,
    result: '1-0' as const,
  }
  try {
    const candidatePass = new CompactCandidatePass(candidateIndex, 1_024, 4)
    candidatePass.beginArchive()
    for (let count = 0; count < 100; count += 1) {
      candidatePass.observe({ identity: selected, cohortId: evidence.cohortId, ply: 31 })
    }
    candidatePass.commitArchive()

    const exactPass = new CompactExactPass(exactStore, candidateIndex)
    exactPass.beginArchive()
    assert.equal(exactPass.observe({ ...evidence, identity: other, ply: 30 }), true)
    assert.equal(exactPass.observe({ ...evidence, identity: selected, ply: 31 }), true)
    assert.equal(exactPass.observe({ ...evidence, identity: other, ply: 31 }), false)
    assert.deepEqual(exactPass.commitArchive(), {
      observationsSeen: 3,
      completeBaselineObservationsRetained: 1,
      adaptiveCandidateObservationsRetained: 1,
      adaptiveNoncandidateObservationsRejected: 1,
    })
    const rows = exactStore.database.prepare('SELECT count(*) AS count FROM outcomes').get() as { count: number }
    assert.equal(rows.count, 2)
  } finally {
    exactStore.close()
    candidateIndex.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('preflight uses enforced caps, preserves 10 GiB, and documents exit 0/2', () => {
  const bound = Object.values(bounds).reduce((sum, value) => sum + value, 0)
  const pending = assessCompactV3Storage(preflightPlan('pending'), Number.MAX_SAFE_INTEGER)
  assert.equal(pending.safeToStart, false)
  assert.equal(pending.reasonCode, 'benchmark-not-approved')
  assert.equal(compactPreflightExitCode(pending), 2)
  const approved = preflightPlan('approved')
  const insufficient = assessCompactV3Storage(approved, bound + COMPACT_MINIMUM_FREE_RESERVE_BYTES - 1)
  assert.equal(insufficient.reasonCode, 'insufficient-free-space')
  assert.equal(compactPreflightExitCode(insufficient), 2)
  const ready = assessCompactV3Storage(approved, bound + COMPACT_MINIMUM_FREE_RESERVE_BYTES)
  assert.equal(ready.peakAdditionalBytesUpperBound, bound)
  assert.equal(ready.remainingBytesAtPeak, COMPACT_MINIMUM_FREE_RESERVE_BYTES)
  assert.equal(compactPreflightExitCode(ready), 0)
  const partlyRetained = assessCompactV3Storage(
    approved,
    bound - 8_192 + COMPACT_MINIMUM_FREE_RESERVE_BYTES,
    { retainedBytesAlreadyPresent: 8_192 },
  )
  assert.equal(partlyRetained.retainedBytesAlreadyPresent, 8_192)
  assert.equal(partlyRetained.remainingRetainedBudgetBytes, bounds.retainedCorpusMaxBytes - 8_192)
  assert.equal(partlyRetained.peakAdditionalBytesUpperBound, bound - 8_192)
  assert.equal(partlyRetained.safeToStart, true)
  const overRetained = assessCompactV3Storage(approved, Number.MAX_SAFE_INTEGER, {
    retainedBytesAlreadyPresent: bounds.retainedCorpusMaxBytes + 1,
  })
  assert.equal(overRetained.safeToStart, false)
  assert.equal(overRetained.reasonCode, 'retained-state-cap-exceeded')
  const bootstrap = assessCompactV3Storage(preflightPlan('pending'), bound + COMPACT_MINIMUM_FREE_RESERVE_BYTES, {
    executionPurpose: 'benchmark-bootstrap',
  })
  assert.equal(bootstrap.safeToStart, true)
  assert.equal(bootstrap.executionPurpose, 'benchmark-bootstrap')
  assert.equal(bootstrap.reasonCode, 'ready')
  const approvedBootstrap = assessCompactV3Storage(approved, Number.MAX_SAFE_INTEGER, {
    executionPurpose: 'benchmark-bootstrap',
  })
  assert.equal(approvedBootstrap.safeToStart, false)
  assert.equal(approvedBootstrap.reasonCode, 'benchmark-bootstrap-requires-pending-proof')
  assert.throws(() => assessCompactV3Storage({
    ...approved,
    bounds: { ...approved.bounds, candidateSketchMaxBytes: 7 },
  }, Number.MAX_SAFE_INTEGER), /sketch byte cap/u)
})

test('terminal status distinguishes empirical ends, sample exhaustion, quarantine, and ply-100 caps', () => {
  assert.equal(classifyBookTerminal({ terminalPly: 42, hasEligibleContinuation: false, hasObservedContinuation: false, quarantined: false }), 'evidence_terminal')
  assert.equal(classifyBookTerminal({ terminalPly: 42, hasEligibleContinuation: false, hasObservedContinuation: true, quarantined: false }), 'insufficient_sample')
  assert.equal(classifyBookTerminal({ terminalPly: 42, hasEligibleContinuation: false, hasObservedContinuation: false, quarantined: true }), 'quarantined')
  assert.equal(classifyBookTerminal({ terminalPly: 100, hasEligibleContinuation: true, hasObservedContinuation: true, quarantined: false }), 'depth_capped')
  assert.throws(() => classifyBookTerminal({ terminalPly: 99, hasEligibleContinuation: true, hasObservedContinuation: true, quarantined: false }), /cannot terminate/u)
})

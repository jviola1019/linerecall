import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  CompactV31ArchiveDeltaReceiptSchema,
  CompactV31BenchmarkAuthorizationReceiptSchema,
  CompactV31MergeReceiptSchema,
  CompactV31PlanSchema,
  CompactV31RepeatabilityBindingSchema,
  CompactV31RunReceiptSchema,
  assessCompactV31Resources,
  compactV31ConfigurationSha256,
} from '../../scripts/data/compact-v31-contracts.ts'
import { compactV31ExecutionStatus } from '../../scripts/data/run-compact-v31-benchmark.ts'
import { assessCompactV31WorkDirectory } from '../../scripts/data/preflight-compact-v31.ts'

const gib = 1024 * 1024 * 1024
const hash = (value: string) => value.repeat(64).slice(0, 64)
const resources = {
  sampleCount: 1,
  maximumObservedWorkerResidentBytes: 1 * gib,
  minimumObservedFreeStorageBytes: 20 * gib,
  minimumObservedAvailableMemoryBytes: 10 * gib,
  maximumObservedRetainedDeltaBytes: 1,
} as const

const limits = {
  minimumAvailableMemoryBytes: 8 * gib,
  maximumWorkerResidentBytes: 6 * gib,
  minimumFreeReserveBytes: 10 * gib,
  archiveConcurrency: 1,
  maximumDeltaBytesPerArchive: 1 * gib,
  maximumPartitionRunBytes: 1 * gib,
  maximumMergeWorkspaceBytes: 4 * gib,
  maximumReceiptBytes: 16 * 1024 * 1024,
  maximumRetainedDeltaBytes: 32 * gib,
  maximumFinalStateBytes: 16 * gib,
  inputStagingBytes: 0,
} as const

const partitioning = {
  algorithm: 'sha256-prefix',
  prefixBits: 12,
  keyOrder: 'unsigned-byte-lexicographic',
  duplicatePolicy: 'merge-identical-key-counters',
} as const

const replay = {
  completeBaselineMaxPly: 30,
  adaptiveEvidenceMaxPly: 100,
  adaptiveCandidateMinimumSample: 100,
  compressedInputReplay: 'from-byte-zero',
  sourceExpansion: 'stream-only',
} as const

function plan() {
  const sourceSnapshotSha256 = hash('a')
  const benchmarkAuthorizationSha256 = hash('b')
  return CompactV31PlanSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-archive-plan',
    storageModel: 'log-structured-external-merge-v3.1',
    pipelineVersion: '3.1.0',
    sourceSnapshotSha256,
    configurationSha256: compactV31ConfigurationSha256({
      sourceSnapshotSha256,
      benchmarkAuthorizationSha256,
      limits,
      partitioning,
      replay,
    }),
    benchmarkAuthorizationSha256,
    executionPurpose: 'benchmark-bootstrap',
    releaseEligible: false,
    archive: {
      archiveId: 'broadcast-2020-01',
      sourceId: 'lichess-broadcasts',
      sourceManifestSha256: hash('c'),
      licenseSpdxId: 'CC-BY-SA-4.0',
      cutoff: '2026-06-30',
      month: '2020-01',
      filename: 'lichess_db_broadcast_2020-01.pgn.zst',
      url: 'https://database.lichess.org/broadcast/lichess_db_broadcast_2020-01.pgn.zst',
      compressedBytes: 100,
      sha256: hash('d'),
      retrievedAt: '2026-08-23T12:24:12.871Z',
      etagObserved: 'fixture',
      lastModifiedObserved: 'Sun, 23 Aug 2026 12:24:12 GMT',
    },
    archiveOrdinal: 0,
    corpusArchiveCount: 78,
    limits,
    partitioning,
    replay,
  })
}

test('checked-in authorization records only the exact provisional benchmark permission', async () => {
  const receipt = CompactV31BenchmarkAuthorizationReceiptSchema.parse(JSON.parse(
    await readFile('data/manifests/compact-v31-benchmark.authorization.json', 'utf8'),
  ) as unknown)
  assert.equal(receipt.proposalSha256, 'c598a637c729be22a61583345b33589f462f1fb07294ef53678f0ecc85e857d5')
  assert.equal(receipt.observationSha256, '043b06dfd1fdf6adee65b1e1d29e18a561c0a046c4d6a5dd124aeb138465d56c')
  assert.equal(receipt.q2IngestionAuthorized, false)
  assert.equal(receipt.benchmarkPromotionAuthorized, false)
  assert.equal(receipt.releaseEligible, false)
})

test('preflight blocks low available memory, an RSS breach, and a reserve breach', () => {
  const input = plan()
  const lowMemory = assessCompactV31Resources(input, {
    availableStorageBytes: 100 * gib,
    retainedDeltaBytes: 0,
    availableMemoryBytes: 8 * gib - 1,
    workerResidentBytes: 1 * gib,
  })
  assert.equal(lowMemory.safeToStart, false)
  assert.equal(lowMemory.reasonCode, 'insufficient-memory')

  const highRss = assessCompactV31Resources(input, {
    availableStorageBytes: 100 * gib,
    retainedDeltaBytes: 0,
    availableMemoryBytes: 10 * gib,
    workerResidentBytes: 6 * gib + 1,
  })
  assert.equal(highRss.reasonCode, 'worker-rss-cap-exceeded')

  const lowDisk = assessCompactV31Resources(input, {
    availableStorageBytes: 10 * gib,
    retainedDeltaBytes: 0,
    availableMemoryBytes: 10 * gib,
    workerResidentBytes: 1 * gib,
  })
  assert.equal(lowDisk.reasonCode, 'insufficient-free-space')
})

test('preflight permits exactly one bounded archive transaction when all caps fit', () => {
  const result = assessCompactV31Resources(plan(), {
    availableStorageBytes: 80 * gib,
    retainedDeltaBytes: 10 * gib,
    availableMemoryBytes: 10 * gib,
    workerResidentBytes: 1 * gib,
  })
  assert.equal(result.safeToStart, true)
  assert.equal(result.reasonCode, 'ready')
  assert.ok(result.remainingStorageAtPeakBytes >= 10 * gib)
})

test('filesystem preflight accounts for retained immutable delta bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-v31-preflight-'))
  const deltaDirectory = join(root, 'v31', 'deltas', 'run-one')
  await mkdir(deltaDirectory, { recursive: true })
  await writeFile(join(deltaDirectory, '000.run'), Buffer.alloc(17))
  const result = await assessCompactV31WorkDirectory(plan(), root, {
    availableStorageBytes: 100 * gib,
    availableMemoryBytes: 10 * gib,
    workerResidentBytes: 1 * gib,
  })
  assert.equal(result.retainedDeltaBytes, 17)
  assert.equal(result.safeToStart, true)
})

test('filesystem preflight rejects a retained-delta link instead of following it', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-v31-linked-preflight-'))
  const external = await mkdtemp(join(tmpdir(), 'linerecall-v31-external-deltas-'))
  await writeFile(join(external, '000.run'), Buffer.alloc(17))
  await mkdir(join(root, 'v31'), { recursive: true })
  try {
    await symlink(external, join(root, 'v31', 'deltas'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('This platform does not permit creating a test directory link')
      return
    }
    throw error
  }
  await assert.rejects(
    assessCompactV31WorkDirectory(plan(), root, {
      availableStorageBytes: 100 * gib,
      availableMemoryBytes: 10 * gib,
      workerResidentBytes: 1 * gib,
    }),
    /non-symbolic-link directory/iu,
  )
})

test('archive deltas are ordered immutable runs rather than cumulative states', () => {
  const base = plan()
  const receipt = CompactV31ArchiveDeltaReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-archive-delta',
    storageModel: base.storageModel,
    pipelineVersion: base.pipelineVersion,
    executionPurpose: 'benchmark-bootstrap',
    releaseEligible: false,
    runId: 'fixture-run-one',
    sourceSnapshotSha256: base.sourceSnapshotSha256,
    configurationSha256: base.configurationSha256,
    benchmarkAuthorizationSha256: base.benchmarkAuthorizationSha256,
    archive: base.archive,
    archiveOrdinal: 0,
    pass: 'candidate',
    previousArchiveDeltaReceiptSha256: null,
    compressedInput: { bytes: 100, sha256: hash('d'), verified: true },
    accounting: { recordsSeen: 2, accepted: 1, deduplicated: 0, rejected: { malformed_pgn: 1 } },
    partitions: [{
      partition: '000',
      path: 'v31/deltas/fixture/000.run',
      bytes: 10,
      sha256: hash('e'),
      firstKeySha256: hash('1'),
      lastKeySha256: hash('2'),
      rowCount: 1,
    }],
    startedAt: '2026-08-27T12:00:00.000Z',
    completedAt: '2026-08-27T12:01:00.000Z',
    hardCapReached: false,
    resources,
  })
  assert.equal(receipt.previousArchiveDeltaReceiptSha256, null)
  assert.throws(() => CompactV31ArchiveDeltaReceiptSchema.parse({
    ...receipt,
    archiveOrdinal: 1,
    previousArchiveDeltaReceiptSha256: null,
  }), /chain is incomplete/iu)
})

test('external merge receipts bind all archive deltas and reconcile row accounting', () => {
  const inputDeltaReceiptSha256s = Array.from(
    { length: 78 },
    (_, index) => index.toString(16).padStart(64, '0'),
  )
  const inputDeltaReceipts = inputDeltaReceiptSha256s.map((receiptSha256, archiveOrdinal) => {
    const absoluteMonth = (2020 * 12) + archiveOrdinal
    return {
      archiveOrdinal,
      archiveId: `broadcast-${Math.floor(absoluteMonth / 12)}-${String((absoluteMonth % 12) + 1).padStart(2, '0')}`,
      receiptSha256,
    }
  })
  const receipt = CompactV31MergeReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-external-merge',
    storageModel: 'log-structured-external-merge-v3.1',
    pipelineVersion: '3.1.0',
    executionPurpose: 'benchmark-bootstrap',
    releaseEligible: false,
    runId: 'fixture-run-one',
    pass: 'exact',
    sourceSnapshotSha256: hash('a'),
    configurationSha256: hash('b'),
    inputDeltaReceipts,
    outputPartitions: [{
      partition: '000',
      path: 'v31/merged/fixture/000.run',
      bytes: 10,
      sha256: hash('c'),
      firstKeySha256: hash('1'),
      lastKeySha256: hash('2'),
      rowCount: 3,
    }],
    ownershipIndexes: [],
    inputRows: 5,
    outputRows: 3,
    duplicateRowsMerged: 2,
    completedAt: '2026-08-27T12:01:00.000Z',
    resources,
  })
  assert.equal(receipt.inputDeltaReceipts.length, 78)
  assert.throws(() => CompactV31MergeReceiptSchema.parse({
    ...receipt,
    inputDeltaReceipts: inputDeltaReceipts.map((value, index) => index === 77
      ? { ...value, receiptSha256: inputDeltaReceiptSha256s[0]! }
      : value),
  }), /must be unique/iu)
  assert.throws(() => CompactV31MergeReceiptSchema.parse({
    ...receipt,
    duplicateRowsMerged: 1,
  }), /does not reconcile/iu)
})

test('repeatability requires independent receipts and byte-identical result bindings', () => {
  const deltaHashes = (prefix: number) => Array.from(
    { length: 78 },
    (_, index) => (prefix + index).toString(16).padStart(64, '0'),
  )
  const deltaRefs = (prefix: number) => deltaHashes(prefix).map((receiptSha256, archiveOrdinal) => {
    const absoluteMonth = (2020 * 12) + archiveOrdinal
    return {
      archiveOrdinal,
      archiveId: `broadcast-${Math.floor(absoluteMonth / 12)}-${String((absoluteMonth % 12) + 1).padStart(2, '0')}`,
      receiptSha256,
    }
  })
  const run = CompactV31RunReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-benchmark-run',
    storageModel: 'log-structured-external-merge-v3.1',
    pipelineVersion: '3.1.0',
    executionPurpose: 'benchmark-bootstrap',
    releaseEligible: false,
    runId: 'broadcast-run-one',
    sourceSnapshotSha256: hash('3'),
    configurationSha256: hash('4'),
    benchmarkAuthorizationSha256: hash('8'),
    planReviewSha256: hash('9'),
    cleanWorkDirectory: true,
    sourceArchiveCount: 78,
    publishedGames: 1_146_297,
    candidateDeltaReceipts: deltaRefs(1),
    candidateMergeReceiptSha256: hash('5'),
    exactDeltaReceipts: deltaRefs(1_000),
    exactMergeReceiptSha256: hash('6'),
    accountingSha256: hash('7'),
    allArchiveDigestsVerified: true,
    resourceSampleCount: 2,
    maximumObservedWorkerResidentBytes: 5 * gib,
    minimumObservedFreeStorageBytes: 11 * gib,
    startedAt: '2026-08-27T12:00:00.000Z',
    completedAt: '2026-08-27T13:00:00.000Z',
    hardCapReached: false,
  })
  assert.equal(run.candidateDeltaReceipts.length, 78)
  assert.equal(CompactV31RunReceiptSchema.safeParse({
    ...run,
    maximumObservedWorkerResidentBytes: 6 * gib + 1,
  }).success, false)

  const valid = {
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-repeatability-binding',
    releaseEligible: false,
    firstRunId: 'broadcast-run-one',
    secondRunId: 'broadcast-run-two',
    firstRunReceiptSha256: hash('1'),
    secondRunReceiptSha256: hash('2'),
    sourceSnapshotSha256: hash('3'),
    configurationSha256: hash('4'),
    benchmarkAuthorizationSha256: hash('8'),
    planReviewSha256: hash('9'),
    candidateMergeSha256: hash('5'),
    exactMergeSha256: hash('6'),
    accountingSha256: hash('7'),
    result: 'byte-identical',
    comparedAt: '2026-08-27T13:00:00.000Z',
    note: 'Fixture comparison only.',
  }
  assert.equal(CompactV31RepeatabilityBindingSchema.parse(valid).result, 'byte-identical')
  assert.equal(CompactV31RepeatabilityBindingSchema.safeParse({
    ...valid,
    secondRunReceiptSha256: valid.firstRunReceiptSha256,
  }).success, false)
})

test('benchmark command reports resource blocking and explicit-input readiness without opening sources', () => {
  const resourceBlocked = compactV31ExecutionStatus(assessCompactV31Resources(plan(), {
    availableStorageBytes: 100 * gib,
    retainedDeltaBytes: 0,
    availableMemoryBytes: 1 * gib,
    workerResidentBytes: 1 * gib,
  }))
  assert.equal(resourceBlocked.reasonCode, 'resource-preflight-blocked')
  assert.equal(resourceBlocked.sourceInputOpened, false)

  const executorBlocked = compactV31ExecutionStatus(assessCompactV31Resources(plan(), {
    availableStorageBytes: 100 * gib,
    retainedDeltaBytes: 0,
    availableMemoryBytes: 10 * gib,
    workerResidentBytes: 1 * gib,
  }))
  assert.equal(executorBlocked.reasonCode, 'explicit-inputs-required')
  assert.equal(executorBlocked.operational, true)
  assert.equal(executorBlocked.benchmarkComplete, false)
  assert.equal(executorBlocked.releaseEligible, false)
  assert.equal(executorBlocked.sourceInputOpened, false)
})

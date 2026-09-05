import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import {
  COMPACT_V31_SKETCH_DEPTH,
  COMPACT_V31_SKETCH_WIDTH,
  CompactV31CountMinSketch,
  compactV31EligibilityKey,
  emitCompactV31ArchiveDelta,
  initializeCompactV31RunDirectory,
  mergeCompactV31ArchiveDeltas,
  startCompactV31ResourceMonitor,
  writeCompactV31RepeatabilityBinding,
  type CompactV31DeltaInput,
} from '../../scripts/data/compact-v31-executor.ts'
import {
  CompactV31ArchiveDeltaReceiptSchema,
  CompactV31MergeReceiptSchema,
  CompactV31PlanSchema,
  CompactV31RunReceiptSchema,
  compactV31ConfigurationSha256,
  type CompactV31Plan,
} from '../../scripts/data/compact-v31-contracts.ts'

const gib = 1024 * 1024 * 1024
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const hash = (value: string): string => value.repeat(64).slice(0, 64)
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
  maximumDeltaBytesPerArchive: 8 * 1024 * 1024,
  maximumPartitionRunBytes: 4 * 1024 * 1024,
  maximumMergeWorkspaceBytes: 64 * 1024 * 1024,
  maximumReceiptBytes: 2 * 1024 * 1024,
  maximumRetainedDeltaBytes: 32 * 1024 * 1024,
  maximumFinalStateBytes: 32 * 1024 * 1024,
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

function monthFor(archiveOrdinal: number): string {
  const absolute = 2020 * 12 + archiveOrdinal
  return `${Math.floor(absolute / 12)}-${String((absolute % 12) + 1).padStart(2, '0')}`
}

function planFor(archiveOrdinal: number, compressed: Uint8Array = Buffer.from([archiveOrdinal + 1])): CompactV31Plan {
  const sourceSnapshotSha256 = hash('a')
  const benchmarkAuthorizationSha256 = hash('b')
  const month = monthFor(archiveOrdinal)
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
      archiveId: `broadcast-${month}`,
      sourceId: 'lichess-broadcasts',
      sourceManifestSha256: hash('c'),
      licenseSpdxId: 'CC-BY-SA-4.0',
      cutoff: '2026-06-30',
      month,
      filename: `lichess_db_broadcast_${month}.pgn.zst`,
      url: `https://database.lichess.org/broadcast/lichess_db_broadcast_${month}.pgn.zst`,
      compressedBytes: compressed.byteLength,
      sha256: digest(compressed),
      retrievedAt: '2026-08-27T12:00:00.000Z',
      etagObserved: 'fixture',
      lastModifiedObserved: 'Thu, 27 Aug 2026 12:00:00 GMT',
    },
    archiveOrdinal,
    corpusArchiveCount: 78,
    limits,
    partitioning,
    replay,
  })
}

const healthy = async () => ({
  availableStorageBytes: 100 * gib,
  retainedDeltaBytes: 0,
  availableMemoryBytes: 10 * gib,
  workerResidentBytes: 1 * gib,
})

const pgn = `[Event "Rated Classical game"]
[Site "https://lichess.org/fixture01"]
[Date "2026.08.27"]
[Round "1"]
[White "White"]
[Black "Black"]
[Result "1-0"]
[WhiteElo "2100"]
[BlackElo "2050"]
[Variant "Standard"]
[TimeControl "3600+0"]
[GameURL "https://lichess.org/broadcast/fixture/game/1"]

1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 1-0
`

test('fixed sketch overestimates safely and merges deterministically', () => {
  const key = digest('position-key')
  const first = new CompactV31CountMinSketch()
  const second = new CompactV31CountMinSketch()
  first.add(key, 70)
  second.add(key, 30)
  first.merge(second)
  assert.equal(first.estimate(key), 100)
  assert.equal(first.counters.length, COMPACT_V31_SKETCH_WIDTH * COMPACT_V31_SKETCH_DEPTH)
  assert.deepEqual(CompactV31CountMinSketch.fromBytes(first.toBytes()).toBytes(), first.toBytes())
})

test('adaptive eligibility reaches its threshold across reporting months and rating bands', () => {
  const shared = compactV31EligibilityKey({
    kind: 'edge',
    sourceId: 'lichess-broadcasts',
    cohortId: 'cohort_broadcast-classical',
    timeControl: 'classical',
    epd: '8/8/8/8/8/8/8/K6k w - -',
    uci: 'a1a2',
    toEpd: '8/8/8/8/8/8/K7/7k b - -',
  })
  const sketch = new CompactV31CountMinSketch()
  // These counts represent separate month/rating reporting rows. Eligibility
  // deliberately omits those dimensions, so an aggregate N=100 cannot vanish.
  sketch.add(shared, 60)
  sketch.add(shared, 40)
  assert.equal(sketch.estimate(shared), 100)
})

test('resource monitor aborts before a source callback can be reached', async () => {
  const monitor = startCompactV31ResourceMonitor({
    plan: planFor(0),
    observe: async () => ({
      availableStorageBytes: 100 * gib,
      retainedDeltaBytes: 0,
      availableMemoryBytes: 1 * gib,
      workerResidentBytes: 1 * gib,
    }),
    intervalMs: 10,
    now: () => new Date('2026-08-27T12:00:00.000Z'),
  })
  await assert.rejects(monitor.sampleNow(), /insufficient-memory/iu)
  assert.equal(monitor.signal.aborted, true)
  await assert.rejects(monitor.stop(), /insufficient-memory/iu)
})

test('archive emitter preflights before opening an explicit source path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-v31-no-open-'))
  await assert.rejects(emitCompactV31ArchiveDelta({
    plan: planFor(0),
    pass: 'candidate',
    runId: 'fixture-no-open',
    workDirectory: root,
    sourcePath: join(root, 'does-not-exist.zst'),
    previousArchiveDeltaReceiptSha256: null,
    observeResources: async () => ({
      availableStorageBytes: 100 * gib,
      retainedDeltaBytes: 0,
      availableMemoryBytes: 1 * gib,
      workerResidentBytes: 1 * gib,
    }),
    now: () => new Date('2026-08-27T12:00:00.000Z'),
  }), /resource guard aborted: insufficient-memory/iu)
})

test('run bootstrap permits only an authenticated same-run resume and removes its stale staging directory', async () => {
  const work = await mkdtemp(join(tmpdir(), 'linerecall-v31-resume-'))
  const input = {
    workDirectory: work,
    runId: 'fixture-resume',
    plan: planFor(0),
    planReviewSha256: hash('9'),
    now: () => new Date('2026-08-27T12:00:00.000Z'),
  }
  const first = await initializeCompactV31RunDirectory(input)
  assert.equal(first.resumed, false)
  const stale = join(work, 'v31', '.working', 'fixture-resume-candidate-broadcast-2020-01-stale')
  await mkdir(stale, { recursive: true })
  await writeFile(join(stale, 'partial.run'), 'partial')

  const resumed = await initializeCompactV31RunDirectory(input)
  assert.equal(resumed.resumed, true)
  await assert.rejects(lstat(stale), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  await assert.rejects(
    initializeCompactV31RunDirectory({ ...input, planReviewSha256: hash('8') }),
    /does not match this invocation/iu,
  )
})

test('run bootstrap rejects unrecognized or foreign committed resume state', async () => {
  const inputFor = async (suffix: string) => {
    const workDirectory = await mkdtemp(join(tmpdir(), `linerecall-v31-resume-${suffix}-`))
    const input = {
      workDirectory,
      runId: 'fixture-resume',
      plan: planFor(0),
      planReviewSha256: hash('9'),
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    }
    await initializeCompactV31RunDirectory(input)
    return input
  }

  const unknown = await inputFor('unknown')
  await mkdir(join(unknown.workDirectory, 'v31', 'scratch'), { recursive: true })
  await assert.rejects(
    initializeCompactV31RunDirectory(unknown),
    /unrecognized entry/iu,
  )

  const foreign = await inputFor('foreign')
  await mkdir(join(foreign.workDirectory, 'v31', 'deltas', 'another-run'), { recursive: true })
  await assert.rejects(
    initializeCompactV31RunDirectory(foreign),
    /committed state from another run/iu,
  )
})

test('candidate archive replay hashes compressed bytes and commits only immutable deltas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-v31-candidate-'))
  const compressed = zstdCompressSync(Buffer.from(pgn, 'utf8'))
  const source = join(root, 'fixture.pgn.zst')
  await writeFile(source, compressed)
  const work = await mkdtemp(join(tmpdir(), 'linerecall-v31-work-'))
  const result = await emitCompactV31ArchiveDelta({
    plan: planFor(0, compressed),
    pass: 'candidate',
    runId: 'fixture-candidate',
    workDirectory: work,
    sourcePath: source,
    previousArchiveDeltaReceiptSha256: null,
    observeResources: healthy,
    resourceSampleIntervalMs: 60_000,
    maximumOwnerSortEntries: 1,
    now: () => new Date('2026-08-27T12:00:00.000Z'),
  })
  assert.equal(result.receipt.accounting.accepted, 1)
  assert.equal(result.receipt.compressedInput.sha256, digest(compressed))
  assert.ok(result.receipt.partitions.some(({ path }) => path.endsWith('.owners')))
  assert.ok(result.receipt.partitions.some(({ path }) => path.endsWith('.sketch')))
  assert.equal(result.checkpoint.deltaReceiptSha256, result.receiptSha256)
  assert.equal(result.receipt.releaseEligible, false)
  const resumed = await emitCompactV31ArchiveDelta({
    plan: planFor(0, compressed),
    pass: 'candidate',
    runId: 'fixture-candidate',
    workDirectory: work,
    sourcePath: join(root, 'not-opened-on-resume.zst'),
    previousArchiveDeltaReceiptSha256: null,
    observeResources: healthy,
    now: () => new Date('2026-08-27T12:00:00.000Z'),
  })
  assert.equal(resumed.status, 'already-committed')
  assert.equal(resumed.receiptSha256, result.receiptSha256)
})

function exactRow() {
  const row = {
    kind: 'position',
    sourceId: 'lichess-broadcasts' as const,
    cohortId: 'cohort_broadcast-classical',
    month: '2020-01',
    timeControl: 'classical',
    ratingBand: '2000-2199',
    ratingDetail: '',
    epd: '8/8/8/8/8/8/8/K6k w - -',
    minPly: 0,
    n: 1,
    whiteWins: 1,
    draws: 0,
    blackWins: 0,
  } as const
  return {
    ...row,
    keySha256: digest([
      row.kind, row.sourceId, row.cohortId, row.month, row.timeControl,
      row.ratingBand, row.ratingDetail, row.epd, '', '',
    ].join('\0')),
    eligibilityKeySha256: compactV31EligibilityKey(row),
  }
}

test('external exact merge consumes all 78 canonical deltas and reconciles duplicates', async () => {
  const work = await mkdtemp(join(tmpdir(), 'linerecall-v31-merge-'))
  await mkdir(join(work, 'fixture-inputs'))
  const inputs: CompactV31DeltaInput[] = []
  let previous: string | null = null
  for (let archiveOrdinal = 0; archiveOrdinal < 78; archiveOrdinal += 1) {
    const plan = planFor(archiveOrdinal)
    const path = join(work, 'fixture-inputs', `${archiveOrdinal}.jsonl`)
    const rowBytes = Buffer.from(`${JSON.stringify(exactRow())}\n`, 'utf8')
    await writeFile(path, rowBytes)
    const receipt = CompactV31ArchiveDeltaReceiptSchema.parse({
      schemaVersion: 1,
      kind: 'linerecall-compact-v31-archive-delta',
      storageModel: plan.storageModel,
      pipelineVersion: plan.pipelineVersion,
      executionPurpose: plan.executionPurpose,
      releaseEligible: false,
      runId: 'fixture-exact-merge',
      sourceSnapshotSha256: plan.sourceSnapshotSha256,
      configurationSha256: plan.configurationSha256,
      benchmarkAuthorizationSha256: plan.benchmarkAuthorizationSha256,
      archive: plan.archive,
      archiveOrdinal,
      pass: 'exact',
      previousArchiveDeltaReceiptSha256: previous,
      compressedInput: { bytes: plan.archive.compressedBytes, sha256: plan.archive.sha256, verified: true },
      accounting: { recordsSeen: 1, accepted: 1, deduplicated: 0, rejected: {} },
      partitions: [{
        partition: '111',
        path: relativePath(work, path),
        bytes: rowBytes.byteLength,
        sha256: digest(rowBytes),
        firstKeySha256: hash('1'),
        lastKeySha256: hash('1'),
        rowCount: 1,
      }],
      startedAt: '2026-08-27T12:00:00.000Z',
      completedAt: '2026-08-27T12:00:00.000Z',
      hardCapReached: false,
      resources,
    })
    const receiptSha256 = digest(Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8'))
    inputs.push({ receipt, receiptSha256 })
    previous = receiptSha256
  }
  const result = await mergeCompactV31ArchiveDeltas({
    plan: planFor(0),
    pass: 'exact',
    runId: 'fixture-exact-merge',
    workDirectory: work,
    inputs,
    observeResources: healthy,
    resourceSampleIntervalMs: 60_000,
    now: () => new Date('2026-08-27T12:00:00.000Z'),
  })
  assert.equal(result.receipt.inputRows, 78)
  assert.equal(result.receipt.outputRows, 1)
  assert.equal(result.receipt.duplicateRowsMerged, 77)
  assert.deepEqual(result.receipt.ownershipIndexes, [])
  const merged = JSON.parse(await readFile(join(work, ...result.receipt.outputPartitions[0]!.path.split('/')), 'utf8')) as { n: number; whiteWins: number }
  assert.equal(merged.n, 78)
  assert.equal(merged.whiteWins, 78)

  const occupiedDirectory = join(work, 'v31', 'merged', 'fixture-exact-merge', 'candidate')
  const occupiedPath = join(occupiedDirectory, 'aggregate-cap-fixture.bin')
  await mkdir(occupiedDirectory, { recursive: true })
  const occupied = await open(occupiedPath, 'wx')
  await occupied.truncate(limits.maximumFinalStateBytes)
  await occupied.close()
  await assert.rejects(mergeCompactV31ArchiveDeltas({
    plan: planFor(0),
    pass: 'exact',
    runId: 'fixture-exact-merge',
    workDirectory: work,
    inputs,
    observeResources: healthy,
  }), /aggregate final-state cap/iu)
  await rm(occupiedPath)
})

test('candidate merge builds deterministic per-archive ownership indexes for exact replay', async () => {
  const work = await mkdtemp(join(tmpdir(), 'linerecall-v31-owner-merge-'))
  await mkdir(join(work, 'fixture-inputs'))
  const sketch = new CompactV31CountMinSketch().toBytes()
  const sketchPath = join(work, 'fixture-inputs', 'shared.sketch')
  await writeFile(sketchPath, sketch)
  const sketchBounds = [digest('compact-v31-sketch:first'), digest('compact-v31-sketch:last')].sort()
  const inputs: CompactV31DeltaInput[] = []
  let previous: string | null = null
  for (let archiveOrdinal = 0; archiveOrdinal < 78; archiveOrdinal += 1) {
    const plan = planFor(archiveOrdinal)
    const ownerKey = archiveOrdinal === 0
      ? digest('lichess-broadcasts\0url:https://lichess.org/broadcast/fixture/game/1')
      : digest(`fixture-owner-${archiveOrdinal}`)
    const owner = Buffer.alloc(70)
    Buffer.from(ownerKey, 'hex').copy(owner, 0)
    owner.writeUInt16BE(archiveOrdinal, 32)
    owner.writeUInt32BE(0, 34)
    Buffer.from(digest(`guard-${archiveOrdinal}`), 'hex').copy(owner, 38)
    const ownerPath = join(work, 'fixture-inputs', `${archiveOrdinal}.owners`)
    await writeFile(ownerPath, owner)
    const receipt = CompactV31ArchiveDeltaReceiptSchema.parse({
      schemaVersion: 1,
      kind: 'linerecall-compact-v31-archive-delta',
      storageModel: plan.storageModel,
      pipelineVersion: plan.pipelineVersion,
      executionPurpose: plan.executionPurpose,
      releaseEligible: false,
      runId: 'fixture-owner-merge',
      sourceSnapshotSha256: plan.sourceSnapshotSha256,
      configurationSha256: plan.configurationSha256,
      benchmarkAuthorizationSha256: plan.benchmarkAuthorizationSha256,
      archive: plan.archive,
      archiveOrdinal,
      pass: 'candidate',
      previousArchiveDeltaReceiptSha256: previous,
      compressedInput: { bytes: plan.archive.compressedBytes, sha256: plan.archive.sha256, verified: true },
      accounting: { recordsSeen: 1, accepted: 1, deduplicated: 0, rejected: {} },
      partitions: [{
        partition: ownerKey.slice(0, 3),
        path: relativePath(work, ownerPath),
        bytes: owner.byteLength,
        sha256: digest(owner),
        firstKeySha256: ownerKey,
        lastKeySha256: ownerKey,
        rowCount: 1,
      }, {
        partition: 'ffff',
        path: relativePath(work, sketchPath),
        bytes: sketch.byteLength,
        sha256: digest(sketch),
        firstKeySha256: sketchBounds[0]!,
        lastKeySha256: sketchBounds[1]!,
        rowCount: COMPACT_V31_SKETCH_WIDTH * COMPACT_V31_SKETCH_DEPTH,
      }],
      startedAt: '2026-08-27T12:00:00.000Z',
      completedAt: '2026-08-27T12:00:00.000Z',
      hardCapReached: false,
      resources,
    })
    const receiptSha256 = digest(Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8'))
    inputs.push({ receipt, receiptSha256 })
    previous = receiptSha256
  }
  const candidate = await mergeCompactV31ArchiveDeltas({
    plan: planFor(0),
    pass: 'candidate',
    runId: 'fixture-owner-merge',
    workDirectory: work,
    inputs,
    observeResources: healthy,
    resourceSampleIntervalMs: 60_000,
    maximumSortEntries: 2,
    now: () => new Date('2026-08-27T12:00:00.000Z'),
  })
  assert.equal(candidate.receipt.ownershipIndexes.length, 78)
  assert.ok(candidate.receipt.ownershipIndexes.every(({ ownedRecordCount }) => ownedRecordCount === 1))
  assert.equal(candidate.receipt.outputPartitions.at(-1)?.path.endsWith('.sketch'), true)

  const compressed = zstdCompressSync(Buffer.from(pgn, 'utf8'))
  const source = join(work, 'fixture-source.zst')
  await writeFile(source, compressed)
  const exact = await emitCompactV31ArchiveDelta({
    plan: planFor(0, compressed),
    pass: 'exact',
    runId: 'fixture-owner-merge',
    workDirectory: work,
    sourcePath: source,
    previousArchiveDeltaReceiptSha256: null,
    candidateMergeReceipt: candidate.receipt,
    observeResources: healthy,
    resourceSampleIntervalMs: 60_000,
    maximumSortEntries: 2,
    now: () => new Date('2026-08-27T12:00:00.000Z'),
  })
  assert.equal(exact.receipt.accounting.accepted, 1)
  assert.equal(exact.receipt.accounting.deduplicated, 0)
  assert.ok(exact.receipt.partitions.length > 0)
})

function relativePath(root: string, path: string): string {
  return path.slice(root.length + 1).replaceAll('\\', '/')
}

function archiveRefs(prefix: number) {
  return Array.from({ length: 78 }, (_, archiveOrdinal) => ({
    archiveOrdinal,
    archiveId: `broadcast-${monthFor(archiveOrdinal)}`,
    receiptSha256: (prefix + archiveOrdinal).toString(16).padStart(64, '0'),
  }))
}

function mergeReceipt(runId: string, pass: 'candidate' | 'exact') {
  const ownershipIndexes = pass === 'candidate'
    ? Array.from({ length: 78 }, (_, archiveOrdinal) => ({
      archiveOrdinal,
      archiveId: `broadcast-${monthFor(archiveOrdinal)}`,
      ownedRecordCount: 1,
      file: {
        path: `v31/merged/${runId}/candidate/ownership/${archiveOrdinal}.ordinals`,
        bytes: 4,
        sha256: (2_000 + archiveOrdinal).toString(16).padStart(64, '0'),
      },
    }))
    : []
  return CompactV31MergeReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-external-merge',
    storageModel: 'log-structured-external-merge-v3.1',
    pipelineVersion: '3.1.0',
    executionPurpose: 'benchmark-bootstrap',
    releaseEligible: false,
    runId,
    pass,
    sourceSnapshotSha256: hash('a'),
    configurationSha256: planFor(0).configurationSha256,
    inputDeltaReceipts: archiveRefs(pass === 'candidate' ? 1 : 1_000),
    outputPartitions: [{
      partition: '111',
      path: `v31/merged/${runId}/${pass}/${hash(pass === 'candidate' ? 'd' : 'e')}.jsonl`,
      bytes: 10,
      sha256: hash(pass === 'candidate' ? 'd' : 'e'),
      firstKeySha256: hash('1'),
      lastKeySha256: hash('1'),
      rowCount: 1,
    }],
    ownershipIndexes,
    inputRows: 1,
    outputRows: 1,
    duplicateRowsMerged: 0,
    completedAt: '2026-08-27T12:00:00.000Z',
    resources,
  })
}

function runReceipt(runId: string, candidate: ReturnType<typeof mergeReceipt>, exact: ReturnType<typeof mergeReceipt>) {
  const canonical = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return CompactV31RunReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-benchmark-run',
    storageModel: 'log-structured-external-merge-v3.1',
    pipelineVersion: '3.1.0',
    executionPurpose: 'benchmark-bootstrap',
    releaseEligible: false,
    runId,
    sourceSnapshotSha256: hash('a'),
    configurationSha256: planFor(0).configurationSha256,
    benchmarkAuthorizationSha256: hash('b'),
    planReviewSha256: hash('9'),
    cleanWorkDirectory: true,
    sourceArchiveCount: 78,
    publishedGames: 1_146_297,
    candidateDeltaReceipts: archiveRefs(1),
    candidateMergeReceiptSha256: digest(canonical(candidate)),
    exactDeltaReceipts: archiveRefs(1_000),
    exactMergeReceiptSha256: digest(canonical(exact)),
    accountingSha256: hash('f'),
    allArchiveDigestsVerified: true,
    resourceSampleCount: 1,
    maximumObservedWorkerResidentBytes: 1 * gib,
    minimumObservedFreeStorageBytes: 20 * gib,
    startedAt: '2026-08-27T12:00:00.000Z',
    completedAt: '2026-08-27T13:00:00.000Z',
    hardCapReached: false,
  })
}

test('repeatability writer binds two independent byte-identical states and refuses overwrite', async () => {
  const firstCandidate = mergeReceipt('fixture-run-one', 'candidate')
  const firstExact = mergeReceipt('fixture-run-one', 'exact')
  const secondCandidate = mergeReceipt('fixture-run-two', 'candidate')
  const secondExact = mergeReceipt('fixture-run-two', 'exact')
  const firstRun = runReceipt('fixture-run-one', firstCandidate, firstExact)
  const secondRun = runReceipt('fixture-run-two', secondCandidate, secondExact)
  const canonical = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  const root = await mkdtemp(join(tmpdir(), 'linerecall-v31-repeat-'))
  const output = join(root, 'repeatability.json')
  const options = {
    first: { receipt: firstRun, receiptSha256: digest(canonical(firstRun)), path: 'fixture-one.json' },
    second: { receipt: secondRun, receiptSha256: digest(canonical(secondRun)), path: 'fixture-two.json' },
    firstCandidateMerge: firstCandidate,
    firstExactMerge: firstExact,
    secondCandidateMerge: secondCandidate,
    secondExactMerge: secondExact,
    outputPath: output,
    comparedAt: '2026-08-27T14:00:00.000Z',
    maximumBytes: 1_000_000,
  }
  const result = await writeCompactV31RepeatabilityBinding(options)
  assert.equal(result.binding.result, 'byte-identical')
  assert.equal(result.binding.releaseEligible, false)
  await assert.rejects(writeCompactV31RepeatabilityBinding(options), /exist/iu)
})

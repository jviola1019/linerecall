import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import { Chess } from 'chess.js'
import {
  COMPACT_MINIMUM_FREE_RESERVE_BYTES,
  COMPACT_STORAGE_MODEL,
  CompactPreflightPlanSchema,
  type CompactPassReceipt,
  type CompactPreflightPlan,
} from '../../scripts/data/compact-v3-contracts.ts'
import {
  runCompactV3ArchiveAdapter,
  runCompactV3RemoteArchiveAdapter,
} from '../../scripts/data/compact-v3-adapter.ts'
import { approvedCompactCorpusFromBytes } from '../../scripts/data/compact-v3-manifest.ts'

const LONG_LINE = (
  'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 ' +
  'a4b3 d7d6 c2c3 e8g8 h2h3 c6b8 d2d4 b8d7 b1d2 c7c5 d4e5 d6e5 ' +
  'd2f1 c5c4 b3c2 d8c7 f1g3 f8e8 c1g5 h7h6 g5e3 e7f8 d1d2 c7c6 ' +
  'a1d1 a6a5 g3f5 b5b4'
).split(' ')

const bounds = {
  candidateSketchMaxBytes: 128 * 1024,
  candidateIndexMaxBytes: 8 * 1024 * 1024,
  baselineShardMaxBytes: 8 * 1024 * 1024,
  adaptiveShardMaxBytes: 8 * 1024 * 1024,
  exactWorkMaxBytes: 16 * 1024 * 1024,
  checkpointMaxBytes: 256 * 1024,
  atomicPromotionMaxBytes: 16 * 1024 * 1024,
  inputStagingMaxBytes: 0,
  retainedCorpusMaxBytes: 256 * 1024 * 1024,
}
const peakBound = Object.values(bounds).reduce((sum, value) => sum + value, 0)

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function pgn(gameId: string, result: '1-0' | '0-1' | '1/2-1/2' = '1-0', rating = 1600): string {
  const chess = new Chess()
  chess.header(
    'Event', 'rated blitz game',
    'Site', `https://lichess.org/${gameId}`,
    'White', 'Fixture White',
    'Black', 'Fixture Black',
    'WhiteElo', String(rating),
    'BlackElo', String(rating + 20),
    'Result', result,
  )
  for (const uci of LONG_LINE) {
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) })
    if (!move) throw new Error(`Fixture move ${uci} is illegal`)
  }
  return `${chess.pgn({ maxWidth: 512 })}\n`
}

function gameId(value: number): string {
  return `T${String(value).padStart(7, '0')}`
}

function archive(records: readonly string[]): Buffer {
  return zstdCompressSync(Buffer.from(records.join('\n'), 'utf8'))
}

function manifestBytes(
  archives: readonly Buffer[],
  games: readonly [number, number, number] = [61, 41, 1],
): Buffer {
  const months = ['2026-04', '2026-05', '2026-06']
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    source: {
      id: 'lichess-standard-rated-q2-2026',
      name: 'Lichess standard rated games, 2026 Q2',
      databaseUrl: 'https://database.lichess.org/',
      downloadListUrl: 'https://database.lichess.org/standard/list.txt',
      checksumsUrl: 'https://database.lichess.org/standard/sha256sums.txt',
      cutoff: '2026-06-30',
      publishedGameTotal: games.reduce((sum, count) => sum + count, 0),
    },
    license: {
      spdxId: 'CC0-1.0',
      name: 'Creative Commons Zero v1.0 Universal',
      termsUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      sourceStatementUrl: 'https://database.lichess.org/',
      permissions: {
        download: true,
        transform: true,
        redistribute: true,
        attributionRequired: false,
        shareAlikeRequired: false,
      },
    },
    approval: {
      status: 'approved',
      approvedOn: '2026-07-14',
      scope: 'Fixture-only approved manifest shape for local adapter tests.',
      basis: 'Official CC0 source contract represented without a network request.',
      reviewRequiredWhen: 'Any fixture identity changes.',
    },
    filtering: {
      variant: 'Standard only',
      rated: true,
      finishedResults: ['1-0', '0-1', '1/2-1/2'],
      timeControlsIncluded: ['blitz', 'rapid', 'classical'],
      timeControlsExcluded: ['ultraBullet', 'bullet', 'correspondence', 'unknown'],
      botsExcluded: true,
      numericRatingsRequired: true,
      ratingSystemLabel: 'Lichess rating (Glicko-2)',
      deduplication: 'immutable game ID plus corruption guard',
      maximumPly: 30,
    },
    archives: months.map((month, index) => ({
      month,
      filename: `lichess_db_standard_rated_${month}.pgn.zst`,
      url: `https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst`,
      bytes: archives[index]!.byteLength,
      games: games[index],
      sha256: digest(archives[index]!),
      etagObserved: `fixture-etag-${month}`,
      lastModifiedObserved: 'Thu, 16 Jul 2026 12:00:00 GMT',
    })),
    integrity: {
      algorithm: 'SHA-256',
      publisherChecksumsRequired: true,
      verifyByteLengthBeforeParse: true,
      verifyDigestBeforeParse: true,
      failClosed: true,
    },
  })}\n`, 'utf8')
}

function planFor(manifest: Buffer, archiveBytes: Buffer, month: string): CompactPreflightPlan {
  return CompactPreflightPlanSchema.parse({
    schemaVersion: 3,
    storageModel: COMPACT_STORAGE_MODEL,
    archive: {
      archiveId: `standard-${month}`,
      sourceId: 'lichess-standard-rated-q2-2026',
      sourceManifestSha256: digest(manifest),
      licenseSpdxId: 'CC0-1.0',
      cutoff: '2026-06-30',
      month,
      filename: `lichess_db_standard_rated_${month}.pgn.zst`,
      url: `https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst`,
      compressedBytes: archiveBytes.byteLength,
      sha256: digest(archiveBytes),
      retrievedAt: '2026-07-16T12:00:00.000Z',
      etagObserved: `fixture-etag-${month}`,
      lastModifiedObserved: 'Thu, 16 Jul 2026 12:00:00 GMT',
    },
    limits: {
      completeBaselineMaxPly: 30,
      adaptiveEvidenceMaxPly: 100,
      adaptiveCandidateMinimumSample: 100,
      archiveConcurrency: 1,
      minimumFreeReserveBytes: COMPACT_MINIMUM_FREE_RESERVE_BYTES,
      countMinWidth: 8_192,
      countMinDepth: 4,
      maximumCandidates: 10_000,
    },
    bounds,
    benchmark: {
      status: 'approved',
      method: 'complete-broadcast-replay-with-enforced-hard-caps',
      receiptSha256: 'b'.repeat(64),
      measuredAt: '2026-07-16T12:05:00.000Z',
      acceptedGames: 103,
      observations: 8_000,
      peakResidentBytes: 4 * 1024 * 1024,
      peakAdditionalStorageBytes: peakBound,
      note: 'Fixture-only approval used to test the boundary; never valid as corpus evidence.',
    },
  })
}

function broadcastManifestBytes(firstArchive: Buffer): Buffer {
  const archives = []
  let year = 2020
  let month = 1
  while (year < 2026 || (year === 2026 && month <= 6)) {
    const value = `${year}-${String(month).padStart(2, '0')}`
    const filename = `lichess_db_broadcast_${value}.pgn.zst`
    archives.push({
      month: value,
      filename,
      url: `https://database.lichess.org/broadcast/${filename}`,
      sha256: value === '2020-01' ? digest(firstArchive) : createHash('sha256').update(value).digest('hex'),
    })
    month += 1
    if (month === 13) { year += 1; month = 1 }
  }
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-07-11T04:08:37.539Z',
    startMonth: '2020-01',
    cutoffMonth: '2026-06',
    source: {
      listUrl: 'https://database.lichess.org/broadcast/list.txt',
      checksumsUrl: 'https://database.lichess.org/broadcast/sha256sums.txt',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
    approval: {
      status: 'approved',
      approvedOn: '2026-07-11',
      scope: 'Fixture shape for the complete approved broadcast range.',
      basis: 'Official CC BY-SA source contract represented without a network request.',
      reviewRequiredWhen: 'Any fixture identity changes.',
    },
    archives,
  })}\n`, 'utf8')
}

function broadcastPlan(manifest: Buffer, archiveBytes: Buffer): CompactPreflightPlan {
  return CompactPreflightPlanSchema.parse({
    ...planFor(manifest, archiveBytes, '2026-04'),
    archive: {
      archiveId: 'broadcast-2020-01',
      sourceId: 'lichess-broadcasts',
      sourceManifestSha256: digest(manifest),
      licenseSpdxId: 'CC-BY-SA-4.0',
      cutoff: '2026-06-30',
      month: '2020-01',
      filename: 'lichess_db_broadcast_2020-01.pgn.zst',
      url: 'https://database.lichess.org/broadcast/lichess_db_broadcast_2020-01.pgn.zst',
      compressedBytes: archiveBytes.byteLength,
      sha256: digest(archiveBytes),
      retrievedAt: '2026-07-16T12:00:00.000Z',
      etagObserved: 'fixture-etag-broadcast-2020-01',
      lastModifiedObserved: 'Thu, 16 Jul 2026 12:00:00 GMT',
    },
  })
}

const toolchain = {
  node: process.version,
  chessJs: '1.4.0',
  zstd: 'node:zlib:createZstdDecompress',
  sourceSnapshotSha256: 'c'.repeat(64),
}

function fixedClock(): () => Date {
  let second = 0
  return () => new Date(Date.UTC(2026, 6, 16, 13, 0, second++))
}

test('real PGN records feed cumulative candidate and exact SQLite states with cross-archive deduplication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-adapter-'))
  const workDirectory = join(directory, 'work')
  const archiveDirectory = join(directory, 'archives')
  await mkdir(workDirectory)
  await mkdir(archiveDirectory)
  const malformed = '[Event "rated blitz game"]\n\n1. e4 *\n'
  const archives = [
    archive([...Array.from({ length: 60 }, (_, index) => pgn(gameId(index))), malformed]),
    archive([pgn(gameId(0)), ...Array.from({ length: 40 }, (_, index) => pgn(gameId(60 + index)))]),
    archive([pgn(gameId(100), '1/2-1/2', 2050)]),
  ]
  const months = ['2026-04', '2026-05', '2026-06']
  const manifest = manifestBytes(archives)
  const corpus = approvedCompactCorpusFromBytes(manifest, 'lichess-standard-rated-q2-2026')
  const plans = archives.map((bytes, index) => planFor(manifest, bytes, months[index]!))
  const paths: string[] = []
  try {
    for (const [index, bytes] of archives.entries()) {
      const path = join(archiveDirectory, plans[index]!.archive.filename)
      await writeFile(path, bytes)
      paths.push(path)
    }
    const common = {
      corpus,
      workDirectory,
      toolchain,
      availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + peakBound + 1,
      now: fixedClock(),
    }
    const first = await runCompactV3ArchiveAdapter({ ...common, pass: 'candidate', plan: plans[0]!, archivePath: paths[0]! })
    assert.equal(first.receipt.accepted, 60)
    assert.equal(first.receipt.recordsSeen, 61)
    assert.equal(first.receipt.rejected.invalid_result, 1)
    const second = await runCompactV3ArchiveAdapter({ ...common, pass: 'candidate', plan: plans[1]!, archivePath: paths[1]! })
    assert.equal(second.receipt.accepted, 40)
    assert.equal(second.receipt.deduplicated, 1)
    assert.equal(second.receipt.pass, 'candidate')
    assert.equal(second.receipt.priorCandidateStateSha256, first.receipt.output.sha256)

    await assert.rejects(
      runCompactV3ArchiveAdapter({ ...common, pass: 'exact', plan: plans[0]!, archivePath: paths[0]! }),
      /before every candidate archive commits/iu,
    )

    const third = await runCompactV3ArchiveAdapter({ ...common, pass: 'candidate', plan: plans[2]!, archivePath: paths[2]! })
    assert.ok(third.receipt.pass === 'candidate' && third.receipt.candidateRows > 0)
    const resumedFirstCandidate = await runCompactV3ArchiveAdapter({
      ...common,
      pass: 'candidate',
      plan: plans[0]!,
      archivePath: paths[0]!,
    })
    assert.equal(resumedFirstCandidate.status, 'already-committed')
    const candidateDatabase = new DatabaseSync(join(workDirectory, ...third.receipt.output.path.split('/')), { readOnly: true })
    try {
      const counts = candidateDatabase.prepare(`
        SELECT
          (SELECT count(*) FROM compact_adapter_games) AS games,
          (SELECT count(*) FROM compact_adapter_archives) AS archives,
          (SELECT count(*) FROM candidates) AS candidates
      `).get() as { games: number; archives: number; candidates: number }
      assert.deepEqual({ ...counts }, { games: 101, archives: 3, candidates: third.receipt.candidateRows })
      const rows = candidateDatabase.prepare(`
        SELECT archive_id AS archiveId, accepted, deduplicated, rejected_json AS rejectedJson
        FROM compact_adapter_archives ORDER BY archive_index
      `).all() as unknown as Array<{ archiveId: string; accepted: number; deduplicated: number; rejectedJson: string }>
      assert.deepEqual(rows.map(({ archiveId, accepted, deduplicated }) => ({ archiveId, accepted, deduplicated })), [
        { archiveId: 'standard-2026-04', accepted: 60, deduplicated: 0 },
        { archiveId: 'standard-2026-05', accepted: 40, deduplicated: 1 },
        { archiveId: 'standard-2026-06', accepted: 1, deduplicated: 0 },
      ])
    } finally {
      candidateDatabase.close()
    }

    const exactResults = []
    for (const index of [0, 1, 2]) {
      exactResults.push(await runCompactV3ArchiveAdapter({
        ...common,
        pass: 'exact',
        plan: plans[index]!,
        archivePath: paths[index]!,
      }))
    }
    assert.deepEqual(exactResults.map((result) => [result.receipt.accepted, result.receipt.deduplicated]), [
      [60, 0], [40, 1], [1, 0],
    ])
    const exact = exactResults[2]!.receipt
    assert.equal(exact.pass, 'exact')
    assert.ok(exact.completeBaselineObservationsRetained > 0)
    assert.ok(exact.adaptiveCandidateObservationsRetained > 0)
    const exactDatabase = new DatabaseSync(join(workDirectory, ...exact.output.path.split('/')), { readOnly: true })
    try {
      const counts = exactDatabase.prepare(`
        SELECT
          (SELECT count(*) FROM compact_adapter_games) AS games,
          (SELECT count(*) FROM compact_adapter_archives) AS archives,
          (SELECT count(*) FROM positions) AS positions,
          (SELECT count(*) FROM edges) AS edges,
          (SELECT sum(n) FROM outcomes) AS observations
      `).get() as { games: number; archives: number; positions: number; edges: number; observations: number }
      assert.equal(counts.games, 101)
      assert.equal(counts.archives, 3)
      assert.ok(counts.positions > 0 && counts.edges > 0 && counts.observations > 0)
    } finally {
      exactDatabase.close()
    }

    const resumed = await runCompactV3ArchiveAdapter({
      ...common,
      pass: 'exact',
      plan: plans[2]!,
      archivePath: paths[2]!,
    })
    assert.equal(resumed.status, 'already-committed')
    assert.equal(resumed.receipt.output.sha256, exact.output.sha256)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a conflicting cross-archive game rolls back without changing prior state or promoting a checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-adapter-rollback-'))
  const workDirectory = join(directory, 'work')
  const archiveDirectory = join(directory, 'archives')
  await mkdir(workDirectory)
  await mkdir(archiveDirectory)
  const sharedId = 'CONFL001'
  const archives = [
    archive([pgn(sharedId, '1-0', 1600)]),
    archive([pgn(sharedId, '0-1', 1900)]),
    archive([pgn('CONFL002')]),
  ]
  const months = ['2026-04', '2026-05', '2026-06']
  const manifest = manifestBytes(archives, [1, 1, 1])
  const corpus = approvedCompactCorpusFromBytes(manifest, 'lichess-standard-rated-q2-2026')
  const plans = archives.map((bytes, index) => planFor(manifest, bytes, months[index]!))
  try {
    const paths: string[] = []
    for (const [index, bytes] of archives.entries()) {
      const path = join(archiveDirectory, plans[index]!.archive.filename)
      await writeFile(path, bytes)
      paths.push(path)
    }
    const common = {
      corpus,
      workDirectory,
      toolchain,
      availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + peakBound + 1,
      now: fixedClock(),
    }
    const first = await runCompactV3ArchiveAdapter({ ...common, pass: 'candidate', plan: plans[0]!, archivePath: paths[0]! })
    const priorPath = join(workDirectory, ...first.receipt.output.path.split('/'))
    const before = await readFile(priorPath)
    await assert.rejects(
      runCompactV3ArchiveAdapter({ ...common, pass: 'candidate', plan: plans[1]!, archivePath: paths[1]! }),
      /game key conflicts with different content/iu,
    )
    assert.deepEqual(await readFile(priorPath), before)
    await assert.rejects(stat(join(workDirectory, 'v3', 'standard-2026-05', 'checkpoint.json')), { code: 'ENOENT' })
    const state = new DatabaseSync(priorPath, { readOnly: true })
    try {
      const games = state.prepare('SELECT count(*) AS count FROM compact_adapter_games').get() as { count: number }
      assert.equal(games.count, 1)
    } finally {
      state.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the adapter consumes a wrapped broadcast Zstandard frame from the same verified stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-adapter-broadcast-'))
  const workDirectory = join(directory, 'work')
  await mkdir(workDirectory)
  const wrappedFrame = (id: string): Buffer => {
    const rawPgn = Buffer.from(`${pgn(id).replace(
      '[Event ',
      `[Variant "Standard"]\n[GameURL "https://lichess.org/broadcast/fixture/${id}"]\n[Event `,
    )}\n`, 'utf8')
    const frame = zstdCompressSync(rawPgn)
    const wrapper = Buffer.alloc(12)
    wrapper.writeUInt32LE(0x184d2a50, 0)
    wrapper.writeUInt32LE(4, 4)
    wrapper.writeUInt32LE(frame.byteLength, 8)
    return Buffer.concat([wrapper, frame])
  }
  const bytes = Buffer.concat([wrappedFrame('BROAD001'), wrappedFrame('BROAD002')])
  const manifest = broadcastManifestBytes(bytes)
  const plan = broadcastPlan(manifest, bytes)
  const archivePath = join(directory, plan.archive.filename)
  await writeFile(archivePath, bytes)
  try {
    const result = await runCompactV3ArchiveAdapter({
      pass: 'candidate',
      plan,
      corpus: approvedCompactCorpusFromBytes(manifest, 'lichess-broadcasts'),
      archivePath,
      workDirectory,
      toolchain,
      availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + peakBound + 1,
      now: fixedClock(),
    })
    assert.equal(result.receipt.recordsSeen, 2)
    assert.equal(result.receipt.accepted, 2, JSON.stringify(result.receipt.rejected))
    assert.equal(result.receipt.deduplicated, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('pending benchmark preflight blocks before the local archive is opened', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-adapter-preflight-'))
  const first = archive([pgn('PREFL001')])
  const archives = [first, archive([pgn('PREFL002')]), archive([pgn('PREFL003')])]
  const manifest = manifestBytes(archives, [1, 1, 1])
  const approved = planFor(manifest, first, '2026-04')
  const plan = CompactPreflightPlanSchema.parse({
    ...approved,
    benchmark: {
      status: 'pending',
      method: 'complete-broadcast-replay-with-enforced-hard-caps',
      receiptSha256: null,
      measuredAt: null,
      acceptedGames: 0,
      observations: 0,
      peakResidentBytes: 0,
      peakAdditionalStorageBytes: 0,
      note: 'No complete broadcast benchmark has been approved.',
    },
  })
  try {
    await assert.rejects(runCompactV3ArchiveAdapter({
      pass: 'candidate',
      plan,
      corpus: approvedCompactCorpusFromBytes(manifest, 'lichess-standard-rated-q2-2026'),
      archivePath: join(directory, plan.archive.filename),
      workDirectory: directory,
      toolchain,
      availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + peakBound + 1,
    }), /benchmark-not-approved/iu)
    await assert.rejects(runCompactV3ArchiveAdapter({
      pass: 'candidate',
      plan,
      corpus: approvedCompactCorpusFromBytes(manifest, 'lichess-standard-rated-q2-2026'),
      archivePath: join(directory, plan.archive.filename),
      workDirectory: directory,
      toolchain,
      executionPurpose: 'benchmark-bootstrap',
      availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + peakBound + 1,
    }), /complete approved 78-archive broadcast corpus/iu)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('published archive accounting mismatch rolls back without a receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-adapter-accounting-'))
  const first = archive([pgn('COUNT001')])
  const archives = [first, archive([pgn('COUNT002')]), archive([pgn('COUNT003')])]
  const manifest = manifestBytes(archives, [2, 1, 1])
  const plan = planFor(manifest, first, '2026-04')
  const archivePath = join(directory, plan.archive.filename)
  await writeFile(archivePath, first)
  try {
    await assert.rejects(runCompactV3ArchiveAdapter({
      pass: 'candidate',
      plan,
      corpus: approvedCompactCorpusFromBytes(manifest, 'lichess-standard-rated-q2-2026'),
      archivePath,
      workDirectory: directory,
      toolchain,
      availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + peakBound + 1,
      now: fixedClock(),
    }), /published total/iu)
    await assert.rejects(
      stat(join(directory, 'v3', plan.archive.archiveId, 'checkpoint.json')),
      { code: 'ENOENT' },
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a live corpus lock enforces one archive worker across different archive IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-adapter-lock-'))
  const first = archive([pgn('LOCK0001')])
  const archives = [first, archive([pgn('LOCK0002')]), archive([pgn('LOCK0003')])]
  const manifest = manifestBytes(archives, [1, 1, 1])
  const plan = planFor(manifest, first, '2026-04')
  const archivePath = join(directory, plan.archive.filename)
  await writeFile(archivePath, first)
  await mkdir(join(directory, 'v3'))
  const lockPath = join(directory, 'v3', 'adapter-corpus.lock')
  await writeFile(lockPath, `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    hostname: hostname(),
    createdAt: '2026-07-16T12:00:00.000Z',
  })}\n`)
  try {
    await assert.rejects(runCompactV3ArchiveAdapter({
      pass: 'candidate',
      plan,
      corpus: approvedCompactCorpusFromBytes(manifest, 'lichess-standard-rated-q2-2026'),
      archivePath,
      workDirectory: directory,
      toolchain,
      availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + peakBound + 1,
    }), /holds the corpus lock/iu)
    assert.equal((await stat(lockPath)).isFile(), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('candidate and exact passes independently stream and receipt the same approved HTTPS archive identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-adapter-remote-'))
  const archives = [
    archive([pgn('REMOTE01')]),
    archive([pgn('REMOTE02')]),
    archive([pgn('REMOTE03')]),
  ]
  const manifest = manifestBytes(archives, [1, 1, 1])
  const corpus = approvedCompactCorpusFromBytes(manifest, 'lichess-standard-rated-q2-2026')
  const months = ['2026-04', '2026-05', '2026-06']
  const plans = archives.map((bytes, index) => planFor(manifest, bytes, months[index]!))
  const byUrl = new Map(plans.map((plan, index) => [plan.archive.url, archives[index]!]))
  let requests = 0
  try {
    const common = {
      corpus,
      workDirectory: directory,
      toolchain,
      availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + peakBound + 1,
      now: fixedClock(),
      remoteTestSeams: {
        resolver: async () => [{ address: '93.184.216.34', family: 4 as const }],
        transport: async ({ url }: { url: URL }) => {
          requests += 1
          const bytes = byUrl.get(url.href)
          if (!bytes) throw new Error('Fixture received an unapproved archive URL')
          const plan = plans.find((candidate) => candidate.archive.url === url.href)!
          return {
            statusCode: 200,
            headers: {
              'content-length': String(bytes.byteLength),
              etag: plan.archive.etagObserved,
              'last-modified': plan.archive.lastModifiedObserved,
            },
            body: (async function* () {
              const split = Math.floor(bytes.byteLength / 2)
              yield bytes.subarray(0, split)
              yield bytes.subarray(split)
            })(),
            remoteAddress: '93.184.216.34',
            abort() {},
          }
        },
        now: fixedClock(),
      },
    }
    const candidateReceipts: CompactPassReceipt[] = []
    for (const plan of plans) {
      const result = await runCompactV3RemoteArchiveAdapter({
        ...common,
        pass: 'candidate',
        plan,
      })
      candidateReceipts.push(result.receipt)
    }
    const exactReceipts: CompactPassReceipt[] = []
    for (const plan of plans) {
      const result = await runCompactV3RemoteArchiveAdapter({
        ...common,
        pass: 'exact',
        plan,
      })
      exactReceipts.push(result.receipt)
    }
    assert.equal(requests, 6)
    for (const [index, candidate] of candidateReceipts.entries()) {
      const exact = exactReceipts[index]!
      const plan = plans[index]!
      assert.equal(candidate.compressedInput.sha256, plan.archive.sha256)
      assert.equal(exact.compressedInput.sha256, plan.archive.sha256)
      assert.equal(candidate.compressedInput.bytes, exact.compressedInput.bytes)
      assert.equal(candidate.compressedInput.acquisition?.requestedUrl, plan.archive.url)
      assert.equal(exact.compressedInput.acquisition?.requestedUrl, plan.archive.url)
      assert.equal(candidate.compressedInput.acquisition?.transport, 'approved-https')
      assert.equal(exact.compressedInput.acquisition?.transport, 'approved-https')
    }
    await assert.rejects(stat(join(directory, plans[0]!.archive.filename)), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed HTTPS stream leaves no compact checkpoint or promoted receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-adapter-remote-failure-'))
  const archives = [
    archive([pgn('RFAIL001')]),
    archive([pgn('RFAIL002')]),
    archive([pgn('RFAIL003')]),
  ]
  const manifest = manifestBytes(archives, [1, 1, 1])
  const plan = planFor(manifest, archives[0]!, '2026-04')
  try {
    await assert.rejects(runCompactV3RemoteArchiveAdapter({
      pass: 'candidate',
      plan,
      corpus: approvedCompactCorpusFromBytes(manifest, 'lichess-standard-rated-q2-2026'),
      workDirectory: directory,
      toolchain,
      availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + peakBound + 1,
      remoteTestSeams: {
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async () => ({
          statusCode: 200,
          headers: {
            etag: plan.archive.etagObserved,
            'last-modified': plan.archive.lastModifiedObserved,
          },
          body: (async function* () {
            yield archives[0]!.subarray(0, 16)
            throw new Error('fixture connection reset')
          })(),
          remoteAddress: '93.184.216.34',
          abort() {},
        }),
      },
    }), /fixture connection reset/iu)
    await assert.rejects(
      stat(join(directory, 'v3', plan.archive.archiveId, 'checkpoint.json')),
      { code: 'ENOENT' },
    )
    const receipts = join(directory, 'v3', plan.archive.archiveId, 'receipts')
    await assert.rejects(stat(receipts), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

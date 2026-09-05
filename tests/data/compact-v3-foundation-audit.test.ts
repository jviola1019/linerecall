import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  auditCompactV3Foundation,
  validateCompactCheckpointSequence,
} from '../../scripts/data/audit-data-foundation.ts'
import {
  COMPACT_MINIMUM_FREE_RESERVE_BYTES,
  COMPACT_STORAGE_MODEL,
  COMPACT_ADAPTER_STATE_SCHEMA_VERSION,
  CompactPreflightPlanSchema,
  type CompactArchiveCheckpoint,
  type CompactPreflightPlan,
} from '../../scripts/data/compact-v3-contracts.ts'
import type { ApprovedCompactCorpus } from '../../scripts/data/compact-v3-manifest.ts'
import { runCompactArchivePass } from '../../scripts/data/compact-v3-orchestrator.ts'
import {
  compactAdapterConfigurationSha256,
} from '../../scripts/data/compact-v3-adapter.ts'
import {
  compactBenchmarkApprovalRelativePath,
  validateCompactBenchmarkApproval,
} from '../../scripts/data/compact-v3-benchmark-approval.ts'
import { createFixtureBenchmarkApproval } from '../fixtures/compact-benchmark-approval.ts'

const sourceBytes = Buffer.from('compact foundation fixture input\n', 'utf8')
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
const manifestSha256 = 'a'.repeat(64)
const snapshotSha256 = 'b'.repeat(64)
const archive = {
  archiveId: 'standard-2026-04',
  sourceId: 'lichess-standard-rated-q2-2026' as const,
  sourceManifestSha256: manifestSha256,
  licenseSpdxId: 'CC0-1.0' as const,
  cutoff: '2026-06-30',
  month: '2026-04',
  filename: 'lichess_db_standard_rated_2026-04.pgn.zst',
  url: 'https://database.lichess.org/standard/lichess_db_standard_rated_2026-04.pgn.zst',
  compressedBytes: sourceBytes.byteLength,
  sha256: sourceSha256,
  retrievedAt: '2026-07-16T12:00:00.000Z',
  etagObserved: 'fixture-etag',
  lastModifiedObserved: 'Thu, 16 Jul 2026 12:00:00 GMT',
}
const corpus: ApprovedCompactCorpus = {
  sourceId: 'lichess-standard-rated-q2-2026',
  sourceManifestSha256: manifestSha256,
  licenseSpdxId: 'CC0-1.0',
  cutoff: '2026-06-30',
  publishedGameTotal: 4,
  archives: [{
    month: archive.month,
    filename: archive.filename,
    url: archive.url,
    sha256: archive.sha256,
    compressedBytes: archive.compressedBytes,
    etagObserved: archive.etagObserved,
    lastModifiedObserved: archive.lastModifiedObserved,
    publishedGames: 4,
  }],
}
const bounds = {
  candidateSketchMaxBytes: 1024,
  candidateIndexMaxBytes: 1024 * 1024,
  baselineShardMaxBytes: 1024 * 1024,
  adaptiveShardMaxBytes: 1024 * 1024,
  exactWorkMaxBytes: 1024 * 1024,
  checkpointMaxBytes: 256 * 1024,
  atomicPromotionMaxBytes: 1024 * 1024,
  inputStagingMaxBytes: 0,
  retainedCorpusMaxBytes: 16 * 1024 * 1024,
}
const limits = {
  completeBaselineMaxPly: 30 as const,
  adaptiveEvidenceMaxPly: 100 as const,
  adaptiveCandidateMinimumSample: 100 as const,
  archiveConcurrency: 1 as const,
  minimumFreeReserveBytes: COMPACT_MINIMUM_FREE_RESERVE_BYTES,
  countMinWidth: 8,
  countMinDepth: 2,
  maximumCandidates: 1000,
}
const benchmarkApproval = createFixtureBenchmarkApproval({
  limits,
  bounds,
  sourceSnapshotSha256: snapshotSha256,
  acceptedGames: 12,
  observations: 100,
  peakResidentBytes: 1024,
  peakAdditionalStorageBytes: 4096,
})
const plan: CompactPreflightPlan = CompactPreflightPlanSchema.parse({
  schemaVersion: 3,
  storageModel: COMPACT_STORAGE_MODEL,
  archive,
  limits,
  bounds,
  benchmark: benchmarkApproval.proof,
})
const validatedBenchmarkApproval = validateCompactBenchmarkApproval(plan, benchmarkApproval.bytes, snapshotSha256)

async function writePlanEvidence(plansDirectory: string): Promise<void> {
  await mkdir(plansDirectory, { recursive: true })
  await writeFile(join(plansDirectory, `${archive.archiveId}.json`), `${JSON.stringify(plan)}\n`, 'utf8')
  const approvalPath = join(
    plansDirectory,
    ...compactBenchmarkApprovalRelativePath(plan.benchmark.receiptSha256!).split('/'),
  )
  await mkdir(join(approvalPath, '..'), { recursive: true })
  await writeFile(approvalPath, benchmarkApproval.bytes)
}

function clock(): () => Date {
  let tick = 0
  return () => new Date(Date.UTC(2026, 6, 16, 13, 0, tick++))
}

async function writeExactState(path: string, finalCandidateReceiptSha256: string): Promise<Buffer> {
  const database = new DatabaseSync(path)
  try {
    database.exec(`
      PRAGMA user_version = ${COMPACT_ADAPTER_STATE_SCHEMA_VERSION};
      CREATE TABLE compact_adapter_metadata (
        singleton INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, pass TEXT NOT NULL,
        source_manifest_sha256 TEXT NOT NULL, configuration_sha256 TEXT NOT NULL,
        last_archive_id TEXT NOT NULL, last_archive_index INTEGER NOT NULL,
        sketch_snapshot BLOB, final_candidate_receipt_sha256 TEXT
      ) STRICT;
      CREATE TABLE compact_adapter_games (
        game_identity_sha256 BLOB PRIMARY KEY CHECK(length(game_identity_sha256) = 32),
        corruption_guard_sha256 BLOB NOT NULL CHECK(length(corruption_guard_sha256) = 32),
        first_archive_index INTEGER NOT NULL CHECK(first_archive_index >= 0)
      ) WITHOUT ROWID, STRICT;
      CREATE TABLE compact_adapter_archives (
        pass TEXT NOT NULL, archive_id TEXT NOT NULL, archive_index INTEGER NOT NULL,
        source_id TEXT NOT NULL, source_manifest_sha256 TEXT NOT NULL, month TEXT NOT NULL,
        archive_sha256 TEXT NOT NULL, compressed_bytes INTEGER NOT NULL,
        records_seen INTEGER NOT NULL, accepted INTEGER NOT NULL, deduplicated INTEGER NOT NULL,
        rejected_json TEXT NOT NULL, PRIMARY KEY(pass, archive_id)
      ) WITHOUT ROWID, STRICT;
      CREATE TABLE positions (
        position_id INTEGER PRIMARY KEY, fingerprint BLOB NOT NULL UNIQUE CHECK(length(fingerprint) = 32),
        epd TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE edges (
        edge_id INTEGER PRIMARY KEY, fingerprint BLOB NOT NULL UNIQUE CHECK(length(fingerprint) = 32),
        from_position_id INTEGER NOT NULL REFERENCES positions(position_id), uci TEXT NOT NULL,
        san TEXT NOT NULL, to_position_id INTEGER NOT NULL REFERENCES positions(position_id)
      ) STRICT;
      CREATE TABLE outcomes (
        kind TEXT NOT NULL, reference_id INTEGER NOT NULL, cohort_id TEXT NOT NULL,
        month TEXT NOT NULL, time_control TEXT NOT NULL, rating_band TEXT NOT NULL,
        rating_detail TEXT NOT NULL, min_ply INTEGER NOT NULL, n INTEGER NOT NULL,
        white_wins INTEGER NOT NULL, draws INTEGER NOT NULL, black_wins INTEGER NOT NULL,
        PRIMARY KEY(kind, reference_id, cohort_id, month, time_control, rating_band, rating_detail)
      ) WITHOUT ROWID, STRICT;
    `)
    database.prepare(`
      INSERT INTO compact_adapter_metadata VALUES (1,?,'exact',?,? ,?,0,NULL,?)
    `).run(
      COMPACT_ADAPTER_STATE_SCHEMA_VERSION,
      manifestSha256,
      compactAdapterConfigurationSha256(plan, snapshotSha256, 'evidence-candidate'),
      archive.archiveId,
      finalCandidateReceiptSha256,
    )
    for (const byte of [1, 2]) {
      database.prepare('INSERT INTO compact_adapter_games VALUES (?,?,?)')
        .run(Buffer.alloc(32, byte), Buffer.alloc(32, byte + 10), 0)
    }
    database.prepare('INSERT INTO compact_adapter_archives VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'exact', archive.archiveId, 0, archive.sourceId, manifestSha256, archive.month,
      archive.sha256, archive.compressedBytes, 4, 2, 1, JSON.stringify({ malformed_pgn: 1 }),
    )
    database.prepare('INSERT INTO positions VALUES (1,?,?)').run(Buffer.alloc(32, 20), '8/8/8/8/8/8/8/K6k w - -')
    database.prepare('INSERT INTO positions VALUES (2,?,?)').run(Buffer.alloc(32, 21), '8/8/8/8/8/8/1K6/7k b - -')
    database.prepare('INSERT INTO edges VALUES (1,?,?,?,?,?)').run(Buffer.alloc(32, 22), 1, 'a1b2', 'Kb2', 2)
    database.prepare('INSERT INTO outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'position', 1, 'lichess-standard', archive.month, 'blitz', '<1800', '1500-1799', 0, 2, 1, 1, 0,
    )
    database.prepare('INSERT INTO outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'edge', 1, 'lichess-standard', archive.month, 'blitz', '<1800', '1500-1799', 1, 2, 1, 1, 0,
    )
  } finally {
    database.close()
  }
  return readFile(path)
}

async function completeFixture(directory: string): Promise<{ checkpoint: CompactArchiveCheckpoint; outputPath: string }> {
  const common = {
    plan,
    workDirectory: directory,
    openCompressedInput: () => Readable.from([sourceBytes]),
    toolchain: {
      node: '24.4.1', chessJs: '1.4.0', zstd: 'fixture', sourceSnapshotSha256: snapshotSha256,
      adapterStateSchemaVersion: COMPACT_ADAPTER_STATE_SCHEMA_VERSION,
    },
    benchmarkApprovalBytes: benchmarkApproval.bytes,
    outputExtension: 'sqlite',
    availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + 32 * 1024 * 1024,
    now: clock(),
  }
  const candidate = await runCompactArchivePass({
    ...common,
    pass: 'candidate',
    process: async ({ input, output }) => {
      for await (const _chunk of input) { /* consume the exact source stream */ }
      await output.write(Buffer.from('candidate-state', 'utf8'))
      return {
        pass: 'candidate', priorCandidateStateSha256: null,
        recordsSeen: 4, accepted: 2, deduplicated: 1, rejected: { malformed_pgn: 1 },
        adaptiveObservationsSeen: 8, candidateRows: 1,
      }
    },
  })
  const sqlitePath = join(directory, 'exact-fixture.sqlite')
  const exactBytes = await writeExactState(sqlitePath, candidate.receiptSha256)
  const exact = await runCompactArchivePass({
    ...common,
    pass: 'exact',
    process: async ({ input, output }) => {
      for await (const _chunk of input) { /* consume the exact source stream */ }
      await output.write(exactBytes)
      return {
        pass: 'exact', priorExactStateSha256: null, finalCandidateSetReceiptSha256: candidate.receiptSha256,
        recordsSeen: 4, accepted: 2, deduplicated: 1, rejected: { malformed_pgn: 1 },
        completeBaselineObservationsRetained: 4,
        adaptiveCandidateObservationsRetained: 2,
        adaptiveNoncandidateObservationsRejected: 1,
        normalizedPositionRows: 2,
        normalizedEdgeRows: 1,
      }
    },
  })
  return {
    checkpoint: exact.checkpoint,
    outputPath: join(directory, ...exact.receipt.output.path.split('/')),
  }
}

test('compact-v3 foundation accepts only a complete receipt-bound exact state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-foundation-v3-'))
  try {
    const plans = join(directory, 'plans')
    await writePlanEvidence(plans)
    const fixture = await completeFixture(directory)
    const result = await auditCompactV3Foundation({ workDirectory: directory, plansDirectory: plans, corpora: [corpus] })
    assert.equal(result.complete, true)
    assert.equal(result.corpora[0]?.recordsSeen, 4)
    assert.equal(result.corpora[0]?.games, 2)
    assert.equal(result.corpora[0]?.positions, 2)

    const output = await readFile(fixture.outputPath)
    output[0] = output[0]! ^ 0xff
    await writeFile(fixture.outputPath, output)
    await assert.rejects(
      auditCompactV3Foundation({ workDirectory: directory, plansDirectory: plans, corpora: [corpus] }),
      /content-addressed exact shard is corrupt/iu,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('compact-v3 foundation reports absent production passes as incomplete', () => {
  const result = validateCompactCheckpointSequence({
    corpus, plans: [null], checkpoints: [null], benchmarkApprovals: [null],
  })
  assert.equal(result.complete, false)
  assert.deepEqual(result.missing, [
    `plan:${archive.archiveId}`,
    `checkpoint:${archive.archiveId}`,
    `benchmark-approval:${archive.archiveId}`,
  ])
})

test('compact-v3 foundation rejects provisional and source-mismatched evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-foundation-v3-policy-'))
  try {
    const { checkpoint } = await completeFixture(directory)
    const provisional = structuredClone(checkpoint)
    provisional.candidateReceipt!.executionPurpose = 'benchmark-bootstrap'
    assert.throws(
      () => validateCompactCheckpointSequence({
        corpus, plans: [plan], checkpoints: [provisional], benchmarkApprovals: [validatedBenchmarkApproval],
      }),
      /Provisional benchmark receipts/iu,
    )
    const wrongManifest = structuredClone(plan)
    wrongManifest.archive.sourceManifestSha256 = '9'.repeat(64)
    assert.throws(
      () => validateCompactCheckpointSequence({
        corpus, plans: [wrongManifest], checkpoints: [checkpoint], benchmarkApprovals: [validatedBenchmarkApproval],
      }),
      /provenance|approved source manifest/iu,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('compact-v3 foundation rejects same-byte SQLite replacement during inspection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-foundation-v3-identity-'))
  try {
    const plans = join(directory, 'plans')
    await writePlanEvidence(plans)
    await completeFixture(directory)
    await assert.rejects(auditCompactV3Foundation({
      workDirectory: directory,
      plansDirectory: plans,
      corpora: [corpus],
      testHooks: {
        afterFinalDatabaseInspection: async (path) => {
          const replacement = `${path}.replacement`
          const original = `${path}.original`
          await writeFile(replacement, await readFile(path))
          await rename(path, original)
          await rename(replacement, path)
        },
      },
    }), /identity or digest changed during inspection/iu)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

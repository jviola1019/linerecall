import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  statfs,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { Readable } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import {
  CompactArchiveCheckpointSchema,
  CompactPreflightPlanSchema,
  type CompactArchiveCheckpoint,
  type CompactExecutionPurpose,
  type CompactPassReceipt,
  type CompactPreflightPlan,
} from './compact-v3-contracts.ts'
import {
  CompactCandidatePass,
  CompactExactPass,
  SqliteCandidateIndex,
  SqliteCompactExactStore,
  compactReplayObservations,
  assessCompactV3Storage,
  evidenceFingerprint,
  receiptDigest,
} from './compact-v3-foundation.ts'
import {
  readVerifiedCompactCheckpoint,
  runCompactArchivePass,
  compactRetainedStateBytes,
  type CompactArchivePassResult,
  type CompactArtifactSink,
  type CompactToolchainReceipt,
} from './compact-v3-orchestrator.ts'
import {
  DEFAULT_PGN_LIMITS,
  splitPgnStream,
  type PgnRecord,
} from './broadcast-pgn.ts'
import {
  parseBroadcastGraphPgn,
  parseLichessStandardGraphPgn,
  type GraphAcceptedGame,
  type ParseGraphGameResult,
} from './evidence-graph.ts'
import {
  approvedArchiveIndex,
  type ApprovedCompactCorpus,
} from './compact-v3-manifest.ts'
import {
  createApprovedHttpsArchiveInput,
  type ApprovedHttpsArchiveInput,
  type CompactRemoteTestSeams,
} from './compact-v3-remote.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const STATE_SCHEMA_VERSION = 1
const PGN_LIMITS = Object.freeze({
  ...DEFAULT_PGN_LIMITS,
  maxPlies: 1_000,
})

type PassName = 'candidate' | 'exact'

export interface CompactV3AdapterOptions {
  pass: PassName
  plan: CompactPreflightPlan
  corpus: ApprovedCompactCorpus
  archivePath: string
  workDirectory: string
  toolchain: CompactToolchainReceipt
  executionPurpose?: CompactExecutionPurpose
  /** Test seam for the same free-space probe used by the orchestrator. */
  availableBytes?: () => Promise<number>
  now?: () => Date
}

export interface CompactV3RemoteAdapterOptions extends Omit<CompactV3AdapterOptions, 'archivePath'> {
  /** Dependency seams are fixture-only; the command-line path never supplies them. */
  remoteTestSeams?: CompactRemoteTestSeams
}

export interface CompactV3AdapterResult extends CompactArchivePassResult {
  archiveIndex: number
  corpusArchiveCount: number
}

interface PassAccounting {
  recordsSeen: number
  accepted: number
  deduplicated: number
  rejected: Record<string, number>
}

interface ExpectedCandidateAccounting extends PassAccounting {
  archiveId: string
}

interface CandidateStateMetadata {
  lastArchiveId: string
  lastArchiveIndex: number
  sourceManifestSha256: string
  configurationSha256: string
  sketch: Uint8Array
}

interface ExactStateMetadata {
  lastArchiveId: string
  lastArchiveIndex: number
  sourceManifestSha256: string
  configurationSha256: string
  finalCandidateSetReceiptSha256: string
}

interface VerifiedPassState {
  checkpoint: CompactArchiveCheckpoint
  receipt: CompactPassReceipt
  absoluteOutputPath: string
}

interface AdapterLockRecord {
  schemaVersion: 1
  pid: number
  hostname: string
  createdAt: string
}

function executionPurposeFor(options: CompactV3AdapterOptions): CompactExecutionPurpose {
  return options.executionPurpose ?? 'evidence-candidate'
}

function configurationSha256(
  plan: CompactPreflightPlan,
  sourceSnapshotSha256: string,
  executionPurpose: CompactExecutionPurpose,
): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: plan.schemaVersion,
    storageModel: plan.storageModel,
    sourceId: plan.archive.sourceId,
    limits: plan.limits,
    bounds: plan.bounds,
    benchmark: plan.benchmark,
    executionPurpose,
    sourceSnapshotSha256,
  })).digest('hex')
}

function safeIncrement(value: number, field: string): number {
  const next = value + 1
  if (!Number.isSafeInteger(next)) throw new Error(`${field} exceeds the safe integer range`)
  return next
}

function reject(accounting: PassAccounting, reason: string): void {
  accounting.rejected[reason] = safeIncrement(accounting.rejected[reason] ?? 0, `Rejected ${reason}`)
}

function rejectedCount(accounting: PassAccounting): number {
  return Object.values(accounting.rejected).reduce((sum, value) => sum + value, 0)
}

function assertAccounting(accounting: PassAccounting): void {
  if (accounting.recordsSeen !== accounting.accepted + accounting.deduplicated + rejectedCount(accounting)) {
    throw new Error('Compact adapter record accounting does not reconcile')
  }
}

function assertPublishedRecordTotals(
  database: DatabaseSync,
  pass: PassName,
  options: CompactV3AdapterOptions,
  archiveIndex: number,
  accounting: PassAccounting,
): void {
  const approved = options.corpus.archives[archiveIndex]
  if (!approved) throw new Error('Approved archive accounting index is unavailable')
  if (approved.publishedGames !== null && accounting.recordsSeen !== approved.publishedGames) {
    throw new Error(
      `Archive record total does not match the published total: expected ${approved.publishedGames}, received ${accounting.recordsSeen}`,
    )
  }
  if (archiveIndex !== options.corpus.archives.length - 1) return
  const prior = database.prepare(`
    SELECT coalesce(sum(records_seen), 0) AS recordsSeen
    FROM compact_adapter_archives WHERE pass = ?
  `).get(pass) as { recordsSeen: number }
  const corpusRecords = prior.recordsSeen + accounting.recordsSeen
  if (!Number.isSafeInteger(corpusRecords) || corpusRecords !== options.corpus.publishedGameTotal) {
    throw new Error(
      `Corpus record total does not reconcile: expected ${options.corpus.publishedGameTotal}, received ${corpusRecords}`,
    )
  }
}

function checkpointPath(workDirectory: string, archiveId: string): string {
  return join(resolve(workDirectory), 'v3', archiveId, 'checkpoint.json')
}

function artifactPath(workDirectory: string, relativePath: string): string {
  return join(resolve(workDirectory), ...relativePath.split('/'))
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function acquireAdapterLock(workDirectory: string): Promise<() => Promise<void>> {
  const path = join(resolve(workDirectory), 'v3', 'adapter-corpus.lock')
  await mkdir(join(resolve(workDirectory), 'v3'), { recursive: true })
  const record: AdapterLockRecord = {
    schemaVersion: 1,
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  }
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return async () => {
        try {
          const current = await readFile(path)
          if (current.equals(bytes)) await rm(path, { force: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let existing: AdapterLockRecord
      let observed: Buffer
      try {
        const details = await stat(path)
        if (!details.isFile() || details.size > 2_048) throw new Error('invalid lock file')
        observed = await readFile(path)
        existing = JSON.parse(observed.toString('utf8')) as AdapterLockRecord
      } catch {
        throw new Error('Compact adapter corpus lock is corrupt; inspect it before resuming')
      }
      if (
        existing.schemaVersion !== 1 || existing.hostname !== hostname() ||
        processExists(existing.pid)
      ) {
        throw new Error('Another compact-v3 archive pass holds the corpus lock')
      }
      if (!(await readFile(path)).equals(observed!)) {
        throw new Error('Compact adapter corpus lock changed while checking stale ownership')
      }
      await rm(path, { force: true })
    }
  }
  throw new Error('Could not acquire the compact-v3 corpus lock')
}

async function readCheckpointSeed(
  workDirectory: string,
  archiveId: string,
): Promise<CompactArchiveCheckpoint | null> {
  try {
    return CompactArchiveCheckpointSchema.parse(
      JSON.parse(await readFile(checkpointPath(workDirectory, archiveId), 'utf8')) as unknown,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function planForCheckpoint(
  current: CompactPreflightPlan,
  checkpoint: CompactArchiveCheckpoint,
): CompactPreflightPlan {
  return CompactPreflightPlanSchema.parse({ ...current, archive: checkpoint.archive })
}

async function verifiedPassState(
  workDirectory: string,
  currentPlan: CompactPreflightPlan,
  corpus: ApprovedCompactCorpus,
  archiveIndex: number,
  pass: PassName,
  sourceSnapshotSha256: string,
  executionPurpose: CompactExecutionPurpose,
): Promise<VerifiedPassState | null> {
  const approved = corpus.archives[archiveIndex]
  if (!approved) throw new Error(`Approved archive index ${archiveIndex} is out of range`)
  const archiveId = currentPlan.archive.sourceId === 'lichess-broadcasts'
    ? `broadcast-${approved.month}`
    : `standard-${approved.month}`
  const seed = await readCheckpointSeed(workDirectory, archiveId)
  if (!seed) return null
  approvedArchiveIndex(corpus, seed.archive)
  if (
    configurationSha256(planForCheckpoint(currentPlan, seed), sourceSnapshotSha256, executionPurpose) !==
    configurationSha256(currentPlan, sourceSnapshotSha256, executionPurpose)
  ) {
    throw new Error(`Compact archive ${archiveId} used a different approved configuration`)
  }
  const checkpoint = await readVerifiedCompactCheckpoint(
    workDirectory,
    planForCheckpoint(currentPlan, seed),
  )
  if (!checkpoint) return null
  const receipt = pass === 'candidate' ? checkpoint.candidateReceipt : checkpoint.exactReceipt
  if (!receipt || receipt.pass !== pass) return null
  if (receipt.executionPurpose !== executionPurpose) {
    throw new Error(`Compact ${pass} receipt belongs to another execution purpose`)
  }
  if (receipt.archive.archiveId !== archiveId) throw new Error(`Compact ${pass} receipt archive order changed`)
  if (receipt.toolchain.sourceSnapshotSha256 !== sourceSnapshotSha256) {
    throw new Error(`Compact ${pass} receipt belongs to another source snapshot`)
  }
  return {
    checkpoint,
    receipt,
    absoluteOutputPath: artifactPath(workDirectory, receipt.output.path),
  }
}

function candidateAccountingFromFinalState(
  path: string,
  options: CompactV3AdapterOptions,
  archiveIndex: number,
): ExpectedCandidateAccounting {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const metadata = readCandidateMetadata(database)
    const finalApproved = options.corpus.archives.at(-1)
    const finalArchiveId = !finalApproved
      ? ''
      : options.plan.archive.sourceId === 'lichess-broadcasts'
        ? `broadcast-${finalApproved.month}`
        : `standard-${finalApproved.month}`
    if (
      !metadata || metadata.lastArchiveIndex !== options.corpus.archives.length - 1 ||
      metadata.lastArchiveId !== finalArchiveId ||
      metadata.sourceManifestSha256 !== options.corpus.sourceManifestSha256 ||
      metadata.configurationSha256 !== configurationSha256(
        options.plan,
        options.toolchain.sourceSnapshotSha256,
        executionPurposeFor(options),
      )
    ) {
      throw new Error('Final candidate state metadata does not represent the complete approved corpus')
    }
    const totals = database.prepare(`
      SELECT count(*) AS archives, coalesce(sum(records_seen), 0) AS recordsSeen
      FROM compact_adapter_archives WHERE pass = 'candidate'
    `).get() as { archives: number; recordsSeen: number }
    if (
      totals.archives !== options.corpus.archives.length ||
      totals.recordsSeen !== options.corpus.publishedGameTotal
    ) {
      throw new Error('Final candidate state accounting does not reconcile with the approved corpus')
    }
    const approved = options.corpus.archives[archiveIndex]
    if (!approved) throw new Error('Candidate accounting archive index is unavailable')
    const archiveId = options.plan.archive.sourceId === 'lichess-broadcasts'
      ? `broadcast-${approved.month}`
      : `standard-${approved.month}`
    const row = database.prepare(`
      SELECT archive_id AS archiveId, records_seen AS recordsSeen, accepted, deduplicated,
        rejected_json AS rejectedJson
      FROM compact_adapter_archives
      WHERE pass = 'candidate' AND archive_index = ?
    `).get(archiveIndex) as {
      archiveId: string
      recordsSeen: number
      accepted: number
      deduplicated: number
      rejectedJson: string
    } | undefined
    if (!row || row.archiveId !== archiveId) throw new Error('Final candidate state is missing an archive accounting row')
    let rejectedValue: unknown
    try { rejectedValue = JSON.parse(row.rejectedJson) as unknown } catch {
      throw new Error('Final candidate state has malformed rejection accounting')
    }
    if (!rejectedValue || typeof rejectedValue !== 'object' || Array.isArray(rejectedValue)) {
      throw new Error('Final candidate state has malformed rejection accounting')
    }
    const rejected: Record<string, number> = {}
    for (const [reason, count] of Object.entries(rejectedValue)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(reason) || !Number.isSafeInteger(count) || (count as number) < 0) {
        throw new Error('Final candidate state has invalid rejection accounting')
      }
      rejected[reason] = count as number
    }
    const accounting: ExpectedCandidateAccounting = {
      archiveId,
      recordsSeen: row.recordsSeen,
      accepted: row.accepted,
      deduplicated: row.deduplicated,
      rejected,
    }
    assertAccounting(accounting)
    return accounting
  } finally {
    database.close()
  }
}

async function enforcePassOrdering(
  options: CompactV3AdapterOptions,
  archiveIndex: number,
): Promise<{
  prior: VerifiedPassState | null
  finalCandidate: VerifiedPassState | null
  expectedCandidateAccounting: ExpectedCandidateAccounting | null
}> {
  const { corpus, pass, plan, workDirectory } = options
  const currentSeed = await readCheckpointSeed(workDirectory, plan.archive.archiveId)
  if (
    (pass === 'candidate' && currentSeed?.candidateReceipt?.pass === 'candidate') ||
    (pass === 'exact' && currentSeed?.exactReceipt?.pass === 'exact')
  ) {
    const currentReceipt = pass === 'candidate' ? currentSeed.candidateReceipt : currentSeed.exactReceipt
    if (currentReceipt?.toolchain.sourceSnapshotSha256 !== options.toolchain.sourceSnapshotSha256) {
      throw new Error(`Committed ${pass} state belongs to another source snapshot`)
    }
    if (currentReceipt.executionPurpose !== executionPurposeFor(options)) {
      throw new Error(`Committed ${pass} state belongs to another execution purpose`)
    }
    // The orchestrator fully revalidates the current receipt and shard before
    // it returns already-committed. Idempotent resume does not need to reopen
    // every predecessor or reject because later archives also completed.
    return { prior: null, finalCandidate: null, expectedCandidateAccounting: null }
  }
  let prior: VerifiedPassState | null = null
  if (pass === 'candidate') {
    if (archiveIndex > 0) {
      prior = await verifiedPassState(
        workDirectory,
        plan,
        corpus,
        archiveIndex - 1,
        'candidate',
        options.toolchain.sourceSnapshotSha256,
        executionPurposeFor(options),
      )
      if (!prior) {
        throw new Error(`Candidate pass is out of order; archive ${corpus.archives[archiveIndex - 1]!.month} is incomplete`)
      }
    }
    for (let index = archiveIndex + 1; index < corpus.archives.length; index += 1) {
      const approved = corpus.archives[index]!
      const laterId = plan.archive.sourceId === 'lichess-broadcasts'
        ? `broadcast-${approved.month}`
        : `standard-${approved.month}`
      const later = await readCheckpointSeed(workDirectory, laterId)
      if (later?.candidateReceipt) {
        throw new Error('Candidate pass order is inconsistent because a later archive is already committed')
      }
    }
    return { prior, finalCandidate: null, expectedCandidateAccounting: null }
  }

  const finalCandidate = await verifiedPassState(
    workDirectory,
    plan,
    corpus,
    corpus.archives.length - 1,
    'candidate',
    options.toolchain.sourceSnapshotSha256,
    executionPurposeFor(options),
  )
  if (!finalCandidate) {
    throw new Error('Exact pass cannot start before every candidate archive commits')
  }
  const expectedCandidateAccounting = candidateAccountingFromFinalState(
    finalCandidate.absoluteOutputPath,
    options,
    archiveIndex,
  )
  if (archiveIndex > 0) {
    prior = await verifiedPassState(
      workDirectory,
      plan,
      corpus,
      archiveIndex - 1,
      'exact',
      options.toolchain.sourceSnapshotSha256,
      executionPurposeFor(options),
    )
    if (!prior) {
      throw new Error(`Exact pass is out of order; archive ${corpus.archives[archiveIndex - 1]!.month} is incomplete`)
    }
  }
  for (let index = archiveIndex + 1; index < corpus.archives.length; index += 1) {
    const approved = corpus.archives[index]!
    const laterId = plan.archive.sourceId === 'lichess-broadcasts'
      ? `broadcast-${approved.month}`
      : `standard-${approved.month}`
    const later = await readCheckpointSeed(workDirectory, laterId)
    if (later?.exactReceipt) {
      throw new Error('Exact pass order is inconsistent because a later archive is already committed')
    }
  }
  return { prior, finalCandidate, expectedCandidateAccounting }
}

function parserFor(sourceId: CompactPreflightPlan['archive']['sourceId']): (
  pgn: string,
  month: string,
) => ParseGraphGameResult {
  return sourceId === 'lichess-broadcasts' ? parseBroadcastGraphPgn : parseLichessStandardGraphPgn
}

const ZSTD_FRAME_MAGIC = 0xfd2fb528
const ZSTD_SKIPPABLE_MIN = 0x184d2a50
const ZSTD_SKIPPABLE_MAX = 0x184d2a5f

class AsyncByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>
  private current = Buffer.alloc(0)
  private offset = 0
  private ended = false

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  private async refill(): Promise<boolean> {
    while (this.offset >= this.current.byteLength && !this.ended) {
      const next = await this.iterator.next()
      if (next.done) {
        this.ended = true
        return false
      }
      this.current = Buffer.from(next.value)
      this.offset = 0
    }
    return this.offset < this.current.byteLength
  }

  async exact(length: number, allowCleanEnd = false): Promise<Buffer | null> {
    const output = Buffer.allocUnsafe(length)
    let written = 0
    while (written < length) {
      if (!await this.refill()) {
        if (allowCleanEnd && written === 0) return null
        throw new Error('Compressed Zstandard archive ended inside a frame header')
      }
      const available = this.current.byteLength - this.offset
      const count = Math.min(length - written, available)
      this.current.copy(output, written, this.offset, this.offset + count)
      this.offset += count
      written += count
    }
    return output
  }

  async *chunks(length: number): AsyncGenerator<Buffer> {
    let remaining = length
    while (remaining > 0) {
      if (!await this.refill()) throw new Error('Compressed Zstandard frame is truncated')
      const available = this.current.byteLength - this.offset
      const count = Math.min(remaining, available)
      yield this.current.subarray(this.offset, this.offset + count)
      this.offset += count
      remaining -= count
    }
  }

  async *remainder(): AsyncGenerator<Buffer> {
    if (await this.refill()) {
      yield this.current.subarray(this.offset)
      this.offset = this.current.byteLength
    }
    while (!this.ended) {
      const next = await this.iterator.next()
      if (next.done) {
        this.ended = true
        break
      }
      yield Buffer.from(next.value)
    }
  }
}

/**
 * Official broadcast archives place a four-byte compressed-frame length in a
 * Zstandard skippable record before each independent frame. Node's streaming
 * decoder stops after a leading skippable record, so strip and validate those
 * bounded wrappers while still consuming the orchestrator's single verified
 * input iterator. Standard archives beginning with a normal frame pass
 * through unchanged.
 */
async function* decompressZstdFrame(input: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  const compressed = Readable.from(input)
  const decompressor = createZstdDecompress()
  compressed.once('error', (error) => decompressor.destroy(error))
  for await (const chunk of compressed.pipe(decompressor)) yield Buffer.from(chunk)
}

async function* decompressedPgnBytes(input: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = new AsyncByteReader(input)
  let frames = 0
  while (true) {
    const descriptorBytes = await reader.exact(4, true)
    if (descriptorBytes === null) break
    const descriptor = descriptorBytes.readUInt32LE(0)
    if (descriptor === ZSTD_FRAME_MAGIC && frames === 0) {
      async function* rawArchive(): AsyncGenerator<Buffer> {
        yield descriptorBytes!
        yield* reader.remainder()
      }
      yield* decompressZstdFrame(rawArchive())
      return
    }
    if (descriptor < ZSTD_SKIPPABLE_MIN || descriptor > ZSTD_SKIPPABLE_MAX) {
      throw new Error(`Compressed archive contains an unknown Zstandard wrapper after ${frames} frame(s)`)
    }
    if (frames >= 10_000) throw new Error('Compressed archive has an unreasonable Zstandard frame count')
    const wrapper = await reader.exact(8)
    if (!wrapper || wrapper.readUInt32LE(0) !== 4) {
      throw new Error('Broadcast Zstandard wrapper payload must be exactly four bytes')
    }
    const compressedBytes = wrapper.readUInt32LE(4)
    if (compressedBytes < 4) throw new Error('Broadcast Zstandard frame length is invalid')
    const magic = await reader.exact(4)
    if (!magic || magic.readUInt32LE(0) !== ZSTD_FRAME_MAGIC) {
      throw new Error('Broadcast wrapper is not followed by a Zstandard frame')
    }
    async function* wrappedFrame(): AsyncGenerator<Buffer> {
      yield magic!
      yield* reader.chunks(compressedBytes - 4)
    }
    // Node's decoder completes after one independent frame, so each wrapped
    // broadcast frame gets its own bounded decoder and their plaintext is
    // concatenated for the PGN record splitter.
    yield* decompressZstdFrame(wrappedFrame())
    frames = safeIncrement(frames, 'Zstandard frames')
  }
  if (frames === 0) throw new Error('Compressed archive contains no Zstandard frame')
}

function pgnRecords(input: AsyncIterable<Uint8Array>): AsyncIterable<PgnRecord> {
  return splitPgnStream(Readable.from(decompressedPgnBytes(input)), PGN_LIMITS)
}

async function streamFileToSink(path: string, sink: CompactArtifactSink): Promise<void> {
  for await (const chunk of createReadStream(path)) await sink.write(Buffer.from(chunk))
}

function createAdapterTables(database: DatabaseSync, pass: PassName): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS compact_adapter_metadata (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      schema_version INTEGER NOT NULL CHECK(schema_version = ${STATE_SCHEMA_VERSION}),
      pass TEXT NOT NULL CHECK(pass IN ('candidate', 'exact')),
      source_manifest_sha256 TEXT NOT NULL CHECK(length(source_manifest_sha256) = 64),
      configuration_sha256 TEXT NOT NULL CHECK(length(configuration_sha256) = 64),
      last_archive_id TEXT NOT NULL,
      last_archive_index INTEGER NOT NULL CHECK(last_archive_index >= 0),
      sketch_snapshot BLOB,
      final_candidate_receipt_sha256 TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS compact_adapter_games (
      source_id TEXT NOT NULL,
      deduplication_key TEXT NOT NULL,
      corruption_guard_sha256 TEXT NOT NULL CHECK(length(corruption_guard_sha256) = 64),
      first_archive_id TEXT NOT NULL,
      PRIMARY KEY(source_id, deduplication_key)
    ) WITHOUT ROWID, STRICT;
    CREATE TABLE IF NOT EXISTS compact_adapter_archives (
      pass TEXT NOT NULL CHECK(pass IN ('candidate', 'exact')),
      archive_id TEXT NOT NULL,
      archive_index INTEGER NOT NULL CHECK(archive_index >= 0),
      source_id TEXT NOT NULL,
      source_manifest_sha256 TEXT NOT NULL CHECK(length(source_manifest_sha256) = 64),
      month TEXT NOT NULL,
      archive_sha256 TEXT NOT NULL CHECK(length(archive_sha256) = 64),
      compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes > 0),
      records_seen INTEGER NOT NULL CHECK(records_seen >= 0),
      accepted INTEGER NOT NULL CHECK(accepted >= 0),
      deduplicated INTEGER NOT NULL CHECK(deduplicated >= 0),
      rejected_json TEXT NOT NULL,
      PRIMARY KEY(pass, archive_id),
      UNIQUE(pass, archive_index)
    ) WITHOUT ROWID, STRICT;
  `)
  const existing = database.prepare('SELECT pass FROM compact_adapter_metadata WHERE singleton = 1').get() as
    | { pass: PassName }
    | undefined
  if (existing && existing.pass !== pass) throw new Error('Compact adapter state belongs to another pass')
}

function readCandidateMetadata(database: DatabaseSync): CandidateStateMetadata | null {
  const row = database.prepare(`
    SELECT last_archive_id AS lastArchiveId, last_archive_index AS lastArchiveIndex,
      source_manifest_sha256 AS sourceManifestSha256, configuration_sha256 AS configurationSha256,
      sketch_snapshot AS sketch
    FROM compact_adapter_metadata WHERE singleton = 1 AND pass = 'candidate'
  `).get() as CandidateStateMetadata | undefined
  return row ?? null
}

function readExactMetadata(database: DatabaseSync): ExactStateMetadata | null {
  const row = database.prepare(`
    SELECT last_archive_id AS lastArchiveId, last_archive_index AS lastArchiveIndex,
      source_manifest_sha256 AS sourceManifestSha256, configuration_sha256 AS configurationSha256,
      final_candidate_receipt_sha256 AS finalCandidateSetReceiptSha256
    FROM compact_adapter_metadata WHERE singleton = 1 AND pass = 'exact'
  `).get() as ExactStateMetadata | undefined
  return row ?? null
}

function assertPriorMetadata(
  metadata: Pick<CandidateStateMetadata, 'lastArchiveId' | 'lastArchiveIndex' | 'sourceManifestSha256' | 'configurationSha256'> | null,
  options: CompactV3AdapterOptions,
  archiveIndex: number,
  prior: VerifiedPassState | null,
): void {
  if (archiveIndex === 0) {
    if (metadata !== null || prior !== null) throw new Error('First compact archive cannot inherit prior state')
    return
  }
  if (
    !metadata || !prior || metadata.lastArchiveIndex !== archiveIndex - 1 ||
    metadata.lastArchiveId !== prior.receipt.archive.archiveId ||
    metadata.sourceManifestSha256 !== options.corpus.sourceManifestSha256 ||
    metadata.configurationSha256 !== configurationSha256(
      options.plan,
      options.toolchain.sourceSnapshotSha256,
      executionPurposeFor(options),
    )
  ) {
    throw new Error('Compact prior state metadata does not match the committed preceding archive')
  }
}

function assertPriorArchiveRows(database: DatabaseSync, pass: PassName, archiveIndex: number): void {
  const row = database.prepare(`
    SELECT count(*) AS count, coalesce(max(archive_index), -1) AS maximumIndex
    FROM compact_adapter_archives WHERE pass = ?
  `).get(pass) as { count: number; maximumIndex: number }
  if (row.count !== archiveIndex || row.maximumIndex !== archiveIndex - 1) {
    throw new Error(`Compact ${pass} state does not contain the complete canonical archive prefix`)
  }
}

function insertAcceptedGame(
  database: DatabaseSync,
  archiveId: string,
  game: GraphAcceptedGame,
): boolean {
  const existing = database.prepare(`
    SELECT corruption_guard_sha256 AS corruptionGuardSha256
    FROM compact_adapter_games WHERE source_id = ? AND deduplication_key = ?
  `).get(game.sourceId, game.deduplicationKey) as { corruptionGuardSha256: string } | undefined
  if (existing) {
    if (existing.corruptionGuardSha256 !== game.corruptionGuardSha256) {
      throw new Error(`Cross-archive game key conflicts with different content: ${game.deduplicationKey}`)
    }
    return false
  }
  database.prepare(`
    INSERT INTO compact_adapter_games(
      source_id, deduplication_key, corruption_guard_sha256, first_archive_id
    ) VALUES (?, ?, ?, ?)
  `).run(game.sourceId, game.deduplicationKey, game.corruptionGuardSha256, archiveId)
  return true
}

function storeArchiveAccounting(
  database: DatabaseSync,
  pass: PassName,
  options: CompactV3AdapterOptions,
  archiveIndex: number,
  accounting: PassAccounting,
): void {
  assertAccounting(accounting)
  database.prepare(`
    INSERT INTO compact_adapter_archives(
      pass, archive_id, archive_index, source_id, source_manifest_sha256, month,
      archive_sha256, compressed_bytes, records_seen, accepted, deduplicated, rejected_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pass,
    options.plan.archive.archiveId,
    archiveIndex,
    options.plan.archive.sourceId,
    options.plan.archive.sourceManifestSha256,
    options.plan.archive.month,
    options.plan.archive.sha256,
    options.plan.archive.compressedBytes,
    accounting.recordsSeen,
    accounting.accepted,
    accounting.deduplicated,
    JSON.stringify(accounting.rejected),
  )
}

async function checkedStateBytes(path: string, maximumBytes: number, label: string): Promise<number> {
  const details = await stat(path)
  if (!details.isFile() || details.size < 1) throw new Error(`${label} state is not a nonempty regular file`)
  if (details.size > maximumBytes) throw new Error(`${label} state exceeds its ${maximumBytes}-byte hard cap`)
  for (const suffix of ['-wal', '-shm']) {
    try {
      const sidecar = await stat(`${path}${suffix}`)
      if (sidecar.size > 0) throw new Error(`${label} state retained an uncheckpointed SQLite ${suffix} file`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return details.size
}

function writeCandidateMetadata(
  database: DatabaseSync,
  options: CompactV3AdapterOptions,
  archiveIndex: number,
  sketch: Uint8Array,
): void {
  database.prepare(`
    INSERT OR REPLACE INTO compact_adapter_metadata(
      singleton, schema_version, pass, source_manifest_sha256, configuration_sha256,
      last_archive_id, last_archive_index, sketch_snapshot, final_candidate_receipt_sha256
    ) VALUES (1, ?, 'candidate', ?, ?, ?, ?, ?, NULL)
  `).run(
    STATE_SCHEMA_VERSION,
    options.corpus.sourceManifestSha256,
    configurationSha256(
      options.plan,
      options.toolchain.sourceSnapshotSha256,
      executionPurposeFor(options),
    ),
    options.plan.archive.archiveId,
    archiveIndex,
    Buffer.from(sketch),
  )
}

function writeExactMetadata(
  database: DatabaseSync,
  options: CompactV3AdapterOptions,
  archiveIndex: number,
  finalCandidateSetReceiptSha256: string,
): void {
  database.prepare(`
    INSERT OR REPLACE INTO compact_adapter_metadata(
      singleton, schema_version, pass, source_manifest_sha256, configuration_sha256,
      last_archive_id, last_archive_index, sketch_snapshot, final_candidate_receipt_sha256
    ) VALUES (1, ?, 'exact', ?, ?, ?, ?, NULL, ?)
  `).run(
    STATE_SCHEMA_VERSION,
    options.corpus.sourceManifestSha256,
    configurationSha256(
      options.plan,
      options.toolchain.sourceSnapshotSha256,
      executionPurposeFor(options),
    ),
    options.plan.archive.archiveId,
    archiveIndex,
    finalCandidateSetReceiptSha256,
  )
}

function candidateLookup(path: string): { has(fingerprint: string, cohortId: string): boolean; close(): void } {
  const database = new DatabaseSync(path, { readOnly: true })
  const statement = database.prepare(
    'SELECT 1 AS found FROM candidates WHERE fingerprint = ? AND cohort_id = ?',
  )
  return {
    has(fingerprint, cohortId) {
      if (!SHA256.test(fingerprint)) throw new Error('Candidate fingerprint is invalid')
      return statement.get(fingerprint, cohortId) !== undefined
    },
    close() { database.close() },
  }
}

async function prepareWorkingState(
  workDirectory: string,
  archiveId: string,
  pass: PassName,
  prior: VerifiedPassState | null,
): Promise<string> {
  const directory = join(resolve(workDirectory), 'v3', '.adapter-working')
  await mkdir(directory, { recursive: true })
  const prefix = `${archiveId}.${pass}.`
  for (const entry of await readdir(directory)) {
    if (entry.startsWith(prefix) && /\.sqlite(?:-wal|-shm)?$/u.test(entry)) {
      await rm(join(directory, entry), { force: true })
    }
  }
  const path = join(directory, `${archiveId}.${pass}.${process.pid}.sqlite`)
  if (prior) await copyFile(prior.absoluteOutputPath, path)
  return path
}

async function processCandidate(
  options: CompactV3AdapterOptions,
  archiveIndex: number,
  prior: VerifiedPassState | null,
  context: { input: AsyncIterable<Uint8Array>; output: CompactArtifactSink },
): Promise<import('./compact-v3-orchestrator.ts').CompactCandidatePassSummary> {
  const workingPath = await prepareWorkingState(
    options.workDirectory,
    options.plan.archive.archiveId,
    'candidate',
    prior,
  )
  const accounting: PassAccounting = { recordsSeen: 0, accepted: 0, deduplicated: 0, rejected: {} }
  let index: SqliteCandidateIndex | null = null
  let candidatePass: CompactCandidatePass | null = null
  let active = false
  try {
    index = new SqliteCandidateIndex(workingPath, options.plan.limits.maximumCandidates)
    createAdapterTables(index.database, 'candidate')
    const metadata = readCandidateMetadata(index.database)
    assertPriorMetadata(metadata, options, archiveIndex, prior)
    assertPriorArchiveRows(index.database, 'candidate', archiveIndex)
    candidatePass = new CompactCandidatePass(
      index,
      options.plan.limits.countMinWidth,
      options.plan.limits.countMinDepth,
      metadata?.sketch,
    )
    candidatePass.beginArchive()
    active = true
    const parse = parserFor(options.plan.archive.sourceId)
    let adaptiveObservationsSeen = 0
    for await (const record of pgnRecords(context.input)) {
      accounting.recordsSeen = safeIncrement(accounting.recordsSeen, 'Records seen')
      if (record.rejection || record.pgn === null) {
        reject(accounting, record.rejection ?? 'record_too_large')
        continue
      }
      const parsed = parse(record.pgn, options.plan.archive.month)
      if (!parsed.accepted) {
        reject(accounting, parsed.reason)
        continue
      }
      if (!insertAcceptedGame(index.database, options.plan.archive.archiveId, parsed.game)) {
        accounting.deduplicated = safeIncrement(accounting.deduplicated, 'Deduplicated games')
        continue
      }
      accounting.accepted = safeIncrement(accounting.accepted, 'Accepted games')
      for (const observation of compactReplayObservations(parsed.game.moves)) {
        candidatePass.observe({
          identity: observation.identity,
          cohortId: parsed.game.cohortId,
          ply: observation.ply,
        })
        if (observation.ply > options.plan.limits.completeBaselineMaxPly) {
          adaptiveObservationsSeen = safeIncrement(adaptiveObservationsSeen, 'Adaptive observations')
        }
      }
    }
    assertAccounting(accounting)
    assertPublishedRecordTotals(index.database, 'candidate', options, archiveIndex, accounting)
    const snapshot = candidatePass.commitArchive()
    active = false
    if (snapshot.byteLength - 12 > options.plan.bounds.candidateSketchMaxBytes) {
      throw new Error('Candidate sketch snapshot exceeds its hard cap')
    }
    index.database.exec('BEGIN IMMEDIATE')
    try {
      storeArchiveAccounting(index.database, 'candidate', options, archiveIndex, accounting)
      writeCandidateMetadata(index.database, options, archiveIndex, snapshot)
      index.database.exec('COMMIT')
    } catch (error) {
      index.database.exec('ROLLBACK')
      throw error
    }
    const candidateRows = (index.database.prepare('SELECT count(*) AS count FROM candidates').get() as { count: number }).count
    index.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    index.close()
    index = null
    await checkedStateBytes(workingPath, options.plan.bounds.candidateIndexMaxBytes, 'Candidate')
    await streamFileToSink(workingPath, context.output)
    return {
      pass: 'candidate',
      priorCandidateStateSha256: prior?.receipt.output.sha256 ?? null,
      ...accounting,
      adaptiveObservationsSeen,
      candidateRows,
    }
  } catch (error) {
    if (active && candidatePass) candidatePass.rollbackArchive()
    throw error
  } finally {
    index?.close()
    await rm(workingPath, { force: true })
    await rm(`${workingPath}-wal`, { force: true })
    await rm(`${workingPath}-shm`, { force: true })
  }
}

async function processExact(
  options: CompactV3AdapterOptions,
  archiveIndex: number,
  prior: VerifiedPassState | null,
  finalCandidate: VerifiedPassState,
  expectedCandidateAccounting: ExpectedCandidateAccounting,
  context: { input: AsyncIterable<Uint8Array>; output: CompactArtifactSink },
): Promise<import('./compact-v3-orchestrator.ts').CompactExactPassSummary> {
  if (finalCandidate.receipt.pass !== 'candidate') throw new Error('Final candidate receipt has the wrong pass')
  const finalCandidateReceiptSha256 = receiptDigest(finalCandidate.receipt)
  const workingPath = await prepareWorkingState(
    options.workDirectory,
    options.plan.archive.archiveId,
    'exact',
    prior,
  )
  const accounting: PassAccounting = { recordsSeen: 0, accepted: 0, deduplicated: 0, rejected: {} }
  const lookup = candidateLookup(finalCandidate.absoluteOutputPath)
  let store: SqliteCompactExactStore | null = null
  let exactPass: CompactExactPass | null = null
  let active = false
  try {
    store = new SqliteCompactExactStore(workingPath)
    createAdapterTables(store.database, 'exact')
    const metadata = readExactMetadata(store.database)
    assertPriorMetadata(metadata, options, archiveIndex, prior)
    assertPriorArchiveRows(store.database, 'exact', archiveIndex)
    if (metadata && metadata.finalCandidateSetReceiptSha256 !== finalCandidateReceiptSha256) {
      throw new Error('Exact state was built against another final candidate set')
    }
    exactPass = new CompactExactPass(store, lookup)
    exactPass.beginArchive()
    active = true
    const parse = parserFor(options.plan.archive.sourceId)
    for await (const record of pgnRecords(context.input)) {
      accounting.recordsSeen = safeIncrement(accounting.recordsSeen, 'Records seen')
      if (record.rejection || record.pgn === null) {
        reject(accounting, record.rejection ?? 'record_too_large')
        continue
      }
      const parsed = parse(record.pgn, options.plan.archive.month)
      if (!parsed.accepted) {
        reject(accounting, parsed.reason)
        continue
      }
      if (!insertAcceptedGame(store.database, options.plan.archive.archiveId, parsed.game)) {
        accounting.deduplicated = safeIncrement(accounting.deduplicated, 'Deduplicated games')
        continue
      }
      accounting.accepted = safeIncrement(accounting.accepted, 'Accepted games')
      for (const observation of compactReplayObservations(parsed.game.moves)) {
        exactPass.observe({
          identity: observation.identity,
          cohortId: parsed.game.cohortId,
          ply: observation.ply,
          month: parsed.game.month,
          timeControl: parsed.game.timeControl,
          ratingBand: parsed.game.ratingBand,
          ratingDetail: parsed.game.ratingDetail ?? '',
          result: parsed.game.result,
          ...(observation.san ? { san: observation.san } : {}),
        })
      }
    }
    assertAccounting(accounting)
    assertPublishedRecordTotals(store.database, 'exact', options, archiveIndex, accounting)
    if (
      expectedCandidateAccounting.archiveId !== options.plan.archive.archiveId ||
      expectedCandidateAccounting.recordsSeen !== accounting.recordsSeen ||
      expectedCandidateAccounting.accepted !== accounting.accepted ||
      expectedCandidateAccounting.deduplicated !== accounting.deduplicated ||
      JSON.stringify(expectedCandidateAccounting.rejected) !== JSON.stringify(accounting.rejected)
    ) {
      throw new Error('Exact replay accounting does not reconcile with the committed candidate pass')
    }
    const totals = exactPass.commitArchive()
    active = false
    store.database.exec('BEGIN IMMEDIATE')
    try {
      storeArchiveAccounting(store.database, 'exact', options, archiveIndex, accounting)
      writeExactMetadata(store.database, options, archiveIndex, finalCandidateReceiptSha256)
      store.database.exec('COMMIT')
    } catch (error) {
      store.database.exec('ROLLBACK')
      throw error
    }
    const normalizedPositionRows = (store.database.prepare('SELECT count(*) AS count FROM positions').get() as { count: number }).count
    const normalizedEdgeRows = (store.database.prepare('SELECT count(*) AS count FROM edges').get() as { count: number }).count
    store.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    store.close()
    store = null
    const shardBudget = options.plan.bounds.baselineShardMaxBytes + options.plan.bounds.adaptiveShardMaxBytes
    if (!Number.isSafeInteger(shardBudget)) throw new Error('Combined exact shard cap exceeds the safe integer range')
    await checkedStateBytes(
      workingPath,
      Math.min(options.plan.bounds.exactWorkMaxBytes, shardBudget),
      'Exact',
    )
    await streamFileToSink(workingPath, context.output)
    return {
      pass: 'exact',
      finalCandidateSetReceiptSha256: finalCandidateReceiptSha256,
      ...accounting,
      completeBaselineObservationsRetained: totals.completeBaselineObservationsRetained,
      adaptiveCandidateObservationsRetained: totals.adaptiveCandidateObservationsRetained,
      adaptiveNoncandidateObservationsRejected: totals.adaptiveNoncandidateObservationsRejected,
      normalizedPositionRows,
      normalizedEdgeRows,
    }
  } catch (error) {
    if (active && exactPass) exactPass.rollbackArchive()
    throw error
  } finally {
    store?.close()
    lookup.close()
    await rm(workingPath, { force: true })
    await rm(`${workingPath}-wal`, { force: true })
    await rm(`${workingPath}-shm`, { force: true })
  }
}

async function assertLocalArchiveShape(options: CompactV3AdapterOptions): Promise<void> {
  const path = resolve(options.archivePath)
  const details = await stat(path)
  if (!details.isFile() || details.size !== options.plan.archive.compressedBytes) {
    throw new Error('Local compact archive byte length does not match the approved plan')
  }
  // The orchestrator hashes this exact stream while it is parsed and refuses
  // promotion on a digest mismatch. Avoid a redundant full archive read here.
}

async function preflightBeforeInput(options: CompactV3AdapterOptions): Promise<void> {
  let availableBytes: number
  if (options.availableBytes) {
    availableBytes = await options.availableBytes()
  } else {
    const filesystem = await statfs(options.workDirectory, { bigint: true })
    const available = filesystem.bavail * filesystem.bsize
    if (available > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Available storage exceeds the safe integer range')
    }
    availableBytes = Number(available)
  }
  const assessment = assessCompactV3Storage(options.plan, availableBytes, {
    executionPurpose: executionPurposeFor(options),
    retainedBytesAlreadyPresent: await compactRetainedStateBytes(options.workDirectory),
  })
  if (!assessment.safeToStart) {
    throw new Error(`Compact v3 preflight blocked: ${assessment.reasonCode}`)
  }
}

async function runAdapterWithInput(
  options: CompactV3AdapterOptions,
  archiveIndex: number,
  openCompressedInput: () => AsyncIterable<Uint8Array>,
  remoteInputAcquisition?: () => import('./compact-v3-contracts.ts').CompactRemoteInputAcquisition,
): Promise<CompactV3AdapterResult> {
  await preflightBeforeInput(options)
  const releaseAdapterLock = await acquireAdapterLock(options.workDirectory)
  try {
    const ordering = await enforcePassOrdering(options, archiveIndex)
    const result = await runCompactArchivePass({
      plan: options.plan,
      pass: options.pass,
      workDirectory: options.workDirectory,
      openCompressedInput,
      ...(remoteInputAcquisition ? { remoteInputAcquisition } : {}),
      outputExtension: 'sqlite',
      toolchain: options.toolchain,
      executionPurpose: executionPurposeFor(options),
      ...(options.availableBytes ? { availableBytes: options.availableBytes } : {}),
      ...(options.now ? { now: options.now } : {}),
      process: options.pass === 'candidate'
        ? (context) => processCandidate(options, archiveIndex, ordering.prior, context)
        : (context) => processExact(
            options,
            archiveIndex,
            ordering.prior,
            ordering.finalCandidate!,
            ordering.expectedCandidateAccounting!,
            context,
          ),
    })
    return { ...result, archiveIndex, corpusArchiveCount: options.corpus.archives.length }
  } finally {
    await releaseAdapterLock()
  }
}

/**
 * Process exactly one already-local archive and one pass. No code path fetches
 * or deletes source input, and all mutable work remains under workDirectory/v3.
 */
export async function runCompactV3ArchiveAdapter(
  optionsValue: CompactV3AdapterOptions,
): Promise<CompactV3AdapterResult> {
  const plan = CompactPreflightPlanSchema.parse(optionsValue.plan)
  const options: CompactV3AdapterOptions = {
    ...optionsValue,
    plan,
    archivePath: resolve(optionsValue.archivePath),
    workDirectory: resolve(optionsValue.workDirectory),
    executionPurpose: optionsValue.executionPurpose ?? 'evidence-candidate',
  }
  if (!SHA256.test(options.toolchain.sourceSnapshotSha256)) {
    throw new Error('Toolchain source snapshot must be a SHA-256 digest')
  }
  const archiveIndex = approvedArchiveIndex(options.corpus, plan.archive)
  if (options.executionPurpose === 'benchmark-bootstrap' && (
    options.corpus.sourceId !== 'lichess-broadcasts' ||
    options.corpus.archives.length !== 78 ||
    options.corpus.publishedGameTotal !== 1_146_297
  )) {
    throw new Error('Benchmark bootstrap is restricted to the complete approved 78-archive broadcast corpus')
  }
  // Preserve fail-closed ordering: an unsafe plan is rejected before even the
  // local source path is opened or statted.
  await preflightBeforeInput(options)
  await assertLocalArchiveShape(options)
  return runAdapterWithInput(options, archiveIndex, () => createReadStream(options.archivePath))
}

/**
 * Stream one archive directly from its exact manifest-approved HTTPS URL.
 * Nothing is staged as a source file; candidate and exact passes each obtain a
 * new stream and are independently byte/digest verified by the orchestrator.
 */
export async function runCompactV3RemoteArchiveAdapter(
  optionsValue: CompactV3RemoteAdapterOptions,
): Promise<CompactV3AdapterResult> {
  const plan = CompactPreflightPlanSchema.parse(optionsValue.plan)
  const options: CompactV3AdapterOptions = {
    ...optionsValue,
    plan,
    archivePath: '<approved-https-stream>',
    workDirectory: resolve(optionsValue.workDirectory),
    executionPurpose: optionsValue.executionPurpose ?? 'evidence-candidate',
  }
  if (!SHA256.test(options.toolchain.sourceSnapshotSha256)) {
    throw new Error('Toolchain source snapshot must be a SHA-256 digest')
  }
  const archiveIndex = approvedArchiveIndex(options.corpus, plan.archive)
  if (options.executionPurpose === 'benchmark-bootstrap' && (
    options.corpus.sourceId !== 'lichess-broadcasts' ||
    options.corpus.archives.length !== 78 ||
    options.corpus.publishedGameTotal !== 1_146_297
  )) {
    throw new Error('Benchmark bootstrap is restricted to the complete approved 78-archive broadcast corpus')
  }
  const approved = options.corpus.archives[archiveIndex]
  if (!approved) throw new Error('Approved remote archive identity is unavailable')
  let opened: ApprovedHttpsArchiveInput | null = null
  return runAdapterWithInput(
    options,
    archiveIndex,
    () => {
      if (opened !== null) throw new Error('Remote archive input was opened more than once in one pass')
      opened = createApprovedHttpsArchiveInput({
        approvedUrl: plan.archive.url,
        expectedBytes: plan.archive.compressedBytes,
        approvedEtag: approved.etagObserved,
        approvedLastModified: approved.lastModifiedObserved,
        ...(optionsValue.remoteTestSeams ? { testSeams: optionsValue.remoteTestSeams } : {}),
      })
      return opened.input
    },
    () => {
      if (opened === null) throw new Error('Remote archive input was never opened')
      return opened.receipt()
    },
  )
}

export function compactV3FixturePgnLimits(): Readonly<typeof PGN_LIMITS> {
  return PGN_LIMITS
}

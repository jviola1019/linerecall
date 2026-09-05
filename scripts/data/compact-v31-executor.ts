import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  type FileHandle,
} from 'node:fs/promises'
import { freemem } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import { Chess } from 'chess.js'
import {
  CompactV31ArchiveCheckpointSchema,
  CompactV31ArchiveDeltaReceiptSchema,
  CompactV31MergeReceiptSchema,
  CompactV31PlanSchema,
  CompactV31PlanReviewSchema,
  CompactV31RepeatabilityBindingSchema,
  CompactV31RunBootstrapSchema,
  CompactV31RunReceiptSchema,
  assessCompactV31Resources,
  type CompactV31ArchiveCheckpoint,
  type CompactV31ArchiveDeltaReceipt,
  type CompactV31MergeReceipt,
  type CompactV31Plan,
  type CompactV31PlanReview,
  type CompactV31RepeatabilityBinding,
  type CompactV31RunBootstrap,
  type CompactV31ResourceObservation,
  type CompactV31ResourceSummary,
  type CompactV31RunReceipt,
} from './compact-v31-contracts.ts'
import {
  DEFAULT_PGN_LIMITS,
  normalizedEpd,
  splitPgnStream,
  uciForMove,
  type PgnRecord,
} from './broadcast-pgn.ts'
import {
  parseBroadcastGraphPgn,
  type GraphAcceptedGame,
  type GraphRejectionReason,
} from './evidence-graph.ts'
import {
  ensureSecureCompactWorkDirectory,
  digestRegularFile,
  openValidatedRegularFile,
  readBoundedRegularFile,
  syncCompactParentDirectory,
} from './compact-v3-orchestrator.ts'
import { assessCompactV31WorkDirectory } from './preflight-compact-v31.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,63}$/u
const ZSTD_FRAME_MAGIC = 0xfd2fb528
const ZSTD_SKIPPABLE_MIN = 0x184d2a50
const ZSTD_SKIPPABLE_MAX = 0x184d2a5f
const OWNER_RECORD_BYTES = 70
const ORDINAL_RECORD_BYTES = 4
const MAXIMUM_RECORD_ORDINAL = 0xffff_ffff
const MAXIMUM_COUNTER = 0xffff_ffff
const MAXIMUM_CONTROL_BYTES = 64 * 1024 * 1024
const DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS = 250
const DEFAULT_SORT_ENTRIES = 20_000
const DEFAULT_OWNER_SORT_ENTRIES = 50_000
const MAXIMUM_EXACT_ROW_BYTES = 16 * 1024
const STREAM_READ_BYTES = 64 * 1024
const MAXIMUM_INVENTORY_ENTRIES = 200_000

/** Fixed by pipeline source SHA. Collisions only retain extra deep evidence. */
export const COMPACT_V31_SKETCH_WIDTH = 65_536
export const COMPACT_V31_SKETCH_DEPTH = 4
const SKETCH_BYTES = COMPACT_V31_SKETCH_WIDTH * COMPACT_V31_SKETCH_DEPTH * Uint32Array.BYTES_PER_ELEMENT
const SKETCH_SEEDS = ['linerecall-v31-0', 'linerecall-v31-1', 'linerecall-v31-2', 'linerecall-v31-3'] as const

interface ResourceSample extends CompactV31ResourceObservation {
  observedAt: string
}

export interface CompactV31ResourceMonitor {
  readonly signal: AbortSignal
  assertHealthy(): void
  sampleNow(): Promise<ResourceSample>
  snapshot(): readonly ResourceSample[]
  stop(): Promise<readonly ResourceSample[]>
}

export interface CompactV31MonitorOptions {
  plan: CompactV31Plan
  observe: () => Promise<CompactV31ResourceObservation>
  intervalMs?: number
  now?: () => Date
}

function isoNow(now: () => Date): string {
  const date = now()
  if (!Number.isFinite(date.getTime())) throw new Error('Clock returned an invalid date')
  return date.toISOString()
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function canonicalJsonLineBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} exceeds the safe integer range`)
  return result
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (result.bytesWritten < 1) throw new Error('Filesystem made no progress while writing')
    offset += result.bytesWritten
  }
}

class AggregateByteLedger {
  currentBytes = 0
  peakBytes = 0

  constructor(readonly maximumBytes: number, readonly label: string, private readonly parent?: AggregateByteLedger) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error(`${label} byte cap is invalid`)
  }

  reserve(bytes: number): void {
    const next = safeAdd(this.currentBytes, bytes, this.label)
    if (next > this.maximumBytes) throw new Error(`${this.label} exceeded its aggregate hard cap`)
    this.parent?.reserve(bytes)
    this.currentBytes = next
    this.peakBytes = Math.max(this.peakBytes, next)
  }

  release(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.currentBytes) throw new Error(`${this.label} release is invalid`)
    this.currentBytes -= bytes
    this.parent?.release(bytes)
  }
}

function resourceSummary(samples: readonly ResourceSample[]): CompactV31ResourceSummary {
  if (samples.length < 1) throw new Error('Resource summary requires at least one sample')
  return {
    sampleCount: samples.length,
    maximumObservedWorkerResidentBytes: Math.max(...samples.map(({ workerResidentBytes }) => workerResidentBytes)),
    minimumObservedFreeStorageBytes: Math.min(...samples.map(({ availableStorageBytes }) => availableStorageBytes)),
    minimumObservedAvailableMemoryBytes: Math.min(...samples.map(({ availableMemoryBytes }) => availableMemoryBytes)),
    maximumObservedRetainedDeltaBytes: Math.max(...samples.map(({ retainedDeltaBytes }) => retainedDeltaBytes)),
  }
}

function resourceSummaryDominates(
  later: CompactV31ResourceSummary,
  earlier: CompactV31ResourceSummary,
): boolean {
  return later.sampleCount >= earlier.sampleCount &&
    later.maximumObservedWorkerResidentBytes >= earlier.maximumObservedWorkerResidentBytes &&
    later.minimumObservedFreeStorageBytes <= earlier.minimumObservedFreeStorageBytes &&
    later.minimumObservedAvailableMemoryBytes <= earlier.minimumObservedAvailableMemoryBytes &&
    later.maximumObservedRetainedDeltaBytes >= earlier.maximumObservedRetainedDeltaBytes
}

function assertRelativeTo(root: string, path: string, label: string): void {
  const fromRoot = relative(resolve(root), resolve(path))
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || fromRoot === '' || /^[A-Za-z]:/u.test(fromRoot)) {
    throw new Error(`${label} must remain below its approved root`)
  }
}

function relativePosix(root: string, path: string): string {
  assertRelativeTo(root, path, 'Receipt artifact')
  return relative(resolve(root), resolve(path)).split(sep).join('/')
}

async function inventoryRegularTreeBytes(root: string, approvedRoot: string, label: string): Promise<number> {
  assertRelativeTo(approvedRoot, root, label)
  try {
    const entry = await lstat(root)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} must be a regular directory`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  const pending = [root]
  let entries = 0
  let bytes = 0
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const name of await readdir(directory)) {
      entries += 1
      if (entries > MAXIMUM_INVENTORY_ENTRIES) throw new Error(`${label} exceeds its entry cap`)
      const path = join(directory, name)
      assertRelativeTo(root, path, label)
      const entry = await lstat(path)
      if (entry.isSymbolicLink()) throw new Error(`${label} cannot contain symbolic links`)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) bytes = safeAdd(bytes, entry.size, `${label} bytes`)
      else throw new Error(`${label} contains a non-file entry`)
    }
  }
  return bytes
}

export function startCompactV31ResourceMonitor(options: CompactV31MonitorOptions): CompactV31ResourceMonitor {
  const plan = CompactV31PlanSchema.parse(options.plan)
  const now = options.now ?? (() => new Date())
  const intervalMs = options.intervalMs ?? DEFAULT_RESOURCE_SAMPLE_INTERVAL_MS
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) {
    throw new Error('Resource sample interval must be from 10 through 60,000 milliseconds')
  }
  const controller = new AbortController()
  const samples: ResourceSample[] = []
  let breach: Error | null = null
  let sampling: Promise<void> | null = null

  const sample = async (): Promise<ResourceSample> => {
    const observation = await options.observe()
    const assessment = assessCompactV31Resources(plan, observation)
    const recorded = { ...observation, observedAt: isoNow(now) }
    samples.push(recorded)
    if (!assessment.safeToStart && breach === null) {
      breach = new Error(`Compact-v3.1 resource guard aborted: ${assessment.reasonCode}`)
      controller.abort(breach)
    }
    return recorded
  }
  const timer = setInterval(() => {
    if (sampling !== null || breach !== null) return
    sampling = sample().then(() => undefined).catch((error: unknown) => {
      breach = error instanceof Error ? error : new Error(String(error))
      controller.abort(breach)
    }).finally(() => { sampling = null })
  }, intervalMs)
  timer.unref()

  return {
    signal: controller.signal,
    assertHealthy() {
      if (breach !== null) throw breach
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error('Compact-v3.1 resource guard aborted')
    },
    async sampleNow() {
      if (sampling !== null) await sampling
      if (breach !== null) throw breach
      const recorded = await sample()
      if (breach !== null) throw breach
      return recorded
    },
    snapshot() { return [...samples] },
    async stop() {
      clearInterval(timer)
      if (sampling !== null) await sampling
      if (breach !== null) throw breach
      return samples
    },
  }
}

export class CompactV31CountMinSketch {
  readonly counters: Uint32Array

  constructor(counters?: Uint32Array) {
    if (counters && counters.length !== COMPACT_V31_SKETCH_WIDTH * COMPACT_V31_SKETCH_DEPTH) {
      throw new Error('Compact-v3.1 sketch has an unexpected counter count')
    }
    this.counters = counters ? new Uint32Array(counters) : new Uint32Array(COMPACT_V31_SKETCH_WIDTH * COMPACT_V31_SKETCH_DEPTH)
  }

  private indexes(keySha256: string): number[] {
    if (!SHA256.test(keySha256)) throw new Error('Sketch key must be a lowercase SHA-256')
    return SKETCH_SEEDS.map((seed, depth) => {
      const digest = createHash('sha256').update(seed).update(keySha256).digest()
      return depth * COMPACT_V31_SKETCH_WIDTH + (digest.readUInt32BE(0) % COMPACT_V31_SKETCH_WIDTH)
    })
  }

  add(keySha256: string, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAXIMUM_COUNTER) throw new Error('Sketch increment is invalid')
    for (const index of this.indexes(keySha256)) {
      const current = this.counters[index]!
      if (current > MAXIMUM_COUNTER - amount) throw new Error('Compact-v3.1 sketch counter saturated')
      this.counters[index] = current + amount
    }
  }

  estimate(keySha256: string): number {
    return Math.min(...this.indexes(keySha256).map((index) => this.counters[index]!))
  }

  merge(other: CompactV31CountMinSketch): void {
    for (let index = 0; index < this.counters.length; index += 1) {
      const value = this.counters[index]! + other.counters[index]!
      if (value > MAXIMUM_COUNTER) throw new Error('Compact-v3.1 merged sketch counter saturated')
      this.counters[index] = value
    }
  }

  toBytes(): Buffer {
    const bytes = Buffer.alloc(SKETCH_BYTES)
    for (let index = 0; index < this.counters.length; index += 1) {
      bytes.writeUInt32LE(this.counters[index]!, index * 4)
    }
    return bytes
  }

  static fromBytes(bytes: Uint8Array): CompactV31CountMinSketch {
    if (bytes.byteLength !== SKETCH_BYTES) throw new Error('Compact-v3.1 sketch byte length is invalid')
    const counters = new Uint32Array(COMPACT_V31_SKETCH_WIDTH * COMPACT_V31_SKETCH_DEPTH)
    const view = Buffer.from(bytes)
    for (let index = 0; index < counters.length; index += 1) counters[index] = view.readUInt32LE(index * 4)
    return new CompactV31CountMinSketch(counters)
  }
}

/** Removes the Lichess frame-length wrappers while hashing their raw bytes upstream. */
class BroadcastZstdPayloadTransform extends Transform {
  private mode: 'unknown' | 'raw' | 'wrapper-header' | 'wrapper-payload' = 'unknown'
  private pending = Buffer.alloc(0)
  private remainingPayloadBytes = 0
  private frames = 0

  override _transform(chunkValue: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      let chunk = this.pending.length === 0 ? Buffer.from(chunkValue) : Buffer.concat([this.pending, chunkValue])
      this.pending = Buffer.alloc(0)
      while (chunk.length > 0) {
        if (this.mode === 'unknown') {
          if (chunk.length < 4) { this.pending = chunk; break }
          if (chunk.readUInt32LE(0) === ZSTD_FRAME_MAGIC) {
            this.mode = 'raw'
            this.push(chunk)
            chunk = Buffer.alloc(0)
            continue
          }
          this.mode = 'wrapper-header'
        }
        if (this.mode === 'raw') {
          this.push(chunk)
          chunk = Buffer.alloc(0)
          continue
        }
        if (this.mode === 'wrapper-header') {
          if (chunk.length < 12) { this.pending = chunk; break }
          const descriptor = chunk.readUInt32LE(0)
          if (
            descriptor < ZSTD_SKIPPABLE_MIN || descriptor > ZSTD_SKIPPABLE_MAX ||
            chunk.readUInt32LE(4) !== 4
          ) throw new Error('Unknown Lichess Zstandard wrapper')
          this.remainingPayloadBytes = chunk.readUInt32LE(8)
          if (this.remainingPayloadBytes < 4) throw new Error('Invalid wrapped Zstandard frame length')
          this.mode = 'wrapper-payload'
          chunk = chunk.subarray(12)
          continue
        }
        const consumed = Math.min(this.remainingPayloadBytes, chunk.length)
        const payload = chunk.subarray(0, consumed)
        if (this.remainingPayloadBytes === 0) throw new Error('Invalid wrapped Zstandard payload')
        this.push(payload)
        this.remainingPayloadBytes -= consumed
        chunk = chunk.subarray(consumed)
        if (this.remainingPayloadBytes === 0) {
          this.frames += 1
          this.mode = 'wrapper-header'
        }
      }
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    if (this.pending.length !== 0 || this.mode === 'unknown' || this.mode === 'wrapper-payload' || (this.mode === 'wrapper-header' && this.frames === 0)) {
      callback(new Error('Truncated Zstandard archive'))
      return
    }
    callback()
  }
}

interface VerifiedRecordStream {
  records: AsyncGenerator<PgnRecord>
  completion: Promise<{ bytes: number; sha256: string }>
}

async function openVerifiedRecordStream(
  sourcePath: string,
  plan: CompactV31Plan,
  signal: AbortSignal,
): Promise<VerifiedRecordStream> {
  const validated = await openValidatedRegularFile(sourcePath, {
    label: `Compact-v3.1 source ${plan.archive.archiveId}`,
    minimumBytes: plan.archive.compressedBytes,
    maximumBytes: plan.archive.compressedBytes,
    exactBytes: plan.archive.compressedBytes,
  })
  const hash = createHash('sha256')
  let byteCount = 0
  let resolveCompletion!: (value: { bytes: number; sha256: string }) => void
  let rejectCompletion!: (error: unknown) => void
  const completion = new Promise<{ bytes: number; sha256: string }>((resolvePromise, rejectPromise) => {
    resolveCompletion = resolvePromise
    rejectCompletion = rejectPromise
  })
  void completion.catch(() => undefined)
  const raw = validated.handle.createReadStream({ autoClose: false, start: 0 })
  const digesting = new Transform({
    transform(chunkValue: Buffer, _encoding, callback) {
      const chunk = Buffer.from(chunkValue)
      byteCount = safeAdd(byteCount, chunk.byteLength, 'Compressed input bytes')
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  const payload = new BroadcastZstdPayloadTransform()
  const decompressor = createZstdDecompress()
  const abort = (): void => {
    const reason = signal.reason instanceof Error ? signal.reason : new Error('Compact-v3.1 source aborted')
    raw.destroy(reason)
    digesting.destroy(reason)
    payload.destroy(reason)
    decompressor.destroy(reason)
  }
  signal.addEventListener('abort', abort, { once: true })
  const decoded = raw.pipe(digesting).pipe(payload).pipe(decompressor)
  const records = (async function* (): AsyncGenerator<PgnRecord> {
    try {
      yield* splitPgnStream(decoded, DEFAULT_PGN_LIMITS)
      if (byteCount !== plan.archive.compressedBytes || await validated.changed()) {
        throw new Error('Compressed source changed or ended at an unexpected byte length')
      }
      const observedSha256 = hash.digest('hex')
      if (observedSha256 !== plan.archive.sha256) throw new Error('Compressed source SHA-256 does not match its plan')
      const result = { bytes: byteCount, sha256: observedSha256 }
      resolveCompletion(result)
    } catch (error) {
      rejectCompletion(error)
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
      decoded.destroy()
      await validated.close()
    }
  })()
  return { records, completion }
}

interface OwnerRecord {
  keySha256: string
  archiveOrdinal: number
  recordOrdinal: number
  corruptionGuardSha256: string
}

interface ExactEvidenceRow {
  keySha256: string
  eligibilityKeySha256: string
  kind: 'position' | 'edge'
  sourceId: GraphAcceptedGame['sourceId']
  cohortId: string
  month: string
  timeControl: string
  ratingBand: string
  ratingDetail: string
  epd: string
  uci?: string
  san?: string
  toEpd?: string
  minPly: number
  n: number
  whiteWins: number
  draws: number
  blackWins: number
}

interface SpillRun {
  partition: string
  path: string
  rows: number
  expectedBytes: number
  expectedSha256: string
}

interface PartitionArtifact {
  partition: string
  path: string
  bytes: number
  sha256: string
  firstKeySha256: string
  lastKeySha256: string
  rowCount: number
}

function keyHash(value: string): string {
  return sha256(value)
}

function partitionFor(keySha256: string, prefixBits: number): string {
  if (!SHA256.test(keySha256) || prefixBits % 4 !== 0) throw new Error('Unsupported partition key')
  return keySha256.slice(0, prefixBits / 4)
}

function gameIdentityHash(game: GraphAcceptedGame): string {
  return keyHash(`${game.sourceId}\0${game.deduplicationKey}`)
}

function evidenceIdentity(input: {
  kind: 'position' | 'edge'
  game: GraphAcceptedGame
  epd: string
  uci?: string
  toEpd?: string
}): string {
  return [
    input.kind,
    input.game.sourceId,
    input.game.cohortId,
    input.game.month,
    input.game.timeControl,
    input.game.ratingBand,
    input.game.ratingDetail ?? '',
    input.epd,
    input.uci ?? '',
    input.toEpd ?? '',
  ].join('\0')
}

function reportingEvidenceIdentity(row: Pick<ExactEvidenceRow,
  'kind' | 'sourceId' | 'cohortId' | 'month' | 'timeControl' | 'ratingBand' | 'ratingDetail' | 'epd' | 'uci' | 'toEpd'>): string {
  return [
    row.kind,
    row.sourceId,
    row.cohortId,
    row.month,
    row.timeControl,
    row.ratingBand,
    row.ratingDetail,
    row.epd,
    row.uci ?? '',
    row.toEpd ?? '',
  ].join('\0')
}

function parseExactEvidenceRow(value: unknown): ExactEvidenceRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Exact evidence row must be an object')
  const row = value as Record<string, unknown>
  const allowed = new Set([
    'keySha256', 'eligibilityKeySha256', 'kind', 'sourceId', 'cohortId', 'month', 'timeControl',
    'ratingBand', 'ratingDetail', 'epd', 'uci', 'san', 'toEpd', 'minPly', 'n', 'whiteWins', 'draws', 'blackWins',
  ])
  if (Object.keys(row).some((key) => !allowed.has(key))) throw new Error('Exact evidence row contains an unknown field')
  const text = (name: string, pattern?: RegExp): string => {
    const item = row[name]
    if (typeof item !== 'string' || item.length > 256 || (pattern && !pattern.test(item))) throw new Error(`Exact evidence row ${name} is invalid`)
    return item
  }
  const integer = (name: string, maximum = Number.MAX_SAFE_INTEGER): number => {
    const item = row[name]
    if (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > maximum) throw new Error(`Exact evidence row ${name} is invalid`)
    return item as number
  }
  const kind = text('kind')
  if (kind !== 'position' && kind !== 'edge') throw new Error('Exact evidence row kind is invalid')
  const sourceId = text('sourceId')
  if (sourceId !== 'lichess-broadcasts' && sourceId !== 'lichess-standard-rated-q2-2026') throw new Error('Exact evidence source is invalid')
  const parsed: ExactEvidenceRow = {
    keySha256: text('keySha256', SHA256),
    eligibilityKeySha256: text('eligibilityKeySha256', SHA256),
    kind,
    sourceId,
    cohortId: text('cohortId', /^cohort_[a-z0-9-]{3,64}$/u),
    month: text('month', /^\d{4}-(?:0[1-9]|1[0-2])$/u),
    timeControl: text('timeControl', /^(?:blitz|rapid|classical|unknown)$/u),
    ratingBand: text('ratingBand', /^(?:<1800|1800-1999|2000-2199|2200-2399|2400\+)$/u),
    ratingDetail: text('ratingDetail', /^(?:|<1200|1200-1499|1500-1799)$/u),
    epd: text('epd'),
    minPly: integer('minPly', 100),
    n: integer('n'),
    whiteWins: integer('whiteWins'),
    draws: integer('draws'),
    blackWins: integer('blackWins'),
    ...(kind === 'edge' ? {
      uci: text('uci', /^[a-h][1-8][a-h][1-8][qrbn]?$/u),
      san: text('san'),
      toEpd: text('toEpd'),
    } : {}),
  }
  if (parsed.n < 1 || parsed.whiteWins + parsed.draws + parsed.blackWins !== parsed.n) throw new Error('Exact evidence outcomes do not reconcile')
  for (const epd of [parsed.epd, ...(parsed.toEpd ? [parsed.toEpd] : [])]) {
    try { new Chess(`${epd} 0 1`) } catch { throw new Error('Exact evidence EPD is illegal') }
  }
  if (parsed.keySha256 !== keyHash(reportingEvidenceIdentity(parsed))) throw new Error('Exact evidence reporting key does not match its dimensions')
  const eligibility = compactV31EligibilityKey(parsed)
  if (parsed.eligibilityKeySha256 !== eligibility) throw new Error('Exact evidence eligibility key does not match its aggregate dimensions')
  return parsed
}

export function compactV31EligibilityKey(input: {
  kind: 'position' | 'edge'
  sourceId: GraphAcceptedGame['sourceId']
  cohortId: string
  timeControl: string
  epd: string
  uci?: string
  toEpd?: string
}): string {
  return keyHash([
    input.kind,
    input.sourceId,
    input.cohortId,
    input.timeControl,
    input.epd,
    input.uci ?? '',
    input.toEpd ?? '',
  ].join('\0'))
}

function resultCounts(result: GraphAcceptedGame['result']): Pick<ExactEvidenceRow, 'n' | 'whiteWins' | 'draws' | 'blackWins'> {
  return {
    n: 1,
    whiteWins: result === '1-0' ? 1 : 0,
    draws: result === '1/2-1/2' ? 1 : 0,
    blackWins: result === '0-1' ? 1 : 0,
  }
}

function forEachGameEvidence(
  game: GraphAcceptedGame,
  maximumPly: number,
  visit: (row: ExactEvidenceRow, ply: number) => void,
): void {
  const chess = new Chess()
  const finalPly = Math.min(maximumPly, game.moves.length)
  const outcome = resultCounts(game.result)
  for (let ply = 0; ply <= finalPly; ply += 1) {
    const epd = normalizedEpd(chess)
    const positionIdentity = evidenceIdentity({ kind: 'position', game, epd })
    visit({
      keySha256: keyHash(positionIdentity),
      eligibilityKeySha256: compactV31EligibilityKey({
        kind: 'position',
        sourceId: game.sourceId,
        cohortId: game.cohortId,
        timeControl: game.timeControl,
        epd,
      }),
      kind: 'position',
      sourceId: game.sourceId,
      cohortId: game.cohortId,
      month: game.month,
      timeControl: game.timeControl,
      ratingBand: game.ratingBand,
      ratingDetail: game.ratingDetail ?? '',
      epd,
      minPly: ply,
      ...outcome,
    }, ply)
    const sourceMove = game.moves[ply]
    if (!sourceMove || ply === finalPly) break
    const move = chess.move({
      from: sourceMove.from,
      to: sourceMove.to,
      ...(sourceMove.promotion ? { promotion: sourceMove.promotion } : {}),
    })
    if (!move) throw new Error(`Validated game could not replay ${uciForMove(sourceMove)}`)
    const toEpd = normalizedEpd(chess)
    const uci = uciForMove(sourceMove)
    const edgeIdentity = evidenceIdentity({ kind: 'edge', game, epd, uci, toEpd })
    visit({
      keySha256: keyHash(edgeIdentity),
      eligibilityKeySha256: compactV31EligibilityKey({
        kind: 'edge',
        sourceId: game.sourceId,
        cohortId: game.cohortId,
        timeControl: game.timeControl,
        epd,
        uci,
        toEpd,
      }),
      kind: 'edge',
      sourceId: game.sourceId,
      cohortId: game.cohortId,
      month: game.month,
      timeControl: game.timeControl,
      ratingBand: game.ratingBand,
      ratingDetail: game.ratingDetail ?? '',
      epd,
      uci,
      san: move.san,
      toEpd,
      minPly: ply,
      ...outcome,
    }, ply)
  }
}

function encodeOwner(record: OwnerRecord): Buffer {
  if (
    !SHA256.test(record.keySha256) || !SHA256.test(record.corruptionGuardSha256) ||
    !Number.isSafeInteger(record.archiveOrdinal) || record.archiveOrdinal < 0 || record.archiveOrdinal > 77 ||
    !Number.isSafeInteger(record.recordOrdinal) || record.recordOrdinal < 0 || record.recordOrdinal > MAXIMUM_RECORD_ORDINAL
  ) throw new Error('Invalid compact-v3.1 game ownership record')
  const bytes = Buffer.alloc(OWNER_RECORD_BYTES)
  Buffer.from(record.keySha256, 'hex').copy(bytes, 0)
  bytes.writeUInt16BE(record.archiveOrdinal, 32)
  bytes.writeUInt32BE(record.recordOrdinal, 34)
  Buffer.from(record.corruptionGuardSha256, 'hex').copy(bytes, 38)
  return bytes
}

function decodeOwner(bytes: Buffer): OwnerRecord {
  if (bytes.byteLength !== OWNER_RECORD_BYTES) throw new Error('Truncated compact-v3.1 ownership row')
  return {
    keySha256: bytes.subarray(0, 32).toString('hex'),
    archiveOrdinal: bytes.readUInt16BE(32),
    recordOrdinal: bytes.readUInt32BE(34),
    corruptionGuardSha256: bytes.subarray(38, 70).toString('hex'),
  }
}

function compareOwner(left: OwnerRecord, right: OwnerRecord): number {
  return compareCanonical(left.keySha256, right.keySha256) ||
    left.archiveOrdinal - right.archiveOrdinal ||
    left.recordOrdinal - right.recordOrdinal ||
    compareCanonical(left.corruptionGuardSha256, right.corruptionGuardSha256)
}

function mergeExactRows(left: ExactEvidenceRow, right: ExactEvidenceRow): ExactEvidenceRow {
  if (left.keySha256 !== right.keySha256) throw new Error('Cannot merge distinct exact-evidence keys')
  const identity = (row: ExactEvidenceRow): string => JSON.stringify({
    kind: row.kind,
    eligibilityKeySha256: row.eligibilityKeySha256,
    sourceId: row.sourceId,
    cohortId: row.cohortId,
    month: row.month,
    timeControl: row.timeControl,
    ratingBand: row.ratingBand,
    ratingDetail: row.ratingDetail,
    epd: row.epd,
    uci: row.uci ?? null,
    san: row.san ?? null,
    toEpd: row.toEpd ?? null,
  })
  if (identity(left) !== identity(right)) throw new Error('SHA-256 collision or conflicting exact-evidence identity')
  return {
    ...left,
    minPly: Math.min(left.minPly, right.minPly),
    n: safeAdd(left.n, right.n, 'Exact evidence N'),
    whiteWins: safeAdd(left.whiteWins, right.whiteWins, 'Exact evidence White wins'),
    draws: safeAdd(left.draws, right.draws, 'Exact evidence draws'),
    blackWins: safeAdd(left.blackWins, right.blackWins, 'Exact evidence Black wins'),
  }
}

async function writeExclusive(path: string, bytes: Uint8Array, maximumBytes: number, ledger?: AggregateByteLedger): Promise<void> {
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) throw new Error(`Output ${basename(path)} exceeds its approved byte bound`)
  let reserved = false
  let handle: FileHandle | null = null
  try {
    ledger?.reserve(bytes.byteLength)
    reserved = ledger !== undefined
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    handle = await open(path, 'wx', 0o600)
    await writeAll(handle, bytes)
    await handle.sync()
  } catch (error) {
    try { await handle?.close() } catch { /* retain the primary write failure */ }
    handle = null
    await rm(path, { force: true })
    if (reserved) ledger!.release(bytes.byteLength)
    throw error
  } finally {
    await handle?.close()
  }
}

async function appendExclusive(path: string, chunks: readonly Uint8Array[], maximumBytes: number, ledger?: AggregateByteLedger): Promise<number> {
  let handle: FileHandle | null = null
  let written = 0
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    handle = await open(path, 'wx', 0o600)
    for (const chunk of chunks) {
      const next = safeAdd(written, chunk.byteLength, 'Spill output bytes')
      if (next > maximumBytes) throw new Error(`Output ${basename(path)} exceeds its approved byte bound`)
      ledger?.reserve(chunk.byteLength)
      written = next
      await writeAll(handle, chunk)
    }
    await handle.sync()
  } catch (error) {
    try { await handle?.close() } catch { /* retain the primary write failure */ }
    handle = null
    await rm(path, { force: true })
    ledger?.release(written)
    throw error
  } finally {
    await handle?.close()
  }
  return written
}

class OwnerSpillWriter {
  private records: OwnerRecord[] = []
  private readonly runs = new Map<string, SpillRun[]>()
  private runNumber = 0
  private totalBytes = 0

  constructor(
    private readonly directory: string,
    private readonly prefixBits: number,
    private readonly maximumEntries: number,
    private readonly maximumBytes: number,
    private readonly monitor: CompactV31ResourceMonitor,
    private readonly workspaceLedger: AggregateByteLedger,
  ) {}

  get writtenBytes(): number { return this.totalBytes }

  async add(record: OwnerRecord): Promise<void> {
    this.records.push(record)
    if (this.records.length >= this.maximumEntries) await this.flush()
  }

  private async flush(): Promise<void> {
    if (this.records.length === 0) return
    this.monitor.assertHealthy()
    const grouped = new Map<string, OwnerRecord[]>()
    for (const record of this.records) {
      const partition = partitionFor(record.keySha256, this.prefixBits)
      const rows = grouped.get(partition) ?? []
      rows.push(record)
      grouped.set(partition, rows)
    }
    this.records = []
    for (const [partition, rows] of [...grouped.entries()].sort(([left], [right]) => compareCanonical(left, right))) {
      rows.sort(compareOwner)
      const path = join(this.directory, 'owner-runs', partition, `${String(this.runNumber).padStart(8, '0')}.bin`)
      this.runNumber += 1
      const bytes = rows.map(encodeOwner)
      const runBytes = bytes.reduce((sum, value) => safeAdd(sum, value.byteLength, 'Owner spill bytes'), 0)
      this.totalBytes = safeAdd(this.totalBytes, runBytes, 'Archive owner spill bytes')
      if (this.totalBytes > this.maximumBytes) throw new Error('Compact-v3.1 archive owner deltas exceeded their hard cap')
      await appendExclusive(path, bytes, this.maximumBytes, this.workspaceLedger)
      const runs = this.runs.get(partition) ?? []
      runs.push({ partition, path, rows: rows.length, expectedBytes: runBytes, expectedSha256: sha256(Buffer.concat(bytes)) })
      this.runs.set(partition, runs)
    }
    await this.monitor.sampleNow()
  }

  async finish(): Promise<Map<string, SpillRun[]>> {
    await this.flush()
    return this.runs
  }
}

class ExactSpillWriter {
  private rows = new Map<string, ExactEvidenceRow>()
  private readonly runs = new Map<string, SpillRun[]>()
  private runNumber = 0
  private totalBytes = 0

  constructor(
    private readonly directory: string,
    private readonly prefixBits: number,
    private readonly maximumEntries: number,
    private readonly maximumBytes: number,
    private readonly monitor: CompactV31ResourceMonitor,
    private readonly workspaceLedger: AggregateByteLedger,
  ) {}

  get writtenBytes(): number { return this.totalBytes }

  async add(row: ExactEvidenceRow): Promise<void> {
    const existing = this.rows.get(row.keySha256)
    this.rows.set(row.keySha256, existing ? mergeExactRows(existing, row) : row)
    if (this.rows.size >= this.maximumEntries) await this.flush()
  }

  private async flush(): Promise<void> {
    if (this.rows.size === 0) return
    this.monitor.assertHealthy()
    const grouped = new Map<string, ExactEvidenceRow[]>()
    for (const row of this.rows.values()) {
      const partition = partitionFor(row.keySha256, this.prefixBits)
      const rows = grouped.get(partition) ?? []
      rows.push(row)
      grouped.set(partition, rows)
    }
    this.rows = new Map()
    for (const [partition, rows] of [...grouped.entries()].sort(([left], [right]) => compareCanonical(left, right))) {
      rows.sort((left, right) => compareCanonical(left.keySha256, right.keySha256))
      const bytes = rows.map((row) => canonicalJsonLineBytes(row))
      const runBytes = bytes.reduce((sum, value) => safeAdd(sum, value.byteLength, 'Exact spill bytes'), 0)
      this.totalBytes = safeAdd(this.totalBytes, runBytes, 'Archive exact spill bytes')
      if (this.totalBytes > this.maximumBytes) throw new Error('Compact-v3.1 archive exact deltas exceeded their hard cap')
      const path = join(this.directory, 'exact-runs', partition, `${String(this.runNumber).padStart(8, '0')}.jsonl`)
      this.runNumber += 1
      await appendExclusive(path, bytes, this.maximumBytes, this.workspaceLedger)
      const runs = this.runs.get(partition) ?? []
      runs.push({ partition, path, rows: rows.length, expectedBytes: runBytes, expectedSha256: sha256(Buffer.concat(bytes)) })
      this.runs.set(partition, runs)
    }
    await this.monitor.sampleNow()
  }

  async finish(): Promise<Map<string, SpillRun[]>> {
    await this.flush()
    return this.runs
  }
}

class BoundedOutputFile {
  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
    private readonly maximumBytes: number,
    private readonly ledger?: AggregateByteLedger,
  ) {}

  bytes = 0
  readonly hash = createHash('sha256')

  static async create(path: string, maximumBytes: number, ledger?: AggregateByteLedger): Promise<BoundedOutputFile> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    return new BoundedOutputFile(path, await open(path, 'wx', 0o600), maximumBytes, ledger)
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.bytes = safeAdd(this.bytes, bytes.byteLength, 'Bounded output bytes')
    if (this.bytes > this.maximumBytes) throw new Error(`Output ${basename(this.path)} exceeded its hard cap`)
    this.ledger?.reserve(bytes.byteLength)
    this.hash.update(bytes)
    await writeAll(this.handle, bytes)
  }

  async close(): Promise<string> {
    if (this.bytes < 1) throw new Error(`Output ${basename(this.path)} cannot be empty`)
    await this.handle.sync()
    await this.handle.close()
    return this.hash.digest('hex')
  }

  async abort(): Promise<void> {
    try { await this.handle.close() } finally {
      await rm(this.path, { force: true })
      this.ledger?.release(this.bytes)
    }
  }
}

async function* readOwnerRun(run: SpillRun): AsyncGenerator<OwnerRecord> {
  if (run.expectedBytes !== run.rows * OWNER_RECORD_BYTES) throw new Error('Owner spill receipt byte/row count does not reconcile')
  const validated = await openValidatedRegularFile(run.path, {
    label: 'Compact-v3.1 owner run',
    minimumBytes: run.expectedBytes,
    maximumBytes: run.expectedBytes,
    exactBytes: run.expectedBytes,
  })
  const hash = createHash('sha256')
  try {
    const bytes = Buffer.alloc(OWNER_RECORD_BYTES)
    for (let offset = 0; offset < validated.size; offset += OWNER_RECORD_BYTES) {
      const result = await validated.handle.read(bytes, 0, OWNER_RECORD_BYTES, offset)
      if (result.bytesRead !== OWNER_RECORD_BYTES) throw new Error('Owner spill run changed while reading')
      hash.update(bytes)
      yield decodeOwner(Buffer.from(bytes))
    }
    if (hash.digest('hex') !== run.expectedSha256 || await validated.changed()) throw new Error('Owner spill run digest or identity changed while consumed')
  } finally {
    await validated.close()
  }
}

async function* readJsonlRun(run: SpillRun, maximumBytes: number): AsyncGenerator<ExactEvidenceRow> {
  if (run.expectedBytes < 1 || run.expectedBytes > maximumBytes) throw new Error('Exact spill run byte receipt is outside bounds')
  const validated = await openValidatedRegularFile(run.path, {
    label: 'Compact-v3.1 exact run',
    minimumBytes: run.expectedBytes,
    maximumBytes: run.expectedBytes,
    exactBytes: run.expectedBytes,
  })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const hash = createHash('sha256')
  let pending = ''
  let offset = 0
  const parseLine = (line: string): ExactEvidenceRow => {
    if (line.length === 0 || line.includes('\0') || Buffer.byteLength(line, 'utf8') > MAXIMUM_EXACT_ROW_BYTES) {
      throw new Error('Exact spill run contains an invalid or oversized row')
    }
    return parseExactEvidenceRow(JSON.parse(line) as unknown)
  }
  try {
    while (offset < validated.size) {
      const chunk = Buffer.alloc(Math.min(STREAM_READ_BYTES, validated.size - offset))
      const result = await validated.handle.read(chunk, 0, chunk.byteLength, offset)
      if (result.bytesRead < 1) throw new Error('Exact spill run changed while reading')
      offset += result.bytesRead
      const consumed = chunk.subarray(0, result.bytesRead)
      hash.update(consumed)
      pending += decoder.decode(consumed, { stream: offset < validated.size })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        yield parseLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
      if (Buffer.byteLength(pending, 'utf8') > MAXIMUM_EXACT_ROW_BYTES) throw new Error('Exact spill run row exceeded its byte cap')
    }
    if (pending.length !== 0) throw new Error('Exact spill run must end with a newline')
    if (hash.digest('hex') !== run.expectedSha256 || await validated.changed()) throw new Error('Exact spill run digest or identity changed while consumed')
  } finally {
    await validated.close()
  }
}

async function initializeHeads<T>(iterators: AsyncIterator<T>[]): Promise<Array<{ iterator: AsyncIterator<T>; value: T }>> {
  const heads: Array<{ iterator: AsyncIterator<T>; value: T }> = []
  for (const iterator of iterators) {
    const next = await iterator.next()
    if (!next.done) heads.push({ iterator, value: next.value })
  }
  return heads
}

async function advanceHead<T>(heads: Array<{ iterator: AsyncIterator<T>; value: T }>, index: number): Promise<void> {
  const head = heads[index]!
  const next = await head.iterator.next()
  if (next.done) heads.splice(index, 1)
  else head.value = next.value
}

async function mergeOwnerRuns(options: {
  runs: readonly SpillRun[]
  stagingPath: string
  maximumBytes: number
  monitor: CompactV31ResourceMonitor
  outputLedger: AggregateByteLedger
}): Promise<{ bytes: number; sha256: string; first: string; last: string; rows: number; duplicateRows: number }> {
  const iterators = options.runs.map((run) => readOwnerRun(run)[Symbol.asyncIterator]())
  const heads = await initializeHeads(iterators)
  const output = await BoundedOutputFile.create(options.stagingPath, options.maximumBytes, options.outputLedger)
  let first = ''
  let last = ''
  let rows = 0
  let inputRows = 0
  try {
    while (heads.length > 0) {
      options.monitor.assertHealthy()
      let selected = 0
      for (let index = 1; index < heads.length; index += 1) {
        if (compareOwner(heads[index]!.value, heads[selected]!.value) < 0) selected = index
      }
      const key = heads[selected]!.value.keySha256
      let chosen: OwnerRecord | null = null
      let guard: string | null = null
      while (true) {
        let matching = -1
        for (let index = 0; index < heads.length; index += 1) {
          if (heads[index]!.value.keySha256 === key) { matching = index; break }
        }
        if (matching < 0) break
        const current = heads[matching]!.value
        inputRows += 1
        if (inputRows % 4096 === 0) await options.monitor.sampleNow()
        if (guard !== null && guard !== current.corruptionGuardSha256) {
          throw new Error(`Conflicting game content for ownership key ${key}`)
        }
        guard = current.corruptionGuardSha256
        if (
          chosen === null || current.archiveOrdinal < chosen.archiveOrdinal ||
          (current.archiveOrdinal === chosen.archiveOrdinal && current.recordOrdinal < chosen.recordOrdinal)
        ) chosen = current
        await advanceHead(heads, matching)
      }
      if (chosen === null) throw new Error('Owner merge lost its selected row')
      await output.write(encodeOwner(chosen))
      first ||= key
      last = key
      rows += 1
    }
    const digest = await output.close()
    return { bytes: output.bytes, sha256: digest, first, last, rows, duplicateRows: inputRows - rows }
  } catch (error) {
    await output.abort()
    throw error
  }
}

async function mergeExactRuns(options: {
  runs: readonly SpillRun[]
  stagingPath: string
  maximumInputRunBytes: number
  maximumOutputBytes: number
  monitor: CompactV31ResourceMonitor
  outputLedger: AggregateByteLedger
}): Promise<{ bytes: number; sha256: string; first: string; last: string; rows: number; duplicateRows: number }> {
  const iterators = options.runs.map((run) => readJsonlRun(run, options.maximumInputRunBytes)[Symbol.asyncIterator]())
  const heads = await initializeHeads(iterators)
  const output = await BoundedOutputFile.create(options.stagingPath, options.maximumOutputBytes, options.outputLedger)
  let first = ''
  let last = ''
  let rows = 0
  let inputRows = 0
  try {
    while (heads.length > 0) {
      options.monitor.assertHealthy()
      let selected = 0
      for (let index = 1; index < heads.length; index += 1) {
        if (heads[index]!.value.keySha256 < heads[selected]!.value.keySha256) selected = index
      }
      const key = heads[selected]!.value.keySha256
      let merged: ExactEvidenceRow | null = null
      while (true) {
        let matching = -1
        for (let index = 0; index < heads.length; index += 1) {
          if (heads[index]!.value.keySha256 === key) { matching = index; break }
        }
        if (matching < 0) break
        const current = heads[matching]!.value
        inputRows += 1
        if (inputRows % 4096 === 0) await options.monitor.sampleNow()
        merged = merged === null ? current : mergeExactRows(merged, current)
        await advanceHead(heads, matching)
      }
      if (merged === null) throw new Error('Exact merge lost its selected row')
      await output.write(canonicalJsonLineBytes(merged))
      first ||= key
      last = key
      rows += 1
    }
    const digest = await output.close()
    return { bytes: output.bytes, sha256: digest, first, last, rows, duplicateRows: inputRows - rows }
  } catch (error) {
    await output.abort()
    throw error
  }
}

async function contentAddressOutput(path: string, sha: string, extension: string): Promise<string> {
  if (!SHA256.test(sha) || !/^[a-z0-9]{1,12}$/u.test(extension)) throw new Error('Invalid content-addressed output identity')
  const destination = join(dirname(path), `${sha}.${extension}`)
  try {
    await link(path, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const source = await digestRegularFile(path, { label: 'Staged content-addressed output', minimumBytes: 1, maximumBytes: Number.MAX_SAFE_INTEGER })
    const existing = await digestRegularFile(destination, { label: 'Existing content-addressed output', minimumBytes: source.size, maximumBytes: source.size, exactBytes: source.size })
    if (source.sha256 !== sha || existing.sha256 !== sha) throw new Error('Content-addressed output collision or corruption')
  }
  await rm(path, { force: true })
  return destination
}

async function finalizeOwnerPartitions(options: {
  runs: Map<string, SpillRun[]>
  stageDirectory: string
  finalDirectory: string
  workDirectory: string
  maximumPartitionBytes: number
  monitor: CompactV31ResourceMonitor
  outputLedger: AggregateByteLedger
}): Promise<{ artifacts: PartitionArtifact[]; inputRows: number; outputRows: number; duplicateRows: number }> {
  const artifacts: PartitionArtifact[] = []
  let inputRows = 0
  let outputRows = 0
  let duplicateRows = 0
  for (const [partition, runs] of [...options.runs.entries()].sort(([left], [right]) => compareCanonical(left, right))) {
    const stagingPath = join(options.stageDirectory, 'partitions', `${partition}.owners.partial`)
    const merged = await mergeOwnerRuns({
      runs,
      stagingPath,
      maximumBytes: options.maximumPartitionBytes,
      monitor: options.monitor,
      outputLedger: options.outputLedger,
    })
    const addressed = await contentAddressOutput(stagingPath, merged.sha256, 'owners')
    const finalPath = join(options.finalDirectory, relative(options.stageDirectory, addressed))
    artifacts.push({
      partition,
      path: relativePosix(options.workDirectory, finalPath),
      bytes: merged.bytes,
      sha256: merged.sha256,
      firstKeySha256: merged.first,
      lastKeySha256: merged.last,
      rowCount: merged.rows,
    })
    inputRows += runs.reduce((sum, run) => sum + run.rows, 0)
    outputRows += merged.rows
    duplicateRows += merged.duplicateRows
    await options.monitor.sampleNow()
  }
  return { artifacts, inputRows, outputRows, duplicateRows }
}

async function finalizeExactPartitions(options: {
  runs: Map<string, SpillRun[]>
  stageDirectory: string
  finalDirectory: string
  workDirectory: string
  maximumPartitionBytes: number
  monitor: CompactV31ResourceMonitor
  outputLedger: AggregateByteLedger
}): Promise<{ artifacts: PartitionArtifact[]; inputRows: number; outputRows: number; duplicateRows: number }> {
  const artifacts: PartitionArtifact[] = []
  let inputRows = 0
  let outputRows = 0
  let duplicateRows = 0
  for (const [partition, runs] of [...options.runs.entries()].sort(([left], [right]) => compareCanonical(left, right))) {
    const stagingPath = join(options.stageDirectory, 'partitions', `${partition}.jsonl.partial`)
    const merged = await mergeExactRuns({
      runs,
      stagingPath,
      maximumInputRunBytes: options.maximumPartitionBytes,
      maximumOutputBytes: options.maximumPartitionBytes,
      monitor: options.monitor,
      outputLedger: options.outputLedger,
    })
    const addressed = await contentAddressOutput(stagingPath, merged.sha256, 'jsonl')
    const finalPath = join(options.finalDirectory, relative(options.stageDirectory, addressed))
    artifacts.push({
      partition,
      path: relativePosix(options.workDirectory, finalPath),
      bytes: merged.bytes,
      sha256: merged.sha256,
      firstKeySha256: merged.first,
      lastKeySha256: merged.last,
      rowCount: merged.rows,
    })
    inputRows += runs.reduce((sum, run) => sum + run.rows, 0)
    outputRows += merged.rows
    duplicateRows += merged.duplicateRows
    await options.monitor.sampleNow()
  }
  return { artifacts, inputRows, outputRows, duplicateRows }
}

class OwnedOrdinalCursor {
  private offset = 0
  private nextValue: number | null = null
  private readonly hash = createHash('sha256')

  private constructor(
    private readonly validated: Awaited<ReturnType<typeof openValidatedRegularFile>>,
    private readonly expectedSha256: string,
  ) {}

  static async open(options: { path: string; bytes: number; sha256: string }): Promise<OwnedOrdinalCursor> {
    if (options.bytes % ORDINAL_RECORD_BYTES !== 0) throw new Error('Candidate ownership index byte count is invalid')
    const validated = await openValidatedRegularFile(options.path, {
      label: 'Candidate ownership index',
      minimumBytes: options.bytes,
      maximumBytes: options.bytes,
      exactBytes: options.bytes,
    })
    const cursor = new OwnedOrdinalCursor(validated, options.sha256)
    await cursor.advance()
    return cursor
  }

  private async advance(): Promise<void> {
    if (this.offset >= this.validated.size) { this.nextValue = null; return }
    const bytes = Buffer.alloc(ORDINAL_RECORD_BYTES)
    const result = await this.validated.handle.read(bytes, 0, ORDINAL_RECORD_BYTES, this.offset)
    if (result.bytesRead !== ORDINAL_RECORD_BYTES) throw new Error('Candidate ownership index changed while reading')
    this.hash.update(bytes)
    const value = bytes.readUInt32BE(0)
    if (this.nextValue !== null && value <= this.nextValue) throw new Error('Candidate ownership index is not strictly ordered')
    this.nextValue = value
    this.offset += ORDINAL_RECORD_BYTES
  }

  async owns(recordOrdinal: number): Promise<boolean> {
    if (this.nextValue !== null && this.nextValue < recordOrdinal) {
      throw new Error('Candidate ownership index contains an unobserved record ordinal')
    }
    if (this.nextValue !== recordOrdinal) return false
    await this.advance()
    return true
  }

  async assertComplete(): Promise<void> {
    if (this.nextValue !== null) throw new Error('Candidate ownership index extends beyond the archive record stream')
    if (this.hash.digest('hex') !== this.expectedSha256 || await this.validated.changed()) {
      throw new Error('Candidate ownership index digest or identity changed while consumed')
    }
  }

  async close(): Promise<void> {
    await this.validated.close()
  }
}

export interface CompactV31ArchiveDeltaOptions {
  plan: CompactV31Plan
  pass: 'candidate' | 'exact'
  runId: string
  workDirectory: string
  sourcePath: string
  previousArchiveDeltaReceiptSha256: string | null
  observeResources: () => Promise<CompactV31ResourceObservation>
  candidateMergeReceipt?: CompactV31MergeReceipt
  now?: () => Date
  resourceSampleIntervalMs?: number
  maximumSortEntries?: number
  maximumOwnerSortEntries?: number
}

export interface CompactV31ArchiveDeltaResult {
  status: 'committed' | 'already-committed'
  receipt: CompactV31ArchiveDeltaReceipt
  receiptSha256: string
  checkpoint: CompactV31ArchiveCheckpoint
  resourceSamples: readonly ResourceSample[]
  resources: CompactV31ResourceSummary
}

async function readCommittedArchiveDelta(options: {
  plan: CompactV31Plan
  pass: 'candidate' | 'exact'
  runId: string
  workDirectory: string
  finalDirectory: string
  previousArchiveDeltaReceiptSha256: string | null
}): Promise<CompactV31ArchiveDeltaResult> {
  const receiptBytes = await readBoundedRegularFile(
    join(options.finalDirectory, 'receipt.json'),
    options.plan.limits.maximumReceiptBytes,
    'Committed compact-v3.1 archive receipt',
    1,
  )
  const receipt = CompactV31ArchiveDeltaReceiptSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)) as unknown)
  const receiptSha256 = sha256(receiptBytes)
  if (
    !receiptBytes.equals(canonicalJsonBytes(receipt)) || receipt.pass !== options.pass || receipt.runId !== options.runId ||
    receipt.archive.archiveId !== options.plan.archive.archiveId || receipt.archiveOrdinal !== options.plan.archiveOrdinal ||
    receipt.sourceSnapshotSha256 !== options.plan.sourceSnapshotSha256 ||
    receipt.configurationSha256 !== options.plan.configurationSha256 ||
    receipt.benchmarkAuthorizationSha256 !== options.plan.benchmarkAuthorizationSha256 ||
    receipt.previousArchiveDeltaReceiptSha256 !== options.previousArchiveDeltaReceiptSha256
  ) throw new Error('Committed compact-v3.1 archive receipt does not match this invocation')
  const retainedBytes = receipt.partitions.reduce((sum, artifact) => safeAdd(sum, artifact.bytes, 'Committed archive delta bytes'), 0)
  if (retainedBytes > options.plan.limits.maximumDeltaBytesPerArchive) {
    throw new Error('Committed compact-v3.1 archive exceeds its aggregate delta cap')
  }
  for (const artifact of receipt.partitions) {
    const verified = await digestRegularFile(compactPath(options.workDirectory, artifact.path), {
      label: `Committed archive partition ${artifact.partition}`,
      minimumBytes: artifact.bytes,
      maximumBytes: artifact.bytes,
      exactBytes: artifact.bytes,
    })
    if (verified.sha256 !== artifact.sha256) throw new Error('Committed compact-v3.1 partition digest changed')
  }
  const checkpointPath = join(options.workDirectory, 'v31', 'checkpoints', options.runId, options.pass, `${options.plan.archive.archiveId}.json`)
  let checkpointBytes: Buffer
  let checkpoint: CompactV31ArchiveCheckpoint
  try {
    checkpointBytes = await readBoundedRegularFile(checkpointPath, options.plan.limits.maximumReceiptBytes, 'Compact-v3.1 checkpoint', 1)
    checkpoint = CompactV31ArchiveCheckpointSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(checkpointBytes)) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    checkpoint = CompactV31ArchiveCheckpointSchema.parse({
      schemaVersion: 1,
      kind: 'linerecall-compact-v31-archive-checkpoint',
      storageModel: options.plan.storageModel,
      pipelineVersion: options.plan.pipelineVersion,
      executionPurpose: options.plan.executionPurpose,
      releaseEligible: false,
      runId: options.runId,
      pass: options.pass,
      archiveOrdinal: options.plan.archiveOrdinal,
      archiveId: options.plan.archive.archiveId,
      planSha256: sha256(canonicalJsonBytes(options.plan)),
      deltaReceiptSha256: receiptSha256,
      previousArchiveDeltaReceiptSha256: options.previousArchiveDeltaReceiptSha256,
      committedAt: receipt.completedAt,
      resources: receipt.resources,
    })
    checkpointBytes = canonicalJsonBytes(checkpoint)
    if (safeAdd(receiptBytes.byteLength, checkpointBytes.byteLength, 'Archive receipt bytes') > options.plan.limits.maximumReceiptBytes) {
      throw new Error('Recovered archive receipt and checkpoint exceed their aggregate cap')
    }
    const ledger = new AggregateByteLedger(options.plan.limits.maximumReceiptBytes, 'Recovered archive receipt and checkpoint bytes')
    ledger.reserve(receiptBytes.byteLength)
    await atomicallyCommitCheckpoint({
      workDirectory: options.workDirectory,
      checkpoint,
      maximumBytes: options.plan.limits.maximumReceiptBytes,
      ledger,
    })
  }
  if (
    !checkpointBytes.equals(canonicalJsonBytes(checkpoint)) || checkpoint.deltaReceiptSha256 !== receiptSha256 ||
    checkpoint.planSha256 !== sha256(canonicalJsonBytes(options.plan)) ||
    checkpoint.previousArchiveDeltaReceiptSha256 !== options.previousArchiveDeltaReceiptSha256 ||
    !resourceSummaryDominates(checkpoint.resources, receipt.resources) ||
    safeAdd(receiptBytes.byteLength, checkpointBytes.byteLength, 'Archive receipt bytes') > options.plan.limits.maximumReceiptBytes
  ) throw new Error('Compact-v3.1 checkpoint does not bind its committed archive bytes')
  return { status: 'already-committed', receipt, receiptSha256, checkpoint, resourceSamples: [], resources: checkpoint.resources }
}

function incrementRejection(
  rejected: Partial<Record<GraphRejectionReason | NonNullable<PgnRecord['rejection']>, number>>,
  reason: GraphRejectionReason | NonNullable<PgnRecord['rejection']>,
): void {
  rejected[reason] = (rejected[reason] ?? 0) + 1
}

function compactPath(workDirectory: string, relativePath: string): string {
  if (relativePath.includes('\\') || relativePath.startsWith('/') || relativePath.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('Compact-v3.1 receipt contains an unsafe path')
  }
  const path = join(resolve(workDirectory), ...relativePath.split('/'))
  assertRelativeTo(workDirectory, path, 'Compact-v3.1 receipt path')
  return path
}

async function readVerifiedArtifactBytes(options: {
  path: string
  bytes: number
  sha256: string
  label: string
}): Promise<Buffer> {
  const validated = await openValidatedRegularFile(options.path, {
    label: options.label,
    minimumBytes: options.bytes,
    maximumBytes: options.bytes,
    exactBytes: options.bytes,
  })
  const output = Buffer.alloc(options.bytes)
  const hash = createHash('sha256')
  let offset = 0
  try {
    while (offset < output.byteLength) {
      const result = await validated.handle.read(output, offset, Math.min(STREAM_READ_BYTES, output.byteLength - offset), offset)
      if (result.bytesRead < 1) throw new Error(`${options.label} changed while consumed`)
      hash.update(output.subarray(offset, offset + result.bytesRead))
      offset += result.bytesRead
    }
    if (hash.digest('hex') !== options.sha256 || await validated.changed()) throw new Error(`${options.label} digest or identity changed while consumed`)
    return output
  } finally {
    await validated.close()
  }
}

async function verifiedCandidateInputs(options: {
  workDirectory: string
  plan: CompactV31Plan
  runId: string
  receipt: CompactV31MergeReceipt
}): Promise<{
  sketch: CompactV31CountMinSketch
  ownershipIndex: { path: string; bytes: number; sha256: string }
}> {
  const receipt = CompactV31MergeReceiptSchema.parse(options.receipt)
  if (
    receipt.pass !== 'candidate' || receipt.runId !== options.runId ||
    receipt.sourceSnapshotSha256 !== options.plan.sourceSnapshotSha256 ||
    receipt.configurationSha256 !== options.plan.configurationSha256
  ) throw new Error('Exact replay candidate state does not match its plan')
  const sketchReceipt = receipt.outputPartitions.find(({ path }) => path.endsWith('.sketch'))
  if (!sketchReceipt) throw new Error('Candidate merge is missing its fixed-memory sketch')
  const sketchPath = compactPath(options.workDirectory, sketchReceipt.path)
  const sketchBytes = await readVerifiedArtifactBytes({
    path: sketchPath,
    bytes: sketchReceipt.bytes,
    sha256: sketchReceipt.sha256,
    label: 'Merged candidate sketch',
  })
  const ownership = receipt.ownershipIndexes[options.plan.archiveOrdinal]
  if (!ownership || ownership.archiveId !== options.plan.archive.archiveId) {
    throw new Error('Candidate merge is missing this archive ownership index')
  }
  if (ownership.file.bytes !== ownership.ownedRecordCount * ORDINAL_RECORD_BYTES) throw new Error('Candidate ownership index byte count does not reconcile')
  return {
    sketch: CompactV31CountMinSketch.fromBytes(sketchBytes),
    ownershipIndex: {
      path: compactPath(options.workDirectory, ownership.file.path),
      bytes: ownership.file.bytes,
      sha256: ownership.file.sha256,
    },
  }
}

async function atomicallyCommitCheckpoint(options: {
  workDirectory: string
  checkpoint: CompactV31ArchiveCheckpoint
  maximumBytes: number
  ledger: AggregateByteLedger
}): Promise<void> {
  const directory = join(options.workDirectory, 'v31', 'checkpoints', options.checkpoint.runId, options.checkpoint.pass)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = join(directory, `${options.checkpoint.archiveId}.json`)
  const staging = `${destination}.working-${randomUUID()}`
  const bytes = canonicalJsonBytes(options.checkpoint)
  try {
    const existing = await readBoundedRegularFile(destination, options.maximumBytes, 'Existing compact-v3.1 checkpoint', 1)
    if (!existing.equals(bytes)) throw new Error('Existing compact-v3.1 checkpoint conflicts with the committed archive')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeExclusive(staging, bytes, options.maximumBytes, options.ledger)
  try {
    await link(staging, destination)
    await syncCompactParentDirectory(destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readBoundedRegularFile(destination, options.maximumBytes, 'Concurrent compact-v3.1 checkpoint', 1)
    if (!existing.equals(bytes)) throw new Error('Concurrent compact-v3.1 checkpoint conflicts with the committed archive')
  } finally {
    await rm(staging, { force: true })
  }
}

export async function emitCompactV31ArchiveDelta(
  optionsInput: CompactV31ArchiveDeltaOptions,
): Promise<CompactV31ArchiveDeltaResult> {
  const plan = CompactV31PlanSchema.parse(optionsInput.plan)
  if (!RUN_ID.test(optionsInput.runId)) throw new Error('Compact-v3.1 run ID is invalid')
  if (!optionsInput.sourcePath) throw new Error('An explicit local archive path is required')
  if ((plan.archiveOrdinal === 0) !== (optionsInput.previousArchiveDeltaReceiptSha256 === null)) {
    throw new Error('Archive predecessor does not match its canonical ordinal')
  }
  if (
    optionsInput.previousArchiveDeltaReceiptSha256 !== null &&
    !SHA256.test(optionsInput.previousArchiveDeltaReceiptSha256)
  ) throw new Error('Archive predecessor must be a lowercase SHA-256')
  const now = optionsInput.now ?? (() => new Date())
  const boundary = await ensureSecureCompactWorkDirectory(optionsInput.workDirectory, { createV3: false })
  const workDirectory = boundary.workDirectory
  const finalDirectory = join(workDirectory, 'v31', 'deltas', optionsInput.runId, optionsInput.pass, plan.archive.archiveId)
  const stageDirectory = join(workDirectory, 'v31', '.working', `${optionsInput.runId}-${optionsInput.pass}-${plan.archive.archiveId}-${randomUUID()}`)
  assertRelativeTo(workDirectory, finalDirectory, 'Archive delta directory')
  assertRelativeTo(workDirectory, stageDirectory, 'Archive delta staging directory')
  try {
    const existing = await lstat(finalDirectory)
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Committed archive delta must be a non-symbolic-link directory')
    return await readCommittedArchiveDelta({
      plan,
      pass: optionsInput.pass,
      runId: optionsInput.runId,
      workDirectory,
      finalDirectory,
      previousArchiveDeltaReceiptSha256: optionsInput.previousArchiveDeltaReceiptSha256,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(stageDirectory, { recursive: true, mode: 0o700 })
  const workspaceLedger = new AggregateByteLedger(plan.limits.maximumMergeWorkspaceBytes, 'Archive workspace bytes')
  const deltaLedger = new AggregateByteLedger(plan.limits.maximumDeltaBytesPerArchive, 'Archive retained delta bytes', workspaceLedger)
  const receiptLedger = new AggregateByteLedger(plan.limits.maximumReceiptBytes, 'Archive receipt and checkpoint bytes', workspaceLedger)
  const monitor = startCompactV31ResourceMonitor({
    plan,
    observe: optionsInput.observeResources,
    ...(optionsInput.resourceSampleIntervalMs === undefined ? {} : { intervalMs: optionsInput.resourceSampleIntervalMs }),
    now,
  })
  const startedAt = isoNow(now)
  let source: VerifiedRecordStream | null = null
  let ownershipCursor: OwnedOrdinalCursor | null = null
  try {
    // This synchronous sample is the final gate before the archive handle opens.
    await monitor.sampleNow()
    monitor.assertHealthy()
    let candidateSketch: CompactV31CountMinSketch | null = null
    let exactSpill: ExactSpillWriter | null = null
    let ownerSpill: OwnerSpillWriter | null = null
    if (optionsInput.pass === 'candidate') {
      candidateSketch = new CompactV31CountMinSketch()
      ownerSpill = new OwnerSpillWriter(
        stageDirectory,
        plan.partitioning.prefixBits,
        optionsInput.maximumOwnerSortEntries ?? DEFAULT_OWNER_SORT_ENTRIES,
        plan.limits.maximumDeltaBytesPerArchive,
        monitor,
        workspaceLedger,
      )
    } else {
      if (!optionsInput.candidateMergeReceipt) throw new Error('Exact replay requires the complete candidate merge receipt')
      const candidate = await verifiedCandidateInputs({
        workDirectory,
        plan,
        runId: optionsInput.runId,
        receipt: optionsInput.candidateMergeReceipt,
      })
      candidateSketch = candidate.sketch
      ownershipCursor = await OwnedOrdinalCursor.open(candidate.ownershipIndex)
      exactSpill = new ExactSpillWriter(
        stageDirectory,
        plan.partitioning.prefixBits,
        optionsInput.maximumSortEntries ?? DEFAULT_SORT_ENTRIES,
        plan.limits.maximumDeltaBytesPerArchive,
        monitor,
        workspaceLedger,
      )
    }
    source = await openVerifiedRecordStream(resolve(optionsInput.sourcePath), plan, monitor.signal)
    const accounting: {
      recordsSeen: number
      accepted: number
      deduplicated: number
      rejected: Record<string, number>
    } = { recordsSeen: 0, accepted: 0, deduplicated: 0, rejected: {} }
    for await (const record of source.records) {
      monitor.assertHealthy()
      const recordOrdinal = accounting.recordsSeen
      if (recordOrdinal > MAXIMUM_RECORD_ORDINAL) throw new Error('Archive record count exceeds the ownership-index format')
      accounting.recordsSeen += 1
      if (record.rejection || record.pgn === null) {
        incrementRejection(accounting.rejected, record.rejection ?? 'record_too_large')
        if (optionsInput.pass === 'exact' && await ownershipCursor!.owns(recordOrdinal)) {
          throw new Error('Candidate ownership index points at a rejected PGN record')
        }
        continue
      }
      const parsed = parseBroadcastGraphPgn(record.pgn, plan.archive.month)
      if (!parsed.accepted) {
        incrementRejection(accounting.rejected, parsed.reason)
        if (optionsInput.pass === 'exact' && await ownershipCursor!.owns(recordOrdinal)) {
          throw new Error('Candidate ownership index points at a rejected chess game')
        }
        continue
      }
      if (optionsInput.pass === 'candidate') {
        accounting.accepted += 1
        await ownerSpill!.add({
          keySha256: gameIdentityHash(parsed.game),
          archiveOrdinal: plan.archiveOrdinal,
          recordOrdinal,
          corruptionGuardSha256: parsed.game.corruptionGuardSha256,
        })
        const seenAdaptive = new Set<string>()
        forEachGameEvidence(parsed.game, plan.replay.adaptiveEvidenceMaxPly, (row, ply) => {
          const adaptive = row.kind === 'position'
            ? ply > plan.replay.completeBaselineMaxPly
            : ply >= plan.replay.completeBaselineMaxPly
          if (adaptive && !seenAdaptive.has(row.eligibilityKeySha256)) {
            seenAdaptive.add(row.eligibilityKeySha256)
            candidateSketch!.add(row.eligibilityKeySha256)
          }
        })
      } else {
        const owned = await ownershipCursor!.owns(recordOrdinal)
        if (!owned) { accounting.deduplicated += 1; continue }
        accounting.accepted += 1
        const seenExact = new Set<string>()
        const retainedRows: ExactEvidenceRow[] = []
        forEachGameEvidence(parsed.game, plan.replay.adaptiveEvidenceMaxPly, (row, ply) => {
          const baseline = row.kind === 'position'
            ? ply <= plan.replay.completeBaselineMaxPly
            : ply < plan.replay.completeBaselineMaxPly
          if (
            !seenExact.has(row.keySha256) &&
            (baseline || candidateSketch!.estimate(row.eligibilityKeySha256) >= plan.replay.adaptiveCandidateMinimumSample)
          ) {
            seenExact.add(row.keySha256)
            retainedRows.push(row)
          }
        })
        for (const row of retainedRows) await exactSpill!.add(row)
      }
      if (accounting.recordsSeen % 128 === 0) await monitor.sampleNow()
    }
    const compressedInput = await source.completion
    if (ownershipCursor) await ownershipCursor.assertComplete()
    const finalArtifacts: PartitionArtifact[] = []
    if (optionsInput.pass === 'candidate') {
      const ownerRuns = await ownerSpill!.finish()
      const ownerResult = await finalizeOwnerPartitions({
        runs: ownerRuns,
        stageDirectory,
        finalDirectory,
        workDirectory,
        maximumPartitionBytes: plan.limits.maximumPartitionRunBytes,
        monitor,
        outputLedger: deltaLedger,
      })
      await rm(join(stageDirectory, 'owner-runs'), { recursive: true, force: true })
      workspaceLedger.release(ownerSpill!.writtenBytes)
      finalArtifacts.push(...ownerResult.artifacts)
      const sketchBytes = candidateSketch!.toBytes()
      const sketchSha = sha256(sketchBytes)
      const sketchStage = join(stageDirectory, 'partitions', `${sketchSha}.sketch`)
      await writeExclusive(sketchStage, sketchBytes, plan.limits.maximumPartitionRunBytes, deltaLedger)
      const sketchKeys = [keyHash('compact-v31-sketch:first'), keyHash('compact-v31-sketch:last')].sort()
      finalArtifacts.push({
        partition: 'ffff',
        path: relativePosix(workDirectory, join(finalDirectory, relative(stageDirectory, sketchStage))),
        bytes: sketchBytes.byteLength,
        sha256: sketchSha,
        firstKeySha256: sketchKeys[0]!,
        lastKeySha256: sketchKeys[1]!,
        rowCount: candidateSketch!.counters.length,
      })
    } else {
      const exactRuns = await exactSpill!.finish()
      const exactResult = await finalizeExactPartitions({
        runs: exactRuns,
        stageDirectory,
        finalDirectory,
        workDirectory,
        maximumPartitionBytes: plan.limits.maximumPartitionRunBytes,
        monitor,
        outputLedger: deltaLedger,
      })
      await rm(join(stageDirectory, 'exact-runs'), { recursive: true, force: true })
      workspaceLedger.release(exactSpill!.writtenBytes)
      finalArtifacts.push(...exactResult.artifacts)
    }
    finalArtifacts.sort((left, right) => compareCanonical(left.partition, right.partition))
    if (finalArtifacts.length === 0) throw new Error('Archive emitted no evidence partitions')
    const preCommitSample = await monitor.sampleNow()
    const retainedAfterCommit = safeAdd(preCommitSample.retainedDeltaBytes, deltaLedger.currentBytes, 'Retained archive delta bytes')
    if (retainedAfterCommit > plan.limits.maximumRetainedDeltaBytes) {
      throw new Error('Archive commit would exceed the aggregate retained-delta hard cap')
    }
    const resourceSamples = await monitor.stop()
    const persistedResources = resourceSummary(resourceSamples)
    const completedAt = isoNow(now)
    const receipt = CompactV31ArchiveDeltaReceiptSchema.parse({
      schemaVersion: 1,
      kind: 'linerecall-compact-v31-archive-delta',
      storageModel: plan.storageModel,
      pipelineVersion: plan.pipelineVersion,
      executionPurpose: plan.executionPurpose,
      releaseEligible: false,
      runId: optionsInput.runId,
      sourceSnapshotSha256: plan.sourceSnapshotSha256,
      configurationSha256: plan.configurationSha256,
      benchmarkAuthorizationSha256: plan.benchmarkAuthorizationSha256,
      archive: plan.archive,
      archiveOrdinal: plan.archiveOrdinal,
      pass: optionsInput.pass,
      previousArchiveDeltaReceiptSha256: optionsInput.previousArchiveDeltaReceiptSha256,
      compressedInput: { ...compressedInput, verified: true },
      accounting,
      partitions: finalArtifacts,
      startedAt,
      completedAt,
      hardCapReached: false,
      resources: persistedResources,
    })
    const receiptBytes = canonicalJsonBytes(receipt)
    const receiptSha256 = sha256(receiptBytes)
    const checkpoint = CompactV31ArchiveCheckpointSchema.parse({
      schemaVersion: 1,
      kind: 'linerecall-compact-v31-archive-checkpoint',
      storageModel: plan.storageModel,
      pipelineVersion: plan.pipelineVersion,
      executionPurpose: plan.executionPurpose,
      releaseEligible: false,
      runId: optionsInput.runId,
      pass: optionsInput.pass,
      archiveOrdinal: plan.archiveOrdinal,
      archiveId: plan.archive.archiveId,
      planSha256: sha256(canonicalJsonBytes(plan)),
      deltaReceiptSha256: receiptSha256,
      previousArchiveDeltaReceiptSha256: optionsInput.previousArchiveDeltaReceiptSha256,
      committedAt: completedAt,
      resources: persistedResources,
    })
    const checkpointBytes = canonicalJsonBytes(checkpoint)
    const retainedWithReceipt = safeAdd(retainedAfterCommit, receiptBytes.byteLength, 'Retained archive delta bytes')
    if (retainedWithReceipt > plan.limits.maximumRetainedDeltaBytes) {
      throw new Error('Archive receipt would exceed the aggregate retained-delta hard cap')
    }
    if (safeAdd(receiptBytes.byteLength, checkpointBytes.byteLength, 'Archive receipt bytes') > plan.limits.maximumReceiptBytes) {
      throw new Error('Archive receipt and checkpoint exceed their aggregate hard cap')
    }
    await writeExclusive(join(stageDirectory, 'receipt.json'), receiptBytes, plan.limits.maximumReceiptBytes, receiptLedger)
    await mkdir(dirname(finalDirectory), { recursive: true, mode: 0o700 })
    await rename(stageDirectory, finalDirectory)
    await syncCompactParentDirectory(finalDirectory)
    await atomicallyCommitCheckpoint({
      workDirectory,
      checkpoint,
      maximumBytes: plan.limits.maximumReceiptBytes,
      ledger: receiptLedger,
    })
    return { status: 'committed', receipt, receiptSha256, checkpoint, resourceSamples, resources: checkpoint.resources }
  } catch (error) {
    try { await monitor.stop() } catch { /* retain the primary pipeline error */ }
    await rm(stageDirectory, { recursive: true, force: true })
    throw error
  } finally {
    await ownershipCursor?.close()
  }
}

class OrdinalSpillWriter {
  private readonly values = new Map<number, number[]>()
  private readonly runs = new Map<number, SpillRun[]>()
  private entries = 0
  private runNumber = 0
  private totalBytes = 0

  constructor(
    private readonly directory: string,
    private readonly maximumEntries: number,
    private readonly maximumBytes: number,
    private readonly monitor: CompactV31ResourceMonitor,
    private readonly workspaceLedger: AggregateByteLedger,
  ) {}

  get writtenBytes(): number { return this.totalBytes }

  async add(archiveOrdinal: number, recordOrdinal: number): Promise<void> {
    const values = this.values.get(archiveOrdinal) ?? []
    values.push(recordOrdinal)
    this.values.set(archiveOrdinal, values)
    this.entries += 1
    if (this.entries >= this.maximumEntries) await this.flush()
  }

  private async flush(): Promise<void> {
    if (this.entries === 0) return
    this.monitor.assertHealthy()
    for (const [archiveOrdinal, values] of [...this.values.entries()].sort(([left], [right]) => left - right)) {
      values.sort((left, right) => left - right)
      const path = join(this.directory, 'ownership-runs', String(archiveOrdinal).padStart(2, '0'), `${String(this.runNumber).padStart(8, '0')}.bin`)
      this.runNumber += 1
      const encoded: Buffer[] = []
      let previous = -1
      for (const value of values) {
        if (value === previous) continue
        if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_RECORD_ORDINAL) throw new Error('Ownership ordinal is invalid')
        const bytes = Buffer.alloc(ORDINAL_RECORD_BYTES)
        bytes.writeUInt32BE(value, 0)
        encoded.push(bytes)
        previous = value
      }
      const runBytes = encoded.reduce((sum, bytes) => safeAdd(sum, bytes.byteLength, 'Ordinal spill bytes'), 0)
      this.totalBytes = safeAdd(this.totalBytes, runBytes, 'Ordinal workspace bytes')
      if (this.totalBytes > this.maximumBytes) throw new Error('Ownership ordinal spills exceeded their aggregate hard cap')
      await appendExclusive(path, encoded, this.maximumBytes, this.workspaceLedger)
      const runs = this.runs.get(archiveOrdinal) ?? []
      runs.push({
        partition: String(archiveOrdinal).padStart(2, '0'),
        path,
        rows: encoded.length,
        expectedBytes: runBytes,
        expectedSha256: sha256(Buffer.concat(encoded)),
      })
      this.runs.set(archiveOrdinal, runs)
    }
    this.values.clear()
    this.entries = 0
    await this.monitor.sampleNow()
  }

  async finish(): Promise<Map<number, SpillRun[]>> {
    await this.flush()
    return this.runs
  }
}

async function* readOrdinalRun(run: SpillRun): AsyncGenerator<number> {
  if (run.expectedBytes !== run.rows * ORDINAL_RECORD_BYTES) throw new Error('Ownership ordinal run byte/row count does not reconcile')
  const validated = await openValidatedRegularFile(run.path, {
    label: 'Ownership ordinal run',
    minimumBytes: run.expectedBytes,
    maximumBytes: run.expectedBytes,
    exactBytes: run.expectedBytes,
  })
  const hash = createHash('sha256')
  try {
    const bytes = Buffer.alloc(ORDINAL_RECORD_BYTES)
    let previous = -1
    for (let offset = 0; offset < validated.size; offset += ORDINAL_RECORD_BYTES) {
      if ((await validated.handle.read(bytes, 0, ORDINAL_RECORD_BYTES, offset)).bytesRead !== ORDINAL_RECORD_BYTES) {
        throw new Error('Ownership ordinal run changed while reading')
      }
      hash.update(bytes)
      const value = bytes.readUInt32BE(0)
      if (value <= previous) throw new Error('Ownership ordinal run is not strictly sorted')
      previous = value
      yield value
    }
    if (hash.digest('hex') !== run.expectedSha256 || await validated.changed()) {
      throw new Error('Ownership ordinal run digest or identity changed while consumed')
    }
  } finally {
    await validated.close()
  }
}

async function mergeOrdinalRuns(options: {
  runs: readonly SpillRun[]
  stagingPath: string
  maximumBytes: number
  monitor: CompactV31ResourceMonitor
  outputLedger: AggregateByteLedger
}): Promise<{ bytes: number; sha256: string; rows: number }> {
  if (options.runs.length === 0) throw new Error('Every benchmark archive must own at least one accepted record')
  const heads = await initializeHeads(options.runs.map((run) => readOrdinalRun(run)[Symbol.asyncIterator]()))
  const output = await BoundedOutputFile.create(options.stagingPath, options.maximumBytes, options.outputLedger)
  let rows = 0
  let previous = -1
  try {
    while (heads.length > 0) {
      options.monitor.assertHealthy()
      let selected = 0
      for (let index = 1; index < heads.length; index += 1) if (heads[index]!.value < heads[selected]!.value) selected = index
      const value = heads[selected]!.value
      if (value !== previous) {
        const bytes = Buffer.alloc(ORDINAL_RECORD_BYTES)
        bytes.writeUInt32BE(value, 0)
        await output.write(bytes)
        rows += 1
        if (rows % 4096 === 0) await options.monitor.sampleNow()
        previous = value
      }
      for (let index = heads.length - 1; index >= 0; index -= 1) {
        if (heads[index]!.value === value) await advanceHead(heads, index)
      }
    }
    return { bytes: output.bytes, sha256: await output.close(), rows }
  } catch (error) {
    await output.abort()
    throw error
  }
}

export interface CompactV31DeltaInput {
  receipt: CompactV31ArchiveDeltaReceipt
  receiptSha256: string
}

export interface CompactV31ExternalMergeOptions {
  plan: CompactV31Plan
  pass: 'candidate' | 'exact'
  runId: string
  workDirectory: string
  inputs: readonly CompactV31DeltaInput[]
  observeResources: () => Promise<CompactV31ResourceObservation>
  now?: () => Date
  resourceSampleIntervalMs?: number
  maximumSortEntries?: number
}

export interface CompactV31ExternalMergeResult {
  receipt: CompactV31MergeReceipt
  receiptSha256: string
  resourceSamples: readonly ResourceSample[]
  resources: CompactV31ResourceSummary
}

function expectedDeltaRefs(inputs: readonly CompactV31DeltaInput[]): CompactV31MergeReceipt['inputDeltaReceipts'] {
  return inputs.map(({ receipt, receiptSha256 }) => ({
    archiveOrdinal: receipt.archiveOrdinal,
    archiveId: receipt.archive.archiveId,
    receiptSha256,
  }))
}

function sameDeltaRefs(
  left: readonly { archiveOrdinal: number; archiveId: string; receiptSha256: string }[],
  right: readonly { archiveOrdinal: number; archiveId: string; receiptSha256: string }[],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index]
    return other !== undefined && value.archiveOrdinal === other.archiveOrdinal &&
      value.archiveId === other.archiveId && value.receiptSha256 === other.receiptSha256
  })
}

async function readCommittedMerge(options: {
  plan: CompactV31Plan
  pass: 'candidate' | 'exact'
  runId: string
  workDirectory: string
  finalDirectory: string
  inputs: readonly CompactV31DeltaInput[]
}): Promise<CompactV31ExternalMergeResult> {
  const receiptBytes = await readBoundedRegularFile(
    join(options.finalDirectory, 'receipt.json'),
    options.plan.limits.maximumReceiptBytes,
    'Committed compact-v3.1 merge receipt',
    1,
  )
  const receipt = CompactV31MergeReceiptSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)) as unknown)
  if (
    !receiptBytes.equals(canonicalJsonBytes(receipt)) || receipt.pass !== options.pass || receipt.runId !== options.runId ||
    receipt.sourceSnapshotSha256 !== options.plan.sourceSnapshotSha256 ||
    receipt.configurationSha256 !== options.plan.configurationSha256 ||
    !sameDeltaRefs(receipt.inputDeltaReceipts, expectedDeltaRefs(options.inputs))
  ) throw new Error('Committed compact-v3.1 merge receipt does not match this invocation')
  const artifacts = [
    ...receipt.outputPartitions.map((artifact) => artifact),
    ...receipt.ownershipIndexes.map(({ file }) => file),
  ]
  const outputBytes = artifacts.reduce((sum, artifact) => safeAdd(sum, artifact.bytes, 'Committed merge final-state bytes'), 0)
  if (safeAdd(outputBytes, receiptBytes.byteLength, 'Committed merge final-state bytes') > options.plan.limits.maximumFinalStateBytes) {
    throw new Error('Committed compact-v3.1 merge exceeds its aggregate final-state cap')
  }
  for (const artifact of artifacts) {
    const verified = await digestRegularFile(compactPath(options.workDirectory, artifact.path), {
      label: 'Committed compact-v3.1 merge artifact',
      minimumBytes: artifact.bytes,
      maximumBytes: artifact.bytes,
      exactBytes: artifact.bytes,
    })
    if (verified.sha256 !== artifact.sha256) throw new Error('Committed compact-v3.1 merge artifact digest changed')
  }
  return {
    receipt,
    receiptSha256: sha256(receiptBytes),
    resourceSamples: [],
    resources: receipt.resources,
  }
}

async function validateDeltaInputs(options: {
  plan: CompactV31Plan
  pass: 'candidate' | 'exact'
  runId: string
  workDirectory: string
  inputs: readonly CompactV31DeltaInput[]
}): Promise<CompactV31ArchiveDeltaReceipt[]> {
  if (options.inputs.length !== 78) throw new Error('External merge requires all 78 canonical archive deltas')
  const receipts: CompactV31ArchiveDeltaReceipt[] = []
  let previous: string | null = null
  for (const [archiveOrdinal, input] of options.inputs.entries()) {
    const receipt = CompactV31ArchiveDeltaReceiptSchema.parse(input.receipt)
    const observedReceiptSha = sha256(canonicalJsonBytes(receipt))
    if (!SHA256.test(input.receiptSha256) || input.receiptSha256 !== observedReceiptSha) {
      throw new Error(`Archive delta receipt digest differs at ordinal ${archiveOrdinal}`)
    }
    if (
      receipt.archiveOrdinal !== archiveOrdinal || receipt.pass !== options.pass || receipt.runId !== options.runId ||
      receipt.sourceSnapshotSha256 !== options.plan.sourceSnapshotSha256 ||
      receipt.configurationSha256 !== options.plan.configurationSha256 ||
      receipt.benchmarkAuthorizationSha256 !== options.plan.benchmarkAuthorizationSha256 ||
      receipt.previousArchiveDeltaReceiptSha256 !== previous
    ) throw new Error(`Archive delta chain differs at ordinal ${archiveOrdinal}`)
    receipts.push(receipt)
    previous = input.receiptSha256
  }
  return receipts
}

export async function mergeCompactV31ArchiveDeltas(
  optionsInput: CompactV31ExternalMergeOptions,
): Promise<CompactV31ExternalMergeResult> {
  const plan = CompactV31PlanSchema.parse(optionsInput.plan)
  if (!RUN_ID.test(optionsInput.runId)) throw new Error('Compact-v3.1 run ID is invalid')
  const boundary = await ensureSecureCompactWorkDirectory(optionsInput.workDirectory, { createV3: false })
  const workDirectory = boundary.workDirectory
  const finalDirectory = join(workDirectory, 'v31', 'merged', optionsInput.runId, optionsInput.pass)
  const stageDirectory = join(workDirectory, 'v31', '.working', `${optionsInput.runId}-merge-${optionsInput.pass}-${randomUUID()}`)
  const mergedRunDirectory = join(workDirectory, 'v31', 'merged', optionsInput.runId)
  const existingFinalStateBytes = await inventoryRegularTreeBytes(
    mergedRunDirectory,
    workDirectory,
    'Compact-v3.1 merged final state',
  )
  if (existingFinalStateBytes > plan.limits.maximumFinalStateBytes) {
    throw new Error('Committed compact-v3.1 merged states exceed their aggregate final-state cap')
  }
  const receipts = await validateDeltaInputs({
    plan,
    pass: optionsInput.pass,
    runId: optionsInput.runId,
    workDirectory,
    inputs: optionsInput.inputs,
  })
  try {
    const existing = await lstat(finalDirectory)
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Committed merge must be a non-symbolic-link directory')
    return await readCommittedMerge({
      plan,
      pass: optionsInput.pass,
      runId: optionsInput.runId,
      workDirectory,
      finalDirectory,
      inputs: optionsInput.inputs,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(stageDirectory, { recursive: true, mode: 0o700 })
  const workspaceLedger = new AggregateByteLedger(plan.limits.maximumMergeWorkspaceBytes, 'External merge workspace bytes')
  const remainingFinalStateBytes = plan.limits.maximumFinalStateBytes - existingFinalStateBytes
  if (remainingFinalStateBytes < 1) throw new Error('Compact-v3.1 aggregate final-state cap has no remaining capacity')
  const finalStateLedger = new AggregateByteLedger(remainingFinalStateBytes, 'External merge final-state bytes', workspaceLedger)
  const receiptLedger = new AggregateByteLedger(plan.limits.maximumReceiptBytes, 'External merge receipt bytes', finalStateLedger)
  const monitor = startCompactV31ResourceMonitor({
    plan,
    observe: optionsInput.observeResources,
    ...(optionsInput.resourceSampleIntervalMs === undefined ? {} : { intervalMs: optionsInput.resourceSampleIntervalMs }),
    now: optionsInput.now ?? (() => new Date()),
  })
  try {
    await monitor.sampleNow()
    await monitor.sampleNow()
    const grouped = new Map<string, SpillRun[]>()
    for (const receipt of receipts) {
      for (const artifact of receipt.partitions) {
        if (artifact.path.endsWith('.sketch')) continue
        const runs = grouped.get(artifact.partition) ?? []
        runs.push({
          partition: artifact.partition,
          path: compactPath(workDirectory, artifact.path),
          rows: artifact.rowCount,
          expectedBytes: artifact.bytes,
          expectedSha256: artifact.sha256,
        })
        grouped.set(artifact.partition, runs)
      }
    }
    let outputArtifacts: PartitionArtifact[] = []
    let inputRows = 0
    let outputRows = 0
    let duplicateRowsMerged = 0
    const ownershipIndexes: Array<{
      archiveOrdinal: number
      archiveId: string
      ownedRecordCount: number
      file: { path: string; bytes: number; sha256: string }
    }> = []
    if (optionsInput.pass === 'candidate') {
      const ownerResult = await finalizeOwnerPartitions({
        runs: grouped,
        stageDirectory,
        finalDirectory,
        workDirectory,
        maximumPartitionBytes: plan.limits.maximumPartitionRunBytes,
        monitor,
        outputLedger: finalStateLedger,
      })
      outputArtifacts = [...ownerResult.artifacts]
      inputRows = ownerResult.inputRows
      outputRows = ownerResult.outputRows
      duplicateRowsMerged = ownerResult.duplicateRows
      const mergedSketch = new CompactV31CountMinSketch()
      let firstSketch = true
      for (const receipt of receipts) {
        const artifact = receipt.partitions.find(({ path }) => path.endsWith('.sketch'))
        if (!artifact) throw new Error(`Candidate delta ${receipt.archive.archiveId} is missing its sketch`)
        const bytes = await readVerifiedArtifactBytes({
          path: compactPath(workDirectory, artifact.path),
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          label: `Archive candidate sketch ${receipt.archive.archiveId}`,
        })
        const sketch = CompactV31CountMinSketch.fromBytes(bytes)
        if (firstSketch) {
          mergedSketch.counters.set(sketch.counters)
          firstSketch = false
        } else mergedSketch.merge(sketch)
        inputRows += artifact.rowCount
        await monitor.sampleNow()
      }
      const sketchBytes = mergedSketch.toBytes()
      const sketchSha = sha256(sketchBytes)
      const sketchStage = join(stageDirectory, 'partitions', `${sketchSha}.sketch`)
      await writeExclusive(sketchStage, sketchBytes, plan.limits.maximumPartitionRunBytes, finalStateLedger)
      const sketchKeys = [keyHash('compact-v31-sketch:first'), keyHash('compact-v31-sketch:last')].sort()
      outputArtifacts.push({
        partition: 'ffff',
        path: relativePosix(workDirectory, join(finalDirectory, relative(stageDirectory, sketchStage))),
        bytes: sketchBytes.byteLength,
        sha256: sketchSha,
        firstKeySha256: sketchKeys[0]!,
        lastKeySha256: sketchKeys[1]!,
        rowCount: mergedSketch.counters.length,
      })
      outputRows += mergedSketch.counters.length
      duplicateRowsMerged = inputRows - outputRows

      const ordinalWriter = new OrdinalSpillWriter(
        stageDirectory,
        optionsInput.maximumSortEntries ?? DEFAULT_OWNER_SORT_ENTRIES,
        plan.limits.maximumMergeWorkspaceBytes,
        monitor,
        workspaceLedger,
      )
      let ownersRead = 0
      for (const artifact of ownerResult.artifacts) {
        const futurePath = compactPath(workDirectory, artifact.path)
        const stagePath = join(stageDirectory, relative(finalDirectory, futurePath))
        for await (const owner of readOwnerRun({
          partition: artifact.partition,
          path: stagePath,
          rows: artifact.rowCount,
          expectedBytes: artifact.bytes,
          expectedSha256: artifact.sha256,
        })) {
          await ordinalWriter.add(owner.archiveOrdinal, owner.recordOrdinal)
          ownersRead += 1
          if (ownersRead % 4096 === 0) await monitor.sampleNow()
        }
      }
      const ordinalRuns = await ordinalWriter.finish()
      for (let archiveOrdinal = 0; archiveOrdinal < 78; archiveOrdinal += 1) {
        const absoluteMonth = 2020 * 12 + archiveOrdinal
        const archiveId = `broadcast-${Math.floor(absoluteMonth / 12)}-${String((absoluteMonth % 12) + 1).padStart(2, '0')}`
        const partial = join(stageDirectory, 'ownership', `${archiveId}.partial`)
        const merged = await mergeOrdinalRuns({
          runs: ordinalRuns.get(archiveOrdinal) ?? [],
          stagingPath: partial,
          maximumBytes: plan.limits.maximumPartitionRunBytes,
          monitor,
          outputLedger: finalStateLedger,
        })
        const addressed = await contentAddressOutput(partial, merged.sha256, 'ordinals')
        ownershipIndexes.push({
          archiveOrdinal,
          archiveId,
          ownedRecordCount: merged.rows,
          file: {
            path: relativePosix(workDirectory, join(finalDirectory, relative(stageDirectory, addressed))),
            bytes: merged.bytes,
            sha256: merged.sha256,
          },
        })
      }
      await rm(join(stageDirectory, 'ownership-runs'), { recursive: true, force: true })
      workspaceLedger.release(ordinalWriter.writtenBytes)
    } else {
      const exactResult = await finalizeExactPartitions({
        runs: grouped,
        stageDirectory,
        finalDirectory,
        workDirectory,
        maximumPartitionBytes: plan.limits.maximumPartitionRunBytes,
        monitor,
        outputLedger: finalStateLedger,
      })
      outputArtifacts = exactResult.artifacts
      inputRows = exactResult.inputRows
      outputRows = exactResult.outputRows
      duplicateRowsMerged = exactResult.duplicateRows
    }
    outputArtifacts.sort((left, right) => compareCanonical(left.partition, right.partition))
    await monitor.sampleNow()
    const resourceSamples = await monitor.stop()
    const persistedResources = resourceSummary(resourceSamples)
    const receipt = CompactV31MergeReceiptSchema.parse({
      schemaVersion: 1,
      kind: 'linerecall-compact-v31-external-merge',
      storageModel: plan.storageModel,
      pipelineVersion: plan.pipelineVersion,
      executionPurpose: plan.executionPurpose,
      releaseEligible: false,
      runId: optionsInput.runId,
      pass: optionsInput.pass,
      sourceSnapshotSha256: plan.sourceSnapshotSha256,
      configurationSha256: plan.configurationSha256,
      inputDeltaReceipts: optionsInput.inputs.map(({ receipt, receiptSha256 }) => ({
        archiveOrdinal: receipt.archiveOrdinal,
        archiveId: receipt.archive.archiveId,
        receiptSha256,
      })),
      outputPartitions: outputArtifacts,
      ownershipIndexes,
      inputRows,
      outputRows,
      duplicateRowsMerged,
      completedAt: isoNow(optionsInput.now ?? (() => new Date())),
      resources: persistedResources,
    })
    const receiptBytes = canonicalJsonBytes(receipt)
    const receiptSha256 = sha256(receiptBytes)
    await writeExclusive(join(stageDirectory, 'receipt.json'), receiptBytes, plan.limits.maximumReceiptBytes, receiptLedger)
    await mkdir(dirname(finalDirectory), { recursive: true, mode: 0o700 })
    await rename(stageDirectory, finalDirectory)
    await syncCompactParentDirectory(finalDirectory)
    return { receipt, receiptSha256, resourceSamples, resources: persistedResources }
  } catch (error) {
    try { await monitor.stop() } catch { /* keep primary merge failure */ }
    await rm(stageDirectory, { recursive: true, force: true })
    throw error
  }
}

export interface CompactV31RunReceiptOptions {
  plan: CompactV31Plan
  runId: string
  planReviewSha256: string
  workDirectory: string
  candidateDeltas: readonly CompactV31DeltaInput[]
  candidateMerge: CompactV31ExternalMergeResult
  exactDeltas: readonly CompactV31DeltaInput[]
  exactMerge: CompactV31ExternalMergeResult
  startedAt: string
  completedAt: string
}

export interface CompactV31WrittenRunReceipt {
  receipt: CompactV31RunReceipt
  receiptSha256: string
  path: string
}

function accountingDigest(
  candidateDeltas: readonly CompactV31DeltaInput[],
  exactDeltas: readonly CompactV31DeltaInput[],
): string {
  return sha256(canonicalJsonBytes({
    candidate: candidateDeltas.map(({ receipt }) => ({
      archiveOrdinal: receipt.archiveOrdinal,
      archiveId: receipt.archive.archiveId,
      accounting: receipt.accounting,
    })),
    exact: exactDeltas.map(({ receipt }) => ({
      archiveOrdinal: receipt.archiveOrdinal,
      archiveId: receipt.archive.archiveId,
      accounting: receipt.accounting,
    })),
  }))
}

export async function writeCompactV31RunReceipt(
  options: CompactV31RunReceiptOptions,
): Promise<CompactV31WrittenRunReceipt> {
  const plan = CompactV31PlanSchema.parse(options.plan)
  if (!RUN_ID.test(options.runId)) throw new Error('Compact-v3.1 run ID is invalid')
  if (!SHA256.test(options.planReviewSha256)) throw new Error('Run receipt requires the authenticated plan-review SHA-256')
  const validateRefs = (inputs: readonly CompactV31DeltaInput[], pass: 'candidate' | 'exact'): void => {
    if (inputs.length !== 78) throw new Error(`Run receipt requires 78 ${pass} deltas`)
    let previous: string | null = null
    for (const [index, input] of inputs.entries()) {
      const receipt = CompactV31ArchiveDeltaReceiptSchema.parse(input.receipt)
      if (
        receipt.runId !== options.runId || receipt.pass !== pass || receipt.archiveOrdinal !== index ||
        receipt.sourceSnapshotSha256 !== plan.sourceSnapshotSha256 ||
        receipt.configurationSha256 !== plan.configurationSha256 ||
        receipt.benchmarkAuthorizationSha256 !== plan.benchmarkAuthorizationSha256 ||
        receipt.previousArchiveDeltaReceiptSha256 !== previous ||
        sha256(canonicalJsonBytes(receipt)) !== input.receiptSha256
      ) throw new Error(`Run receipt ${pass} delta chain is invalid at ordinal ${index}`)
      previous = input.receiptSha256
    }
  }
  validateRefs(options.candidateDeltas, 'candidate')
  validateRefs(options.exactDeltas, 'exact')
  const candidateMerge = CompactV31MergeReceiptSchema.parse(options.candidateMerge.receipt)
  const exactMerge = CompactV31MergeReceiptSchema.parse(options.exactMerge.receipt)
  if (
    candidateMerge.pass !== 'candidate' || exactMerge.pass !== 'exact' ||
    candidateMerge.runId !== options.runId || exactMerge.runId !== options.runId ||
    candidateMerge.sourceSnapshotSha256 !== plan.sourceSnapshotSha256 ||
    exactMerge.sourceSnapshotSha256 !== plan.sourceSnapshotSha256 ||
    candidateMerge.configurationSha256 !== plan.configurationSha256 ||
    exactMerge.configurationSha256 !== plan.configurationSha256 ||
    !sameDeltaRefs(candidateMerge.inputDeltaReceipts, expectedDeltaRefs(options.candidateDeltas)) ||
    !sameDeltaRefs(exactMerge.inputDeltaReceipts, expectedDeltaRefs(options.exactDeltas)) ||
    sha256(canonicalJsonBytes(candidateMerge)) !== options.candidateMerge.receiptSha256 ||
    sha256(canonicalJsonBytes(exactMerge)) !== options.exactMerge.receiptSha256
  ) throw new Error('Run receipt merge bindings are invalid')
  for (let index = 0; index < 78; index += 1) {
    const candidate = options.candidateDeltas[index]!.receipt
    const exact = options.exactDeltas[index]!.receipt
    if (
      candidate.accounting.recordsSeen !== exact.accounting.recordsSeen ||
      canonicalJsonBytes(candidate.accounting.rejected).compare(canonicalJsonBytes(exact.accounting.rejected)) !== 0 ||
      candidate.accounting.accepted !== exact.accounting.accepted + exact.accounting.deduplicated ||
      candidate.compressedInput.bytes !== exact.compressedInput.bytes ||
      candidate.compressedInput.sha256 !== exact.compressedInput.sha256
    ) throw new Error(`Candidate/exact archive accounting differs at ordinal ${index}`)
  }
  const expectedMergeRows = (inputs: readonly CompactV31DeltaInput[]): number => inputs.reduce(
    (sum, { receipt }) => receipt.partitions.reduce(
      (inner, artifact) => safeAdd(inner, artifact.rowCount, 'Merge input rows'),
      sum,
    ),
    0,
  )
  const observedMergeRows = (merge: CompactV31MergeReceipt): number => merge.outputPartitions.reduce(
    (sum, artifact) => safeAdd(sum, artifact.rowCount, 'Merge output rows'),
    0,
  )
  if (
    candidateMerge.inputRows !== expectedMergeRows(options.candidateDeltas) ||
    exactMerge.inputRows !== expectedMergeRows(options.exactDeltas) ||
    candidateMerge.outputRows !== observedMergeRows(candidateMerge) ||
    exactMerge.outputRows !== observedMergeRows(exactMerge) ||
    candidateMerge.ownershipIndexes.reduce((sum, index) => safeAdd(sum, index.ownedRecordCount, 'Owned records'), 0) !==
      options.exactDeltas.reduce((sum, { receipt }) => safeAdd(sum, receipt.accounting.accepted, 'Exact accepted games'), 0)
  ) throw new Error('Run receipt merge row accounting does not reconcile with its inputs')
  const persistedResourceSummaries = [
    ...options.candidateDeltas.map(({ receipt }) => receipt.resources),
    candidateMerge.resources,
    ...options.exactDeltas.map(({ receipt }) => receipt.resources),
    exactMerge.resources,
  ]
  const resourceSampleCount = persistedResourceSummaries.reduce((sum, summary) => safeAdd(sum, summary.sampleCount, 'Resource sample count'), 0)
  const maximumObservedWorkerResidentBytes = Math.max(...persistedResourceSummaries.map((summary) => summary.maximumObservedWorkerResidentBytes))
  const minimumObservedFreeStorageBytes = Math.min(...persistedResourceSummaries.map((summary) => summary.minimumObservedFreeStorageBytes))
  const receipt = CompactV31RunReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-benchmark-run',
    storageModel: plan.storageModel,
    pipelineVersion: plan.pipelineVersion,
    executionPurpose: plan.executionPurpose,
    releaseEligible: false,
    runId: options.runId,
    sourceSnapshotSha256: plan.sourceSnapshotSha256,
    configurationSha256: plan.configurationSha256,
    benchmarkAuthorizationSha256: plan.benchmarkAuthorizationSha256,
    planReviewSha256: options.planReviewSha256,
    cleanWorkDirectory: true,
    sourceArchiveCount: 78,
    publishedGames: 1_146_297,
    candidateDeltaReceipts: options.candidateDeltas.map(({ receipt, receiptSha256 }) => ({
      archiveOrdinal: receipt.archiveOrdinal,
      archiveId: receipt.archive.archiveId,
      receiptSha256,
    })),
    candidateMergeReceiptSha256: options.candidateMerge.receiptSha256,
    exactDeltaReceipts: options.exactDeltas.map(({ receipt, receiptSha256 }) => ({
      archiveOrdinal: receipt.archiveOrdinal,
      archiveId: receipt.archive.archiveId,
      receiptSha256,
    })),
    exactMergeReceiptSha256: options.exactMerge.receiptSha256,
    accountingSha256: accountingDigest(options.candidateDeltas, options.exactDeltas),
    allArchiveDigestsVerified: true,
    resourceSampleCount,
    maximumObservedWorkerResidentBytes,
    minimumObservedFreeStorageBytes,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    hardCapReached: false,
  })
  const bytes = canonicalJsonBytes(receipt)
  const receiptSha256 = sha256(bytes)
  const directory = join(resolve(options.workDirectory), 'v31', 'runs', options.runId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${receiptSha256}.json`)
  try {
    const existing = await readBoundedRegularFile(path, plan.limits.maximumReceiptBytes, 'Existing compact-v3.1 run receipt', 1)
    if (!existing.equals(bytes)) throw new Error('Existing compact-v3.1 run receipt conflicts with the completed run')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeExclusive(path, bytes, plan.limits.maximumReceiptBytes)
  }
  await syncCompactParentDirectory(path)
  return { receipt, receiptSha256, path }
}

function mergeStateDigest(receipt: CompactV31MergeReceipt): string {
  return sha256(canonicalJsonBytes({
    pass: receipt.pass,
    outputPartitions: receipt.outputPartitions.map(({ partition, bytes, sha256: digest, firstKeySha256, lastKeySha256, rowCount }) => ({
      partition, bytes, sha256: digest, firstKeySha256, lastKeySha256, rowCount,
    })),
    ownershipIndexes: receipt.ownershipIndexes.map(({ archiveOrdinal, archiveId, ownedRecordCount, file }) => ({
      archiveOrdinal, archiveId, ownedRecordCount, bytes: file.bytes, sha256: file.sha256,
    })),
    inputRows: receipt.inputRows,
    outputRows: receipt.outputRows,
    duplicateRowsMerged: receipt.duplicateRowsMerged,
  }))
}

export interface CompactV31RepeatabilityOptions {
  first: CompactV31WrittenRunReceipt
  second: CompactV31WrittenRunReceipt
  firstCandidateMerge: CompactV31MergeReceipt
  secondCandidateMerge: CompactV31MergeReceipt
  firstExactMerge: CompactV31MergeReceipt
  secondExactMerge: CompactV31MergeReceipt
  outputPath: string
  comparedAt: string
  maximumBytes: number
}

export async function writeCompactV31RepeatabilityBinding(
  options: CompactV31RepeatabilityOptions,
): Promise<{ binding: CompactV31RepeatabilityBinding; sha256: string; path: string }> {
  const first = CompactV31RunReceiptSchema.parse(options.first.receipt)
  const second = CompactV31RunReceiptSchema.parse(options.second.receipt)
  if (
    options.first.receiptSha256 !== sha256(canonicalJsonBytes(first)) ||
    options.second.receiptSha256 !== sha256(canonicalJsonBytes(second))
  ) throw new Error('Repeatability input run receipt digest changed')
  const firstCandidate = CompactV31MergeReceiptSchema.parse(options.firstCandidateMerge)
  const secondCandidate = CompactV31MergeReceiptSchema.parse(options.secondCandidateMerge)
  const firstExact = CompactV31MergeReceiptSchema.parse(options.firstExactMerge)
  const secondExact = CompactV31MergeReceiptSchema.parse(options.secondExactMerge)
  if (
    first.runId === second.runId || first.sourceSnapshotSha256 !== second.sourceSnapshotSha256 ||
    first.configurationSha256 !== second.configurationSha256 ||
    first.benchmarkAuthorizationSha256 !== second.benchmarkAuthorizationSha256 ||
    first.planReviewSha256 !== second.planReviewSha256 ||
    first.accountingSha256 !== second.accountingSha256
  ) throw new Error('Repeatability runs are not independent executions of one configuration')
  if (
    firstCandidate.runId !== first.runId || firstExact.runId !== first.runId ||
    secondCandidate.runId !== second.runId || secondExact.runId !== second.runId ||
    firstCandidate.pass !== 'candidate' || secondCandidate.pass !== 'candidate' ||
    firstExact.pass !== 'exact' || secondExact.pass !== 'exact'
  ) throw new Error('Repeatability merge receipts do not belong to their run receipts')
  if (
    first.candidateMergeReceiptSha256 !== sha256(canonicalJsonBytes(firstCandidate)) ||
    first.exactMergeReceiptSha256 !== sha256(canonicalJsonBytes(firstExact)) ||
    second.candidateMergeReceiptSha256 !== sha256(canonicalJsonBytes(secondCandidate)) ||
    second.exactMergeReceiptSha256 !== sha256(canonicalJsonBytes(secondExact))
  ) throw new Error('Repeatability run receipts do not bind their merge receipts')
  const firstCandidateSha = mergeStateDigest(firstCandidate)
  const secondCandidateSha = mergeStateDigest(secondCandidate)
  const firstExactSha = mergeStateDigest(firstExact)
  const secondExactSha = mergeStateDigest(secondExact)
  if (firstCandidateSha !== secondCandidateSha || firstExactSha !== secondExactSha) {
    throw new Error('Compact-v3.1 runs are not byte-identical')
  }
  const binding = CompactV31RepeatabilityBindingSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-repeatability-binding',
    releaseEligible: false,
    firstRunId: first.runId,
    secondRunId: second.runId,
    firstRunReceiptSha256: options.first.receiptSha256,
    secondRunReceiptSha256: options.second.receiptSha256,
    sourceSnapshotSha256: first.sourceSnapshotSha256,
    configurationSha256: first.configurationSha256,
    benchmarkAuthorizationSha256: first.benchmarkAuthorizationSha256,
    planReviewSha256: first.planReviewSha256,
    candidateMergeSha256: firstCandidateSha,
    exactMergeSha256: firstExactSha,
    accountingSha256: first.accountingSha256,
    result: 'byte-identical',
    comparedAt: options.comparedAt,
    note: 'Two independent clean-directory broadcast runs produced byte-identical candidate state, exact state, and accounting. The result remains provisional, non-promotable, and release-ineligible pending separate review.',
  })
  const bytes = canonicalJsonBytes(binding)
  const destination = resolve(options.outputPath)
  const digest = sha256(bytes)
  await writeExclusive(destination, bytes, options.maximumBytes)
  await syncCompactParentDirectory(destination)
  return { binding, sha256: digest, path: destination }
}

export interface CompactV31BenchmarkRunOptions {
  plans: readonly CompactV31Plan[]
  planReview: CompactV31PlanReview
  planReviewSha256: string
  sourcePaths: readonly string[]
  workDirectory: string
  runId: string
  now?: () => Date
  resourceSampleIntervalMs?: number
}

export async function initializeCompactV31RunDirectory(options: {
  workDirectory: string
  runId: string
  plan: CompactV31Plan
  planReviewSha256: string
  now?: () => Date
}): Promise<{ bootstrap: CompactV31RunBootstrap; resumed: boolean }> {
  const plan = CompactV31PlanSchema.parse(options.plan)
  if (!RUN_ID.test(options.runId)) throw new Error('Compact-v3.1 run ID is invalid')
  if (!SHA256.test(options.planReviewSha256)) throw new Error('Compact-v3.1 plan-review SHA-256 is invalid')
  const boundary = await ensureSecureCompactWorkDirectory(options.workDirectory, { createV3: false })
  const workDirectory = boundary.workDirectory
  const markerPath = join(workDirectory, 'compact-v31-run.json')
  const entries = await readdir(workDirectory)
  const expected = CompactV31RunBootstrapSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-run-bootstrap',
    storageModel: plan.storageModel,
    pipelineVersion: plan.pipelineVersion,
    executionPurpose: plan.executionPurpose,
    releaseEligible: false,
    runId: options.runId,
    sourceSnapshotSha256: plan.sourceSnapshotSha256,
    configurationSha256: plan.configurationSha256,
    benchmarkAuthorizationSha256: plan.benchmarkAuthorizationSha256,
    planReviewSha256: options.planReviewSha256,
    initialWorkDirectoryEmpty: true,
    createdAt: isoNow(options.now ?? (() => new Date())),
  })
  if (entries.length === 0) {
    await writeExclusive(markerPath, canonicalJsonBytes(expected), plan.limits.maximumReceiptBytes)
    await syncCompactParentDirectory(markerPath)
    return { bootstrap: expected, resumed: false }
  }
  if (entries.some((name) => name !== 'compact-v31-run.json' && name !== 'v31')) {
    throw new Error('Benchmark work directory contains content outside its resumable compact-v3.1 run')
  }
  const bytes = await readBoundedRegularFile(markerPath, plan.limits.maximumReceiptBytes, 'Compact-v3.1 run bootstrap', 1)
  const bootstrap = CompactV31RunBootstrapSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
  )
  if (
    !bytes.equals(canonicalJsonBytes(bootstrap)) || bootstrap.runId !== options.runId ||
    bootstrap.sourceSnapshotSha256 !== plan.sourceSnapshotSha256 ||
    bootstrap.configurationSha256 !== plan.configurationSha256 ||
    bootstrap.benchmarkAuthorizationSha256 !== plan.benchmarkAuthorizationSha256 ||
    bootstrap.planReviewSha256 !== options.planReviewSha256
  ) throw new Error('Existing compact-v3.1 run bootstrap does not match this invocation')
  const v31Path = join(workDirectory, 'v31')
  const resumableContainers = new Set(['.working', 'checkpoints', 'deltas', 'merged', 'runs'])
  try {
    const entry = await lstat(v31Path)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Compact-v3.1 resume root must be a regular directory')
    for (const name of await readdir(v31Path)) {
      if (!resumableContainers.has(name)) {
        throw new Error('Compact-v3.1 resume root contains an unrecognized entry')
      }
      const containerPath = join(v31Path, name)
      const container = await lstat(containerPath)
      if (!container.isDirectory() || container.isSymbolicLink()) {
        throw new Error('Compact-v3.1 resume container must be a regular directory')
      }
      if (name === '.working') continue
      for (const childName of await readdir(containerPath)) {
        if (childName !== options.runId) {
          throw new Error('Compact-v3.1 resume container contains committed state from another run')
        }
        const child = await lstat(join(containerPath, childName))
        if (!child.isDirectory() || child.isSymbolicLink()) {
          throw new Error('Compact-v3.1 committed run entry must be a regular directory')
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const working = join(v31Path, '.working')
  try {
    const entry = await lstat(working)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Compact-v3.1 staging root must be a regular directory')
    for (const name of await readdir(working)) {
      if (!name.startsWith(`${options.runId}-`)) {
        throw new Error('Compact-v3.1 staging root contains work from another run')
      }
      const path = join(working, name)
      const child = await lstat(path)
      if (!child.isDirectory() || child.isSymbolicLink()) throw new Error('Compact-v3.1 staging entry must be a regular directory')
      await rm(path, { recursive: true })
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { bootstrap, resumed: true }
}

export async function observeCompactV31WorkResources(
  workDirectoryValue: string,
  retainedDeltaBytes: number,
): Promise<CompactV31ResourceObservation> {
  const filesystem = await statfs(resolve(workDirectoryValue), { bigint: true })
  const available = filesystem.bavail * filesystem.bsize
  if (available > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Available storage exceeds the safe integer range')
  return {
    availableStorageBytes: Number(available),
    retainedDeltaBytes,
    availableMemoryBytes: freemem(),
    workerResidentBytes: process.memoryUsage().rss,
  }
}

/**
 * Complete one provisional benchmark replay. This never downloads, promotes,
 * or deletes an archive. Every source path must be supplied explicitly.
 */
export async function runCompactV31BenchmarkOnce(
  options: CompactV31BenchmarkRunOptions,
): Promise<{
  run: CompactV31WrittenRunReceipt
  candidateMerge: CompactV31ExternalMergeResult
  exactMerge: CompactV31ExternalMergeResult
}> {
  if (!RUN_ID.test(options.runId)) throw new Error('Compact-v3.1 run ID is invalid')
  if (!SHA256.test(options.planReviewSha256)) throw new Error('Benchmark run requires an authenticated plan-review SHA-256')
  if (options.plans.length !== 78 || options.sourcePaths.length !== 78) {
    throw new Error('Benchmark run requires 78 plans and 78 explicit local archive paths')
  }
  const plans = options.plans.map((plan, archiveOrdinal) => {
    const parsed = CompactV31PlanSchema.parse(plan)
    if (parsed.archiveOrdinal !== archiveOrdinal) throw new Error('Benchmark plans are not in canonical archive order')
    return parsed
  })
  const first = plans[0]!
  const planReview = CompactV31PlanReviewSchema.parse(options.planReview)
  if (sha256(canonicalJsonBytes(planReview)) !== options.planReviewSha256) {
    throw new Error('Benchmark plan-review digest does not match its authenticated bytes')
  }
  if (plans.some((plan) =>
    plan.sourceSnapshotSha256 !== first.sourceSnapshotSha256 ||
    plan.configurationSha256 !== first.configurationSha256 ||
    plan.benchmarkAuthorizationSha256 !== first.benchmarkAuthorizationSha256
  )) throw new Error('Benchmark plans do not share one frozen configuration')
  if (
    planReview.sourceSnapshotSha256 !== first.sourceSnapshotSha256 ||
    planReview.configurationSha256 !== first.configurationSha256 ||
    planReview.benchmarkAuthorizationSha256 !== first.benchmarkAuthorizationSha256 ||
    planReview.plans.some((listed, index) => {
      const plan = plans[index]!
      const bytes = canonicalJsonBytes(plan)
      return listed.archiveId !== plan.archive.archiveId || listed.archiveOrdinal !== index ||
        listed.path !== `${plan.archive.archiveId}.json` || listed.bytes !== bytes.byteLength ||
        listed.sha256 !== sha256(bytes)
    })
  ) throw new Error('Benchmark plan-review does not authenticate the supplied plan bundle')
  const workDirectory = resolve(options.workDirectory)
  const runDirectory = await initializeCompactV31RunDirectory({
    workDirectory,
    runId: options.runId,
    plan: first,
    planReviewSha256: options.planReviewSha256,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const startedAt = runDirectory.bootstrap.createdAt
  let retainedDeltaBytes = 0
  const observe = (): Promise<CompactV31ResourceObservation> => observeCompactV31WorkResources(workDirectory, retainedDeltaBytes)
  const candidateDeltas: CompactV31DeltaInput[] = []
  let previous: string | null = null
  for (const [archiveOrdinal, plan] of plans.entries()) {
    const preflight = await assessCompactV31WorkDirectory(plan, workDirectory)
    retainedDeltaBytes = preflight.retainedDeltaBytes
    if (!preflight.safeToStart) throw new Error(`Archive ${plan.archive.archiveId} preflight blocked: ${preflight.reasonCode}`)
    const delta = await emitCompactV31ArchiveDelta({
      plan,
      pass: 'candidate',
      runId: options.runId,
      workDirectory,
      sourcePath: options.sourcePaths[archiveOrdinal]!,
      previousArchiveDeltaReceiptSha256: previous,
      observeResources: observe,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.resourceSampleIntervalMs === undefined ? {} : { resourceSampleIntervalMs: options.resourceSampleIntervalMs }),
    })
    candidateDeltas.push({ receipt: delta.receipt, receiptSha256: delta.receiptSha256 })
    retainedDeltaBytes = (await assessCompactV31WorkDirectory(plan, workDirectory)).retainedDeltaBytes
    previous = delta.receiptSha256
  }
  const candidateMerge = await mergeCompactV31ArchiveDeltas({
    plan: first,
    pass: 'candidate',
    runId: options.runId,
    workDirectory,
    inputs: candidateDeltas,
    observeResources: observe,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.resourceSampleIntervalMs === undefined ? {} : { resourceSampleIntervalMs: options.resourceSampleIntervalMs }),
  })
  const exactDeltas: CompactV31DeltaInput[] = []
  previous = null
  for (const [archiveOrdinal, plan] of plans.entries()) {
    const preflight = await assessCompactV31WorkDirectory(plan, workDirectory)
    retainedDeltaBytes = preflight.retainedDeltaBytes
    if (!preflight.safeToStart) throw new Error(`Exact archive ${plan.archive.archiveId} preflight blocked: ${preflight.reasonCode}`)
    const delta = await emitCompactV31ArchiveDelta({
      plan,
      pass: 'exact',
      runId: options.runId,
      workDirectory,
      sourcePath: options.sourcePaths[archiveOrdinal]!,
      previousArchiveDeltaReceiptSha256: previous,
      candidateMergeReceipt: candidateMerge.receipt,
      observeResources: observe,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.resourceSampleIntervalMs === undefined ? {} : { resourceSampleIntervalMs: options.resourceSampleIntervalMs }),
    })
    exactDeltas.push({ receipt: delta.receipt, receiptSha256: delta.receiptSha256 })
    retainedDeltaBytes = (await assessCompactV31WorkDirectory(plan, workDirectory)).retainedDeltaBytes
    previous = delta.receiptSha256
  }
  const exactMerge = await mergeCompactV31ArchiveDeltas({
    plan: first,
    pass: 'exact',
    runId: options.runId,
    workDirectory,
    inputs: exactDeltas,
    observeResources: observe,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.resourceSampleIntervalMs === undefined ? {} : { resourceSampleIntervalMs: options.resourceSampleIntervalMs }),
  })
  const completedAt = isoNow(options.now ?? (() => new Date()))
  const run = await writeCompactV31RunReceipt({
    plan: first,
    runId: options.runId,
    planReviewSha256: options.planReviewSha256,
    workDirectory,
    candidateDeltas,
    candidateMerge,
    exactDeltas,
    exactMerge,
    startedAt,
    completedAt,
  })
  return { run, candidateMerge, exactMerge }
}

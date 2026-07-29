import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { Chess, type Move } from 'chess.js'
import {
  ADAPTIVE_CANDIDATE_MINIMUM_SAMPLE,
  ADAPTIVE_EVIDENCE_MAX_PLY,
  COMPLETE_BASELINE_MAX_PLY,
  CompactArchiveCheckpointSchema,
  CompactPassReceiptSchema,
  CompactPreflightPlanSchema,
  type BookTerminalStatus,
  type CompactArchiveCheckpoint,
  type CompactExecutionPurpose,
  type CompactPassReceipt,
  type CompactPreflightPlan,
} from './compact-v3-contracts.ts'
import { normalizedEpd } from './broadcast-pgn.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const COHORT_ID = /^cohort_[a-z0-9-]{3,64}$/u
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/u
const UINT32_MAX = 0xffff_ffff

function pragmaInteger(database: DatabaseSync, name: 'page_count' | 'page_size' | 'max_page_count'): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  const value = row ? Object.values(row)[0] : undefined
  const minimum = name === 'page_count' ? 0 : 1
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`SQLite ${name} did not return a safe integer of at least ${minimum}`)
  }
  return value as number
}

/**
 * Adapter working databases are disposable copies: only a fully processed,
 * hashed shard is promoted. Keeping their rollback journal on disk would let a
 * single archive transaction grow beyond the advertised spill cap before the
 * end-of-pass size check. Disable that disposable journal and let SQLite's
 * max-page count enforce the main-file byte ceiling while writes are occurring.
 *
 * Standalone stores retain SQLite's durable WAL behavior when no byte cap is
 * supplied.
 */
function configureWorkingDatabaseByteCap(
  database: DatabaseSync,
  maximumBytes: number | undefined,
  label: string,
): void {
  if (maximumBytes === undefined) return
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error(`${label} byte hard cap must be a positive safe integer`)
  }
  database.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;')
  const pageSize = pragmaInteger(database, 'page_size')
  const currentPages = pragmaInteger(database, 'page_count')
  const maximumPages = Math.floor(maximumBytes / pageSize)
  if (maximumPages < currentPages || maximumPages < 1) {
    throw new Error(`${label} existing state exceeds its byte hard cap`)
  }
  database.exec(`PRAGMA max_page_count = ${maximumPages}`)
  const appliedMaximumPages = pragmaInteger(database, 'max_page_count')
  if (appliedMaximumPages > maximumPages) {
    throw new Error(`${label} SQLite page cap was not enforced`)
  }
}

function rollbackSqliteTransaction(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch (error) {
    // SQLITE_FULL may already have rolled back the transaction. The entire
    // working database is disposable, so an absent transaction is equivalent
    // to the requested rollback; every other SQLite failure remains fatal.
    if (!/no transaction is active/iu.test((error as Error).message)) throw error
  }
}

export type CompactEvidenceKind = 'position' | 'edge'

export interface PositionIdentity {
  kind: 'position'
  epd: string
}

export interface EdgeIdentity {
  kind: 'edge'
  fromEpd: string
  uci: string
  toEpd: string
}

export type CompactEvidenceIdentity = PositionIdentity | EdgeIdentity

export interface CandidateObservation {
  identity: CompactEvidenceIdentity
  cohortId: string
  ply: number
}

export interface ExactObservation extends CandidateObservation {
  month: string
  timeControl: 'blitz' | 'rapid' | 'classical' | 'unknown'
  ratingBand: '<1800' | '1800-1999' | '2000-2199' | '2200-2399' | '2400+'
  ratingDetail: '' | '<1200' | '1200-1499' | '1500-1799'
  result: '1-0' | '0-1' | '1/2-1/2'
  san?: string
}

export interface CompactReplayObservation {
  identity: CompactEvidenceIdentity
  /** Absolute ply of the reached position; an edge at 31 is adaptive. */
  ply: number
  san?: string
}

export interface CompactReplayMove {
  from: Move['from']
  to: Move['to']
  promotion?: Move['promotion']
}

export type ResumeAction = 'candidate' | 'exact' | 'complete'

function assertEpd(epd: string): void {
  if (epd.trim() !== epd || epd.split(/\s+/u).length !== 4 || epd.includes('\0')) {
    throw new Error('Evidence identity contains an invalid normalized EPD')
  }
}

function assertIdentity(identity: CompactEvidenceIdentity): void {
  if (identity.kind === 'position') return assertEpd(identity.epd)
  assertEpd(identity.fromEpd)
  assertEpd(identity.toEpd)
  if (!UCI.test(identity.uci)) throw new Error('Evidence identity contains an invalid UCI move')
}

function uciForCompactMove(move: CompactReplayMove): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`
}

function safeAdd(values: readonly number[], field: string): number {
  return values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must contain nonnegative safe integers`)
    const next = sum + value
    if (!Number.isSafeInteger(next)) throw new Error(`${field} exceeds the safe integer range`)
    return next
  }, 0)
}

export function evidenceFingerprint(identity: CompactEvidenceIdentity): string {
  assertIdentity(identity)
  const canonical = identity.kind === 'position'
    ? `position\0${identity.epd}`
    : `edge\0${identity.fromEpd}\0${identity.uci}\0${identity.toEpd}`
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Produce legal, per-game reach observations through absolute ply 100. A
 * repeated position or edge contributes at most once per game, so candidate
 * counts remain game samples rather than visit counts.
 */
export function compactReplayObservations(
  moves: readonly CompactReplayMove[],
  maximumPly: number = ADAPTIVE_EVIDENCE_MAX_PLY,
): CompactReplayObservation[] {
  if (!Number.isSafeInteger(maximumPly) || maximumPly < 0 || maximumPly > ADAPTIVE_EVIDENCE_MAX_PLY) {
    throw new Error(`Replay maximum ply must be between 0 and ${ADAPTIVE_EVIDENCE_MAX_PLY}`)
  }
  const chess = new Chess()
  const observations: CompactReplayObservation[] = []
  const seenPositions = new Set<string>()
  const seenEdges = new Set<string>()
  const root: PositionIdentity = { kind: 'position', epd: normalizedEpd(chess) }
  seenPositions.add(evidenceFingerprint(root))
  observations.push({ identity: root, ply: 0 })
  const finalPly = Math.min(maximumPly, moves.length)
  for (let index = 0; index < finalPly; index += 1) {
    const source = moves[index]!
    const fromEpd = normalizedEpd(chess)
    const applied = chess.move({
      from: source.from,
      to: source.to,
      ...(source.promotion ? { promotion: source.promotion } : {}),
    })
    if (!applied) throw new Error(`Could not replay validated move ${uciForCompactMove(source)}`)
    const toEpd = normalizedEpd(chess)
    const reachedPly = index + 1
    const edge: EdgeIdentity = { kind: 'edge', fromEpd, uci: uciForCompactMove(source), toEpd }
    const edgeFingerprint = evidenceFingerprint(edge)
    if (!seenEdges.has(edgeFingerprint)) {
      seenEdges.add(edgeFingerprint)
      observations.push({ identity: edge, ply: reachedPly, san: applied.san })
    }
    const position: PositionIdentity = { kind: 'position', epd: toEpd }
    const positionFingerprint = evidenceFingerprint(position)
    if (!seenPositions.has(positionFingerprint)) {
      seenPositions.add(positionFingerprint)
      observations.push({ identity: position, ply: reachedPly })
    }
  }
  return observations
}

function sketchFingerprint(identityFingerprint: string, cohortId: string): string {
  if (!SHA256.test(identityFingerprint) || !COHORT_ID.test(cohortId)) throw new Error('Invalid candidate identity')
  return createHash('sha256').update(`${cohortId}\0${identityFingerprint}`).digest('hex')
}

/**
 * Fixed-memory Count-Min sketch. Counters only increase and saturation aborts,
 * so estimates never undercount. False positives are expected and removed by
 * the exact replay.
 */
export class CountMinSketch {
  readonly width: number
  readonly depth: number
  readonly byteLength: number
  private readonly rows: Uint32Array[]

  constructor(width: number, depth: number) {
    if (!Number.isSafeInteger(width) || width < 1) throw new Error('Count-Min width must be a positive integer')
    if (!Number.isSafeInteger(depth) || depth < 2 || depth > 16) throw new Error('Count-Min depth must be from 2 to 16')
    const cells = width * depth
    if (!Number.isSafeInteger(cells) || cells > 0x3fff_ffff) throw new Error('Count-Min sketch is too large')
    this.width = width
    this.depth = depth
    this.byteLength = cells * Uint32Array.BYTES_PER_ELEMENT
    this.rows = Array.from({ length: depth }, () => new Uint32Array(width))
  }

  increment(fingerprint: string): number {
    if (!SHA256.test(fingerprint)) throw new Error('Count-Min keys must be SHA-256 fingerprints')
    const bytes = Buffer.from(fingerprint, 'hex')
    let estimate = UINT32_MAX
    for (let row = 0; row < this.depth; row += 1) {
      const offset = (row * 4) % 28
      const base = bytes.readUInt32BE(offset)
      const mixed = (base ^ Math.imul(row + 1, 0x9e37_79b1)) >>> 0
      const index = mixed % this.width
      const current = this.rows[row]![index]!
      if (current === UINT32_MAX) throw new Error('Count-Min counter saturated; candidate pass aborted')
      const next = current + 1
      this.rows[row]![index] = next
      estimate = Math.min(estimate, next)
    }
    return estimate
  }

  snapshot(): Uint8Array {
    const headerBytes = 12
    const output = Buffer.allocUnsafe(headerBytes + this.byteLength)
    output.write('CMS3', 0, 'ascii')
    output.writeUInt32BE(this.width, 4)
    output.writeUInt32BE(this.depth, 8)
    let offset = headerBytes
    for (const row of this.rows) {
      for (const count of row) {
        output.writeUInt32BE(count, offset)
        offset += 4
      }
    }
    return output
  }

  restore(snapshot: Uint8Array): void {
    const restored = CountMinSketch.fromSnapshot(snapshot)
    if (restored.width !== this.width || restored.depth !== this.depth) {
      throw new Error('Count-Min snapshot dimensions do not match the configured sketch')
    }
    for (let row = 0; row < this.depth; row += 1) this.rows[row]!.set(restored.rows[row]!)
  }

  static fromSnapshot(snapshot: Uint8Array): CountMinSketch {
    const input = Buffer.from(snapshot)
    if (input.length < 12 || input.toString('ascii', 0, 4) !== 'CMS3') {
      throw new Error('Count-Min snapshot header is invalid')
    }
    const width = input.readUInt32BE(4)
    const depth = input.readUInt32BE(8)
    const restored = new CountMinSketch(width, depth)
    if (input.length !== 12 + restored.byteLength) throw new Error('Count-Min snapshot byte length is invalid')
    let offset = 12
    for (const row of restored.rows) {
      for (let index = 0; index < row.length; index += 1) {
        row[index] = input.readUInt32BE(offset)
        offset += 4
      }
    }
    return restored
  }
}

export class SqliteCandidateIndex {
  readonly database: DatabaseSync
  private readonly findCandidate: StatementSync
  private readonly insertCandidate: StatementSync
  private readonly updateEstimate: StatementSync
  private count: number
  private transactionStartCount: number | null = null

  constructor(
    path: string,
    private readonly maximumCandidates: number,
    maximumBytes?: number,
  ) {
    if (!Number.isSafeInteger(maximumCandidates) || maximumCandidates < 1) {
      throw new Error('maximumCandidates must be a positive safe integer')
    }
    this.database = new DatabaseSync(path)
    try {
      if (maximumBytes === undefined) {
        this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA temp_store = MEMORY;')
      } else {
        configureWorkingDatabaseByteCap(this.database, maximumBytes, 'Candidate index')
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS candidates (
          fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
          cohort_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('position', 'edge')),
          first_estimate INTEGER NOT NULL CHECK(first_estimate >= 1),
          maximum_estimate INTEGER NOT NULL CHECK(maximum_estimate >= first_estimate),
          PRIMARY KEY(fingerprint, cohort_id)
        ) STRICT;
      `)
    } catch (error) {
      this.database.close()
      throw error
    }
    this.findCandidate = this.database.prepare(
      'SELECT kind FROM candidates WHERE fingerprint = ? AND cohort_id = ?',
    )
    this.insertCandidate = this.database.prepare(`
      INSERT INTO candidates(fingerprint, cohort_id, kind, first_estimate, maximum_estimate)
      VALUES (?, ?, ?, ?, ?)
    `)
    this.updateEstimate = this.database.prepare(`
      UPDATE candidates SET maximum_estimate = max(maximum_estimate, ?)
      WHERE fingerprint = ? AND cohort_id = ?
    `)
    const row = this.database.prepare('SELECT count(*) AS count FROM candidates').get() as { count: number }
    this.count = row.count
    if (this.count > maximumCandidates) throw new Error('Existing candidate index exceeds its configured hard cap')
  }

  get size(): number {
    return this.count
  }

  beginArchive(): void {
    if (this.transactionStartCount !== null) throw new Error('A candidate archive transaction is already active')
    this.database.exec('BEGIN IMMEDIATE')
    this.transactionStartCount = this.count
  }

  commitArchive(): void {
    if (this.transactionStartCount === null) throw new Error('No candidate archive transaction is active')
    this.database.exec('COMMIT')
    this.transactionStartCount = null
  }

  rollbackArchive(): void {
    if (this.transactionStartCount === null) throw new Error('No candidate archive transaction is active')
    rollbackSqliteTransaction(this.database)
    this.count = this.transactionStartCount
    this.transactionStartCount = null
  }

  has(fingerprint: string, cohortId: string): boolean {
    if (!SHA256.test(fingerprint) || !COHORT_ID.test(cohortId)) throw new Error('Invalid candidate lookup')
    return this.findCandidate.get(fingerprint, cohortId) !== undefined
  }

  retain(fingerprint: string, cohortId: string, kind: CompactEvidenceKind, estimate: number): boolean {
    if (this.transactionStartCount === null) throw new Error('Candidate retention requires an archive transaction')
    if (!SHA256.test(fingerprint) || !COHORT_ID.test(cohortId)) throw new Error('Invalid candidate row')
    if (!Number.isSafeInteger(estimate) || estimate < ADAPTIVE_CANDIDATE_MINIMUM_SAMPLE) {
      throw new Error('Candidate estimate has not reached the retention threshold')
    }
    const existing = this.findCandidate.get(fingerprint, cohortId) as { kind: CompactEvidenceKind } | undefined
    if (existing) {
      if (existing.kind !== kind) throw new Error('Candidate fingerprint collision changed evidence kind')
      this.updateEstimate.run(estimate, fingerprint, cohortId)
      return false
    }
    if (this.count >= this.maximumCandidates) {
      throw new Error('Candidate index hard cap reached; archive pass aborted without promotion')
    }
    this.insertCandidate.run(fingerprint, cohortId, kind, estimate, estimate)
    this.count += 1
    return true
  }

  close(): void {
    if (this.transactionStartCount !== null) this.rollbackArchive()
    this.database.close()
  }
}

export class CompactCandidatePass {
  readonly sketch: CountMinSketch
  private adaptiveObservations = 0
  private archiveSnapshot: Uint8Array | null = null
  private archiveObservationStart = 0

  constructor(
    readonly index: SqliteCandidateIndex,
    width: number,
    depth: number,
    snapshot?: Uint8Array,
  ) {
    this.sketch = snapshot ? CountMinSketch.fromSnapshot(snapshot) : new CountMinSketch(width, depth)
    if (this.sketch.width !== width || this.sketch.depth !== depth) {
      throw new Error('Restored Count-Min state does not match the configured dimensions')
    }
  }

  get observationsSeen(): number {
    return this.adaptiveObservations
  }

  beginArchive(): void {
    if (this.archiveSnapshot !== null) throw new Error('A candidate archive pass is already active')
    this.archiveSnapshot = this.sketch.snapshot()
    this.archiveObservationStart = this.adaptiveObservations
    this.index.beginArchive()
  }

  commitArchive(): Uint8Array {
    if (this.archiveSnapshot === null) throw new Error('No candidate archive pass is active')
    this.index.commitArchive()
    this.archiveSnapshot = null
    return this.sketch.snapshot()
  }

  rollbackArchive(): void {
    if (this.archiveSnapshot === null) throw new Error('No candidate archive pass is active')
    this.index.rollbackArchive()
    this.sketch.restore(this.archiveSnapshot)
    this.adaptiveObservations = this.archiveObservationStart
    this.archiveSnapshot = null
  }

  observe(observation: CandidateObservation): { retained: boolean; estimate: number | null } {
    if (this.archiveSnapshot === null) throw new Error('Candidate observations require an active archive pass')
    if (!Number.isSafeInteger(observation.ply) || observation.ply < 0 || observation.ply > ADAPTIVE_EVIDENCE_MAX_PLY) {
      throw new Error(`Evidence ply must be between 0 and ${ADAPTIVE_EVIDENCE_MAX_PLY}`)
    }
    if (!COHORT_ID.test(observation.cohortId)) throw new Error('Candidate cohort is invalid')
    if (observation.ply <= COMPLETE_BASELINE_MAX_PLY) return { retained: false, estimate: null }
    const fingerprint = evidenceFingerprint(observation.identity)
    const estimate = this.sketch.increment(sketchFingerprint(fingerprint, observation.cohortId))
    this.adaptiveObservations += 1
    if (estimate < ADAPTIVE_CANDIDATE_MINIMUM_SAMPLE) return { retained: false, estimate }
    return {
      retained: this.index.retain(fingerprint, observation.cohortId, observation.identity.kind, estimate),
      estimate,
    }
  }
}

export function shouldRetainExactObservation(
  observation: Pick<CandidateObservation, 'identity' | 'cohortId' | 'ply'>,
  candidates: Pick<SqliteCandidateIndex, 'has'>,
): boolean {
  if (!Number.isSafeInteger(observation.ply) || observation.ply < 0 || observation.ply > ADAPTIVE_EVIDENCE_MAX_PLY) {
    throw new Error(`Evidence ply must be between 0 and ${ADAPTIVE_EVIDENCE_MAX_PLY}`)
  }
  if (observation.ply <= COMPLETE_BASELINE_MAX_PLY) return true
  return candidates.has(evidenceFingerprint(observation.identity), observation.cohortId)
}

/**
 * Compact exact store: EPDs and moves are normalized once and evidence rows
 * refer to integer IDs. It is deliberately archive-scoped; cross-archive
 * promotion/merge belongs to a later audited orchestration layer.
 */
export class SqliteCompactExactStore {
  readonly database: DatabaseSync
  private readonly upsertPosition: StatementSync
  private readonly getPosition: StatementSync
  private readonly upsertEdge: StatementSync
  private readonly getEdge: StatementSync
  private readonly upsertOutcome: StatementSync
  private archiveTransactionActive = false

  constructor(path: string, maximumBytes?: number) {
    this.database = new DatabaseSync(path)
    try {
      if (maximumBytes === undefined) {
        this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      } else {
        configureWorkingDatabaseByteCap(this.database, maximumBytes, 'Exact evidence state')
      }
      this.database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS positions (
          position_id INTEGER PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
          epd TEXT NOT NULL UNIQUE
        ) STRICT;
        CREATE TABLE IF NOT EXISTS edges (
          edge_id INTEGER PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
          from_position_id INTEGER NOT NULL REFERENCES positions(position_id),
          uci TEXT NOT NULL,
          san TEXT NOT NULL,
          to_position_id INTEGER NOT NULL REFERENCES positions(position_id),
          UNIQUE(from_position_id, uci, to_position_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS outcomes (
          kind TEXT NOT NULL CHECK(kind IN ('position', 'edge')),
          reference_id INTEGER NOT NULL,
          cohort_id TEXT NOT NULL,
          month TEXT NOT NULL,
          time_control TEXT NOT NULL,
          rating_band TEXT NOT NULL,
          rating_detail TEXT NOT NULL,
          min_ply INTEGER NOT NULL CHECK(min_ply BETWEEN 0 AND 100),
          n INTEGER NOT NULL,
          white_wins INTEGER NOT NULL,
          draws INTEGER NOT NULL,
          black_wins INTEGER NOT NULL,
          PRIMARY KEY(kind, reference_id, cohort_id, month, time_control, rating_band, rating_detail)
        ) WITHOUT ROWID, STRICT;
      `)
    } catch (error) {
      this.database.close()
      throw error
    }
    this.upsertPosition = this.database.prepare('INSERT OR IGNORE INTO positions(fingerprint, epd) VALUES (?, ?)')
    this.getPosition = this.database.prepare('SELECT position_id AS positionId, epd FROM positions WHERE fingerprint = ?')
    this.upsertEdge = this.database.prepare(`
      INSERT OR IGNORE INTO edges(fingerprint, from_position_id, uci, san, to_position_id)
      VALUES (?, ?, ?, ?, ?)
    `)
    this.getEdge = this.database.prepare(`
      SELECT edge_id AS edgeId, from_position_id AS fromPositionId, uci, san,
        to_position_id AS toPositionId
      FROM edges WHERE fingerprint = ?
    `)
    this.upsertOutcome = this.database.prepare(`
      INSERT INTO outcomes(
        kind, reference_id, cohort_id, month, time_control, rating_band, rating_detail,
        min_ply, n, white_wins, draws, black_wins
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(kind, reference_id, cohort_id, month, time_control, rating_band, rating_detail)
      DO UPDATE SET min_ply = min(min_ply, excluded.min_ply), n = n + 1,
        white_wins = white_wins + excluded.white_wins,
        draws = draws + excluded.draws,
        black_wins = black_wins + excluded.black_wins
    `)
  }

  private positionId(epd: string): number {
    const identity: PositionIdentity = { kind: 'position', epd }
    const fingerprint = evidenceFingerprint(identity)
    this.upsertPosition.run(fingerprint, epd)
    const row = this.getPosition.get(fingerprint) as { positionId: number; epd: string } | undefined
    if (!row || row.epd !== epd) throw new Error('Position fingerprint collision detected')
    return row.positionId
  }

  beginArchive(): void {
    if (this.archiveTransactionActive) throw new Error('An exact archive transaction is already active')
    this.database.exec('BEGIN IMMEDIATE')
    this.archiveTransactionActive = true
  }

  commitArchive(): void {
    if (!this.archiveTransactionActive) throw new Error('No exact archive transaction is active')
    this.database.exec('COMMIT')
    this.archiveTransactionActive = false
  }

  rollbackArchive(): void {
    if (!this.archiveTransactionActive) throw new Error('No exact archive transaction is active')
    rollbackSqliteTransaction(this.database)
    this.archiveTransactionActive = false
  }

  add(observation: ExactObservation): void {
    if (!this.archiveTransactionActive) throw new Error('Exact evidence writes require an archive transaction')
    assertIdentity(observation.identity)
    if (!COHORT_ID.test(observation.cohortId)) throw new Error('Exact evidence cohort is invalid')
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(observation.month)) throw new Error('Exact evidence month is invalid')
    if (!Number.isSafeInteger(observation.ply) || observation.ply < 0 || observation.ply > ADAPTIVE_EVIDENCE_MAX_PLY) {
      throw new Error('Exact evidence ply is invalid')
    }
    let referenceId: number
    if (observation.identity.kind === 'position') {
      referenceId = this.positionId(observation.identity.epd)
    } else {
      if (!observation.san || observation.san.length > 32 || /[\u0000-\u001f\u007f]/u.test(observation.san)) {
        throw new Error('Exact edge evidence requires bounded SAN')
      }
      const fromPositionId = this.positionId(observation.identity.fromEpd)
      const toPositionId = this.positionId(observation.identity.toEpd)
      const fingerprint = evidenceFingerprint(observation.identity)
      this.upsertEdge.run(
        fingerprint,
        fromPositionId,
        observation.identity.uci,
        observation.san,
        toPositionId,
      )
      const row = this.getEdge.get(fingerprint) as {
        edgeId: number
        fromPositionId: number
        uci: string
        san: string
        toPositionId: number
      } | undefined
      if (
        !row || row.fromPositionId !== fromPositionId || row.uci !== observation.identity.uci ||
        row.san !== observation.san || row.toPositionId !== toPositionId
      ) throw new Error('Edge fingerprint collision detected')
      referenceId = row.edgeId
    }
    const whiteWin = observation.result === '1-0' ? 1 : 0
    const draw = observation.result === '1/2-1/2' ? 1 : 0
    const blackWin = observation.result === '0-1' ? 1 : 0
    this.upsertOutcome.run(
      observation.identity.kind,
      referenceId,
      observation.cohortId,
      observation.month,
      observation.timeControl,
      observation.ratingBand,
      observation.ratingDetail,
      observation.ply,
      whiteWin,
      draw,
      blackWin,
    )
  }

  close(): void {
    if (this.archiveTransactionActive) this.rollbackArchive()
    this.database.close()
  }
}

export interface CompactExactPassTotals {
  observationsSeen: number
  completeBaselineObservationsRetained: number
  adaptiveCandidateObservationsRetained: number
  adaptiveNoncandidateObservationsRejected: number
}

export class CompactExactPass {
  private totalsValue: CompactExactPassTotals = {
    observationsSeen: 0,
    completeBaselineObservationsRetained: 0,
    adaptiveCandidateObservationsRetained: 0,
    adaptiveNoncandidateObservationsRejected: 0,
  }
  private archiveStart: CompactExactPassTotals | null = null

  constructor(
    readonly store: SqliteCompactExactStore,
    readonly candidates: Pick<SqliteCandidateIndex, 'has'>,
  ) {}

  get totals(): Readonly<CompactExactPassTotals> {
    return this.totalsValue
  }

  beginArchive(): void {
    if (this.archiveStart !== null) throw new Error('An exact archive pass is already active')
    this.archiveStart = { ...this.totalsValue }
    this.store.beginArchive()
  }

  observe(observation: ExactObservation): boolean {
    if (this.archiveStart === null) throw new Error('Exact observations require an active archive pass')
    this.totalsValue.observationsSeen += 1
    if (!shouldRetainExactObservation(observation, this.candidates)) {
      this.totalsValue.adaptiveNoncandidateObservationsRejected += 1
      return false
    }
    this.store.add(observation)
    if (observation.ply <= COMPLETE_BASELINE_MAX_PLY) {
      this.totalsValue.completeBaselineObservationsRetained += 1
    } else {
      this.totalsValue.adaptiveCandidateObservationsRetained += 1
    }
    return true
  }

  commitArchive(): CompactExactPassTotals {
    if (this.archiveStart === null) throw new Error('No exact archive pass is active')
    this.store.commitArchive()
    this.archiveStart = null
    return { ...this.totalsValue }
  }

  rollbackArchive(): void {
    if (this.archiveStart === null) throw new Error('No exact archive pass is active')
    this.store.rollbackArchive()
    this.totalsValue = this.archiveStart
    this.archiveStart = null
  }
}

export interface CompactStorageAssessment {
  storageModel: 'bounded-two-pass-content-addressed-v3'
  executionPurpose: CompactExecutionPurpose
  safeToStart: boolean
  reasonCode:
    | 'ready'
    | 'benchmark-not-approved'
    | 'benchmark-bootstrap-requires-pending-proof'
    | 'retained-state-cap-exceeded'
    | 'insufficient-free-space'
  transientAdditionalBytesUpperBound: number
  retainedBytesAlreadyPresent: number
  retainedCorpusMaxBytes: number
  remainingRetainedBudgetBytes: number
  peakAdditionalBytesUpperBound: number
  availableBytes: number
  minimumFreeReserveBytes: number
  remainingBytesAtPeak: number
  detail: string
}

export function assessCompactV3Storage(
  planValue: CompactPreflightPlan,
  availableBytes: number,
  context: {
    executionPurpose?: CompactExecutionPurpose
    retainedBytesAlreadyPresent?: number
  } = {},
): CompactStorageAssessment {
  const plan = CompactPreflightPlanSchema.parse(planValue)
  const executionPurpose = context.executionPurpose ?? 'evidence-candidate'
  const retainedBytesAlreadyPresent = context.retainedBytesAlreadyPresent ?? 0
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw new Error('Available storage must be a nonnegative safe integer')
  }
  if (!Number.isSafeInteger(retainedBytesAlreadyPresent) || retainedBytesAlreadyPresent < 0) {
    throw new Error('Retained compact storage must be a nonnegative safe integer')
  }
  const sketchBytes = plan.limits.countMinWidth * plan.limits.countMinDepth * Uint32Array.BYTES_PER_ELEMENT
  if (!Number.isSafeInteger(sketchBytes) || sketchBytes > plan.bounds.candidateSketchMaxBytes) {
    throw new Error('Count-Min dimensions exceed the enforced sketch byte cap')
  }
  if (sketchBytes + 12 > plan.bounds.checkpointMaxBytes) {
    throw new Error('Count-Min snapshot exceeds the enforced checkpoint byte cap')
  }
  const transientBound = safeAdd([
    plan.bounds.candidateSketchMaxBytes,
    plan.bounds.candidateIndexMaxBytes,
    plan.bounds.baselineShardMaxBytes,
    plan.bounds.adaptiveShardMaxBytes,
    plan.bounds.exactWorkMaxBytes,
    plan.bounds.checkpointMaxBytes,
    plan.bounds.atomicPromotionMaxBytes,
    plan.bounds.inputStagingMaxBytes,
  ], 'Compact transient storage bounds')
  const fullCorpusBound = safeAdd(
    [transientBound, plan.bounds.retainedCorpusMaxBytes],
    'Compact full-corpus storage bound',
  )
  if (plan.benchmark.status === 'approved' && fullCorpusBound < plan.benchmark.peakAdditionalStorageBytes) {
    throw new Error('Enforced storage caps are below the approved benchmark peak')
  }
  const remainingRetainedBudgetBytes = Math.max(
    0,
    plan.bounds.retainedCorpusMaxBytes - retainedBytesAlreadyPresent,
  )
  const peakAdditionalBytesUpperBound = safeAdd(
    [transientBound, remainingRetainedBudgetBytes],
    'Compact remaining storage requirement',
  )
  const required = safeAdd(
    [peakAdditionalBytesUpperBound, plan.limits.minimumFreeReserveBytes],
    'Compact storage requirement',
  )
  const remainingBytesAtPeak = availableBytes - peakAdditionalBytesUpperBound
  const common = {
    storageModel: plan.storageModel,
    executionPurpose,
    transientAdditionalBytesUpperBound: transientBound,
    retainedBytesAlreadyPresent,
    retainedCorpusMaxBytes: plan.bounds.retainedCorpusMaxBytes,
    remainingRetainedBudgetBytes,
    peakAdditionalBytesUpperBound,
    availableBytes,
    minimumFreeReserveBytes: plan.limits.minimumFreeReserveBytes,
    remainingBytesAtPeak,
  } as const
  if (retainedBytesAlreadyPresent > plan.bounds.retainedCorpusMaxBytes) {
    return {
      ...common,
      safeToStart: false,
      reasonCode: 'retained-state-cap-exceeded',
      detail: 'Retained schema-v3 objects already exceed the corpus-wide hard cap; no pass may start.',
    }
  }
  if (executionPurpose === 'evidence-candidate' && plan.benchmark.status !== 'approved') {
    return {
      ...common,
      safeToStart: false,
      reasonCode: 'benchmark-not-approved',
      detail: 'Evidence ingestion is disabled until a complete broadcast replay proves the enforced hard-cap plan.',
    }
  }
  if (executionPurpose === 'benchmark-bootstrap' && plan.benchmark.status !== 'pending') {
    return {
      ...common,
      safeToStart: false,
      reasonCode: 'benchmark-bootstrap-requires-pending-proof',
      detail: 'Benchmark bootstrap is permitted only for an explicitly pending proof; approved plans use evidence mode.',
    }
  }
  if (availableBytes < required) {
    return {
      ...common,
      safeToStart: false,
      reasonCode: 'insufficient-free-space',
      detail: 'Compact ingestion is disabled because transient work plus the unfilled corpus-retention budget would violate the free-space reserve.',
    }
  }
  return {
    ...common,
    safeToStart: true,
    reasonCode: 'ready',
    detail: executionPurpose === 'benchmark-bootstrap'
      ? 'A provisional benchmark replay fits the enforced transient and corpus-retention caps while preserving the required reserve.'
      : 'The approved benchmark and enforced transient and corpus-retention caps fit while preserving the required reserve.',
  }
}

export function compactPreflightExitCode(assessment: CompactStorageAssessment): 0 | 2 {
  return assessment.safeToStart ? 0 : 2
}

export function resumeAction(checkpointValue: CompactArchiveCheckpoint): ResumeAction {
  const checkpoint = CompactArchiveCheckpointSchema.parse(checkpointValue)
  if (checkpoint.exactReceipt !== null) return 'complete'
  if (checkpoint.candidateReceipt !== null) return 'exact'
  return 'candidate'
}

export function receiptDigest(receipt: CompactPassReceipt): string {
  const canonical = CompactPassReceiptSchema.parse(receipt)
  return createHash('sha256').update(`${JSON.stringify(canonical)}\n`).digest('hex')
}

export function classifyBookTerminal(input: {
  terminalPly: number
  hasEligibleContinuation: boolean
  hasObservedContinuation: boolean
  quarantined: boolean
}): BookTerminalStatus {
  if (!Number.isSafeInteger(input.terminalPly) || input.terminalPly < 0 || input.terminalPly > ADAPTIVE_EVIDENCE_MAX_PLY) {
    throw new Error(`Terminal ply must be between 0 and ${ADAPTIVE_EVIDENCE_MAX_PLY}`)
  }
  if (input.quarantined) return 'quarantined'
  if (input.hasEligibleContinuation) {
    if (input.terminalPly === ADAPTIVE_EVIDENCE_MAX_PLY) return 'depth_capped'
    throw new Error('A path cannot terminate before ply 100 while an eligible continuation exists')
  }
  return input.hasObservedContinuation ? 'insufficient_sample' : 'evidence_terminal'
}

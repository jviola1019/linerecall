import { createHash } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { Chess, type Move } from 'chess.js'
import {
  DEFAULT_PGN_LIMITS,
  normalizedEpd,
  parseBroadcastPgn,
  uciForMove,
  type ParseBroadcastResult,
  type PgnLimits,
  type PgnRecord,
} from './broadcast-pgn.ts'
import {
  REPERTOIRE_MAX_PLY,
  canonicalRatingBandFor,
  lichessBeginnerDetailBandFor,
  type CanonicalRatingBand,
  type LichessBeginnerDetailBand,
  type TimeControlClass,
} from './evidence-contracts.ts'
import type { GameResult, RejectionReason } from './broadcast-contracts.ts'

export type GraphRejectionReason =
  | RejectionReason
  | 'bot_game'
  | 'missing_game_id'
  | 'unsupported_time_control'
  | 'unexpected_variant'

export interface GraphAcceptedGame {
  sourceId: 'lichess-broadcasts' | 'lichess-standard-rated-q2-2026'
  cohortId: string
  month: string
  timeControl: TimeControlClass
  ratingBand: CanonicalRatingBand
  ratingDetail: LichessBeginnerDetailBand | null
  result: GameResult
  deduplicationKey: string
  corruptionGuardSha256: string
  moves: Array<Pick<Move, 'from' | 'to' | 'promotion'>>
}

export type ParseGraphGameResult =
  | { accepted: true; game: GraphAcceptedGame }
  | { accepted: false; reason: GraphRejectionReason }

export interface GraphArchiveIdentity {
  archiveId: string
  sourceId: GraphAcceptedGame['sourceId']
  month: string
  sha256: string
}

export interface GraphIngestionTotals {
  recordsSeen: number
  accepted: number
  deduplicated: number
  rejected: Partial<Record<GraphRejectionReason, number>>
}

export interface GraphIngestionOptions {
  batchGames?: number
  maximumPly?: number
  limits?: PgnLimits
}

interface MutableOutcome {
  archiveId: string
  cohortId: string
  month: string
  timeControl: TimeControlClass
  ratingBand: CanonicalRatingBand
  ratingDetail: string
  epd: string
  minPly: number
  n: number
  whiteWins: number
  draws: number
  blackWins: number
}

interface MutableEdgeOutcome extends MutableOutcome {
  uci: string
  san: string
  toEpd: string
}

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,95}$/u
const ARCHIVE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/u
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

function outcomeDelta(result: GameResult): Pick<MutableOutcome, 'n' | 'whiteWins' | 'draws' | 'blackWins'> {
  return {
    n: 1,
    whiteWins: result === '1-0' ? 1 : 0,
    draws: result === '1/2-1/2' ? 1 : 0,
    blackWins: result === '0-1' ? 1 : 0,
  }
}

function gameGuard(
  result: GameResult,
  whiteRating: number,
  blackRating: number,
  moves: GraphAcceptedGame['moves'],
): string {
  return createHash('sha256').update(JSON.stringify([
    result,
    whiteRating,
    blackRating,
    moves.map(uciForMove),
  ])).digest('hex')
}

function speedFromEvent(event: string | undefined): TimeControlClass | null {
  if (!event) return null
  const match = /(?:^|\s)rated\s+([a-z][a-z0-9]*)\s+game(?:\s|$)/iu.exec(event)
  if (!match?.[1]) return null
  const speed = match[1].toLowerCase()
  if (speed === 'blitz' || speed === 'rapid' || speed === 'classical') return speed
  // Lichess's archive Event header is authoritative when it names a rated
  // speed. Explicit bullet, ultraBullet, correspondence, or a future unknown
  // class must never be reclassified from a superficially plausible clock.
  return 'unknown'
}

/**
 * Map a PGN time control to a trainable cohort. Lichess calculates speed from
 * initial seconds plus forty increments. UltraBullet (0-29), Bullet (30-179),
 * and Correspondence (21600+) are intentionally collapsed to `unknown` so
 * they cannot enter the blitz, rapid, or classical evidence cohorts.
 */
export function classifyTimeControl(
  timeControl: string | undefined,
  event: string | undefined,
): TimeControlClass {
  const fromEvent = speedFromEvent(event)
  if (fromEvent) return fromEvent
  if (!timeControl) return 'unknown'
  const normalized = timeControl.trim()
  const simple = /^(\d+)(m)?(?:\+(\d+)(s)?)?$/iu.exec(normalized)
  if (!simple?.[1]) return 'unknown'
  const base = Number(simple[1]) * (simple[2] ? 60 : 1)
  const increment = Number(simple[3] ?? '0') * (simple[4] ? 1 : 1)
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(increment)) return 'unknown'
  const estimate = base + 40 * increment
  if (estimate < 180) return 'unknown'
  if (estimate < 480) return 'blitz'
  if (estimate < 1_500) return 'rapid'
  if (estimate < 21_600) return 'classical'
  return 'unknown'
}

function standardGameId(site: string | undefined): string | null {
  if (!site) return null
  try {
    const url = new URL(site)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'lichess.org') return null
    const id = url.pathname.split('/').filter(Boolean)[0]
    return id && /^[A-Za-z0-9]{8,12}$/u.test(id) ? id : null
  } catch {
    return null
  }
}

function withExplicitStandardVariant(pgn: string): string | null {
  const existing = /^\[Variant\s+"((?:[^"\\]|\\["\\])*)"\]\s*$/imu.exec(pgn)
  if (existing) return existing[1]?.trim().toLowerCase() === 'standard' ? pgn : null
  return `[Variant "Standard"]\n${pgn}`
}

export function parseBroadcastGraphPgn(pgn: string, month: string): ParseGraphGameResult {
  const parsed = parseBroadcastPgn(pgn)
  if (!parsed.accepted) return parsed
  const timeControl = classifyTimeControl(parsed.game.headers.TimeControl, parsed.game.headers.Event)
  return {
    accepted: true,
    game: {
      sourceId: 'lichess-broadcasts',
      cohortId: `cohort_broadcast-${timeControl}`,
      month,
      timeControl,
      ratingBand: canonicalRatingBandFor(parsed.game.whiteElo, parsed.game.blackElo),
      ratingDetail: null,
      result: parsed.game.result,
      deduplicationKey: parsed.game.deduplicationKey,
      corruptionGuardSha256: gameGuard(
        parsed.game.result,
        parsed.game.whiteElo,
        parsed.game.blackElo,
        parsed.game.moves,
      ),
      moves: parsed.game.moves,
    },
  }
}

export function parseLichessStandardGraphPgn(pgn: string, month: string): ParseGraphGameResult {
  const normalized = withExplicitStandardVariant(pgn)
  if (normalized === null) return { accepted: false, reason: 'unexpected_variant' }
  const parsed: ParseBroadcastResult = parseBroadcastPgn(normalized)
  if (!parsed.accepted) return parsed
  if (
    parsed.game.headers.WhiteTitle?.trim().toUpperCase() === 'BOT' ||
    parsed.game.headers.BlackTitle?.trim().toUpperCase() === 'BOT'
  ) return { accepted: false, reason: 'bot_game' }
  const gameId = standardGameId(parsed.game.headers.Site)
  if (!gameId) return { accepted: false, reason: 'missing_game_id' }
  // Official Lichess standard archives identify the server-assigned speed in
  // Event. Require that authoritative class instead of guessing a missing or
  // future archive header from a clock string.
  const timeControl = speedFromEvent(parsed.game.headers.Event)
  if (!timeControl || timeControl === 'unknown') return { accepted: false, reason: 'unsupported_time_control' }
  return {
    accepted: true,
    game: {
      sourceId: 'lichess-standard-rated-q2-2026',
      cohortId: `cohort_lichess-standard-${timeControl}`,
      month,
      timeControl,
      ratingBand: canonicalRatingBandFor(parsed.game.whiteElo, parsed.game.blackElo),
      ratingDetail: lichessBeginnerDetailBandFor(parsed.game.whiteElo, parsed.game.blackElo),
      result: parsed.game.result,
      deduplicationKey: `lichess:${gameId}`,
      corruptionGuardSha256: gameGuard(
        parsed.game.result,
        parsed.game.whiteElo,
        parsed.game.blackElo,
        parsed.game.moves,
      ),
      moves: parsed.game.moves,
    },
  }
}

function positionKey(value: Omit<MutableOutcome, 'minPly' | 'n' | 'whiteWins' | 'draws' | 'blackWins'>): string {
  return [
    value.archiveId,
    value.cohortId,
    value.month,
    value.timeControl,
    value.ratingBand,
    value.ratingDetail,
    value.epd,
  ].join('\0')
}

function edgeKey(value: Omit<MutableEdgeOutcome, 'minPly' | 'n' | 'whiteWins' | 'draws' | 'blackWins'>): string {
  return `${positionKey(value)}\0${value.uci}\0${value.toEpd}`
}

function mergeOutcome<T extends MutableOutcome>(
  map: Map<string, T>,
  key: string,
  base: Omit<T, 'minPly' | 'n' | 'whiteWins' | 'draws' | 'blackWins'>,
  ply: number,
  result: GameResult,
): void {
  const existing = map.get(key)
  const delta = outcomeDelta(result)
  if (existing) {
    existing.minPly = Math.min(existing.minPly, ply)
    existing.n += 1
    existing.whiteWins += delta.whiteWins
    existing.draws += delta.draws
    existing.blackWins += delta.blackWins
    return
  }
  map.set(key, { ...base, minPly: ply, ...delta } as T)
}

function addGameContributions(
  archiveId: string,
  game: GraphAcceptedGame,
  maximumPly: number,
  positions: Map<string, MutableOutcome>,
  edges: Map<string, MutableEdgeOutcome>,
): void {
  const chess = new Chess()
  const seenPositions = new Set<string>()
  const seenEdges = new Set<string>()
  const finalPly = Math.min(maximumPly, game.moves.length)
  for (let ply = 0; ply <= finalPly; ply += 1) {
    const fromEpd = normalizedEpd(chess)
    const positionBase = {
      archiveId,
      cohortId: game.cohortId,
      month: game.month,
      timeControl: game.timeControl,
      ratingBand: game.ratingBand,
      ratingDetail: game.ratingDetail ?? '',
      epd: fromEpd,
    }
    const pKey = positionKey(positionBase)
    if (!seenPositions.has(pKey)) {
      seenPositions.add(pKey)
      mergeOutcome(positions, pKey, positionBase, ply, game.result)
    }
    const sourceMove = game.moves[ply]
    if (!sourceMove || ply === finalPly) break
    const applied = chess.move({
      from: sourceMove.from,
      to: sourceMove.to,
      ...(sourceMove.promotion ? { promotion: sourceMove.promotion } : {}),
    })
    if (!applied) throw new Error(`Could not replay validated move ${uciForMove(sourceMove)}`)
    const toEpd = normalizedEpd(chess)
    const edgeBase = {
      ...positionBase,
      uci: uciForMove(sourceMove),
      san: applied.san,
      toEpd,
    }
    const eKey = edgeKey(edgeBase)
    if (!seenEdges.has(eKey)) {
      seenEdges.add(eKey)
      mergeOutcome(edges, eKey, edgeBase, ply, game.result)
    }
  }
}

export class EvidenceGraphStore {
  readonly database: DatabaseSync
  private readonly insertPosition: StatementSync
  private readonly insertEdge: StatementSync

  constructor(path: string) {
    this.database = new DatabaseSync(path)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
      CREATE TABLE IF NOT EXISTS graph_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS archive_runs (
        archive_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        month TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'complete')),
        records_seen INTEGER NOT NULL DEFAULT 0,
        accepted INTEGER NOT NULL DEFAULT 0,
        deduplicated INTEGER NOT NULL DEFAULT 0,
        rejected_json TEXT NOT NULL DEFAULT '{}',
        completed_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS games (
        source_id TEXT NOT NULL,
        deduplication_key TEXT NOT NULL,
        corruption_guard_sha256 TEXT NOT NULL,
        archive_id TEXT NOT NULL REFERENCES archive_runs(archive_id) ON DELETE CASCADE,
        PRIMARY KEY (source_id, deduplication_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS position_outcomes (
        archive_id TEXT NOT NULL REFERENCES archive_runs(archive_id) ON DELETE CASCADE,
        cohort_id TEXT NOT NULL,
        month TEXT NOT NULL,
        time_control TEXT NOT NULL,
        rating_band TEXT NOT NULL,
        rating_detail TEXT NOT NULL,
        epd TEXT NOT NULL,
        min_ply INTEGER NOT NULL,
        n INTEGER NOT NULL,
        white_wins INTEGER NOT NULL,
        draws INTEGER NOT NULL,
        black_wins INTEGER NOT NULL,
        PRIMARY KEY (archive_id, cohort_id, month, time_control, rating_band, rating_detail, epd)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS edge_outcomes (
        archive_id TEXT NOT NULL REFERENCES archive_runs(archive_id) ON DELETE CASCADE,
        cohort_id TEXT NOT NULL,
        month TEXT NOT NULL,
        time_control TEXT NOT NULL,
        rating_band TEXT NOT NULL,
        rating_detail TEXT NOT NULL,
        from_epd TEXT NOT NULL,
        uci TEXT NOT NULL,
        san TEXT NOT NULL,
        to_epd TEXT NOT NULL,
        min_ply INTEGER NOT NULL,
        n INTEGER NOT NULL,
        white_wins INTEGER NOT NULL,
        draws INTEGER NOT NULL,
        black_wins INTEGER NOT NULL,
        PRIMARY KEY (archive_id, cohort_id, month, time_control, rating_band, rating_detail, from_epd, uci, to_epd)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS position_epd_index ON position_outcomes(epd, cohort_id, time_control);
      CREATE INDEX IF NOT EXISTS edge_from_index ON edge_outcomes(from_epd, cohort_id, time_control);
      CREATE INDEX IF NOT EXISTS edge_to_index ON edge_outcomes(to_epd);
    `)
    const metadata = this.database.prepare('SELECT value FROM graph_metadata WHERE key = ?').get('schemaVersion') as { value?: string } | undefined
    if (metadata && metadata.value !== '2') throw new Error(`Unsupported evidence graph schema ${metadata.value ?? 'unknown'}`)
    this.database.prepare('INSERT OR IGNORE INTO graph_metadata(key, value) VALUES (?, ?)').run('schemaVersion', '2')
    this.database.prepare('INSERT OR IGNORE INTO graph_metadata(key, value) VALUES (?, ?)').run('maximumPly', String(REPERTOIRE_MAX_PLY))
    this.insertPosition = this.database.prepare(`
      INSERT INTO position_outcomes(
        archive_id, cohort_id, month, time_control, rating_band, rating_detail, epd,
        min_ply, n, white_wins, draws, black_wins
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(archive_id, cohort_id, month, time_control, rating_band, rating_detail, epd)
      DO UPDATE SET
        min_ply = min(min_ply, excluded.min_ply),
        n = n + excluded.n,
        white_wins = white_wins + excluded.white_wins,
        draws = draws + excluded.draws,
        black_wins = black_wins + excluded.black_wins
    `)
    this.insertEdge = this.database.prepare(`
      INSERT INTO edge_outcomes(
        archive_id, cohort_id, month, time_control, rating_band, rating_detail,
        from_epd, uci, san, to_epd, min_ply, n, white_wins, draws, black_wins
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(archive_id, cohort_id, month, time_control, rating_band, rating_detail, from_epd, uci, to_epd)
      DO UPDATE SET
        min_ply = min(min_ply, excluded.min_ply),
        n = n + excluded.n,
        white_wins = white_wins + excluded.white_wins,
        draws = draws + excluded.draws,
        black_wins = black_wins + excluded.black_wins
    `)
  }

  close(): void {
    this.database.close()
  }

  beginArchive(identity: GraphArchiveIdentity): 'process' | 'skip' {
    if (
      !ARCHIVE_ID_PATTERN.test(identity.archiveId) ||
      !SOURCE_ID_PATTERN.test(identity.sourceId) ||
      !MONTH_PATTERN.test(identity.month) ||
      !SHA256_PATTERN.test(identity.sha256)
    ) throw new Error('Invalid graph archive identity')
    const existing = this.database.prepare(
      'SELECT source_id, month, sha256, status FROM archive_runs WHERE archive_id = ?',
    ).get(identity.archiveId) as { source_id: string; month: string; sha256: string; status: string } | undefined
    if (existing?.status === 'complete') {
      if (
        existing.source_id !== identity.sourceId ||
        existing.month !== identity.month ||
        existing.sha256 !== identity.sha256
      ) throw new Error(`Completed archive identity changed: ${identity.archiveId}`)
      return 'skip'
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('DELETE FROM archive_runs WHERE archive_id = ?').run(identity.archiveId)
      this.database.prepare(`
        INSERT INTO archive_runs(archive_id, source_id, month, sha256, status)
        VALUES (?, ?, ?, ?, 'processing')
      `).run(identity.archiveId, identity.sourceId, identity.month, identity.sha256)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
    return 'process'
  }

  hasCompletedArchive(identity: GraphArchiveIdentity): boolean {
    const existing = this.database.prepare(
      'SELECT source_id, month, sha256, status FROM archive_runs WHERE archive_id = ?',
    ).get(identity.archiveId) as { source_id: string; month: string; sha256: string; status: string } | undefined
    if (!existing || existing.status !== 'complete') return false
    if (
      existing.source_id !== identity.sourceId ||
      existing.month !== identity.month ||
      existing.sha256 !== identity.sha256
    ) throw new Error(`Completed archive identity changed: ${identity.archiveId}`)
    return true
  }

  /**
   * Merge an independently completed archive shard. Cross-archive duplicate
   * keys return false so the caller can replay only that archive against the
   * global game table; aggregate counts are never guessed or double-counted.
   */
  mergeCompletedShard(identity: GraphArchiveIdentity, shardPath: string): boolean {
    const escaped = shardPath.replaceAll("'", "''")
    this.database.exec(`ATTACH DATABASE '${escaped}' AS incoming`)
    try {
      const incoming = this.database.prepare(`
        SELECT source_id, month, sha256, status FROM incoming.archive_runs WHERE archive_id = ?
      `).get(identity.archiveId) as { source_id: string; month: string; sha256: string; status: string } | undefined
      if (
        !incoming || incoming.status !== 'complete' || incoming.source_id !== identity.sourceId ||
        incoming.month !== identity.month || incoming.sha256 !== identity.sha256
      ) throw new Error(`Evidence shard does not contain completed archive ${identity.archiveId}`)
      const archiveCount = (this.database.prepare(
        'SELECT count(*) AS count FROM incoming.archive_runs',
      ).get() as { count: number }).count
      if (archiveCount !== 1) throw new Error('Evidence shard must contain exactly one archive')
      const duplicates = (this.database.prepare(`
        SELECT count(*) AS count FROM incoming.games AS candidate
        INNER JOIN main.games AS existing
          ON existing.source_id = candidate.source_id
         AND existing.deduplication_key = candidate.deduplication_key
      `).get() as { count: number }).count
      if (duplicates > 0) return false

      this.database.exec('BEGIN IMMEDIATE')
      try {
        this.database.prepare('DELETE FROM archive_runs WHERE archive_id = ?').run(identity.archiveId)
        this.database.prepare(`
          INSERT INTO archive_runs
          SELECT * FROM incoming.archive_runs WHERE archive_id = ?
        `).run(identity.archiveId)
        this.database.exec(`
          INSERT INTO games SELECT * FROM incoming.games;
          INSERT INTO position_outcomes SELECT * FROM incoming.position_outcomes;
          INSERT INTO edge_outcomes SELECT * FROM incoming.edge_outcomes;
        `)
        this.database.exec('COMMIT')
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
      return true
    } finally {
      this.database.exec('DETACH DATABASE incoming')
    }
  }

  insertAcceptedGame(identity: GraphArchiveIdentity, game: GraphAcceptedGame): boolean {
    if (identity.sourceId !== game.sourceId || identity.month !== game.month) {
      throw new Error('Parsed game source/month does not match its archive')
    }
    const existing = this.database.prepare(`
      SELECT corruption_guard_sha256 FROM games
      WHERE source_id = ? AND deduplication_key = ?
    `).get(game.sourceId, game.deduplicationKey) as { corruption_guard_sha256: string } | undefined
    if (existing) {
      if (existing.corruption_guard_sha256 !== game.corruptionGuardSha256) {
        throw new Error(`Deduplicated game content conflicts for ${game.deduplicationKey}`)
      }
      return false
    }
    this.database.prepare(`
      INSERT INTO games(source_id, deduplication_key, corruption_guard_sha256, archive_id)
      VALUES (?, ?, ?, ?)
    `).run(game.sourceId, game.deduplicationKey, game.corruptionGuardSha256, identity.archiveId)
    return true
  }

  flushOutcomes(
    positions: ReadonlyMap<string, MutableOutcome>,
    edges: ReadonlyMap<string, MutableEdgeOutcome>,
  ): void {
    for (const value of positions.values()) {
      this.insertPosition.run(
        value.archiveId,
        value.cohortId,
        value.month,
        value.timeControl,
        value.ratingBand,
        value.ratingDetail,
        value.epd,
        value.minPly,
        value.n,
        value.whiteWins,
        value.draws,
        value.blackWins,
      )
    }
    for (const value of edges.values()) {
      this.insertEdge.run(
        value.archiveId,
        value.cohortId,
        value.month,
        value.timeControl,
        value.ratingBand,
        value.ratingDetail,
        value.epd,
        value.uci,
        value.san,
        value.toEpd,
        value.minPly,
        value.n,
        value.whiteWins,
        value.draws,
        value.blackWins,
      )
    }
  }

  updateArchive(identity: GraphArchiveIdentity, totals: GraphIngestionTotals, complete: boolean): void {
    const result = this.database.prepare(`
      UPDATE archive_runs SET
        records_seen = ?, accepted = ?, deduplicated = ?, rejected_json = ?,
        status = ?, completed_at = ?
      WHERE archive_id = ? AND source_id = ? AND sha256 = ?
    `).run(
      totals.recordsSeen,
      totals.accepted,
      totals.deduplicated,
      JSON.stringify(totals.rejected),
      complete ? 'complete' : 'processing',
      complete ? new Date().toISOString() : null,
      identity.archiveId,
      identity.sourceId,
      identity.sha256,
    )
    if (result.changes !== 1) throw new Error(`Could not update archive ${identity.archiveId}`)
  }
}

function incrementRejected(
  totals: GraphIngestionTotals,
  reason: GraphRejectionReason,
): void {
  totals.rejected[reason] = (totals.rejected[reason] ?? 0) + 1
}

export async function ingestGraphRecords(options: {
  store: EvidenceGraphStore
  identity: GraphArchiveIdentity
  records: AsyncIterable<PgnRecord>
  parse: (pgn: string, month: string) => ParseGraphGameResult
  ingestion?: GraphIngestionOptions
}): Promise<GraphIngestionTotals & { skipped: boolean }> {
  const maximumPly = options.ingestion?.maximumPly ?? REPERTOIRE_MAX_PLY
  const batchGames = options.ingestion?.batchGames ?? 2_000
  if (maximumPly !== REPERTOIRE_MAX_PLY) throw new Error('Production evidence graph maximum ply is fixed at 30')
  if (!Number.isSafeInteger(batchGames) || batchGames < 1 || batchGames > 50_000) {
    throw new Error('batchGames must be an integer from 1 through 50,000')
  }
  if (options.store.beginArchive(options.identity) === 'skip') {
    const row = options.store.database.prepare(`
      SELECT records_seen, accepted, deduplicated, rejected_json
      FROM archive_runs WHERE archive_id = ?
    `).get(options.identity.archiveId) as {
      records_seen: number
      accepted: number
      deduplicated: number
      rejected_json: string
    }
    return {
      recordsSeen: row.records_seen,
      accepted: row.accepted,
      deduplicated: row.deduplicated,
      rejected: JSON.parse(row.rejected_json) as GraphIngestionTotals['rejected'],
      skipped: true,
    }
  }

  const totals: GraphIngestionTotals = { recordsSeen: 0, accepted: 0, deduplicated: 0, rejected: {} }
  let positions = new Map<string, MutableOutcome>()
  let edges = new Map<string, MutableEdgeOutcome>()
  let gamesInBatch = 0
  const commitBatch = (complete: boolean): void => {
    options.store.flushOutcomes(positions, edges)
    options.store.updateArchive(options.identity, totals, complete)
    positions = new Map()
    edges = new Map()
    gamesInBatch = 0
  }

  options.store.database.exec('BEGIN IMMEDIATE')
  try {
    for await (const record of options.records) {
      totals.recordsSeen += 1
      if (record.rejection || record.pgn === null) {
        incrementRejected(totals, record.rejection ?? 'record_too_large')
        continue
      }
      const parsed = options.parse(record.pgn, options.identity.month)
      if (!parsed.accepted) {
        incrementRejected(totals, parsed.reason)
        continue
      }
      if (!options.store.insertAcceptedGame(options.identity, parsed.game)) {
        totals.deduplicated += 1
        continue
      }
      totals.accepted += 1
      addGameContributions(options.identity.archiveId, parsed.game, maximumPly, positions, edges)
      gamesInBatch += 1
      if (gamesInBatch >= batchGames) {
        commitBatch(false)
        options.store.database.exec('COMMIT')
        options.store.database.exec('BEGIN IMMEDIATE')
      }
    }
    commitBatch(true)
    options.store.database.exec('COMMIT')
  } catch (error) {
    options.store.database.exec('ROLLBACK')
    throw error
  }
  return { ...totals, skipped: false }
}

export const GRAPH_PGN_LIMITS: PgnLimits = {
  ...DEFAULT_PGN_LIMITS,
  maxPlies: 1_000,
}

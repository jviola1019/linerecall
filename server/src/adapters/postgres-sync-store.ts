import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type {
  CardStateV2,
  ProgressSettingsV2,
  PuzzleAttemptSyncRequest,
  PuzzleAttemptSyncResponse,
  PuzzleProgressBootstrapResponse,
  ReviewEventV1,
  SyncRejection,
  SyncRequestV1,
  SyncResponseV1,
} from '../contracts.js'
import { ProgressSettingsV2Schema } from '../contracts.js'
import { replayCard, serializeCard, type StoredReviewEvent } from '../domain/sm2.js'
import { ApiError } from '../errors.js'
import type { SyncStore } from '../ports.js'
import type { ObjectStore } from '../infrastructure/ports.js'

interface EventRow extends QueryResultRow {
  event_id: string
  device_id: string
  card_id: string
  pack_id: string
  node_id: string
  grade: ReviewEventV1['grade']
  occurred_at: Date
  normalized_occurred_at: Date
  received_at: Date
  local_date: string
  time_zone: string
  snapshot_version: string
  corrects_event_id: string | null
  sync_sequence: string
}

interface CardRow extends QueryResultRow {
  card_id: string
  repetitions: number
  interval_days: number
  ease_factor: string
  due_at: Date
  last_reviewed_at: Date | null
  mastery: number
  last_event_id: string | null
  sync_sequence: string
}

interface ImportExportRow extends QueryResultRow {
  id: string; display_name: string; trained_side: string; status: string
  source_sha256: string; failure_code: string | null; created_at: Date; updated_at: Date
}
interface RepertoireExportRow extends QueryResultRow {
  id: string; version: number; current_revision_id: string | null; updated_at: Date
}
interface RevisionExportRow extends QueryResultRow {
  id: string; repertoire_id: string; version: number; document: unknown; created_at: Date
}
interface ShareExportRow extends QueryResultRow {
  id: string; repertoire_id: string; revision_id: string
  expires_at: Date | null; revoked_at: Date | null; created_at: Date
}
interface PuzzleExportRow extends QueryResultRow {
  puzzle_id: string; attempts: number; solved: number; abandoned: number
  clean_solves: number; hints_used: number; incorrect_moves: string
  total_elapsed_ms: string; last_elapsed_ms: number | null; last_attempt_at: Date | null
}
interface PuzzleAttemptRow extends QueryResultRow {
  attempt_id: string; device_id: string; puzzle_id: string; solved: boolean; abandoned: boolean
  incorrect_attempts: number; used_hint: boolean; elapsed_ms: number | null
  occurred_at: Date; normalized_occurred_at: Date; received_at: Date
  snapshot_version: string; sync_sequence: string
}
interface ConnectionExportRow extends QueryResultRow {
  provider: string; consented_at: Date; last_synced_at: Date | null; disconnected_at: Date | null
  sync_cursor_last_move_at: string | null; sync_cursor_game_digest: string | null
}
interface LichessSyncJobExportRow extends QueryResultRow {
  id: string; status: string; requested_at: Date; sync_started_at: Date
  started_at: Date | null; completed_at: Date | null; retry_at: Date | null
  attempts: number; processed_records: string; accepted_games: string
  rejected_records: string; failure_code: string | null
}
interface LichessImportedGameExportRow extends QueryResultRow {
  game_id_digest: string; last_move_at: string; processed_at: Date
}
interface PersonalOpeningEdgeExportRow extends QueryResultRow {
  edge_key: string; from_epd: string; uci: string; san: string; to_epd: string
  speed: string; trained_side: string; rating_band: string; opening_eco: string
  opening_name: string; opening_ply: number; ply: number; games: string
  wins: string; draws: string; losses: string; first_seen_at: Date; last_seen_at: Date
}

const DEFAULT_SETTINGS = ProgressSettingsV2Schema.parse({})

function eventFromRow(row: EventRow): StoredReviewEvent {
  return {
    eventId: row.event_id,
    deviceId: row.device_id,
    cardId: row.card_id,
    packId: row.pack_id,
    nodeId: row.node_id,
    grade: row.grade,
    occurredAt: row.occurred_at.toISOString(),
    localDate: row.local_date,
    timeZone: row.time_zone,
    snapshotVersion: row.snapshot_version,
    ...(row.corrects_event_id ? { correctsEventId: row.corrects_event_id } : {}),
    normalizedOccurredAt: row.normalized_occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    syncSequence: BigInt(row.sync_sequence),
  }
}

function immutableEventMatches(row: EventRow, event: ReviewEventV1): boolean {
  return row.event_id === event.eventId && row.device_id === event.deviceId && row.card_id === event.cardId &&
    row.pack_id === event.packId && row.node_id === event.nodeId && row.grade === event.grade &&
    row.occurred_at.toISOString() === new Date(event.occurredAt).toISOString() &&
    row.local_date === event.localDate && row.time_zone === event.timeZone &&
    row.snapshot_version === event.snapshotVersion && row.corrects_event_id === (event.correctsEventId ?? null)
}

function cardFromRow(row: CardRow): CardStateV2 {
  return {
    cardId: row.card_id,
    repetitions: row.repetitions,
    intervalDays: row.interval_days,
    easeFactor: Number(row.ease_factor),
    dueAt: row.due_at.toISOString(),
    lastReviewedAt: row.last_reviewed_at?.toISOString() ?? null,
    mastery: row.mastery,
    lastEventId: row.last_event_id,
    syncSequence: row.sync_sequence,
  }
}

export class PostgresSyncStore implements SyncStore {
  constructor(private readonly pool: Pool, private readonly objects?: ObjectStore) {}

  async sync(userId: string, request: SyncRequestV1, now: Date): Promise<SyncResponseV1> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.#setUser(client, userId)
      // All writers for a user share this transaction-scoped lock. It prevents
      // concurrent event replay and settings/card projections from overwriting
      // one another even when requests land on different API tasks.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId])
      const acceptedEventIds: string[] = []
      const rejectedEvents: SyncRejection[] = []
      const affectedCards = new Set<string>()

      for (const event of request.events) {
        const snapshot = await client.query('SELECT 1 FROM supported_snapshot_versions WHERE version = $1 AND retired_at IS NULL', [event.snapshotVersion])
        if (snapshot.rowCount !== 1) {
          rejectedEvents.push({ eventId: event.eventId, code: 'unsupported_snapshot', message: 'The repertoire snapshot is not active' })
          continue
        }
        const membership = await client.query(
          `SELECT 1 FROM snapshot_card_membership
           WHERE snapshot_version=$1 AND pack_id=$2 AND node_id=$3 AND card_id=$4`,
          [event.snapshotVersion, event.packId, event.nodeId, event.cardId],
        )
        if (membership.rowCount !== 1) {
          rejectedEvents.push({
            eventId: event.eventId,
            code: 'unknown_card_membership',
            message: 'The card does not belong to the referenced signed repertoire snapshot',
          })
          continue
        }

        const duplicate = await client.query<EventRow>('SELECT * FROM review_events WHERE user_id = $1 AND event_id = $2', [userId, event.eventId])
        if (duplicate.rows[0]) {
          if (immutableEventMatches(duplicate.rows[0], event)) acceptedEventIds.push(event.eventId)
          else rejectedEvents.push({ eventId: event.eventId, code: 'conflicting_event_id', message: 'The immutable event ID has different content' })
          continue
        }

        if (event.correctsEventId) {
          const target = await client.query<EventRow>(
            `SELECT target.*,
              NOT EXISTS (
                SELECT 1 FROM review_events later
                WHERE later.user_id = target.user_id AND later.card_id = target.card_id
                  AND later.corrects_event_id IS NULL
                  AND (later.normalized_occurred_at, later.received_at, later.event_id) >
                      (target.normalized_occurred_at, target.received_at, target.event_id)
              ) AS is_latest,
              NOT EXISTS (
                SELECT 1 FROM review_events correction
                WHERE correction.user_id = target.user_id AND correction.corrects_event_id = target.event_id
              ) AS is_uncorrected
            FROM review_events target
            WHERE target.user_id = $1 AND target.event_id = $2`,
            [userId, event.correctsEventId],
          )
          const row = target.rows[0] as (EventRow & { is_latest: boolean; is_uncorrected: boolean }) | undefined
          if (!row || !row.is_latest || !row.is_uncorrected || row.card_id !== event.cardId || row.pack_id !== event.packId || row.node_id !== event.nodeId) {
            rejectedEvents.push({ eventId: event.eventId, code: 'invalid_correction', message: 'Only the latest uncorrected review of this card can be corrected' })
            continue
          }
        }

        const incomingTime = new Date(event.occurredAt)
        const normalized = incomingTime.getTime() > now.getTime() + 300_000 ? now : incomingTime
        await client.query(
          `INSERT INTO review_events (
            user_id, event_id, device_id, card_id, pack_id, node_id, grade,
            occurred_at, normalized_occurred_at, received_at, local_date,
            time_zone, snapshot_version, corrects_event_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [userId, event.eventId, event.deviceId, event.cardId, event.packId, event.nodeId, event.grade,
            incomingTime, normalized, now, event.localDate, event.timeZone, event.snapshotVersion, event.correctsEventId ?? null],
        )
        acceptedEventIds.push(event.eventId)
        affectedCards.add(event.cardId)
        if (normalized !== incomingTime) rejectedEvents.push({
          eventId: event.eventId,
          code: 'future_timestamp_normalized',
          message: 'The review time was normalized to server time',
        })
      }

      if (request.settingsMutation) {
        const mutation = request.settingsMutation
        const changed = mutation.baseVersion === 0
          ? await client.query(
            `INSERT INTO user_settings (user_id, version, value, sync_sequence, updated_at)
             VALUES ($1, 1, $2, nextval('linerecall_sync_sequence'), $3)
             ON CONFLICT (user_id) DO NOTHING`,
            [userId, mutation.value, now],
          )
          : await client.query(
            `UPDATE user_settings SET
               version=version+1, value=$3,
               sync_sequence=nextval('linerecall_sync_sequence'), updated_at=$4
             WHERE user_id=$1 AND version=$2`,
            [userId, mutation.baseVersion, mutation.value, now],
          )
        if (changed.rowCount !== 1) {
          throw new ApiError(409, 'settings_version_conflict', 'Settings changed on another device; refresh and try again')
        }
      }

      for (const cardId of affectedCards) await this.#rebuildCard(client, userId, cardId, now)
      const response = await this.#page(client, userId, BigInt(request.cursor ?? '0'), 250, now, acceptedEventIds, rejectedEvents)
      await client.query('COMMIT')
      return response
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async bootstrap(userId: string, cursor: bigint, limit: number, now: Date): Promise<SyncResponseV1> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await this.#setUser(client, userId)
      const response = await this.#page(client, userId, cursor, limit, now, [], [])
      await client.query('COMMIT')
      return response
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async bootstrapPuzzleProgress(
    userId: string,
    cursor: bigint,
    limit: number,
    now: Date,
  ): Promise<PuzzleProgressBootstrapResponse> {
    if (cursor < 0n || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new ApiError(422, 'invalid_cursor', 'Puzzle progress cursor is invalid')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await this.#setUser(client, userId)
      const result = await client.query<PuzzleExportRow & { sync_sequence: string }>(
        `SELECT puzzle_id,attempts,solved,abandoned,clean_solves,hints_used,
                incorrect_moves::text,total_elapsed_ms::text,last_elapsed_ms,last_attempt_at,sync_sequence::text
         FROM puzzle_progress
         WHERE user_id=$1 AND sync_sequence>$2
         ORDER BY sync_sequence,puzzle_id
         LIMIT $3`,
        [userId, cursor.toString(), limit + 1],
      )
      const hasMore = result.rows.length > limit
      const page = result.rows.slice(0, limit)
      const progress = page.map((row) => ({
        puzzleId: row.puzzle_id,
        attempts: row.attempts,
        solved: row.solved,
        abandoned: row.abandoned,
        cleanSolves: row.clean_solves,
        hintsUsed: row.hints_used,
        incorrectMoves: Number(row.incorrect_moves),
        totalElapsedMs: Number(row.total_elapsed_ms),
        lastElapsedMs: row.last_elapsed_ms,
        lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
        syncSequence: row.sync_sequence,
      }))
      const response = {
        progress,
        nextCursor: page.at(-1)?.sync_sequence ?? cursor.toString(),
        hasMore,
        serverTime: now.toISOString(),
      }
      await client.query('COMMIT')
      return response
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async syncPuzzleAttempts(userId: string, request: PuzzleAttemptSyncRequest, now: Date): Promise<PuzzleAttemptSyncResponse> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.#setUser(client, userId)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId])
      const acceptedAttemptIds: string[] = []
      const rejectedAttempts: PuzzleAttemptSyncResponse['rejectedAttempts'] = []
      const affected = new Set<string>()
      for (const incoming of request.attempts) {
        const snapshot = await client.query(
          'SELECT 1 FROM supported_snapshot_versions WHERE version=$1 AND retired_at IS NULL', [incoming.snapshotVersion],
        )
        if (snapshot.rowCount !== 1) {
          rejectedAttempts.push({ attemptId: incoming.attemptId, code: 'unsupported_snapshot', message: 'The puzzle snapshot is not active' })
          continue
        }
        const membership = await client.query(
          'SELECT 1 FROM snapshot_puzzle_membership WHERE snapshot_version=$1 AND puzzle_id=$2',
          [incoming.snapshotVersion, incoming.puzzleId],
        )
        if (membership.rowCount !== 1) {
          rejectedAttempts.push({ attemptId: incoming.attemptId, code: 'unknown_puzzle_membership', message: 'The puzzle is absent from the signed snapshot' })
          continue
        }
        const duplicate = await client.query<PuzzleAttemptRow>(
          'SELECT * FROM puzzle_attempt_events WHERE user_id=$1 AND attempt_id=$2', [userId, incoming.attemptId],
        )
        const previous = duplicate.rows[0]
        if (previous) {
          const same = previous.device_id === incoming.deviceId && previous.puzzle_id === incoming.puzzleId &&
            previous.solved === (incoming.outcome === 'solved') &&
            previous.abandoned === (incoming.outcome === 'abandoned') &&
            previous.incorrect_attempts === incoming.incorrectAttempts &&
            previous.used_hint === incoming.usedHint &&
            (previous.elapsed_ms ?? undefined) === incoming.elapsedMs &&
            previous.occurred_at.toISOString() === new Date(incoming.occurredAt).toISOString() &&
            previous.snapshot_version === incoming.snapshotVersion
          if (same) {
            acceptedAttemptIds.push(incoming.attemptId)
            affected.add(incoming.puzzleId)
          } else rejectedAttempts.push({
            attemptId: incoming.attemptId, code: 'conflicting_attempt_id', message: 'The attempt ID has different immutable content',
          })
          continue
        }
        const occurredAt = new Date(incoming.occurredAt)
        const future = occurredAt.getTime() > now.getTime() + 5 * 60_000
        const normalized = future ? now : occurredAt
        const inserted = await client.query<{ sync_sequence: string }>(
          `INSERT INTO puzzle_attempt_events
           (user_id,attempt_id,device_id,puzzle_id,solved,abandoned,incorrect_attempts,used_hint,elapsed_ms,
            occurred_at,normalized_occurred_at,received_at,snapshot_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING sync_sequence::text`,
          [userId, incoming.attemptId, incoming.deviceId, incoming.puzzleId,
            incoming.outcome === 'solved', incoming.outcome === 'abandoned',
            incoming.incorrectAttempts, incoming.usedHint, incoming.elapsedMs ?? null,
            occurredAt, normalized, now, incoming.snapshotVersion],
        )
        const sequence = inserted.rows[0]!.sync_sequence
        const solved = incoming.outcome === 'solved'
        const clean = solved && incoming.incorrectAttempts === 0 && !incoming.usedHint
        await client.query(
          `INSERT INTO puzzle_progress
             (user_id,puzzle_id,attempts,solved,abandoned,clean_solves,hints_used,incorrect_moves,
              total_elapsed_ms,last_elapsed_ms,last_attempt_at,sync_sequence)
           VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (user_id,puzzle_id) DO UPDATE SET
             attempts=puzzle_progress.attempts+1,
             solved=puzzle_progress.solved+EXCLUDED.solved,
             abandoned=puzzle_progress.abandoned+EXCLUDED.abandoned,
             clean_solves=puzzle_progress.clean_solves+EXCLUDED.clean_solves,
             hints_used=puzzle_progress.hints_used+EXCLUDED.hints_used,
             incorrect_moves=puzzle_progress.incorrect_moves+EXCLUDED.incorrect_moves,
             total_elapsed_ms=puzzle_progress.total_elapsed_ms+EXCLUDED.total_elapsed_ms,
             last_elapsed_ms=CASE
               WHEN puzzle_progress.last_attempt_at IS NULL OR EXCLUDED.last_attempt_at >= puzzle_progress.last_attempt_at
                 THEN EXCLUDED.last_elapsed_ms
               ELSE puzzle_progress.last_elapsed_ms
             END,
             last_attempt_at=CASE
               WHEN puzzle_progress.last_attempt_at IS NULL OR EXCLUDED.last_attempt_at >= puzzle_progress.last_attempt_at
                 THEN EXCLUDED.last_attempt_at
               ELSE puzzle_progress.last_attempt_at
             END,
             sync_sequence=EXCLUDED.sync_sequence`,
          [userId, incoming.puzzleId, solved ? 1 : 0, solved ? 0 : 1, clean ? 1 : 0,
            incoming.usedHint ? 1 : 0, incoming.incorrectAttempts, incoming.elapsedMs ?? 0,
            incoming.elapsedMs ?? null, normalized, sequence],
        )
        acceptedAttemptIds.push(incoming.attemptId)
        affected.add(incoming.puzzleId)
        if (future) rejectedAttempts.push({
          attemptId: incoming.attemptId, code: 'future_timestamp_normalized',
          message: 'The attempt time was over five minutes in the future and was normalized',
        })
      }
      const ids = [...affected]
      const progress = ids.length === 0 ? { rows: [] as Array<PuzzleExportRow & { sync_sequence: string }> } : await client.query<PuzzleExportRow & { sync_sequence: string }>(
        `SELECT puzzle_id,attempts,solved,abandoned,clean_solves,hints_used,
                incorrect_moves::text,total_elapsed_ms::text,last_elapsed_ms,last_attempt_at,sync_sequence::text
         FROM puzzle_progress WHERE user_id=$1 AND puzzle_id=ANY($2::text[]) ORDER BY puzzle_id`, [userId, ids],
      )
      await client.query('COMMIT')
      return {
        acceptedAttemptIds,
        rejectedAttempts,
        progress: progress.rows.map((row) => ({
          puzzleId: row.puzzle_id, attempts: row.attempts, solved: row.solved,
          abandoned: row.abandoned, cleanSolves: row.clean_solves, hintsUsed: row.hints_used,
          incorrectMoves: Number(row.incorrect_moves), totalElapsedMs: Number(row.total_elapsed_ms),
          lastElapsedMs: row.last_elapsed_ms,
          lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
          syncSequence: row.sync_sequence,
        })),
        serverTime: now.toISOString(),
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async exportAccount(userId: string, now: Date): Promise<unknown> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await this.#setUser(client, userId)
      const [
        events, cards, settings, imports, repertoires, revisions, shares, puzzles,
        puzzleAttempts, connections, lichessSyncJobs, lichessImportedGames, personalOpeningEdges,
      ] = await Promise.all([
        client.query<EventRow>('SELECT * FROM review_events WHERE user_id = $1 ORDER BY sync_sequence', [userId]),
        client.query<CardRow>('SELECT * FROM card_states WHERE user_id = $1 ORDER BY card_id', [userId]),
        this.#settings(client, userId),
        client.query<ImportExportRow>(
          `SELECT id,display_name,trained_side,status,source_sha256,failure_code,created_at,updated_at
           FROM repertoire_import_jobs WHERE user_id=$1 ORDER BY created_at,id`, [userId],
        ),
        client.query<RepertoireExportRow>(
          'SELECT id,version,current_revision_id,updated_at FROM repertoires WHERE user_id=$1 ORDER BY id', [userId],
        ),
        client.query<RevisionExportRow>(
          `SELECT id,repertoire_id,version,document,created_at FROM repertoire_revisions
           WHERE user_id=$1 ORDER BY repertoire_id,version`, [userId],
        ),
        client.query<ShareExportRow>(
          `SELECT id,repertoire_id,revision_id,expires_at,revoked_at,created_at FROM share_links
           WHERE user_id=$1 ORDER BY created_at,id`, [userId],
        ),
        client.query<PuzzleExportRow>(
          `SELECT puzzle_id,attempts,solved,abandoned,clean_solves,hints_used,
                  incorrect_moves::text,total_elapsed_ms::text,last_elapsed_ms,last_attempt_at
           FROM puzzle_progress WHERE user_id=$1 ORDER BY puzzle_id`, [userId],
        ),
        client.query<PuzzleAttemptRow>(
          `SELECT attempt_id,device_id,puzzle_id,solved,abandoned,incorrect_attempts,used_hint,elapsed_ms,
                  occurred_at,normalized_occurred_at,received_at,snapshot_version,sync_sequence::text
           FROM puzzle_attempt_events WHERE user_id=$1 ORDER BY sync_sequence`, [userId],
        ),
        client.query<ConnectionExportRow>(
          `SELECT provider,consented_at,last_synced_at,disconnected_at,
                  sync_cursor_last_move_at::text,sync_cursor_game_digest
           FROM external_connections
           WHERE user_id=$1 ORDER BY provider`, [userId],
        ),
        client.query<LichessSyncJobExportRow>(
          `SELECT id,status,requested_at,sync_started_at,started_at,completed_at,retry_at,
                  attempts,processed_records::text,accepted_games::text,rejected_records::text,failure_code
           FROM lichess_sync_jobs WHERE user_id=$1 ORDER BY requested_at,id`, [userId],
        ),
        client.query<LichessImportedGameExportRow>(
          `SELECT game_id_digest,last_move_at::text,processed_at
           FROM lichess_imported_game_ids WHERE user_id=$1 ORDER BY processed_at,game_id_digest`, [userId],
        ),
        client.query<PersonalOpeningEdgeExportRow>(
          `SELECT edge_key,from_epd,uci,san,to_epd,speed,trained_side,rating_band,opening_eco,
                  opening_name,opening_ply,ply,games::text,wins::text,draws::text,losses::text,
                  first_seen_at,last_seen_at
           FROM personal_opening_edge_aggregates WHERE user_id=$1 ORDER BY opening_eco,trained_side,edge_key`, [userId],
        ),
      ])
      await client.query('COMMIT')
      return {
        schema: 'linerecall-account-export-v4',
        exportedAt: now.toISOString(),
        settings,
        reviewEvents: events.rows.map(eventFromRow).map(({ syncSequence, ...event }) => ({ ...event, syncSequence: syncSequence.toString() })),
        cards: cards.rows.map(cardFromRow),
        imports: imports.rows.map((row) => ({
          id: row.id, name: row.display_name, side: row.trained_side, status: row.status,
          sourceSha256: row.source_sha256, failureCode: row.failure_code,
          createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
        })),
        repertoires: repertoires.rows.map((row) => ({
          id: row.id, version: row.version, currentRevisionId: row.current_revision_id,
          updatedAt: row.updated_at.toISOString(),
        })),
        repertoireRevisions: revisions.rows.map((row) => ({
          id: row.id, repertoireId: row.repertoire_id, version: row.version,
          document: row.document, createdAt: row.created_at.toISOString(),
        })),
        shares: shares.rows.map((row) => ({
          id: row.id, repertoireId: row.repertoire_id, revisionId: row.revision_id,
          expiresAt: row.expires_at?.toISOString() ?? null,
          revokedAt: row.revoked_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
        })),
        puzzleProgress: puzzles.rows.map((row) => ({
          puzzleId: row.puzzle_id, attempts: row.attempts, solved: row.solved,
          abandoned: row.abandoned, cleanSolves: row.clean_solves, hintsUsed: row.hints_used,
          incorrectMoves: Number(row.incorrect_moves), totalElapsedMs: Number(row.total_elapsed_ms),
          lastElapsedMs: row.last_elapsed_ms,
          lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
        })),
        puzzleAttempts: puzzleAttempts.rows.map((row) => ({
          attemptId: row.attempt_id, deviceId: row.device_id, puzzleId: row.puzzle_id,
          outcome: row.solved && !row.abandoned ? 'solved' : 'abandoned',
          incorrectAttempts: row.incorrect_attempts, usedHint: row.used_hint,
          ...(row.elapsed_ms === null ? {} : { elapsedMs: row.elapsed_ms }),
          occurredAt: row.occurred_at.toISOString(), normalizedOccurredAt: row.normalized_occurred_at.toISOString(),
          receivedAt: row.received_at.toISOString(), snapshotVersion: row.snapshot_version,
          syncSequence: row.sync_sequence,
        })),
        connections: connections.rows.map((row) => ({
          provider: row.provider, consentedAt: row.consented_at.toISOString(),
          lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
          disconnectedAt: row.disconnected_at?.toISOString() ?? null,
          syncCursor: row.sync_cursor_last_move_at && row.sync_cursor_game_digest
            ? { lastMoveAt: row.sync_cursor_last_move_at, gameDigest: row.sync_cursor_game_digest }
            : null,
        })),
        lichessSyncJobs: lichessSyncJobs.rows.map((row) => ({
          id: row.id, status: row.status, requestedAt: row.requested_at.toISOString(),
          syncStartedAt: row.sync_started_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null,
          completedAt: row.completed_at?.toISOString() ?? null, retryAt: row.retry_at?.toISOString() ?? null,
          attempts: row.attempts, processedRecords: row.processed_records,
          acceptedGames: row.accepted_games, rejectedRecords: row.rejected_records,
          failureCode: row.failure_code,
        })),
        lichessImportedGames: lichessImportedGames.rows.map((row) => ({
          gameIdDigest: row.game_id_digest, lastMoveAt: row.last_move_at,
          processedAt: row.processed_at.toISOString(),
        })),
        personalOpeningEdges: personalOpeningEdges.rows.map((row) => ({
          edgeKey: row.edge_key, fromEpd: row.from_epd, uci: row.uci, san: row.san, toEpd: row.to_epd,
          speed: row.speed, trainedSide: row.trained_side, ratingBand: row.rating_band,
          openingEco: row.opening_eco, openingName: row.opening_name,
          openingPly: row.opening_ply, ply: row.ply, games: row.games,
          wins: row.wins, draws: row.draws, losses: row.losses,
          firstSeenAt: row.first_seen_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(),
        })),
        excludedSecrets: ['provider access tokens', 'provider account identifiers', 'share token hashes', 'object-store keys'],
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async deleteAccount(userId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.#setUser(client, userId)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId])
      const importObjects = await client.query<{ source_object_key: string }>(
        'SELECT source_object_key FROM repertoire_import_jobs WHERE user_id=$1', [userId],
      )
      if (importObjects.rows.length > 0 && !this.objects) {
        throw new ApiError(503, 'private_object_store_unavailable', 'Account deletion cannot safely remove private imports')
      }
      await Promise.all(importObjects.rows.map((row) => this.objects!.deletePrivate(row.source_object_key)))
      for (const table of [
        'share_links', 'repertoire_revisions', 'repertoires', 'repertoire_import_jobs',
        'lichess_sync_jobs', 'lichess_imported_game_ids', 'personal_opening_edge_aggregates', 'external_connections',
        'puzzle_attempt_events', 'puzzle_progress', 'card_states', 'review_events', 'user_settings',
      ]) await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async #setUser(client: PoolClient, userId: string): Promise<void> {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
  }

  async #settings(client: PoolClient, userId: string): Promise<{ version: number; value: ProgressSettingsV2 }> {
    const result = await client.query<{ version: number; value: unknown }>('SELECT version, value FROM user_settings WHERE user_id = $1', [userId])
    const row = result.rows[0]
    return row ? { version: row.version, value: ProgressSettingsV2Schema.parse(row.value) } : { version: 0, value: DEFAULT_SETTINGS }
  }

  async #rebuildCard(client: PoolClient, userId: string, cardId: string, now: Date): Promise<void> {
    const rows = await client.query<EventRow>(
      'SELECT * FROM review_events WHERE user_id = $1 AND card_id = $2 ORDER BY normalized_occurred_at, received_at, event_id',
      [userId, cardId],
    )
    const highestSequence = rows.rows.reduce((max, row) => BigInt(row.sync_sequence) > max ? BigInt(row.sync_sequence) : max, 0n)
    const card = serializeCard(replayCard(cardId, rows.rows.map(eventFromRow), now), highestSequence)
    await client.query(
      `INSERT INTO card_states (
        user_id, card_id, repetitions, interval_days, ease_factor, due_at,
        last_reviewed_at, mastery, last_event_id, sync_sequence
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (user_id, card_id) DO UPDATE SET
        repetitions=EXCLUDED.repetitions, interval_days=EXCLUDED.interval_days,
        ease_factor=EXCLUDED.ease_factor, due_at=EXCLUDED.due_at,
        last_reviewed_at=EXCLUDED.last_reviewed_at, mastery=EXCLUDED.mastery,
        last_event_id=EXCLUDED.last_event_id, sync_sequence=EXCLUDED.sync_sequence`,
      [userId, card.cardId, card.repetitions, card.intervalDays, card.easeFactor, card.dueAt,
        card.lastReviewedAt, card.mastery, card.lastEventId, card.syncSequence],
    )
  }

  async #page(
    client: PoolClient,
    userId: string,
    cursor: bigint,
    limit: number,
    now: Date,
    acceptedEventIds: string[],
    rejectedEvents: SyncRejection[],
  ): Promise<SyncResponseV1> {
    const result = await client.query<CardRow>(
      'SELECT * FROM card_states WHERE user_id = $1 AND sync_sequence > $2 ORDER BY sync_sequence, card_id LIMIT $3',
      [userId, cursor.toString(), limit + 1],
    )
    const hasMore = result.rows.length > limit
    const cards = result.rows.slice(0, limit).map(cardFromRow)
    const settings = await this.#settings(client, userId)
    const sequence = await client.query<{ current: string }>(
      `SELECT GREATEST(
        COALESCE((SELECT max(sync_sequence) FROM review_events WHERE user_id=$1), 0),
        COALESCE((SELECT max(sync_sequence) FROM card_states WHERE user_id=$1), 0),
        COALESCE((SELECT max(sync_sequence) FROM user_settings WHERE user_id=$1), 0)
      )::text AS current`, [userId],
    )
    return {
      acceptedEventIds,
      rejectedEvents,
      cards,
      settings,
      nextCursor: hasMore && cards.length > 0 ? cards.at(-1)!.syncSequence : (sequence.rows[0]?.current ?? cursor.toString()),
      hasMore,
      serverTime: now.toISOString(),
    }
  }
}

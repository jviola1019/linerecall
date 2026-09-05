import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { Db, Queue } from 'pg-boss'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { uuidV7 } from '../ids.js'
import {
  buildLichessGamesUrl,
  streamLichessGameResponse,
  type LichessStreamChunk,
  type PersonalGameAggregate,
} from '../connections/lichess-game-stream.js'
import type { LichessSyncRequestResult, LichessSyncService, LichessSyncStatus } from '../ports.js'

export const LICHESS_SYNC_QUEUE = 'linerecall-lichess-sync'
export const LICHESS_SYNC_DEAD_LETTER_QUEUE = `${LICHESS_SYNC_QUEUE}-dead-letter`

const LichessSyncJobPayloadSchema = z.object({
  jobId: z.uuid(),
  userId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
}).strict()

export type LichessSyncJobPayload = z.infer<typeof LichessSyncJobPayloadSchema>

export interface LichessSyncTokenVault {
  open(userId: string, ciphertext: Uint8Array): Promise<string>
}

export interface LichessSyncProviderGate {
  run<T>(operation: (leaseSignal: AbortSignal) => Promise<T>): Promise<T>
  applyRateLimit(response: Response, attempt?: number): Promise<number>
}

interface BossClient {
  createQueue(name: string, options?: Omit<Queue, 'name'>): Promise<void>
  updateQueue(name: string, options?: Omit<Queue, 'name'>): Promise<void>
  send(name: string, data?: object | null, options?: Record<string, unknown>): Promise<string | null>
}

export interface TransactionalLichessSyncQueue {
  enqueue(client: PoolClient, input: LichessSyncJobPayload): Promise<void>
}

export interface LichessSyncWorkerAvailability {
  available(): Promise<boolean>
}

export const LICHESS_SYNC_WORKER_HEARTBEAT_KEY = 'linerecall:worker:lichess-sync:heartbeat'

interface RedisHeartbeatClient {
  pttl(key: string): Promise<number>
}

/**
 * A queue existing is not proof that a worker can consume it. This monitor
 * requires a short-lived heartbeat written by the separately deployed worker
 * before the API will accept a sync request.
 */
export class RedisLichessSyncWorkerAvailability implements LichessSyncWorkerAvailability {
  constructor(private readonly redis: RedisHeartbeatClient) {}

  async available(): Promise<boolean> {
    try {
      return await this.redis.pttl(LICHESS_SYNC_WORKER_HEARTBEAT_KEY) > 0
    } catch {
      return false
    }
  }
}

function transactionDatabase(client: PoolClient): Db {
  return {
    async executeSql(text, values) {
      const result = await client.query(text, values)
      return { rows: result.rows }
    },
  }
}

export class PgBossLichessSyncQueue implements TransactionalLichessSyncQueue {
  constructor(private readonly boss: BossClient) {}

  async initialize(): Promise<void> {
    await this.boss.createQueue(LICHESS_SYNC_DEAD_LETTER_QUEUE, {
      policy: 'standard', retentionSeconds: 2_592_000, deleteAfterSeconds: 0,
      warningQueueSize: 1, notify: true,
    })
    const options: Omit<Queue, 'name'> = {
      policy: 'standard', retryLimit: 8, retryDelay: 60, retryBackoff: true,
      retryDelayMax: 900, expireInSeconds: 3_600, retentionSeconds: 1_209_600,
      deleteAfterSeconds: 604_800, heartbeatSeconds: 120,
      deadLetter: LICHESS_SYNC_DEAD_LETTER_QUEUE, warningQueueSize: 250, notify: true,
    }
    await this.boss.createQueue(LICHESS_SYNC_QUEUE, options)
    await this.boss.updateQueue(LICHESS_SYNC_QUEUE, options)
  }

  async enqueue(client: PoolClient, candidate: LichessSyncJobPayload): Promise<void> {
    const input = LichessSyncJobPayloadSchema.parse(candidate)
    const id = await this.boss.send(LICHESS_SYNC_QUEUE, input, {
      id: input.jobId,
      singletonKey: input.userId,
      db: transactionDatabase(client),
    })
    if (!id) throw new Error('Durable Lichess sync queue rejected the job')
  }
}

export function parseLichessSyncJobPayload(value: unknown): LichessSyncJobPayload {
  return LichessSyncJobPayloadSchema.parse(value)
}

export class PostgresLichessSyncCoordinator implements LichessSyncService {
  constructor(
    private readonly pool: Pool,
    private readonly queue: TransactionalLichessSyncQueue,
    private readonly workers: LichessSyncWorkerAvailability = { available: async () => true },
  ) {}

  async request(userId: string, now: Date): Promise<LichessSyncRequestResult> {
    if (!await this.workers.available()) {
      throw new ApiError(503, 'lichess_sync_worker_unavailable', 'Lichess game sync is temporarily unavailable because no worker is ready', {
        retryAfterSeconds: 30,
      })
    }
    return this.#transaction(userId, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`lichess-sync-request:${userId}`])
      const connection = await client.query(
        `SELECT 1 FROM external_connections
         WHERE user_id=$1 AND provider='lichess' AND disconnected_at IS NULL`, [userId],
      )
      if (connection.rowCount !== 1) throw new ApiError(409, 'lichess_not_connected', 'Connect Lichess before syncing games')
      const active = await client.query<{
        id: string; status: LichessSyncRequestResult['status']; sync_started_at: Date
      }>(
        `SELECT id,status,sync_started_at FROM lichess_sync_jobs
         WHERE user_id=$1 AND status IN ('queued','running','retry_wait')
         ORDER BY requested_at DESC,id DESC LIMIT 1`, [userId],
      )
      const current = active.rows[0]
      if (current) return { jobId: current.id, status: current.status, syncStartedAt: current.sync_started_at.toISOString() }

      const jobId = uuidV7(now.getTime())
      await client.query(
        `INSERT INTO lichess_sync_jobs
          (user_id,id,status,requested_at,sync_started_at,attempts,processed_records,accepted_games,rejected_records)
         VALUES ($1,$2,'queued',$3,$3,0,0,0,0)`,
        [userId, jobId, now],
      )
      try {
        await this.queue.enqueue(client, { jobId, userId })
      } catch {
        throw new ApiError(503, 'lichess_sync_queue_unavailable', 'Lichess game sync could not be queued safely', {
          retryAfterSeconds: 30,
        })
      }
      return { jobId, status: 'queued', syncStartedAt: now.toISOString() }
    })
  }

  async status(userId: string, now: Date): Promise<LichessSyncStatus> {
    const workerAvailable = await this.workers.available()
    return this.#transaction(userId, async (client) => {
      const connection = await client.query<{ consented_at: Date; last_synced_at: Date | null }>(
        `SELECT consented_at,last_synced_at FROM external_connections
         WHERE user_id=$1 AND provider='lichess' AND disconnected_at IS NULL`, [userId],
      )
      const record = connection.rows[0]
      if (!record) return {
        available: workerAvailable,
        unavailableReason: workerAvailable ? null : 'worker_unavailable',
        connected: false,
        consentedAt: null,
        lastSyncedAt: null,
        job: null,
      }
      const jobs = await client.query<{
        id: string; status: NonNullable<LichessSyncStatus['job']>['status']; requested_at: Date; sync_started_at: Date
        retry_at: Date | null; processed_records: string; accepted_games: string; rejected_records: string; failure_code: string | null
      }>(
        `SELECT id,status,requested_at,sync_started_at,retry_at,processed_records,accepted_games,rejected_records,failure_code
         FROM lichess_sync_jobs WHERE user_id=$1 ORDER BY requested_at DESC,id DESC LIMIT 1`, [userId],
      )
      const job = jobs.rows[0]
      return {
        available: workerAvailable,
        unavailableReason: workerAvailable ? null : 'worker_unavailable',
        connected: true,
        consentedAt: record.consented_at.toISOString(),
        lastSyncedAt: record.last_synced_at?.toISOString() ?? null,
        job: job ? {
          id: job.id,
          status: job.status,
          requestedAt: job.requested_at.toISOString(),
          syncStartedAt: job.sync_started_at.toISOString(),
          retryAt: job.retry_at?.toISOString() ?? null,
          retryAfterSeconds: job.retry_at ? Math.max(0, Math.ceil((job.retry_at.getTime() - now.getTime()) / 1_000)) : null,
          processedRecords: job.processed_records,
          acceptedGames: job.accepted_games,
          rejectedRecords: job.rejected_records,
          failureCode: job.failure_code,
        } : null,
      }
    }, true)
  }

  async #transaction<T>(userId: string, callback: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
      await client.query(`SELECT set_config('app.user_id',$1,true)`, [userId])
      const result = await callback(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

type RatingBand = '<1200' | '1200-1499' | '1500-1799' | '1800-1999' | '2000-2199' | '2200-2399' | '2400+'

function ratingBand(rating: number): RatingBand {
  if (rating < 1_200) return '<1200'
  if (rating < 1_500) return '1200-1499'
  if (rating < 1_800) return '1500-1799'
  if (rating < 2_000) return '1800-1999'
  if (rating < 2_200) return '2000-2199'
  if (rating < 2_400) return '2200-2399'
  return '2400+'
}

function edgeKey(game: PersonalGameAggregate, edge: PersonalGameAggregate['edges'][number], band: RatingBand): string {
  return createHash('sha256').update([
    'linerecall-personal-edge-v1', edge.fromEpd, edge.uci, edge.toEpd, game.speed,
    game.side, band, game.openingEco, String(game.openingPly), String(edge.ply),
  ].join('\0')).digest('hex')
}

function serializeGames(games: readonly PersonalGameAggregate[]) {
  return games.map((game) => {
    const band = ratingBand(game.playerRating)
    return {
      game_id_digest: game.gameIdDigest,
      last_move_at: game.lastMoveAt,
      speed: game.speed,
      trained_side: game.side,
      outcome: game.outcome,
      rating_band: band,
      opening_eco: game.openingEco,
      opening_name: game.openingName,
      opening_ply: game.openingPly,
      edges: game.edges.map((edge) => ({
        edge_key: edgeKey(game, edge, band), ply: edge.ply, from_epd: edge.fromEpd,
        uci: edge.uci, san: edge.san, to_epd: edge.toEpd,
      })),
    }
  })
}

interface LoadedJob {
  syncStartedAt: Date
  attempt: number
  accountCiphertext: Buffer
  tokenCiphertext: Buffer
  cursor: { lastMoveAt: number; gameIdDigest: string } | null
  terminal: boolean
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface LichessSyncFailureDisposition {
  retryable: boolean
  code: string
  retryAfterSeconds: number | null
}

class PermanentLichessSyncError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PermanentLichessSyncError'
  }
}

function safeFailureCode(value: string | undefined): string {
  return value && /^[a-z0-9_]{1,64}$/u.test(value) ? value : 'lichess_sync_failed'
}

/**
 * Keeps the application row aligned with pg-boss. Infrastructure and process
 * interruptions remain active/retryable; invalid jobs and persisted data
 * invariants fail terminally. Only bounded codes, never exception messages, are
 * returned to queue output or persisted for users.
 */
export function classifyLichessSyncFailure(error: unknown): LichessSyncFailureDisposition {
  if (error instanceof PermanentLichessSyncError) {
    return { retryable: false, code: safeFailureCode(error.code), retryAfterSeconds: null }
  }
  if (error instanceof ApiError) {
    const retryable = error.retryAfterSeconds !== undefined || error.statusCode >= 500
    return {
      retryable,
      code: safeFailureCode(error.code),
      retryAfterSeconds: retryable ? Math.max(1, error.retryAfterSeconds ?? 60) : null,
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { retryable: true, code: 'lichess_sync_interrupted', retryAfterSeconds: 60 }
  }
  return { retryable: true, code: 'lichess_sync_failed', retryAfterSeconds: 60 }
}

export class LichessSyncRunner {
  constructor(
    private readonly pool: Pool,
    private readonly vault: LichessSyncTokenVault,
    private readonly gate: LichessSyncProviderGate,
    private readonly userAgent: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (userAgent.length < 10 || userAgent.length > 256 || !userAgent.includes('@')) {
      throw new Error('Provider User-Agent must include a monitored contact address')
    }
  }

  async run(candidate: LichessSyncJobPayload, workerSignal?: AbortSignal): Promise<{ status: 'succeeded' | 'already_terminal' }> {
    const input = LichessSyncJobPayloadSchema.parse(candidate)
    const lockClient = await this.pool.connect()
    let locked = false
    let claimed = false
    try {
      const lock = await lockClient.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`lichess-sync-run:${input.userId}`],
      )
      locked = lock.rows[0]?.locked === true
      if (!locked) throw new ApiError(503, 'lichess_sync_busy', 'A sync for this account is already running', { retryAfterSeconds: 5 })

      const loaded = await this.#loadAndMarkRunning(input)
      if (loaded.terminal) return { status: 'already_terminal' }
      claimed = true
      workerSignal?.throwIfAborted()
      const [accountId, token] = await Promise.all([
        this.vault.open(input.userId, loaded.accountCiphertext),
        this.vault.open(input.userId, loaded.tokenCiphertext),
      ])
      const url = buildLichessGamesUrl(accountId, loaded.cursor, loaded.syncStartedAt)

      await this.gate.run(async (leaseSignal) => {
        const response = await this.fetcher(url, {
          redirect: 'error',
          signal: AbortSignal.any([
            leaseSignal,
            AbortSignal.timeout(600_000),
            ...(workerSignal ? [workerSignal] : []),
          ]),
          headers: {
            Accept: 'application/x-ndjson', Authorization: `Bearer ${token}`, 'User-Agent': this.userAgent,
          },
        })
        if (response.status === 429) {
          const retryAfterSeconds = await this.gate.applyRateLimit(response, loaded.attempt)
          throw new ApiError(429, 'provider_rate_limited', 'Lichess requested a cooldown', { retryAfterSeconds })
        }
        for await (const chunk of streamLichessGameResponse(response, accountId, loaded.syncStartedAt)) {
          workerSignal?.throwIfAborted()
          await this.#commitChunk(input, chunk, this.clock())
        }
      })
      workerSignal?.throwIfAborted()
      await this.#complete(input, loaded.syncStartedAt, this.clock())
      return { status: 'succeeded' }
    } catch (error) {
      // A worker that failed to acquire or claim the job does not own the
      // application row and must not overwrite the active runner's status.
      if (claimed) await this.#recordFailure(input, error, this.clock())
      throw error
    } finally {
      if (locked) {
        await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`lichess-sync-run:${input.userId}`]).catch(() => undefined)
      }
      lockClient.release()
    }
  }

  async #loadAndMarkRunning(input: LichessSyncJobPayload): Promise<LoadedJob> {
    return this.#transaction(input.userId, async (client) => {
      const result = await client.query<{
        status: string; sync_started_at: Date; retry_at: Date | null; attempts: number
        provider_user_id_ciphertext: Buffer; access_token_ciphertext: Buffer
        sync_cursor_last_move_at: string | null; sync_cursor_game_digest: string | null
      }>(
        `SELECT job.status,job.sync_started_at,job.retry_at,job.attempts,
                connection.provider_user_id_ciphertext,connection.access_token_ciphertext,
                connection.sync_cursor_last_move_at,connection.sync_cursor_game_digest
         FROM lichess_sync_jobs job
         JOIN external_connections connection ON connection.user_id=job.user_id
           AND connection.provider='lichess' AND connection.disconnected_at IS NULL
         WHERE job.user_id=$1 AND job.id=$2 FOR UPDATE OF job`, [input.userId, input.jobId],
      )
      const row = result.rows[0]
      if (!row) throw new ApiError(409, 'lichess_sync_unavailable', 'The sync job or active connection is unavailable')
      if (row.status === 'succeeded' || row.status === 'cancelled') {
        return {
          syncStartedAt: row.sync_started_at, attempt: row.attempts,
          accountCiphertext: row.provider_user_id_ciphertext, tokenCiphertext: row.access_token_ciphertext,
          cursor: null, terminal: true,
        }
      }
      const current = this.clock()
      if (row.retry_at && row.retry_at > current) {
        throw new ApiError(429, 'provider_rate_limited', 'Lichess sync is waiting for its retry window', {
          retryAfterSeconds: Math.max(60, Math.ceil((row.retry_at.getTime() - current.getTime()) / 1_000)),
        })
      }
      const attempt = row.attempts + 1
      await client.query(
        `UPDATE lichess_sync_jobs SET status='running',started_at=COALESCE(started_at,$3),retry_at=NULL,
          failure_code=NULL,attempts=$4 WHERE user_id=$1 AND id=$2`,
        [input.userId, input.jobId, current, attempt],
      )
      const lastMoveAt = row.sync_cursor_last_move_at === null ? null : Number(row.sync_cursor_last_move_at)
      if (lastMoveAt !== null && !Number.isSafeInteger(lastMoveAt)) {
        throw new PermanentLichessSyncError('lichess_cursor_corrupt', 'Stored Lichess cursor is outside the safe integer range')
      }
      return {
        syncStartedAt: row.sync_started_at,
        attempt,
        accountCiphertext: row.provider_user_id_ciphertext,
        tokenCiphertext: row.access_token_ciphertext,
        cursor: lastMoveAt === null || !row.sync_cursor_game_digest ? null : {
          lastMoveAt, gameIdDigest: row.sync_cursor_game_digest,
        },
        terminal: false,
      }
    })
  }

  async #commitChunk(input: LichessSyncJobPayload, chunk: LichessStreamChunk, now: Date): Promise<void> {
    const rejected = Object.values(chunk.rejected).reduce((sum, count) => sum + count, 0)
    if (chunk.records !== chunk.accepted.length + rejected) {
      throw new PermanentLichessSyncError('lichess_chunk_accounting_invalid', 'Lichess stream chunk accounting is inconsistent')
    }
    const games = serializeGames(chunk.accepted)
    await this.#transaction(input.userId, async (client) => {
      const connection = await client.query(
        `SELECT 1 FROM external_connections
         WHERE user_id=$1 AND provider='lichess' AND disconnected_at IS NULL FOR UPDATE`, [input.userId],
      )
      if (connection.rowCount !== 1) throw new ApiError(409, 'lichess_disconnected', 'The Lichess connection was removed during sync')
      const committed = await client.query<{ inserted_count: string }>(
        `WITH input_games AS (
           SELECT * FROM jsonb_to_recordset($2::jsonb) AS game(
             game_id_digest text,last_move_at bigint,speed text,trained_side text,outcome text,
             rating_band text,opening_eco text,opening_name text,opening_ply integer,edges jsonb)
         ), new_games AS (
           INSERT INTO lichess_imported_game_ids (user_id,game_id_digest,last_move_at,processed_at)
           SELECT $1,game_id_digest,last_move_at,$3 FROM input_games
           ON CONFLICT (user_id,game_id_digest) DO NOTHING RETURNING game_id_digest
         ), deltas AS (
           SELECT edge.edge_key,edge.from_epd,edge.uci,edge.san,edge.to_epd,game.speed,game.trained_side,
                  game.rating_band,game.opening_eco,game.opening_name,game.opening_ply,edge.ply,
                  count(*)::bigint AS games,
                  count(*) FILTER (WHERE game.outcome='win')::bigint AS wins,
                  count(*) FILTER (WHERE game.outcome='draw')::bigint AS draws,
                  count(*) FILTER (WHERE game.outcome='loss')::bigint AS losses,
                  min(to_timestamp(game.last_move_at / 1000.0)) AS first_seen_at,
                  max(to_timestamp(game.last_move_at / 1000.0)) AS last_seen_at
           FROM input_games game JOIN new_games USING (game_id_digest)
           CROSS JOIN LATERAL jsonb_to_recordset(game.edges) AS edge(
             edge_key text,ply integer,from_epd text,uci text,san text,to_epd text)
           GROUP BY edge.edge_key,edge.from_epd,edge.uci,edge.san,edge.to_epd,game.speed,game.trained_side,
                    game.rating_band,game.opening_eco,game.opening_name,game.opening_ply,edge.ply
         ), aggregate_write AS (
           INSERT INTO personal_opening_edge_aggregates
             (user_id,edge_key,from_epd,uci,san,to_epd,speed,trained_side,rating_band,opening_eco,
              opening_name,opening_ply,ply,games,wins,draws,losses,first_seen_at,last_seen_at)
           SELECT $1,edge_key,from_epd,uci,san,to_epd,speed,trained_side,rating_band,opening_eco,
                  opening_name,opening_ply,ply,games,wins,draws,losses,first_seen_at,last_seen_at FROM deltas
           ON CONFLICT (user_id,edge_key) DO UPDATE SET
             games=personal_opening_edge_aggregates.games+EXCLUDED.games,
             wins=personal_opening_edge_aggregates.wins+EXCLUDED.wins,
             draws=personal_opening_edge_aggregates.draws+EXCLUDED.draws,
             losses=personal_opening_edge_aggregates.losses+EXCLUDED.losses,
             first_seen_at=LEAST(personal_opening_edge_aggregates.first_seen_at,EXCLUDED.first_seen_at),
             last_seen_at=GREATEST(personal_opening_edge_aggregates.last_seen_at,EXCLUDED.last_seen_at),
             san=LEAST(personal_opening_edge_aggregates.san,EXCLUDED.san),
             opening_name=LEAST(personal_opening_edge_aggregates.opening_name,EXCLUDED.opening_name)
           RETURNING 1
         ) SELECT count(*)::text AS inserted_count FROM new_games`,
        [input.userId, JSON.stringify(games), now],
      )
      const inserted = Number(committed.rows[0]?.inserted_count ?? '0')
      if (!Number.isSafeInteger(inserted) || inserted < 0) {
        throw new PermanentLichessSyncError('lichess_import_count_invalid', 'Invalid imported game count returned by PostgreSQL')
      }
      if (chunk.cursor) {
        await client.query(
          `UPDATE external_connections SET
             sync_cursor_last_move_at=$2,sync_cursor_game_digest=$3
           WHERE user_id=$1 AND provider='lichess' AND disconnected_at IS NULL AND (
             sync_cursor_last_move_at IS NULL OR sync_cursor_last_move_at < $2 OR
             (sync_cursor_last_move_at = $2 AND sync_cursor_game_digest < $3)
           )`, [input.userId, chunk.cursor.lastMoveAt, chunk.cursor.gameIdDigest],
        )
      }
      await client.query(
        `UPDATE lichess_sync_jobs SET processed_records=processed_records+$3,
          accepted_games=accepted_games+$4,rejected_records=rejected_records+$5
         WHERE user_id=$1 AND id=$2 AND status='running'`,
        [input.userId, input.jobId, chunk.records, inserted, rejected],
      )
    })
  }

  async #complete(input: LichessSyncJobPayload, syncStartedAt: Date, now: Date): Promise<void> {
    await this.#transaction(input.userId, async (client) => {
      const connection = await client.query(
        `UPDATE external_connections SET last_synced_at=$2
         WHERE user_id=$1 AND provider='lichess' AND disconnected_at IS NULL`, [input.userId, syncStartedAt],
      )
      if (connection.rowCount !== 1) throw new ApiError(409, 'lichess_disconnected', 'The Lichess connection was removed during sync')
      const job = await client.query(
        `UPDATE lichess_sync_jobs SET status='succeeded',completed_at=$3,retry_at=NULL,failure_code=NULL
         WHERE user_id=$1 AND id=$2 AND status='running'`, [input.userId, input.jobId, now],
      )
      if (job.rowCount !== 1) {
        throw new PermanentLichessSyncError('lichess_job_state_changed', 'Lichess sync job changed before completion')
      }
    })
  }

  async #recordFailure(input: LichessSyncJobPayload, error: unknown, now: Date): Promise<void> {
    const disposition = classifyLichessSyncFailure(error)
    const status = disposition.retryable ? 'retry_wait' : 'failed'
    await this.#transaction(input.userId, async (client) => {
      await client.query(
        `UPDATE lichess_sync_jobs SET status=$3,retry_at=$4,failure_code=$5,
          completed_at=CASE WHEN $3='failed' THEN $6 ELSE NULL END
         WHERE user_id=$1 AND id=$2 AND status NOT IN ('succeeded','cancelled')`,
        [input.userId, input.jobId, status,
          disposition.retryAfterSeconds === null ? null : new Date(now.getTime() + disposition.retryAfterSeconds * 1_000), disposition.code, now],
      )
    })
  }

  async #transaction<T>(userId: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.user_id',$1,true)`, [userId])
      const result = await callback(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

export type LichessSyncDeadLetterResult = 'marked_failed' | 'already_terminal_or_missing'

/**
 * Reconciles a pg-boss job that exhausted all retries. The update is tenant
 * scoped and idempotent; an already-terminal application failure is left
 * untouched by the status predicate.
 */
export class PostgresLichessSyncDeadLetterHandler {
  constructor(private readonly pool: Pool, private readonly clock: () => Date = () => new Date()) {}

  async handle(candidate: LichessSyncJobPayload): Promise<LichessSyncDeadLetterResult> {
    const input = LichessSyncJobPayloadSchema.parse(candidate)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.user_id',$1,true)`, [input.userId])
      const result = await client.query(
        `UPDATE lichess_sync_jobs SET status='failed',completed_at=COALESCE(completed_at,$3),retry_at=NULL,
           failure_code='lichess_sync_retries_exhausted'
         WHERE user_id=$1 AND id=$2 AND status NOT IN ('succeeded','cancelled','failed')`,
        [input.userId, input.jobId, this.clock()],
      )
      await client.query('COMMIT')
      return result.rowCount === 1 ? 'marked_failed' : 'already_terminal_or_missing'
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

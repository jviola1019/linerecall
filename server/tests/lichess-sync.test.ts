import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { ApiError } from '../src/errors.js'
import {
  LICHESS_SYNC_DEAD_LETTER_QUEUE,
  LICHESS_SYNC_QUEUE,
  PgBossLichessSyncQueue,
  PostgresLichessSyncCoordinator,
  RedisLichessSyncWorkerAvailability,
  parseLichessSyncJobPayload,
  type LichessSyncJobPayload,
  type TransactionalLichessSyncQueue,
} from '../src/jobs/lichess-sync.js'

const NOW = new Date('2026-07-15T12:00:00.000Z')

type QueryResult = { rows?: unknown[]; rowCount?: number | null }

class ScriptedDatabase {
  readonly statements: Array<{ sql: string; values: readonly unknown[] | undefined }> = []
  readonly client: PoolClient
  readonly pool: Pool

  constructor(private readonly answer: (sql: string, values: readonly unknown[] | undefined) => QueryResult = () => ({})) {
    const query = async (sql: string, values?: readonly unknown[]) => {
      this.statements.push({ sql, values })
      const result = this.answer(sql, values)
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 }
    }
    this.client = { query, release() {} } as unknown as PoolClient
    this.pool = { connect: async () => this.client } as unknown as Pool
  }
}

class RecordingQueue implements TransactionalLichessSyncQueue {
  readonly jobs: LichessSyncJobPayload[] = []
  fail = false

  async enqueue(_client: PoolClient, input: LichessSyncJobPayload): Promise<void> {
    this.jobs.push(input)
    if (this.fail) throw new Error('queue internals must not leak')
  }
}

describe('Lichess sync queue and API coordinator', () => {
  it('creates bounded retry/dead-letter queues and enqueues in the caller transaction', async () => {
    const created: string[] = []
    const updated: string[] = []
    const sent: Array<{ name: string; data: object | null | undefined; options: Record<string, unknown> | undefined }> = []
    const boss = {
      async createQueue(name: string) { created.push(name) },
      async updateQueue(name: string) { updated.push(name) },
      async send(name: string, data?: object | null, options?: Record<string, unknown>) {
        sent.push({ name, data, options })
        return (data as { jobId: string }).jobId
      },
    }
    const queue = new PgBossLichessSyncQueue(boss)
    await queue.initialize()
    assert.deepEqual(created, [LICHESS_SYNC_DEAD_LETTER_QUEUE, LICHESS_SYNC_QUEUE])
    assert.deepEqual(updated, [LICHESS_SYNC_QUEUE])

    const queries: string[] = []
    const client = { query: async (sql: string) => { queries.push(sql); return { rows: [] } } } as unknown as PoolClient
    const payload = { jobId: '0198a5c0-1000-7000-8000-000000000091', userId: 'user-a' }
    await queue.enqueue(client, payload)
    assert.equal(sent[0]?.name, LICHESS_SYNC_QUEUE)
    assert.equal(sent[0]?.options?.singletonKey, 'user-a')
    const db = sent[0]?.options?.db as { executeSql(sql: string): Promise<unknown> }
    await db.executeSql('SELECT 1')
    assert.deepEqual(queries, ['SELECT 1'])
    assert.deepEqual(parseLichessSyncJobPayload(payload), payload)
    assert.throws(() => parseLichessSyncJobPayload({ ...payload, userId: '../other' }))

    const rejected = new PgBossLichessSyncQueue({ ...boss, send: async () => null })
    await assert.rejects(() => rejected.enqueue(client, payload), /rejected the job/)
  })

  it('fails closed when the worker heartbeat or queue is unavailable', async () => {
    let connections = 0
    const untouched = { connect: async () => { connections += 1; throw new Error('must not connect') } } as unknown as Pool
    const queue = new RecordingQueue()
    const noWorker = new PostgresLichessSyncCoordinator(untouched, queue, { available: async () => false })
    await assert.rejects(
      () => noWorker.request('user-a', NOW),
      (error: unknown) => error instanceof ApiError && error.code === 'lichess_sync_worker_unavailable' && error.retryAfterSeconds === 30,
    )
    assert.equal(connections, 0)

    queue.fail = true
    const database = new ScriptedDatabase((sql) => {
      if (sql.includes('SELECT 1 FROM external_connections')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      if (sql.includes('FROM lichess_sync_jobs')) return { rows: [] }
      return {}
    })
    const coordinator = new PostgresLichessSyncCoordinator(database.pool, queue)
    await assert.rejects(
      () => coordinator.request('user-a', NOW),
      (error: unknown) => error instanceof ApiError && error.code === 'lichess_sync_queue_unavailable',
    )
    assert.equal(database.statements.some(({ sql }) => sql === 'ROLLBACK'), true)
    assert.equal(database.statements.some(({ sql }) => sql === 'COMMIT'), false)
  })

  it('requires an active connection and atomically queues a new request', async () => {
    const absent = new ScriptedDatabase()
    const queue = new RecordingQueue()
    await assert.rejects(
      () => new PostgresLichessSyncCoordinator(absent.pool, queue).request('user-a', NOW),
      (error: unknown) => error instanceof ApiError && error.code === 'lichess_not_connected',
    )

    const connected = new ScriptedDatabase((sql) => {
      if (sql.includes('SELECT 1 FROM external_connections')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      if (sql.includes('SELECT id,status,sync_started_at')) return { rows: [] }
      return {}
    })
    const result = await new PostgresLichessSyncCoordinator(connected.pool, queue).request('user-a', NOW)
    assert.equal(result.status, 'queued')
    assert.equal(result.syncStartedAt, NOW.toISOString())
    assert.equal(queue.jobs.length, 1)
    assert.equal(connected.statements.some(({ sql }) => sql === 'COMMIT'), true)
  })

  it('deduplicates active requests and returns tenant-scoped status with worker availability', async () => {
    const activeJob = '0198a5c0-1000-7000-8000-000000000092'
    const database = new ScriptedDatabase((sql) => {
      if (sql.includes('SELECT 1 FROM external_connections')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      if (sql.includes('SELECT id,status,sync_started_at')) return {
        rows: [{ id: activeJob, status: 'running', sync_started_at: NOW }],
      }
      if (sql.includes('SELECT consented_at,last_synced_at')) return {
        rows: [{ consented_at: new Date('2026-07-01T00:00:00Z'), last_synced_at: null }],
      }
      if (sql.includes('SELECT id,status,requested_at')) return {
        rows: [{
          id: activeJob, status: 'retry_wait', requested_at: new Date('2026-07-15T11:00:00Z'), sync_started_at: NOW,
          retry_at: new Date('2026-07-15T12:00:31Z'), processed_records: '20', accepted_games: '17',
          rejected_records: '3', failure_code: 'provider_rate_limited',
        }],
      }
      return {}
    })
    const queue = new RecordingQueue()
    const coordinator = new PostgresLichessSyncCoordinator(database.pool, queue, { available: async () => false })
    const status = await coordinator.status('user-a', NOW)
    assert.equal(status.available, false)
    assert.equal(status.unavailableReason, 'worker_unavailable')
    assert.equal(status.connected, true)
    assert.equal(status.job?.retryAfterSeconds, 31)
    assert.equal(status.job?.processedRecords, '20')
    assert.equal(queue.jobs.length, 0)
    assert.equal(database.statements.some(({ sql, values }) => sql.includes("set_config('app.user_id'") && values?.[0] === 'user-a'), true)

    const activeCoordinator = new PostgresLichessSyncCoordinator(database.pool, queue)
    assert.deepEqual(await activeCoordinator.request('user-a', NOW), {
      jobId: activeJob, status: 'running', syncStartedAt: NOW.toISOString(),
    })
    assert.equal(queue.jobs.length, 0)
  })

  it('treats missing, expired, and errored Redis heartbeats as unavailable', async () => {
    for (const result of [30_000, 0, -2] as const) {
      const monitor = new RedisLichessSyncWorkerAvailability({ pttl: async () => result })
      assert.equal(await monitor.available(), result > 0)
    }
    const failed = new RedisLichessSyncWorkerAvailability({ pttl: async () => { throw new Error('redis detail') } })
    assert.equal(await failed.available(), false)
  })

  it('returns explicit disconnected and idle-connected status shapes', async () => {
    const disconnected = new ScriptedDatabase()
    const available = new PostgresLichessSyncCoordinator(disconnected.pool, new RecordingQueue())
    assert.deepEqual(await available.status('user-a', NOW), {
      available: true,
      unavailableReason: null,
      connected: false,
      consentedAt: null,
      lastSyncedAt: null,
      job: null,
    })

    const lastSynced = new Date('2026-07-14T09:00:00Z')
    const idle = new ScriptedDatabase((sql) => {
      if (sql.includes('SELECT consented_at,last_synced_at')) return {
        rows: [{ consented_at: new Date('2026-07-01T00:00:00Z'), last_synced_at: lastSynced }],
      }
      if (sql.includes('SELECT id,status,requested_at')) return { rows: [] }
      return {}
    })
    const status = await new PostgresLichessSyncCoordinator(idle.pool, new RecordingQueue()).status('user-a', NOW)
    assert.equal(status.connected, true)
    assert.equal(status.lastSyncedAt, lastSynced.toISOString())
    assert.equal(status.job, null)
  })
})

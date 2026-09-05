import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { ApiError } from '../src/errors.js'
import {
  LichessSyncRunner,
  PostgresLichessSyncDeadLetterHandler,
  classifyLichessSyncFailure,
  type LichessSyncJobPayload,
  type LichessSyncProviderGate,
} from '../src/jobs/lichess-sync.js'

const NOW = new Date('2026-07-15T12:00:00.000Z')
const PAYLOAD: LichessSyncJobPayload = {
  jobId: '0198a5c0-1000-7000-8000-000000000098',
  userId: 'user-a',
}

type QueryResult = { rows?: unknown[]; rowCount?: number | null }

class RunnerDatabase {
  readonly statements: Array<{ sql: string; values: readonly unknown[] | undefined }> = []
  readonly pool: Pool
  locked = true
  status = 'queued'
  retryAt: Date | null = null
  cursorLastMoveAt: string | null = null
  cursorDigest: string | null = null
  insertedCount = '1'
  connectionPresent = true
  completionRowCount = 1
  deadLetterRowCount = 1
  loadPresent = true

  constructor() {
    const client = {
      query: async (sql: string, values?: readonly unknown[]) => {
        this.statements.push({ sql, values })
        return this.#answer(sql)
      },
      release() {},
    } as unknown as PoolClient
    this.pool = { connect: async () => client } as unknown as Pool
  }

  #answer(sql: string): QueryResult {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: this.locked }] }
    if (sql.includes('SELECT job.status')) return { rows: this.loadPresent ? [{
      status: this.status,
      sync_started_at: NOW,
      retry_at: this.retryAt,
      attempts: 0,
      provider_user_id_ciphertext: Buffer.from('account-ciphertext'),
      access_token_ciphertext: Buffer.from('token-ciphertext'),
      sync_cursor_last_move_at: this.cursorLastMoveAt,
      sync_cursor_game_digest: this.cursorDigest,
    }] : [] }
    if (sql.includes('SELECT 1 FROM external_connections')) {
      return { rows: this.connectionPresent ? [{ '?column?': 1 }] : [], rowCount: this.connectionPresent ? 1 : 0 }
    }
    if (sql.includes('WITH input_games AS')) return { rows: [{ inserted_count: this.insertedCount }] }
    if (sql.includes('UPDATE external_connections SET last_synced_at')) {
      return { rows: [], rowCount: this.connectionPresent ? 1 : 0 }
    }
    if (sql.includes("SET status='succeeded'")) return { rows: [], rowCount: this.completionRowCount }
    if (sql.includes("SET status='failed'")) return { rows: [], rowCount: this.deadLetterRowCount }
    return { rows: [], rowCount: 0 }
  }
}

class DirectGate implements LichessSyncProviderGate {
  retryDelay = 73
  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return operation(new AbortController().signal)
  }
  async applyRateLimit(): Promise<number> { return this.retryDelay }
}

function game(overrides: { id?: string; rating?: number } = {}) {
  return {
    id: overrides.id ?? 'abcdEF12', rated: true, variant: 'standard', speed: 'rapid', perf: 'rapid',
    createdAt: NOW.getTime() - 60_000, lastMoveAt: NOW.getTime() - 1_000, status: 'resign',
    players: {
      white: { user: { id: 'line-user', name: 'LineUser' }, rating: overrides.rating ?? 1850 },
      black: { user: { id: 'opponent', name: 'Opponent' }, rating: 1900 },
    },
    winner: 'white', opening: { eco: 'C50', name: 'Italian Game', ply: 3 },
    moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6',
  }
}

function response(records: unknown[]): Response {
  return new Response(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`, {
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

function createRunner(database: RunnerDatabase, fetcher: typeof fetch) {
  return new LichessSyncRunner(
    database.pool,
    {
      async open(_userId, ciphertext) {
        return Buffer.from(ciphertext).toString() === 'account-ciphertext' ? 'line-user' : 'provider-token'
      },
    },
    new DirectGate(),
    'LineRecall/1.0 (ops@example.com)',
    fetcher,
    () => NOW,
  )
}

describe('Lichess sync runner', () => {
  it('streams, anonymizes, commits, and completes a claimed job', async () => {
    const database = new RunnerDatabase()
    let request: { url: string; init: RequestInit | undefined } | undefined
    const runner = createRunner(database, async (input, init) => {
      request = { url: String(input), init }
      return response([game()])
    })
    assert.deepEqual(await runner.run(PAYLOAD), { status: 'succeeded' })
    assert.equal(new URL(request!.url).hostname, 'lichess.org')
    const headers = new Headers(request!.init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer provider-token')
    assert.equal(database.statements.some(({ sql }) => sql.includes('WITH input_games AS')), true)
    assert.equal(database.statements.some(({ sql }) => sql.includes("SET status='succeeded'")), true)
    assert.equal(JSON.stringify(database.statements).includes('abcdEF12'), false)
    assert.equal(JSON.stringify(database.statements).includes('opponent'), false)
    assert.equal(database.statements.some(({ sql }) => sql.includes('pg_advisory_unlock')), true)
  })

  it('serializes every personal rating band without mixing provider identity into storage', async () => {
    const database = new RunnerDatabase()
    const records = [
      game({ id: 'rate0001', rating: 1199 }),
      game({ id: 'rate0002', rating: 1200 }),
      game({ id: 'rate0003', rating: 1500 }),
      game({ id: 'rate0004', rating: 2000 }),
      game({ id: 'rate0005', rating: 2200 }),
      game({ id: 'rate0006', rating: 2400 }),
    ]
    const runner = createRunner(database, async () => response(records))
    await runner.run(PAYLOAD, new AbortController().signal)
    const aggregate = database.statements.find(({ sql }) => sql.includes('WITH input_games AS'))
    const serialized = String(aggregate?.values?.[1])
    for (const band of ['<1200', '1200-1499', '1500-1799', '2000-2199', '2200-2399', '2400+']) {
      assert.equal(serialized.includes(`"rating_band":"${band}"`), true)
    }
    assert.equal(serialized.includes('line-user'), false)
  })

  it('returns without decrypting or fetching an already-terminal job', async () => {
    const database = new RunnerDatabase()
    database.status = 'succeeded'
    let fetched = false
    const runner = createRunner(database, async () => { fetched = true; return response([]) })
    assert.deepEqual(await runner.run(PAYLOAD), { status: 'already_terminal' })
    assert.equal(fetched, false)
    assert.equal(database.statements.some(({ sql }) => sql.includes('pg_advisory_unlock')), true)
  })

  it('does not overwrite a job when another runner owns its advisory lock', async () => {
    const database = new RunnerDatabase()
    database.locked = false
    const runner = createRunner(database, async () => response([]))
    await assert.rejects(
      () => runner.run(PAYLOAD),
      (error: unknown) => error instanceof ApiError && error.code === 'lichess_sync_busy',
    )
    assert.equal(database.statements.some(({ sql }) => sql.includes('SET status=$3')), false)
    assert.equal(database.statements.some(({ sql }) => sql.includes('pg_advisory_unlock')), false)
  })

  it('records provider rate limiting as retry-wait with the coordinated delay', async () => {
    const database = new RunnerDatabase()
    const runner = createRunner(database, async () => new Response('', { status: 429 }))
    await assert.rejects(
      () => runner.run(PAYLOAD),
      (error: unknown) => error instanceof ApiError && error.code === 'provider_rate_limited' && error.retryAfterSeconds === 73,
    )
    const failure = database.statements.find(({ sql }) => sql.includes('SET status=$3'))
    assert.equal(failure?.values?.[2], 'retry_wait')
    assert.equal(failure?.values?.[4], 'provider_rate_limited')
    assert.equal((failure?.values?.[3] as Date).toISOString(), '2026-07-15T12:01:13.000Z')
  })

  it('honors stored retry windows and resumes from a validated cursor', async () => {
    const waitingDatabase = new RunnerDatabase()
    waitingDatabase.retryAt = new Date('2026-07-15T12:00:30.000Z')
    const waiting = createRunner(waitingDatabase, async () => response([]))
    await assert.rejects(
      () => waiting.run(PAYLOAD),
      (error: unknown) => error instanceof ApiError && error.code === 'provider_rate_limited' && error.retryAfterSeconds === 60,
    )
    assert.equal(waitingDatabase.statements.some(({ sql }) => sql.includes('SET status=$3')), false)

    const resumedDatabase = new RunnerDatabase()
    resumedDatabase.cursorLastMoveAt = String(NOW.getTime() - 5_000)
    resumedDatabase.cursorDigest = 'a'.repeat(64)
    let requestedUrl = ''
    const resumed = createRunner(resumedDatabase, async (input) => {
      requestedUrl = String(input)
      return response([])
    })
    await resumed.run(PAYLOAD)
    assert.equal(new URL(requestedUrl).searchParams.get('since'), String(NOW.getTime() - 6_000))
  })

  it('fails terminally when a claimed job loses its connection or returns invalid commit counts', async () => {
    const disconnectedDatabase = new RunnerDatabase()
    disconnectedDatabase.connectionPresent = false
    const disconnected = createRunner(disconnectedDatabase, async () => response([game()]))
    await assert.rejects(
      () => disconnected.run(PAYLOAD),
      (error: unknown) => error instanceof ApiError && error.code === 'lichess_disconnected',
    )
    const disconnection = disconnectedDatabase.statements.find(({ sql }) => sql.includes('SET status=$3'))
    assert.equal(disconnection?.values?.[2], 'failed')

    const invalidCountDatabase = new RunnerDatabase()
    invalidCountDatabase.insertedCount = '-1'
    const invalidCount = createRunner(invalidCountDatabase, async () => response([game()]))
    await assert.rejects(() => invalidCount.run(PAYLOAD), /Invalid imported game count/)
    const failure = invalidCountDatabase.statements.find(({ sql }) => sql.includes('SET status=$3'))
    assert.equal(failure?.values?.[4], 'lichess_import_count_invalid')
  })

  it('fails before provider access when the job/connection join is absent', async () => {
    const database = new RunnerDatabase()
    database.loadPresent = false
    let fetched = false
    const runner = createRunner(database, async () => { fetched = true; return response([]) })
    await assert.rejects(
      () => runner.run(PAYLOAD),
      (error: unknown) => error instanceof ApiError && error.code === 'lichess_sync_unavailable',
    )
    assert.equal(fetched, false)
    assert.equal(database.statements.some(({ sql }) => sql.includes('SET status=$3')), false)
  })

  it('handles rejected-only stream chunks without fabricating a cursor', async () => {
    const database = new RunnerDatabase()
    const malformed = new Response('{not-json\n', { headers: { 'content-type': 'application/x-ndjson' } })
    await createRunner(database, async () => malformed).run(PAYLOAD)
    assert.equal(database.statements.some(({ sql }) => sql.includes('sync_cursor_last_move_at=$2')), false)
    const accounting = database.statements.find(({ sql }) => sql.includes('processed_records=processed_records'))
    assert.equal(accounting?.values?.[2], 1)
    assert.equal(accounting?.values?.[4], 1)
  })

  it('fails completion if the connection disappears after an empty provider response', async () => {
    const database = new RunnerDatabase()
    const originalAnswer = database.connectionPresent
    let fetched = false
    const runner = createRunner(database, async () => {
      fetched = true
      database.connectionPresent = false
      return response([])
    })
    await assert.rejects(
      () => runner.run(PAYLOAD),
      (error: unknown) => error instanceof ApiError && error.code === 'lichess_disconnected',
    )
    assert.equal(fetched, true)
    database.connectionPresent = originalAnswer
  })

  it('records worker cancellation as retryable and terminal state corruption as failed', async () => {
    const cancelledDatabase = new RunnerDatabase()
    const controller = new AbortController()
    controller.abort(new DOMException('stop', 'AbortError'))
    const cancelled = createRunner(cancelledDatabase, async () => response([]))
    await assert.rejects(() => cancelled.run(PAYLOAD, controller.signal), { name: 'AbortError' })
    const cancellation = cancelledDatabase.statements.find(({ sql }) => sql.includes('SET status=$3'))
    assert.equal(cancellation?.values?.[2], 'retry_wait')
    assert.equal(cancellation?.values?.[4], 'lichess_sync_interrupted')

    const corruptDatabase = new RunnerDatabase()
    corruptDatabase.completionRowCount = 0
    const corrupt = createRunner(corruptDatabase, async () => response([]))
    await assert.rejects(() => corrupt.run(PAYLOAD), /changed before completion/)
    const failure = corruptDatabase.statements.find(({ sql }) => sql.includes('SET status=$3'))
    assert.equal(failure?.values?.[2], 'failed')
    assert.equal(failure?.values?.[4], 'lichess_job_state_changed')
  })

  it('rejects malformed job envelopes and unsafe provider identities', async () => {
    const database = new RunnerDatabase()
    await assert.rejects(() => createRunner(database, async () => response([])).run({ ...PAYLOAD, userId: '../other' }))
    assert.throws(() => new LichessSyncRunner(
      database.pool,
      { open: async () => 'value' },
      new DirectGate(),
      'unmonitored-agent',
      async () => response([]),
    ), /monitored contact/)
  })

  it('classifies only bounded codes and defaults unknown infrastructure errors to retryable', () => {
    assert.deepEqual(classifyLichessSyncFailure(new Error('database detail')), {
      retryable: true, code: 'lichess_sync_failed', retryAfterSeconds: 60,
    })
    assert.deepEqual(classifyLichessSyncFailure(new ApiError(400, 'Bad-Code', 'invalid')), {
      retryable: false, code: 'lichess_sync_failed', retryAfterSeconds: null,
    })
    assert.deepEqual(classifyLichessSyncFailure(new ApiError(503, 'temporary_failure', 'retry', { retryAfterSeconds: 0 })), {
      retryable: true, code: 'temporary_failure', retryAfterSeconds: 1,
    })
  })
})

describe('Lichess sync dead-letter reconciliation', () => {
  it('terminalizes exhausted work idempotently inside the tenant transaction', async () => {
    const database = new RunnerDatabase()
    const handler = new PostgresLichessSyncDeadLetterHandler(database.pool, () => NOW)
    assert.equal(await handler.handle(PAYLOAD), 'marked_failed')
    const update = database.statements.find(({ sql }) => sql.includes("SET status='failed'"))
    assert.deepEqual(update?.values, [PAYLOAD.userId, PAYLOAD.jobId, NOW])
    assert.equal(update?.sql.includes("failure_code='lichess_sync_retries_exhausted'"), true)
    assert.equal(database.statements.some(({ sql, values }) => sql.includes("set_config('app.user_id'") && values?.[0] === 'user-a'), true)

    database.deadLetterRowCount = 0
    assert.equal(await handler.handle(PAYLOAD), 'already_terminal_or_missing')
  })

  it('rolls back a reconciliation failure', async () => {
    const statements: string[] = []
    const client = {
      async query(sql: string) {
        statements.push(sql)
        if (sql.includes("SET status='failed'")) throw new Error('database unavailable')
        return { rows: [], rowCount: 0 }
      },
      release() {},
    } as unknown as PoolClient
    const pool = { connect: async () => client } as unknown as Pool
    const handler = new PostgresLichessSyncDeadLetterHandler(pool, () => NOW)
    await assert.rejects(() => handler.handle(PAYLOAD), /database unavailable/)
    assert.equal(statements.includes('ROLLBACK'), true)
  })
})

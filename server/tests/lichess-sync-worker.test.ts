import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiError } from '../src/errors.js'
import {
  LICHESS_SYNC_DEAD_LETTER_QUEUE,
  LICHESS_SYNC_QUEUE,
  PgBossLichessSyncQueue,
  type LichessSyncJobPayload,
} from '../src/jobs/lichess-sync.js'
import { loadLichessSyncWorkerConfig } from '../src/jobs/lichess-sync-worker-config.js'
import {
  LichessSyncWorkerRuntime,
  RedisLichessSyncWorkerHeartbeat,
  type LichessSyncWorkerBoss,
  type LichessSyncWorkerLogger,
} from '../src/jobs/lichess-sync-worker-runtime.js'

const PAYLOAD: LichessSyncJobPayload = {
  jobId: '0198a5c0-1000-7000-8000-000000000099',
  userId: 'user-a',
}

class RecordingLogger implements LichessSyncWorkerLogger {
  readonly records: Array<{ level: string; fields: Record<string, unknown>; message: string }> = []
  info(fields: Record<string, unknown>, message: string) { this.records.push({ level: 'info', fields, message }) }
  warn(fields: Record<string, unknown>, message: string) { this.records.push({ level: 'warn', fields, message }) }
  error(fields: Record<string, unknown>, message: string) { this.records.push({ level: 'error', fields, message }) }
}

class HeartbeatRedis {
  readonly sets: unknown[][] = []
  readonly calls: unknown[][] = []
  setResult: unknown = 'OK'
  setFailure: Error | undefined
  callFailure: Error | undefined

  async set(...args: unknown[]) {
    this.sets.push(args)
    if (this.setFailure) throw this.setFailure
    return this.setResult
  }

  async call(...args: unknown[]) {
    this.calls.push(args)
    if (this.callFailure) throw this.callFailure
    return 1
  }
}

type Handler = (jobs: Array<{ id: string; data: unknown; signal: AbortSignal }>) => Promise<unknown>

class RecordingBoss implements LichessSyncWorkerBoss {
  readonly events: string[] = []
  readonly handlers = new Map<string, Handler>()
  readonly created: string[] = []
  readonly updated: string[] = []
  failWorkName: string | undefined
  failOffWork = false

  async start() { this.events.push('boss:start'); return this }
  async createQueue(name: string) { this.created.push(name) }
  async updateQueue(name: string) { this.updated.push(name) }
  async send() { return PAYLOAD.jobId }
  async work(name: string, _options: never, handler: Handler) {
    this.events.push(`work:${name}`)
    if (name === this.failWorkName) throw new Error('registration failed')
    this.handlers.set(name, handler)
    return `worker:${name}`
  }
  async offWork(name: string) {
    this.events.push(`off:${name}`)
    if (this.failOffWork) throw new Error('deregistration failed')
  }
  async stop() { this.events.push('boss:stop') }

  invoke(name: string, data: unknown = PAYLOAD, signal = new AbortController().signal) {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`Missing handler for ${name}`)
    return handler([{ id: `queue-${name}`, data, signal }])
  }
}

function runtimeFixture(options: { runnerError?: unknown; failWorkName?: string } = {}) {
  const logger = new RecordingLogger()
  const redis = new HeartbeatRedis()
  const heartbeat = new RedisLichessSyncWorkerHeartbeat(redis as never, {
    token: 'worker_token_1234567890', logger,
  })
  const boss = new RecordingBoss()
  boss.failWorkName = options.failWorkName
  const queue = new PgBossLichessSyncQueue(boss)
  const calls: LichessSyncJobPayload[] = []
  const runner = {
    async run(input: LichessSyncJobPayload) {
      calls.push(input)
      if (options.runnerError) throw options.runnerError
      return { status: 'succeeded' as const }
    },
  }
  const deadLetterInputs: LichessSyncJobPayload[] = []
  const deadLetters = {
    async handle(input: LichessSyncJobPayload) {
      deadLetterInputs.push(input)
      return 'marked_failed' as const
    },
  }
  const runtime = new LichessSyncWorkerRuntime(boss, queue, runner, deadLetters, heartbeat, { logger })
  return { runtime, boss, redis, logger, calls, deadLetterInputs }
}

describe('Lichess sync worker runtime', () => {
  it('publishes and token-releases a renewable readiness heartbeat', async () => {
    const redis = new HeartbeatRedis()
    const logger = new RecordingLogger()
    let interval: (() => void) | undefined
    let cleared = false
    const heartbeat = new RedisLichessSyncWorkerHeartbeat(redis as never, {
      token: 'worker_token_1234567890', logger,
      setIntervalFn: ((callback: () => void) => { interval = callback; return { unref() {} } }) as never,
      clearIntervalFn: (() => { cleared = true }) as never,
    })
    await heartbeat.start()
    await assert.rejects(() => heartbeat.start(), /already running/)
    assert.equal(redis.sets.length, 1)
    interval?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(redis.sets.length, 2)
    await heartbeat.stop()
    assert.equal(cleared, true)
    assert.equal(redis.calls.length, 1)
    assert.equal(String(redis.calls[0]?.[1]).includes("redis.call('GET'"), true)
  })

  it('fails startup on an unacknowledged heartbeat and lets a failed refresh expire', async () => {
    const rejected = new HeartbeatRedis()
    rejected.setResult = null
    const heartbeat = new RedisLichessSyncWorkerHeartbeat(rejected as never, { token: 'worker_token_1234567890' })
    await assert.rejects(() => heartbeat.start(), /did not acknowledge/)

    const redis = new HeartbeatRedis()
    const logger = new RecordingLogger()
    let interval: (() => void) | undefined
    const refreshing = new RedisLichessSyncWorkerHeartbeat(redis as never, {
      token: 'worker_token_1234567890', logger,
      setIntervalFn: ((callback: () => void) => { interval = callback; return { unref() {} } }) as never,
      clearIntervalFn: (() => undefined) as never,
    })
    await refreshing.start()
    redis.setFailure = new Error('secret Redis detail')
    interval?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(logger.records.some(({ message, fields }) => message.includes('refresh failed') && fields.errorClass === 'Error'), true)
    redis.callFailure = new Error('secret release detail')
    await refreshing.stop()
    assert.equal(logger.records.some(({ message }) => message.includes('release failed')), true)
    assert.equal(JSON.stringify(logger.records).includes('secret'), false)
  })

  it('rejects unsafe heartbeat and shutdown configurations', () => {
    const redis = new HeartbeatRedis()
    assert.throws(() => new RedisLichessSyncWorkerHeartbeat(redis as never, { token: 'short' }), /token/)
    assert.throws(() => new RedisLichessSyncWorkerHeartbeat(redis as never, {
      token: 'worker_token_1234567890', ttlMs: 10_000, refreshEveryMs: 5_000,
    }), /timing/)
    const fixture = runtimeFixture()
    assert.throws(() => new LichessSyncWorkerRuntime(
      fixture.boss,
      new PgBossLichessSyncQueue(fixture.boss),
      { run: async () => ({ status: 'succeeded' }) },
      { handle: async () => 'marked_failed' },
      new RedisLichessSyncWorkerHeartbeat(redis as never, { token: 'worker_token_1234567890' }),
      { shutdownTimeoutMs: 999 },
    ), /shutdown timeout/)
  })

  it('registers both queues, completes valid work, and reconciles dead letters', async () => {
    const fixture = runtimeFixture()
    await fixture.runtime.start()
    await assert.rejects(() => fixture.runtime.start(), /already started/)
    assert.deepEqual(fixture.boss.created, [LICHESS_SYNC_DEAD_LETTER_QUEUE, LICHESS_SYNC_QUEUE])
    assert.deepEqual(fixture.boss.updated, [LICHESS_SYNC_QUEUE])
    assert.equal(fixture.redis.sets.length, 1)

    const main = await fixture.boss.invoke(LICHESS_SYNC_QUEUE) as Array<{ status: string; output: unknown }>
    assert.equal(main[0]?.status, 'completed')
    assert.deepEqual(fixture.calls, [PAYLOAD])
    const dead = await fixture.boss.invoke(LICHESS_SYNC_DEAD_LETTER_QUEUE) as Array<{ status: string; output: unknown }>
    assert.equal(dead[0]?.status, 'completed')
    assert.deepEqual(fixture.deadLetterInputs, [PAYLOAD])

    const invalidMain = await fixture.boss.invoke(LICHESS_SYNC_QUEUE, { ...PAYLOAD, userId: '../other' }) as Array<{ status: string }>
    assert.equal(invalidMain[0]?.status, 'deadletter')
    const invalidDead = await fixture.boss.invoke(LICHESS_SYNC_DEAD_LETTER_QUEUE, null) as Array<{ status: string }>
    assert.equal(invalidDead[0]?.status, 'completed')
    assert.equal(JSON.stringify(fixture.logger.records).includes('../other'), false)

    await fixture.runtime.stop()
    await fixture.runtime.stop()
    assert.equal(fixture.boss.events.filter((event) => event === 'boss:stop').length, 1)
    assert.equal(fixture.redis.calls.length, 1)
  })

  it('maps retryable and terminal failures to pg-boss settlement without leaking messages', async () => {
    for (const testCase of [
      { error: new ApiError(503, 'provider_guard_unavailable', 'secret provider detail'), status: 'failed' },
      { error: new ApiError(409, 'lichess_disconnected', 'secret account detail'), status: 'deadletter' },
    ]) {
      const fixture = runtimeFixture({ runnerError: testCase.error })
      await fixture.runtime.start()
      const result = await fixture.boss.invoke(LICHESS_SYNC_QUEUE) as Array<{ status: string; output: unknown }>
      assert.equal(result[0]?.status, testCase.status)
      assert.equal(JSON.stringify(result).includes('secret'), false)
      assert.equal(JSON.stringify(fixture.logger.records).includes('secret'), false)
      await fixture.runtime.stop()
    }
  })

  it('cleans up a partial startup and tolerates deregistration failure', async () => {
    const failed = runtimeFixture({ failWorkName: LICHESS_SYNC_DEAD_LETTER_QUEUE })
    await assert.rejects(() => failed.runtime.start(), /registration failed/)
    assert.equal(failed.boss.events.includes(`off:${LICHESS_SYNC_QUEUE}`), true)
    assert.equal(failed.boss.events.includes('boss:stop'), true)

    const stopping = runtimeFixture()
    stopping.boss.failOffWork = true
    await stopping.runtime.start()
    await stopping.runtime.stop()
    assert.equal(stopping.logger.records.filter(({ message }) => message.includes('deregistration failed')).length, 2)

    const noHeartbeat = runtimeFixture()
    noHeartbeat.redis.setResult = null
    await assert.rejects(() => noHeartbeat.runtime.start(), /did not acknowledge/)
    assert.equal(noHeartbeat.redis.calls.length, 1)
    assert.equal(noHeartbeat.boss.events.includes('boss:stop'), true)
  })

  it('propagates graceful shutdown cancellation into active provider work', async () => {
    const logger = new RecordingLogger()
    const redis = new HeartbeatRedis()
    const boss = new RecordingBoss()
    let observedSignal: AbortSignal | undefined
    const runtime = new LichessSyncWorkerRuntime(
      boss,
      new PgBossLichessSyncQueue(boss),
      {
        run: async (_input, signal) => {
          observedSignal = signal
          await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
          return { status: 'succeeded' }
        },
      },
      { handle: async () => 'marked_failed' },
      new RedisLichessSyncWorkerHeartbeat(redis as never, { token: 'worker_token_1234567890', logger }),
      { logger },
    )
    await runtime.start()
    const active = boss.invoke(LICHESS_SYNC_QUEUE)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await runtime.stop()
    const result = await active as Array<{ status: string; output: { code: string } }>
    assert.equal(observedSignal?.aborted, true)
    assert.equal(result[0]?.status, 'failed')
    assert.equal(result[0]?.output.code, 'lichess_sync_interrupted')
  })

  it('rejects impossible empty pg-boss batches', async () => {
    const fixture = runtimeFixture()
    await fixture.runtime.start()
    await assert.rejects(() => fixture.boss.handlers.get(LICHESS_SYNC_QUEUE)!([]), /without a job/)
    await assert.rejects(() => fixture.boss.handlers.get(LICHESS_SYNC_DEAD_LETTER_QUEUE)!([]), /without a job/)
    await fixture.runtime.stop()
  })
})

describe('Lichess sync worker configuration', () => {
  const complete = {
    DATABASE_URL: 'postgresql://app:masked@database.example/linerecall',
    DATABASE_SSL_CA_PEM: 'test-ca',
    REDIS_URL: 'rediss://cache.example/0',
    AWS_REGION: 'us-east-1',
    TOKEN_KMS_KEY_ID: 'alias/linerecall-token',
    EXTERNAL_USER_AGENT: 'LineRecall/1.0 (ops@example.com)',
    WORKER_SHUTDOWN_TIMEOUT_MS: '12000',
  }

  it('accepts only verified database and encrypted Redis transport', () => {
    const config = loadLichessSyncWorkerConfig(complete)
    assert.equal(config.databaseSsl.rejectUnauthorized, true)
    assert.equal(config.WORKER_SHUTDOWN_TIMEOUT_MS, 12_000)
    assert.throws(() => loadLichessSyncWorkerConfig({ ...complete, REDIS_URL: 'redis://cache.example/0' }), /rediss/)
    const { DATABASE_SSL_CA_PEM: _ca, ...withoutCa } = complete
    assert.throws(() => loadLichessSyncWorkerConfig(withoutCa), /PostgreSQL CA/)
    assert.throws(() => loadLichessSyncWorkerConfig({ ...complete, EXTERNAL_USER_AGENT: 'no-contact-agent' }))
  })
})

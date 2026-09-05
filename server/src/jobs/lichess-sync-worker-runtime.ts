import type { JobResult } from 'pg-boss'
import {
  LICHESS_SYNC_DEAD_LETTER_QUEUE,
  LICHESS_SYNC_QUEUE,
  LICHESS_SYNC_WORKER_HEARTBEAT_KEY,
  classifyLichessSyncFailure,
  parseLichessSyncJobPayload,
  type LichessSyncJobPayload,
  type LichessSyncDeadLetterResult,
} from './lichess-sync.js'

const HEARTBEAT_RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`

interface HeartbeatRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>
  call(command: 'EVAL', script: string, keyCount: '1', key: string, value: string): Promise<unknown>
}

export interface LichessSyncWorkerLogger {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

const defaultLogger: LichessSyncWorkerLogger = {
  info: (fields, message) => console.info(message, fields),
  warn: (fields, message) => console.warn(message, fields),
  error: (fields, message) => console.error(message, fields),
}

interface HeartbeatOptions {
  token: string
  ttlMs?: number
  refreshEveryMs?: number
  logger?: LichessSyncWorkerLogger
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}

/**
 * Publishes a renewable, token-owned readiness lease. A failed refresh is not
 * masked: the prior key expires naturally and the API stops accepting new work.
 */
export class RedisLichessSyncWorkerHeartbeat {
  readonly #ttlMs: number
  readonly #refreshEveryMs: number
  readonly #logger: LichessSyncWorkerLogger
  readonly #setInterval: typeof setInterval
  readonly #clearInterval: typeof clearInterval
  #timer: ReturnType<typeof setInterval> | undefined
  #refreshing: Promise<void> | undefined
  #running = false

  constructor(private readonly redis: HeartbeatRedis, private readonly options: HeartbeatOptions) {
    this.#ttlMs = options.ttlMs ?? 45_000
    this.#refreshEveryMs = options.refreshEveryMs ?? 15_000
    this.#logger = options.logger ?? defaultLogger
    this.#setInterval = options.setIntervalFn ?? setInterval
    this.#clearInterval = options.clearIntervalFn ?? clearInterval
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(options.token)) throw new Error('Invalid worker heartbeat token')
    if (this.#ttlMs < 10_000 || this.#refreshEveryMs < 1_000 || this.#refreshEveryMs * 2 >= this.#ttlMs) {
      throw new Error('Invalid worker heartbeat timing')
    }
  }

  async start(): Promise<void> {
    if (this.#running) throw new Error('Worker heartbeat is already running')
    this.#running = true
    try {
      await this.#refresh()
    } catch (error) {
      this.#running = false
      throw error
    }
    this.#timer = this.#setInterval(() => {
      if (!this.#running) return
      void this.#refresh().catch((error: unknown) => {
        this.#logger.error({ errorClass: errorClass(error) }, 'Lichess sync worker heartbeat refresh failed')
      })
    }, this.#refreshEveryMs)
    this.#timer.unref?.()
  }

  async stop(): Promise<void> {
    this.#running = false
    if (this.#timer) {
      this.#clearInterval(this.#timer)
      this.#timer = undefined
    }
    await this.#refreshing?.catch(() => undefined)
    await this.redis.call(
      'EVAL', HEARTBEAT_RELEASE_SCRIPT, '1', LICHESS_SYNC_WORKER_HEARTBEAT_KEY, this.options.token,
    ).catch((error: unknown) => {
      this.#logger.warn({ errorClass: errorClass(error) }, 'Lichess sync worker heartbeat release failed')
    })
  }

  async #refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing
    const pending = (async () => {
      const result = await this.redis.set(
        LICHESS_SYNC_WORKER_HEARTBEAT_KEY, this.options.token, 'PX', this.#ttlMs,
      )
      if (result !== 'OK') throw new Error('Redis did not acknowledge the worker heartbeat')
    })()
    this.#refreshing = pending
    try {
      await pending
    } finally {
      if (this.#refreshing === pending) this.#refreshing = undefined
    }
  }
}

interface WorkerJob {
  id: string
  data: unknown
  signal: AbortSignal
}

interface WorkerOptions {
  localConcurrency: number
  batchSize: number
  pollingIntervalSeconds: number
  notifyPollingIntervalSeconds?: number
  heartbeatRefreshSeconds?: number
  perJobResults: true
}

export interface LichessSyncWorkerBoss {
  start(): Promise<unknown>
  work(
    name: string,
    options: WorkerOptions,
    handler: (jobs: WorkerJob[]) => Promise<JobResult[]>,
  ): Promise<string>
  offWork(name: string, options: { id: string; wait: true }): Promise<void>
  stop(options: { graceful: true; timeout: number }): Promise<void>
}

export interface LichessSyncWorkerRuntimeOptions {
  shutdownTimeoutMs?: number
  logger?: LichessSyncWorkerLogger
}

export interface LichessSyncJobRunner {
  run(input: LichessSyncJobPayload, signal?: AbortSignal): Promise<{ status: 'succeeded' | 'already_terminal' }>
}

export interface LichessSyncQueueInitializer {
  initialize(): Promise<void>
}

export interface LichessSyncDeadLetterReconciler {
  handle(input: LichessSyncJobPayload): Promise<LichessSyncDeadLetterResult>
}

function errorClass(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)) return error.name
  return 'UnknownError'
}

/** Testable worker lifecycle; the executable entrypoint only supplies adapters. */
export class LichessSyncWorkerRuntime {
  readonly #shutdownTimeoutMs: number
  readonly #logger: LichessSyncWorkerLogger
  readonly #shutdown = new AbortController()
  #bossStarted = false
  #mainWorkerId: string | undefined
  #deadLetterWorkerId: string | undefined
  #heartbeatAttempted = false
  #stopping: Promise<void> | undefined

  constructor(
    private readonly boss: LichessSyncWorkerBoss,
    private readonly queue: LichessSyncQueueInitializer,
    private readonly runner: LichessSyncJobRunner,
    private readonly deadLetters: LichessSyncDeadLetterReconciler,
    private readonly heartbeat: RedisLichessSyncWorkerHeartbeat,
    options: LichessSyncWorkerRuntimeOptions = {},
  ) {
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 15_000
    this.#logger = options.logger ?? defaultLogger
    if (this.#shutdownTimeoutMs < 1_000 || this.#shutdownTimeoutMs > 60_000) {
      throw new Error('Invalid worker shutdown timeout')
    }
  }

  async start(): Promise<void> {
    if (this.#bossStarted) throw new Error('Lichess sync worker is already started')
    try {
      await this.boss.start()
      this.#bossStarted = true
      await this.queue.initialize()
      this.#mainWorkerId = await this.boss.work(LICHESS_SYNC_QUEUE, {
        localConcurrency: 1,
        batchSize: 1,
        pollingIntervalSeconds: 2,
        notifyPollingIntervalSeconds: 30,
        heartbeatRefreshSeconds: 45,
        perJobResults: true,
      }, (jobs) => this.#runMain(jobs))
      this.#deadLetterWorkerId = await this.boss.work(LICHESS_SYNC_DEAD_LETTER_QUEUE, {
        localConcurrency: 1,
        batchSize: 1,
        pollingIntervalSeconds: 2,
        perJobResults: true,
      }, (jobs) => this.#runDeadLetter(jobs))
      this.#heartbeatAttempted = true
      await this.heartbeat.start()
      this.#logger.info({ queue: LICHESS_SYNC_QUEUE }, 'Lichess sync worker ready')
    } catch (error) {
      await this.stop().catch(() => undefined)
      throw error
    }
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping
    this.#stopping = this.#stop()
    return this.#stopping
  }

  async #stop(): Promise<void> {
    if (this.#heartbeatAttempted) {
      await this.heartbeat.stop()
      this.#heartbeatAttempted = false
    }
    this.#shutdown.abort(new DOMException('Worker is stopping', 'AbortError'))
    const workers: Array<readonly [string, string]> = []
    if (this.#mainWorkerId) workers.push([LICHESS_SYNC_QUEUE, this.#mainWorkerId])
    if (this.#deadLetterWorkerId) workers.push([LICHESS_SYNC_DEAD_LETTER_QUEUE, this.#deadLetterWorkerId])
    for (const [name, id] of workers) {
      await this.boss.offWork(name, { id, wait: true }).catch((error: unknown) => {
        this.#logger.error({ queue: name, errorClass: errorClass(error) }, 'Lichess sync worker deregistration failed')
      })
    }
    if (this.#bossStarted) {
      await this.boss.stop({ graceful: true, timeout: this.#shutdownTimeoutMs })
      this.#bossStarted = false
    }
  }

  async #runMain(jobs: WorkerJob[]): Promise<JobResult[]> {
    const job = jobs[0]
    if (!job) throw new Error('pg-boss invoked the Lichess worker without a job')
    let input: LichessSyncJobPayload
    try {
      input = parseLichessSyncJobPayload(job.data)
    } catch (error) {
      this.#logger.error({ queueJobId: job.id, errorClass: errorClass(error) }, 'Rejected invalid Lichess sync queue payload')
      return [{ id: job.id, status: 'deadletter', output: { code: 'invalid_job_payload' } }]
    }
    try {
      const signal = AbortSignal.any([job.signal, this.#shutdown.signal])
      const result = await this.runner.run(input, signal)
      return [{ id: job.id, status: 'completed', output: result }]
    } catch (error) {
      const failure = classifyLichessSyncFailure(error)
      this.#logger.warn({
        queueJobId: job.id,
        syncJobId: input.jobId,
        code: failure.code,
        retryable: failure.retryable,
      }, 'Lichess sync job did not complete')
      return [{
        id: job.id,
        status: failure.retryable ? 'failed' : 'deadletter',
        output: { code: failure.code },
      }]
    }
  }

  async #runDeadLetter(jobs: WorkerJob[]): Promise<JobResult[]> {
    const job = jobs[0]
    if (!job) throw new Error('pg-boss invoked the Lichess dead-letter worker without a job')
    let input: LichessSyncJobPayload
    try {
      input = parseLichessSyncJobPayload(job.data)
    } catch (error) {
      this.#logger.error({ queueJobId: job.id, errorClass: errorClass(error) }, 'Acknowledged invalid Lichess dead-letter payload')
      return [{ id: job.id, status: 'completed', output: { status: 'invalid_payload_acknowledged' } }]
    }
    const status = await this.deadLetters.handle(input)
    this.#logger.error({ queueJobId: job.id, syncJobId: input.jobId, status }, 'Lichess sync retries exhausted')
    return [{ id: job.id, status: 'completed', output: { status } }]
  }
}

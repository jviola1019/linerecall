import { randomBytes } from 'node:crypto'
import type { Redis } from 'ioredis'
import { ApiError } from '../errors.js'

const LOCK_KEY = 'linerecall:provider:lichess:lock'
const COOLDOWN_KEY = 'linerecall:provider:lichess:cooldown'
const MINIMUM_COOLDOWN_MS = 60_000
const MAXIMUM_PROVIDER_DELAY_MS = 86_400_000

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`

export interface LichessProviderGateOptions {
  leaseMs?: number
  renewEveryMs?: number
  random?: () => number
  now?: () => Date
}
function parseRetryAfter(response: Response, now: Date): number {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return 0
  if (/^\d{1,9}$/u.test(value)) return Math.min(MAXIMUM_PROVIDER_DELAY_MS, Number(value) * 1_000)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 0
  return Math.min(MAXIMUM_PROVIDER_DELAY_MS, Math.max(0, timestamp - now.getTime()))
}

/**
 * One distributed lease and one shared cooldown cover every Lichess request
 * made by API tasks and sync workers. A lost lease aborts the in-flight body
 * stream instead of allowing two provider requests to overlap silently.
 */
export class RedisLichessProviderGate {
  readonly #leaseMs: number
  readonly #renewEveryMs: number
  readonly #random: () => number
  readonly #now: () => Date

  constructor(private readonly redis: Redis, options: LichessProviderGateOptions = {}) {
    this.#leaseMs = options.leaseMs ?? 90_000
    this.#renewEveryMs = options.renewEveryMs ?? 30_000
    this.#random = options.random ?? Math.random
    this.#now = options.now ?? (() => new Date())
    if (this.#leaseMs < 10_000 || this.#renewEveryMs < 1_000 || this.#renewEveryMs * 2 >= this.#leaseMs) {
      throw new Error('Invalid Lichess provider lease configuration')
    }
  }

  async run<T>(operation: (leaseSignal: AbortSignal) => Promise<T>): Promise<T> {
    let cooldown: number
    try {
      cooldown = await this.redis.pttl(COOLDOWN_KEY)
    } catch {
      throw new ApiError(503, 'provider_guard_unavailable', 'Provider request coordination is unavailable')
    }
    if (cooldown > 0) {
      throw new ApiError(429, 'provider_rate_limited', 'Lichess requested a cooldown', {
        retryAfterSeconds: Math.max(60, Math.ceil(cooldown / 1_000)),
      })
    }

    const token = randomBytes(24).toString('base64url')
    let locked: string | null
    try {
      locked = await this.redis.set(LOCK_KEY, token, 'PX', this.#leaseMs, 'NX')
    } catch {
      throw new ApiError(503, 'provider_guard_unavailable', 'Provider request coordination is unavailable')
    }
    if (locked !== 'OK') {
      throw new ApiError(503, 'provider_busy', 'Another Lichess request is active; retry shortly', {
        retryAfterSeconds: 2,
      })
    }

    const controller = new AbortController()
    let leaseFailure: ApiError | undefined
    let renewalRunning = false
    const renewal = setInterval(() => {
      if (renewalRunning || controller.signal.aborted) return
      renewalRunning = true
      void this.redis.call('EVAL', RENEW_SCRIPT, '1', LOCK_KEY, token, String(this.#leaseMs))
        .then((result) => {
          if (Number(result) !== 1) {
            leaseFailure = new ApiError(503, 'provider_lease_lost', 'Provider request coordination was lost')
            controller.abort(leaseFailure)
          }
        })
        .catch(() => {
          leaseFailure = new ApiError(503, 'provider_guard_unavailable', 'Provider request coordination is unavailable')
          controller.abort(leaseFailure)
        })
        .finally(() => { renewalRunning = false })
    }, this.#renewEveryMs)
    renewal.unref()

    try {
      const value = await operation(controller.signal)
      if (leaseFailure) throw leaseFailure
      return value
    } catch (error) {
      if (leaseFailure) throw leaseFailure
      throw error
    } finally {
      clearInterval(renewal)
      await this.redis.call('EVAL', RELEASE_SCRIPT, '1', LOCK_KEY, token).catch(() => undefined)
    }
  }

  async applyRateLimit(response: Response, attempt = 1): Promise<number> {
    const exponential = MINIMUM_COOLDOWN_MS * 2 ** Math.min(4, Math.max(0, attempt - 1))
    const required = Math.max(MINIMUM_COOLDOWN_MS, exponential, parseRetryAfter(response, this.#now()))
    const jitter = Math.floor(required * 0.2 * Math.min(1, Math.max(0, this.#random())))
    const delayMs = Math.min(MAXIMUM_PROVIDER_DELAY_MS, required + jitter)
    try {
      await this.redis.set(COOLDOWN_KEY, '1', 'PX', delayMs)
    } catch {
      throw new ApiError(503, 'provider_guard_unavailable', 'Provider request coordination is unavailable')
    }
    return Math.max(60, Math.ceil(delayMs / 1_000))
  }
}

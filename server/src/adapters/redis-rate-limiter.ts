import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { RateLimitDecision, RateLimiter } from '../ports.js'

const SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`

/** Redis is disposable coordination only; identity sessions remain in PG. */
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis, private readonly prefix = 'linerecall:rate:v1') {}

  async consume(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitDecision> {
    const digest = createHash('sha256').update(key).digest('hex')
    // This invokes Redis's atomic EVAL command with a compile-time constant
    // Lua program; it is unrelated to JavaScript dynamic evaluation.
    const result = await this.redis.call('EVAL', SCRIPT, '1', `${this.prefix}:${digest}`, String(windowMs))
    if (!Array.isArray(result) || result.length !== 2) throw new Error('Unexpected Redis rate-limit response')
    const count = Number(result[0])
    const ttl = Number(result[1])
    if (!Number.isSafeInteger(count) || !Number.isFinite(ttl) || ttl < 0) throw new Error('Invalid Redis rate-limit response')
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: new Date(now.getTime() + ttl),
    }
  }
}

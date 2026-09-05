import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Redis } from 'ioredis'
import { RedisLichessProviderGate } from '../src/connections/lichess-provider-gate.js'
import { ApiError } from '../src/errors.js'

class GateRedis {
  pttlResult = -1
  pttlFailure: Error | undefined
  setResult: string | null = 'OK'
  setFailure: Error | undefined
  callFailure: Error | undefined
  readonly sets: unknown[][] = []
  readonly calls: unknown[][] = []

  async pttl() {
    if (this.pttlFailure) throw this.pttlFailure
    return this.pttlResult
  }

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

function gate(redis: GateRedis, overrides: ConstructorParameters<typeof RedisLichessProviderGate>[1] = {}) {
  return new RedisLichessProviderGate(redis as unknown as Redis, {
    random: () => 0,
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    ...overrides,
  })
}

describe('distributed Lichess provider gate', () => {
  it('releases its token after success and after an operation failure', async () => {
    const redis = new GateRedis()
    assert.equal(await gate(redis).run(async (signal) => {
      assert.equal(signal.aborted, false)
      return 'done'
    }), 'done')
    assert.equal(redis.calls.length, 1)

    await assert.rejects(() => gate(redis).run(async () => { throw new Error('provider failure') }), /provider failure/)
    assert.equal(redis.calls.length, 2)
    redis.callFailure = new Error('release unavailable')
    assert.equal(await gate(redis).run(async () => 'released-by-expiry'), 'released-by-expiry')
  })

  it('fails closed when cooldown or lease coordination cannot be verified', async () => {
    const cooldown = new GateRedis()
    cooldown.pttlResult = 30_001
    await assert.rejects(
      () => gate(cooldown).run(async () => undefined),
      (error: unknown) => error instanceof ApiError && error.code === 'provider_rate_limited' && error.retryAfterSeconds === 60,
    )

    const readFailure = new GateRedis()
    readFailure.pttlFailure = new Error('Redis detail')
    await assert.rejects(
      () => gate(readFailure).run(async () => undefined),
      (error: unknown) => error instanceof ApiError && error.code === 'provider_guard_unavailable',
    )

    const writeFailure = new GateRedis()
    writeFailure.setFailure = new Error('Redis detail')
    await assert.rejects(
      () => gate(writeFailure).run(async () => undefined),
      (error: unknown) => error instanceof ApiError && error.code === 'provider_guard_unavailable',
    )

    const busy = new GateRedis()
    busy.setResult = null
    await assert.rejects(
      () => gate(busy).run(async () => undefined),
      (error: unknown) => error instanceof ApiError && error.code === 'provider_busy' && error.retryAfterSeconds === 2,
    )
  })

  it('honors bounded numeric and HTTP-date Retry-After values', async () => {
    const numericRedis = new GateRedis()
    const numeric = await gate(numericRedis).applyRateLimit(new Response('', { headers: { 'retry-after': '120' } }), 1)
    assert.equal(numeric, 120)

    const dateRedis = new GateRedis()
    const date = await gate(dateRedis).applyRateLimit(new Response('', {
      headers: { 'retry-after': 'Wed, 15 Jul 2026 12:03:00 GMT' },
    }), 1)
    assert.equal(date, 180)

    const invalidRedis = new GateRedis()
    const exponential = await gate(invalidRedis).applyRateLimit(new Response('', { headers: { 'retry-after': 'not-a-date' } }), 3)
    assert.equal(exponential, 240)

    const failedRedis = new GateRedis()
    failedRedis.setFailure = new Error('Redis detail')
    await assert.rejects(
      () => gate(failedRedis).applyRateLimit(new Response(''), 1),
      (error: unknown) => error instanceof ApiError && error.code === 'provider_guard_unavailable',
    )
  })

  it('rejects lease timing that cannot renew safely', () => {
    const redis = new GateRedis()
    assert.throws(() => gate(redis, { leaseMs: 9_999 }), /lease configuration/)
    assert.throws(() => gate(redis, { leaseMs: 10_000, renewEveryMs: 5_000 }), /lease configuration/)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { LichessConnectionService, RedisOAuthStateStore, type OAuthStateStore, type TokenVault } from '../src/connections/lichess.js'
import { ApiError } from '../src/errors.js'

class FakeRedis {
  values = new Map<string, string>()
  cooldownMs = -1
  async pttl(key: string) { return key.includes('cooldown') ? this.cooldownMs : -1 }
  async set(key: string, value: string, ...args: unknown[]) {
    if (args.includes('NX') && this.values.has(key)) return null
    this.values.set(key, value)
    if (key.includes('cooldown')) {
      const pxIndex = args.indexOf('PX')
      const duration = pxIndex >= 0 ? args[pxIndex + 1] : undefined
      this.cooldownMs = typeof duration === 'number' ? duration : Number(duration)
    }
    return 'OK'
  }
  async getdel(key: string) { const value = this.values.get(key) ?? null; this.values.delete(key); return value }
  async call(_command: string, _script: string, _keys: string, key: string) { this.values.delete(key); return 1 }
}

function fakePool(encryptedToken = Buffer.from('sealed-token')) {
  const statements: string[] = []
  const client = {
    query: async (sql: string) => {
      statements.push(sql)
      if (sql.includes('SELECT access_token_ciphertext')) return { rows: [{ access_token_ciphertext: encryptedToken }] }
      return { rows: [], rowCount: 1 }
    },
    release: () => undefined,
  }
  return { pool: { connect: async () => client } as unknown as Pool, statements }
}

describe('Lichess PKCE connection', () => {
  it('generates a bounded no-scope authorization request and stores one-time state', async () => {
    let stored: { state: string; value: { userId: string; verifier: string; redirectUri: string }; ttl: number } | undefined
    const states: OAuthStateStore = {
      put: async (state, value, ttl) => { stored = { state, value, ttl } },
      consume: async () => null,
    }
    const vault: TokenVault = {
      seal: async () => new Uint8Array(),
      open: async () => '',
    }
    const service = new LichessConnectionService(
      {} as Pool, {} as Redis, states, vault, 'linerecall-example',
      'LineRecall/0.1 security-contact@example.test',
    )
    const result = await service.beginLichess('user-a', 'https://app.example.test/connections/lichess/callback')
    const url = new URL(result.authorizationUrl)
    assert.equal(url.origin, 'https://lichess.org')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.has('scope'), false)
    assert.equal(url.searchParams.get('state'), stored?.state)
    assert.equal(stored?.value.userId, 'user-a')
    assert.equal(stored?.ttl, 600)
    assert.ok((stored?.value.verifier.length ?? 0) >= 43)
  })

  it('stores and atomically consumes hashed Redis state keys', async () => {
    const redis = new FakeRedis()
    const store = new RedisOAuthStateStore(redis as unknown as Redis)
    const value = { userId: 'user-a', verifier: 'verifier', redirectUri: 'https://app.example.test/callback' }
    await store.put('secret-state', value, 600)
    assert.equal([...redis.values.keys()][0]?.includes('secret-state'), false)
    assert.deepEqual(await store.consume('secret-state'), value)
    assert.equal(await store.consume('secret-state'), null)
  })

  it('fails closed when OAuth state collides or its stored envelope is malformed', async () => {
    const redis = new FakeRedis()
    const store = new RedisOAuthStateStore(redis as unknown as Redis)
    const value = { userId: 'user-a', verifier: 'verifier', redirectUri: 'https://app.example.test/callback' }
    await store.put('same-state', value, 600)
    await assert.rejects(
      () => store.put('same-state', value, 600),
      (error: unknown) => error instanceof ApiError && error.code === 'oauth_state_unavailable',
    )
    const key = [...redis.values.keys()][0]!
    redis.values.set(key, JSON.stringify({ userId: 'user-a', verifier: 42, redirectUri: null }))
    assert.equal(await store.consume('same-state'), null)
  })

  it('exchanges a one-time code, encrypts credentials, and revokes on disconnect', async () => {
    const redis = new FakeRedis()
    const { pool, statements } = fakePool()
    const states: OAuthStateStore = {
      put: async () => undefined,
      consume: async () => ({ userId: 'user-a', verifier: 'verifier', redirectUri: 'https://app.example.test/connections/lichess/callback' }),
    }
    const vault: TokenVault = {
      seal: async (_user, value) => Buffer.from(`sealed:${value}`),
      open: async () => 'provider-token',
    }
    const service = new LichessConnectionService(pool, redis as unknown as Redis, states, vault, 'linerecall-example', 'LineRecall/0.1 security@example.test')
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (url.endsWith('/api/token') && method === 'POST') return new Response(JSON.stringify({ access_token: 'abcdefghijklmnopqrstuvwxyz123456', expires_in: 3600 }), { status: 200 })
      if (url.endsWith('/api/account')) return new Response(JSON.stringify({ id: 'connected-user' }), { status: 200 })
      return new Response(null, { status: 204 })
    }
    try {
      await service.completeLichess('user-a', { code: 'code', state: 'state', redirectUri: 'https://app.example.test/connections/lichess/callback' }, new Date('2026-07-14T12:00:00Z'))
      await service.disconnectLichess('user-a', new Date('2026-07-14T13:00:00Z'))
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'DELETE'])
    assert.ok(statements.some((sql) => sql.includes('INSERT INTO external_connections')))
    assert.ok(statements.some((sql) => sql.includes("failure_code='connection_reauthorized'")))
    assert.ok(statements.some((sql) => sql.includes("failure_code='connection_disconnected'")))
    assert.ok(statements.some((sql) => sql.includes('DELETE FROM external_connections')))
  })

  it('rejects consumed state and honors a full provider cooldown', async () => {
    const redis = new FakeRedis()
    const { pool } = fakePool()
    const vault: TokenVault = { seal: async () => new Uint8Array(), open: async () => '' }
    const missing = new LichessConnectionService(pool, redis as unknown as Redis, { put: async () => undefined, consume: async () => null }, vault, 'linerecall-example', 'LineRecall security@example.test')
    await assert.rejects(
      () => missing.completeLichess('user-a', { code: 'code', state: 'state', redirectUri: 'https://app.example.test/callback' }, new Date()),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_oauth_state',
    )

    redis.cooldownMs = 59_000
    const ready = new LichessConnectionService(pool, redis as unknown as Redis, {
      put: async () => undefined,
      consume: async () => ({ userId: 'user-a', verifier: 'v', redirectUri: 'https://app.example.test/callback' }),
    }, vault, 'linerecall-example', 'LineRecall security@example.test')
    await assert.rejects(
      () => ready.completeLichess('user-a', { code: 'code', state: 'state', redirectUri: 'https://app.example.test/callback' }, new Date()),
      (error: unknown) => error instanceof ApiError && error.code === 'provider_rate_limited' && error.retryAfterSeconds === 60,
    )
  })

  it('rejects unsafe provider configuration and redirect origins', async () => {
    const { pool } = fakePool()
    const redis = new FakeRedis() as unknown as Redis
    const states: OAuthStateStore = { put: async () => undefined, consume: async () => null }
    const vault: TokenVault = { seal: async () => new Uint8Array(), open: async () => '' }
    assert.throws(() => new LichessConnectionService(pool, redis, states, vault, '!', 'LineRecall security@example.test'), /client ID/)
    assert.throws(() => new LichessConnectionService(pool, redis, states, vault, 'valid-client', 'short'), /User-Agent/)
    const service = new LichessConnectionService(pool, redis, states, vault, 'valid-client', 'LineRecall security@example.test')
    await assert.rejects(() => service.beginLichess('user-a', 'http://evil.example/callback'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_provider_configuration')
  })

  it('turns a provider 429 into a mandatory 60-second cooldown', async () => {
    const redis = new FakeRedis()
    const { pool } = fakePool()
    const service = new LichessConnectionService(pool, redis as unknown as Redis, {
      put: async () => undefined,
      consume: async () => ({ userId: 'user-a', verifier: 'verifier', redirectUri: 'https://app.example.test/callback' }),
    }, { seal: async () => new Uint8Array(), open: async () => '' }, 'valid-client', 'LineRecall security@example.test')
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('', { status: 429 })
    let retryAfterSeconds: number | undefined
    try {
      await assert.rejects(
        () => service.completeLichess('user-a', { code: 'code', state: 'state', redirectUri: 'https://app.example.test/callback' }, new Date()),
        (error: unknown) => {
          if (!(error instanceof ApiError) || error.code !== 'provider_rate_limited') return false
          retryAfterSeconds = error.retryAfterSeconds
          return retryAfterSeconds !== undefined && retryAfterSeconds >= 60 && retryAfterSeconds <= 72
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.ok(redis.cooldownMs >= 60_000 && redis.cooldownMs <= 72_000)
    assert.equal(retryAfterSeconds, Math.ceil(redis.cooldownMs / 1_000))
  })

  it('retains encrypted credentials when revocation fails', async () => {
    const redis = new FakeRedis()
    const { pool, statements } = fakePool()
    const service = new LichessConnectionService(
      pool, redis as unknown as Redis,
      { put: async () => undefined, consume: async () => null },
      { seal: async () => new Uint8Array(), open: async () => 'provider-token' },
      'valid-client', 'LineRecall security@example.test',
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('provider failure', { status: 500 })
    try {
      await assert.rejects(() => service.disconnectLichess('user-a', new Date()), /revocation failed/)
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(statements.some((sql) => sql.includes('DELETE FROM external_connections')), false)
  })

  it('deletes ciphertext when the provider confirms the token is already invalid', async () => {
    const redis = new FakeRedis()
    const { pool, statements } = fakePool()
    const service = new LichessConnectionService(
      pool, redis as unknown as Redis,
      { put: async () => undefined, consume: async () => null },
      { seal: async () => new Uint8Array(), open: async () => 'provider-token' },
      'valid-client', 'LineRecall security@example.test',
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('', { status: 401 })
    try {
      await service.revokeForAccountDeletion('user-a', new Date())
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(statements.some((sql) => sql.includes('DELETE FROM external_connections')), true)
  })

  it('bounds and validates token responses before accepting provider credentials', async () => {
    const redirectUri = 'https://app.example.test/callback'
    const originalFetch = globalThis.fetch
    const cases: Array<{
      name: string
      response: () => Response
      code?: string
    }> = [
      { name: 'empty body', response: () => new Response(null, { status: 200 }), code: 'invalid_provider_response' },
      { name: 'oversized body', response: () => new Response('x'.repeat(65_537), { status: 200 }), code: 'provider_response_too_large' },
      { name: 'rejected exchange', response: () => new Response('denied', { status: 400 }), code: 'provider_token_exchange_failed' },
      { name: 'non-string token', response: () => new Response(JSON.stringify({ access_token: 42 }), { status: 200 }), code: 'invalid_provider_response' },
      { name: 'short token', response: () => new Response(JSON.stringify({ access_token: 'short' }), { status: 200 }), code: 'invalid_provider_response' },
      { name: 'oversized token', response: () => new Response(JSON.stringify({ access_token: 'x'.repeat(2_049) }), { status: 200 }), code: 'invalid_provider_response' },
    ]
    try {
      for (const candidate of cases) {
        const redis = new FakeRedis()
        const { pool } = fakePool()
        const service = new LichessConnectionService(pool, redis as unknown as Redis, {
          put: async () => undefined,
          consume: async () => ({ userId: 'user-a', verifier: 'verifier', redirectUri }),
        }, { seal: async () => new Uint8Array(), open: async () => '' }, 'valid-client', 'LineRecall security@example.test')
        globalThis.fetch = async () => candidate.response()
        await assert.rejects(
          () => service.completeLichess('user-a', { code: 'code', state: 'state', redirectUri }, new Date()),
          (error: unknown) => error instanceof ApiError && error.code === candidate.code,
          candidate.name,
        )
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('validates account responses and preserves a null token expiry', async () => {
    const redirectUri = 'https://app.example.test/callback'
    const originalFetch = globalThis.fetch
    const tokenResponse = () => new Response(JSON.stringify({ access_token: 'abcdefghijklmnopqrstuvwxyz123456' }), { status: 200 })
    const accountCases: Array<{ response: () => Response; code: string }> = [
      { response: () => new Response('', { status: 429 }), code: 'provider_rate_limited' },
      { response: () => new Response('unavailable', { status: 503 }), code: 'provider_account_failed' },
      { response: () => new Response('{', { status: 200 }), code: 'invalid_provider_response' },
      { response: () => new Response(JSON.stringify({ id: '../invalid' }), { status: 200 }), code: 'invalid_provider_response' },
    ]
    try {
      for (const candidate of accountCases) {
        const redis = new FakeRedis()
        const { pool } = fakePool()
        const service = new LichessConnectionService(pool, redis as unknown as Redis, {
          put: async () => undefined,
          consume: async () => ({ userId: 'user-a', verifier: 'verifier', redirectUri }),
        }, { seal: async () => new Uint8Array(), open: async () => '' }, 'valid-client', 'LineRecall security@example.test')
        globalThis.fetch = async (input, init) => {
          if (String(input).endsWith('/api/token') && init?.method === 'POST') return tokenResponse()
          if (String(input).endsWith('/api/account')) return candidate.response()
          return new Response(null, { status: 204 })
        }
        await assert.rejects(
          () => service.completeLichess('user-a', { code: 'code', state: 'state', redirectUri }, new Date()),
          (error: unknown) => error instanceof ApiError && error.code === candidate.code,
        )
      }

      const { pool, statements } = fakePool()
      const successful = new LichessConnectionService(pool, new FakeRedis() as unknown as Redis, {
        put: async () => undefined,
        consume: async () => ({ userId: 'user-a', verifier: 'verifier', redirectUri }),
      }, { seal: async (_user, value) => Buffer.from(value), open: async () => '' }, 'valid-client', 'LineRecall security@example.test')
      globalThis.fetch = async (input, init) => String(input).endsWith('/api/token') && init?.method === 'POST'
        ? tokenResponse()
        : new Response(JSON.stringify({ id: 'connected-user' }), { status: 200 })
      await successful.completeLichess('user-a', { code: 'code', state: 'state', redirectUri }, new Date())
      assert.ok(statements.some((sql) => sql.includes('INSERT INTO external_connections')))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rolls back failed credential persistence and attempts provider revocation', async () => {
    const statements: string[] = []
    let released = false
    const client = {
      async query(sql: string) {
        statements.push(sql)
        if (sql.includes('INSERT INTO external_connections')) throw new Error('database unavailable')
        return { rows: [], rowCount: 1 }
      },
      release() { released = true },
    }
    const pool = { connect: async () => client } as unknown as Pool
    const redirectUri = 'https://app.example.test/callback'
    const service = new LichessConnectionService(pool, new FakeRedis() as unknown as Redis, {
      put: async () => undefined,
      consume: async () => ({ userId: 'user-a', verifier: 'verifier', redirectUri }),
    }, { seal: async (_user, value) => Buffer.from(value), open: async () => '' }, 'valid-client', 'LineRecall security@example.test')
    const originalFetch = globalThis.fetch
    const methods: string[] = []
    globalThis.fetch = async (input, init) => {
      methods.push(init?.method ?? 'GET')
      if (String(input).endsWith('/api/token') && init?.method === 'POST') {
        return new Response(JSON.stringify({ access_token: 'abcdefghijklmnopqrstuvwxyz123456' }), { status: 200 })
      }
      if (String(input).endsWith('/api/account')) return new Response(JSON.stringify({ id: 'connected-user' }), { status: 200 })
      return new Response(null, { status: 204 })
    }
    try {
      await assert.rejects(
        () => service.completeLichess('user-a', { code: 'code', state: 'state', redirectUri }, new Date()),
        /database unavailable/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.ok(statements.includes('ROLLBACK'))
    assert.ok(methods.includes('DELETE'))
    assert.equal(released, true)
  })

  it('honors provider cooldown when token revocation itself is rate limited', async () => {
    const redis = new FakeRedis()
    const { pool, statements } = fakePool()
    const service = new LichessConnectionService(pool, redis as unknown as Redis, {
      put: async () => undefined,
      consume: async () => null,
    }, { seal: async () => new Uint8Array(), open: async () => 'provider-token' }, 'valid-client', 'LineRecall security@example.test')
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('', { status: 429 })
    try {
      await assert.rejects(
        () => service.disconnectLichess('user-a', new Date()),
        (error: unknown) => error instanceof ApiError && error.code === 'provider_rate_limited',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(statements.some((sql) => sql.includes('DELETE FROM external_connections')), false)
    assert.ok(redis.cooldownMs >= 60_000)
  })
})

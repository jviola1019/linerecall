import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import {
  DisabledExternalConnectionService,
  HeaderAuthenticator,
  InMemoryRateLimiter,
  InMemoryRepertoireService,
  InMemorySyncStore,
  StaticCatalogService,
} from '../src/adapters/memory.js'
import type { Authenticator, ExternalConnectionService, RateLimiter, ServiceDependencies } from '../src/ports.js'
import { AUDITED_MEMORY_OPTIONS, NOW, tacticalPuzzle } from './helpers.js'

const ORIGIN = 'https://app.example.test'
const HEADERS = { origin: ORIGIN, 'x-linerecall-user': 'user-branches' }

function dependencies(overrides: Partial<ServiceDependencies> = {}): ServiceDependencies {
  return {
    auth: new HeaderAuthenticator(true, () => NOW),
    sync: new InMemorySyncStore(AUDITED_MEMORY_OPTIONS),
    rateLimiter: new InMemoryRateLimiter(),
    repertoires: new InMemoryRepertoireService(),
    catalog: new StaticCatalogService(
      { etag: '"test-catalog"', manifest: { schema: 'test-catalog' } },
      [tacticalPuzzle('Puzzle001'), tacticalPuzzle('Puzzle002')],
    ),
    connections: new DisabledExternalConnectionService(),
    clock: { now: () => NOW },
    ...overrides,
  }
}

describe('Fastify API decision branches', () => {
  it('rejects non-origin, credentialed, and path-bearing public origins', async () => {
    const credentialed = new URL('https://app.example.test')
    credentialed.username = 'fixture-user'
    credentialed.password = 'fixture-value'
    for (const origin of ['ftp://app.example.test', credentialed.toString(), 'https://app.example.test/path']) {
      await assert.rejects(() => createApp(dependencies(), { publicOrigin: origin }), /HTTP\(S\) origin/)
    }
  })

  it('reports both ready and degraded dependency states', async () => {
    for (const ready of [true, false]) {
      const app = await createApp(dependencies({ readiness: { check: async () => ({ database: ready, redis: true, catalog: true }) } }), { publicOrigin: ORIGIN })
      const response = await app.inject({ method: 'GET', url: '/health/ready' })
      await app.close()
      assert.equal(response.statusCode, ready ? 200 : 503)
      assert.equal(response.json().status, ready ? 'ready' : 'not_ready')
    }
    const defaultApp = await createApp(dependencies(), { publicOrigin: ORIGIN })
    assert.equal((await defaultApp.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200)
    await defaultApp.close()
  })

  it('proxies passkey and generic auth requests with bounded headers, cookies, and bodies', async () => {
    const forwarded: Request[] = []
    const auth: Authenticator = {
      authenticate: async () => null,
      handleWebRequest: async (request) => {
        forwarded.push(request)
        if (request.url.endsWith('/empty')) return new Response(null, { status: 204 })
        return new Response('auth-ok', {
          status: 201,
          headers: [
            ['content-type', 'text/plain'],
            ['ratelimit-limit', '999999'],
            ['retry-after', '999999'],
            ['set-cookie', '__Host-session=opaque; Secure; HttpOnly; Path=/'],
          ],
        })
      },
    }
    const app = await createApp(dependencies({ auth }), { publicOrigin: ORIGIN, serviceOrigin: 'https://api.example.test' })
    const passkey = await app.inject({
      method: 'POST', url: '/api/auth/passkey/verify', headers: { origin: ORIGIN, 'x-forwarded-test': ['one', 'two'] },
      payload: { challenge: 'opaque' },
    })
    const generic = await app.inject({ method: 'GET', url: '/api/auth/session' })
    const empty = await app.inject({ method: 'HEAD', url: '/api/auth/empty' })
    const invalidEmail = await app.inject({
      method: 'POST', url: '/api/auth/sign-in/magic-link', headers: { origin: ORIGIN }, payload: { email: 'not-an-email' },
    })
    await app.close()

    assert.equal(passkey.statusCode, 201)
    assert.equal(passkey.body, 'auth-ok')
    assert.match(String(passkey.headers['set-cookie']), /HttpOnly/u)
    assert.equal(passkey.headers['ratelimit-limit'], '30')
    assert.notEqual(passkey.headers['retry-after'], '999999')
    assert.equal(generic.statusCode, 201)
    assert.equal(empty.statusCode, 204)
    assert.equal(invalidEmail.statusCode, 201)
    assert.equal(forwarded.length, 4)
    assert.equal(new URL(forwarded[0]!.url).origin, 'https://api.example.test')
    assert.deepEqual(await forwarded[0]!.json(), { challenge: 'opaque' })
    assert.equal(forwarded[1]!.body, null)
  })

  it('removes bearer and device metadata from browser-visible auth sessions', async () => {
    const auth: Authenticator = {
      authenticate: async () => null,
      handleWebRequest: async () => Response.json({
        session: {
          id: 'session-1', userId: 'user-a', token: 'secret-bearer',
          ipAddress: '192.0.2.1', userAgent: 'private-agent',
          createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        },
        user: { id: 'user-a', email: 'user@example.test' },
      }),
    }
    const app = await createApp(dependencies({ auth }), { publicOrigin: ORIGIN })
    const response = await app.inject({ method: 'GET', url: '/api/auth/get-session' })
    await app.close()
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.session.token, undefined)
    assert.equal(body.session.ipAddress, undefined)
    assert.equal(body.session.userAgent, undefined)
    assert.equal(body.session.id, 'session-1')
    assert.equal(response.body.includes('secret-bearer'), false)
  })

  it('fails closed without disclosing email state when the per-email limiter is unavailable', async () => {
    let calls = 0
    const limiter: RateLimiter = {
      consume: async (key) => {
        calls += 1
        if (key.startsWith('magic-link-email:')) throw new Error('redis unavailable')
        return { allowed: true, limit: 20, remaining: 19, resetAt: new Date(NOW.getTime() + 60_000) }
      },
    }
    let forwarded = 0
    const auth: Authenticator = {
      authenticate: async () => null,
      handleWebRequest: async () => { forwarded += 1; return Response.json({ status: true }) },
    }
    const app = await createApp(dependencies({ auth, rateLimiter: limiter }), { publicOrigin: ORIGIN })
    const response = await app.inject({
      method: 'POST', url: '/api/auth/sign-in/magic-link', headers: { origin: ORIGIN }, payload: { email: 'user@example.test' },
    })
    await app.close()
    assert.equal(response.statusCode, 200)
    assert.equal(forwarded, 0)
    assert.equal(calls, 3)
  })

  it('returns the same generic magic-link response when the IP limit is exhausted', async () => {
    const limiter: RateLimiter = {
      consume: async () => ({ allowed: false, limit: 20, remaining: 0, resetAt: new Date(NOW.getTime() + 60_000) }),
    }
    let forwarded = 0
    const auth: Authenticator = {
      authenticate: async () => null,
      handleWebRequest: async () => { forwarded += 1; return Response.json({ status: true }) },
    }
    const app = await createApp(dependencies({ auth, rateLimiter: limiter }), { publicOrigin: ORIGIN })
    const response = await app.inject({
      method: 'POST', url: '/api/auth/sign-in/magic-link', headers: { origin: ORIGIN }, payload: { email: 'user@example.test' },
    })
    await app.close()
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { status: true })
    assert.equal(forwarded, 0)
  })

  it('rate-limits every generic auth route before invoking the auth gateway', async () => {
    const keys: string[] = []
    const limiter: RateLimiter = {
      consume: async (key, limit) => {
        keys.push(key)
        return {
          allowed: false,
          limit,
          remaining: 0,
          resetAt: new Date(NOW.getTime() + 60_000),
        }
      },
    }
    let forwarded = 0
    const auth: Authenticator = {
      authenticate: async () => null,
      handleWebRequest: async () => {
        forwarded += 1
        return Response.json({ status: true })
      },
    }
    const app = await createApp(dependencies({ auth, rateLimiter: limiter }), { publicOrigin: ORIGIN })
    const response = await app.inject({ method: 'GET', url: '/api/auth/session' })
    await app.close()

    assert.equal(response.statusCode, 429)
    assert.equal(response.json().error.code, 'rate_limit_exceeded')
    assert.equal(response.headers['ratelimit-limit'], '120')
    assert.equal(response.headers['ratelimit-remaining'], '0')
    assert.equal(forwarded, 0)
    assert.equal(keys.length, 1)
    assert.match(keys[0]!, /^auth-ip:/u)
  })

  it('uses a real Fastify auth backstop while preserving generic magic-link responses', async () => {
    const limiter: RateLimiter = {
      consume: async (_key, limit) => ({
        allowed: true,
        limit,
        remaining: Math.max(0, limit - 1),
        resetAt: new Date(NOW.getTime() + 300_000),
      }),
    }
    let forwarded = 0
    const auth: Authenticator = {
      authenticate: async () => null,
      handleWebRequest: async () => {
        forwarded += 1
        return Response.json({ status: true })
      },
    }
    const app = await createApp(dependencies({ auth, rateLimiter: limiter }), { publicOrigin: ORIGIN })
    for (let index = 0; index < 120; index += 1) {
      const accepted = await app.inject({ method: 'GET', url: '/api/auth/session' })
      assert.equal(accepted.statusCode, 200)
    }
    const exhausted = await app.inject({ method: 'GET', url: '/api/auth/session' })
    assert.equal(exhausted.statusCode, 429, exhausted.body)
    const exhaustedBody = exhausted.json()
    assert.equal(exhaustedBody.error.code, 'rate_limit_exceeded')
    assert.equal(typeof exhaustedBody.error.requestId, 'string')
    assert.equal(exhausted.headers['ratelimit-limit'], '120')
    assert.equal(exhausted.headers['ratelimit-remaining'], '0')
    assert.match(String(exhausted.headers['ratelimit-reset']), /^\d+$/u)
    assert.match(String(exhausted.headers['retry-after']), /^\d+$/u)
    assert.equal(exhaustedBody.error.retryAfterSeconds, Number(exhausted.headers['retry-after']))
    assert.equal(forwarded, 120)

    const magicLink = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { origin: ORIGIN },
      payload: { email: 'user@example.test' },
    })
    await app.close()

    assert.equal(magicLink.statusCode, 200)
    assert.deepEqual(magicLink.json(), { status: true })
    assert.equal(forwarded, 121)
  })

  it('layers the stricter passkey limiter over the auth-route baseline', async () => {
    const keys: string[] = []
    const limiter: RateLimiter = {
      consume: async (key, limit) => {
        keys.push(key)
        return {
          allowed: true,
          limit,
          remaining: limit - 1,
          resetAt: new Date(NOW.getTime() + 60_000),
        }
      },
    }
    const auth: Authenticator = {
      authenticate: async () => null,
      handleWebRequest: async () => Response.json({ status: true }),
    }
    const app = await createApp(dependencies({ auth, rateLimiter: limiter }), { publicOrigin: ORIGIN })
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/verify',
      headers: { origin: ORIGIN },
      payload: { challenge: 'opaque' },
    })
    await app.close()

    assert.equal(response.statusCode, 200)
    assert.equal(keys.length, 2)
    assert.match(keys[0]!, /^auth-ip:/u)
    assert.match(keys[1]!, /^passkey-ip:/u)
  })

  it('classifies auth limits from exact paths rather than attacker-controlled query text or prefixes', async () => {
    const keys: string[] = []
    const limiter: RateLimiter = {
      consume: async (key, limit) => {
        keys.push(key)
        return {
          allowed: true,
          limit,
          remaining: limit - 1,
          resetAt: new Date(NOW.getTime() + 60_000),
        }
      },
    }
    const auth: Authenticator = {
      authenticate: async () => null,
      handleWebRequest: async () => Response.json({ status: true }),
    }
    const app = await createApp(dependencies({ auth, rateLimiter: limiter }), { publicOrigin: ORIGIN })
    const queryOnly = await app.inject({ method: 'GET', url: '/api/auth/session?next=/passkey/verify' })
    const prefixedMagic = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link-shadow',
      headers: { origin: ORIGIN },
      payload: { email: 'user@example.test' },
    })
    await app.close()

    assert.equal(queryOnly.statusCode, 200)
    assert.equal(prefixedMagic.statusCode, 200)
    assert.equal(keys.length, 2)
    assert.equal(keys.every((key) => key.startsWith('auth-ip:')), true)
  })

  it('does not disguise a malformed limiter decision as a successful magic-link request', async () => {
    const limiter: RateLimiter = {
      consume: async () => ({ allowed: true, limit: 20, remaining: 19, resetAt: null as never }),
    }
    let forwarded = 0
    const auth: Authenticator = {
      authenticate: async () => null,
      handleWebRequest: async () => { forwarded += 1; return Response.json({ status: true }) },
    }
    const app = await createApp(dependencies({ auth, rateLimiter: limiter }), { publicOrigin: ORIGIN })
    const response = await app.inject({
      method: 'POST', url: '/api/auth/sign-in/magic-link', headers: { origin: ORIGIN }, payload: { email: 'user@example.test' },
    })
    await app.close()
    assert.equal(response.statusCode, 500)
    assert.equal(response.json().error.code, 'internal_error')
    assert.equal(forwarded, 0)
  })

  it('applies optional puzzle filters and rejects malformed pagination', async () => {
    const app = await createApp(dependencies(), { publicOrigin: ORIGIN })
    const page = await app.inject({ method: 'GET', url: '/v1/puzzles?packId=pack-a&cursor=0&limit=1' })
    const invalid = await app.inject({ method: 'GET', url: '/v1/puzzles?limit=1000' })
    await app.close()
    assert.equal(page.statusCode, 200)
    assert.equal(page.json().items.length, 1)
    assert.equal(invalid.statusCode, 422)
  })

  it('returns explicit import, repertoire, and share lookup failures', async () => {
    const app = await createApp(dependencies(), { publicOrigin: ORIGIN })
    const missingImport = await app.inject({
      method: 'GET', url: '/v1/repertoires/imports/0198a5c0-1000-7000-8000-000000000099', headers: HEADERS,
    })
    const invalidImport = await app.inject({ method: 'GET', url: '/v1/repertoires/imports/not-a-uuid', headers: HEADERS })
    const badRepertoire = await app.inject({
      method: 'PUT', url: '/v1/repertoires/bad!', headers: { ...HEADERS, 'if-match': '"0"' },
      payload: { name: 'Name', side: 'white', rootNodeId: 'root', nodeIds: ['root'], annotations: [] },
    })
    const badShareRepertoire = await app.inject({
      method: 'POST', url: '/v1/repertoires/bad!/shares', headers: HEADERS,
      payload: { revisionId: '0198a5c0-1000-7000-8000-000000000099', expiresAt: null },
    })
    const badShareId = await app.inject({ method: 'DELETE', url: '/v1/shares/not-a-uuid', headers: HEADERS })
    const missingShareId = await app.inject({
      method: 'DELETE', url: '/v1/shares/0198a5c0-1000-7000-8000-000000000099', headers: HEADERS,
    })
    const badToken = await app.inject({ method: 'GET', url: '/v1/shares/short' })
    const missingToken = await app.inject({ method: 'GET', url: `/v1/shares/${'A'.repeat(43)}` })
    await app.close()
    assert.deepEqual([
      missingImport.statusCode, invalidImport.statusCode, badRepertoire.statusCode, badShareRepertoire.statusCode,
      badShareId.statusCode, missingShareId.statusCode, badToken.statusCode, missingToken.statusCode,
    ], [404, 422, 422, 422, 422, 404, 404, 404])
  })

  it('requires recent authentication and uses the identity provider deletion hook when available', async () => {
    let deletedIdentity = 0
    let revoked = 0
    const oldAuth: Authenticator = {
      authenticate: async () => ({ userId: 'old-user', sessionId: 'old-session', authTime: new Date(NOW.getTime() - 601_000) }),
    }
    const oldApp = await createApp(dependencies({ auth: oldAuth }), { publicOrigin: ORIGIN })
    const old = await oldApp.inject({ method: 'DELETE', url: '/v1/account', headers: { origin: ORIGIN } })
    await oldApp.close()
    assert.equal(old.statusCode, 403)
    assert.equal(old.json().error.code, 'recent_authentication_required')

    const auth: Authenticator = {
      authenticate: async () => ({ userId: 'new-user', sessionId: 'session', authTime: NOW }),
      deleteIdentity: async () => { deletedIdentity += 1 },
    }
    const connections: ExternalConnectionService = {
      beginLichess: async () => ({ authorizationUrl: 'https://lichess.org/oauth' }),
      completeLichess: async () => undefined,
      disconnectLichess: async () => undefined,
      revokeForAccountDeletion: async () => { revoked += 1 },
    }
    const app = await createApp(dependencies({ auth, connections }), { publicOrigin: ORIGIN })
    const removed = await app.inject({ method: 'DELETE', url: '/v1/account', headers: { origin: ORIGIN } })
    await app.close()
    assert.equal(removed.statusCode, 204)
    assert.equal(revoked, 1)
    assert.equal(deletedIdentity, 1)
  })

  it('validates, completes, and disconnects the no-scope Lichess connection flow', async () => {
    const completed: unknown[] = []
    let disconnected = 0
    const connections: ExternalConnectionService = {
      beginLichess: async () => ({ authorizationUrl: 'https://lichess.org/oauth' }),
      completeLichess: async (...args) => { completed.push(args) },
      disconnectLichess: async () => { disconnected += 1 },
      revokeForAccountDeletion: async () => undefined,
    }
    const app = await createApp(dependencies({ connections }), { publicOrigin: ORIGIN })
    const invalid = await app.inject({
      method: 'POST', url: '/v1/connections/lichess/complete', headers: HEADERS, payload: { code: 1, state: 'state' },
    })
    const oversized = await app.inject({
      method: 'POST', url: '/v1/connections/lichess/complete', headers: HEADERS,
      payload: { code: 'c'.repeat(2049), state: 's'.repeat(257) },
    })
    const complete = await app.inject({
      method: 'POST', url: '/v1/connections/lichess/complete', headers: HEADERS, payload: { code: 'code', state: 'state' },
    })
    const disconnectedResponse = await app.inject({ method: 'DELETE', url: '/v1/connections/lichess', headers: HEADERS })
    await app.close()
    assert.equal(invalid.statusCode, 422)
    assert.equal(oversized.statusCode, 422)
    assert.equal(complete.statusCode, 204)
    assert.equal(disconnectedResponse.statusCode, 204)
    assert.equal(completed.length, 1)
    assert.equal((completed[0] as unknown[])[1] && ((completed[0] as unknown[])[1] as { redirectUri: string }).redirectUri, `${ORIGIN}/connections/lichess/callback`)
    assert.equal(disconnected, 1)
  })

  it('returns 503 for protected mutations when limits cannot be verified and sanitizes internal failures', async () => {
    const unavailable: RateLimiter = { consume: async () => { throw new Error('redis unavailable') } }
    const limited = await createApp(dependencies({ rateLimiter: unavailable }), { publicOrigin: ORIGIN })
    const closed = await limited.inject({ method: 'POST', url: '/v1/sync', headers: HEADERS, payload: {} })
    await limited.close()
    assert.equal(closed.statusCode, 503)
    assert.equal(closed.headers['retry-after'], '60')

    const sync = new InMemorySyncStore(AUDITED_MEMORY_OPTIONS)
    sync.exportAccount = async () => { throw new Error('sensitive-adapter-detail') }
    const failing = await createApp(dependencies({ sync }), { publicOrigin: ORIGIN, logger: true })
    const response = await failing.inject({ method: 'GET', url: '/v1/account/export', headers: HEADERS })
    await failing.close()
    assert.equal(response.statusCode, 500)
    assert.equal(response.json().error.code, 'internal_error')
    assert.equal(response.body.includes('sensitive-adapter-detail'), false)
  })

  it('uses the framework payload limit for oversized imports', async () => {
    const app = await createApp(dependencies(), { publicOrigin: ORIGIN })
    const response = await app.inject({
      method: 'POST', url: '/v1/repertoires/imports', headers: HEADERS,
      payload: { name: 'Large', side: 'white', pgn: 'x'.repeat(1_060_000) },
    })
    await app.close()
    assert.equal(response.statusCode, 413)
    assert.equal(response.json().error.code, 'payload_too_large')
  })
})

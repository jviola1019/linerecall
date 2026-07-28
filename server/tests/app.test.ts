import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { createApp } from '../src/app.js'
import {
  DisabledExternalConnectionService,
  HeaderAuthenticator,
  InMemoryRateLimiter,
  InMemoryRepertoireService,
  InMemorySyncStore,
  StaticCatalogService,
} from '../src/adapters/memory.js'
import type { Authenticator, ExternalConnectionService, LichessSyncService, RateLimiter } from '../src/ports.js'
import { ApiError } from '../src/errors.js'
import { AUDITED_MEMORY_OPTIONS, DEVICE_ID, NOW, reviewEvent } from './helpers.js'

const ORIGIN = 'https://app.example.test'

function dependencies(rateLimiter: RateLimiter = new InMemoryRateLimiter()) {
  return {
    auth: new HeaderAuthenticator(true, () => NOW),
    sync: new InMemorySyncStore(AUDITED_MEMORY_OPTIONS),
    rateLimiter,
    repertoires: new InMemoryRepertoireService(),
    catalog: new StaticCatalogService(),
    connections: new DisabledExternalConnectionService(),
    clock: { now: () => NOW },
  }
}

describe('Fastify API boundary', () => {
  let app: FastifyInstance
  before(async () => { app = await createApp(dependencies(), { publicOrigin: ORIGIN }) })
  after(async () => app.close())

  it('serves process health and restrictive headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.match(response.headers['content-security-policy'] ?? '', /default-src 'none'/)
    assert.equal(response.headers['cache-control'], 'no-store')
  })

  it('rejects unauthenticated and cross-origin mutations', async () => {
    const noOrigin = await app.inject({ method: 'POST', url: '/v1/sync', payload: {} })
    const noAuth = await app.inject({ method: 'POST', url: '/v1/sync', headers: { origin: ORIGIN }, payload: {} })
    assert.equal(noOrigin.statusCode, 403)
    assert.equal(noAuth.statusCode, 401)
  })

  it('validates and accepts a sync request', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/sync',
      headers: { origin: ORIGIN, 'x-linerecall-user': 'user-a' },
      payload: { deviceId: DEVICE_ID, cursor: null, events: [reviewEvent()] },
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().cards[0].intervalDays, 1)
    assert.equal(response.headers['ratelimit-limit'], '60')
  })

  it('returns bounded validation details without echoing hostile input', async () => {
    const hostile = '<script>alert(1)</script>'
    const response = await app.inject({
      method: 'POST', url: '/v1/sync',
      headers: { origin: ORIGIN, 'x-linerecall-user': 'user-a' },
      payload: { deviceId: hostile, cursor: null, events: [] },
    })
    assert.equal(response.statusCode, 422)
    assert.equal(response.json().error.code, 'validation_failed')
    assert.doesNotMatch(response.body, /<script>/)
  })

  it('uses ETags for the public catalog', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/catalog/manifest' })
    const second = await app.inject({ method: 'GET', url: '/v1/catalog/manifest', headers: { 'if-none-match': first.headers.etag! } })
    assert.equal(first.statusCode, 200)
    assert.equal(second.statusCode, 304)
  })

  it('creates an immutable repertoire revision and revocable unlisted share', async () => {
    const headers = { origin: ORIGIN, 'x-linerecall-user': 'user-a' }
    const update = await app.inject({
      method: 'PUT', url: '/v1/repertoires/my-repertoire', headers: { ...headers, 'if-match': '"0"' },
      payload: { name: 'My repertoire', side: 'white', rootNodeId: 'root', nodeIds: ['root'], annotations: [] },
    })
    assert.equal(update.statusCode, 200, update.body)
    const revisionId = update.json().revisionId
    const created = await app.inject({
      method: 'POST', url: '/v1/repertoires/my-repertoire/shares', headers,
      payload: { revisionId, expiresAt: null },
    })
    assert.equal(created.statusCode, 201, created.body)
    const { id, token } = created.json()
    const shared = await app.inject({ method: 'GET', url: `/v1/shares/${token}` })
    assert.equal(shared.statusCode, 200)
    assert.equal(shared.headers['cache-control'], 'no-store')
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/shares/${id}`, headers })).statusCode, 204)
    assert.equal((await app.inject({ method: 'GET', url: `/v1/shares/${token}` })).statusCode, 404)
  })

  it('keeps public cached reads available when the limiter is unavailable', async () => {
    const unavailable: RateLimiter = { consume: async () => { throw new Error('redis down') } }
    const isolated = await createApp(dependencies(unavailable), { publicOrigin: ORIGIN })
    const response = await isolated.inject({ method: 'GET', url: '/v1/catalog/manifest' })
    const share = await isolated.inject({ method: 'GET', url: `/v1/shares/${'A'.repeat(43)}` })
    await isolated.close()
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['ratelimit-policy'], 'degraded; limiter unavailable')
    assert.equal(share.statusCode, 503)
  })

  it('returns explicit import, export, provider, and not-found states', async () => {
    const headers = { origin: ORIGIN, 'x-linerecall-user': 'user-routes' }
    const queued = await app.inject({
      method: 'POST', url: '/v1/repertoires/imports', headers,
      payload: { name: 'Imported', side: 'white', pgn: '[Result "*"]\n\n*' },
    })
    assert.equal(queued.statusCode, 202)
    const job = await app.inject({ method: 'GET', url: `/v1/repertoires/imports/${queued.json().id}`, headers })
    assert.equal(job.statusCode, 200)
    const exported = await app.inject({ method: 'GET', url: '/v1/account/export', headers })
    assert.equal(exported.statusCode, 200)
    assert.match(exported.headers['content-disposition'] ?? '', /linerecall-account-export/)
    const provider = await app.inject({ method: 'POST', url: '/v1/connections/lichess/start', headers })
    assert.equal(provider.statusCode, 503)
    const syncStatus = await app.inject({ method: 'GET', url: '/v1/connections/lichess/sync', headers })
    assert.deepEqual(syncStatus.json(), {
      available: false, unavailableReason: 'not_configured', connected: false,
      consentedAt: null, lastSyncedAt: null, job: null,
    })
    const syncRequest = await app.inject({ method: 'POST', url: '/v1/connections/lichess/sync', headers })
    assert.equal(syncRequest.statusCode, 503)
    assert.equal(syncRequest.json().error.code, 'lichess_sync_not_configured')
    const missing = await app.inject({ method: 'GET', url: '/does-not-exist' })
    assert.equal(missing.statusCode, 404)
  })

  it('authenticates and rate-limits Lichess sync status and requests', async () => {
    const calls: Array<{ operation: string; userId: string; now: string }> = []
    const lichessSync: LichessSyncService = {
      async status(userId, now) {
        calls.push({ operation: 'status', userId, now: now.toISOString() })
        return {
          available: true, unavailableReason: null, connected: true,
          consentedAt: NOW.toISOString(), lastSyncedAt: null, job: null,
        }
      },
      async request(userId, now) {
        calls.push({ operation: 'request', userId, now: now.toISOString() })
        return {
          jobId: '0198a5c0-1000-7000-8000-000000000090', status: 'queued', syncStartedAt: now.toISOString(),
        }
      },
    }
    const isolated = await createApp({ ...dependencies(), lichessSync }, { publicOrigin: ORIGIN })
    const noAuth = await isolated.inject({ method: 'GET', url: '/v1/connections/lichess/sync' })
    const headers = { origin: ORIGIN, 'x-linerecall-user': 'sync-user' }
    const status = await isolated.inject({ method: 'GET', url: '/v1/connections/lichess/sync', headers })
    const requested = await isolated.inject({ method: 'POST', url: '/v1/connections/lichess/sync', headers })
    await isolated.close()
    assert.equal(noAuth.statusCode, 401)
    assert.equal(status.statusCode, 200)
    assert.equal(status.json().available, true)
    assert.equal(requested.statusCode, 202)
    assert.equal(requested.headers['ratelimit-limit'], '10')
    assert.deepEqual(calls, [
      { operation: 'status', userId: 'sync-user', now: NOW.toISOString() },
      { operation: 'request', userId: 'sync-user', now: NOW.toISOString() },
    ])
  })

  it('batches idempotent puzzle attempts independently from opening recall', async () => {
    const headers = { origin: ORIGIN, 'x-linerecall-user': 'user-puzzles' }
    const payload = {
      deviceId: DEVICE_ID,
      attempts: [{
        attemptId: '0198a5c0-4000-7000-8000-000000000005', deviceId: DEVICE_ID,
        puzzleId: 'puzzle-001', outcome: 'solved', incorrectAttempts: 1, usedHint: true,
        elapsedMs: 12_345, occurredAt: '2026-07-14T11:58:00.000Z',
        snapshotVersion: 'release-2026q2',
      }],
    }
    const first = await app.inject({ method: 'POST', url: '/v1/puzzles/attempts', headers, payload })
    const retry = await app.inject({ method: 'POST', url: '/v1/puzzles/attempts', headers, payload })
    assert.equal(first.statusCode, 200, first.body)
    assert.equal(first.json().progress[0].attempts, 1)
    assert.equal(first.json().progress[0].hintsUsed, 1)
    assert.equal(first.json().progress[0].incorrectMoves, 1)
    assert.equal(first.json().progress[0].totalElapsedMs, 12_345)
    assert.equal(retry.json().progress[0].attempts, 1)
    const bootstrap = await app.inject({
      method: 'GET',
      url: '/v1/puzzles/progress?cursor=0&limit=250',
      headers,
    })
    assert.equal(bootstrap.statusCode, 200, bootstrap.body)
    assert.equal(bootstrap.json().progress[0].puzzleId, 'puzzle-001')
    assert.equal(bootstrap.json().progress[0].attempts, 1)
    assert.equal(bootstrap.headers['ratelimit-limit'], '60')
  })

  it('rejects structurally adversarial PGN before it reaches object storage', async () => {
    const headers = { origin: ORIGIN, 'x-linerecall-user': 'user-hostile-pgn' }
    const response = await app.inject({
      method: 'POST', url: '/v1/repertoires/imports', headers,
      payload: { name: 'Hostile', side: 'white', pgn: `${'('.repeat(33)}e4${')'.repeat(33)}` },
    })
    assert.equal(response.statusCode, 422)
    assert.equal(response.json().error.code, 'invalid_pgn_envelope')
  })

  it('requires If-Match and reports optimistic revision conflicts', async () => {
    const headers = { origin: ORIGIN, 'x-linerecall-user': 'user-precondition' }
    const payload = { name: 'Repertoire', side: 'black', rootNodeId: 'root', nodeIds: ['root'], annotations: [] }
    const missing = await app.inject({ method: 'PUT', url: '/v1/repertoires/rep', headers, payload })
    assert.equal(missing.statusCode, 428)
    const created = await app.inject({ method: 'PUT', url: '/v1/repertoires/rep', headers: { ...headers, 'if-match': '"0"' }, payload })
    const stale = await app.inject({ method: 'PUT', url: '/v1/repertoires/rep', headers: { ...headers, 'if-match': '"0"' }, payload })
    assert.equal(created.statusCode, 200)
    assert.equal(stale.statusCode, 412)
  })

  it('returns 429 with a retry interval when a policy is exhausted', async () => {
    const exhausted: RateLimiter = {
      consume: async () => ({ allowed: false, limit: 1, remaining: 0, resetAt: new Date(NOW.getTime() + 30_000) }),
    }
    const isolated = await createApp(dependencies(exhausted), { publicOrigin: ORIGIN })
    const response = await isolated.inject({ method: 'GET', url: '/v1/catalog/manifest' })
    await isolated.close()
    assert.equal(response.statusCode, 429)
    assert.equal(response.headers['retry-after'], '30')
  })

  it('deletes local account data after recent authentication', async () => {
    const headers = { origin: ORIGIN, 'x-linerecall-user': 'delete-me' }
    await app.inject({
      method: 'POST', url: '/v1/sync', headers,
      payload: { deviceId: DEVICE_ID, cursor: null, events: [reviewEvent()] },
    })
    const removed = await app.inject({ method: 'DELETE', url: '/v1/account', headers })
    const empty = await app.inject({ method: 'GET', url: '/v1/sync/bootstrap', headers })
    assert.equal(removed.statusCode, 204)
    assert.equal(empty.json().cards.length, 0)
  })

  it('enforces the 256 KiB sync envelope before schema parsing', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/sync', headers: { origin: ORIGIN, 'x-linerecall-user': 'user-large' },
      payload: { deviceId: DEVICE_ID, cursor: null, events: [], padding: 'x'.repeat(270_000) },
    })
    assert.equal(response.statusCode, 413)
    assert.equal(response.json().error.code, 'sync_payload_too_large')
  })

  it('adds HSTS only in production mode', async () => {
    const production = await createApp(dependencies(), { publicOrigin: ORIGIN, production: true })
    const response = await production.inject({ method: 'GET', url: '/health/live' })
    await production.close()
    assert.match(response.headers['strict-transport-security'] ?? '', /max-age=31536000/)
    assert.doesNotMatch(response.headers['strict-transport-security'] ?? '', /includeSubDomains|preload/iu)
  })

  it('limits magic links to five per normalized email without changing the public response', async () => {
    let forwarded = 0
    const auth: Authenticator = {
      authenticate: async () => null,
      handleWebRequest: async () => {
        forwarded += 1
        return Response.json({ status: true })
      },
    }
    const isolated = await createApp({ ...dependencies(), auth }, { publicOrigin: ORIGIN, serviceOrigin: 'https://api.example.test' })
    const bodies: string[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await isolated.inject({
        method: 'POST', url: '/api/auth/sign-in/magic-link', headers: { origin: ORIGIN },
        payload: { email: attempt % 2 === 0 ? ' Learner@Example.test ' : 'learner@example.test' },
      })
      assert.equal(response.statusCode, 200)
      bodies.push(response.body)
    }
    await isolated.close()
    assert.equal(forwarded, 5)
    assert.equal(new Set(bodies).size, 1)
    assert.deepEqual(JSON.parse(bodies[5]!), { status: true })
  })

  it('keeps account data and identity when provider revocation fails', async () => {
    const sync = new InMemorySyncStore(AUDITED_MEMORY_OPTIONS)
    await sync.sync('revocation-user', { deviceId: DEVICE_ID, cursor: null, events: [reviewEvent()] }, NOW)
    const connections: ExternalConnectionService = {
      beginLichess: async () => ({ authorizationUrl: 'https://lichess.org/oauth' }),
      completeLichess: async () => undefined,
      disconnectLichess: async () => undefined,
      revokeForAccountDeletion: async () => { throw new ApiError(503, 'provider_revocation_failed', 'Provider revocation failed') },
    }
    const isolated = await createApp({ ...dependencies(), sync, connections }, { publicOrigin: ORIGIN })
    const response = await isolated.inject({
      method: 'DELETE', url: '/v1/account',
      headers: { origin: ORIGIN, 'x-linerecall-user': 'revocation-user' },
    })
    await isolated.close()
    assert.equal(response.statusCode, 503)
    assert.equal((await sync.bootstrap('revocation-user', 0n, 250, NOW)).cards.length, 1)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DisabledExternalConnectionService,
  DisabledLichessSyncService,
  HeaderAuthenticator,
  InMemoryRateLimiter,
  InMemoryRepertoireService,
  InMemorySyncStore,
  StaticCatalogService,
} from '../src/adapters/memory.js'
import { ApiError } from '../src/errors.js'
import { DEVICE_ID, NOW, reviewEvent, tacticalPuzzle } from './helpers.js'

describe('local adapter failure semantics', () => {
  it('resets fixed rate windows and rejects overflow', async () => {
    const limiter = new InMemoryRateLimiter()
    assert.equal((await limiter.consume('key', 2, 1_000, NOW)).allowed, true)
    assert.equal((await limiter.consume('key', 2, 1_000, NOW)).remaining, 0)
    assert.equal((await limiter.consume('key', 2, 1_000, NOW)).allowed, false)
    assert.equal((await limiter.consume('key', 2, 1_000, new Date(NOW.getTime() + 1_001))).allowed, true)
  })

  it('keeps development header authentication explicitly disabled and bounded', async () => {
    assert.equal(await new HeaderAuthenticator(false).authenticate({ 'x-linerecall-user': 'user' }), null)
    const enabled = new HeaderAuthenticator(true, () => NOW)
    assert.equal(await enabled.authenticate({ 'x-linerecall-user': '<script>' }), null)
    assert.equal((await enabled.authenticate({ 'x-linerecall-user': 'valid_user' }))?.authTime.toISOString(), NOW.toISOString())
  })

  it('paginates static puzzles and queues no fabricated analysis result', async () => {
    const puzzles = [tacticalPuzzle('Puzzle001'), tacticalPuzzle('Puzzle002'), tacticalPuzzle('Puzzle003')]
    const catalog = new StaticCatalogService(undefined, puzzles)
    assert.deepEqual(await catalog.listPuzzles({ limit: 2 }), { items: puzzles.slice(0, 2), nextCursor: '2' })
    assert.deepEqual(await catalog.listPuzzles({ limit: 2, cursor: '2' }), { items: puzzles.slice(2), nextCursor: null })
    assert.deepEqual(await catalog.listPuzzles({ limit: 1, cursor: 'not-a-cursor' }), { items: puzzles.slice(0, 1), nextCursor: '1' })
    assert.throws(() => new StaticCatalogService(undefined, [puzzles[0], puzzles[0]]), /Duplicate puzzle ID/u)
    assert.throws(() => new StaticCatalogService(undefined, [{ id: 1 }]))
    const repertoires = new InMemoryRepertoireService()
    const job = await repertoires.createImport('user', { name: 'name', pgn: '*', side: 'white' }, NOW) as { id: string; status: string }
    assert.equal(job.status, 'queued')
    assert.equal(await repertoires.getImport('other', job.id), null)
  })

  it('enforces repertoire ownership, ETags, and share expiry/revocation', async () => {
    const service = new InMemoryRepertoireService()
    const created = await service.update('owner', 'rep', '"0"', {}, NOW) as { revisionId: string }
    await assert.rejects(() => service.update('owner', 'rep', '"0"', {}, NOW), (error: unknown) => error instanceof ApiError && error.code === 'revision_conflict')
    await assert.rejects(() => service.update('other', 'rep', '"1"', {}, NOW), (error: unknown) => error instanceof ApiError && error.code === 'not_found')
    const share = await service.createShare('owner', 'rep', { revisionId: created.revisionId, expiresAt: '2026-07-14T12:01:00Z' }, NOW)
    assert.ok(await service.resolveShare(share.token, NOW))
    assert.equal(await service.resolveShare(share.token, new Date('2026-07-14T12:02:00Z')), null)
    assert.equal(await service.revokeShare('other', share.id, NOW), false)
    assert.equal(await service.revokeShare('owner', share.id, NOW), true)
    assert.equal(await service.resolveShare(share.token, NOW), null)
  })

  it('rejects invalid time zones and stale grade corrections', async () => {
    const store = new InMemorySyncStore()
    await assert.rejects(
      () => store.sync('user', { deviceId: DEVICE_ID, cursor: null, events: [reviewEvent({ timeZone: 'Not/A_Zone' })] }, NOW),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_time_zone',
    )
    const first = reviewEvent()
    const second = reviewEvent({ eventId: '0198a5c0-2000-7000-8000-000000000003', occurredAt: '2026-07-14T11:56:00Z' })
    await store.sync('user', { deviceId: DEVICE_ID, cursor: null, events: [first, second] }, NOW)
    const result = await store.sync('user', {
      deviceId: DEVICE_ID, cursor: null,
      events: [reviewEvent({ eventId: '0198a5c0-3000-7000-8000-000000000004', correctsEventId: first.eventId })],
    }, NOW)
    assert.equal(result.rejectedEvents[0]?.code, 'invalid_correction')
    await store.deleteAccount('missing-user', NOW)
  })

  it('keeps external connections visibly disabled when not configured', async () => {
    const disabled = new DisabledExternalConnectionService()
    await assert.rejects(() => disabled.beginLichess(), (error: unknown) => error instanceof ApiError && error.code === 'provider_not_configured')
    await assert.rejects(() => disabled.completeLichess(), ApiError)
    await assert.rejects(() => disabled.disconnectLichess(), ApiError)
    await disabled.revokeForAccountDeletion()

    const sync = new DisabledLichessSyncService()
    await assert.rejects(
      () => sync.request(),
      (error: unknown) => error instanceof ApiError && error.code === 'lichess_sync_not_configured',
    )
    assert.deepEqual(await sync.status(), {
      available: false,
      unavailableReason: 'not_configured',
      connected: false,
      consentedAt: null,
      lastSyncedAt: null,
      job: null,
    })
  })
})

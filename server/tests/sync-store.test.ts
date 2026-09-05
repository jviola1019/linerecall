import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InMemorySyncStore } from '../src/adapters/memory.js'
import { ApiError } from '../src/errors.js'
import { AUDITED_MEMORY_OPTIONS, DEVICE_ID, NOW, reviewEvent } from './helpers.js'

describe('InMemorySyncStore', () => {
  it('accepts, idempotently retries, and isolates user state', async () => {
    const store = new InMemorySyncStore(AUDITED_MEMORY_OPTIONS)
    const input = { deviceId: DEVICE_ID, cursor: null, events: [reviewEvent()] }
    const first = await store.sync('user-a', input, NOW)
    const retry = await store.sync('user-a', input, NOW)
    const other = await store.bootstrap('user-b', 0n, 250, NOW)
    assert.deepEqual(first.acceptedEventIds, [reviewEvent().eventId])
    assert.equal(first.cards[0]?.intervalDays, 1)
    assert.deepEqual(retry.acceptedEventIds, [reviewEvent().eventId])
    assert.equal(other.cards.length, 0)
  })

  it('rejects immutable-ID conflicts and unsupported snapshots', async () => {
    const store = new InMemorySyncStore(AUDITED_MEMORY_OPTIONS)
    await store.sync('user-a', { deviceId: DEVICE_ID, cursor: null, events: [reviewEvent()] }, NOW)
    const result = await store.sync('user-a', {
      deviceId: DEVICE_ID,
      cursor: null,
      events: [
        reviewEvent({ grade: 'easy' }),
        reviewEvent({ eventId: '0198a5c0-2000-7000-8000-000000000003', snapshotVersion: 'retired' }),
      ],
    }, NOW)
    assert.deepEqual(result.rejectedEvents.map((item) => item.code), ['conflicting_event_id', 'unsupported_snapshot'])
  })

  it('rejects a card identity absent from the signed snapshot graph', async () => {
    const store = new InMemorySyncStore(AUDITED_MEMORY_OPTIONS)
    const result = await store.sync('user-a', {
      deviceId: DEVICE_ID,
      cursor: null,
      events: [reviewEvent({ cardId: 'pack-e4::pos_not-audited', nodeId: 'pos_not-audited' })],
    }, NOW)
    assert.equal(result.acceptedEventIds.length, 0)
    assert.equal(result.rejectedEvents[0]?.code, 'unknown_card_membership')
  })

  it('normalizes clocks over five minutes in the future', async () => {
    const store = new InMemorySyncStore()
    const event = reviewEvent({ occurredAt: '2026-07-14T12:06:00.000Z' })
    const result = await store.sync('user-a', { deviceId: DEVICE_ID, cursor: null, events: [event] }, NOW)
    assert.equal(result.rejectedEvents[0]?.code, 'future_timestamp_normalized')
    assert.equal(result.cards[0]?.lastReviewedAt, NOW.toISOString())
  })

  it('accepts only one correction to the latest review', async () => {
    const store = new InMemorySyncStore()
    const original = reviewEvent()
    await store.sync('user-a', { deviceId: DEVICE_ID, cursor: null, events: [original] }, NOW)
    const correction = reviewEvent({
      eventId: '0198a5c0-2000-7000-8000-000000000003', grade: 'hard', correctsEventId: original.eventId,
    })
    const first = await store.sync('user-a', { deviceId: DEVICE_ID, cursor: null, events: [correction] }, NOW)
    const second = await store.sync('user-a', {
      deviceId: DEVICE_ID,
      cursor: null,
      events: [reviewEvent({
        eventId: '0198a5c0-3000-7000-8000-000000000004', grade: 'easy', correctsEventId: original.eventId,
      })],
    }, NOW)
    assert.equal(first.cards[0]?.easeFactor, 2.36)
    assert.equal(second.rejectedEvents[0]?.code, 'invalid_correction')
  })

  it('enforces optimistic settings versions', async () => {
    const store = new InMemorySyncStore()
    const settings = { locale: 'en-US' as const, theme: 'light' as const, manualPacing: false, reducedMotion: false, boardCoordinates: true }
    await store.sync('user-a', { deviceId: DEVICE_ID, cursor: null, events: [], settingsMutation: { baseVersion: 0, value: settings } }, NOW)
    await assert.rejects(
      () => store.sync('user-a', { deviceId: DEVICE_ID, cursor: null, events: [], settingsMutation: { baseVersion: 0, value: settings } }, NOW),
      (error: unknown) => error instanceof ApiError && error.code === 'settings_version_conflict',
    )
  })

  it('paginates distinct card changes without cursor loss', async () => {
    const store = new InMemorySyncStore()
    await store.sync('user-a', {
      deviceId: DEVICE_ID,
      cursor: null,
      events: [reviewEvent(), reviewEvent({
        eventId: '0198a5c0-2000-7000-8000-000000000003', cardId: 'pack-e4::pos_fedcba9876543210', nodeId: 'pos_fedcba9876543210',
      })],
    }, NOW)
    const page1 = await store.bootstrap('user-a', 0n, 1, NOW)
    const page2 = await store.bootstrap('user-a', BigInt(page1.nextCursor), 1, NOW)
    assert.equal(page1.cards.length, 1)
    assert.equal(page1.hasMore, true)
    assert.equal(page2.cards.length, 1)
    assert.notEqual(page1.cards[0]?.cardId, page2.cards[0]?.cardId)
  })

  it('keeps puzzle attempts idempotent and separate from recall cards', async () => {
    const store = new InMemorySyncStore(AUDITED_MEMORY_OPTIONS)
    const attempt = {
      attemptId: '0198a5c0-4000-7000-8000-000000000005',
      deviceId: DEVICE_ID,
      puzzleId: 'puzzle-001',
      outcome: 'solved' as const,
      incorrectAttempts: 2,
      usedHint: true,
      elapsedMs: 8_765,
      occurredAt: '2026-07-14T11:58:00.000Z',
      snapshotVersion: 'release-2026q2',
    }
    const first = await store.syncPuzzleAttempts('user-puzzle', { deviceId: DEVICE_ID, attempts: [attempt] }, NOW)
    const retry = await store.syncPuzzleAttempts('user-puzzle', { deviceId: DEVICE_ID, attempts: [attempt] }, NOW)
    const recall = await store.bootstrap('user-puzzle', 0n, 250, NOW)
    assert.equal(first.progress[0]?.attempts, 1)
    assert.equal(first.progress[0]?.solved, 1)
    assert.equal(first.progress[0]?.abandoned, 0)
    assert.equal(first.progress[0]?.cleanSolves, 0)
    assert.equal(first.progress[0]?.hintsUsed, 1)
    assert.equal(first.progress[0]?.incorrectMoves, 2)
    assert.equal(first.progress[0]?.totalElapsedMs, 8_765)
    assert.equal(first.progress[0]?.lastElapsedMs, 8_765)
    assert.equal(retry.progress[0]?.attempts, 1)
    assert.equal(recall.cards.length, 0)

    const abandoned = await store.syncPuzzleAttempts('user-puzzle', {
      deviceId: DEVICE_ID,
      attempts: [{
        ...attempt,
        attemptId: '0198a5c0-5000-7000-8000-000000000007',
        outcome: 'abandoned',
        incorrectAttempts: 3,
        usedHint: false,
        elapsedMs: undefined,
        occurredAt: '2026-07-14T11:59:00.000Z',
      }],
    }, NOW)
    assert.equal(abandoned.progress[0]?.attempts, 2)
    assert.equal(abandoned.progress[0]?.solved, 1)
    assert.equal(abandoned.progress[0]?.abandoned, 1)
    assert.equal(abandoned.progress[0]?.incorrectMoves, 5)
    assert.equal(abandoned.progress[0]?.totalElapsedMs, 8_765)
    assert.equal(abandoned.progress[0]?.lastElapsedMs, null)
    const bootstrap = await store.bootstrapPuzzleProgress('user-puzzle', 0n, 1, NOW)
    assert.equal(bootstrap.progress[0]?.puzzleId, 'puzzle-001')
    assert.equal(bootstrap.progress[0]?.attempts, 2)
    assert.equal(bootstrap.nextCursor, bootstrap.progress[0]?.syncSequence)
    assert.equal(bootstrap.hasMore, false)

    const conflict = await store.syncPuzzleAttempts('user-puzzle', {
      deviceId: DEVICE_ID, attempts: [{ ...attempt, outcome: 'abandoned' }],
    }, NOW)
    const unknown = await store.syncPuzzleAttempts('user-puzzle', {
      deviceId: DEVICE_ID,
      attempts: [{ ...attempt, attemptId: '0198a5c0-5000-7000-8000-000000000006', puzzleId: 'not-audited' }],
    }, NOW)
    assert.equal(conflict.rejectedAttempts[0]?.code, 'conflicting_attempt_id')
    assert.equal(unknown.rejectedAttempts[0]?.code, 'unknown_puzzle_membership')
  })
})

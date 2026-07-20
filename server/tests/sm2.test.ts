import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { masteryForInterval, newCard, replayCard, scheduleReview, serializeCard, type StoredReviewEvent } from '../src/domain/sm2.js'
import { NOW, reviewEvent } from './helpers.js'

describe('SM-2 scheduling', () => {
  it('uses 1, 6, and ease-multiplied successful intervals', () => {
    const first = scheduleReview(newCard('card', NOW), 'good', NOW, reviewEvent().eventId)
    const second = scheduleReview(first, 'good', new Date('2026-07-15T12:00:00Z'), '0198aaf0-1000-7000-8000-000000000003')
    const third = scheduleReview(second, 'good', new Date('2026-07-21T12:00:00Z'), '0198ca00-1000-7000-8000-000000000004')
    assert.deepEqual([first.intervalDays, second.intervalDays, third.intervalDays], [1, 6, 15])
    assert.equal(third.easeFactor, 2.5)
  })

  it('resets a failed card and never lowers ease below 1.3', () => {
    let card = newCard('card', NOW)
    for (let index = 0; index < 20; index += 1) card = scheduleReview(card, 'again', NOW, reviewEvent().eventId)
    assert.equal(card.repetitions, 0)
    assert.equal(card.intervalDays, 1)
    assert.equal(card.easeFactor, 1.3)
  })

  it('uses the documented logarithmic mastery formula', () => {
    assert.equal(masteryForInterval(0, true), 0)
    assert.equal(masteryForInterval(1), 20)
    assert.equal(masteryForInterval(30), 100)
    assert.equal(masteryForInterval(365), 100)
  })

  it('applies a correction at the original review position', () => {
    const original: StoredReviewEvent = {
      ...reviewEvent(), receivedAt: '2026-07-14T12:00:00.000Z',
      normalizedOccurredAt: '2026-07-14T11:55:00.000Z', syncSequence: 1n,
    }
    const correction: StoredReviewEvent = {
      ...reviewEvent({
        eventId: '0198a5c0-2000-7000-8000-000000000003',
        grade: 'hard',
        correctsEventId: original.eventId,
        occurredAt: '2026-07-14T12:01:00.000Z',
      }),
      receivedAt: '2026-07-14T12:01:00.000Z', normalizedOccurredAt: '2026-07-14T12:01:00.000Z', syncSequence: 2n,
    }
    const serialized = serializeCard(replayCard(original.cardId, [original, correction], NOW), 2n)
    assert.equal(serialized.easeFactor, 2.36)
    assert.equal(serialized.lastEventId, correction.eventId)
    assert.equal(serialized.lastReviewedAt, original.occurredAt)
  })
})

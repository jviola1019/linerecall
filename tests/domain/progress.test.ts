import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCard,
  createEmptyProgress,
  defaultReviewGrade,
  enqueueFailedCard,
  localDateKey,
  masteryPercent,
  meanMastery,
  scheduleReview,
  updateReviewStreak,
  updateScopedReviewStreaks,
} from '../../src/domain/progress.ts'

const now = new Date('2026-07-11T12:00:00.000Z')

test('SM-2 uses 1 day, 6 days, then the prior interval times ease', () => {
  const initial = createCard('card', 'line', 'node', now)
  const first = scheduleReview(initial, 'good', now).card
  assert.deepEqual({ repetitions: first.repetitions, interval: first.intervalDays, ease: first.easeFactor }, {
    repetitions: 1,
    interval: 1,
    ease: 2.5,
  })
  const second = scheduleReview(first, 'easy', now).card
  assert.deepEqual({ repetitions: second.repetitions, interval: second.intervalDays, ease: second.easeFactor }, {
    repetitions: 2,
    interval: 6,
    ease: 2.6,
  })
  const third = scheduleReview(second, 'hard', now).card
  assert.deepEqual({ repetitions: third.repetitions, interval: third.intervalDays, ease: third.easeFactor }, {
    repetitions: 3,
    interval: 15,
    ease: 2.46,
  })
})

test('Again resets repetitions, floors ease at 1.3, and repeats at session end', () => {
  const card = { ...createCard('card', 'line', 'node', now), repetitions: 8, intervalDays: 30, easeFactor: 1.3 }
  const result = scheduleReview(card, 'again', now)
  assert.deepEqual(
    { repetitions: result.card.repetitions, interval: result.card.intervalDays, ease: result.card.easeFactor },
    { repetitions: 0, interval: 1, ease: 1.3 },
  )
  assert.equal(result.repeatAtSessionEnd, true)
  assert.deepEqual(enqueueFailedCard(['a', 'card', 'b'], 'card'), ['a', 'b', 'card'])
})

test('default grade follows first-try, hint, playable, and incorrect policy', () => {
  assert.equal(defaultReviewGrade({ incorrectAttempts: 0, usedHint: false, playedPlayableAlternative: false }), 'good')
  assert.equal(defaultReviewGrade({ incorrectAttempts: 0, usedHint: true, playedPlayableAlternative: false }), 'hard')
  assert.equal(defaultReviewGrade({ incorrectAttempts: 0, usedHint: false, playedPlayableAlternative: true }), 'hard')
  assert.equal(defaultReviewGrade({ incorrectAttempts: 1, usedHint: false, playedPlayableAlternative: false }), 'again')
})

test('mastery is logarithmic and opening mastery is the card mean', () => {
  assert.equal(masteryPercent({ repetitions: 0, intervalDays: 0 }), 0)
  assert.equal(masteryPercent({ repetitions: 1, intervalDays: 30 }), 100)
  assert.equal(meanMastery([
    { repetitions: 0, intervalDays: 0 },
    { repetitions: 1, intervalDays: 30 },
  ]), 50)
  assert.equal(meanMastery([]), 0)
  assert.equal(masteryPercent({ repetitions: 1, intervalDays: 365 }), 100)
})

test('streak counts consecutive local dates and ignores backward clock changes', () => {
  const first = updateReviewStreak({ current: 0, lastLocalDate: null }, '2026-03-07')
  const second = updateReviewStreak(first, '2026-03-08')
  assert.deepEqual(second, { current: 2, lastLocalDate: '2026-03-08' })
  assert.deepEqual(updateReviewStreak(second, '2026-03-08'), second)
  assert.deepEqual(updateReviewStreak(second, '2026-03-06'), second)
  assert.deepEqual(updateReviewStreak(second, '2026-03-10'), { current: 1, lastLocalDate: '2026-03-10' })
})

test('opening and trained-side variation streaks advance independently', () => {
  const progress = createEmptyProgress(now)
  const white = 'tax_aaaaaaaaaaaaaaaaaaaaaaaa:white'
  const black = 'tax_aaaaaaaaaaaaaaaaaaaaaaaa:black'
  const first = updateScopedReviewStreaks(progress, white, '2026-07-10')
  const nextProgress = { ...progress, ...first }
  const second = updateScopedReviewStreaks(nextProgress, black, '2026-07-11')
  assert.deepEqual(second.openingStreaks.tax_aaaaaaaaaaaaaaaaaaaaaaaa, {
    current: 2,
    lastLocalDate: '2026-07-11',
  })
  assert.deepEqual(second.variationStreaks[white], { current: 1, lastLocalDate: '2026-07-10' })
  assert.deepEqual(second.variationStreaks[black], { current: 1, lastLocalDate: '2026-07-11' })
  assert.throws(() => updateScopedReviewStreaks(progress, 'unverified-line', '2026-07-11'), /audited variation/u)
})

test('date handling is timezone-aware and rejects impossible or invalid dates', () => {
  assert.equal(localDateKey(new Date('2026-01-01T01:00:00.000Z'), 'America/New_York'), '2025-12-31')
  assert.throws(() => localDateKey(new Date(Number.NaN)), /invalid/u)
  assert.throws(() => updateReviewStreak({ current: 1, lastLocalDate: '2026-01-01' }, 'not-a-date'), /key is invalid/u)
  assert.throws(() => updateReviewStreak({ current: 1, lastLocalDate: '2026-01-01' }, '2026-02-30'), /not a real/u)
})

test('progress creation and scheduling reject invalid state and invalid review clocks', () => {
  const empty = createEmptyProgress(new Date('2026-07-11T00:00:00.000Z'))
  assert.deepEqual(empty.settings, {
    locale: 'en-US',
    theme: 'dark',
    boardOrientation: 'white',
    reducedSound: false,
    reducedMotion: false,
    manualGrading: false,
  })
  assert.deepEqual(empty.openingStreaks, {})
  assert.deepEqual(empty.variationStreaks, {})
  const card = createCard('card', 'line', 'node', now)
  assert.throws(() => scheduleReview(card, 'invalid' as never, now))
  assert.throws(() => scheduleReview(card, 'good', new Date(Number.NaN)), /time is invalid/u)
  assert.throws(() => createCard('', 'line', 'node', now))
})

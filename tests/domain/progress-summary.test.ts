import assert from 'node:assert/strict'
import test from 'node:test'
import type { OpeningSearchEntry } from '../../src/domain/input-validation.ts'
import { createCard, scheduleReview, type CardProgress } from '../../src/domain/progress.ts'
import {
  summarizeProgress,
  type ProgressVariantCatalogEntry,
} from '../../src/domain/progress-summary.ts'

const sourceLineId = 'tax_aaaaaaaaaaaaaaaaaaaaaaaa'
const searchEntries: OpeningSearchEntry[] = [{
  sourceLineId,
  eco: 'C20',
  name: 'King Pawn Game',
  pgn: '1. e4 e5',
  uci: ['e2e4', 'e7e5'],
  terminalEpd: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
  terminalSampleSize: 1_000,
  backtestEligible: true,
  verifiedVariantIds: [`${sourceLineId}:white`, `${sourceLineId}:black`],
}]
const variants: ProgressVariantCatalogEntry[] = [
  { id: `${sourceLineId}:white`, sourceLineId, eco: 'C20', name: 'King Pawn Game', trainedSide: 'white', cardCount: 2 },
  { id: `${sourceLineId}:black`, sourceLineId, eco: 'C20', name: 'King Pawn Game', trainedSide: 'black', cardCount: 1 },
]

function reviewedCard(
  cardId: string,
  lineId: string,
  nodeId: string,
  grade: 'again' | 'hard' | 'good' | 'easy' = 'good',
): CardProgress {
  const created = createCard(cardId, lineId, nodeId, new Date('2026-07-10T12:00:00.000Z'))
  return scheduleReview(created, grade, new Date('2026-07-11T12:00:00.000Z')).card
}

test('opening and trained-side mastery include every unreviewed learner card as zero', () => {
  const card = {
    ...reviewedCard('white-one', `${sourceLineId}:white`, `${sourceLineId}:white:ply-0`),
    repetitions: 1,
    intervalDays: 30,
    dueAt: '2026-08-10T12:00:00.000Z',
  }
  const summary = summarizeProgress([card], variants, searchEntries, new Date('2026-07-12T12:00:00.000Z'))

  assert.equal(summary.openings.length, 1)
  assert.deepEqual(
    {
      name: summary.openings[0]?.name,
      eco: summary.openings[0]?.eco,
      mastery: summary.openings[0]?.mastery,
      reviewed: summary.openings[0]?.reviewedCards,
      due: summary.openings[0]?.dueCards,
      total: summary.openings[0]?.totalCards,
      last: summary.openings[0]?.lastReviewedAt,
    },
    {
      name: 'King Pawn Game',
      eco: 'C20',
      mastery: 33,
      reviewed: 1,
      due: 0,
      total: 3,
      last: '2026-07-11T12:00:00.000Z',
    },
  )
  assert.deepEqual(summary.variations.map((variation) => ({
    side: variation.trainedSide,
    mastery: variation.mastery,
    reviewed: variation.reviewedCards,
    due: variation.dueCards,
    total: variation.totalCards,
  })), [
    { side: 'white', mastery: 50, reviewed: 1, due: 0, total: 2 },
    { side: 'black', mastery: 0, reviewed: 0, due: 0, total: 1 },
  ])
  assert.deepEqual(
    { mastery: summary.mastery, reviewed: summary.reviewedCards, due: summary.dueCards, total: summary.totalCards },
    { mastery: 33, reviewed: 1, due: 0, total: 3 },
  )
})

test('opening and variation summaries expose their persisted consecutive-day streaks', () => {
  const card = reviewedCard(
    `${sourceLineId}:white::${sourceLineId}:white:ply-0`,
    `${sourceLineId}:white`,
    `${sourceLineId}:white:ply-0`,
  )
  const summary = summarizeProgress(
    [card],
    variants,
    searchEntries,
    new Date('2026-07-12T12:00:00.000Z'),
    { [sourceLineId]: { current: 4 } },
    { [`${sourceLineId}:white`]: { current: 2 } },
  )
  assert.equal(summary.openings[0]?.streak, 4)
  assert.equal(summary.variations.find((variation) => variation.trainedSide === 'white')?.streak, 2)
  assert.equal(summary.variations.find((variation) => variation.trainedSide === 'black')?.streak, 0)
})

test('stale and malformed imported line IDs receive explicit safe fallback labels', () => {
  const stale = reviewedCard('stale', `${sourceLineId}:black`, 'old-node')
  const malformed = reviewedCard('malformed', 'legacy-unmapped-line', 'legacy-node', 'again')
  const summary = summarizeProgress(
    [stale, malformed],
    variants.filter((variant) => variant.trainedSide === 'white'),
    searchEntries,
    new Date('2026-07-12T12:00:00.000Z'),
  )

  const staleVariation = summary.variations.find((variation) => variation.id === `${sourceLineId}:black`)
  assert.deepEqual({
    name: staleVariation?.name,
    eco: staleVariation?.eco,
    side: staleVariation?.trainedSide,
    current: staleVariation?.availableInCurrentSnapshot,
  }, {
    name: 'King Pawn Game',
    eco: 'C20',
    side: 'black',
    current: false,
  })
  const unknown = summary.variations.find((variation) => variation.id === 'legacy-unmapped-line')
  assert.deepEqual({
    name: unknown?.name,
    eco: unknown?.eco,
    side: unknown?.trainedSide,
    current: unknown?.availableInCurrentSnapshot,
  }, {
    name: 'Unknown imported opening',
    eco: null,
    side: null,
    current: false,
  })
  assert.equal(summary.openings.some((opening) => opening.name === 'Unknown imported opening'), true)
})

test('duplicate imported cards for one node do not inflate card totals or mastery', () => {
  const older = reviewedCard('older', `${sourceLineId}:white`, `${sourceLineId}:white:ply-0`, 'again')
  const newer = {
    ...reviewedCard('newer', `${sourceLineId}:white`, `${sourceLineId}:white:ply-0`),
    lastReviewedAt: '2026-07-11T13:00:00.000Z',
    intervalDays: 30,
    repetitions: 1,
  }
  const summary = summarizeProgress([older, newer], variants.slice(0, 1), searchEntries, new Date('2026-07-12T12:00:00.000Z'))
  assert.deepEqual(
    {
      reviewed: summary.variations[0]?.reviewedCards,
      total: summary.variations[0]?.totalCards,
      mastery: summary.variations[0]?.mastery,
      last: summary.variations[0]?.lastReviewedAt,
    },
    { reviewed: 1, total: 2, mastery: 50, last: '2026-07-11T13:00:00.000Z' },
  )
  assert.equal(summary.excludedCards, 1)
  assert.throws(() => summarizeProgress([], variants, searchEntries, new Date(Number.NaN)), /time is invalid/u)
})

test('known variants exclude structurally valid but non-semantic imported node IDs', () => {
  const valid = reviewedCard(
    'valid',
    `${sourceLineId}:white`,
    `${sourceLineId}:white:ply-0`,
  )
  const wrongPly = {
    ...reviewedCard(
      'wrong-ply',
      `${sourceLineId}:white`,
      `${sourceLineId}:white:ply-1`,
    ),
    intervalDays: 30,
    repetitions: 1,
    dueAt: '2000-01-01T00:00:00.000Z',
  }
  const arbitrary = {
    ...reviewedCard('arbitrary', `${sourceLineId}:white`, 'plausible-imported-node'),
    intervalDays: 30,
    repetitions: 1,
    dueAt: '2000-01-01T00:00:00.000Z',
  }
  const summary = summarizeProgress(
    [valid, wrongPly, arbitrary],
    variants.slice(0, 1),
    searchEntries,
    new Date('2026-07-12T12:00:00.000Z'),
  )

  assert.deepEqual({
    reviewed: summary.reviewedCards,
    due: summary.dueCards,
    mastery: summary.mastery,
    excluded: summary.excludedCards,
  }, {
    reviewed: 1,
    due: 1,
    mastery: 10,
    excluded: 2,
  })
})

test('graph-pack cards resolve to their canonical opening family and exact learner nodes', () => {
  const packId = 'caro_kann_black_core'
  const reviewedNodeId = 'pos_1111111111111111'
  const unreviewedNodeId = 'pos_2222222222222222'
  const card = reviewedCard(
    `${packId}::${reviewedNodeId}`,
    packId,
    reviewedNodeId,
  )
  const familyCatalog: ProgressVariantCatalogEntry[] = [{
    id: packId,
    openingId: 'caro-kann',
    openingName: 'Caro–Kann',
    sourceLineId: null,
    eco: 'B10–B19',
    name: 'Caro–Kann · Black pack 1',
    trainedSide: 'black',
    cardCount: 2,
    nodeIds: [reviewedNodeId, unreviewedNodeId],
  }]

  const summary = summarizeProgress(
    [card],
    familyCatalog,
    searchEntries,
    new Date('2026-07-12T12:00:00.000Z'),
  )

  assert.deepEqual(summary.openings.map(({ id, sourceLineId: source, name, totalCards, reviewedCards }) => ({
    id,
    source,
    name,
    totalCards,
    reviewedCards,
  })), [{
    id: 'caro-kann',
    source: null,
    name: 'Caro–Kann',
    totalCards: 2,
    reviewedCards: 1,
  }])
  assert.deepEqual(summary.variations.map(({ id, openingId, name, trainedSide, availableInCurrentSnapshot }) => ({
    id,
    openingId,
    name,
    trainedSide,
    availableInCurrentSnapshot,
  })), [{
    id: packId,
    openingId: 'caro-kann',
    name: 'Caro–Kann · Black pack 1',
    trainedSide: 'black',
    availableInCurrentSnapshot: true,
  }])
})

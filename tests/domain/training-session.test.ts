import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess } from 'chess.js'
import { buildPositionGraph } from '../../src/domain/deviation.ts'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import { createCard } from '../../src/domain/progress.ts'
import {
  completeTrainingReview,
  createTrainingSession,
  submitTrainingMove,
  useHint,
} from '../../src/domain/training-session.ts'
import type { MoveEvidence, PositionNode, VerifiedLine } from '../../src/domain/opening-data.ts'

function bands(): MoveEvidence['bands'] {
  return ['<1800', '1800-1999', '2000-2199', '2200-2399', '2400+'].map((band) => ({
    band: band as MoveEvidence['bands'][number]['band'], n: 100,
    whiteWins: 40, draws: 30, blackWins: 30, wins: 40, losses: 30,
    winRate: 40, drawRate: 30, lossRate: 30, lowSample: false,
  }))
}

function node(id: string, ply: number, fen: string, expected: string, next: string | null): PositionNode {
  const san = new Chess(fen).move({ from: expected.slice(0, 2) as never, to: expected.slice(2, 4) as never }).san
  return {
    id, ply, epd: normalizedEpd(new Chess(fen)), fen, sideToMove: 'white', expectedMoveUci: expected,
    nextNodeId: next, equivalentPositionLineIds: ['tax_000000000000000000000000'],
    moves: [{
      uci: expected, san, classification: 'book', expected: true, acceptedBookTransposition: false,
      sampleSize: 500, bands: bands(), centipawnLoss: 0, score: { kind: 'centipawn', value: 10 },
      principalVariationUci: [expected], independentlyEngineAnalyzed: true,
    }],
    engine: {
      engineRef: 'engine_0123456789abcdef', bestMoveUci: expected, bestScore: { kind: 'centipawn', value: 10 },
      expectedMoveCentipawnLoss: 0, topVariations: [{ multipv: 1, depth: 10, selectiveDepth: 12, nodes: 250000, score: { kind: 'centipawn', value: 10 }, bound: 'exact', movesUci: [expected] }],
      analyzedAt: '2026-07-11T00:00:00.000Z', quarantined: false, quarantineReasons: [],
    },
    provenanceRef: 'prov_0123456789abcdef',
  }
}

const afterE4E5 = new Chess()
afterE4E5.move('e4'); afterE4E5.move('e5')
const first = node('line:ply-0', 0, new Chess().fen(), 'e2e4', 'line:ply-2')
const second = node('line:ply-2', 2, afterE4E5.fen(), 'g1f3', null)
const line = {
  id: 'line', sourceLineId: 'tax_000000000000000000000000', drillEligible: true,
  uci: ['e2e4', 'e7e5', 'g1f3'], nodes: [first, second],
} as Pick<VerifiedLine, 'id' | 'sourceLineId' | 'drillEligible' | 'uci' | 'nodes'>
const graph = buildPositionGraph([line])

const firstWithAlternatives = {
  ...first,
  moves: [
    ...first.moves,
    {
      ...first.moves[0]!, uci: 'd2d4', san: 'd4', expected: false,
      classification: 'playable' as const, centipawnLoss: 20,
    },
    {
      ...first.moves[0]!, uci: 'c2c4', san: 'c4', expected: false,
      classification: 'mistake' as const, centipawnLoss: 120,
    },
  ],
}
const lineWithAlternatives = { ...line, nodes: [firstWithAlternatives, second] }

test('first-try book recall suggests Good and auto-plays the opponent move', () => {
  let state = createTrainingSession(line)
  state = submitTrainingMove({ state, line, graph, moveUci: 'e2e4' })
  assert.equal(state.suggestedGrade, 'good')
  const completed = completeTrainingReview({ state, line, existingCard: null, now: new Date('2026-07-11T00:00:00.000Z') })
  assert.equal(completed.state.currentNodeId, second.id)
  assert.equal(completed.state.opponentAutoMoveUci, 'e7e5')
})

test('a hint suggests Hard and an incorrect move suggests Again', () => {
  const hinted = submitTrainingMove({ state: useHint(createTrainingSession(line)), line, graph, moveUci: 'e2e4' })
  assert.equal(hinted.suggestedGrade, 'hard')
  const wrong = submitTrainingMove({ state: createTrainingSession(line), line, graph, moveUci: 'd2d4' })
  assert.equal(wrong.suggestedGrade, 'again')
})

test('Again requeues the failed card at the end and a user can override a grade', () => {
  const answered = submitTrainingMove({ state: createTrainingSession(line), line, graph, moveUci: 'e2e4' })
  const completed = completeTrainingReview({
    state: answered, line, existingCard: null, grade: 'again', now: new Date('2026-07-11T00:00:00.000Z'),
  })
  assert.equal(completed.repeatAtSessionEnd, true)
  assert.deepEqual(completed.state.queue, [second.id, first.id])
})

test('illegal input is announced but does not advance to grading', () => {
  const state = submitTrainingMove({ state: createTrainingSession(line), line, graph, moveUci: 'e2e5' })
  assert.equal(state.phase, 'awaiting_move')
  assert.equal(state.feedback?.reason, 'illegal_move')
})

test('session creation filters due cards, handles empty queues, and rejects quarantined lines', () => {
  assert.deepEqual(createTrainingSession(line, [second.id, 'unknown', second.id]).queue, [second.id])
  assert.equal(createTrainingSession(line, []).phase, 'complete')
  assert.throws(() => createTrainingSession({ ...line, drillEligible: false }), /not eligible/u)
  const complete = createTrainingSession(line, [])
  assert.strictEqual(useHint(complete), complete)
})

test('alternatives without a proven graph continuation require correction and repeat', () => {
  const playable = submitTrainingMove({
    state: createTrainingSession(lineWithAlternatives), line: lineWithAlternatives, graph, moveUci: 'd2d4',
  })
  assert.equal(playable.suggestedGrade, 'again')
  assert.equal(playable.phase, 'awaiting_move')
  const mistake = submitTrainingMove({
    state: createTrainingSession(lineWithAlternatives), line: lineWithAlternatives, graph, moveUci: 'c2c4',
  })
  assert.equal(mistake.suggestedGrade, 'again')
  assert.equal(mistake.phase, 'awaiting_move')
})

test('session transition guards fail closed for stale or missing state', () => {
  const complete = createTrainingSession(line, [])
  assert.throws(() => submitTrainingMove({ state: complete, line, graph, moveUci: 'e2e4' }), /not waiting/u)
  assert.throws(() => submitTrainingMove({
    state: { ...createTrainingSession(line), currentNodeId: 'missing' }, line, graph, moveUci: 'e2e4',
  }), /node is missing/u)
  assert.throws(() => completeTrainingReview({
    state: createTrainingSession(line), line, existingCard: null, now: new Date(),
  }), /no answer/u)

  const answered = submitTrainingMove({ state: createTrainingSession(line), line, graph, moveUci: 'e2e4' })
  assert.throws(() => completeTrainingReview({
    state: { ...answered, currentNodeId: 'missing' }, line, existingCard: null, now: new Date(),
  }), /node is missing/u)
  assert.throws(() => completeTrainingReview({
    state: { ...answered, suggestedGrade: null }, line, existingCard: null, now: new Date(),
  }), /grade is required/u)
})

test('existing cards are updated and a final due card completes the session', () => {
  const state = submitTrainingMove({
    state: createTrainingSession(line, [second.id]), line, graph, moveUci: 'g1f3',
  })
  const existing = createCard(`${line.id}::${second.id}`, line.id, second.id, new Date('2026-07-10T00:00:00.000Z'))
  assert.throws(() => completeTrainingReview({
    state,
    line,
    existingCard: { ...existing, nodeId: first.id },
    grade: 'easy',
    now: new Date('2026-07-11T00:00:00.000Z'),
  }), /identity does not match/u)
  const result = completeTrainingReview({
    state, line, existingCard: existing, grade: 'easy', now: new Date('2026-07-11T00:00:00.000Z'),
  })
  assert.equal(result.card.reviewCount, 1)
  assert.equal(result.appliedGrade, 'easy')
  assert.equal(result.state.phase, 'complete')
  assert.equal(result.state.opponentAutoMoveUci, null)
})

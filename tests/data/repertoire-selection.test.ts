import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess } from 'chess.js'
import { normalizedEpd } from '../../scripts/data/broadcast-pgn.ts'
import {
  buildRepertoireGraph,
  cardIdentityForGraphNode,
  classifyEvidenceMove,
  isProvenTransposition,
  rankLearnerMoves,
  repertoireDepthTier,
  scoreConfidenceInterval,
  selectOpponentCoverage,
  trinomialScoreProfileLikelihoodInterval,
  type EmpiricalMoveEvidence,
} from '../../scripts/data/repertoire-selection.ts'

function candidate(overrides: Partial<EmpiricalMoveEvidence> = {}): EmpiricalMoveEvidence {
  return {
    uci: 'e2e4',
    san: 'e4',
    fromEpd: normalizedEpd(new Chess()),
    toEpd: normalizedEpd(new Chess().move('e4') && new Chess()),
    n: 1_000,
    parentN: 2_000,
    whiteWins: 400,
    draws: 350,
    blackWins: 250,
    trainedSide: 'white',
    engine: { verified: true, centipawnLoss: 10, forcedMateAgainstTrainedSide: false, exactScore: true },
    expected: true,
    coverageAdjustedDepth: 8,
    ...overrides,
  }
}

test('learner ranking follows soundness, depth, coverage, usage, score bound, then UCI', () => {
  const moves = [
    candidate({ uci: 'd2d4', san: 'd4', engine: { verified: true, centipawnLoss: 21, forcedMateAgainstTrainedSide: false, exactScore: true }, coverageAdjustedDepth: 20 }),
    candidate({ uci: 'c2c4', san: 'c4', engine: { verified: true, centipawnLoss: 10, forcedMateAgainstTrainedSide: false, exactScore: true }, coverageAdjustedDepth: 7 }),
    candidate({ uci: 'g1f3', san: 'Nf3', n: 499 }),
    candidate({ uci: 'e2e4', san: 'e4', coverageAdjustedDepth: 9 }),
  ]
  assert.deepEqual(rankLearnerMoves(moves).map(({ move }) => move.uci), ['e2e4', 'c2c4', 'd2d4'])
  assert.equal(classifyEvidenceMove(candidate({ n: 99, expected: false })), 'unverified')
  assert.equal(classifyEvidenceMove(candidate({ expected: false, engine: { verified: true, centipawnLoss: 75, forcedMateAgainstTrainedSide: false, exactScore: true } })), 'inaccuracy')
  assert.equal(classifyEvidenceMove(candidate({ engine: { verified: true, centipawnLoss: 100, forcedMateAgainstTrainedSide: false, exactScore: true } })), 'mistake')
  assert.ok((scoreConfidenceInterval(candidate())?.low ?? 0) < 0.575)
})

test('trinomial profile interval reduces to the binomial likelihood interval when no draws occur', () => {
  const interval = trinomialScoreProfileLikelihoodInterval(60, 0, 40)
  assert.ok(interval)
  const mle = 0.6
  const maximum = 60 * Math.log(mle) + 40 * Math.log(1 - mle)
  const ratio = (probability: number): number => 2 * (
    maximum - 60 * Math.log(probability) - 40 * Math.log(1 - probability)
  )
  const root = (lower: number, upper: number, lowerOutside: boolean): number => {
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const midpoint = (lower + upper) / 2
      const outside = ratio(midpoint) > 3.841458820694124
      if (outside === lowerOutside) lower = midpoint
      else upper = midpoint
    }
    return (lower + upper) / 2
  }
  const expectedLow = root(Number.EPSILON, mle, true)
  const expectedHigh = root(mle, 1 - Number.EPSILON, false)
  assert.ok(Math.abs(interval.low - expectedLow) < 1e-10)
  assert.ok(Math.abs(interval.high - expectedHigh) < 1e-10)
  const drawHeavy = trinomialScoreProfileLikelihoodInterval(25, 50, 25)
  assert.ok(drawHeavy && drawHeavy.low < 0.5 && drawHeavy.high > 0.5)
  assert.deepEqual(trinomialScoreProfileLikelihoodInterval(0, 0, 0), null)
  assert.throws(
    () => trinomialScoreProfileLikelihoodInterval(268_479_805, 0, 0),
    /approved .* evidence bound/iu,
  )
  const upperBound = trinomialScoreProfileLikelihoodInterval(268_479_804, 0, 0)!
  assert.ok(upperBound.low < upperBound.high && upperBound.high === 1)
  const smaller = trinomialScoreProfileLikelihoodInterval(60, 20, 20)!
  const larger = trinomialScoreProfileLikelihoodInterval(600, 200, 200)!
  assert.ok(smaller.low < smaller.high)
  assert.ok(larger.low < larger.high)
  assert.ok(larger.low > smaller.low && larger.high < smaller.high)
})

test('ranking rejects impossible reach, depth, and duplicate-move evidence before sorting', () => {
  assert.throws(() => rankLearnerMoves([candidate({ n: 2_001, parentN: 2_000 })]), /cannot exceed/iu)
  assert.throws(() => rankLearnerMoves([candidate({ coverageAdjustedDepth: Number.NaN })]), /depth/iu)
  assert.throws(() => rankLearnerMoves([candidate(), candidate()]), /Duplicate empirical move UCI/u)
  assert.throws(() => selectOpponentCoverage([candidate({ n: 501, parentN: 500 })], 500), /cannot exceed/iu)
})

test('opponent selection prioritizes coverage while retaining every eligible branch', () => {
  const counts = [1_500, 800, 500, 500, 500]
  const moves = counts.map((n, index) => candidate({
    uci: `a${index + 1}a${index + 2}`,
    n,
    parentN: 3_800,
    whiteWins: Math.floor(n * 0.4),
    draws: Math.floor(n * 0.35),
    blackWins: n - Math.floor(n * 0.4) - Math.floor(n * 0.35),
  }))
  const selection = selectOpponentCoverage(moves, 3_800)
  assert.equal(selection.selected.length, 4)
  assert.equal(selection.extended.length, 1)
  assert.equal(selection.allEligible.length, 5)
  assert.equal(selection.coveredN, 3_300)
  assert.ok(selection.coverage >= 0.85)
  assert.equal(selection.residualN, 500)
  assert.deepEqual(
    [...selection.selected, ...selection.extended].map(({ uci }) => uci),
    selection.allEligible.map(({ uci }) => uci),
  )
  assert.throws(() => selectOpponentCoverage(moves, 3_799), /cannot exceed/iu)
})

test('transpositions require a legal edge reaching the exact canonical successor EPD', () => {
  const start = new Chess()
  const root = normalizedEpd(start)
  start.move('Nf3')
  const afterNf3 = normalizedEpd(start)
  const graph = buildRepertoireGraph([{ uci: 'g1f3', san: 'Nf3', fromEpd: root, toEpd: afterNf3 }])
  assert.equal(isProvenTransposition(graph, root, 'g1f3', afterNf3), true)
  assert.equal(isProvenTransposition(graph, root, 'g1f3', root), false)
  assert.throws(
    () => buildRepertoireGraph([{ uci: 'g1f3', san: 'Nf3', fromEpd: root, toEpd: root }]),
    /reaches/u,
  )
  assert.match(cardIdentityForGraphNode('white_core', afterNf3), /^white_core::pos_[a-f0-9]{16}$/u)
  assert.equal(repertoireDepthTier(6, 2), 'core')
  assert.equal(repertoireDepthTier(5, 4), 'primer')
})

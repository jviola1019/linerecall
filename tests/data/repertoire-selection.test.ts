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

test('opponent selection covers usage deterministically without exceeding four branches', () => {
  const moves = [800, 500, 450, 300, 200].map((n, index) => candidate({ uci: `a${index + 1}a${index + 2}`, n, parentN: 1_500 }))
  const selection = selectOpponentCoverage(moves, 1_500)
  assert.equal(selection.selected.length, 2)
  assert.equal(selection.coveredN, 1_300)
  assert.ok(selection.coverage >= 0.85)
  assert.equal(selection.residualN, 200)
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

import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess } from 'chess.js'
import { buildPositionGraph, evaluateMove } from '../../src/domain/deviation.ts'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import type { MoveEvidence, PositionNode, VerifiedLine } from '../../src/domain/opening-data.ts'

function evidence(
  uci: string,
  classification: MoveEvidence['classification'],
  expected = false,
): MoveEvidence {
  return {
    uci,
    san: uci === 'e2e4' ? 'e4' : uci === 'd2d4' ? 'd4' : 'Nf3',
    classification,
    expected,
    acceptedBookTransposition: classification === 'book' && !expected,
    sampleSize: 100,
    bands: [
      ['<1800', 20], ['1800-1999', 20], ['2000-2199', 20], ['2200-2399', 20], ['2400+', 20],
    ].map(([band, n]) => ({
      band: band as MoveEvidence['bands'][number]['band'], n: n as number,
      whiteWins: 8, draws: 6, blackWins: 6, wins: 8, losses: 6,
      winRate: 40, drawRate: 30, lossRate: 30, lowSample: true,
    })),
    centipawnLoss: classification === 'playable' ? 20 : classification === 'mistake' ? 120 : 0,
    score: { kind: 'centipawn', value: 20 },
    principalVariationUci: [uci],
    independentlyEngineAnalyzed: true,
  }
}

const startEpd = normalizedEpd(new Chess())
const node = {
  id: 'selected:ply-0', ply: 0, epd: startEpd,
  fen: new Chess().fen(), sideToMove: 'white', expectedMoveUci: 'e2e4', nextNodeId: 'selected:ply-2',
  equivalentPositionLineIds: ['source-selected', 'source-reti'],
  moves: [
    evidence('e2e4', 'book', true),
    evidence('d2d4', 'playable'),
    evidence('c2c4', 'inaccuracy'),
    evidence('b2b4', 'mistake'),
    evidence('a2a3', 'unverified_deviation'),
  ],
  engine: {
    engineRef: 'engine_0123456789abcdef', bestMoveUci: 'e2e4', bestScore: { kind: 'centipawn', value: 20 },
    expectedMoveCentipawnLoss: 0, topVariations: [{
      multipv: 1, depth: 10, selectiveDepth: 12, nodes: 250000,
      score: { kind: 'centipawn', value: 20 }, bound: 'exact', movesUci: ['e2e4'],
    }], analyzedAt: '2026-07-11T00:00:00.000Z', quarantined: false, quarantineReasons: [],
  },
  provenanceRef: 'prov_0123456789abcdef',
} satisfies PositionNode

const selected = {
  id: 'selected', sourceLineId: 'source-selected', uci: ['e2e4', 'e7e5', 'g1f3'], nodes: [node],
} as Pick<VerifiedLine, 'id' | 'sourceLineId' | 'uci' | 'nodes'>
const reti = {
  id: 'reti', sourceLineId: 'source-reti', uci: ['g1f3', 'd7d5'], nodes: [],
} as Pick<VerifiedLine, 'id' | 'sourceLineId' | 'uci' | 'nodes'>
const graph = buildPositionGraph([selected, reti])

test('exact book recall continues only the selected repertoire', () => {
  const feedback = evaluateMove({ selectedLine: selected, node, playedMoveUci: 'e2e4', graph })
  assert.equal(feedback.reason, 'exact_book')
  assert.equal(feedback.selectedLineId, 'selected')
  assert.equal(feedback.selectedLineResumeNodeId, 'selected:ply-2')
})

test('playable alternatives retain statistics but do not switch repertoire', () => {
  const feedback = evaluateMove({ selectedLine: selected, node, playedMoveUci: 'd2d4', graph })
  assert.equal(feedback.reason, 'playable_alternative')
  assert.equal(feedback.evidence?.centipawnLoss, 20)
  assert.equal(feedback.selectedLineResumeNodeId, null)
})

test('a move known from another opening remains unverified and does not switch', () => {
  const feedback = evaluateMove({ selectedLine: selected, node, playedMoveUci: 'g1f3', graph })
  assert.equal(feedback.reason, 'known_line_unverified')
  assert.deepEqual(feedback.knownLineIds, ['reti'])
  assert.equal(feedback.selectedLineId, 'selected')
  assert.equal(feedback.selectedLineResumeNodeId, null)
})

test('illegal and unsupported legal moves are distinguished', () => {
  assert.equal(evaluateMove({ selectedLine: selected, node, playedMoveUci: 'e2e5', graph }).reason, 'illegal_move')
  assert.equal(evaluateMove({ selectedLine: selected, node, playedMoveUci: 'h2h3', graph }).reason, 'unsupported_unverified')
})

test('engine-backed deviations preserve each audited classification', () => {
  assert.equal(evaluateMove({ selectedLine: selected, node, playedMoveUci: 'c2c4', graph }).reason, 'engine_inaccuracy')
  assert.equal(evaluateMove({ selectedLine: selected, node, playedMoveUci: 'b2b4', graph }).reason, 'engine_mistake')
  assert.equal(evaluateMove({ selectedLine: selected, node, playedMoveUci: 'a2a3', graph }).reason, 'unsupported_unverified')
})

test('accepted book transpositions may resume only the selected repertoire', () => {
  const afterD4 = new Chess()
  afterD4.move('d4')
  const resumeNode = { ...node, id: 'selected:resume', ply: 2, epd: normalizedEpd(afterD4), fen: afterD4.fen() }
  const acceptedNode = {
    ...node,
    moves: node.moves.map((move) => move.uci === 'd2d4'
      ? { ...move, classification: 'book' as const, acceptedBookTransposition: true }
      : move),
  }
  const line = { ...selected, uci: ['d2d4', 'd7d5', 'c2c4'], nodes: [acceptedNode, resumeNode] }
  const acceptedGraph = buildPositionGraph([line, reti])
  const feedback = evaluateMove({ selectedLine: line, node: acceptedNode, playedMoveUci: 'd2d4', graph: acceptedGraph })
  assert.equal(feedback.reason, 'accepted_book_transposition')
  assert.equal(feedback.selectedLineResumePly, 0)
  assert.equal(feedback.selectedLineResumeNodeId, 'selected:resume')
})

test('a stored book flag cannot turn a3 into the e4 repertoire move without exact graph convergence', () => {
  const contradictoryNode = {
    ...node,
    moves: node.moves.map((move) => move.uci === 'a2a3'
      ? { ...move, classification: 'book' as const, acceptedBookTransposition: true }
      : move),
  }
  const feedback = evaluateMove({
    selectedLine: selected,
    node: contradictoryNode,
    playedMoveUci: 'a2a3',
    graph,
  })

  assert.equal(feedback.playedMoveSan, 'a3')
  assert.equal(feedback.expectedEvidence.san, 'e4')
  assert.equal(feedback.classification, 'unverified_deviation')
  assert.equal(feedback.reason, 'unsupported_unverified')
  assert.equal(feedback.selectedLineResumePly, null)
  assert.equal(feedback.selectedLineResumeNodeId, null)
})

test('even a book-flagged move from another line remains a known but unverified deviation', () => {
  const a3Line = {
    id: 'a3-line', sourceLineId: 'source-a3', uci: ['a2a3', 'e7e5'], nodes: [],
  } as Pick<VerifiedLine, 'id' | 'sourceLineId' | 'uci' | 'nodes'>
  const contradictoryNode = {
    ...node,
    moves: node.moves.map((move) => move.uci === 'a2a3'
      ? { ...move, classification: 'book' as const, acceptedBookTransposition: true }
      : move),
  }
  const feedback = evaluateMove({
    selectedLine: selected,
    node: contradictoryNode,
    playedMoveUci: 'a2a3',
    graph: buildPositionGraph([selected, reti, a3Line]),
  })

  assert.equal(feedback.classification, 'unverified_deviation')
  assert.equal(feedback.reason, 'known_line_unverified')
  assert.deepEqual(feedback.knownLineIds, ['a3-line'])
  assert.equal(feedback.selectedLineResumeNodeId, null)
})

test('unverified engine evidence known from another source remains unverified', () => {
  const a3Line = {
    id: 'a3-unverified-line', sourceLineId: 'source-a3', uci: ['a2a3', 'e7e5'], nodes: [],
  } as Pick<VerifiedLine, 'id' | 'sourceLineId' | 'uci' | 'nodes'>
  const feedback = evaluateMove({
    selectedLine: selected,
    node,
    playedMoveUci: 'a2a3',
    graph: buildPositionGraph([selected, reti, a3Line]),
  })

  assert.equal(feedback.evidence?.classification, 'unverified_deviation')
  assert.equal(feedback.classification, 'unverified_deviation')
  assert.equal(feedback.reason, 'known_line_unverified')
  assert.deepEqual(feedback.knownLineIds, ['a3-unverified-line'])
  assert.equal(feedback.selectedLineResumeNodeId, null)
})

test('graph construction rejects illegal audited lines and feedback requires expected evidence', () => {
  assert.throws(() => buildPositionGraph([{
    id: 'bad', sourceLineId: 'bad-source', uci: ['e2e5'],
  }]), /illegal move/u)
  assert.throws(() => evaluateMove({
    selectedLine: selected,
    node: { ...node, moves: node.moves.filter((move) => !move.expected) },
    playedMoveUci: 'e2e4',
    graph,
  }), /no expected-move evidence/u)
})

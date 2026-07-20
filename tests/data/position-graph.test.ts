import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess } from 'chess.js'
import { positionGraphFromWire } from '../../src/data/position-graph.ts'
import { evaluateMove } from '../../src/domain/deviation.ts'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import type { MoveEvidence, PositionNode, VerifiedLine } from '../../src/domain/opening-data.ts'
import type { WireSearchSnapshot } from '../../src/data/wire.ts'

test('wire graph exposes shared opening moves without replaying or switching lines', () => {
  const search = {
    v: 2,
    g: '2026-07-11T00:00:00.000Z',
    l: [
      ['tax_000000000000000000000001', 'A00', 'One', '1. e4', 'e2e4', 'start epd fields here', 500, 'prov_0000000000000001'],
      ['tax_000000000000000000000002', 'B00', 'Two', '1. e4', 'e2e4', 'start epd fields here', 600, 'prov_0000000000000002'],
    ],
    c: [],
    x: [],
    q: [['start epd fields here', [['e2e4', [1, 0]]]]],
  } as unknown as WireSearchSnapshot
  const graph = positionGraphFromWire(search)
  const edges = graph.edgesByPositionMove.get('start epd fields here\0e2e4')
  assert.deepEqual(edges?.map((edge) => edge.lineId), [
    'tax_000000000000000000000001',
    'tax_000000000000000000000002',
  ])
  assert.ok(edges?.every((edge) => edge.ply === null && edge.afterEpd === null))
  assert.throws(() => positionGraphFromWire({
    ...search,
    q: [['start epd fields here', [['e2e4', [9]]]]],
  }), /unknown line index/u)
})

test('compact graph source IDs resume the selected trained-side repertoire', () => {
  const sourceLineId = 'tax_000000000000000000000001'
  const start = new Chess()
  const epd = normalizedEpd(start)
  const bands: MoveEvidence['bands'] = ['<1800', '1800-1999', '2000-2199', '2200-2399', '2400+'].map((band) => ({
    band: band as MoveEvidence['bands'][number]['band'],
    n: 100,
    whiteWins: 40,
    draws: 30,
    blackWins: 30,
    wins: 40,
    losses: 30,
    winRate: 40,
    drawRate: 30,
    lossRate: 30,
    lowSample: false,
  }))
  const expected: MoveEvidence = {
    uci: 'e2e4',
    san: 'e4',
    classification: 'book',
    expected: true,
    acceptedBookTransposition: false,
    sampleSize: 500,
    bands,
    centipawnLoss: 0,
    score: { kind: 'centipawn', value: 20 },
    principalVariationUci: ['e2e4'],
    independentlyEngineAnalyzed: true,
  }
  const node: PositionNode = {
    id: `${sourceLineId}:white:ply-0`,
    ply: 0,
    epd,
    fen: start.fen(),
    sideToMove: 'white',
    expectedMoveUci: 'e2e4',
    nextNodeId: null,
    equivalentPositionLineIds: [sourceLineId],
    moves: [expected],
    engine: {
      engineRef: 'engine_0123456789abcdef',
      bestMoveUci: 'e2e4',
      bestScore: { kind: 'centipawn', value: 20 },
      expectedMoveCentipawnLoss: 0,
      topVariations: [{
        multipv: 1,
        depth: 10,
        selectiveDepth: 12,
        nodes: 250_000,
        score: { kind: 'centipawn', value: 20 },
        bound: 'exact',
        movesUci: ['e2e4'],
      }],
      analyzedAt: '2026-07-11T00:00:00.000Z',
      quarantined: false,
      quarantineReasons: [],
    },
    provenanceRef: 'prov_0123456789abcdef',
  }
  const line = {
    id: `${sourceLineId}:white`,
    sourceLineId,
    nodes: [node],
  } as Pick<VerifiedLine, 'id' | 'sourceLineId' | 'nodes'>
  const search = {
    v: 2,
    g: '2026-07-11T00:00:00.000Z',
    l: [[sourceLineId, 'A00', 'One', '1. e4', 'e2e4', epd, 500, 'prov_0000000000000001']],
    c: [],
    x: [],
    q: [[epd, [['e2e4', [0]]]]],
  } as unknown as WireSearchSnapshot
  const feedback = evaluateMove({
    selectedLine: line,
    node,
    playedMoveUci: 'e2e4',
    graph: positionGraphFromWire(search),
  })
  assert.equal(feedback.reason, 'exact_book')
  assert.equal(feedback.selectedLineResumePly, 0)
  assert.deepEqual(feedback.knownLineIds, [sourceLineId])
})

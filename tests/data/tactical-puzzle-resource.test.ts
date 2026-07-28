import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import {
  TacticalPuzzleResourceSchema,
  validateTacticalPuzzleRecords,
} from '../../src/data/tactical-puzzle-resource.ts'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import { PuzzleRecordV1Schema, type PuzzleRecord } from '../../src/domain/tactical-puzzles.ts'

function apply(chess: Chess, uci: string): void {
  const promotion = uci[4] as PieceSymbol | undefined
  chess.move({
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    ...(promotion ? { promotion } : {}),
  })
}

function puzzle(puzzleId: string): PuzzleRecord {
  const initialFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
  const chess = new Chess(initialFen)
  apply(chess, 'e7e5')
  const presentationFen = chess.fen()
  const proof = 'pengine_0000000000000001'
  return PuzzleRecordV1Schema.parse({
    version: 1,
    puzzleId,
    initialFen,
    presentationFen,
    movesUci: ['e7e5', 'g1f3'],
    learnerNodes: [{
      learnerIndex: 0,
      solutionMoveIndex: 1,
      fen: presentationFen,
      epd: normalizedEpd(chess),
      expectedMoveUci: 'g1f3',
      forcedReplyUci: null,
      mateInOne: false,
      engineProofRef: proof,
    }],
    rating: 1600,
    ratingDeviation: 70,
    attempts: 1_000,
    popularity: 90,
    themes: ['opening'],
    association: { confidence: 'opening-family', taxonomyLineId: null, openingTag: 'Kings_Pawn' },
    source: {
      id: 'lichess-puzzle-database',
      license: 'CC0-1.0',
      sha256: 'a'.repeat(64),
      retrievedAt: '2026-07-20T12:00:00.000Z',
    },
    engine: { name: 'Stockfish 18', allLearnerNodesVerified: true, proofRefs: [proof] },
  })
}

test('resource schema exposes every explicit tactical data state', () => {
  const record = puzzle('Puzzle1')
  const states = [
    { status: 'disabled', reason: 'No promoted shard.' },
    { status: 'loading' },
    { status: 'ready', puzzles: [record] },
    { status: 'empty', reason: 'No matching puzzles.' },
    { status: 'stale', puzzles: [record], staleAt: '2026-07-20T12:00:00.000Z', reason: 'A newer release is pending.' },
    { status: 'offline', puzzles: [record], reason: 'Using the verified cached shard.' },
    { status: 'rate-limited', retryAt: '2026-07-20T12:01:00.000Z', retryAfterSeconds: 60, reason: 'Try again shortly.' },
    { status: 'corrupt', reason: 'The puzzle shard failed validation.' },
    { status: 'error', reason: 'The puzzle shard could not be loaded.' },
  ]
  for (const state of states) assert.equal(TacticalPuzzleResourceSchema.safeParse(state).success, true)
})

test('ready and stale states reject empty, malformed, and duplicate puzzle collections', () => {
  const record = puzzle('Puzzle1')
  assert.equal(TacticalPuzzleResourceSchema.safeParse({ status: 'ready', puzzles: [] }).success, false)
  assert.equal(TacticalPuzzleResourceSchema.safeParse({
    status: 'stale',
    puzzles: [],
    staleAt: '2026-07-20T12:00:00.000Z',
    reason: 'Stale.',
  }).success, false)
  assert.throws(() => validateTacticalPuzzleRecords([record, structuredClone(record)]), /Duplicate puzzle ID/u)
  assert.throws(() => validateTacticalPuzzleRecords([{ ...record, movesUci: ['e7e4', 'g1f3'] }]))
})

test('rate-limit and error metadata are bounded and strict', () => {
  assert.equal(TacticalPuzzleResourceSchema.safeParse({
    status: 'rate-limited',
    retryAt: 'not-a-date',
    retryAfterSeconds: 0,
    reason: '',
  }).success, false)
  assert.equal(TacticalPuzzleResourceSchema.safeParse({
    status: 'corrupt',
    reason: 'Corrupt.',
    puzzles: [puzzle('Puzzle1')],
  }).success, false)
})

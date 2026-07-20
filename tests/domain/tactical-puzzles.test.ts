import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import {
  PuzzleRecordV1Schema,
  beginTacticalPuzzle,
  playTacticalPuzzleMove,
  useTacticalPuzzleHint,
  type PuzzleRecord,
} from '../../src/domain/tactical-puzzles.ts'

function apply(chess: Chess, uci: string): void {
  const promotion = uci[4] as PieceSymbol | undefined
  chess.move({
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    ...(promotion ? { promotion } : {}),
  })
}

function record(initialFen: string, movesUci: string[], id = 'Puzzle1'): PuzzleRecord {
  const chess = new Chess(initialFen)
  apply(chess, movesUci[0]!)
  const presentationFen = chess.fen()
  const learnerNodes = []
  const proofRefs = []
  for (let moveIndex = 1, learnerIndex = 0; moveIndex < movesUci.length; moveIndex += 2, learnerIndex += 1) {
    const proof = `pengine_${String(learnerIndex + 1).padStart(16, '0')}`
    proofRefs.push(proof)
    const fen = chess.fen()
    const epd = normalizedEpd(chess)
    const expectedMoveUci = movesUci[moveIndex]!
    apply(chess, expectedMoveUci)
    const mateInOne = chess.isCheckmate()
    const forcedReplyUci = movesUci[moveIndex + 1] ?? null
    if (forcedReplyUci) apply(chess, forcedReplyUci)
    learnerNodes.push({
      learnerIndex,
      solutionMoveIndex: moveIndex,
      fen,
      epd,
      expectedMoveUci,
      forcedReplyUci,
      mateInOne,
      engineProofRef: proof,
    })
  }
  return PuzzleRecordV1Schema.parse({
    version: 1,
    puzzleId: id,
    initialFen,
    presentationFen,
    movesUci,
    learnerNodes,
    rating: 1700,
    ratingDeviation: 70,
    attempts: 4_000,
    popularity: 95,
    themes: ['opening', 'tactic'],
    association: { confidence: 'exact-position', taxonomyLineId: null, openingTag: null },
    source: {
      id: 'lichess-puzzle-database',
      license: 'CC0-1.0',
      sha256: 'a'.repeat(64),
      retrievedAt: '2026-07-16T12:00:00.000Z',
    },
    engine: { name: 'Stockfish 18', allLearnerNodesVerified: true, proofRefs },
  })
}

test('setup and forced replies auto-play while learner decisions remain explicit', () => {
  const puzzle = record(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'g1f3', 'b8c6', 'f1b5'],
  )
  const started = beginTacticalPuzzle(puzzle)
  assert.equal(started.fen, puzzle.presentationFen)
  const first = playTacticalPuzzleMove(puzzle, started, 'g1f3')
  assert.equal(first.verdict, 'advanced')
  assert.equal(first.autoPlayedReplyUci, 'b8c6')
  assert.equal(first.state.fen, puzzle.learnerNodes[1]?.fen)
  const solved = playTacticalPuzzleMove(puzzle, first.state, 'f1b5')
  assert.equal(solved.verdict, 'solved')
  assert.equal(solved.grade, 'good')
})

test('incorrect and illegal attempts leave the puzzle position unchanged', () => {
  const puzzle = record(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'g1f3'],
  )
  const started = beginTacticalPuzzle(puzzle)
  const retry = playTacticalPuzzleMove(puzzle, started, 'b1c3')
  assert.equal(retry.verdict, 'retry')
  assert.equal(retry.state.fen, started.fen)
  const illegal = playTacticalPuzzleMove(puzzle, retry.state, 'g1g1')
  assert.equal(illegal.verdict, 'illegal')
  assert.equal(illegal.state.fen, started.fen)
  const solved = playTacticalPuzzleMove(puzzle, illegal.state, 'g1f3')
  assert.equal(solved.grade, 'again')
})

test('mate in one accepts every legal mating move, not only the stored move', () => {
  const puzzle = record(
    '7k/5Q2/6K1/8/8/8/8/r7 b - - 0 1',
    ['a1a2', 'f7e8'],
    'Mate01',
  )
  const result = playTacticalPuzzleMove(puzzle, beginTacticalPuzzle(puzzle), 'f7g7')
  assert.equal(result.verdict, 'solved')
  assert.equal(result.acceptedAlternateMate, true)
  assert.equal(new Chess(result.state.fen).isCheckmate(), true)
})

test('hint use produces Hard without altering the solution position', () => {
  const puzzle = record(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'g1f3'],
  )
  const started = beginTacticalPuzzle(puzzle)
  const hinted = useTacticalPuzzleHint(started)
  assert.equal(hinted.fen, started.fen)
  assert.equal(playTacticalPuzzleMove(puzzle, hinted, 'g1f3').grade, 'hard')
})

test('runtime schema rejects every replay and proof-order inconsistency', () => {
  const base = record(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'g1f3', 'b8c6', 'f1b5'],
  )
  const rejected = (mutate: (copy: PuzzleRecord) => void): void => {
    const copy = structuredClone(base)
    mutate(copy)
    assert.equal(PuzzleRecordV1Schema.safeParse(copy).success, false)
  }
  rejected((copy) => { copy.learnerNodes = copy.learnerNodes.slice(0, 1); copy.engine.proofRefs = copy.engine.proofRefs.slice(0, 1) })
  rejected((copy) => { copy.engine.proofRefs = copy.engine.proofRefs.slice(0, 1) })
  rejected((copy) => { copy.presentationFen = copy.initialFen })
  rejected((copy) => { copy.learnerNodes[0]!.learnerIndex = 1 })
  rejected((copy) => { copy.learnerNodes[0]!.solutionMoveIndex = 3 })
  rejected((copy) => { copy.learnerNodes[0]!.fen = copy.initialFen })
  rejected((copy) => { copy.learnerNodes[0]!.epd = copy.learnerNodes[1]!.epd })
  rejected((copy) => { copy.learnerNodes[0]!.expectedMoveUci = 'b1c3' })
  rejected((copy) => { copy.learnerNodes[0]!.engineProofRef = copy.learnerNodes[1]!.engineProofRef })
  rejected((copy) => { copy.learnerNodes[0]!.mateInOne = true })
  rejected((copy) => { copy.learnerNodes[0]!.forcedReplyUci = null })

  const illegal = structuredClone(base)
  illegal.movesUci[0] = 'e7e4'
  assert.equal(PuzzleRecordV1Schema.safeParse(illegal).success, false)
})

test('schema rejects a forced reply after checkmate and supports legal promotion input', () => {
  const mate = record('7k/5Q2/6K1/8/8/8/8/r7 b - - 0 1', ['a1a2', 'f7e8'], 'Mate02')
  const impossible = structuredClone(mate)
  impossible.movesUci.push('a2a3')
  impossible.learnerNodes[0]!.forcedReplyUci = 'a2a3'
  assert.equal(PuzzleRecordV1Schema.safeParse(impossible).success, false)

  const promotion = record('7k/1P6/6K1/8/8/8/8/r7 b - - 0 1', ['a1a2', 'b7b8q'], 'Promo1')
  const result = playTacticalPuzzleMove(promotion, beginTacticalPuzzle(promotion), 'b7b8q')
  assert.equal(result.verdict, 'solved')
  assert.deepEqual(useTacticalPuzzleHint(result.state), result.state)
  assert.throws(() => playTacticalPuzzleMove(promotion, result.state, 'b7b8q'), /active puzzle/u)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import {
  PuzzleRecordListV1Schema,
  PuzzleRecordV1Schema,
  TacticalPuzzleStateSchema,
  beginTacticalPuzzle,
  playTacticalPuzzleForcedReply,
  playTacticalPuzzleLearnerMove,
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

test('learner and forced-reply transitions can be advanced and animated separately', () => {
  const puzzle = record(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'g1f3', 'b8c6', 'f1b5'],
  )
  const started = beginTacticalPuzzle(puzzle)
  const learner = playTacticalPuzzleLearnerMove(puzzle, started, 'g1f3')
  assert.equal(learner.verdict, 'awaiting-reply')
  assert.equal(learner.transition?.actor, 'learner')
  assert.equal(learner.transition?.moveUci, 'g1f3')
  assert.equal(learner.state.phase, 'forced-reply')
  assert.equal(learner.state.pendingForcedReplyUci, 'b8c6')
  assert.notEqual(learner.state.fen, puzzle.learnerNodes[1]?.fen)
  assert.throws(
    () => playTacticalPuzzleLearnerMove(puzzle, learner.state, 'f1b5'),
    /active learner turn/u,
  )

  const reply = playTacticalPuzzleForcedReply(puzzle, learner.state)
  assert.equal(reply.verdict, 'advanced')
  assert.equal(reply.transition.actor, 'opponent')
  assert.equal(reply.transition.moveUci, 'b8c6')
  assert.equal(reply.transition.fromFen, learner.transition?.toFen)
  assert.equal(reply.state.fen, puzzle.learnerNodes[1]?.fen)
  assert.equal(reply.state.phase, 'learner')
  assert.equal(reply.state.pendingForcedReplyUci, null)
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
  assert.equal(result.state.phase, 'completed')
  assert.deepEqual(useTacticalPuzzleHint(result.state), result.state)
  assert.throws(() => playTacticalPuzzleMove(promotion, result.state, 'b7b8q'), /active puzzle/u)
})

test('puzzle lists reject duplicate publisher IDs without rejecting distinct records', () => {
  const first = record(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'g1f3'],
    'List01',
  )
  const second = record(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'b1c3'],
    'List02',
  )
  assert.equal(PuzzleRecordListV1Schema.safeParse([first, second]).success, true)
  const duplicate = PuzzleRecordListV1Schema.safeParse([first, second, structuredClone(first)])
  assert.equal(duplicate.success, false)
  if (!duplicate.success) {
    assert.deepEqual(duplicate.error.issues[0]?.path, [2, 'puzzleId'])
    assert.match(duplicate.error.issues[0]?.message ?? '', /Duplicate puzzle ID List01/u)
  }
})

test('tactical state schema rejects every contradictory phase payload', () => {
  const puzzle = record(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'g1f3', 'b8c6'],
    'Phase1',
  )
  const learner = beginTacticalPuzzle(puzzle)
  const invalid = [
    { ...learner, completed: true },
    { ...learner, pendingForcedReplyUci: 'b8c6' },
    { ...learner, phase: 'forced-reply' as const, completed: true, pendingForcedReplyUci: 'b8c6' },
    { ...learner, phase: 'forced-reply' as const, pendingForcedReplyUci: null },
    { ...learner, phase: 'completed' as const, completed: false },
    { ...learner, phase: 'completed' as const, completed: true, pendingForcedReplyUci: 'b8c6' },
  ]
  for (const state of invalid) {
    assert.equal(TacticalPuzzleStateSchema.safeParse(state).success, false)
  }
})

test('state-machine guards reject cross-puzzle and unaudited learner positions', () => {
  const puzzle = record(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'g1f3'],
    'Guard1',
  )
  const started = beginTacticalPuzzle(puzzle)
  assert.throws(
    () => playTacticalPuzzleLearnerMove(puzzle, { ...started, puzzleId: 'Other1' }, 'g1f3'),
    /active learner turn/u,
  )
  assert.throws(
    () => playTacticalPuzzleLearnerMove(puzzle, { ...started, learnerIndex: 5 }, 'g1f3'),
    /audited learner node/u,
  )
  assert.throws(
    () => playTacticalPuzzleLearnerMove(puzzle, { ...started, fen: puzzle.initialFen }, 'g1f3'),
    /audited learner node/u,
  )
  assert.throws(
    () => playTacticalPuzzleMove(puzzle, { ...started, puzzleId: 'Other1' }, 'g1f3'),
    /active puzzle/u,
  )
})

test('forced-reply guards fail closed and a terminal reply solves exactly once', () => {
  const puzzle = record(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'g1f3', 'b8c6'],
    'Reply1',
  )
  const learner = playTacticalPuzzleLearnerMove(puzzle, beginTacticalPuzzle(puzzle), 'g1f3')
  assert.equal(learner.verdict, 'awaiting-reply')
  assert.throws(
    () => playTacticalPuzzleForcedReply(puzzle, { ...learner.state, puzzleId: 'Other1' }),
    /pending forced reply/u,
  )
  assert.throws(
    () => playTacticalPuzzleForcedReply(puzzle, { ...learner.state, learnerIndex: 5 }),
    /does not match the audited puzzle node/u,
  )
  assert.throws(
    () => playTacticalPuzzleForcedReply(puzzle, { ...learner.state, pendingForcedReplyUci: 'g8f6' }),
    /does not match the audited puzzle node/u,
  )
  assert.throws(
    () => playTacticalPuzzleForcedReply(puzzle, { ...learner.state, fen: puzzle.initialFen }),
    /does not follow the audited learner move/u,
  )

  const noReplyPuzzle = record(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'g1f3'],
    'Reply2',
  )
  const noReplyState = {
    ...beginTacticalPuzzle(noReplyPuzzle),
    phase: 'forced-reply' as const,
    pendingForcedReplyUci: 'b8c6',
  }
  assert.throws(
    () => playTacticalPuzzleForcedReply(noReplyPuzzle, noReplyState),
    /does not match the audited puzzle node/u,
  )

  const solved = playTacticalPuzzleForcedReply(puzzle, learner.state)
  assert.equal(solved.verdict, 'solved')
  assert.equal(solved.grade, 'good')
  assert.equal(solved.state.phase, 'completed')
  assert.equal(solved.state.completed, true)
  assert.throws(
    () => playTacticalPuzzleForcedReply(puzzle, solved.state),
    /pending forced reply/u,
  )
})

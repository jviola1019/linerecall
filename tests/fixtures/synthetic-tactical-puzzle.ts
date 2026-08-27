import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import { PuzzleRecordV1Schema, type PuzzleRecord } from '../../src/domain/tactical-puzzles.ts'
import {
  createTestOnlyTrustedTacticalPuzzleResource,
  type TrustedTacticalPuzzleResource,
} from '../../src/data/tactical-puzzle-resource.ts'

function applyMove(chess: Chess, uci: string): void {
  const promotion = uci[4] as PieceSymbol | undefined
  chess.move({
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    ...(promotion ? { promotion } : {}),
  })
}

export function createSyntheticTacticalPuzzle(
  initialFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  movesUci = ['e7e5', 'g1f3', 'b8c6', 'f1b5'],
  puzzleId = 'Puzzle1',
): PuzzleRecord {
  const chess = new Chess(initialFen)
  applyMove(chess, movesUci[0]!)
  const presentationFen = chess.fen()
  const learnerNodes = []
  const proofRefs = []
  for (let moveIndex = 1, learnerIndex = 0; moveIndex < movesUci.length; moveIndex += 2, learnerIndex += 1) {
    const proof = `pengine_${String(learnerIndex + 1).padStart(16, '0')}`
    proofRefs.push(proof)
    const fen = chess.fen()
    const epd = normalizedEpd(chess)
    const expectedMoveUci = movesUci[moveIndex]!
    applyMove(chess, expectedMoveUci)
    const mateInOne = chess.isCheckmate()
    const forcedReplyUci = movesUci[moveIndex + 1] ?? null
    if (forcedReplyUci) applyMove(chess, forcedReplyUci)
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
    puzzleId,
    initialFen,
    presentationFen,
    movesUci,
    learnerNodes,
    rating: 1700,
    ratingDeviation: 70,
    attempts: 4_000,
    popularity: 95,
    themes: ['opening', 'tactic'],
    association: { confidence: 'exact-position', taxonomyLineId: null, openingTag: 'Ruy_Lopez' },
    source: {
      id: 'lichess-puzzle-database',
      license: 'CC0-1.0',
      sha256: 'a'.repeat(64),
      retrievedAt: '2026-07-16T12:00:00.000Z',
    },
    engine: { name: 'Stockfish 18', allLearnerNodesVerified: true, proofRefs },
  })
}

/** Review/test-only resource. It must never be used as release evidence. */
export function createSyntheticPuzzleResource(
  puzzles: readonly PuzzleRecord[],
  options: {
    identity?: string
    status?: 'ready' | 'stale' | 'offline'
    staleAt?: string
    reason?: string
  } = {},
): TrustedTacticalPuzzleResource {
  return createTestOnlyTrustedTacticalPuzzleResource({
    puzzles,
    collectionIdentity: options.identity ?? puzzles.map(({ puzzleId }) => puzzleId).join(':'),
    ...(options.status ? { status: options.status } : {}),
    ...(options.staleAt ? { staleAt: options.staleAt } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  })
}

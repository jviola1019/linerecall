import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { z } from 'zod'

const UciMoveSchema = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u)
const EpdSchema = z.string().min(1).max(128).refine(
  (value) => value.split(/\s+/u).length === 4,
  'EPD must have four fields',
)

function moveInput(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const parsed = UciMoveSchema.parse(uci)
  const promotion = parsed[4] as PieceSymbol | undefined
  return promotion
    ? { from: parsed.slice(0, 2) as Square, to: parsed.slice(2, 4) as Square, promotion }
    : { from: parsed.slice(0, 2) as Square, to: parsed.slice(2, 4) as Square }
}

function applyMove(chess: Chess, uci: string): void {
  if (!chess.move(moveInput(uci))) throw new Error(`Illegal puzzle move ${uci}`)
}

function normalizedEpd(chess: Chess): string {
  const [placement, turn, castling, rawEnPassant] = chess.fen().split(/\s+/u)
  if (!placement || !turn || !castling || !rawEnPassant) throw new Error('chess.js returned an invalid FEN')
  const enPassant = rawEnPassant !== '-' && chess.moves({ verbose: true }).some((candidate) => candidate.isEnPassant())
    ? rawEnPassant
    : '-'
  return `${placement} ${turn} ${castling} ${enPassant}`
}

const TacticalPuzzleLearnerNodeSchema = z.object({
  learnerIndex: z.number().int().min(0).max(4),
  solutionMoveIndex: z.number().int().min(1).max(9),
  fen: z.string().min(1).max(128),
  epd: EpdSchema,
  expectedMoveUci: UciMoveSchema,
  forcedReplyUci: UciMoveSchema.nullable(),
  mateInOne: z.boolean(),
  engineProofRef: z.string().regex(/^pengine_[a-f0-9]{16,64}$/u),
}).strict()

/**
 * Server copy of the public v1 puzzle contract. The connected service validates
 * every content-addressed record before it can be cached or returned.
 */
export const PuzzleRecordV1Schema = z.object({
  version: z.literal(1),
  puzzleId: z.string().regex(/^[A-Za-z0-9]{5,16}$/u),
  initialFen: z.string().min(1).max(128),
  presentationFen: z.string().min(1).max(128),
  movesUci: z.array(UciMoveSchema).min(2).max(11),
  learnerNodes: z.array(TacticalPuzzleLearnerNodeSchema).min(1).max(5),
  rating: z.number().int().min(0).max(5000),
  ratingDeviation: z.number().int().min(0).max(100),
  attempts: z.number().int().min(100),
  popularity: z.number().int().min(80).max(100),
  themes: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)).min(1).max(64),
  association: z.object({
    confidence: z.enum(['exact-position', 'opening-family']),
    taxonomyLineId: z.string().regex(/^tax_[a-f0-9]{24}$/u).nullable(),
    openingTag: z.string().min(1).max(128).nullable(),
  }).strict(),
  source: z.object({
    id: z.literal('lichess-puzzle-database'),
    license: z.literal('CC0-1.0'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    retrievedAt: z.string().datetime({ offset: true }),
  }).strict(),
  engine: z.object({
    name: z.literal('Stockfish 18'),
    allLearnerNodesVerified: z.literal(true),
    proofRefs: z.array(z.string().regex(/^pengine_[a-f0-9]{16,64}$/u)).min(1).max(5),
  }).strict(),
}).strict().superRefine((puzzle, context) => {
  if (puzzle.learnerNodes.length !== Math.ceil((puzzle.movesUci.length - 1) / 2)) {
    context.addIssue({ code: 'custom', path: ['learnerNodes'], message: 'One learner node is required for every learner decision' })
  }
  if (puzzle.engine.proofRefs.length !== puzzle.learnerNodes.length) {
    context.addIssue({ code: 'custom', path: ['engine', 'proofRefs'], message: 'Every learner node requires one engine proof' })
  }
  try {
    const chess = new Chess(puzzle.initialFen)
    applyMove(chess, puzzle.movesUci[0]!)
    if (chess.fen() !== puzzle.presentationFen) {
      context.addIssue({ code: 'custom', path: ['presentationFen'], message: 'Presentation FEN does not follow the setup move' })
    }
    for (let moveIndex = 1, learnerIndex = 0; moveIndex < puzzle.movesUci.length; moveIndex += 2, learnerIndex += 1) {
      const node = puzzle.learnerNodes[learnerIndex]
      if (!node) continue
      if (
        node.learnerIndex !== learnerIndex ||
        node.solutionMoveIndex !== moveIndex ||
        node.fen !== chess.fen() ||
        node.epd !== normalizedEpd(chess) ||
        node.expectedMoveUci !== puzzle.movesUci[moveIndex] ||
        node.engineProofRef !== puzzle.engine.proofRefs[learnerIndex]
      ) {
        context.addIssue({
          code: 'custom',
          path: ['learnerNodes', learnerIndex],
          message: 'Learner node does not match legal solution replay and engine proof order',
        })
      }
      applyMove(chess, puzzle.movesUci[moveIndex]!)
      if (node.mateInOne !== chess.isCheckmate()) {
        context.addIssue({
          code: 'custom',
          path: ['learnerNodes', learnerIndex, 'mateInOne'],
          message: 'Mate-in-one flag does not match the legal position',
        })
      }
      const reply = puzzle.movesUci[moveIndex + 1] ?? null
      if (node.forcedReplyUci !== reply) {
        context.addIssue({
          code: 'custom',
          path: ['learnerNodes', learnerIndex, 'forcedReplyUci'],
          message: 'Forced reply does not match the audited solution',
        })
      }
      if (reply !== null) {
        if (chess.isCheckmate()) {
          context.addIssue({
            code: 'custom',
            path: ['movesUci', moveIndex + 1],
            message: 'A checkmating move cannot have a forced reply',
          })
        } else {
          applyMove(chess, reply)
        }
      }
    }
  } catch {
    context.addIssue({ code: 'custom', path: ['movesUci'], message: 'Puzzle setup or solution contains an illegal move' })
  }
})

export const PuzzleRecordListV1Schema = z.array(PuzzleRecordV1Schema).max(50_000).superRefine((puzzles, context) => {
  const puzzleIds = new Set<string>()
  for (const [index, puzzle] of puzzles.entries()) {
    if (puzzleIds.has(puzzle.puzzleId)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'puzzleId'],
        message: `Duplicate puzzle ID ${puzzle.puzzleId}`,
      })
    }
    puzzleIds.add(puzzle.puzzleId)
  }
})

export type PuzzleRecordV1 = z.infer<typeof PuzzleRecordV1Schema>

import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { z } from 'zod'
import { normalizedEpd } from './input-validation.ts'

const UciMoveSchema = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u)
const EpdSchema = z.string().min(1).max(128).refine((value) => value.split(/\s+/u).length === 4, 'EPD must have four fields')

export const TacticalPuzzleLearnerNodeSchema = z.object({
  learnerIndex: z.number().int().min(0).max(4),
  solutionMoveIndex: z.number().int().min(1).max(9),
  fen: z.string().min(1).max(128),
  epd: EpdSchema,
  expectedMoveUci: UciMoveSchema,
  forcedReplyUci: UciMoveSchema.nullable(),
  mateInOne: z.boolean(),
  engineProofRef: z.string().regex(/^pengine_[a-f0-9]{16,64}$/u),
}).strict()

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
    move(chess, puzzle.movesUci[0]!)
    if (chess.fen() !== puzzle.presentationFen) {
      context.addIssue({ code: 'custom', path: ['presentationFen'], message: 'Presentation FEN does not follow the setup move' })
    }
    for (let moveIndex = 1, learnerIndex = 0; moveIndex < puzzle.movesUci.length; moveIndex += 2, learnerIndex += 1) {
      const node = puzzle.learnerNodes[learnerIndex]
      if (!node) continue
      if (
        node.learnerIndex !== learnerIndex || node.solutionMoveIndex !== moveIndex ||
        node.fen !== chess.fen() || node.epd !== normalizedEpd(chess) ||
        node.expectedMoveUci !== puzzle.movesUci[moveIndex] ||
        node.engineProofRef !== puzzle.engine.proofRefs[learnerIndex]
      ) {
        context.addIssue({ code: 'custom', path: ['learnerNodes', learnerIndex], message: 'Learner node does not match legal solution replay and engine proof order' })
      }
      move(chess, puzzle.movesUci[moveIndex]!)
      if (node.mateInOne !== chess.isCheckmate()) {
        context.addIssue({ code: 'custom', path: ['learnerNodes', learnerIndex, 'mateInOne'], message: 'Mate-in-one flag does not match the legal position' })
      }
      const reply = puzzle.movesUci[moveIndex + 1] ?? null
      if (node.forcedReplyUci !== reply) {
        context.addIssue({ code: 'custom', path: ['learnerNodes', learnerIndex, 'forcedReplyUci'], message: 'Forced reply does not match the audited solution' })
      }
      if (reply !== null) {
        if (chess.isCheckmate()) {
          context.addIssue({ code: 'custom', path: ['movesUci', moveIndex + 1], message: 'A checkmating move cannot have a forced reply' })
        } else {
          move(chess, reply)
        }
      }
    }
  } catch {
    context.addIssue({ code: 'custom', path: ['movesUci'], message: 'Puzzle setup or solution contains an illegal move' })
  }
})

export type PuzzleRecord = z.infer<typeof PuzzleRecordV1Schema>

export const TacticalPuzzleStateSchema = z.object({
  puzzleId: z.string().regex(/^[A-Za-z0-9]{5,16}$/u),
  learnerIndex: z.number().int().min(0).max(5),
  fen: z.string().min(1).max(128),
  incorrectAttempts: z.number().int().nonnegative(),
  usedHint: z.boolean(),
  completed: z.boolean(),
}).strict()

export type TacticalPuzzleState = z.infer<typeof TacticalPuzzleStateSchema>

export type TacticalPuzzleMoveResult = {
  verdict: 'advanced' | 'solved' | 'retry' | 'illegal'
  acceptedMoveUci: string | null
  acceptedAlternateMate: boolean
  autoPlayedReplyUci: string | null
  grade: 'again' | 'hard' | 'good' | null
  state: TacticalPuzzleState
}

function input(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const parsed = UciMoveSchema.parse(uci)
  const promotion = parsed[4] as PieceSymbol | undefined
  return promotion
    ? { from: parsed.slice(0, 2) as Square, to: parsed.slice(2, 4) as Square, promotion }
    : { from: parsed.slice(0, 2) as Square, to: parsed.slice(2, 4) as Square }
}

function move(chess: Chess, uci: string): void {
  const applied = chess.move(input(uci))
  if (!applied) throw new Error(`Illegal puzzle move ${uci}`)
}

function validatedPuzzle(inputValue: PuzzleRecord): PuzzleRecord {
  return PuzzleRecordV1Schema.parse(inputValue)
}

export function beginTacticalPuzzle(inputValue: PuzzleRecord): TacticalPuzzleState {
  const puzzle = validatedPuzzle(inputValue)
  return TacticalPuzzleStateSchema.parse({
    puzzleId: puzzle.puzzleId,
    learnerIndex: 0,
    fen: puzzle.presentationFen,
    incorrectAttempts: 0,
    usedHint: false,
    completed: false,
  })
}

export function useTacticalPuzzleHint(stateInput: TacticalPuzzleState): TacticalPuzzleState {
  const state = TacticalPuzzleStateSchema.parse(stateInput)
  if (state.completed) return state
  return { ...state, usedHint: true }
}

/**
 * Grade one learner move without mutating the board on retry. A mate-in-one
 * node accepts any legal mating move; all other nodes require the audited move.
 * The audited opponent reply is then applied automatically.
 */
export function playTacticalPuzzleMove(
  puzzleInput: PuzzleRecord,
  stateInput: TacticalPuzzleState,
  moveUci: string,
): TacticalPuzzleMoveResult {
  const puzzle = validatedPuzzle(puzzleInput)
  const state = TacticalPuzzleStateSchema.parse(stateInput)
  if (state.puzzleId !== puzzle.puzzleId || state.completed) throw new Error('Puzzle state does not belong to an active puzzle')
  const node = puzzle.learnerNodes[state.learnerIndex]
  if (!node || node.fen !== state.fen) throw new Error('Puzzle state is not at its audited learner node')
  const chess = new Chess(state.fen)
  try {
    move(chess, moveUci)
  } catch {
    return {
      verdict: 'illegal',
      acceptedMoveUci: null,
      acceptedAlternateMate: false,
      autoPlayedReplyUci: null,
      grade: null,
      state: { ...state, incorrectAttempts: state.incorrectAttempts + 1 },
    }
  }
  const alternateMate = node.mateInOne && moveUci !== node.expectedMoveUci && chess.isCheckmate()
  if (moveUci !== node.expectedMoveUci && !alternateMate) {
    return {
      verdict: 'retry',
      acceptedMoveUci: null,
      acceptedAlternateMate: false,
      autoPlayedReplyUci: null,
      grade: null,
      state: { ...state, incorrectAttempts: state.incorrectAttempts + 1 },
    }
  }
  let autoPlayedReplyUci: string | null = null
  if (!alternateMate && node.forcedReplyUci !== null) {
    move(chess, node.forcedReplyUci)
    autoPlayedReplyUci = node.forcedReplyUci
  }
  const learnerIndex = state.learnerIndex + 1
  const completed = alternateMate || learnerIndex >= puzzle.learnerNodes.length
  const grade = state.incorrectAttempts > 0 ? 'again' : state.usedHint ? 'hard' : 'good'
  return {
    verdict: completed ? 'solved' : 'advanced',
    acceptedMoveUci: moveUci,
    acceptedAlternateMate: alternateMate,
    autoPlayedReplyUci,
    grade: completed ? grade : null,
    state: TacticalPuzzleStateSchema.parse({
      ...state,
      learnerIndex,
      fen: chess.fen(),
      completed,
    }),
  }
}

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

export const TacticalPuzzleStateSchema = z.object({
  puzzleId: z.string().regex(/^[A-Za-z0-9]{5,16}$/u),
  learnerIndex: z.number().int().min(0).max(5),
  fen: z.string().min(1).max(128),
  incorrectAttempts: z.number().int().nonnegative(),
  usedHint: z.boolean(),
  phase: z.enum(['learner', 'forced-reply', 'completed']),
  pendingForcedReplyUci: UciMoveSchema.nullable(),
  completed: z.boolean(),
}).strict().superRefine((state, context) => {
  if (state.phase === 'learner' && (state.completed || state.pendingForcedReplyUci !== null)) {
    context.addIssue({ code: 'custom', message: 'Learner phase cannot be completed or hold a forced reply' })
  }
  if (state.phase === 'forced-reply' && (state.completed || state.pendingForcedReplyUci === null)) {
    context.addIssue({ code: 'custom', message: 'Forced-reply phase requires one pending reply' })
  }
  if (state.phase === 'completed' && (!state.completed || state.pendingForcedReplyUci !== null)) {
    context.addIssue({ code: 'custom', message: 'Completed phase cannot hold a forced reply' })
  }
})

export type TacticalPuzzleState = z.infer<typeof TacticalPuzzleStateSchema>

export const TacticalPuzzleTransitionSchema = z.object({
  actor: z.enum(['learner', 'opponent']),
  moveUci: UciMoveSchema,
  fromFen: z.string().min(1).max(128),
  toFen: z.string().min(1).max(128),
}).strict()

export type TacticalPuzzleTransition = z.infer<typeof TacticalPuzzleTransitionSchema>

export type TacticalPuzzleLearnerMoveResult = {
  verdict: 'awaiting-reply' | 'solved' | 'retry' | 'illegal'
  acceptedMoveUci: string | null
  acceptedAlternateMate: boolean
  transition: TacticalPuzzleTransition | null
  grade: 'again' | 'hard' | 'good' | null
  state: TacticalPuzzleState
}

export type TacticalPuzzleForcedReplyResult = {
  verdict: 'advanced' | 'solved'
  transition: TacticalPuzzleTransition
  grade: 'again' | 'hard' | 'good' | null
  state: TacticalPuzzleState
}

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
    phase: 'learner',
    pendingForcedReplyUci: null,
    completed: false,
  })
}

export function useTacticalPuzzleHint(stateInput: TacticalPuzzleState): TacticalPuzzleState {
  const state = TacticalPuzzleStateSchema.parse(stateInput)
  if (state.phase !== 'learner') return state
  return { ...state, usedHint: true }
}

function gradeFor(state: TacticalPuzzleState): 'again' | 'hard' | 'good' {
  return state.incorrectAttempts > 0 ? 'again' : state.usedHint ? 'hard' : 'good'
}

/**
 * Apply only the learner transition. A successful result with
 * `verdict: "awaiting-reply"` deliberately stops before the audited opponent
 * reply so visual clients can animate the two transitions independently.
 */
export function playTacticalPuzzleLearnerMove(
  puzzleInput: PuzzleRecord,
  stateInput: TacticalPuzzleState,
  moveUci: string,
): TacticalPuzzleLearnerMoveResult {
  const puzzle = validatedPuzzle(puzzleInput)
  const state = TacticalPuzzleStateSchema.parse(stateInput)
  if (state.puzzleId !== puzzle.puzzleId || state.phase !== 'learner') {
    throw new Error('Puzzle state does not belong to an active learner turn')
  }
  const node = puzzle.learnerNodes[state.learnerIndex]
  if (!node || node.fen !== state.fen) throw new Error('Puzzle state is not at its audited learner node')
  const chess = new Chess(state.fen)
  const fromFen = chess.fen()
  try {
    move(chess, moveUci)
  } catch {
    return {
      verdict: 'illegal',
      acceptedMoveUci: null,
      acceptedAlternateMate: false,
      transition: null,
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
      transition: null,
      grade: null,
      state: { ...state, incorrectAttempts: state.incorrectAttempts + 1 },
    }
  }
  const transition = TacticalPuzzleTransitionSchema.parse({
    actor: 'learner',
    moveUci,
    fromFen,
    toFen: chess.fen(),
  })
  const nextLearnerIndex = state.learnerIndex + 1
  if (!alternateMate && node.forcedReplyUci !== null) {
    return {
      verdict: 'awaiting-reply',
      acceptedMoveUci: moveUci,
      acceptedAlternateMate: false,
      transition,
      grade: null,
      state: TacticalPuzzleStateSchema.parse({
        ...state,
        fen: chess.fen(),
        phase: 'forced-reply',
        pendingForcedReplyUci: node.forcedReplyUci,
      }),
    }
  }
  const completed = alternateMate || nextLearnerIndex >= puzzle.learnerNodes.length
  if (!completed) throw new Error('Audited puzzle is missing the forced reply before its next learner node')
  const completedState = TacticalPuzzleStateSchema.parse({
    ...state,
    learnerIndex: nextLearnerIndex,
    fen: chess.fen(),
    phase: 'completed',
    pendingForcedReplyUci: null,
    completed: true,
  })
  return {
    verdict: 'solved',
    acceptedMoveUci: moveUci,
    acceptedAlternateMate: alternateMate,
    transition,
    grade: gradeFor(completedState),
    state: completedState,
  }
}

/** Apply exactly one audited opponent reply after its learner move. */
export function playTacticalPuzzleForcedReply(
  puzzleInput: PuzzleRecord,
  stateInput: TacticalPuzzleState,
): TacticalPuzzleForcedReplyResult {
  const puzzle = validatedPuzzle(puzzleInput)
  const state = TacticalPuzzleStateSchema.parse(stateInput)
  if (state.puzzleId !== puzzle.puzzleId || state.phase !== 'forced-reply') {
    throw new Error('Puzzle state does not have a pending forced reply')
  }
  const node = puzzle.learnerNodes[state.learnerIndex]
  if (!node || node.forcedReplyUci === null || node.forcedReplyUci !== state.pendingForcedReplyUci) {
    throw new Error('Pending reply does not match the audited puzzle node')
  }
  const expectedPosition = new Chess(node.fen)
  move(expectedPosition, node.expectedMoveUci)
  if (expectedPosition.fen() !== state.fen) throw new Error('Forced-reply state does not follow the audited learner move')
  const chess = new Chess(state.fen)
  const fromFen = chess.fen()
  move(chess, state.pendingForcedReplyUci)
  const transition = TacticalPuzzleTransitionSchema.parse({
    actor: 'opponent',
    moveUci: state.pendingForcedReplyUci,
    fromFen,
    toFen: chess.fen(),
  })
  const learnerIndex = state.learnerIndex + 1
  const completed = learnerIndex >= puzzle.learnerNodes.length
  const nextState = TacticalPuzzleStateSchema.parse({
    ...state,
    learnerIndex,
    fen: chess.fen(),
    phase: completed ? 'completed' : 'learner',
    pendingForcedReplyUci: null,
    completed,
  })
  if (!completed && puzzle.learnerNodes[learnerIndex]?.fen !== nextState.fen) {
    throw new Error('Forced reply does not reach the next audited learner node')
  }
  return {
    verdict: completed ? 'solved' : 'advanced',
    transition,
    grade: completed ? gradeFor(nextState) : null,
    state: nextState,
  }
}

/**
 * Compatibility wrapper for consumers that still expect the opponent reply to
 * be applied atomically. New animation code should call the two phase-specific
 * functions above.
 */
export function playTacticalPuzzleMove(
  puzzleInput: PuzzleRecord,
  stateInput: TacticalPuzzleState,
  moveUci: string,
): TacticalPuzzleMoveResult {
  const compatibilityState = TacticalPuzzleStateSchema.parse(stateInput)
  if (compatibilityState.puzzleId !== puzzleInput.puzzleId || compatibilityState.completed) {
    throw new Error('Puzzle state does not belong to an active puzzle')
  }
  const learnerResult = playTacticalPuzzleLearnerMove(puzzleInput, stateInput, moveUci)
  if (learnerResult.verdict === 'illegal' || learnerResult.verdict === 'retry') {
    return {
      verdict: learnerResult.verdict,
      acceptedMoveUci: null,
      acceptedAlternateMate: false,
      autoPlayedReplyUci: null,
      grade: null,
      state: learnerResult.state,
    }
  }
  if (learnerResult.verdict === 'solved') {
    return {
      verdict: 'solved',
      acceptedMoveUci: learnerResult.acceptedMoveUci,
      acceptedAlternateMate: learnerResult.acceptedAlternateMate,
      autoPlayedReplyUci: null,
      grade: learnerResult.grade,
      state: learnerResult.state,
    }
  }
  const replyResult = playTacticalPuzzleForcedReply(puzzleInput, learnerResult.state)
  return {
    verdict: replyResult.verdict,
    acceptedMoveUci: learnerResult.acceptedMoveUci,
    acceptedAlternateMate: false,
    autoPlayedReplyUci: replyResult.transition.moveUci,
    grade: replyResult.grade,
    state: replyResult.state,
  }
}

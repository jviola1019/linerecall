import { z } from 'zod'
import { applyLegalMove } from './board.ts'
import {
  EcoCodeSchema,
  EngineVariationSchema,
  MoveEvidenceSchema,
  UciMoveSchema,
  type MoveEvidence,
  type VerifiedLine,
} from './opening-data.ts'
import { ReviewGradeSchema, type ReviewGrade } from './progress.ts'

export const OPENING_PUZZLE_LIMITATION =
  'Opening recall only. These positions come from the loaded audited repertoire and stored Stockfish checks. LineRecall does not ship a licensed tactical-puzzle corpus, so they are not labeled as tactics or as proof of best play beyond the stored evidence.'

function validateMoveSequence(fen: string, moves: readonly string[]): void {
  let currentFen = fen
  for (const move of moves) currentFen = applyLegalMove(currentFen, move).fen
}

export const OpeningPuzzleSchema = z.object({
  id: z.string().min(1).max(480),
  lineId: z.string().min(1).max(220),
  sourceLineId: z.string().regex(/^tax_[a-f0-9]{24}$/u),
  eco: EcoCodeSchema,
  openingName: z.string().min(1).max(256),
  trainedSide: z.enum(['white', 'black']),
  nodeId: z.string().min(1).max(240),
  ply: z.number().int().nonnegative().max(200),
  fen: z.string().min(1).max(128),
  expectedMoveUci: UciMoveSchema,
  moves: z.array(MoveEvidenceSchema).min(1).max(128),
  principalVariationUci: z.array(UciMoveSchema).max(256),
  engineVariations: z.array(EngineVariationSchema).min(1).max(5),
  provenanceRef: z.string().regex(/^prov_[a-f0-9]{16}$/u),
}).strict().superRefine((puzzle, context) => {
  const expected = puzzle.moves.filter((move) => move.uci === puzzle.expectedMoveUci && move.expected)
  if (expected.length !== 1 || expected[0]?.classification !== 'book') {
    context.addIssue({ code: 'custom', message: 'Puzzle must contain one expected audited book move', path: ['moves'] })
  }
  try {
    applyLegalMove(puzzle.fen, puzzle.expectedMoveUci)
  } catch {
    context.addIssue({ code: 'custom', message: 'Puzzle solution is not legal in its position', path: ['expectedMoveUci'] })
  }
  for (const [index, move] of puzzle.moves.entries()) {
    try {
      applyLegalMove(puzzle.fen, move.uci)
    } catch {
      context.addIssue({ code: 'custom', message: 'Stored move evidence is not legal in the puzzle position', path: ['moves', index, 'uci'] })
    }
  }
  try {
    validateMoveSequence(puzzle.fen, puzzle.principalVariationUci)
  } catch {
    context.addIssue({ code: 'custom', message: 'The stored repertoire continuation is not a legal move sequence', path: ['principalVariationUci'] })
  }
  for (const [index, variation] of puzzle.engineVariations.entries()) {
    try {
      validateMoveSequence(puzzle.fen, variation.movesUci)
    } catch {
      context.addIssue({ code: 'custom', message: 'A stored engine continuation is not a legal move sequence', path: ['engineVariations', index, 'movesUci'] })
    }
  }
})

export const OpeningPuzzleListSchema = z.array(OpeningPuzzleSchema).max(100)

export type OpeningPuzzle = z.infer<typeof OpeningPuzzleSchema>
export type PuzzleMoveVerdict = 'solved' | 'playable' | 'retry' | 'illegal'
export type PuzzleAutoGrade = Extract<ReviewGrade, 'again' | 'hard' | 'good'>

export interface PuzzleAttemptContext {
  incorrectAttempts: number
  usedHint: boolean
  playedPlayableAlternative: boolean
}

export interface PuzzleMoveResult {
  moveUci: string
  verdict: PuzzleMoveVerdict
  classification: MoveEvidence['classification'] | 'illegal'
  evidence: MoveEvidence | null
  autoGrade: PuzzleAutoGrade | null
  message: string
  nextContext: PuzzleAttemptContext
}

const validatedPuzzleObjects = new WeakSet<OpeningPuzzle>()

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function registerValidatedPuzzle(puzzle: OpeningPuzzle): OpeningPuzzle {
  deepFreeze(puzzle)
  validatedPuzzleObjects.add(puzzle)
  return puzzle
}

export function safeParseOpeningPuzzleList(input: unknown): ReturnType<typeof OpeningPuzzleListSchema.safeParse> {
  const result = OpeningPuzzleListSchema.safeParse(input)
  if (result.success) {
    for (const puzzle of result.data) registerValidatedPuzzle(puzzle)
    Object.freeze(result.data)
  }
  return result
}

function validatedPuzzle(input: OpeningPuzzle): OpeningPuzzle {
  if (validatedPuzzleObjects.has(input)) return input
  return registerValidatedPuzzle(OpeningPuzzleSchema.parse(input))
}

export function createPuzzleAttemptContext(): PuzzleAttemptContext {
  return { incorrectAttempts: 0, usedHint: false, playedPlayableAlternative: false }
}

function gradeForSolvedMove(
  context: PuzzleAttemptContext,
  acceptedAlternative: boolean,
): PuzzleAutoGrade {
  if (context.incorrectAttempts > 0) return ReviewGradeSchema.parse('again') as PuzzleAutoGrade
  if (context.usedHint || context.playedPlayableAlternative || acceptedAlternative) {
    return ReviewGradeSchema.parse('hard') as PuzzleAutoGrade
  }
  return ReviewGradeSchema.parse('good') as PuzzleAutoGrade
}

function evidenceDetail(evidence: MoveEvidence): string {
  const loss = evidence.centipawnLoss === null ? '' : ` Stored difference: ${evidence.centipawnLoss} centipawns.`
  return `${evidence.san} is stored as ${evidence.classification.replaceAll('_', ' ')} with N=${evidence.sampleSize}.${loss}`
}

export function openingPuzzlesFromVerifiedLine(line: VerifiedLine): OpeningPuzzle[] {
  if (!line.drillEligible || line.quarantined) {
    throw new Error('Only an audited, drill-eligible, non-quarantined line can create puzzles')
  }
  const puzzles = line.nodes.map((node) => {
    if (node.sideToMove !== line.trainedSide) {
      throw new Error(`Puzzle node ${node.id} is not a ${line.trainedSide} learner decision`)
    }
    if (node.engine.quarantined) throw new Error(`Puzzle node ${node.id} is quarantined`)
    const expected = node.moves.find((move) => move.uci === node.expectedMoveUci && move.expected)
    return {
      id: `${line.id}::puzzle::${node.id}`,
      lineId: line.id,
      sourceLineId: line.sourceLineId,
      eco: line.eco,
      openingName: line.name,
      trainedSide: line.trainedSide,
      nodeId: node.id,
      ply: node.ply,
      fen: node.fen,
      expectedMoveUci: node.expectedMoveUci,
      moves: node.moves,
      principalVariationUci: expected?.principalVariationUci ?? [],
      engineVariations: node.engine.topVariations,
      provenanceRef: node.provenanceRef,
    }
  })
  const parsed = safeParseOpeningPuzzleList(puzzles)
  if (!parsed.success) throw parsed.error
  return parsed.data
}

export function markPuzzleHintUsed(context: PuzzleAttemptContext): PuzzleAttemptContext {
  return { ...context, usedHint: true }
}

export function gradePuzzleMove(
  puzzleInput: OpeningPuzzle,
  moveUciInput: string,
  contextInput: PuzzleAttemptContext,
): PuzzleMoveResult {
  const puzzle = validatedPuzzle(puzzleInput)
  const context: PuzzleAttemptContext = {
    incorrectAttempts: z.number().int().nonnegative().parse(contextInput.incorrectAttempts),
    usedHint: z.boolean().parse(contextInput.usedHint),
    playedPlayableAlternative: z.boolean().parse(contextInput.playedPlayableAlternative),
  }
  const parsedMove = UciMoveSchema.safeParse(moveUciInput)
  if (!parsedMove.success) {
    return {
      moveUci: moveUciInput,
      verdict: 'illegal',
      classification: 'illegal',
      evidence: null,
      autoGrade: null,
      message: 'That move is not valid UCI move input. The puzzle position did not change.',
      nextContext: { ...context, incorrectAttempts: context.incorrectAttempts + 1 },
    }
  }
  try {
    applyLegalMove(puzzle.fen, parsedMove.data)
  } catch {
    return {
      moveUci: parsedMove.data,
      verdict: 'illegal',
      classification: 'illegal',
      evidence: null,
      autoGrade: null,
      message: `${parsedMove.data} is not legal in this position. The puzzle position did not change.`,
      nextContext: { ...context, incorrectAttempts: context.incorrectAttempts + 1 },
    }
  }

  const evidence = puzzle.moves.find((move) => move.uci === parsedMove.data) ?? null
  const expected = parsedMove.data === puzzle.expectedMoveUci
  const acceptedAlternative = Boolean(evidence?.acceptedBookTransposition)
  if (expected || acceptedAlternative) {
    const autoGrade = gradeForSolvedMove(context, acceptedAlternative)
    const reason = expected
      ? `${evidence?.san ?? parsedMove.data} matches the audited repertoire move.`
      : `${evidence?.san ?? parsedMove.data} is an accepted audited book transposition.`
    return {
      moveUci: parsedMove.data,
      verdict: 'solved',
      classification: 'book',
      evidence,
      autoGrade,
      message: `${reason} Auto-graded ${autoGrade}.`,
      nextContext: context,
    }
  }
  if (evidence?.classification === 'playable') {
    return {
      moveUci: parsedMove.data,
      verdict: 'playable',
      classification: 'playable',
      evidence,
      autoGrade: null,
      message: `${evidenceDetail(evidence)} Try the audited repertoire move.`,
      nextContext: { ...context, playedPlayableAlternative: true },
    }
  }
  if (evidence) {
    return {
      moveUci: parsedMove.data,
      verdict: 'retry',
      classification: evidence.classification,
      evidence,
      autoGrade: null,
      message: `${evidenceDetail(evidence)} Try the audited repertoire move.`,
      nextContext: { ...context, incorrectAttempts: context.incorrectAttempts + 1 },
    }
  }
  return {
    moveUci: parsedMove.data,
    verdict: 'retry',
    classification: 'unverified_deviation',
    evidence: null,
    autoGrade: null,
    message: `${parsedMove.data} is legal, but this audited snapshot has no stored move evidence for it. Try the repertoire move.`,
    nextContext: { ...context, incorrectAttempts: context.incorrectAttempts + 1 },
  }
}

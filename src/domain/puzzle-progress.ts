import { z } from 'zod'

const PuzzleIdSchema = z.string().regex(/^[A-Za-z0-9]{5,16}$/u)

export const PuzzleAttemptEventV1Schema = z.object({
  eventId: z.string().uuid(),
  puzzleId: PuzzleIdSchema,
  occurredAt: z.string().datetime({ offset: true }),
  outcome: z.enum(['solved', 'abandoned']),
  incorrectAttempts: z.number().int().nonnegative().max(10_000),
  usedHint: z.boolean(),
}).strict()

export const PuzzleProgressEntryV1Schema = z.object({
  puzzleId: PuzzleIdSchema,
  attempts: z.number().int().nonnegative(),
  solves: z.number().int().nonnegative(),
  cleanSolves: z.number().int().nonnegative(),
  hintsUsed: z.number().int().nonnegative(),
  incorrectMoves: z.number().int().nonnegative(),
  lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
}).strict().superRefine((entry, context) => {
  if (entry.solves > entry.attempts || entry.cleanSolves > entry.solves || entry.hintsUsed > entry.attempts) {
    context.addIssue({ code: 'custom', message: 'Puzzle progress totals do not reconcile' })
  }
})

export const PuzzleProgressV1Schema = z.object({
  version: z.literal(1),
  updatedAt: z.string().datetime({ offset: true }),
  /** Separate namespace: these entries never enter opening recall cards. */
  puzzles: z.record(PuzzleIdSchema, PuzzleProgressEntryV1Schema),
  appliedEventIds: z.array(z.string().uuid()).max(100_000),
}).strict().superRefine((progress, context) => {
  for (const [puzzleId, entry] of Object.entries(progress.puzzles)) {
    if (entry.puzzleId !== puzzleId) {
      context.addIssue({ code: 'custom', path: ['puzzles', puzzleId], message: 'Puzzle map key must equal puzzleId' })
    }
  }
  if (new Set(progress.appliedEventIds).size !== progress.appliedEventIds.length) {
    context.addIssue({ code: 'custom', path: ['appliedEventIds'], message: 'Applied puzzle event IDs must be unique' })
  }
})

export type PuzzleAttemptEventV1 = z.infer<typeof PuzzleAttemptEventV1Schema>
export type PuzzleProgress = z.infer<typeof PuzzleProgressV1Schema>
export type PuzzleProgressEntry = z.infer<typeof PuzzleProgressEntryV1Schema>

export interface PuzzleProgressRepository {
  readonly kind: 'artifact' | 'cloud' | 'memory'
  load(): Promise<PuzzleProgress | null>
  save(progress: PuzzleProgress): Promise<void>
  clear(): Promise<void>
}

export function createEmptyPuzzleProgress(now = new Date()): PuzzleProgress {
  if (Number.isNaN(now.getTime())) throw new Error('Puzzle progress time is invalid')
  return PuzzleProgressV1Schema.parse({
    version: 1,
    updatedAt: now.toISOString(),
    puzzles: {},
    appliedEventIds: [],
  })
}

/** Idempotently apply a puzzle event without touching opening-recall mastery. */
export function applyPuzzleAttemptEvent(
  progressInput: PuzzleProgress,
  eventInput: PuzzleAttemptEventV1,
): PuzzleProgress {
  const progress = PuzzleProgressV1Schema.parse(progressInput)
  const event = PuzzleAttemptEventV1Schema.parse(eventInput)
  if (progress.appliedEventIds.includes(event.eventId)) return progress
  const previous = progress.puzzles[event.puzzleId] ?? {
    puzzleId: event.puzzleId,
    attempts: 0,
    solves: 0,
    cleanSolves: 0,
    hintsUsed: 0,
    incorrectMoves: 0,
    lastAttemptAt: null,
  }
  const solved = event.outcome === 'solved'
  const clean = solved && event.incorrectAttempts === 0 && !event.usedHint
  const entry = PuzzleProgressEntryV1Schema.parse({
    ...previous,
    attempts: previous.attempts + 1,
    solves: previous.solves + (solved ? 1 : 0),
    cleanSolves: previous.cleanSolves + (clean ? 1 : 0),
    hintsUsed: previous.hintsUsed + (event.usedHint ? 1 : 0),
    incorrectMoves: previous.incorrectMoves + event.incorrectAttempts,
    lastAttemptAt: event.occurredAt,
  })
  return PuzzleProgressV1Schema.parse({
    ...progress,
    updatedAt: event.occurredAt,
    puzzles: { ...progress.puzzles, [event.puzzleId]: entry },
    appliedEventIds: [...progress.appliedEventIds, event.eventId],
  })
}

/** Three clean solves reach 100%; abandoned or hinted attempts do not. */
export function puzzleMasteryPercent(entryInput: PuzzleProgressEntry): number {
  const entry = PuzzleProgressEntryV1Schema.parse(entryInput)
  return Math.min(100, Math.round((entry.cleanSolves / 3) * 100))
}

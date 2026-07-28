import {
  PuzzleProgressV1Schema,
  applyPuzzleAttemptEvent,
  createEmptyPuzzleProgress,
  type PuzzleAttemptEventV1,
  type PuzzleProgress,
  type PuzzleProgressRepository,
} from '../domain/puzzle-progress.ts'

/**
 * Session-only adapter used when neither account sync nor Artifact storage is
 * available. Values are cloned at the boundary so callers cannot mutate saved
 * progress without a validated repository write.
 */
export class MemoryPuzzleProgressRepository implements PuzzleProgressRepository {
  readonly kind = 'memory' as const
  #value: PuzzleProgress | null

  constructor(initial: PuzzleProgress | null = null) {
    this.#value = initial === null ? null : structuredClone(PuzzleProgressV1Schema.parse(initial))
  }

  async load(): Promise<PuzzleProgress | null> {
    return this.#value === null ? null : structuredClone(this.#value)
  }

  async save(progress: PuzzleProgress): Promise<void> {
    this.#value = structuredClone(PuzzleProgressV1Schema.parse(progress))
  }

  async clear(): Promise<void> {
    this.#value = null
  }
}

/**
 * Idempotently records one attempt through the repository boundary. Puzzle
 * progress remains entirely separate from the opening-recall repository.
 */
export async function persistPuzzleAttempt(
  repository: PuzzleProgressRepository,
  event: PuzzleAttemptEventV1,
): Promise<PuzzleProgress> {
  const current = await repository.load() ?? createEmptyPuzzleProgress(new Date(event.occurredAt))
  const next = applyPuzzleAttemptEvent(current, event)
  if (next !== current) await repository.save(next)
  return next
}

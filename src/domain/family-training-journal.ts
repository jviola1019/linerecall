import {
  FamilyCoverageEventV1Schema,
  FamilyIdSchema,
  FamilyReleaseIdSchema,
  FamilyTrainingCursorV1Schema,
  type FamilyCoverageEventV1,
  type FamilyTrainingCursorV1,
} from './opening-family.ts'

export {
  FamilyCoverageEventV1Schema,
  FamilyTrainingCursorV1Schema,
} from './opening-family.ts'
export type {
  FamilyCoverageEventV1,
  FamilyTrainingCursorV1,
} from './opening-family.ts'

export type FamilyTrainingAppendResult = 'appended' | 'duplicate'

export interface FamilyTrainingCursorFlushResult {
  savedCount: number
  pendingCount: number
  error: Error | null
}

export interface FamilyTrainingJournalScope {
  releaseId: string
  familyId: string
}

export interface FamilyTrainingCursorScope extends FamilyTrainingJournalScope {
  side: 'white' | 'black'
}

/**
 * Persistence adapters append immutable records. Repeating the same request is
 * a successful no-op; an event-ID collision with different data must fail.
 */
export interface FamilyTrainingJournalRepository {
  readonly kind: 'artifact' | 'cloud' | 'memory'
  appendCoverageEvent(event: FamilyCoverageEventV1): Promise<FamilyTrainingAppendResult>
  appendCursor(cursor: FamilyTrainingCursorV1): Promise<FamilyTrainingAppendResult>
  listCoverageEvents(scope: FamilyTrainingJournalScope): Promise<FamilyCoverageEventV1[]>
  loadLatestCursor(scope: FamilyTrainingCursorScope): Promise<FamilyTrainingCursorV1 | null>
}

function coverageScopeKey(scope: FamilyTrainingJournalScope): string {
  const releaseId = FamilyReleaseIdSchema.parse(scope.releaseId)
  const familyId = FamilyIdSchema.parse(scope.familyId)
  return `${releaseId}\0${familyId}`
}

function cursorScopeKey(scope: FamilyTrainingCursorScope): string {
  return `${coverageScopeKey(scope)}\0${scope.side}`
}

function logicalCompletionKey(event: FamilyCoverageEventV1): string {
  return [
    event.releaseId,
    event.familyId,
    event.packId,
    event.pathId,
    event.coverageCycleId,
  ].join('\0')
}

function canonical(value: FamilyCoverageEventV1 | FamilyTrainingCursorV1): string {
  return JSON.stringify(value)
}

/**
 * Serializes cursor writes and retains failed snapshots in memory for an
 * explicit retry. It never drops or reorders a cursor after an adapter error.
 * Durable adapters remain responsible for their own cross-process delivery.
 */
export class FamilyTrainingCursorWriteQueue {
  readonly #repository: Pick<FamilyTrainingJournalRepository, 'appendCursor'>
  readonly #pending: FamilyTrainingCursorV1[] = []
  #activeFlush: Promise<FamilyTrainingCursorFlushResult> | null = null

  constructor(repository: Pick<FamilyTrainingJournalRepository, 'appendCursor'>) {
    this.#repository = repository
  }

  get pendingCount(): number {
    return this.#pending.length
  }

  enqueue(input: FamilyTrainingCursorV1): Promise<FamilyTrainingCursorFlushResult> {
    const cursor = FamilyTrainingCursorV1Schema.parse(input)
    const latest = this.#pending.at(-1)
    if (!latest || canonical(latest) !== canonical(cursor)) {
      this.#pending.push(structuredClone(cursor))
    }
    return this.flush()
  }

  flush(): Promise<FamilyTrainingCursorFlushResult> {
    if (this.#activeFlush) return this.#activeFlush
    this.#activeFlush = this.#drain().finally(() => {
      this.#activeFlush = null
    })
    return this.#activeFlush
  }

  async #drain(): Promise<FamilyTrainingCursorFlushResult> {
    let savedCount = 0
    while (this.#pending.length > 0) {
      try {
        await this.#repository.appendCursor(this.#pending[0]!)
        this.#pending.shift()
        savedCount += 1
      } catch (error) {
        return {
          savedCount,
          pendingCount: this.#pending.length,
          error: error instanceof Error ? error : new Error('Family training cursor could not be saved'),
        }
      }
    }
    return { savedCount, pendingCount: 0, error: null }
  }
}

/** Counts paths completed at least once without inflating totals in later coverage cycles. */
export function countUniqueCompletedFamilyPaths(events: readonly FamilyCoverageEventV1[]): number {
  const validated = events.map((event) => FamilyCoverageEventV1Schema.parse(event))
  return new Set(validated.map((event) =>
    `${event.releaseId}\0${event.familyId}\0${event.packId}\0${event.pathId}`)).size
}

/** Session-only adapter used when durable Artifact or cloud storage is absent. */
export class MemoryFamilyTrainingJournalRepository implements FamilyTrainingJournalRepository {
  readonly kind = 'memory' as const
  readonly #coverageEvents: FamilyCoverageEventV1[] = []
  readonly #coverageByEventId = new Map<string, FamilyCoverageEventV1>()
  readonly #completionKeys = new Set<string>()
  readonly #cursorHistory = new Map<string, FamilyTrainingCursorV1[]>()

  async appendCoverageEvent(input: FamilyCoverageEventV1): Promise<FamilyTrainingAppendResult> {
    const event = FamilyCoverageEventV1Schema.parse(input)
    const priorById = this.#coverageByEventId.get(event.eventId)
    if (priorById) {
      if (canonical(priorById) !== canonical(event)) {
        throw new Error('Family coverage event ID was reused with different content')
      }
      return 'duplicate'
    }
    const completionKey = logicalCompletionKey(event)
    const stored = structuredClone(event)
    if (this.#completionKeys.has(completionKey)) {
      this.#coverageByEventId.set(stored.eventId, stored)
      return 'duplicate'
    }
    this.#coverageEvents.push(stored)
    this.#coverageByEventId.set(stored.eventId, stored)
    this.#completionKeys.add(completionKey)
    return 'appended'
  }

  async appendCursor(input: FamilyTrainingCursorV1): Promise<FamilyTrainingAppendResult> {
    const cursor = FamilyTrainingCursorV1Schema.parse(input)
    const key = cursorScopeKey(cursor)
    const history = this.#cursorHistory.get(key) ?? []
    const previous = history.at(-1)
    if (previous && canonical(previous) === canonical(cursor)) return 'duplicate'
    history.push(structuredClone(cursor))
    this.#cursorHistory.set(key, history)
    return 'appended'
  }

  async listCoverageEvents(scope: FamilyTrainingJournalScope): Promise<FamilyCoverageEventV1[]> {
    const key = coverageScopeKey(scope)
    return this.#coverageEvents
      .filter((event) => coverageScopeKey(event) === key)
      .map((event) => structuredClone(event))
  }

  async loadLatestCursor(scope: FamilyTrainingCursorScope): Promise<FamilyTrainingCursorV1 | null> {
    const latest = this.#cursorHistory.get(cursorScopeKey(scope))?.at(-1)
    return latest ? structuredClone(latest) : null
  }
}

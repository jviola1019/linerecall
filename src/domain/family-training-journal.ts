import {
  FamilyCoverageEventV1Schema,
  FamilyIdSchema,
  FamilyPackIdSchema,
  FamilyReleaseIdSchema,
  FamilyTrainingCursorV1Schema,
  type FamilyCoverageEventV1,
  type FamilyTrainingCursorV1,
} from './opening-family.ts'
import { z } from 'zod'

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
  packId: string
  side: 'white' | 'black'
}

export interface FamilyTrainingCursorLookup extends FamilyTrainingCursorScope {
  coverageCycleId: string
}

export interface FamilyCoverageCycleScope extends FamilyTrainingJournalScope {
  side: 'white' | 'black'
}

const FamilyCoverageCycleEventBaseSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  side: z.enum(['white', 'black']),
  generationId: z.string().uuid(),
  generationOrdinal: z.number().int().nonnegative(),
  occurredAt: z.string().datetime({ offset: true }),
})

export const FamilyCoverageCycleEventV1Schema = z.discriminatedUnion('kind', [
  FamilyCoverageCycleEventBaseSchema.extend({
    kind: z.literal('cycle_started'),
  }).strict(),
  FamilyCoverageCycleEventBaseSchema.extend({
    kind: z.literal('pack_bound'),
    packId: FamilyPackIdSchema,
    packCoverageCycleId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::coverage:[0-9]+$/u),
  }).strict().superRefine((event, context) => {
    if (!event.packCoverageCycleId.startsWith(`${event.packId}::coverage:`)) {
      context.addIssue({
        code: 'custom',
        path: ['packCoverageCycleId'],
        message: 'Pack cycle binding must belong to the declared graph pack',
      })
    }
  }),
])

export type FamilyCoverageCycleEventV1 = z.infer<typeof FamilyCoverageCycleEventV1Schema>

/**
 * Portable journal data contains immutable completion/cycle events and only
 * the latest cursor for each release/family/side/pack scope. Earlier cursor
 * snapshots are implementation history; the latest validated cursor contains
 * every due, reviewed, completed, and pending path needed to resume exactly.
 */
export const FamilyTrainingJournalSnapshotV1Schema = z.object({
  schemaVersion: z.literal(1),
  coverageEvents: z.array(FamilyCoverageEventV1Schema).max(100_000),
  cycleEvents: z.array(FamilyCoverageCycleEventV1Schema).max(100_000),
  latestCursors: z.array(FamilyTrainingCursorV1Schema).max(10_000),
}).strict().superRefine((snapshot, context) => {
  const coverageIds = new Set<string>()
  const completionKeys = new Set<string>()
  snapshot.coverageEvents.forEach((event, index) => {
    if (coverageIds.has(event.eventId)) {
      context.addIssue({ code: 'custom', path: ['coverageEvents', index, 'eventId'], message: 'Coverage event IDs must be unique' })
    }
    coverageIds.add(event.eventId)
    const completionKey = logicalCompletionKey(event)
    if (completionKeys.has(completionKey)) {
      context.addIssue({ code: 'custom', path: ['coverageEvents', index], message: 'Logical path completions must be unique' })
    }
    completionKeys.add(completionKey)
  })

  const cycleIds = new Set<string>()
  const cycleLogicalKeys = new Set<string>()
  snapshot.cycleEvents.forEach((event, index) => {
    if (cycleIds.has(event.eventId)) {
      context.addIssue({ code: 'custom', path: ['cycleEvents', index, 'eventId'], message: 'Coverage-cycle event IDs must be unique' })
    }
    cycleIds.add(event.eventId)
    const scope = `${event.releaseId}\0${event.familyId}\0${event.side}`
    const logicalKey = event.kind === 'cycle_started'
      ? `${scope}\0generation:${event.generationOrdinal}`
      : `${scope}\0${event.generationId}\0pack:${event.packId}`
    if (cycleLogicalKeys.has(logicalKey)) {
      context.addIssue({ code: 'custom', path: ['cycleEvents', index], message: 'Logical coverage-cycle records must be unique' })
    }
    cycleLogicalKeys.add(logicalKey)
  })

  const cursorScopes = new Set<string>()
  snapshot.latestCursors.forEach((cursor, index) => {
    const scope = `${cursor.releaseId}\0${cursor.familyId}\0${cursor.side}\0${cursorPackId(cursor)}`
    if (cursorScopes.has(scope)) {
      context.addIssue({ code: 'custom', path: ['latestCursors', index], message: 'A journal snapshot may contain only one latest cursor per pack scope' })
    }
    cursorScopes.add(scope)
  })
})

export type FamilyTrainingJournalSnapshotV1 = z.infer<typeof FamilyTrainingJournalSnapshotV1Schema>

export interface FamilyCoverageGenerationV1 {
  releaseId: string
  familyId: string
  side: 'white' | 'black'
  generationId: string
  generationOrdinal: number
  packCycleIds: Readonly<Record<string, string>>
}

/**
 * Persistence adapters append immutable records. Repeating the same request is
 * a successful no-op; an event-ID collision with different data must fail.
 */
export interface FamilyTrainingJournalRepository {
  readonly kind: 'artifact' | 'cloud' | 'memory'
  appendCoverageEvent(event: FamilyCoverageEventV1): Promise<FamilyTrainingAppendResult>
  appendCycleEvent(event: FamilyCoverageCycleEventV1): Promise<FamilyTrainingAppendResult>
  appendCursor(cursor: FamilyTrainingCursorV1): Promise<FamilyTrainingAppendResult>
  listCoverageEvents(scope: FamilyTrainingJournalScope): Promise<FamilyCoverageEventV1[]>
  listCycleEvents(scope: FamilyCoverageCycleScope): Promise<FamilyCoverageCycleEventV1[]>
  loadLatestCursor(scope: FamilyTrainingCursorScope): Promise<FamilyTrainingCursorV1 | null>
  loadCursor(scope: FamilyTrainingCursorLookup): Promise<FamilyTrainingCursorV1 | null>
}

/**
 * Optional transfer boundary. Adapters implement this only when they can
 * faithfully snapshot and replace the complete journal represented above.
 * Cloud and Artifact adapters are not assumed to support it.
 */
export interface FamilyTrainingJournalTransferCapability {
  exportSnapshot(): Promise<FamilyTrainingJournalSnapshotV1>
  replaceSnapshot(snapshot: FamilyTrainingJournalSnapshotV1): Promise<void>
}

export type TransferableFamilyTrainingJournalRepository =
  FamilyTrainingJournalRepository & FamilyTrainingJournalTransferCapability

export function supportsFamilyTrainingJournalTransfer(
  repository: FamilyTrainingJournalRepository,
): repository is TransferableFamilyTrainingJournalRepository {
  const candidate = repository as Partial<FamilyTrainingJournalTransferCapability>
  return typeof candidate.exportSnapshot === 'function' && typeof candidate.replaceSnapshot === 'function'
}

function coverageScopeKey(scope: FamilyTrainingJournalScope): string {
  const releaseId = FamilyReleaseIdSchema.parse(scope.releaseId)
  const familyId = FamilyIdSchema.parse(scope.familyId)
  return `${releaseId}\0${familyId}`
}

function cursorScopeKey(scope: FamilyTrainingCursorScope): string {
  const packId = FamilyPackIdSchema.parse(scope.packId)
  if (scope.side !== 'white' && scope.side !== 'black') {
    throw new Error('Family training cursor side must be white or black')
  }
  return `${coverageScopeKey(scope)}\0${scope.side}\0${packId}`
}

function cursorPackId(cursor: FamilyTrainingCursorV1): string {
  const separator = '::coverage:'
  const separatorIndex = cursor.coverageCycleId.indexOf(separator)
  if (separatorIndex < 1) throw new Error('Family training cursor has an invalid coverage cycle')
  return FamilyPackIdSchema.parse(cursor.coverageCycleId.slice(0, separatorIndex))
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

/** Replay durable completion events after a crash between the event and cursor writes. */
export function reconcileFamilyCursorCompletions(
  input: FamilyTrainingCursorV1,
  inputs: readonly FamilyCoverageEventV1[],
): FamilyTrainingCursorV1 {
  const cursor = FamilyTrainingCursorV1Schema.parse(input)
  const packId = cursorPackId(cursor)
  const selected = new Set([...cursor.completedPathIds, ...cursor.pendingPathIds])
  const completed = new Set<string>()
  for (const inputEvent of inputs) {
    const event = FamilyCoverageEventV1Schema.parse(inputEvent)
    if (event.releaseId !== cursor.releaseId || event.familyId !== cursor.familyId
      || event.packId !== packId || event.coverageCycleId !== cursor.coverageCycleId) continue
    if (!selected.has(event.pathId)) throw new Error('Saved completion is outside the selected family paths')
    completed.add(event.pathId)
  }
  if (cursor.completedPathIds.some((pathId) => !completed.has(pathId))) {
    throw new Error('Saved cursor completion is missing its append-only event')
  }
  return FamilyTrainingCursorV1Schema.parse({
    ...cursor,
    completedPathIds: [...cursor.completedPathIds, ...cursor.pendingPathIds.filter((pathId) => completed.has(pathId))],
    pendingPathIds: cursor.pendingPathIds.filter((pathId) => !completed.has(pathId)),
  })
}

function cycleScopeKey(scope: FamilyCoverageCycleScope): string {
  if (scope.side !== 'white' && scope.side !== 'black') {
    throw new Error('Family coverage cycle side must be white or black')
  }
  return `${coverageScopeKey(scope)}\0${scope.side}`
}

function canonical(value: FamilyCoverageEventV1 | FamilyTrainingCursorV1): string {
  return JSON.stringify(value)
}

function canonicalCycle(value: FamilyCoverageCycleEventV1): string {
  return JSON.stringify(value)
}

export function latestFamilyCoverageGeneration(
  inputs: readonly FamilyCoverageCycleEventV1[],
): FamilyCoverageGenerationV1 | null {
  const events = inputs.map((event) => FamilyCoverageCycleEventV1Schema.parse(event))
  const starts = events.filter((event) => event.kind === 'cycle_started')
  if (starts.length === 0) return null
  const latest = [...starts].sort((left, right) =>
    right.generationOrdinal - left.generationOrdinal
    || right.occurredAt.localeCompare(left.occurredAt)
    || right.eventId.localeCompare(left.eventId))[0]!
  const sameOrdinalStarts = starts.filter((event) =>
    event.releaseId === latest.releaseId
    && event.familyId === latest.familyId
    && event.side === latest.side
    && event.generationOrdinal === latest.generationOrdinal)
  if (new Set(sameOrdinalStarts.map(({ generationId }) => generationId)).size !== 1) {
    throw new Error('Family coverage generation ordinal has conflicting identities')
  }
  const packCycleIds: Record<string, string> = {}
  for (const event of events) {
    if (event.kind !== 'pack_bound' || event.generationId !== latest.generationId) continue
    if (
      event.releaseId !== latest.releaseId
      || event.familyId !== latest.familyId
      || event.side !== latest.side
      || event.generationOrdinal !== latest.generationOrdinal
    ) {
      throw new Error('Family coverage pack binding conflicts with its generation')
    }
    const prior = packCycleIds[event.packId]
    if (prior && prior !== event.packCoverageCycleId) {
      throw new Error('Family coverage generation binds one pack to multiple cycles')
    }
    packCycleIds[event.packId] = event.packCoverageCycleId
  }
  return {
    releaseId: latest.releaseId,
    familyId: latest.familyId,
    side: latest.side,
    generationId: latest.generationId,
    generationOrdinal: latest.generationOrdinal,
    packCycleIds,
  }
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
  readonly #cycleEvents: FamilyCoverageCycleEventV1[] = []
  readonly #cycleByEventId = new Map<string, FamilyCoverageCycleEventV1>()
  readonly #cycleStarts = new Map<string, FamilyCoverageCycleEventV1>()
  readonly #cycleBindings = new Map<string, FamilyCoverageCycleEventV1>()

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
    const key = cursorScopeKey({
      releaseId: cursor.releaseId,
      familyId: cursor.familyId,
      packId: cursorPackId(cursor),
      side: cursor.side,
    })
    const history = this.#cursorHistory.get(key) ?? []
    const previous = history.at(-1)
    if (previous && canonical(previous) === canonical(cursor)) return 'duplicate'
    history.push(structuredClone(cursor))
    this.#cursorHistory.set(key, history)
    return 'appended'
  }

  async appendCycleEvent(input: FamilyCoverageCycleEventV1): Promise<FamilyTrainingAppendResult> {
    const event = FamilyCoverageCycleEventV1Schema.parse(input)
    const priorById = this.#cycleByEventId.get(event.eventId)
    if (priorById) {
      if (canonicalCycle(priorById) !== canonicalCycle(event)) {
        throw new Error('Family coverage cycle event ID was reused with different content')
      }
      return 'duplicate'
    }
    const scope = cycleScopeKey(event)
    const logicalKey = event.kind === 'cycle_started'
      ? `${scope}\0generation:${event.generationOrdinal}`
      : `${scope}\0${event.generationId}\0pack:${event.packId}`
    const logicalMap = event.kind === 'cycle_started' ? this.#cycleStarts : this.#cycleBindings
    const priorLogical = logicalMap.get(logicalKey)
    if (priorLogical) {
      const sameLogicalContent = priorLogical.kind === event.kind
        && priorLogical.generationId === event.generationId
        && priorLogical.generationOrdinal === event.generationOrdinal
        && (priorLogical.kind !== 'pack_bound' || event.kind !== 'pack_bound' || (
          priorLogical.packId === event.packId
          && priorLogical.packCoverageCycleId === event.packCoverageCycleId
        ))
      if (!sameLogicalContent) {
        throw new Error(event.kind === 'cycle_started'
          ? 'Family coverage generation ordinal was reused with different content'
          : 'Family coverage generation pack was rebound to another cycle')
      }
      this.#cycleByEventId.set(event.eventId, structuredClone(event))
      return 'duplicate'
    }
    const stored = structuredClone(event)
    this.#cycleEvents.push(stored)
    this.#cycleByEventId.set(stored.eventId, stored)
    logicalMap.set(logicalKey, stored)
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

  async loadCursor(scope: FamilyTrainingCursorLookup): Promise<FamilyTrainingCursorV1 | null> {
    const expectedPackId = cursorPackId(FamilyTrainingCursorV1Schema.parse({
      schemaVersion: 1,
      releaseId: scope.releaseId,
      familyId: scope.familyId,
      side: scope.side,
      coverageCycleId: scope.coverageCycleId,
      authoritativeDueCardIds: [],
      reviewedCardIds: [],
      completedPathIds: [],
      pendingPathIds: [],
      batchIndex: 0,
    }))
    if (expectedPackId !== FamilyPackIdSchema.parse(scope.packId)) {
      throw new Error('Requested family cursor belongs to another graph pack')
    }
    const history = this.#cursorHistory.get(cursorScopeKey(scope)) ?? []
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const cursor = history[index]
      if (cursor?.coverageCycleId === scope.coverageCycleId) {
        return structuredClone(cursor)
      }
    }
    return null
  }

  async listCycleEvents(scope: FamilyCoverageCycleScope): Promise<FamilyCoverageCycleEventV1[]> {
    const key = cycleScopeKey(scope)
    return this.#cycleEvents
      .filter((event) => cycleScopeKey(event) === key)
      .map((event) => structuredClone(event))
  }

  async exportSnapshot(): Promise<FamilyTrainingJournalSnapshotV1> {
    return FamilyTrainingJournalSnapshotV1Schema.parse({
      schemaVersion: 1,
      coverageEvents: this.#coverageEvents.map((event) => structuredClone(event)),
      cycleEvents: this.#cycleEvents.map((event) => structuredClone(event)),
      latestCursors: [...this.#cursorHistory.values()]
        .map((history) => history.at(-1))
        .filter((cursor): cursor is FamilyTrainingCursorV1 => cursor !== undefined)
        .map((cursor) => structuredClone(cursor)),
    })
  }

  async replaceSnapshot(input: FamilyTrainingJournalSnapshotV1): Promise<void> {
    const snapshot = FamilyTrainingJournalSnapshotV1Schema.parse(input)
    const staged = new MemoryFamilyTrainingJournalRepository()
    for (const event of snapshot.coverageEvents) {
      if (await staged.appendCoverageEvent(event) !== 'appended') {
        throw new Error('Portable family snapshot contains a duplicate path completion')
      }
    }
    for (const event of snapshot.cycleEvents) {
      if (await staged.appendCycleEvent(event) !== 'appended') {
        throw new Error('Portable family snapshot contains a duplicate coverage-cycle record')
      }
    }
    for (const cursor of snapshot.latestCursors) {
      if (await staged.appendCursor(cursor) !== 'appended') {
        throw new Error('Portable family snapshot contains a duplicate latest cursor')
      }
    }

    // Commit only after the complete replacement validates in isolation.
    this.#coverageEvents.splice(0, this.#coverageEvents.length, ...staged.#coverageEvents.map((event) => structuredClone(event)))
    this.#coverageByEventId.clear()
    for (const [key, value] of staged.#coverageByEventId) this.#coverageByEventId.set(key, structuredClone(value))
    this.#completionKeys.clear()
    for (const key of staged.#completionKeys) this.#completionKeys.add(key)
    this.#cursorHistory.clear()
    for (const [key, history] of staged.#cursorHistory) {
      this.#cursorHistory.set(key, history.map((cursor) => structuredClone(cursor)))
    }
    this.#cycleEvents.splice(0, this.#cycleEvents.length, ...staged.#cycleEvents.map((event) => structuredClone(event)))
    this.#cycleByEventId.clear()
    for (const [key, value] of staged.#cycleByEventId) this.#cycleByEventId.set(key, structuredClone(value))
    this.#cycleStarts.clear()
    for (const [key, value] of staged.#cycleStarts) this.#cycleStarts.set(key, structuredClone(value))
    this.#cycleBindings.clear()
    for (const [key, value] of staged.#cycleBindings) this.#cycleBindings.set(key, structuredClone(value))
  }

}

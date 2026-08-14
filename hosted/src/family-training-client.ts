import type {
  FamilyCoverageCycleEventV1,
  FamilyCoverageCycleScope,
  FamilyTrainingAppendResult,
  FamilyTrainingCursorLookup,
  FamilyTrainingCursorScope,
  FamilyTrainingJournalRepository,
  FamilyTrainingJournalScope,
} from '../../src/domain/family-training-journal.ts'
import {
  FamilyCoverageEventV1Schema,
  FamilyTrainingCursorV1Schema,
  type FamilyCoverageEventV1,
  type FamilyTrainingCursorV1,
} from '../../src/domain/opening-family.ts'
import {
  FamilyCoverageCycleEventV1Schema,
  FamilyCoveragePageV1Schema,
  FamilyCursorResponseV1Schema,
  FamilyCyclePageV1Schema,
  FamilyTrainingSyncRequestV1Schema,
  FamilyTrainingSyncResponseV1Schema,
  type VersionedFamilyTrainingCursorV1,
} from './contracts.ts'
import { expectJson, sameOriginRequest, type FetchLike } from './http.ts'

const MAX_BOOTSTRAP_PAGES = 200
const MAX_PENDING_RECORDS = 50_000
const MAX_PENDING_CURSORS = 10_000

interface PendingCursor {
  mutationId: string
  value: FamilyTrainingCursorV1
}

export interface PendingFamilyTrainingExportV1 {
  pendingFamilyCoverageEvents: FamilyCoverageEventV1[]
  pendingFamilyCycleEvents: FamilyCoverageCycleEventV1[]
  pendingFamilyCursors: PendingCursor[]
}

function uuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new Error('UUIDv7 timestamp is out of range')
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let timestamp = BigInt(now)
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn)
    timestamp >>= 8n
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function canonical(value: unknown): string {
  return JSON.stringify(value)
}

function coverageScope(scope: FamilyTrainingJournalScope): string {
  return `${scope.releaseId}\0${scope.familyId}`
}

function cycleScope(scope: FamilyCoverageCycleScope): string {
  return `${coverageScope(scope)}\0${scope.side}`
}

function cursorPackId(cursor: FamilyTrainingCursorV1): string {
  return cursor.coverageCycleId.slice(0, cursor.coverageCycleId.indexOf('::coverage:'))
}

function cursorScope(scope: FamilyTrainingCursorScope): string {
  return `${coverageScope(scope)}\0${scope.side}\0${scope.packId}`
}

function completionKey(event: FamilyCoverageEventV1): string {
  return [event.releaseId, event.familyId, event.packId, event.pathId, event.coverageCycleId].join('\0')
}

function cycleLogicalKey(event: FamilyCoverageCycleEventV1): string {
  const scope = cycleScope(event)
  return event.kind === 'cycle_started'
    ? `${scope}\0generation:${event.generationOrdinal}`
    : `${scope}\0${event.generationId}\0pack:${event.packId}`
}

/**
 * Cloud adapter for the unified-family journal. Network failures leave the
 * validated records in memory and notify the hosted shell; no browser storage
 * is used. A later online event calls flush() again.
 */
export class CloudFamilyTrainingJournalRepository implements FamilyTrainingJournalRepository {
  readonly kind = 'cloud' as const
  readonly #deviceId: string
  readonly #origin: string
  readonly #fetcher: FetchLike
  readonly #onError: (error: Error) => void
  readonly #onPendingChange: (count: number) => void
  readonly #pendingCoverage = new Map<string, FamilyCoverageEventV1>()
  readonly #pendingCycles = new Map<string, FamilyCoverageCycleEventV1>()
  readonly #pendingCursors = new Map<string, PendingCursor[]>()
  readonly #coverageCache = new Map<string, Map<string, FamilyCoverageEventV1>>()
  readonly #cycleCache = new Map<string, Map<string, FamilyCoverageCycleEventV1>>()
  readonly #loadedCoverageScopes = new Set<string>()
  readonly #loadedCycleScopes = new Set<string>()
  readonly #cursorCache = new Map<string, VersionedFamilyTrainingCursorV1>()
  readonly #cursorMutationByDocument = new Map<string, string>()
  #flushPromise: Promise<void> | null = null

  constructor(options: {
    deviceId: string
    origin?: string
    fetcher?: FetchLike
    onError?: (error: Error) => void
    onPendingChange?: (count: number) => void
  }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(options.deviceId)) {
      throw new Error('Family cloud journal requires a UUIDv7 device ID')
    }
    this.#deviceId = options.deviceId
    this.#origin = new URL(options.origin ?? globalThis.location.origin).origin
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.#onError = options.onError ?? (() => undefined)
    this.#onPendingChange = options.onPendingChange ?? (() => undefined)
  }

  get pendingCount(): number {
    return this.#pendingCoverage.size + this.#pendingCycles.size +
      [...this.#pendingCursors.values()].reduce((count, queue) => count + queue.length, 0)
  }

  exportPendingRecords(): PendingFamilyTrainingExportV1 {
    return {
      pendingFamilyCoverageEvents: [...this.#pendingCoverage.values()].map((event) => structuredClone(event)),
      pendingFamilyCycleEvents: [...this.#pendingCycles.values()].map((event) => structuredClone(event)),
      pendingFamilyCursors: [...this.#pendingCursors.values()].flat().map((cursor) => structuredClone(cursor)),
    }
  }

  async appendCoverageEvent(input: FamilyCoverageEventV1): Promise<FamilyTrainingAppendResult> {
    const event = FamilyCoverageEventV1Schema.parse(input)
    const cached = this.#coverageCache.get(coverageScope(event))
    const prior = this.#pendingCoverage.get(event.eventId) ?? cached?.get(event.eventId)
    if (prior) {
      if (canonical(prior) !== canonical(event)) throw new Error('Family coverage event ID was reused with different content')
      return 'duplicate'
    }
    if ([...(cached?.values() ?? []), ...this.#pendingCoverage.values()].some((value) => completionKey(value) === completionKey(event))) {
      return 'duplicate'
    }
    this.#assertQueueCapacity()
    this.#pendingCoverage.set(event.eventId, structuredClone(event))
    this.#notifyPending()
    await this.#attemptFlush()
    return 'appended'
  }

  async appendCycleEvent(input: FamilyCoverageCycleEventV1): Promise<FamilyTrainingAppendResult> {
    const event = FamilyCoverageCycleEventV1Schema.parse(input)
    const cached = this.#cycleCache.get(cycleScope(event))
    const prior = this.#pendingCycles.get(event.eventId) ?? cached?.get(event.eventId)
    if (prior) {
      if (canonical(prior) !== canonical(event)) throw new Error('Family cycle event ID was reused with different content')
      return 'duplicate'
    }
    if ([...(cached?.values() ?? []), ...this.#pendingCycles.values()].some((value) => cycleLogicalKey(value) === cycleLogicalKey(event))) {
      return 'duplicate'
    }
    this.#assertQueueCapacity()
    this.#pendingCycles.set(event.eventId, structuredClone(event))
    this.#notifyPending()
    await this.#attemptFlush()
    return 'appended'
  }

  async appendCursor(input: FamilyTrainingCursorV1): Promise<FamilyTrainingAppendResult> {
    const value = FamilyTrainingCursorV1Schema.parse(input)
    const scope = cursorScope({
      releaseId: value.releaseId,
      familyId: value.familyId,
      side: value.side,
      packId: cursorPackId(value),
    })
    const queue = this.#pendingCursors.get(scope) ?? []
    const previous = queue.at(-1)?.value ?? this.#cursorCache.get(scope)?.value
    if (previous && canonical(previous) === canonical(value)) return 'duplicate'
    this.#assertQueueCapacity()
    const pendingCursorCount = [...this.#pendingCursors.values()].reduce((count, pending) => count + pending.length, 0)
    if (pendingCursorCount >= MAX_PENDING_CURSORS) {
      throw new Error('The in-memory family cursor queue reached its safety limit; reconnect before continuing')
    }
    const documentKey = `${scope}\0${canonical(value)}`
    const mutationId = this.#cursorMutationByDocument.get(documentKey) ?? uuidV7()
    this.#cursorMutationByDocument.set(documentKey, mutationId)
    queue.push({ mutationId, value: structuredClone(value) })
    this.#pendingCursors.set(scope, queue)
    this.#notifyPending()
    await this.#attemptFlush()
    return 'appended'
  }

  async listCoverageEvents(scope: FamilyTrainingJournalScope): Promise<FamilyCoverageEventV1[]> {
    const key = coverageScope(scope)
    try {
      if (!this.#loadedCoverageScopes.has(key)) {
        let cursor = '0'
        let pages = 0
        const records = new Map<string, FamilyCoverageEventV1>()
        do {
          if (pages >= MAX_BOOTSTRAP_PAGES) throw new Error('Family coverage bootstrap exceeded its bounded page limit')
          const parameters = new URLSearchParams({
            releaseId: scope.releaseId, familyId: scope.familyId, cursor, limit: '500',
          })
          const response = await sameOriginRequest(this.#fetcher, this.#origin, `/v1/family-training/coverage?${parameters}`)
          const page = await expectJson(response, (value) => FamilyCoveragePageV1Schema.parse(value))
          for (const record of page.records) records.set(record.event.eventId, record.event)
          cursor = page.nextCursor
          pages += 1
          if (!page.hasMore) break
        } while (true)
        this.#coverageCache.set(key, records)
        this.#loadedCoverageScopes.add(key)
      }
    } catch (cause) {
      if (!this.#coverageCache.has(key) && ![...this.#pendingCoverage.values()].some((event) => coverageScope(event) === key)) throw cause
      this.#notify(cause)
    }
    const combined = new Map(this.#coverageCache.get(key) ?? [])
    for (const event of this.#pendingCoverage.values()) if (coverageScope(event) === key) combined.set(event.eventId, event)
    return [...combined.values()].map((event) => structuredClone(event))
  }

  async listCycleEvents(scope: FamilyCoverageCycleScope): Promise<FamilyCoverageCycleEventV1[]> {
    const key = cycleScope(scope)
    try {
      if (!this.#loadedCycleScopes.has(key)) {
        let cursor = '0'
        let pages = 0
        const records = new Map<string, FamilyCoverageCycleEventV1>()
        do {
          if (pages >= MAX_BOOTSTRAP_PAGES) throw new Error('Family cycle bootstrap exceeded its bounded page limit')
          const parameters = new URLSearchParams({
            releaseId: scope.releaseId, familyId: scope.familyId, side: scope.side, cursor, limit: '500',
          })
          const response = await sameOriginRequest(this.#fetcher, this.#origin, `/v1/family-training/cycles?${parameters}`)
          const page = await expectJson(response, (value) => FamilyCyclePageV1Schema.parse(value))
          for (const record of page.records) records.set(record.event.eventId, record.event)
          cursor = page.nextCursor
          pages += 1
          if (!page.hasMore) break
        } while (true)
        this.#cycleCache.set(key, records)
        this.#loadedCycleScopes.add(key)
      }
    } catch (cause) {
      if (!this.#cycleCache.has(key) && ![...this.#pendingCycles.values()].some((event) => cycleScope(event) === key)) throw cause
      this.#notify(cause)
    }
    const combined = new Map(this.#cycleCache.get(key) ?? [])
    for (const event of this.#pendingCycles.values()) if (cycleScope(event) === key) combined.set(event.eventId, event)
    return [...combined.values()].map((event) => structuredClone(event))
  }

  async loadLatestCursor(scope: FamilyTrainingCursorScope): Promise<FamilyTrainingCursorV1 | null> {
    return this.#loadCursor(scope)
  }

  async loadCursor(scope: FamilyTrainingCursorLookup): Promise<FamilyTrainingCursorV1 | null> {
    return this.#loadCursor(scope, scope.coverageCycleId)
  }

  async flush(): Promise<void> {
    if (this.#flushPromise) return this.#flushPromise
    this.#flushPromise = this.#flush().finally(() => { this.#flushPromise = null })
    return this.#flushPromise
  }

  async #attemptFlush(): Promise<void> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.#notify(new Error('Offline. Family progress is held in memory until connectivity returns.'))
      return
    }
    try {
      await this.flush()
    } catch (cause) {
      this.#notify(cause)
      if (cause instanceof FamilyRecordRejectedError) throw cause
    }
  }

  async #flush(): Promise<void> {
    while (this.pendingCount > 0) {
      const coverageEvents = [...this.#pendingCoverage.values()].slice(0, 250)
      const remaining = 250 - coverageEvents.length
      const cycleEvents = [...this.#pendingCycles.values()].slice(0, remaining)
      const pendingCursorQueue = this.#pendingCursors.entries().next().value as [string, PendingCursor[]] | undefined
      const pendingCursor = pendingCursorQueue?.[1][0]
      let cursorMutation: { mutationId: string; baseVersion: number; value: FamilyTrainingCursorV1 } | undefined
      if (pendingCursorQueue && pendingCursor) {
        const [scope] = pendingCursorQueue
        if (!this.#cursorCache.has(scope)) await this.#fetchCursor(pendingCursor.value)
        cursorMutation = {
          mutationId: pendingCursor.mutationId,
          baseVersion: this.#cursorCache.get(scope)?.version ?? 0,
          value: pendingCursor.value,
        }
      }
      const request = FamilyTrainingSyncRequestV1Schema.parse({
        deviceId: this.#deviceId,
        coverageEvents,
        cycleEvents,
        ...(cursorMutation ? { cursorMutation } : {}),
      })
      const response = await sameOriginRequest(this.#fetcher, this.#origin, '/v1/family-training/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      })
      const result = await expectJson(response, (value) => FamilyTrainingSyncResponseV1Schema.parse(value))
      for (const eventId of result.acceptedCoverageEventIds) this.#acceptCoverage(eventId)
      for (const eventId of result.acceptedCycleEventIds) this.#acceptCycle(eventId)
      const fatal: string[] = []
      for (const rejection of result.rejectedRecords) {
        if (rejection.code === 'future_timestamp_normalized') continue
        if (rejection.recordType === 'coverage') this.#pendingCoverage.delete(rejection.recordId)
        else this.#pendingCycles.delete(rejection.recordId)
        this.#notifyPending()
        if (rejection.code !== 'duplicate_logical_record') fatal.push(rejection.message)
      }
      if (pendingCursorQueue && pendingCursor && result.cursor) {
        const [scope, queue] = pendingCursorQueue
        this.#cursorCache.set(scope, result.cursor)
        queue.shift()
        if (queue.length === 0) this.#pendingCursors.delete(scope)
        else this.#pendingCursors.set(scope, queue)
        this.#notifyPending()
      }
      if (pendingCursor && !result.cursor) {
        throw new Error('Family sync omitted the requested cursor acknowledgement')
      }
      if (fatal.length > 0) throw new FamilyRecordRejectedError(fatal[0]!)
      if (coverageEvents.length === 0 && cycleEvents.length === 0 && !pendingCursor) break
    }
  }

  #acceptCoverage(eventId: string): void {
    const event = this.#pendingCoverage.get(eventId)
    if (!event) return
    const key = coverageScope(event)
    const cache = this.#coverageCache.get(key) ?? new Map<string, FamilyCoverageEventV1>()
    cache.set(event.eventId, event)
    this.#coverageCache.set(key, cache)
    this.#pendingCoverage.delete(eventId)
    this.#notifyPending()
  }

  #acceptCycle(eventId: string): void {
    const event = this.#pendingCycles.get(eventId)
    if (!event) return
    const key = cycleScope(event)
    const cache = this.#cycleCache.get(key) ?? new Map<string, FamilyCoverageCycleEventV1>()
    cache.set(event.eventId, event)
    this.#cycleCache.set(key, cache)
    this.#pendingCycles.delete(eventId)
    this.#notifyPending()
  }

  async #loadCursor(scope: FamilyTrainingCursorScope, coverageCycleId?: string): Promise<FamilyTrainingCursorV1 | null> {
    const key = cursorScope(scope)
    const pending = this.#pendingCursors.get(key)?.at(-1)?.value
    try {
      await this.#fetchCursor({
        schemaVersion: 1,
        releaseId: scope.releaseId,
        familyId: scope.familyId,
        side: scope.side,
        coverageCycleId: coverageCycleId ?? `${scope.packId}::coverage:0`,
        authoritativeDueCardIds: [], reviewedCardIds: [], completedPathIds: [], pendingPathIds: [], batchIndex: 0,
      }, coverageCycleId)
    } catch (cause) {
      if (!pending && !this.#cursorCache.has(key)) throw cause
      this.#notify(cause)
    }
    if (pending && (!coverageCycleId || pending.coverageCycleId === coverageCycleId)) return structuredClone(pending)
    const cached = this.#cursorCache.get(key)?.value
    return cached && (!coverageCycleId || cached.coverageCycleId === coverageCycleId) ? structuredClone(cached) : null
  }

  async #fetchCursor(cursor: FamilyTrainingCursorV1, coverageCycleId?: string): Promise<void> {
    const packId = cursorPackId(cursor)
    const parameters = new URLSearchParams({
      releaseId: cursor.releaseId,
      familyId: cursor.familyId,
      side: cursor.side,
      packId,
      ...(coverageCycleId ? { coverageCycleId } : {}),
    })
    const response = await sameOriginRequest(this.#fetcher, this.#origin, `/v1/family-training/cursor?${parameters}`)
    const result = await expectJson(response, (value) => FamilyCursorResponseV1Schema.parse(value))
    if (result.cursor) this.#cursorCache.set(cursorScope({ ...cursor, packId }), result.cursor)
  }

  #assertQueueCapacity(): void {
    if (this.pendingCount >= MAX_PENDING_RECORDS) {
      throw new Error('The in-memory family sync queue reached its safety limit; reconnect before continuing')
    }
  }

  #notify(cause: unknown): void {
    this.#onError(cause instanceof Error ? cause : new Error('Family cloud sync failed'))
  }

  #notifyPending(): void {
    this.#onPendingChange(this.pendingCount)
  }
}

class FamilyRecordRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FamilyRecordRejectedError'
  }
}

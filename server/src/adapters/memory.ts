import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  CardStateV2,
  ProgressSettingsV2,
  PuzzleAttemptSyncRequest,
  PuzzleAttemptSyncResponse,
  PuzzleAttemptV1,
  PuzzleProgressBootstrapResponse,
  PuzzleProgressState,
  ReviewEventV1,
  SyncRejection,
  SyncRequestV1,
  SyncResponseV1,
} from '../contracts.js'
import { ProgressSettingsV2Schema } from '../contracts.js'
import {
  familyCursorPackId,
  type FamilyCoverageCycleEventV1,
  type FamilyCoverageEventV1,
  type FamilyCoveragePageV1,
  type FamilyCursorQuery,
  type FamilyCursorResponseV1,
  type FamilyCyclePageV1,
  type FamilyTrainingCursorV1,
  type FamilyTrainingRejectionV1,
  type FamilyTrainingSyncRequestV1,
  type FamilyTrainingSyncResponseV1,
  type VersionedFamilyTrainingCursorV1,
} from '../family-training-contracts.js'
import { replayCard, serializeCard, type StoredReviewEvent } from '../domain/sm2.js'
import { ApiError } from '../errors.js'
import { uuidV7 } from '../ids.js'
import { PuzzleRecordListV1Schema, type PuzzleRecordV1 } from '../puzzle-record.js'
import type {
  AuthenticatedActor,
  Authenticator,
  CatalogService,
  ExternalConnectionService,
  LichessSyncService,
  RateLimitDecision,
  RateLimiter,
  RepertoireService,
  SyncStore,
} from '../ports.js'

interface UserState {
  sequence: bigint
  events: Map<string, StoredReviewEvent>
  cards: Map<string, CardStateV2>
  puzzleAttempts: Map<string, PuzzleAttemptV1 & { normalizedOccurredAt: string; receivedAt: string; syncSequence: bigint }>
  puzzles: Map<string, PuzzleProgressState>
  familyCoverageEvents: Map<string, StoredFamilyCoverageEvent>
  familyCoverageLogicalKeys: Set<string>
  familyCycleEvents: Map<string, StoredFamilyCycleEvent>
  familyCycleLogicalKeys: Set<string>
  familyCursorMutations: Map<string, StoredFamilyCursor>
  familyCursorHistory: Map<string, StoredFamilyCursor[]>
  settings: { version: number; value: ProgressSettingsV2 }
  deletedAt: string | null
}

interface StoredFamilyCoverageEvent {
  event: FamilyCoverageEventV1
  normalizedCompletedAt: string
  receivedAt: string
  syncSequence: bigint
}

interface StoredFamilyCycleEvent {
  event: FamilyCoverageCycleEventV1
  normalizedOccurredAt: string
  receivedAt: string
  syncSequence: bigint
}

interface StoredFamilyCursor extends VersionedFamilyTrainingCursorV1 {
  deviceId: string
}

function defaultSettings(): ProgressSettingsV2 {
  return ProgressSettingsV2Schema.parse({})
}

function stableEvent(event: ReviewEventV1): string {
  const immutable: ReviewEventV1 = {
    eventId: event.eventId,
    deviceId: event.deviceId,
    cardId: event.cardId,
    packId: event.packId,
    nodeId: event.nodeId,
    grade: event.grade,
    occurredAt: event.occurredAt,
    localDate: event.localDate,
    timeZone: event.timeZone,
    snapshotVersion: event.snapshotVersion,
    ...(event.correctsEventId ? { correctsEventId: event.correctsEventId } : {}),
  }
  return JSON.stringify(immutable, Object.keys(immutable).sort())
}

function stablePuzzleAttempt(attempt: PuzzleAttemptV1): string {
  return JSON.stringify({
    attemptId: attempt.attemptId,
    deviceId: attempt.deviceId,
    puzzleId: attempt.puzzleId,
    outcome: attempt.outcome,
    incorrectAttempts: attempt.incorrectAttempts,
    usedHint: attempt.usedHint,
    ...(attempt.elapsedMs === undefined ? {} : { elapsedMs: attempt.elapsedMs }),
    occurredAt: attempt.occurredAt,
    snapshotVersion: attempt.snapshotVersion,
  })
}

function canonicalFamilyRecord(value: unknown): string {
  return JSON.stringify(value)
}

function familyCoverageLogicalKey(event: FamilyCoverageEventV1): string {
  return [event.releaseId, event.familyId, event.packId, event.pathId, event.coverageCycleId].join('\0')
}

function familyCycleLogicalKey(event: FamilyCoverageCycleEventV1): string {
  const scope = [event.releaseId, event.familyId, event.side].join('\0')
  return event.kind === 'cycle_started'
    ? `${scope}\0generation:${event.generationOrdinal}`
    : `${scope}\0${event.generationId}\0pack:${event.packId}`
}

function familyCursorScope(cursor: FamilyTrainingCursorV1): string {
  return [cursor.releaseId, cursor.familyId, cursor.side, familyCursorPackId(cursor)].join('\0')
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

function eventOrder(a: StoredReviewEvent, b: StoredReviewEvent): number {
  const occurred = a.normalizedOccurredAt.localeCompare(b.normalizedOccurredAt)
  if (occurred !== 0) return occurred
  const received = a.receivedAt.localeCompare(b.receivedAt)
  if (received !== 0) return received
  return a.eventId.localeCompare(b.eventId)
}

export class InMemorySyncStore implements SyncStore {
  readonly #users = new Map<string, UserState>()
  readonly #supportedSnapshots: ReadonlySet<string> | null
  readonly #snapshotMembership: ReadonlySet<string>
  readonly #puzzleMembership: ReadonlySet<string>
  readonly #familyPackMembership: ReadonlySet<string>
  readonly #familyPathMembership: ReadonlySet<string>

  constructor(options: {
    supportedSnapshots?: readonly string[]
    snapshotMembership?: Readonly<Record<string, readonly { packId: string; nodeId: string; cardId: string }[]>>
    puzzleMembership?: Readonly<Record<string, readonly string[]>>
    familyMembership?: Readonly<Record<string, readonly {
      familyId: string
      packId: string
      side: 'white' | 'black'
      pathIds: readonly string[]
    }[]>>
  } = {}) {
    this.#supportedSnapshots = options.supportedSnapshots ? new Set(options.supportedSnapshots) : null
    this.#snapshotMembership = new Set(Object.entries(options.snapshotMembership ?? {}).flatMap(([snapshot, memberships]) =>
      memberships.map((membership) => `${snapshot}\0${membership.packId}\0${membership.nodeId}\0${membership.cardId}`)))
    this.#puzzleMembership = new Set(Object.entries(options.puzzleMembership ?? {}).flatMap(([snapshot, puzzleIds]) =>
      puzzleIds.map((puzzleId) => `${snapshot}\0${puzzleId}`)))
    this.#familyPackMembership = new Set(Object.entries(options.familyMembership ?? {}).flatMap(([releaseId, memberships]) =>
      memberships.map(({ familyId, packId, side }) => `${releaseId}\0${familyId}\0${packId}\0${side}`)))
    this.#familyPathMembership = new Set(Object.entries(options.familyMembership ?? {}).flatMap(([releaseId, memberships]) =>
      memberships.flatMap(({ familyId, packId, pathIds }) =>
        pathIds.map((pathId) => `${releaseId}\0${familyId}\0${packId}\0${pathId}`))))
  }

  #user(userId: string): UserState {
    const existing = this.#users.get(userId)
    if (existing && existing.deletedAt === null) return existing
    const created: UserState = {
      sequence: 0n,
      events: new Map(),
      cards: new Map(),
      puzzleAttempts: new Map(),
      puzzles: new Map(),
      familyCoverageEvents: new Map(),
      familyCoverageLogicalKeys: new Set(),
      familyCycleEvents: new Map(),
      familyCycleLogicalKeys: new Set(),
      familyCursorMutations: new Map(),
      familyCursorHistory: new Map(),
      settings: { version: 0, value: defaultSettings() },
      deletedAt: null,
    }
    this.#users.set(userId, created)
    return created
  }

  async sync(userId: string, request: SyncRequestV1, now: Date): Promise<SyncResponseV1> {
    const user = this.#user(userId)
    const acceptedEventIds: string[] = []
    const rejectedEvents: SyncRejection[] = []
    const affectedCards = new Set<string>()

    for (const incoming of request.events) {
      if (!validTimeZone(incoming.timeZone)) {
        throw new ApiError(422, 'invalid_time_zone', 'A review event contains an unsupported IANA time zone')
      }
      if (this.#supportedSnapshots && !this.#supportedSnapshots.has(incoming.snapshotVersion)) {
        rejectedEvents.push({
          eventId: incoming.eventId,
          code: 'unsupported_snapshot',
          message: 'The referenced repertoire snapshot is not supported by this server',
        })
        continue
      }
      if (
        this.#supportedSnapshots &&
        !this.#snapshotMembership.has(`${incoming.snapshotVersion}\0${incoming.packId}\0${incoming.nodeId}\0${incoming.cardId}`)
      ) {
        rejectedEvents.push({
          eventId: incoming.eventId,
          code: 'unknown_card_membership',
          message: 'The card does not belong to the referenced signed repertoire snapshot',
        })
        continue
      }

      const duplicate = user.events.get(incoming.eventId)
      if (duplicate) {
        if (stableEvent(duplicate) === stableEvent(incoming)) acceptedEventIds.push(incoming.eventId)
        else rejectedEvents.push({
          eventId: incoming.eventId,
          code: 'conflicting_event_id',
          message: 'The event ID is already associated with different immutable content',
        })
        continue
      }

      if (incoming.correctsEventId) {
        const target = user.events.get(incoming.correctsEventId)
        const originalsForCard = [...user.events.values()]
          .filter((event) => !event.correctsEventId && event.cardId === incoming.cardId)
          .sort(eventOrder)
        const alreadyCorrected = [...user.events.values()].some((event) => event.correctsEventId === incoming.correctsEventId)
        if (
          !target || target.correctsEventId || target.cardId !== incoming.cardId ||
          target.packId !== incoming.packId || target.nodeId !== incoming.nodeId ||
          originalsForCard.at(-1)?.eventId !== target.eventId || alreadyCorrected
        ) {
          rejectedEvents.push({
            eventId: incoming.eventId,
            code: 'invalid_correction',
            message: 'Only the latest uncorrected review of the same card can be corrected',
          })
          continue
        }
      }

      const occurred = new Date(incoming.occurredAt)
      const futureLimit = now.getTime() + 5 * 60_000
      const normalizedOccurredAt = occurred.getTime() > futureLimit ? now.toISOString() : occurred.toISOString()
      user.sequence += 1n
      const stored: StoredReviewEvent = {
        ...incoming,
        receivedAt: now.toISOString(),
        normalizedOccurredAt,
        syncSequence: user.sequence,
      }
      user.events.set(incoming.eventId, stored)
      acceptedEventIds.push(incoming.eventId)
      affectedCards.add(incoming.cardId)
      if (occurred.getTime() > futureLimit) {
        rejectedEvents.push({
          eventId: incoming.eventId,
          code: 'future_timestamp_normalized',
          message: 'The review time was over five minutes in the future and was normalized to server time',
        })
      }
    }

    if (request.settingsMutation) {
      if (request.settingsMutation.baseVersion !== user.settings.version) {
        throw new ApiError(409, 'settings_version_conflict', 'Settings changed on another device; refresh and try again')
      }
      user.settings = {
        version: user.settings.version + 1,
        value: request.settingsMutation.value,
      }
      user.sequence += 1n
    }

    for (const cardId of affectedCards) {
      const events = [...user.events.values()].filter((event) => event.cardId === cardId)
      const card = replayCard(cardId, events, now)
      const sequence = events.reduce((highest, event) => event.syncSequence > highest ? event.syncSequence : highest, 0n)
      user.cards.set(cardId, serializeCard(card, sequence))
    }

    return this.#page(user, BigInt(request.cursor ?? '0'), 250, now, acceptedEventIds, rejectedEvents)
  }

  async bootstrap(userId: string, cursor: bigint, limit: number, now: Date): Promise<SyncResponseV1> {
    return this.#page(this.#user(userId), cursor, limit, now, [], [])
  }

  async bootstrapPuzzleProgress(
    userId: string,
    cursor: bigint,
    limit: number,
    now: Date,
  ): Promise<PuzzleProgressBootstrapResponse> {
    if (cursor < 0n || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new ApiError(422, 'invalid_cursor', 'Puzzle progress cursor is invalid')
    }
    const ordered = [...this.#user(userId).puzzles.values()]
      .filter(({ syncSequence }) => BigInt(syncSequence) > cursor)
      .sort((left, right) => {
        const sequence = BigInt(left.syncSequence) - BigInt(right.syncSequence)
        return sequence < 0n ? -1 : sequence > 0n ? 1 : left.puzzleId.localeCompare(right.puzzleId, 'en')
      })
    const page = ordered.slice(0, limit)
    return {
      progress: page,
      nextCursor: page.at(-1)?.syncSequence ?? cursor.toString(),
      hasMore: ordered.length > page.length,
      serverTime: now.toISOString(),
    }
  }

  async syncPuzzleAttempts(userId: string, request: PuzzleAttemptSyncRequest, now: Date): Promise<PuzzleAttemptSyncResponse> {
    const user = this.#user(userId)
    const acceptedAttemptIds: string[] = []
    const rejectedAttempts: PuzzleAttemptSyncResponse['rejectedAttempts'] = []
    const affected = new Set<string>()
    for (const incoming of request.attempts) {
      if (this.#supportedSnapshots && !this.#supportedSnapshots.has(incoming.snapshotVersion)) {
        rejectedAttempts.push({ attemptId: incoming.attemptId, code: 'unsupported_snapshot', message: 'The puzzle snapshot is not supported' })
        continue
      }
      if (this.#supportedSnapshots && !this.#puzzleMembership.has(`${incoming.snapshotVersion}\0${incoming.puzzleId}`)) {
        rejectedAttempts.push({ attemptId: incoming.attemptId, code: 'unknown_puzzle_membership', message: 'The puzzle is absent from the signed snapshot' })
        continue
      }
      const duplicate = user.puzzleAttempts.get(incoming.attemptId)
      if (duplicate) {
        if (stablePuzzleAttempt(duplicate) === stablePuzzleAttempt(incoming)) {
          acceptedAttemptIds.push(incoming.attemptId)
          affected.add(incoming.puzzleId)
        }
        else rejectedAttempts.push({ attemptId: incoming.attemptId, code: 'conflicting_attempt_id', message: 'The attempt ID has different immutable content' })
        continue
      }
      const occurred = new Date(incoming.occurredAt)
      const future = occurred.getTime() > now.getTime() + 5 * 60_000
      const normalizedOccurredAt = future ? now.toISOString() : occurred.toISOString()
      user.sequence += 1n
      user.puzzleAttempts.set(incoming.attemptId, {
        ...incoming, normalizedOccurredAt, receivedAt: now.toISOString(), syncSequence: user.sequence,
      })
      const existing = user.puzzles.get(incoming.puzzleId)
      const solved = incoming.outcome === 'solved'
      const clean = solved && incoming.incorrectAttempts === 0 && !incoming.usedHint
      const isLatestAttempt = !existing?.lastAttemptAt || normalizedOccurredAt >= existing.lastAttemptAt
      user.puzzles.set(incoming.puzzleId, {
        puzzleId: incoming.puzzleId,
        attempts: (existing?.attempts ?? 0) + 1,
        solved: (existing?.solved ?? 0) + (solved ? 1 : 0),
        abandoned: (existing?.abandoned ?? 0) + (solved ? 0 : 1),
        cleanSolves: (existing?.cleanSolves ?? 0) + (clean ? 1 : 0),
        hintsUsed: (existing?.hintsUsed ?? 0) + (incoming.usedHint ? 1 : 0),
        incorrectMoves: (existing?.incorrectMoves ?? 0) + incoming.incorrectAttempts,
        totalElapsedMs: (existing?.totalElapsedMs ?? 0) + (incoming.elapsedMs ?? 0),
        lastElapsedMs: isLatestAttempt ? (incoming.elapsedMs ?? null) : (existing?.lastElapsedMs ?? null),
        lastAttemptAt: isLatestAttempt ? normalizedOccurredAt : existing.lastAttemptAt,
        syncSequence: user.sequence.toString(),
      })
      affected.add(incoming.puzzleId)
      acceptedAttemptIds.push(incoming.attemptId)
      if (future) rejectedAttempts.push({
        attemptId: incoming.attemptId,
        code: 'future_timestamp_normalized',
        message: 'The attempt time was over five minutes in the future and was normalized',
      })
    }
    return {
      acceptedAttemptIds,
      rejectedAttempts,
      progress: [...affected].map((puzzleId) => user.puzzles.get(puzzleId)!),
      serverTime: now.toISOString(),
    }
  }

  async syncFamilyTraining(
    userId: string,
    request: FamilyTrainingSyncRequestV1,
    now: Date,
  ): Promise<FamilyTrainingSyncResponseV1> {
    const user = this.#user(userId)
    const acceptedCoverageEventIds: string[] = []
    const acceptedCycleEventIds: string[] = []
    const rejectedRecords: FamilyTrainingRejectionV1[] = []
    const futureLimit = now.getTime() + 5 * 60_000

    for (const incoming of request.coverageEvents) {
      if (this.#unsupportedFamilyRelease(incoming.releaseId)) {
        rejectedRecords.push({
          recordId: incoming.eventId, recordType: 'coverage', code: 'unsupported_release',
          message: 'The family release is not active',
        })
        continue
      }
      if (!this.#hasFamilyPath(incoming.releaseId, incoming.familyId, incoming.packId, incoming.pathId)) {
        rejectedRecords.push({
          recordId: incoming.eventId, recordType: 'coverage', code: 'unknown_family_membership',
          message: 'The path does not belong to the referenced signed family release',
        })
        continue
      }
      const duplicate = user.familyCoverageEvents.get(incoming.eventId)
      if (duplicate) {
        if (canonicalFamilyRecord(duplicate.event) === canonicalFamilyRecord(incoming)) {
          acceptedCoverageEventIds.push(incoming.eventId)
        } else {
          rejectedRecords.push({
            recordId: incoming.eventId, recordType: 'coverage', code: 'conflicting_event_id',
            message: 'The immutable family coverage event ID has different content',
          })
        }
        continue
      }
      const logicalKey = familyCoverageLogicalKey(incoming)
      if (user.familyCoverageLogicalKeys.has(logicalKey)) {
        rejectedRecords.push({
          recordId: incoming.eventId, recordType: 'coverage', code: 'duplicate_logical_record',
          message: 'This path is already complete in the referenced coverage cycle',
        })
        continue
      }
      const completed = new Date(incoming.completedAt)
      const future = completed.getTime() > futureLimit
      user.sequence += 1n
      user.familyCoverageEvents.set(incoming.eventId, {
        event: structuredClone(incoming),
        normalizedCompletedAt: future ? now.toISOString() : completed.toISOString(),
        receivedAt: now.toISOString(),
        syncSequence: user.sequence,
      })
      user.familyCoverageLogicalKeys.add(logicalKey)
      acceptedCoverageEventIds.push(incoming.eventId)
      if (future) rejectedRecords.push({
        recordId: incoming.eventId, recordType: 'coverage', code: 'future_timestamp_normalized',
        message: 'The completion time was over five minutes in the future and was normalized',
      })
    }

    for (const incoming of request.cycleEvents) {
      if (this.#unsupportedFamilyRelease(incoming.releaseId)) {
        rejectedRecords.push({
          recordId: incoming.eventId, recordType: 'cycle', code: 'unsupported_release',
          message: 'The family release is not active',
        })
        continue
      }
      const hasMembership = incoming.kind === 'pack_bound'
        ? this.#hasFamilyPack(incoming.releaseId, incoming.familyId, incoming.packId, incoming.side)
        : this.#hasFamilySide(incoming.releaseId, incoming.familyId, incoming.side)
      if (!hasMembership) {
        rejectedRecords.push({
          recordId: incoming.eventId, recordType: 'cycle', code: 'unknown_family_membership',
          message: 'The coverage cycle does not belong to the referenced signed family release',
        })
        continue
      }
      const duplicate = user.familyCycleEvents.get(incoming.eventId)
      if (duplicate) {
        if (canonicalFamilyRecord(duplicate.event) === canonicalFamilyRecord(incoming)) {
          acceptedCycleEventIds.push(incoming.eventId)
        } else {
          rejectedRecords.push({
            recordId: incoming.eventId, recordType: 'cycle', code: 'conflicting_event_id',
            message: 'The immutable family cycle event ID has different content',
          })
        }
        continue
      }
      if (incoming.kind === 'pack_bound') {
        const hasGeneration = [...user.familyCycleEvents.values()].some(({ event }) =>
          event.kind === 'cycle_started' && event.releaseId === incoming.releaseId &&
          event.familyId === incoming.familyId && event.side === incoming.side &&
          event.generationId === incoming.generationId && event.generationOrdinal === incoming.generationOrdinal)
        if (!hasGeneration) {
          rejectedRecords.push({
            recordId: incoming.eventId, recordType: 'cycle', code: 'unknown_family_membership',
            message: 'The pack binding has no matching coverage generation',
          })
          continue
        }
      }
      const logicalKey = familyCycleLogicalKey(incoming)
      if (user.familyCycleLogicalKeys.has(logicalKey)) {
        rejectedRecords.push({
          recordId: incoming.eventId, recordType: 'cycle', code: 'duplicate_logical_record',
          message: 'This logical coverage-cycle record already exists',
        })
        continue
      }
      const occurred = new Date(incoming.occurredAt)
      const future = occurred.getTime() > futureLimit
      user.sequence += 1n
      user.familyCycleEvents.set(incoming.eventId, {
        event: structuredClone(incoming),
        normalizedOccurredAt: future ? now.toISOString() : occurred.toISOString(),
        receivedAt: now.toISOString(),
        syncSequence: user.sequence,
      })
      user.familyCycleLogicalKeys.add(logicalKey)
      acceptedCycleEventIds.push(incoming.eventId)
      if (future) rejectedRecords.push({
        recordId: incoming.eventId, recordType: 'cycle', code: 'future_timestamp_normalized',
        message: 'The cycle event time was over five minutes in the future and was normalized',
      })
    }

    let cursor: StoredFamilyCursor | null = null
    let cursorStatus: 'appended' | 'duplicate' | null = null
    if (request.cursorMutation) {
      const mutation = request.cursorMutation
      const value = mutation.value
      const packId = familyCursorPackId(value)
      this.#assertFamilyCursorMembership(value, packId)
      const priorMutation = user.familyCursorMutations.get(mutation.mutationId)
      if (priorMutation) {
        if (canonicalFamilyRecord(priorMutation.value) !== canonicalFamilyRecord(value)) {
          throw new ApiError(409, 'family_cursor_mutation_conflict', 'The immutable cursor mutation ID has different content')
        }
        cursor = priorMutation
        cursorStatus = 'duplicate'
      } else {
        const scope = familyCursorScope(value)
        const history = user.familyCursorHistory.get(scope) ?? []
        const latest = history.at(-1)
        if (latest && canonicalFamilyRecord(latest.value) === canonicalFamilyRecord(value)) {
          const alias = { ...latest, mutationId: mutation.mutationId }
          user.familyCursorMutations.set(mutation.mutationId, alias)
          cursor = alias
          cursorStatus = 'duplicate'
        } else {
          const currentVersion = latest?.version ?? 0
          if (mutation.baseVersion !== currentVersion) {
            throw new ApiError(409, 'family_cursor_version_conflict', 'Family training changed on another device; reload before saving')
          }
          if (latest) this.#assertCursorDoesNotLoseProgress(latest.value, value)
          user.sequence += 1n
          cursor = {
            version: currentVersion + 1,
            mutationId: mutation.mutationId,
            value: structuredClone(value),
            syncSequence: user.sequence.toString(),
            deviceId: request.deviceId,
          }
          history.push(cursor)
          user.familyCursorHistory.set(scope, history)
          user.familyCursorMutations.set(mutation.mutationId, cursor)
          cursorStatus = 'appended'
        }
      }
    }

    return {
      acceptedCoverageEventIds,
      acceptedCycleEventIds,
      rejectedRecords,
      cursor: cursor ? {
        version: cursor.version,
        mutationId: cursor.mutationId,
        value: structuredClone(cursor.value),
        syncSequence: cursor.syncSequence,
      } : null,
      cursorStatus,
      serverTime: now.toISOString(),
    }
  }

  async pageFamilyCoverage(
    userId: string,
    query: { releaseId: string; familyId: string; cursor: bigint; limit: number },
    now: Date,
  ): Promise<FamilyCoveragePageV1> {
    this.#assertFamilyPage(query.cursor, query.limit)
    const records = [...this.#user(userId).familyCoverageEvents.values()]
      .filter(({ event, syncSequence }) => event.releaseId === query.releaseId && event.familyId === query.familyId && syncSequence > query.cursor)
      .sort((left, right) => left.syncSequence < right.syncSequence ? -1 : left.syncSequence > right.syncSequence ? 1 : left.event.eventId.localeCompare(right.event.eventId))
    const page = records.slice(0, query.limit)
    return {
      records: page.map(({ event, syncSequence }) => ({ event: structuredClone(event), syncSequence: syncSequence.toString() })),
      nextCursor: page.at(-1)?.syncSequence.toString() ?? query.cursor.toString(),
      hasMore: records.length > page.length,
      serverTime: now.toISOString(),
    }
  }

  async pageFamilyCycles(
    userId: string,
    query: { releaseId: string; familyId: string; side: 'white' | 'black'; cursor: bigint; limit: number },
    now: Date,
  ): Promise<FamilyCyclePageV1> {
    this.#assertFamilyPage(query.cursor, query.limit)
    const records = [...this.#user(userId).familyCycleEvents.values()]
      .filter(({ event, syncSequence }) => event.releaseId === query.releaseId && event.familyId === query.familyId && event.side === query.side && syncSequence > query.cursor)
      .sort((left, right) => left.syncSequence < right.syncSequence ? -1 : left.syncSequence > right.syncSequence ? 1 : left.event.eventId.localeCompare(right.event.eventId))
    const page = records.slice(0, query.limit)
    return {
      records: page.map(({ event, syncSequence }) => ({ event: structuredClone(event), syncSequence: syncSequence.toString() })),
      nextCursor: page.at(-1)?.syncSequence.toString() ?? query.cursor.toString(),
      hasMore: records.length > page.length,
      serverTime: now.toISOString(),
    }
  }

  async loadFamilyCursor(userId: string, query: FamilyCursorQuery, now: Date): Promise<FamilyCursorResponseV1> {
    const scope = [query.releaseId, query.familyId, query.side, query.packId].join('\0')
    const history = this.#user(userId).familyCursorHistory.get(scope) ?? []
    const match = query.coverageCycleId
      ? [...history].reverse().find(({ value }) => value.coverageCycleId === query.coverageCycleId)
      : history.at(-1)
    return {
      cursor: match ? {
        version: match.version,
        mutationId: match.mutationId,
        value: structuredClone(match.value),
        syncSequence: match.syncSequence,
      } : null,
      serverTime: now.toISOString(),
    }
  }

  #unsupportedFamilyRelease(releaseId: string): boolean {
    return this.#supportedSnapshots !== null && !this.#supportedSnapshots.has(releaseId)
  }

  #hasFamilyPack(releaseId: string, familyId: string, packId: string, side: 'white' | 'black'): boolean {
    return this.#supportedSnapshots === null || this.#familyPackMembership.has(`${releaseId}\0${familyId}\0${packId}\0${side}`)
  }

  #hasFamilySide(releaseId: string, familyId: string, side: 'white' | 'black'): boolean {
    if (this.#supportedSnapshots === null) return true
    const prefix = `${releaseId}\0${familyId}\0`
    const suffix = `\0${side}`
    return [...this.#familyPackMembership].some((membership) => membership.startsWith(prefix) && membership.endsWith(suffix))
  }

  #hasFamilyPath(releaseId: string, familyId: string, packId: string, pathId: string): boolean {
    return this.#supportedSnapshots === null || this.#familyPathMembership.has(`${releaseId}\0${familyId}\0${packId}\0${pathId}`)
  }

  #assertFamilyCursorMembership(cursor: FamilyTrainingCursorV1, packId: string): void {
    if (this.#unsupportedFamilyRelease(cursor.releaseId) || !this.#hasFamilyPack(cursor.releaseId, cursor.familyId, packId, cursor.side)) {
      throw new ApiError(422, 'unknown_family_membership', 'The cursor pack does not belong to the signed family release')
    }
    for (const pathId of [...cursor.completedPathIds, ...cursor.pendingPathIds]) {
      if (!this.#hasFamilyPath(cursor.releaseId, cursor.familyId, packId, pathId)) {
        throw new ApiError(422, 'unknown_family_membership', 'The cursor contains a path outside the signed family release')
      }
    }
    if (this.#supportedSnapshots !== null) {
      for (const cardId of cursor.authoritativeDueCardIds) {
        const prefix = `${cursor.releaseId}\0${packId}\0`
        if (![...this.#snapshotMembership].some((membership) => membership.startsWith(prefix) && membership.endsWith(`\0${cardId}`))) {
          throw new ApiError(422, 'unknown_family_membership', 'The cursor contains a card outside the signed family release')
        }
      }
    }
  }

  #assertCursorDoesNotLoseProgress(previous: FamilyTrainingCursorV1, next: FamilyTrainingCursorV1): void {
    const previousOrdinal = Number(previous.coverageCycleId.split('::coverage:')[1])
    const nextOrdinal = Number(next.coverageCycleId.split('::coverage:')[1])
    if (nextOrdinal < previousOrdinal) {
      throw new ApiError(409, 'family_cursor_regression', 'A family cursor cannot move to an earlier coverage cycle')
    }
    if (nextOrdinal > previousOrdinal) return
    const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
      left.length === right.length && left.every((value) => right.includes(value))
    if (!sameSet(previous.authoritativeDueCardIds, next.authoritativeDueCardIds)) {
      throw new ApiError(409, 'family_cursor_regression', 'The authoritative due-card set cannot change within a coverage cycle')
    }
    if (previous.reviewedCardIds.some((id) => !next.reviewedCardIds.includes(id)) ||
      previous.completedPathIds.some((id) => !next.completedPathIds.includes(id)) ||
      previous.pendingPathIds.some((id) => !next.pendingPathIds.includes(id) && !next.completedPathIds.includes(id)) ||
      next.batchIndex < previous.batchIndex) {
      throw new ApiError(409, 'family_cursor_regression', 'The family cursor would discard reviewed cards or unfinished paths')
    }
  }

  #assertFamilyPage(cursor: bigint, limit: number): void {
    if (cursor < 0n || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new ApiError(422, 'invalid_cursor', 'Family training pagination is invalid')
    }
  }

  #page(
    user: UserState,
    cursor: bigint,
    limit: number,
    now: Date,
    acceptedEventIds: string[],
    rejectedEvents: SyncRejection[],
  ): SyncResponseV1 {
    const all = [...user.cards.values()]
      .filter((card) => BigInt(card.syncSequence) > cursor)
      .sort((a, b) => {
        const left = BigInt(a.syncSequence)
        const right = BigInt(b.syncSequence)
        return left === right ? a.cardId.localeCompare(b.cardId) : left < right ? -1 : 1
      })
    const cards = all.slice(0, limit)
    const nextCursor = cards.length > 0 ? cards.at(-1)!.syncSequence : user.sequence.toString()
    return {
      acceptedEventIds,
      rejectedEvents,
      cards,
      settings: user.settings,
      nextCursor,
      hasMore: all.length > cards.length,
      serverTime: now.toISOString(),
    }
  }

  async exportAccount(userId: string, now: Date): Promise<unknown> {
    const user = this.#user(userId)
    return {
      schema: 'linerecall-account-export-v5',
      exportedAt: now.toISOString(),
      settings: user.settings,
      reviewEvents: [...user.events.values()].map(({ receivedAt, normalizedOccurredAt, syncSequence, ...event }) => ({
        ...event,
        receivedAt,
        normalizedOccurredAt,
        syncSequence: syncSequence.toString(),
      })),
      cards: [...user.cards.values()],
      puzzleAttempts: [...user.puzzleAttempts.values()].map(({ syncSequence, ...attempt }) => ({
        ...attempt, syncSequence: syncSequence.toString(),
      })),
      puzzleProgress: [...user.puzzles.values()],
      familyCoverageEvents: [...user.familyCoverageEvents.values()].map(({ event, normalizedCompletedAt, receivedAt, syncSequence }) => ({
        ...event, normalizedCompletedAt, receivedAt, syncSequence: syncSequence.toString(),
      })),
      familyCycleEvents: [...user.familyCycleEvents.values()].map(({ event, normalizedOccurredAt, receivedAt, syncSequence }) => ({
        ...event, normalizedOccurredAt, receivedAt, syncSequence: syncSequence.toString(),
      })),
      familyTrainingCursors: [...user.familyCursorHistory.values()].flat().map(({ deviceId: _deviceId, ...cursor }) => cursor),
    }
  }

  async deleteAccount(userId: string, now: Date): Promise<void> {
    const state = this.#users.get(userId)
    if (!state) return
    state.events.clear()
    state.cards.clear()
    state.puzzleAttempts.clear()
    state.puzzles.clear()
    state.familyCoverageEvents.clear()
    state.familyCoverageLogicalKeys.clear()
    state.familyCycleEvents.clear()
    state.familyCycleLogicalKeys.clear()
    state.familyCursorMutations.clear()
    state.familyCursorHistory.clear()
    state.deletedAt = now.toISOString()
    this.#users.delete(userId)
  }
}

interface WindowState { count: number; resetAt: number }

export class InMemoryRateLimiter implements RateLimiter {
  readonly #windows = new Map<string, WindowState>()

  async consume(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitDecision> {
    const timestamp = now.getTime()
    let window = this.#windows.get(key)
    if (!window || window.resetAt <= timestamp) {
      window = { count: 0, resetAt: timestamp + windowMs }
      this.#windows.set(key, window)
    }
    window.count += 1
    return {
      allowed: window.count <= limit,
      limit,
      remaining: Math.max(0, limit - window.count),
      resetAt: new Date(window.resetAt),
    }
  }
}

export class HeaderAuthenticator implements Authenticator {
  constructor(private readonly enabled: boolean, private readonly clock: () => Date = () => new Date()) {}

  async authenticate(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<AuthenticatedActor | null> {
    if (!this.enabled) return null
    const userId = headers['x-linerecall-user']
    if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) return null
    return { userId, sessionId: `dev:${userId}`, authTime: this.clock() }
  }
}

export class StaticCatalogService implements CatalogService {
  readonly #puzzles: readonly PuzzleRecordV1[]

  constructor(
    private readonly value: { etag: string; manifest: unknown } = {
      etag: '"local-empty-catalog"',
      manifest: {
        schema: 'linerecall-catalog-manifest-v1',
        releaseStatus: 'unavailable',
        message: 'No signed audited catalog has been mounted in this local service',
        partitions: [],
      },
    },
    puzzles: readonly unknown[] = [],
  ) {
    this.#puzzles = PuzzleRecordListV1Schema.parse(puzzles)
  }

  async getManifest(ifNoneMatch?: string): Promise<{ etag: string; manifest: unknown } | null> {
    return ifNoneMatch === this.value.etag ? null : this.value
  }

  async listPuzzles(query: { packId?: string; cursor?: string; limit: number }): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const start = query.cursor ? Number.parseInt(query.cursor, 10) : 0
    const safeStart = Number.isSafeInteger(start) && start >= 0 ? start : 0
    const items = this.#puzzles.slice(safeStart, safeStart + query.limit)
    const next = safeStart + items.length
    return { items: [...items], nextCursor: next < this.#puzzles.length ? String(next) : null }
  }
}

interface ShareRecord { userId: string; tokenHash: Buffer; revisionId: string; expiresAt: Date | null; revokedAt: Date | null }

export class InMemoryRepertoireService implements RepertoireService {
  readonly #imports = new Map<string, { userId: string; value: unknown }>()
  readonly #repertoires = new Map<string, { userId: string; version: number; revision: unknown }>()
  readonly #shares = new Map<string, ShareRecord>()

  async createImport(userId: string, input: { name: string; pgn: string; side: 'white' | 'black' }, now: Date): Promise<unknown> {
    const id = uuidV7(now.getTime())
    const value = {
      id,
      status: 'queued',
      name: input.name,
      side: input.side,
      submittedAt: now.toISOString(),
      message: 'Awaiting isolated legality and engine analysis worker',
    }
    this.#imports.set(id, { userId, value })
    return value
  }

  async getImport(userId: string, jobId: string): Promise<unknown | null> {
    const record = this.#imports.get(jobId)
    return record?.userId === userId ? record.value : null
  }

  async update(userId: string, repertoireId: string, ifMatch: string, revision: unknown, now: Date): Promise<unknown> {
    const record = this.#repertoires.get(repertoireId)
    const expected = record ? `"${record.version}"` : '"0"'
    if (ifMatch !== expected) throw new ApiError(412, 'revision_conflict', 'The repertoire changed; reload before saving')
    if (record && record.userId !== userId) throw new ApiError(404, 'not_found', 'Repertoire not found')
    const version = (record?.version ?? 0) + 1
    const value = { userId, version, revision }
    this.#repertoires.set(repertoireId, value)
    return { repertoireId, revisionId: uuidV7(now.getTime()), version, etag: `"${version}"`, updatedAt: now.toISOString() }
  }

  async createShare(userId: string, repertoireId: string, request: unknown, now: Date): Promise<{ id: string; token: string; revisionId: string }> {
    const owner = this.#repertoires.get(repertoireId)
    if (!owner || owner.userId !== userId) throw new ApiError(404, 'not_found', 'Repertoire not found')
    const parsed = request as { revisionId: string; expiresAt: string | null }
    const id = uuidV7(now.getTime())
    const token = randomBytes(32).toString('base64url')
    this.#shares.set(id, {
      userId,
      tokenHash: createHash('sha256').update(token).digest(),
      revisionId: parsed.revisionId,
      expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
      revokedAt: null,
    })
    return { id, token, revisionId: parsed.revisionId }
  }

  async revokeShare(userId: string, shareId: string, now: Date): Promise<boolean> {
    const share = this.#shares.get(shareId)
    if (!share || share.userId !== userId) return false
    share.revokedAt = now
    return true
  }

  async resolveShare(token: string, now: Date): Promise<unknown | null> {
    const candidate = createHash('sha256').update(token).digest()
    for (const [id, share] of this.#shares) {
      if (
        share.revokedAt === null && (!share.expiresAt || share.expiresAt > now) &&
        candidate.length === share.tokenHash.length && timingSafeEqual(candidate, share.tokenHash)
      ) {
        return { id, revisionId: share.revisionId }
      }
    }
    return null
  }
}

export class DisabledExternalConnectionService implements ExternalConnectionService {
  async beginLichess(): Promise<{ authorizationUrl: string }> {
    throw new ApiError(503, 'provider_not_configured', 'Lichess connection is not configured for this deployment')
  }
  async completeLichess(): Promise<void> {
    throw new ApiError(503, 'provider_not_configured', 'Lichess connection is not configured for this deployment')
  }
  async disconnectLichess(): Promise<void> {
    throw new ApiError(503, 'provider_not_configured', 'Lichess connection is not configured for this deployment')
  }
  async revokeForAccountDeletion(): Promise<void> {
    // No provider can be connected when this adapter is active.
  }
}

export class DisabledLichessSyncService implements LichessSyncService {
  async request(): Promise<never> {
    throw new ApiError(503, 'lichess_sync_not_configured', 'Lichess game sync is not configured for this deployment')
  }

  async status(): Promise<import('../ports.js').LichessSyncStatus> {
    return {
      available: false,
      unavailableReason: 'not_configured',
      connected: false,
      consentedAt: null,
      lastSyncedAt: null,
      job: null,
    }
  }
}

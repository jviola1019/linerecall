import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  CardStateV2,
  ProgressSettingsV2,
  PuzzleAttemptSyncRequest,
  PuzzleAttemptSyncResponse,
  PuzzleAttemptV1,
  PuzzleProgressState,
  ReviewEventV1,
  SyncRejection,
  SyncRequestV1,
  SyncResponseV1,
} from '../contracts.js'
import { ProgressSettingsV2Schema } from '../contracts.js'
import { replayCard, serializeCard, type StoredReviewEvent } from '../domain/sm2.js'
import { ApiError } from '../errors.js'
import { uuidV7 } from '../ids.js'
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
  settings: { version: number; value: ProgressSettingsV2 }
  deletedAt: string | null
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
    solved: attempt.solved,
    occurredAt: attempt.occurredAt,
    snapshotVersion: attempt.snapshotVersion,
  })
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

  constructor(options: {
    supportedSnapshots?: readonly string[]
    snapshotMembership?: Readonly<Record<string, readonly { packId: string; nodeId: string; cardId: string }[]>>
    puzzleMembership?: Readonly<Record<string, readonly string[]>>
  } = {}) {
    this.#supportedSnapshots = options.supportedSnapshots ? new Set(options.supportedSnapshots) : null
    this.#snapshotMembership = new Set(Object.entries(options.snapshotMembership ?? {}).flatMap(([snapshot, memberships]) =>
      memberships.map((membership) => `${snapshot}\0${membership.packId}\0${membership.nodeId}\0${membership.cardId}`)))
    this.#puzzleMembership = new Set(Object.entries(options.puzzleMembership ?? {}).flatMap(([snapshot, puzzleIds]) =>
      puzzleIds.map((puzzleId) => `${snapshot}\0${puzzleId}`)))
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
      user.puzzles.set(incoming.puzzleId, {
        puzzleId: incoming.puzzleId,
        attempts: (existing?.attempts ?? 0) + 1,
        solved: (existing?.solved ?? 0) + (incoming.solved ? 1 : 0),
        lastAttemptAt: !existing?.lastAttemptAt || normalizedOccurredAt > existing.lastAttemptAt
          ? normalizedOccurredAt : existing.lastAttemptAt,
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
      schema: 'linerecall-account-export-v1',
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
    }
  }

  async deleteAccount(userId: string, now: Date): Promise<void> {
    const state = this.#users.get(userId)
    if (!state) return
    state.events.clear()
    state.cards.clear()
    state.puzzleAttempts.clear()
    state.puzzles.clear()
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
    private readonly puzzles: readonly unknown[] = [],
  ) {}

  async getManifest(ifNoneMatch?: string): Promise<{ etag: string; manifest: unknown } | null> {
    return ifNoneMatch === this.value.etag ? null : this.value
  }

  async listPuzzles(query: { packId?: string; cursor?: string; limit: number }): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const start = query.cursor ? Number.parseInt(query.cursor, 10) : 0
    const safeStart = Number.isSafeInteger(start) && start >= 0 ? start : 0
    const items = this.puzzles.slice(safeStart, safeStart + query.limit)
    const next = safeStart + items.length
    return { items: [...items], nextCursor: next < this.puzzles.length ? String(next) : null }
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

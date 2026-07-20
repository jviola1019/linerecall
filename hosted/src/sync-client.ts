import { CardProgressSchema, createEmptyProgress, type CardProgress, type ProgressV1, type ProgressRepository } from '../../src/domain/progress.ts'
import type { ReviewCommitMetadata } from '../../src/app/components/DrillView.tsx'
import {
  PuzzleAttemptSyncRequestSchema,
  PuzzleAttemptSyncResponseSchema,
  PuzzleAttemptV1Schema,
  ReviewEventV1Schema,
  SyncRequestV1Schema,
  SyncResponseV1Schema,
  UnsyncedExportSchema,
  type CardStateV2,
  type PuzzleAttemptV1,
  type ProgressSettingsV2,
  type ReviewEventV1,
  type SyncRejection,
  type SyncResponseV1,
} from './contracts.ts'
import { HttpProblem, expectJson, sameOriginRequest, type FetchLike } from './http.ts'

export type SyncState =
  | { status: 'idle' | 'syncing' | 'synced'; pending: number; message: string }
  | { status: 'offline' | 'error' | 'signed-out'; pending: number; message: string }
  | { status: 'rate-limited'; pending: number; message: string; retryAfterSeconds: number }

type StatusListener = (state: SyncState) => void
type CardListener = (cards: readonly CardProgress[]) => void
type ErrorListener = (error: Error) => void

interface RejectedReview {
  event: ReviewEventV1
  rejection: SyncRejection
}

const MAX_PENDING_EVENTS = 50_000
const MAX_BOOTSTRAP_PAGES = 200

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

function timeZone(): string {
  const value = Intl.DateTimeFormat().resolvedOptions().timeZone
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : 'UTC'
}

function localDate(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  if (!values.year || !values.month || !values.day) throw new Error('Could not derive the review calendar date')
  return `${values.year}-${values.month}-${values.day}`
}

function projectCard(card: CardStateV2, previous?: CardProgress): CardProgress {
  const separator = card.cardId.lastIndexOf('::')
  if (separator < 1 || separator === card.cardId.length - 2) throw new Error('Cloud card ID does not identify a repertoire node')
  const lineId = card.cardId.slice(0, separator)
  const nodeId = card.cardId.slice(separator + 2)
  return CardProgressSchema.parse({
    cardId: card.cardId,
    lineId,
    nodeId,
    repetitions: card.repetitions,
    intervalDays: card.intervalDays,
    easeFactor: card.easeFactor,
    dueAt: card.dueAt,
    lastReviewedAt: card.lastReviewedAt,
    reviewCount: previous?.reviewCount ?? (card.lastReviewedAt ? 1 : 0),
    lapseCount: previous?.lapseCount ?? 0,
  })
}

function browserSettings(progress: ProgressV1): ProgressSettingsV2 {
  return {
    locale: progress.settings.locale,
    theme: progress.settings.theme,
    manualPacing: progress.settings.manualGrading,
    reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    boardCoordinates: true,
  }
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  // Firefox and WebKit can begin the download after click() returns. Keeping the
  // temporary anchor and bounded object URL alive avoids racing that browser task.
  setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(url)
  }, 60_000)
}

export class ConnectedSyncClient {
  readonly deviceId = uuidV7()
  readonly #origin: string
  readonly #snapshotVersion: string
  readonly #fetcher: FetchLike
  readonly #pending = new Map<string, ReviewEventV1>()
  readonly #pendingPuzzleAttempts = new Map<string, PuzzleAttemptV1>()
  readonly #rejected: RejectedReview[] = []
  readonly #statusListeners = new Set<StatusListener>()
  readonly #cardListeners = new Set<CardListener>()
  readonly #errorListeners = new Set<ErrorListener>()
  readonly #cards = new Map<string, CardProgress>()
  #cursor: string | null = null
  #settingsVersion = 0
  #settings: ProgressSettingsV2 | null = null
  #pendingSettings: ProgressSettingsV2 | null = null
  #flushPromise: Promise<void> | null = null
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #state: SyncState = { status: 'idle', pending: 0, message: 'Cloud sync is ready.' }

  constructor(options: { snapshotVersion: string; origin?: string; fetcher?: FetchLike }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(options.snapshotVersion)) {
      throw new Error('Hosted snapshot version is not a safe server identifier')
    }
    this.#snapshotVersion = options.snapshotVersion
    this.#origin = new URL(options.origin ?? globalThis.location.origin).origin
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  }

  get state(): SyncState { return this.#state }
  get pendingCount(): number { return this.#pending.size + this.#pendingPuzzleAttempts.size }

  subscribeStatus(listener: StatusListener): () => void {
    this.#statusListeners.add(listener)
    listener(this.#state)
    return () => this.#statusListeners.delete(listener)
  }

  subscribeCards(listener: CardListener, onError: ErrorListener): () => void {
    this.#cardListeners.add(listener)
    this.#errorListeners.add(onError)
    if (this.#cards.size > 0) listener([...this.#cards.values()])
    return () => {
      this.#cardListeners.delete(listener)
      this.#errorListeners.delete(onError)
    }
  }

  async bootstrap(): Promise<ProgressV1> {
    this.#setState({ status: 'syncing', pending: this.pendingCount, message: 'Loading your cloud schedule…' })
    let cursor = '0'
    let pages = 0
    do {
      if (pages >= MAX_BOOTSTRAP_PAGES) throw new Error('Cloud bootstrap exceeded its bounded page limit')
      const response = await sameOriginRequest(this.#fetcher, this.#origin, `/v1/sync/bootstrap?cursor=${encodeURIComponent(cursor)}&limit=250`)
      const page = await expectJson(response, (value) => SyncResponseV1Schema.parse(value))
      this.#acceptServerPage(page)
      cursor = page.nextCursor
      pages += 1
      if (!page.hasMore) break
    } while (true)
    this.#cursor = cursor
    const progress = createEmptyProgress()
    progress.cards = Object.fromEntries([...this.#cards].map(([id, card]) => [id, card]))
    if (this.#settings) {
      progress.settings.locale = this.#settings.locale === 'en-US' ? this.#settings.locale : 'en-US'
      progress.settings.theme = this.#settings.theme === 'system'
        ? (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : this.#settings.theme
      progress.settings.manualGrading = this.#settings.manualPacing
    }
    progress.updatedAt = new Date().toISOString()
    this.#setState({ status: 'synced', pending: this.pendingCount, message: 'Cloud schedule is up to date.' })
    return progress
  }

  queueReview(commit: ReviewCommitMetadata & { card: CardProgress }): string {
    if (this.pendingCount >= MAX_PENDING_EVENTS) throw new Error('The in-memory sync queue reached its safety limit; export it before continuing')
    const occurredAt = new Date(commit.occurredAt)
    if (Number.isNaN(occurredAt.getTime())) throw new Error('Review timestamp is invalid')
    const zone = timeZone()
    const event = ReviewEventV1Schema.parse({
      eventId: uuidV7(),
      deviceId: this.deviceId,
      cardId: commit.card.cardId,
      packId: commit.lineId,
      nodeId: commit.nodeId,
      grade: commit.grade,
      occurredAt: occurredAt.toISOString(),
      localDate: localDate(occurredAt, zone),
      timeZone: zone,
      snapshotVersion: this.#snapshotVersion,
      ...(commit.correctsEventId ? { correctsEventId: commit.correctsEventId } : {}),
    })
    if (commit.kind === 'correction' && !event.correctsEventId) {
      throw new Error('A cloud grade correction must reference the review it replaces')
    }
    this.#pending.set(event.eventId, event)
    this.#setState({ status: 'idle', pending: this.pendingCount, message: `${this.pendingCount} event${this.pendingCount === 1 ? '' : 's'} waiting to sync.` })
    queueMicrotask(() => { void this.flush() })
    return event.eventId
  }

  queuePuzzleAttempt(puzzleId: string, occurredAtInput: string): string {
    if (this.pendingCount >= MAX_PENDING_EVENTS) throw new Error('The in-memory sync queue reached its safety limit; export it before continuing')
    const occurredAt = new Date(occurredAtInput)
    if (Number.isNaN(occurredAt.getTime())) throw new Error('Puzzle attempt timestamp is invalid')
    const attempt = PuzzleAttemptV1Schema.parse({
      attemptId: uuidV7(),
      deviceId: this.deviceId,
      puzzleId,
      solved: true,
      occurredAt: occurredAt.toISOString(),
      snapshotVersion: this.#snapshotVersion,
    })
    this.#pendingPuzzleAttempts.set(attempt.attemptId, attempt)
    this.#setState({
      status: 'idle', pending: this.pendingCount,
      message: `${this.pendingCount} event${this.pendingCount === 1 ? '' : 's'} waiting to sync.`,
    })
    queueMicrotask(() => { void this.flush() })
    return attempt.attemptId
  }

  queueSettings(progress: ProgressV1): void {
    const settings = browserSettings(progress)
    if (JSON.stringify(settings) === JSON.stringify(this.#settings)) return
    this.#pendingSettings = settings
    queueMicrotask(() => { void this.flush() })
  }

  async flush(): Promise<void> {
    if (this.#flushPromise) return this.#flushPromise
    this.#flushPromise = this.#flush()
    try {
      await this.#flushPromise
    } finally {
      this.#flushPromise = null
    }
  }

  async #flush(): Promise<void> {
    if (this.pendingCount === 0 && this.#pendingSettings === null) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.#setState({ status: 'offline', pending: this.pendingCount, message: 'Offline. Study events are held in memory; export before leaving.' })
      return
    }
    this.#setState({ status: 'syncing', pending: this.pendingCount, message: 'Syncing study events…' })
    try {
      if (this.#pending.size > 0 || this.#pendingSettings !== null) {
        const events = [...this.#pending.values()].slice(0, 250)
        const request = SyncRequestV1Schema.parse({
          deviceId: this.deviceId,
          cursor: this.#cursor,
          events,
          ...(this.#pendingSettings ? { settingsMutation: { baseVersion: this.#settingsVersion, value: this.#pendingSettings } } : {}),
        })
        const response = await sameOriginRequest(this.#fetcher, this.#origin, '/v1/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
        })
        const result = await expectJson(response, (value) => SyncResponseV1Schema.parse(value))
        const accepted = new Set(result.acceptedEventIds)
        for (const id of accepted) this.#pending.delete(id)
        for (const rejection of result.rejectedEvents) {
          const event = this.#pending.get(rejection.eventId)
          if (!event) continue
          if (rejection.code !== 'future_timestamp_normalized') {
            this.#rejected.push({ event, rejection })
            this.#pending.delete(rejection.eventId)
          }
        }
        this.#pendingSettings = null
        this.#acceptServerPage(result)
      }
      if (this.#pendingPuzzleAttempts.size > 0) {
        const attempts = [...this.#pendingPuzzleAttempts.values()].slice(0, 100)
        const request = PuzzleAttemptSyncRequestSchema.parse({ deviceId: this.deviceId, attempts })
        const response = await sameOriginRequest(this.#fetcher, this.#origin, '/v1/puzzles/attempts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
        })
        const result = await expectJson(response, (value) => PuzzleAttemptSyncResponseSchema.parse(value))
        for (const id of result.acceptedAttemptIds) this.#pendingPuzzleAttempts.delete(id)
        for (const rejection of result.rejectedAttempts) {
          if (rejection.code !== 'future_timestamp_normalized') this.#pendingPuzzleAttempts.delete(rejection.attemptId)
        }
      }
      this.#setState({
        status: 'synced',
        pending: this.pendingCount,
        message: this.pendingCount === 0 ? 'Cloud study history is up to date.' : `${this.pendingCount} events remain queued.`,
      })
      if (this.pendingCount > 0) queueMicrotask(() => { void this.flush() })
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Cloud sync failed')
      if (cause instanceof HttpProblem && cause.status === 401) {
        this.#setState({ status: 'signed-out', pending: this.pendingCount, message: 'Your session ended. Export queued events or sign in again.' })
      } else if (cause instanceof HttpProblem && cause.status === 429 && cause.retryAfterSeconds) {
        this.#setState({ status: 'rate-limited', pending: this.pendingCount, message: 'Sync is temporarily rate-limited.', retryAfterSeconds: cause.retryAfterSeconds })
        if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
        this.#retryTimer = setTimeout(() => { this.#retryTimer = null; void this.flush() }, cause.retryAfterSeconds * 1_000)
      } else {
        this.#setState({ status: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error', pending: this.pendingCount, message: `${error.message} Study events remain in memory.` })
      }
      this.#notifyError(error)
    }
  }

  #acceptServerPage(response: SyncResponseV1): void {
    this.#cursor = response.nextCursor
    this.#settingsVersion = response.settings.version
    this.#settings = response.settings.value
    const changed: CardProgress[] = []
    for (const raw of response.cards) {
      const card = projectCard(raw, this.#cards.get(raw.cardId))
      this.#cards.set(card.cardId, card)
      changed.push(card)
    }
    if (changed.length > 0) for (const listener of this.#cardListeners) listener(changed)
  }

  #setState(state: SyncState): void {
    this.#state = state
    for (const listener of this.#statusListeners) listener(state)
  }

  #notifyError(error: Error): void {
    for (const listener of this.#errorListeners) listener(error)
  }

  exportUnsynced(): void {
    const payload = UnsyncedExportSchema.parse({
      schema: 'linerecall-unsynced-events-v2',
      exportedAt: new Date().toISOString(),
      deviceId: this.deviceId,
      snapshotVersion: this.#snapshotVersion,
      pendingEvents: [...this.#pending.values()],
      rejectedEvents: this.#rejected,
      pendingPuzzleAttempts: [...this.#pendingPuzzleAttempts.values()],
    })
    downloadJson(`linerecall-unsynced-${new Date().toISOString().slice(0, 10)}.json`, payload)
  }
}

export class CloudProgressRepository implements ProgressRepository {
  readonly kind = 'cloud' as const
  #current: ProgressV1 | null = null

  constructor(private readonly sync: ConnectedSyncClient) {}

  async load(): Promise<ProgressV1 | null> {
    this.#current = await this.sync.bootstrap()
    return this.#current
  }

  async save(progress: ProgressV1): Promise<void> {
    this.#current = progress
    this.sync.queueSettings(progress)
  }

  async clear(): Promise<void> {
    throw new Error('Cloud progress can be deleted only through the recent-authenticated account deletion flow')
  }
}

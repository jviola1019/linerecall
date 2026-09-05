import { z } from 'zod'
import {
  CardIdSchema,
  ProgressV1Schema,
  createEmptyProgress,
  type ProgressRepository,
  type ProgressV1,
} from '../domain/progress.ts'

export const MAX_PROGRESS_IMPORT_BYTES = 1024 * 1024
export const PROGRESS_STORAGE_TIMEOUT_MS = 5_000

export function withProgressStorageTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = PROGRESS_STORAGE_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Storage timeout must be a positive duration')
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs)
    void operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

const LegacyProgressV0Schema = z.object({
  version: z.literal(0),
  updatedAt: z.string().datetime({ offset: true }),
  cards: z.record(CardIdSchema, z.object({
    cardId: z.string().min(1),
    lineId: z.string().min(1),
    nodeId: z.string().min(1),
    repetitions: z.number().int().nonnegative(),
    intervalDays: z.number().int().nonnegative(),
    easeFactor: z.number().min(1.3),
    dueAt: z.string().datetime({ offset: true }),
    lastReviewedAt: z.string().datetime({ offset: true }).nullable(),
    reviewCount: z.number().int().nonnegative().optional(),
    lapseCount: z.number().int().nonnegative().optional(),
  }).strict()),
  streak: z.object({
    current: z.number().int().nonnegative(),
    lastLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
  }).strict().optional(),
  settings: z.object({
    theme: z.enum(['dark', 'light']).optional(),
    boardOrientation: z.enum(['white', 'black']).optional(),
  }).strict().optional(),
}).strict()

const RESERVED_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function rejectReservedProgressKeys(value: unknown): void {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'cards')) return
  const cards = (value as { cards?: unknown }).cards
  if (typeof cards !== 'object' || cards === null) return
  const reserved = Object.keys(cards).find((key) => RESERVED_RECORD_KEYS.has(key))
  if (reserved) throw new Error(`Progress cards contain a reserved record key: ${reserved}`)
}

function containsMalformedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

export function migrateProgress(value: unknown): ProgressV1 {
  rejectReservedProgressKeys(value)
  const current = ProgressV1Schema.safeParse(value)
  if (current.success) return current.data
  const legacy = LegacyProgressV0Schema.parse(value)
  const defaults = createEmptyProgress(new Date(legacy.updatedAt))
  return ProgressV1Schema.parse({
    version: 1,
    updatedAt: legacy.updatedAt,
    cards: Object.fromEntries(Object.entries(legacy.cards).map(([id, card]) => [
      id,
      { ...card, reviewCount: card.reviewCount ?? 0, lapseCount: card.lapseCount ?? 0 },
    ])),
    streak: legacy.streak ?? defaults.streak,
    settings: {
      ...defaults.settings,
      ...legacy.settings,
    },
  })
}

export function importProgressJson(source: string): ProgressV1 {
  const bytes = new TextEncoder().encode(source).byteLength
  if (bytes > MAX_PROGRESS_IMPORT_BYTES) throw new Error('Progress file exceeds the 1 MB limit')
  if (source.includes('\0')) throw new Error('Progress file contains a forbidden NUL character')
  if (containsMalformedUnicode(source)) throw new Error('Progress file contains malformed Unicode')
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  } catch {
    throw new Error('Progress file is not valid JSON')
  }
  try {
    return migrateProgress(parsed)
  } catch {
    throw new Error('Progress file has an unsupported version or invalid fields')
  }
}

export function exportProgressJson(progress: ProgressV1): string {
  return `${JSON.stringify(ProgressV1Schema.parse(progress), null, 2)}\n`
}

export class MemoryProgressRepository implements ProgressRepository {
  readonly kind = 'memory' as const
  #value: ProgressV1 | null

  constructor(initial: ProgressV1 | null = null) {
    this.#value = initial === null ? null : structuredClone(ProgressV1Schema.parse(initial))
  }

  async load(): Promise<ProgressV1 | null> {
    return this.#value === null ? null : structuredClone(this.#value)
  }

  async save(progress: ProgressV1): Promise<void> {
    this.#value = structuredClone(ProgressV1Schema.parse(progress))
  }

  async clear(): Promise<void> {
    this.#value = null
  }
}

export async function selectProgressRepository(): Promise<{ repository: ProgressRepository; warning: string | null }> {
  return {
    repository: new MemoryProgressRepository(),
    warning: 'Session-only progress is active. Export JSON before leaving.',
  }
}

export class DebouncedProgressWriter {
  readonly #repository: ProgressRepository
  readonly #onError: (error: Error) => void
  readonly #delayMs: number
  #timer: ReturnType<typeof setTimeout> | null = null
  #pending: ProgressV1 | null = null
  #inFlight: Promise<void> = Promise.resolve()

  constructor(
    repository: ProgressRepository,
    onError: (error: Error) => void,
    delayMs = 300,
  ) {
    this.#repository = repository
    this.#onError = onError
    this.#delayMs = delayMs
  }

  schedule(progress: ProgressV1): void {
    this.#pending = ProgressV1Schema.parse(progress)
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, this.#delayMs)
  }

  async flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const pending = this.#pending
    this.#pending = null
    if (pending === null) return this.#inFlight
    const completion = this.#enqueue(pending)
    await completion.catch(() => undefined)
  }

  /**
   * Persist a review before the UI claims it was recorded. This supersedes a
   * pending debounced snapshot and participates in the same serialized write
   * chain as settings/import writes.
   */
  async saveImmediately(progress: ProgressV1): Promise<void> {
    const validated = ProgressV1Schema.parse(progress)
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#pending = null
    await this.#enqueue(validated)
  }

  #enqueue(progress: ProgressV1): Promise<void> {
    const completion = this.#inFlight.then(() => this.#repository.save(progress))
    const reported = completion.catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error))
      this.#onError(normalized)
      throw normalized
    })
    this.#inFlight = reported.catch(() => undefined)
    return reported
  }
}

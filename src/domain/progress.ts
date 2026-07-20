import { z } from 'zod'
import { RuntimeLocaleIdSchema } from '../i18n/localization.ts'

export const ReviewGradeSchema = z.enum(['again', 'hard', 'good', 'easy'])
export type ReviewGrade = z.infer<typeof ReviewGradeSchema>

const RESERVED_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
export const CardIdSchema = z.string().min(1).max(300).refine(
  (value) => !RESERVED_RECORD_KEYS.has(value),
  'Reserved object property names cannot be used as card IDs',
)

const ProgressLineIdSchema = z.string().min(1).max(220).refine(
  (value) => !RESERVED_RECORD_KEYS.has(value),
  'Reserved object property names cannot be used as line IDs',
)
const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
const ReviewStreakSchema = z.object({
  current: z.number().int().nonnegative(),
  lastLocalDate: LocalDateSchema.nullable(),
}).strict()

export const CardProgressSchema = z.object({
  cardId: CardIdSchema,
  lineId: ProgressLineIdSchema,
  nodeId: z.string().min(1).max(240),
  repetitions: z.number().int().nonnegative(),
  intervalDays: z.number().int().nonnegative(),
  easeFactor: z.number().min(1.3).max(10),
  dueAt: z.string().datetime({ offset: true }),
  lastReviewedAt: z.string().datetime({ offset: true }).nullable(),
  reviewCount: z.number().int().nonnegative(),
  lapseCount: z.number().int().nonnegative(),
}).strict()

export const ProgressV1Schema = z.object({
  version: z.literal(1),
  updatedAt: z.string().datetime({ offset: true }),
  cards: z.record(CardIdSchema, CardProgressSchema),
  streak: ReviewStreakSchema,
  openingStreaks: z.record(ProgressLineIdSchema, ReviewStreakSchema).default({}),
  variationStreaks: z.record(ProgressLineIdSchema, ReviewStreakSchema).default({}),
  settings: z.object({
    locale: RuntimeLocaleIdSchema.default('en-US'),
    theme: z.enum(['dark', 'light']),
    boardOrientation: z.enum(['white', 'black']),
    reducedSound: z.boolean(),
    reducedMotion: z.boolean().default(false),
    manualGrading: z.boolean().default(false),
  }).strict(),
}).strict().superRefine((progress, context) => {
  for (const [key, card] of Object.entries(progress.cards)) {
    if (key !== card.cardId) {
      context.addIssue({ code: 'custom', message: 'Card map key must equal cardId', path: ['cards', key] })
    }
    if (card.cardId !== `${card.lineId}::${card.nodeId}`) {
      context.addIssue({
        code: 'custom',
        message: 'cardId must equal lineId + "::" + nodeId',
        path: ['cards', key, 'cardId'],
      })
    }
  }
  if (Object.keys(progress.openingStreaks).length > 10_000 || Object.keys(progress.variationStreaks).length > 10_000) {
    context.addIssue({ code: 'custom', message: 'Progress contains too many streak records', path: ['variationStreaks'] })
  }
})

export type CardProgress = z.infer<typeof CardProgressSchema>
export type ProgressV1 = z.infer<typeof ProgressV1Schema>

export interface ProgressRepository {
  readonly kind: 'artifact' | 'cloud' | 'memory'
  load(): Promise<ProgressV1 | null>
  save(progress: ProgressV1): Promise<void>
  clear(): Promise<void>
}

export interface ReviewContext {
  incorrectAttempts: number
  usedHint: boolean
  playedPlayableAlternative: boolean
}

export interface ReviewOutcome {
  card: CardProgress
  mastery: number
  repeatAtSessionEnd: boolean
}

const QUALITY: Readonly<Record<ReviewGrade, 0 | 3 | 4 | 5>> = Object.freeze({
  again: 0,
  hard: 3,
  good: 4,
  easy: 5,
})

const DAY_MS = 86_400_000

export function createCard(cardId: string, lineId: string, nodeId: string, now: Date): CardProgress {
  return CardProgressSchema.parse({
    cardId,
    lineId,
    nodeId,
    repetitions: 0,
    intervalDays: 0,
    easeFactor: 2.5,
    dueAt: now.toISOString(),
    lastReviewedAt: null,
    reviewCount: 0,
    lapseCount: 0,
  })
}

export function defaultReviewGrade(context: ReviewContext): ReviewGrade {
  if (context.incorrectAttempts > 0) return 'again'
  if (context.usedHint || context.playedPlayableAlternative) return 'hard'
  return 'good'
}

export function masteryPercent(card: Pick<CardProgress, 'repetitions' | 'intervalDays'>): number {
  if (card.repetitions === 0) return 0
  return Math.round(Math.min(100, (100 * Math.log(1 + card.intervalDays)) / Math.log(31)))
}

export function meanMastery(cards: readonly Pick<CardProgress, 'repetitions' | 'intervalDays'>[]): number {
  if (cards.length === 0) return 0
  return Math.round(cards.reduce((sum, card) => sum + masteryPercent(card), 0) / cards.length)
}

export function scheduleReview(
  existing: CardProgress,
  grade: ReviewGrade,
  now: Date,
): ReviewOutcome {
  const card = CardProgressSchema.parse(existing)
  if (Number.isNaN(now.getTime())) throw new Error('Review time is invalid')
  const quality = QUALITY[ReviewGradeSchema.parse(grade)]
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)
  const easeFactor = Math.max(1.3, Math.round((card.easeFactor + delta) * 100) / 100)
  const failed = quality < 3
  let repetitions: number
  let intervalDays: number
  if (failed) {
    repetitions = 0
    intervalDays = 1
  } else {
    repetitions = card.repetitions + 1
    intervalDays = repetitions === 1
      ? 1
      : repetitions === 2
        ? 6
        : Math.max(1, Math.round(card.intervalDays * easeFactor))
  }
  const dueAt = new Date(now.getTime() + intervalDays * DAY_MS).toISOString()
  const updated = CardProgressSchema.parse({
    ...card,
    repetitions,
    intervalDays,
    easeFactor,
    dueAt,
    lastReviewedAt: now.toISOString(),
    reviewCount: card.reviewCount + 1,
    lapseCount: card.lapseCount + (failed ? 1 : 0),
  })
  return {
    card: updated,
    mastery: masteryPercent(updated),
    repeatAtSessionEnd: failed,
  }
}

export function localDateKey(date: Date, timeZone?: string): string {
  if (Number.isNaN(date.getTime())) throw new Error('Date is invalid')
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  if (!parts.year || !parts.month || !parts.day) throw new Error('Could not derive a local calendar date')
  return `${parts.year}-${parts.month}-${parts.day}`
}

function dayNumber(key: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(key)) throw new Error('Local date key is invalid')
  const [year, month, day] = key.split('-').map(Number)
  const timestamp = Date.UTC(year!, month! - 1, day!)
  const normalized = new Date(timestamp).toISOString().slice(0, 10)
  if (normalized !== key) throw new Error('Local date key is not a real calendar date')
  return timestamp / DAY_MS
}

export function updateReviewStreak(
  streak: ProgressV1['streak'],
  reviewLocalDate: string,
): ProgressV1['streak'] {
  const nextDay = dayNumber(reviewLocalDate)
  if (streak.lastLocalDate === null) return { current: 1, lastLocalDate: reviewLocalDate }
  const previousDay = dayNumber(streak.lastLocalDate)
  if (nextDay < previousDay) return { ...streak }
  if (nextDay === previousDay) return { ...streak }
  return {
    current: nextDay === previousDay + 1 ? streak.current + 1 : 1,
    lastLocalDate: reviewLocalDate,
  }
}

const AUDITED_VARIANT_ID = /^(tax_[a-f0-9]{24}):(white|black)$/u

/**
 * Updates both variation and opening streaks for one audited review. Records
 * from older compatible ProgressV1 files start at zero until reviewed again.
 */
export function updateScopedReviewStreaks(
  progress: Pick<ProgressV1, 'openingStreaks' | 'variationStreaks'>,
  variationId: string,
  reviewLocalDate: string,
): Pick<ProgressV1, 'openingStreaks' | 'variationStreaks'> {
  const parsed = AUDITED_VARIANT_ID.exec(variationId)
  if (!parsed?.[1]) throw new Error('Reviewed card does not belong to an audited variation')
  const sourceLineId = parsed[1]
  const empty = { current: 0, lastLocalDate: null }
  return {
    variationStreaks: {
      ...progress.variationStreaks,
      [variationId]: updateReviewStreak(progress.variationStreaks[variationId] ?? empty, reviewLocalDate),
    },
    openingStreaks: {
      ...progress.openingStreaks,
      [sourceLineId]: updateReviewStreak(progress.openingStreaks[sourceLineId] ?? empty, reviewLocalDate),
    },
  }
}

export function createEmptyProgress(now = new Date()): ProgressV1 {
  return ProgressV1Schema.parse({
    version: 1,
    updatedAt: now.toISOString(),
    cards: {},
    streak: { current: 0, lastLocalDate: null },
    openingStreaks: {},
    variationStreaks: {},
    settings: { locale: 'en-US', theme: 'dark', boardOrientation: 'white', reducedSound: false, reducedMotion: false, manualGrading: false },
  })
}

export function enqueueFailedCard(sessionQueue: readonly string[], cardId: string): string[] {
  return [...sessionQueue.filter((queued) => queued !== cardId), cardId]
}

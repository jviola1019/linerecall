import { z } from 'zod'

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
export const SQUARE = /^[a-h][1-8]$/
const DISALLOWED_TEXT = /[\u0000-\u001F\u007F-\u009F]/u
const LONE_SURROGATE = /[\uD800-\uDFFF]/u

function SafeText(maximum: number) {
  return z.string().trim().min(1).max(maximum)
    .refine((value) => !DISALLOWED_TEXT.test(value), 'Text contains disallowed control characters')
    .refine((value) => !LONE_SURROGATE.test(value), 'Text contains malformed Unicode')
}

export const GradeSchema = z.enum(['again', 'hard', 'good', 'easy'])
export type Grade = z.infer<typeof GradeSchema>

export const ReviewEventV1Schema = z.object({
  eventId: z.string().regex(UUID_V7),
  deviceId: z.string().regex(UUID_V7),
  cardId: z.string().regex(SAFE_ID),
  packId: z.string().regex(SAFE_ID),
  nodeId: z.string().regex(SAFE_ID),
  grade: GradeSchema,
  occurredAt: z.string().datetime({ offset: true }),
  localDate: z.iso.date(),
  timeZone: z.string().min(1).max(64),
  snapshotVersion: z.string().regex(SAFE_ID),
  // Corrections are append-only and are accepted only for the most recent review
  // of the same card. This preserves immutable event IDs while supporting the
  // product's short grade-edit window.
  correctsEventId: z.string().regex(UUID_V7).optional(),
}).strict()
export type ReviewEventV1 = z.infer<typeof ReviewEventV1Schema>

export const ProgressSettingsV2Schema = z.object({
  locale: z.enum(['en-US', 'es', 'de', 'fr', 'pt-BR', 'pl', 'ar']).default('en-US'),
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  manualPacing: z.boolean().default(false),
  reducedMotion: z.boolean().default(false),
  boardCoordinates: z.boolean().default(true),
}).strict()
export type ProgressSettingsV2 = z.infer<typeof ProgressSettingsV2Schema>

export const SettingsMutationSchema = z.object({
  baseVersion: z.number().int().nonnegative(),
  value: ProgressSettingsV2Schema,
}).strict()

export const SyncRequestV1Schema = z.object({
  deviceId: z.string().regex(UUID_V7),
  cursor: z.string().regex(/^\d+$/).nullable(),
  events: z.array(ReviewEventV1Schema).max(250),
  settingsMutation: SettingsMutationSchema.optional(),
}).strict().superRefine((value, context) => {
  for (const [index, event] of value.events.entries()) {
    if (event.deviceId !== value.deviceId) {
      context.addIssue({
        code: 'custom',
        path: ['events', index, 'deviceId'],
        message: 'Event deviceId must match request deviceId',
      })
    }
  }
})
export type SyncRequestV1 = z.infer<typeof SyncRequestV1Schema>

export const CardStateV2Schema = z.object({
  cardId: z.string().regex(SAFE_ID),
  repetitions: z.number().int().nonnegative(),
  intervalDays: z.number().int().nonnegative(),
  easeFactor: z.number().min(1.3).max(3.5),
  dueAt: z.string().datetime({ offset: true }),
  lastReviewedAt: z.string().datetime({ offset: true }).nullable(),
  mastery: z.number().int().min(0).max(100),
  lastEventId: z.string().regex(UUID_V7).nullable(),
  syncSequence: z.string().regex(/^\d+$/),
}).strict()
export type CardStateV2 = z.infer<typeof CardStateV2Schema>

export const VersionedSettingsV2Schema = z.object({
  version: z.number().int().nonnegative(),
  value: ProgressSettingsV2Schema,
}).strict()
export type VersionedSettingsV2 = z.infer<typeof VersionedSettingsV2Schema>

export const SyncRejectionSchema = z.object({
  eventId: z.string(),
  code: z.enum([
    'conflicting_event_id',
    'invalid_correction',
    'future_timestamp_normalized',
    'unsupported_snapshot',
    'unknown_card_membership',
  ]),
  message: z.string().max(256),
}).strict()
export type SyncRejection = z.infer<typeof SyncRejectionSchema>

export const SyncResponseV1Schema = z.object({
  acceptedEventIds: z.array(z.string().regex(UUID_V7)),
  rejectedEvents: z.array(SyncRejectionSchema),
  cards: z.array(CardStateV2Schema),
  settings: VersionedSettingsV2Schema,
  nextCursor: z.string().regex(/^\d+$/),
  hasMore: z.boolean(),
  serverTime: z.string().datetime({ offset: true }),
}).strict()
export type SyncResponseV1 = z.infer<typeof SyncResponseV1Schema>

export const BootstrapQuerySchema = z.object({
  cursor: z.string().regex(/^\d+$/).default('0'),
  limit: z.coerce.number().int().min(1).max(500).default(250),
}).strict()

export const PuzzleQuerySchema = z.object({
  packId: z.string().regex(SAFE_ID).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict()

export const PuzzleAttemptV1Schema = z.object({
  attemptId: z.string().regex(UUID_V7),
  deviceId: z.string().regex(UUID_V7),
  puzzleId: z.string().regex(SAFE_ID),
  solved: z.boolean(),
  occurredAt: z.string().datetime({ offset: true }),
  snapshotVersion: z.string().regex(SAFE_ID),
}).strict()
export type PuzzleAttemptV1 = z.infer<typeof PuzzleAttemptV1Schema>

export const PuzzleAttemptSyncRequestSchema = z.object({
  deviceId: z.string().regex(UUID_V7),
  attempts: z.array(PuzzleAttemptV1Schema).min(1).max(100),
}).strict().superRefine((value, context) => {
  for (const [index, attempt] of value.attempts.entries()) {
    if (attempt.deviceId !== value.deviceId) context.addIssue({
      code: 'custom', path: ['attempts', index, 'deviceId'], message: 'Attempt deviceId must match request deviceId',
    })
  }
})
export type PuzzleAttemptSyncRequest = z.infer<typeof PuzzleAttemptSyncRequestSchema>

export const PuzzleProgressStateSchema = z.object({
  puzzleId: z.string().regex(SAFE_ID),
  attempts: z.number().int().nonnegative(),
  solved: z.number().int().nonnegative(),
  lastAttemptAt: z.string().datetime({ offset: true }).nullable(),
  syncSequence: z.string().regex(/^\d+$/),
}).strict()
export type PuzzleProgressState = z.infer<typeof PuzzleProgressStateSchema>

export const PuzzleAttemptSyncResponseSchema = z.object({
  acceptedAttemptIds: z.array(z.string().regex(UUID_V7)),
  rejectedAttempts: z.array(z.object({
    attemptId: z.string(),
    code: z.enum(['conflicting_attempt_id', 'unsupported_snapshot', 'unknown_puzzle_membership', 'future_timestamp_normalized']),
    message: z.string().max(256),
  }).strict()),
  progress: z.array(PuzzleProgressStateSchema),
  serverTime: z.string().datetime({ offset: true }),
}).strict()
export type PuzzleAttemptSyncResponse = z.infer<typeof PuzzleAttemptSyncResponseSchema>

export const ImportRepertoireSchema = z.object({
  name: SafeText(128),
  pgn: z.string().min(1).max(1_000_000),
  side: z.enum(['white', 'black']),
}).strict()

export const RepertoireRevisionSchema = z.object({
  name: SafeText(128),
  side: z.enum(['white', 'black']),
  rootNodeId: z.string().regex(SAFE_ID),
  nodeIds: z.array(z.string().regex(SAFE_ID)).min(1).max(20_000),
  annotations: z.array(z.object({
    from: z.string().regex(SQUARE),
    to: z.string().regex(SQUARE).optional(),
    kind: z.enum(['arrow', 'circle']),
    style: z.enum(['hint', 'expected', 'played', 'variation']),
    label: SafeText(64).optional(),
  }).strict()).max(32).default([]),
}).strict()

export const ShareRequestSchema = z.object({
  revisionId: z.string().regex(UUID_V7),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
}).strict()

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    retryAfterSeconds: z.number().int().positive().optional(),
    details: z.array(z.object({ path: z.string(), message: z.string() }).strict()).optional(),
  }).strict(),
}).strict()
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

export function validationDetails(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))
}

export function validateImportPgnBounds(pgn: string): void {
  if (pgn.includes('\0') || /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(pgn)) {
    throw new Error('PGN contains disallowed control characters')
  }
  if (LONE_SURROGATE.test(pgn)) throw new Error('PGN contains malformed Unicode')
  const lines = pgn.split(/\r?\n/u)
  if (lines.some((line) => line.length > 8_192)) throw new Error('PGN line exceeds 8,192 characters')
  if (lines.filter((line) => /^\s*\[/u.test(line)).length > 512) throw new Error('PGN contains too many headers')

  const movetext = lines.filter((line) => !/^\s*\[/u.test(line)).join('\n')

  let depth = 0
  let variations = 0
  let inBraceComment = false
  let inLineComment = false
  let tokens = 0
  let plyCount = 0
  let token = ''
  let commentLength = 0
  const finishToken = (): void => {
    if (!token) return
    tokens += 1
    let candidate = token.replace(/^\d+\.(?:\.\.)?/u, '')
    if (
      candidate &&
      !/^(?:\d+\.{1,3}|\$\d+|1-0|0-1|1\/2-1\/2|\*|[!?]+)$/u.test(candidate)
    ) plyCount += 1
    token = ''
    if (tokens > 100_000) throw new Error('PGN contains too many tokens')
    if (plyCount > 20_000) throw new Error('PGN contains more than 20,000 plies')
  }
  for (const character of movetext) {
    if (inLineComment) {
      commentLength += 1
      if (commentLength > 4_096) throw new Error('PGN comment exceeds 4,096 characters')
      if (character === '\n') { inLineComment = false; commentLength = 0 }
      continue
    }
    if (inBraceComment) {
      commentLength += 1
      if (commentLength > 4_096) throw new Error('PGN comment exceeds 4,096 characters')
      if (character === '}') inBraceComment = false
      continue
    }
    if (character === '{') { finishToken(); inBraceComment = true; commentLength = 0; continue }
    if (character === ';') { finishToken(); inLineComment = true; commentLength = 0; continue }
    if (character === '(') {
      finishToken()
      variations += 1
      depth += 1
      if (variations > 5_000) throw new Error('PGN contains more than 5,000 variations')
      if (depth > 32) throw new Error('PGN variation nesting exceeds 32')
    } else if (character === ')') {
      finishToken()
      depth -= 1
      if (depth < 0) throw new Error('PGN contains an unmatched closing variation')
    }
    const separator = /\s|[(){};]/u.test(character)
    if (separator) finishToken()
    else {
      token += character
      if (token.length > 256) throw new Error('PGN token exceeds 256 characters')
    }
  }
  finishToken()
  if (inBraceComment) throw new Error('PGN contains an unterminated comment')
  if (depth !== 0) throw new Error('PGN contains an unterminated variation')
}

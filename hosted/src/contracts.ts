import { z } from 'zod'

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
export const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u

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
  correctsEventId: z.string().regex(UUID_V7).optional(),
}).strict()
export type ReviewEventV1 = z.infer<typeof ReviewEventV1Schema>

export const ProgressSettingsV2Schema = z.object({
  locale: z.enum(['en-US', 'es', 'de', 'fr', 'pt-BR', 'pl', 'ar']),
  theme: z.enum(['dark', 'light', 'system']),
  manualPacing: z.boolean(),
  reducedMotion: z.boolean(),
  boardCoordinates: z.boolean(),
}).strict()
export type ProgressSettingsV2 = z.infer<typeof ProgressSettingsV2Schema>

export const SyncRequestV1Schema = z.object({
  deviceId: z.string().regex(UUID_V7),
  cursor: z.string().regex(/^\d+$/u).nullable(),
  events: z.array(ReviewEventV1Schema).max(250),
  settingsMutation: z.object({
    baseVersion: z.number().int().nonnegative(),
    value: ProgressSettingsV2Schema,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  value.events.forEach((event, index) => {
    if (event.deviceId !== value.deviceId) {
      context.addIssue({ code: 'custom', path: ['events', index, 'deviceId'], message: 'Event device ID differs from request device ID' })
    }
  })
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
  syncSequence: z.string().regex(/^\d+$/u),
}).strict()
export type CardStateV2 = z.infer<typeof CardStateV2Schema>

export const SyncRejectionSchema = z.object({
  eventId: z.string().regex(UUID_V7),
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
  acceptedEventIds: z.array(z.string().regex(UUID_V7)).max(250),
  rejectedEvents: z.array(SyncRejectionSchema).max(250),
  cards: z.array(CardStateV2Schema).max(500),
  settings: z.object({
    version: z.number().int().nonnegative(),
    value: ProgressSettingsV2Schema,
  }).strict(),
  nextCursor: z.string().regex(/^\d+$/u),
  hasMore: z.boolean(),
  serverTime: z.string().datetime({ offset: true }),
}).strict()
export type SyncResponseV1 = z.infer<typeof SyncResponseV1Schema>

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
}).strict()
export const PuzzleAttemptSyncResponseSchema = z.object({
  acceptedAttemptIds: z.array(z.string().regex(UUID_V7)).max(100),
  rejectedAttempts: z.array(z.object({
    attemptId: z.string(),
    code: z.enum(['conflicting_attempt_id', 'unsupported_snapshot', 'unknown_puzzle_membership', 'future_timestamp_normalized']),
    message: z.string().max(256),
  }).strict()).max(100),
  progress: z.array(z.object({
    puzzleId: z.string().regex(SAFE_ID), attempts: z.number().int().nonnegative(), solved: z.number().int().nonnegative(),
    lastAttemptAt: z.string().datetime({ offset: true }).nullable(), syncSequence: z.string().regex(/^\d+$/u),
  }).strict()).max(100),
  serverTime: z.string().datetime({ offset: true }),
}).strict()

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(512),
    requestId: z.string().min(1).max(128),
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
    details: z.array(z.object({ path: z.string().max(256), message: z.string().max(256) }).strict()).max(20).optional(),
  }).strict(),
}).strict()

const IsoDateSchema = z.string().datetime({ offset: true })
const AuthSessionRecordSchema = z.object({
  id: z.string().min(1).max(256),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  userId: z.string().min(1).max(256),
  expiresAt: IsoDateSchema,
}).strict()

const AuthUserSchema = z.object({
  id: z.string().min(1).max(256),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  email: z.string().email().max(254),
  emailVerified: z.boolean(),
  name: z.string().max(256),
  image: z.string().max(2048).nullable().optional(),
}).strict()

export const AuthSessionSchema = z.object({
  session: AuthSessionRecordSchema,
  user: AuthUserSchema,
}).strict()
export type AuthSession = z.infer<typeof AuthSessionSchema>

const Base64UrlSchema = z.string().min(1).max(16_384).regex(/^[A-Za-z0-9_-]+$/u)
const CredentialTransportSchema = z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])
const CredentialDescriptorSchema = z.object({
  id: Base64UrlSchema,
  type: z.literal('public-key'),
  transports: z.array(CredentialTransportSchema).max(8).optional(),
}).strict()
const UserVerificationSchema = z.enum(['discouraged', 'preferred', 'required'])
const HintSchema = z.enum(['security-key', 'client-device', 'hybrid'])

export const AuthenticationOptionsSchema = z.object({
  challenge: Base64UrlSchema,
  timeout: z.number().positive().max(600_000).optional(),
  rpId: z.string().min(1).max(253).optional(),
  allowCredentials: z.array(CredentialDescriptorSchema).max(100).optional(),
  userVerification: UserVerificationSchema.optional(),
  hints: z.array(HintSchema).max(3).optional(),
}).strict()

const AuthenticatorSelectionSchema = z.object({
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  residentKey: z.enum(['discouraged', 'preferred', 'required']).optional(),
  requireResidentKey: z.boolean().optional(),
  userVerification: UserVerificationSchema.optional(),
}).strict()

export const RegistrationOptionsSchema = z.object({
  rp: z.object({ id: z.string().min(1).max(253).optional(), name: z.string().min(1).max(256) }).strict(),
  user: z.object({ id: Base64UrlSchema, name: z.string().min(1).max(256), displayName: z.string().min(1).max(256) }).strict(),
  challenge: Base64UrlSchema,
  pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number().int() }).strict()).min(1).max(32),
  timeout: z.number().positive().max(600_000).optional(),
  excludeCredentials: z.array(CredentialDescriptorSchema).max(100).optional(),
  authenticatorSelection: AuthenticatorSelectionSchema.optional(),
  hints: z.array(HintSchema).max(3).optional(),
  attestation: z.enum(['none', 'indirect', 'direct', 'enterprise']).optional(),
  attestationFormats: z.array(z.string().min(1).max(64)).max(32).optional(),
}).strict()

export const PasskeyRecordSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  publicKey: Base64UrlSchema,
  userId: z.string().min(1).max(256),
  credentialID: Base64UrlSchema,
  counter: z.number().int().nonnegative(),
  deviceType: z.enum(['singleDevice', 'multiDevice']),
  backedUp: z.boolean(),
  transports: z.string().max(256).optional(),
  createdAt: IsoDateSchema,
  aaguid: z.string().max(64).optional(),
}).strict()

export const UnsyncedExportSchema = z.object({
  schema: z.literal('linerecall-unsynced-events-v2'),
  exportedAt: IsoDateSchema,
  deviceId: z.string().regex(UUID_V7),
  snapshotVersion: z.string().regex(SAFE_ID),
  pendingEvents: z.array(ReviewEventV1Schema).max(50_000),
  rejectedEvents: z.array(z.object({ event: ReviewEventV1Schema, rejection: SyncRejectionSchema }).strict()).max(50_000),
  pendingPuzzleAttempts: z.array(PuzzleAttemptV1Schema).max(50_000),
}).strict()

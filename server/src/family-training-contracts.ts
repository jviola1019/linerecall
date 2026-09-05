import { z } from 'zod'
import { UUID_V7 } from './contracts.js'

const FamilyReleaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,159}$/u)
const FamilyIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
const FamilyPackIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}$/u)
const FamilyPathIdSchema = z.string().regex(/^path_[a-f0-9]{20}$/u)
const FamilyCardIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::pos_[a-f0-9]{16}$/u)
const CoverageCycleIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::coverage:[0-9]+$/u)
const SyncCursorSchema = z.string().regex(/^\d+$/u)

function addUniqueIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', path: [...path], message: 'Values must be unique' })
  }
}

export const FamilyCoverageEventV1Schema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid().transform((value) => value.toLowerCase()),
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  packId: FamilyPackIdSchema,
  pathId: FamilyPathIdSchema,
  coverageCycleId: CoverageCycleIdSchema,
  completedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((event, context) => {
  if (!event.coverageCycleId.startsWith(`${event.packId}::coverage:`)) {
    context.addIssue({
      code: 'custom',
      path: ['coverageCycleId'],
      message: 'Coverage cycle must belong to the completed graph pack',
    })
  }
})
export type FamilyCoverageEventV1 = z.infer<typeof FamilyCoverageEventV1Schema>

const FamilyCoverageCycleEventBaseSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid().transform((value) => value.toLowerCase()),
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  side: z.enum(['white', 'black']),
  generationId: z.string().uuid().transform((value) => value.toLowerCase()),
  generationOrdinal: z.number().int().nonnegative(),
  occurredAt: z.string().datetime({ offset: true }),
})

export const FamilyCoverageCycleEventV1Schema = z.discriminatedUnion('kind', [
  FamilyCoverageCycleEventBaseSchema.extend({ kind: z.literal('cycle_started') }).strict(),
  FamilyCoverageCycleEventBaseSchema.extend({
    kind: z.literal('pack_bound'),
    packId: FamilyPackIdSchema,
    packCoverageCycleId: CoverageCycleIdSchema,
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

export const FamilyTrainingCursorV1Schema = z.object({
  schemaVersion: z.literal(1),
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  side: z.enum(['white', 'black']),
  coverageCycleId: CoverageCycleIdSchema,
  authoritativeDueCardIds: z.array(FamilyCardIdSchema).max(100_000),
  reviewedCardIds: z.array(FamilyCardIdSchema).max(100_000),
  completedPathIds: z.array(FamilyPathIdSchema).max(100_000),
  pendingPathIds: z.array(FamilyPathIdSchema).max(100_000),
  batchIndex: z.number().int().nonnegative(),
}).strict().superRefine((cursor, context) => {
  const separator = cursor.coverageCycleId.indexOf('::coverage:')
  const packId = cursor.coverageCycleId.slice(0, separator)
  for (const [key, values] of [
    ['authoritativeDueCardIds', cursor.authoritativeDueCardIds],
    ['reviewedCardIds', cursor.reviewedCardIds],
    ['completedPathIds', cursor.completedPathIds],
    ['pendingPathIds', cursor.pendingPathIds],
  ] as const) addUniqueIssue(values, context, [key])
  if (cursor.reviewedCardIds.some((cardId) => !cursor.authoritativeDueCardIds.includes(cardId))) {
    context.addIssue({
      code: 'custom',
      path: ['reviewedCardIds'],
      message: 'Reviewed cards must belong to the authoritative due-card set',
    })
  }
  if (cursor.completedPathIds.some((pathId) => cursor.pendingPathIds.includes(pathId))) {
    context.addIssue({
      code: 'custom',
      path: ['pendingPathIds'],
      message: 'A path cannot be both completed and pending',
    })
  }
  for (const [key, cardIds] of [
    ['authoritativeDueCardIds', cursor.authoritativeDueCardIds],
    ['reviewedCardIds', cursor.reviewedCardIds],
  ] as const) {
    if (cardIds.some((cardId) => !cardId.startsWith(`${packId}::pos_`))) {
      context.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} must belong to the coverage-cycle graph pack`,
      })
    }
  }
})
export type FamilyTrainingCursorV1 = z.infer<typeof FamilyTrainingCursorV1Schema>

export const FamilyCursorMutationV1Schema = z.object({
  mutationId: z.string().regex(UUID_V7).transform((value) => value.toLowerCase()),
  baseVersion: z.number().int().nonnegative(),
  value: FamilyTrainingCursorV1Schema,
}).strict()
export type FamilyCursorMutationV1 = z.infer<typeof FamilyCursorMutationV1Schema>

export const FamilyTrainingSyncRequestV1Schema = z.object({
  deviceId: z.string().regex(UUID_V7).transform((value) => value.toLowerCase()),
  coverageEvents: z.array(FamilyCoverageEventV1Schema).max(250).default([]),
  cycleEvents: z.array(FamilyCoverageCycleEventV1Schema).max(250).default([]),
  cursorMutation: FamilyCursorMutationV1Schema.optional(),
}).strict().superRefine((request, context) => {
  if (request.coverageEvents.length + request.cycleEvents.length > 250) {
    context.addIssue({ code: 'custom', path: ['cycleEvents'], message: 'At most 250 family events may be synced at once' })
  }
  addUniqueIssue(request.coverageEvents.map(({ eventId }) => eventId), context, ['coverageEvents'])
  addUniqueIssue(request.cycleEvents.map(({ eventId }) => eventId), context, ['cycleEvents'])
})
export type FamilyTrainingSyncRequestV1 = z.infer<typeof FamilyTrainingSyncRequestV1Schema>

export const FamilyTrainingRejectionV1Schema = z.object({
  recordId: z.string().max(128),
  recordType: z.enum(['coverage', 'cycle']),
  code: z.enum([
    'conflicting_event_id',
    'duplicate_logical_record',
    'future_timestamp_normalized',
    'unsupported_release',
    'unknown_family_membership',
  ]),
  message: z.string().max(256),
}).strict()
export type FamilyTrainingRejectionV1 = z.infer<typeof FamilyTrainingRejectionV1Schema>

export const VersionedFamilyTrainingCursorV1Schema = z.object({
  version: z.number().int().positive(),
  mutationId: z.string().regex(UUID_V7),
  value: FamilyTrainingCursorV1Schema,
  syncSequence: SyncCursorSchema,
}).strict()
export type VersionedFamilyTrainingCursorV1 = z.infer<typeof VersionedFamilyTrainingCursorV1Schema>

export const FamilyTrainingSyncResponseV1Schema = z.object({
  acceptedCoverageEventIds: z.array(z.string().uuid()).max(250),
  acceptedCycleEventIds: z.array(z.string().uuid()).max(250),
  rejectedRecords: z.array(FamilyTrainingRejectionV1Schema).max(250),
  cursor: VersionedFamilyTrainingCursorV1Schema.nullable(),
  cursorStatus: z.enum(['appended', 'duplicate']).nullable(),
  serverTime: z.string().datetime({ offset: true }),
}).strict()
export type FamilyTrainingSyncResponseV1 = z.infer<typeof FamilyTrainingSyncResponseV1Schema>

export const FamilyCoveragePageQuerySchema = z.object({
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  cursor: SyncCursorSchema.default('0'),
  limit: z.coerce.number().int().min(1).max(500).default(250),
}).strict()

export const FamilyCyclePageQuerySchema = FamilyCoveragePageQuerySchema.extend({
  side: z.enum(['white', 'black']),
}).strict()

export const FamilyCursorQuerySchema = z.object({
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  packId: FamilyPackIdSchema,
  side: z.enum(['white', 'black']),
  coverageCycleId: CoverageCycleIdSchema.optional(),
}).strict().superRefine((query, context) => {
  if (query.coverageCycleId && !query.coverageCycleId.startsWith(`${query.packId}::coverage:`)) {
    context.addIssue({ code: 'custom', path: ['coverageCycleId'], message: 'Coverage cycle belongs to another pack' })
  }
})
export type FamilyCursorQuery = z.infer<typeof FamilyCursorQuerySchema>

export const FamilyCoveragePageV1Schema = z.object({
  records: z.array(z.object({
    event: FamilyCoverageEventV1Schema,
    syncSequence: SyncCursorSchema,
  }).strict()).max(500),
  nextCursor: SyncCursorSchema,
  hasMore: z.boolean(),
  serverTime: z.string().datetime({ offset: true }),
}).strict()
export type FamilyCoveragePageV1 = z.infer<typeof FamilyCoveragePageV1Schema>

export const FamilyCyclePageV1Schema = z.object({
  records: z.array(z.object({
    event: FamilyCoverageCycleEventV1Schema,
    syncSequence: SyncCursorSchema,
  }).strict()).max(500),
  nextCursor: SyncCursorSchema,
  hasMore: z.boolean(),
  serverTime: z.string().datetime({ offset: true }),
}).strict()
export type FamilyCyclePageV1 = z.infer<typeof FamilyCyclePageV1Schema>

export const FamilyCursorResponseV1Schema = z.object({
  cursor: VersionedFamilyTrainingCursorV1Schema.nullable(),
  serverTime: z.string().datetime({ offset: true }),
}).strict()
export type FamilyCursorResponseV1 = z.infer<typeof FamilyCursorResponseV1Schema>

export function familyCursorPackId(cursor: FamilyTrainingCursorV1): string {
  return cursor.coverageCycleId.slice(0, cursor.coverageCycleId.indexOf('::coverage:'))
}

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CompactSourceArchiveSchema } from './compact-v3-contracts.ts'

export const COMPACT_V31_STORAGE_MODEL = 'log-structured-external-merge-v3.1' as const
export const COMPACT_V31_MINIMUM_AVAILABLE_MEMORY_BYTES = 8 * 1024 * 1024 * 1024
export const COMPACT_V31_MAXIMUM_WORKER_RESIDENT_BYTES = 6 * 1024 * 1024 * 1024
export const COMPACT_V31_MINIMUM_FREE_RESERVE_BYTES = 10 * 1024 * 1024 * 1024

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const SafePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
const IsoDateTimeSchema = z.string().datetime({ offset: true })
const RunIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/u)
const RelativePathSchema = z.string().min(1).max(512).refine((value) => {
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}, 'Artifact paths must be canonical relative POSIX paths')

export const CompactV31FileReceiptSchema = z.object({
  path: RelativePathSchema,
  bytes: SafePositiveIntegerSchema,
  sha256: Sha256Schema,
}).strict()

export const CompactV31ResourceSummarySchema = z.object({
  sampleCount: SafePositiveIntegerSchema,
  maximumObservedWorkerResidentBytes: SafeNonnegativeIntegerSchema.max(COMPACT_V31_MAXIMUM_WORKER_RESIDENT_BYTES),
  minimumObservedFreeStorageBytes: SafePositiveIntegerSchema.min(COMPACT_V31_MINIMUM_FREE_RESERVE_BYTES),
  minimumObservedAvailableMemoryBytes: SafeNonnegativeIntegerSchema,
  maximumObservedRetainedDeltaBytes: SafeNonnegativeIntegerSchema,
}).strict()

/**
 * The workspace owner's decision permits one provisional broadcast benchmark.
 * It does not approve the resulting statistics, Q2 ingestion, or release use.
 */
export const CompactV31BenchmarkAuthorizationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-benchmark-authorization'),
  authorization: z.literal('benchmark-bootstrap-only'),
  authorizedOn: IsoDateSchema,
  authorizedBy: z.string().min(1).max(256),
  proposalSha256: Sha256Schema,
  observationSha256: Sha256Schema,
  sourceSnapshotSha256: Sha256Schema,
  archiveCount: z.literal(78),
  publishedGames: z.literal(1_146_297),
  compressedBytes: z.literal(670_155_109),
  cutoffMonth: z.literal('2026-06'),
  permittedExecutionPurposes: z.tuple([z.literal('benchmark-bootstrap')]),
  q2IngestionAuthorized: z.literal(false),
  benchmarkPromotionAuthorized: z.literal(false),
  releaseEligible: z.literal(false),
  note: z.string().min(1).max(2048),
}).strict()

export const CompactV31ResourceLimitsSchema = z.object({
  minimumAvailableMemoryBytes: SafePositiveIntegerSchema,
  maximumWorkerResidentBytes: SafePositiveIntegerSchema,
  minimumFreeReserveBytes: SafePositiveIntegerSchema,
  archiveConcurrency: z.literal(1),
  maximumDeltaBytesPerArchive: SafePositiveIntegerSchema,
  maximumPartitionRunBytes: SafePositiveIntegerSchema,
  maximumMergeWorkspaceBytes: SafePositiveIntegerSchema,
  maximumReceiptBytes: SafePositiveIntegerSchema,
  maximumRetainedDeltaBytes: SafePositiveIntegerSchema,
  maximumFinalStateBytes: SafePositiveIntegerSchema,
  inputStagingBytes: z.literal(0),
}).strict().superRefine((limits, context) => {
  if (limits.minimumAvailableMemoryBytes < COMPACT_V31_MINIMUM_AVAILABLE_MEMORY_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['minimumAvailableMemoryBytes'],
      message: 'Compact-v3.1 requires at least 8 GiB of available memory before starting',
    })
  }
  if (limits.maximumWorkerResidentBytes > COMPACT_V31_MAXIMUM_WORKER_RESIDENT_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['maximumWorkerResidentBytes'],
      message: 'Compact-v3.1 worker RSS may not exceed 6 GiB',
    })
  }
  if (limits.minimumAvailableMemoryBytes <= limits.maximumWorkerResidentBytes) {
    context.addIssue({
      code: 'custom',
      path: ['minimumAvailableMemoryBytes'],
      message: 'Available-memory preflight must leave headroom above the worker RSS cap',
    })
  }
  if (limits.minimumFreeReserveBytes < COMPACT_V31_MINIMUM_FREE_RESERVE_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['minimumFreeReserveBytes'],
      message: 'Compact-v3.1 must preserve at least 10 GiB of free storage',
    })
  }
})

export const CompactV31PlanSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-archive-plan'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  pipelineVersion: z.literal('3.1.0'),
  sourceSnapshotSha256: Sha256Schema,
  configurationSha256: Sha256Schema,
  benchmarkAuthorizationSha256: Sha256Schema,
  executionPurpose: z.literal('benchmark-bootstrap'),
  releaseEligible: z.literal(false),
  archive: CompactSourceArchiveSchema,
  archiveOrdinal: z.number().int().min(0).max(77),
  corpusArchiveCount: z.literal(78),
  limits: CompactV31ResourceLimitsSchema,
  partitioning: z.object({
    algorithm: z.literal('sha256-prefix'),
    prefixBits: z.number().int().min(8).max(16),
    keyOrder: z.literal('unsigned-byte-lexicographic'),
    duplicatePolicy: z.literal('merge-identical-key-counters'),
  }).strict(),
  replay: z.object({
    completeBaselineMaxPly: z.literal(30),
    adaptiveEvidenceMaxPly: z.literal(100),
    adaptiveCandidateMinimumSample: z.literal(100),
    compressedInputReplay: z.literal('from-byte-zero'),
    sourceExpansion: z.literal('stream-only'),
  }).strict(),
}).strict().superRefine((plan, context) => {
  const expectedArchiveId = `broadcast-${plan.archive.month}`
  if (plan.archive.sourceId !== 'lichess-broadcasts' || plan.archive.archiveId !== expectedArchiveId) {
    context.addIssue({ code: 'custom', path: ['archive'], message: 'Authorized bootstrap plans cover only the pinned broadcast corpus' })
  }
  if (plan.archive.archiveId !== expectedBroadcastArchiveId(plan.archiveOrdinal)) {
    context.addIssue({ code: 'custom', path: ['archiveOrdinal'], message: 'Plan archive does not match its canonical broadcast ordinal' })
  }
})

export const CompactV31PlanReviewSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-benchmark-plan-review'),
  reviewStatus: z.literal('pending-benchmark'),
  releaseEligible: z.literal(false),
  generatedAt: IsoDateTimeSchema,
  sourceSnapshotSha256: Sha256Schema,
  proposalSha256: Sha256Schema,
  observationSha256: Sha256Schema,
  benchmarkAuthorizationSha256: Sha256Schema,
  configurationSha256: Sha256Schema,
  archiveCount: z.literal(78),
  publishedGames: z.literal(1_146_297),
  plans: z.array(z.object({
    archiveId: z.string().regex(/^broadcast-\d{4}-(?:0[1-9]|1[0-2])$/u),
    archiveOrdinal: z.number().int().min(0).max(77),
    path: RelativePathSchema,
    bytes: SafePositiveIntegerSchema,
    sha256: Sha256Schema,
  }).strict()).length(78),
  note: z.string().min(1).max(2048),
}).strict().superRefine((review, context) => {
  if (new Set(review.plans.map(({ archiveId }) => archiveId)).size !== review.plans.length) {
    context.addIssue({ code: 'custom', path: ['plans'], message: 'Plan archive IDs must be unique' })
  }
  if (review.plans.some(({ archiveOrdinal }, index) => archiveOrdinal !== index)) {
    context.addIssue({ code: 'custom', path: ['plans'], message: 'Plans must follow exact canonical archive order' })
  }
})

const AccountingSchema = z.object({
  recordsSeen: SafeNonnegativeIntegerSchema,
  accepted: SafeNonnegativeIntegerSchema,
  deduplicated: SafeNonnegativeIntegerSchema,
  rejected: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u), SafeNonnegativeIntegerSchema),
}).strict().superRefine((accounting, context) => {
  const rejected = Object.values(accounting.rejected).reduce((sum, value) => sum + value, 0)
  if (accounting.recordsSeen !== accounting.accepted + accounting.deduplicated + rejected) {
    context.addIssue({ code: 'custom', path: ['recordsSeen'], message: 'Archive accounting must reconcile exactly' })
  }
})

const OrderedPartitionReceiptSchema = CompactV31FileReceiptSchema.extend({
  partition: z.string().regex(/^[a-f0-9]{2,4}$/u),
  firstKeySha256: Sha256Schema,
  lastKeySha256: Sha256Schema,
  rowCount: SafePositiveIntegerSchema,
}).strict().superRefine((partition, context) => {
  if (partition.firstKeySha256 > partition.lastKeySha256) {
    context.addIssue({ code: 'custom', path: ['firstKeySha256'], message: 'Partition key bounds are not ordered' })
  }
})

const OrderedArchiveDeltaReceiptRefSchema = z.object({
  archiveOrdinal: z.number().int().min(0).max(77),
  archiveId: z.string().regex(/^broadcast-\d{4}-(?:0[1-9]|1[0-2])$/u),
  receiptSha256: Sha256Schema,
}).strict()

const ArchiveOwnershipIndexReceiptSchema = z.object({
  archiveOrdinal: z.number().int().min(0).max(77),
  archiveId: z.string().regex(/^broadcast-\d{4}-(?:0[1-9]|1[0-2])$/u),
  ownedRecordCount: SafeNonnegativeIntegerSchema,
  file: CompactV31FileReceiptSchema,
}).strict()

function expectedBroadcastArchiveId(archiveOrdinal: number): string {
  const absoluteMonth = (2020 * 12) + archiveOrdinal
  const year = Math.floor(absoluteMonth / 12)
  const month = (absoluteMonth % 12) + 1
  return `broadcast-${year}-${String(month).padStart(2, '0')}`
}

function validateOrderedArchiveDeltaRefs(
  refs: readonly z.infer<typeof OrderedArchiveDeltaReceiptRefSchema>[],
  context: z.core.$RefinementCtx,
  path: string,
): void {
  if (new Set(refs.map(({ receiptSha256 }) => receiptSha256)).size !== refs.length) {
    context.addIssue({ code: 'custom', path: [path], message: 'Archive delta receipt hashes must be unique' })
  }
  if (refs.some((ref, index) => ref.archiveOrdinal !== index || ref.archiveId !== expectedBroadcastArchiveId(index))) {
    context.addIssue({ code: 'custom', path: [path], message: 'Archive delta receipts must follow the complete canonical 2020-01 through 2026-06 order' })
  }
}

/** One archive emits immutable deltas; it never copies a cumulative database. */
export const CompactV31ArchiveDeltaReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-archive-delta'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  pipelineVersion: z.literal('3.1.0'),
  executionPurpose: z.literal('benchmark-bootstrap'),
  releaseEligible: z.literal(false),
  runId: RunIdSchema,
  sourceSnapshotSha256: Sha256Schema,
  configurationSha256: Sha256Schema,
  benchmarkAuthorizationSha256: Sha256Schema,
  archive: CompactSourceArchiveSchema,
  archiveOrdinal: z.number().int().min(0).max(77),
  pass: z.enum(['candidate', 'exact']),
  previousArchiveDeltaReceiptSha256: Sha256Schema.nullable(),
  compressedInput: z.object({
    bytes: SafePositiveIntegerSchema,
    sha256: Sha256Schema,
    verified: z.literal(true),
  }).strict(),
  accounting: AccountingSchema,
  partitions: z.array(OrderedPartitionReceiptSchema).min(1).max(65_536),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
  hardCapReached: z.literal(false),
  resources: CompactV31ResourceSummarySchema,
}).strict().superRefine((receipt, context) => {
  if (
    receipt.compressedInput.bytes !== receipt.archive.compressedBytes ||
    receipt.compressedInput.sha256 !== receipt.archive.sha256
  ) {
    context.addIssue({ code: 'custom', path: ['compressedInput'], message: 'Delta input differs from the approved archive' })
  }
  if (receipt.archive.archiveId !== expectedBroadcastArchiveId(receipt.archiveOrdinal)) {
    context.addIssue({ code: 'custom', path: ['archiveOrdinal'], message: 'Delta archive does not match its canonical broadcast ordinal' })
  }
  if (receipt.archiveOrdinal === 0 && receipt.previousArchiveDeltaReceiptSha256 !== null) {
    context.addIssue({ code: 'custom', path: ['previousArchiveDeltaReceiptSha256'], message: 'First archive cannot name a predecessor' })
  }
  if (receipt.archiveOrdinal > 0 && receipt.previousArchiveDeltaReceiptSha256 === null) {
    context.addIssue({ code: 'custom', path: ['previousArchiveDeltaReceiptSha256'], message: 'Archive delta chain is incomplete' })
  }
  const partitionIds = receipt.partitions.map(({ partition }) => partition)
  if (new Set(partitionIds).size !== partitionIds.length || partitionIds.some((value, index) => index > 0 && value <= partitionIds[index - 1]!)) {
    context.addIssue({ code: 'custom', path: ['partitions'], message: 'Delta partitions must be unique and canonically ordered' })
  }
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
    context.addIssue({ code: 'custom', path: ['completedAt'], message: 'Delta completion precedes its start' })
  }
})

export const CompactV31MergeReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-external-merge'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  pipelineVersion: z.literal('3.1.0'),
  executionPurpose: z.literal('benchmark-bootstrap'),
  releaseEligible: z.literal(false),
  runId: RunIdSchema,
  pass: z.enum(['candidate', 'exact']),
  sourceSnapshotSha256: Sha256Schema,
  configurationSha256: Sha256Schema,
  inputDeltaReceipts: z.array(OrderedArchiveDeltaReceiptRefSchema).length(78),
  outputPartitions: z.array(OrderedPartitionReceiptSchema).min(1).max(65_536),
  ownershipIndexes: z.array(ArchiveOwnershipIndexReceiptSchema).max(78),
  inputRows: SafePositiveIntegerSchema,
  outputRows: SafePositiveIntegerSchema,
  duplicateRowsMerged: SafeNonnegativeIntegerSchema,
  completedAt: IsoDateTimeSchema,
  resources: CompactV31ResourceSummarySchema,
}).strict().superRefine((receipt, context) => {
  validateOrderedArchiveDeltaRefs(receipt.inputDeltaReceipts, context, 'inputDeltaReceipts')
  if (receipt.inputRows !== receipt.outputRows + receipt.duplicateRowsMerged) {
    context.addIssue({ code: 'custom', path: ['inputRows'], message: 'External merge row accounting does not reconcile' })
  }
  if (receipt.pass === 'candidate') {
    if (
      receipt.ownershipIndexes.length !== 78 ||
      receipt.ownershipIndexes.some((entry, index) =>
        entry.archiveOrdinal !== index || entry.archiveId !== expectedBroadcastArchiveId(index))
    ) {
      context.addIssue({ code: 'custom', path: ['ownershipIndexes'], message: 'Candidate merge must emit one canonical ownership index for every archive' })
    }
  } else if (receipt.ownershipIndexes.length !== 0) {
    context.addIssue({ code: 'custom', path: ['ownershipIndexes'], message: 'Exact merge cannot emit candidate ownership indexes' })
  }
})

/** Durable archive boundary. A checkpoint never points at staging bytes. */
export const CompactV31ArchiveCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-archive-checkpoint'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  pipelineVersion: z.literal('3.1.0'),
  executionPurpose: z.literal('benchmark-bootstrap'),
  releaseEligible: z.literal(false),
  runId: RunIdSchema,
  pass: z.enum(['candidate', 'exact']),
  archiveOrdinal: z.number().int().min(0).max(77),
  archiveId: z.string().regex(/^broadcast-\d{4}-(?:0[1-9]|1[0-2])$/u),
  planSha256: Sha256Schema,
  deltaReceiptSha256: Sha256Schema,
  previousArchiveDeltaReceiptSha256: Sha256Schema.nullable(),
  committedAt: IsoDateTimeSchema,
  resources: CompactV31ResourceSummarySchema,
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.archiveId !== expectedBroadcastArchiveId(checkpoint.archiveOrdinal)) {
    context.addIssue({ code: 'custom', path: ['archiveOrdinal'], message: 'Checkpoint archive does not match its canonical ordinal' })
  }
  if ((checkpoint.archiveOrdinal === 0) !== (checkpoint.previousArchiveDeltaReceiptSha256 === null)) {
    context.addIssue({ code: 'custom', path: ['previousArchiveDeltaReceiptSha256'], message: 'Checkpoint predecessor does not match its archive ordinal' })
  }
})

/** Proves that a resumable run began in a dedicated empty directory. */
export const CompactV31RunBootstrapSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-run-bootstrap'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  pipelineVersion: z.literal('3.1.0'),
  executionPurpose: z.literal('benchmark-bootstrap'),
  releaseEligible: z.literal(false),
  runId: RunIdSchema,
  sourceSnapshotSha256: Sha256Schema,
  configurationSha256: Sha256Schema,
  benchmarkAuthorizationSha256: Sha256Schema,
  planReviewSha256: Sha256Schema,
  initialWorkDirectoryEmpty: z.literal(true),
  createdAt: IsoDateTimeSchema,
}).strict()

/** One complete clean-directory replay, still provisional and non-promotable. */
export const CompactV31RunReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-benchmark-run'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  pipelineVersion: z.literal('3.1.0'),
  executionPurpose: z.literal('benchmark-bootstrap'),
  releaseEligible: z.literal(false),
  runId: RunIdSchema,
  sourceSnapshotSha256: Sha256Schema,
  configurationSha256: Sha256Schema,
  benchmarkAuthorizationSha256: Sha256Schema,
  planReviewSha256: Sha256Schema,
  cleanWorkDirectory: z.literal(true),
  sourceArchiveCount: z.literal(78),
  publishedGames: z.literal(1_146_297),
  candidateDeltaReceipts: z.array(OrderedArchiveDeltaReceiptRefSchema).length(78),
  candidateMergeReceiptSha256: Sha256Schema,
  exactDeltaReceipts: z.array(OrderedArchiveDeltaReceiptRefSchema).length(78),
  exactMergeReceiptSha256: Sha256Schema,
  accountingSha256: Sha256Schema,
  allArchiveDigestsVerified: z.literal(true),
  resourceSampleCount: SafePositiveIntegerSchema,
  maximumObservedWorkerResidentBytes: SafeNonnegativeIntegerSchema.max(COMPACT_V31_MAXIMUM_WORKER_RESIDENT_BYTES),
  minimumObservedFreeStorageBytes: SafePositiveIntegerSchema.min(COMPACT_V31_MINIMUM_FREE_RESERVE_BYTES),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
  hardCapReached: z.literal(false),
}).strict().superRefine((receipt, context) => {
  validateOrderedArchiveDeltaRefs(receipt.candidateDeltaReceipts, context, 'candidateDeltaReceipts')
  validateOrderedArchiveDeltaRefs(receipt.exactDeltaReceipts, context, 'exactDeltaReceipts')
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
    context.addIssue({ code: 'custom', path: ['completedAt'], message: 'Run completion precedes its start' })
  }
})

export const CompactV31RepeatabilityBindingSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-repeatability-binding'),
  releaseEligible: z.literal(false),
  firstRunId: RunIdSchema,
  secondRunId: RunIdSchema,
  firstRunReceiptSha256: Sha256Schema,
  secondRunReceiptSha256: Sha256Schema,
  sourceSnapshotSha256: Sha256Schema,
  configurationSha256: Sha256Schema,
  benchmarkAuthorizationSha256: Sha256Schema,
  planReviewSha256: Sha256Schema,
  candidateMergeSha256: Sha256Schema,
  exactMergeSha256: Sha256Schema,
  accountingSha256: Sha256Schema,
  result: z.literal('byte-identical'),
  comparedAt: IsoDateTimeSchema,
  note: z.string().min(1).max(2048),
}).strict().superRefine((binding, context) => {
  if (binding.firstRunId === binding.secondRunId || binding.firstRunReceiptSha256 === binding.secondRunReceiptSha256) {
    context.addIssue({ code: 'custom', path: ['secondRunId'], message: 'Repeatability requires two independent runs and receipts' })
  }
})

export interface CompactV31ResourceObservation {
  availableStorageBytes: number
  retainedDeltaBytes: number
  availableMemoryBytes: number
  workerResidentBytes: number
}

export interface CompactV31PreflightAssessment extends CompactV31ResourceObservation {
  storageModel: typeof COMPACT_V31_STORAGE_MODEL
  safeToStart: boolean
  reasonCode: 'ready' | 'insufficient-memory' | 'worker-rss-cap-exceeded' | 'retained-delta-cap-exceeded' | 'insufficient-free-space'
  requiredAdditionalStorageBytes: number
  remainingStorageAtPeakBytes: number
  detail: string
}

function safeSum(values: readonly number[], label: string): number {
  return values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(sum + value)) {
      throw new Error(`${label} exceeds the safe integer range`)
    }
    return sum + value
  }, 0)
}

export function assessCompactV31Resources(
  planInput: unknown,
  observation: CompactV31ResourceObservation,
): CompactV31PreflightAssessment {
  const plan = CompactV31PlanSchema.parse(planInput)
  for (const [name, value] of Object.entries(observation)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`)
  }
  const remainingDeltaBudget = Math.max(0, plan.limits.maximumRetainedDeltaBytes - observation.retainedDeltaBytes)
  const transient = safeSum([
    plan.limits.maximumDeltaBytesPerArchive,
    plan.limits.maximumPartitionRunBytes,
    plan.limits.maximumMergeWorkspaceBytes,
    plan.limits.maximumReceiptBytes,
    plan.limits.maximumFinalStateBytes,
  ], 'Compact-v3.1 transient storage')
  const requiredAdditionalStorageBytes = safeSum([transient, remainingDeltaBudget], 'Compact-v3.1 storage requirement')
  const remainingStorageAtPeakBytes = observation.availableStorageBytes - requiredAdditionalStorageBytes
  const common = {
    storageModel: COMPACT_V31_STORAGE_MODEL,
    ...observation,
    requiredAdditionalStorageBytes,
    remainingStorageAtPeakBytes,
  } as const
  if (observation.availableMemoryBytes < plan.limits.minimumAvailableMemoryBytes) {
    return { ...common, safeToStart: false, reasonCode: 'insufficient-memory', detail: 'Available system memory is below the approved 8 GiB start threshold.' }
  }
  if (observation.workerResidentBytes > plan.limits.maximumWorkerResidentBytes) {
    return { ...common, safeToStart: false, reasonCode: 'worker-rss-cap-exceeded', detail: 'Worker RSS already exceeds the 6 GiB hard cap.' }
  }
  if (observation.retainedDeltaBytes > plan.limits.maximumRetainedDeltaBytes) {
    return { ...common, safeToStart: false, reasonCode: 'retained-delta-cap-exceeded', detail: 'Retained immutable deltas exceed their approved corpus-wide cap.' }
  }
  if (remainingStorageAtPeakBytes < plan.limits.minimumFreeReserveBytes) {
    return { ...common, safeToStart: false, reasonCode: 'insufficient-free-space', detail: 'Bounded delta, merge, and final-state work would violate the 10 GiB free-space reserve.' }
  }
  return { ...common, safeToStart: true, reasonCode: 'ready', detail: 'Memory, RSS, retained-delta, merge-workspace, and free-space bounds permit one archive transaction.' }
}

export function compactV31ConfigurationSha256(input: {
  sourceSnapshotSha256: string
  benchmarkAuthorizationSha256: string
  limits: z.infer<typeof CompactV31ResourceLimitsSchema>
  partitioning: z.infer<typeof CompactV31PlanSchema>['partitioning']
  replay: z.infer<typeof CompactV31PlanSchema>['replay']
}): string {
  Sha256Schema.parse(input.sourceSnapshotSha256)
  Sha256Schema.parse(input.benchmarkAuthorizationSha256)
  CompactV31ResourceLimitsSchema.parse(input.limits)
  return createHash('sha256').update(JSON.stringify({
    storageModel: COMPACT_V31_STORAGE_MODEL,
    pipelineVersion: '3.1.0',
    ...input,
  })).digest('hex')
}

export type CompactV31BenchmarkAuthorizationReceipt = z.infer<typeof CompactV31BenchmarkAuthorizationReceiptSchema>
export type CompactV31ResourceLimits = z.infer<typeof CompactV31ResourceLimitsSchema>
export type CompactV31Plan = z.infer<typeof CompactV31PlanSchema>
export type CompactV31PlanReview = z.infer<typeof CompactV31PlanReviewSchema>
export type CompactV31ArchiveDeltaReceipt = z.infer<typeof CompactV31ArchiveDeltaReceiptSchema>
export type CompactV31MergeReceipt = z.infer<typeof CompactV31MergeReceiptSchema>
export type CompactV31ArchiveCheckpoint = z.infer<typeof CompactV31ArchiveCheckpointSchema>
export type CompactV31RunBootstrap = z.infer<typeof CompactV31RunBootstrapSchema>
export type CompactV31ResourceSummary = z.infer<typeof CompactV31ResourceSummarySchema>
export type CompactV31RunReceipt = z.infer<typeof CompactV31RunReceiptSchema>
export type CompactV31RepeatabilityBinding = z.infer<typeof CompactV31RepeatabilityBindingSchema>

import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  COMPACT_V31_STORAGE_MODEL,
  CompactV31FileReceiptSchema,
  CompactV31ResourceLimitsSchema,
  CompactV31ResourceSummarySchema,
  type CompactV31ResourceLimits,
  type CompactV31ResourceObservation,
} from './compact-v31-contracts.ts'
import { CompactSourceArchiveSchema } from './compact-v3-contracts.ts'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const EdgeIdSchema = z.string().regex(/^edge_[a-f0-9]{16,64}$/u)
const IsoDateTimeSchema = z.string().datetime({ offset: true })
const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const SafePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const PartitionIdSchema = z.string().regex(/^[a-f0-9]{2,4}$/u)
const ProductionReleaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,159}$/u)
const RelativePathSchema = z.string().min(1).max(512).refine((value) => {
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}, 'Artifact paths must be canonical relative POSIX paths')

const Q2AdaptiveReplayBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-q2-adaptive-replay-authorization'),
  sourceManifest: CompactV31FileReceiptSchema,
  completeBaselineMaxPly: z.literal(30),
  adaptiveEvidenceMaxPly: z.literal(100),
  adaptiveCandidateMinimumSample: z.literal(100),
  releaseEligible: z.literal(false),
  note: z.string().min(1).max(2048),
}).strict()

export const CompactV31Q2AdaptiveReplayAuthorizationSchema = z.discriminatedUnion('decision', [
  Q2AdaptiveReplayBaseSchema.extend({
    decision: z.literal('pending'),
    reviewedAt: z.null(),
    reviewedBy: z.null(),
  }).strict(),
  Q2AdaptiveReplayBaseSchema.extend({
    decision: z.literal('approved'),
    reviewedAt: IsoDateTimeSchema,
    reviewedBy: z.string().min(1).max(256),
  }).strict(),
])

export const CompactV31ProductionCorpusSchema = z.enum([
  'lichess-broadcasts',
  'lichess-standard-rated-q2-2026',
])

const ProductionAuthorizationBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-production-authorization'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  proposalCreatedAt: IsoDateTimeSchema,
  proposedBy: z.string().min(1).max(256),
  benchmarkAuthorizationSha256: Sha256Schema,
  sourceManifests: z.object({
    broadcasts: CompactV31FileReceiptSchema,
    standardQ2_2026: CompactV31FileReceiptSchema,
  }).strict(),
  broadcastTransportIdentity: z.object({
    proposal: CompactV31FileReceiptSchema,
    observation: CompactV31FileReceiptSchema,
  }).strict(),
  q2AdaptiveReplayApproval: CompactV31FileReceiptSchema,
  limits: CompactV31ResourceLimitsSchema,
  limitsSha256: Sha256Schema,
  note: z.string().min(1).max(4096),
}).strict()

const PendingProductionAuthorizationSchema = ProductionAuthorizationBaseSchema.extend({
  decision: z.literal('pending'),
  reviewedAt: z.null(),
  reviewedBy: z.null(),
  benchmarkRepeatabilityBinding: z.null(),
  authorizedCorpora: z.tuple([]),
  q2IngestionAuthorized: z.literal(false),
  productionExecutionAuthorized: z.literal(false),
  promotionAuthorized: z.literal(false),
  releaseEligible: z.literal(false),
}).strict()

const ApprovedProductionAuthorizationSchema = ProductionAuthorizationBaseSchema.extend({
  decision: z.literal('approved'),
  reviewedAt: IsoDateTimeSchema,
  reviewedBy: z.string().min(1).max(256),
  benchmarkRepeatabilityBinding: CompactV31FileReceiptSchema,
  authorizedCorpora: z.tuple([
    z.literal('lichess-broadcasts'),
    z.literal('lichess-standard-rated-q2-2026'),
  ]),
  q2IngestionAuthorized: z.literal(true),
  productionExecutionAuthorized: z.literal(true),
  promotionAuthorized: z.literal(true),
  // An authorization permits work. Only audited output receipts can be release eligible.
  releaseEligible: z.literal(false),
}).strict()

export const CompactV31ProductionAuthorizationSchema = z.discriminatedUnion('decision', [
  PendingProductionAuthorizationSchema,
  ApprovedProductionAuthorizationSchema,
]).superRefine((authorization, context) => {
  const digest = createHash('sha256').update(JSON.stringify(authorization.limits)).digest('hex')
  if (authorization.limitsSha256 !== digest) {
    context.addIssue({ code: 'custom', path: ['limitsSha256'], message: 'Resource-limit digest is invalid' })
  }
})

const ProductionPlanBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-production-archive-plan'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  pipelineVersion: z.literal('3.1.0'),
  executionPurpose: z.literal('evidence-candidate'),
  releaseEligible: z.literal(false),
  sourceSnapshotSha256: Sha256Schema,
  configurationSha256: Sha256Schema,
  productionAuthorizationSha256: Sha256Schema,
  benchmarkRepeatabilityBindingSha256: Sha256Schema,
  corpus: CompactV31ProductionCorpusSchema,
  archive: CompactSourceArchiveSchema,
  archiveOrdinal: z.number().int().nonnegative().max(77),
  corpusArchiveCount: z.union([z.literal(3), z.literal(78)]),
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
}).strict()

function expectedArchiveId(corpus: z.infer<typeof CompactV31ProductionCorpusSchema>, ordinal: number): string {
  if (corpus === 'lichess-standard-rated-q2-2026') {
    return `standard-2026-${String(ordinal + 4).padStart(2, '0')}`
  }
  const absoluteMonth = (2020 * 12) + ordinal
  return `broadcast-${Math.floor(absoluteMonth / 12)}-${String((absoluteMonth % 12) + 1).padStart(2, '0')}`
}

export const CompactV31ProductionPlanSchema = ProductionPlanBaseSchema.superRefine((plan, context) => {
  const expectedCount = plan.corpus === 'lichess-broadcasts' ? 78 : 3
  if (plan.corpusArchiveCount !== expectedCount || plan.archiveOrdinal >= expectedCount) {
    context.addIssue({ code: 'custom', path: ['corpusArchiveCount'], message: 'Corpus archive count or ordinal is invalid' })
  }
  if (plan.archive.sourceId !== plan.corpus || plan.archive.archiveId !== expectedArchiveId(plan.corpus, plan.archiveOrdinal)) {
    context.addIssue({ code: 'custom', path: ['archive'], message: 'Archive identity is not canonical for this corpus' })
  }
})

const PlanReferenceSchema = z.object({
  archiveId: z.string().min(1).max(128),
  archiveOrdinal: z.number().int().nonnegative().max(77),
  path: RelativePathSchema,
  bytes: SafePositiveIntegerSchema,
  sha256: Sha256Schema,
}).strict()

export const CompactV31ProductionPlanReviewSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-production-plan-review'),
  reviewStatus: z.literal('authorized-execution'),
  releaseEligible: z.literal(false),
  generatedAt: IsoDateTimeSchema,
  corpus: CompactV31ProductionCorpusSchema,
  sourceSnapshotSha256: Sha256Schema,
  configurationSha256: Sha256Schema,
  productionAuthorizationSha256: Sha256Schema,
  benchmarkRepeatabilityBindingSha256: Sha256Schema,
  archiveCount: z.union([z.literal(3), z.literal(78)]),
  plans: z.array(PlanReferenceSchema).min(3).max(78),
}).strict().superRefine((review, context) => {
  const expectedCount = review.corpus === 'lichess-broadcasts' ? 78 : 3
  if (review.archiveCount !== expectedCount || review.plans.length !== expectedCount) {
    context.addIssue({ code: 'custom', path: ['plans'], message: 'Production plan inventory is incomplete' })
  }
  if (new Set(review.plans.map(({ archiveId }) => archiveId)).size !== review.plans.length) {
    context.addIssue({ code: 'custom', path: ['plans'], message: 'Production plan archive IDs must be unique' })
  }
  if (review.plans.some((entry, ordinal) =>
    entry.archiveOrdinal !== ordinal || entry.archiveId !== expectedArchiveId(review.corpus, ordinal)
  )) {
    context.addIssue({ code: 'custom', path: ['plans'], message: 'Production plans are not in canonical corpus order' })
  }
})

const RejectedAccountingSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  SafeNonnegativeIntegerSchema,
)

const ProductionAccountingSchema = z.object({
  recordsSeen: SafeNonnegativeIntegerSchema,
  accepted: SafeNonnegativeIntegerSchema,
  deduplicated: SafeNonnegativeIntegerSchema,
  rejected: RejectedAccountingSchema,
}).strict().superRefine((accounting, context) => {
  const rejected = Object.values(accounting.rejected).reduce((sum, count) => sum + count, 0)
  if (accounting.recordsSeen !== accounting.accepted + accounting.deduplicated + rejected) {
    context.addIssue({ code: 'custom', path: ['recordsSeen'], message: 'Production accounting does not reconcile' })
  }
})

function requireUniqueFileReceipts(
  receipts: readonly z.infer<typeof CompactV31FileReceiptSchema>[],
  context: z.core.$RefinementCtx,
  path: string,
): void {
  const paths = receipts.map(({ path: receiptPath }) => receiptPath)
  const identities = receipts.map(({ bytes, sha256 }) => `${bytes}:${sha256}`)
  if (new Set(paths).size !== paths.length || new Set(identities).size !== identities.length) {
    context.addIssue({ code: 'custom', path: [path], message: 'File receipts must be unique by path and content identity' })
  }
}

export const CompactV31ProductionPartitionReceiptSchema = CompactV31FileReceiptSchema.extend({
  partition: PartitionIdSchema,
}).strict()

export const CompactV31ProductionDeltaReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-production-delta'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  pipelineVersion: z.literal('3.1.0'),
  executionPurpose: z.literal('evidence-candidate'),
  releaseEligible: z.literal(false),
  corpus: CompactV31ProductionCorpusSchema,
  pass: z.enum(['candidate', 'exact']),
  productionAuthorizationSha256: Sha256Schema,
  sourceManifestSha256: Sha256Schema,
  planSha256: Sha256Schema,
  archiveOrdinal: z.number().int().nonnegative().max(77),
  archiveId: z.string().min(1).max(128),
  previousDeltaReceiptSha256: Sha256Schema.nullable(),
  compressedInput: z.object({
    bytes: SafePositiveIntegerSchema,
    sha256: Sha256Schema,
    verified: z.literal(true),
  }).strict(),
  accounting: ProductionAccountingSchema,
  outputPartitions: z.array(CompactV31ProductionPartitionReceiptSchema).min(1).max(65_536),
  resources: CompactV31ResourceSummarySchema,
  completedAt: IsoDateTimeSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.archiveId !== expectedArchiveId(receipt.corpus, receipt.archiveOrdinal)) {
    context.addIssue({ code: 'custom', path: ['archiveId'], message: 'Delta archive is not canonical for its corpus' })
  }
  if ((receipt.archiveOrdinal === 0) !== (receipt.previousDeltaReceiptSha256 === null)) {
    context.addIssue({ code: 'custom', path: ['previousDeltaReceiptSha256'], message: 'Delta predecessor does not match its ordinal' })
  }
  requireUniqueFileReceipts(receipt.outputPartitions, context, 'outputPartitions')
  const partitions = receipt.outputPartitions.map(({ partition }) => partition)
  if (new Set(partitions).size !== partitions.length || partitions.some((id, index) => index > 0 && partitions[index - 1]! >= id)) {
    context.addIssue({ code: 'custom', path: ['outputPartitions'], message: 'Delta partitions must be unique and canonically ordered' })
  }
})

export const CompactV31ProductionMergeReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-production-merge'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  pipelineVersion: z.literal('3.1.0'),
  executionPurpose: z.literal('evidence-candidate'),
  releaseEligible: z.literal(false),
  corpus: CompactV31ProductionCorpusSchema,
  pass: z.enum(['candidate', 'exact']),
  productionAuthorizationSha256: Sha256Schema,
  sourceManifestSha256: Sha256Schema,
  inputDeltaReceipts: z.array(CompactV31FileReceiptSchema).min(3).max(78),
  outputPartitions: z.array(CompactV31ProductionPartitionReceiptSchema).min(1).max(65_536),
  inputRows: SafePositiveIntegerSchema,
  outputRows: SafePositiveIntegerSchema,
  duplicateRowsMerged: SafeNonnegativeIntegerSchema,
  resources: CompactV31ResourceSummarySchema,
  completedAt: IsoDateTimeSchema,
}).strict().superRefine((receipt, context) => {
  const expected = receipt.corpus === 'lichess-broadcasts' ? 78 : 3
  if (receipt.inputDeltaReceipts.length !== expected) {
    context.addIssue({ code: 'custom', path: ['inputDeltaReceipts'], message: 'Merge input inventory is incomplete' })
  }
  if (receipt.inputRows !== receipt.outputRows + receipt.duplicateRowsMerged) {
    context.addIssue({ code: 'custom', path: ['inputRows'], message: 'Merge row accounting does not reconcile' })
  }
  requireUniqueFileReceipts(receipt.inputDeltaReceipts, context, 'inputDeltaReceipts')
  requireUniqueFileReceipts(receipt.outputPartitions, context, 'outputPartitions')
  const partitions = receipt.outputPartitions.map(({ partition }) => partition)
  if (new Set(partitions).size !== partitions.length || partitions.some((id, index) => index > 0 && partitions[index - 1]! >= id)) {
    context.addIssue({ code: 'custom', path: ['outputPartitions'], message: 'Merge partitions must be unique and canonically ordered' })
  }
})

const EligibleEdgeRowSchema = z.object({
  edgeId: EdgeIdSchema,
  fromEpdSha256: Sha256Schema,
  toEpdSha256: Sha256Schema,
  uci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u),
  sampleSize: SafePositiveIntegerSchema,
  cells: z.array(z.object({
    ratingSystem: z.enum(['broadcast-rating', 'lichess-glicko2']),
    timeControl: z.enum(['blitz', 'rapid', 'classical']),
    ratingBand: z.enum(['<1200', '1200-1499', '1500-1799', '<1800', '1800-1999', '2000-2199', '2200-2399', '2400+']),
    whiteWins: SafeNonnegativeIntegerSchema,
    draws: SafeNonnegativeIntegerSchema,
    blackWins: SafeNonnegativeIntegerSchema,
    n: SafePositiveIntegerSchema,
  }).strict()).min(1).max(64),
}).strict().superRefine((row, context) => {
  const keys = row.cells.map((cell) => `${cell.ratingSystem}:${cell.timeControl}:${cell.ratingBand}`)
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && keys[index - 1]! >= key)) {
    context.addIssue({ code: 'custom', path: ['cells'], message: 'Evidence cells must be unique and canonically sorted' })
  }
  for (const [index, cell] of row.cells.entries()) {
    if (cell.n !== cell.whiteWins + cell.draws + cell.blackWins) {
      context.addIssue({ code: 'custom', path: ['cells', index, 'n'], message: 'Evidence-cell W/D/L counts do not reconcile' })
    }
  }
  if (row.sampleSize !== Math.max(...row.cells.map(({ n }) => n))) {
    context.addIssue({ code: 'custom', path: ['sampleSize'], message: 'Edge sample size must be the maximum declared evidence cell' })
  }
})

const EligibleEdgePartitionReceiptSchema = z.object({
  partition: PartitionIdSchema,
  exactStatePartitionSha256: Sha256Schema,
  exactStateFirstEdgeId: EdgeIdSchema,
  exactStateLastEdgeId: EdgeIdSchema,
  eligibleEdges: CompactV31FileReceiptSchema,
  eligibleEdgeCount: SafeNonnegativeIntegerSchema,
  eligibleFirstEdgeId: EdgeIdSchema.nullable(),
  eligibleLastEdgeId: EdgeIdSchema.nullable(),
}).strict().superRefine((partition, context) => {
  if (partition.exactStateFirstEdgeId > partition.exactStateLastEdgeId) {
    context.addIssue({ code: 'custom', path: ['exactStateFirstEdgeId'], message: 'Exact-state edge bounds are not ordered' })
  }
  const hasEligibleBounds = partition.eligibleFirstEdgeId !== null && partition.eligibleLastEdgeId !== null
  if ((partition.eligibleEdgeCount > 0) !== hasEligibleBounds) {
    context.addIssue({ code: 'custom', path: ['eligibleEdgeCount'], message: 'Eligible bounds must match a non-empty eligible partition' })
  }
  if (hasEligibleBounds && partition.eligibleFirstEdgeId! > partition.eligibleLastEdgeId!) {
    context.addIssue({ code: 'custom', path: ['eligibleFirstEdgeId'], message: 'Eligible edge bounds are not ordered' })
  }
})

export const CompactV31ProductionSourceEdgeInventorySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-production-source-edge-inventory'),
  releaseEligible: z.literal(false),
  releaseId: ProductionReleaseIdSchema,
  corpus: CompactV31ProductionCorpusSchema,
  productionAuthorizationSha256: Sha256Schema,
  sourceManifestSha256: Sha256Schema,
  exactMergeReceiptSha256: Sha256Schema,
  minimumSampleSize: z.literal(100),
  eligibleEdgePartitions: z.array(EligibleEdgePartitionReceiptSchema).min(1).max(65_536),
  eligibleSourceEdges: SafeNonnegativeIntegerSchema,
  emittedEligibleSourceEdges: SafeNonnegativeIntegerSchema,
  omittedEligibleSourceEdges: z.literal(0),
  completedAt: IsoDateTimeSchema,
}).strict().superRefine((inventory, context) => {
  if (inventory.eligibleSourceEdges !== inventory.emittedEligibleSourceEdges) {
    context.addIssue({ code: 'custom', path: ['emittedEligibleSourceEdges'], message: 'Eligible source-edge inventory is incomplete' })
  }
  const exactPartitions = inventory.eligibleEdgePartitions.map(({ exactStatePartitionSha256 }) => exactStatePartitionSha256)
  requireUniqueFileReceipts(inventory.eligibleEdgePartitions.map(({ eligibleEdges }) => eligibleEdges), context, 'eligibleEdgePartitions')
  if (new Set(exactPartitions).size !== exactPartitions.length) {
    context.addIssue({ code: 'custom', path: ['eligibleEdgePartitions'], message: 'Every exact-state partition may be inventoried only once' })
  }
  const partitionIds = inventory.eligibleEdgePartitions.map(({ partition }) => partition)
  if (new Set(partitionIds).size !== partitionIds.length || partitionIds.some((id, index) => index > 0 && partitionIds[index - 1]! >= id)) {
    context.addIssue({ code: 'custom', path: ['eligibleEdgePartitions'], message: 'Eligible partitions must be unique and canonically ordered' })
  }
  for (let index = 1; index < inventory.eligibleEdgePartitions.length; index += 1) {
    const previous = inventory.eligibleEdgePartitions[index - 1]!
    const current = inventory.eligibleEdgePartitions[index]!
    if (previous.exactStateLastEdgeId >= current.exactStateFirstEdgeId) {
      context.addIssue({ code: 'custom', path: ['eligibleEdgePartitions', index], message: 'Exact-state partitions overlap or are not in canonical edge order' })
    }
  }
  const partitionTotal = inventory.eligibleEdgePartitions.reduce((sum, partition) => sum + partition.eligibleEdgeCount, 0)
  if (!Number.isSafeInteger(partitionTotal) || partitionTotal !== inventory.eligibleSourceEdges) {
    context.addIssue({ code: 'custom', path: ['eligibleEdgePartitions'], message: 'Eligible partition counts do not reconcile' })
  }
})

/** One bounded NDJSON row in both exact-state and derived eligible-edge partitions. */
export const CompactV31ProductionExactEdgeRowSchema = EligibleEdgeRowSchema
export const CompactV31ProductionEligibleEdgeRowSchema = EligibleEdgeRowSchema.safeExtend({
  sampleSize: SafePositiveIntegerSchema.min(100),
}).strict()

export const CompactV31ProductionArchiveReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-production-archive'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  pipelineVersion: z.literal('3.1.0'),
  executionPurpose: z.literal('evidence-candidate'),
  releaseEligible: z.literal(false),
  corpus: CompactV31ProductionCorpusSchema,
  productionAuthorizationSha256: Sha256Schema,
  sourceManifestSha256: Sha256Schema,
  archiveOrdinal: z.number().int().nonnegative().max(77),
  archiveId: z.string().min(1).max(128),
  planSha256: Sha256Schema,
  candidateDeltaReceipt: CompactV31FileReceiptSchema,
  exactDeltaReceipt: CompactV31FileReceiptSchema,
  compressedInput: z.object({
    bytes: SafePositiveIntegerSchema,
    sha256: Sha256Schema,
    verified: z.literal(true),
  }).strict(),
  accounting: ProductionAccountingSchema,
  resources: CompactV31ResourceSummarySchema,
  completedAt: IsoDateTimeSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.archiveId !== expectedArchiveId(receipt.corpus, receipt.archiveOrdinal)) {
    context.addIssue({ code: 'custom', path: ['archiveId'], message: 'Archive receipt is not in canonical corpus order' })
  }
  const rejected = Object.values(receipt.accounting.rejected).reduce((sum, count) => sum + count, 0)
  if (receipt.accounting.recordsSeen !== receipt.accounting.accepted + receipt.accounting.deduplicated + rejected) {
    context.addIssue({ code: 'custom', path: ['accounting'], message: 'Archive accounting does not reconcile' })
  }
})

export const CompactV31ProductionCorpusReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-production-corpus'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  pipelineVersion: z.literal('3.1.0'),
  executionPurpose: z.literal('evidence-candidate'),
  releaseEligible: z.literal(false),
  releaseId: ProductionReleaseIdSchema,
  corpus: CompactV31ProductionCorpusSchema,
  productionAuthorization: CompactV31FileReceiptSchema,
  sourceManifest: CompactV31FileReceiptSchema,
  benchmarkRepeatabilityBinding: CompactV31FileReceiptSchema,
  planReview: CompactV31FileReceiptSchema,
  archiveReceipts: z.array(CompactV31FileReceiptSchema).min(3).max(78),
  candidateMergeReceipt: CompactV31FileReceiptSchema,
  exactMergeReceipt: CompactV31FileReceiptSchema,
  sourceArchiveCount: z.union([z.literal(3), z.literal(78)]),
  recordsSeen: SafePositiveIntegerSchema,
  accepted: SafeNonnegativeIntegerSchema,
  deduplicated: SafeNonnegativeIntegerSchema,
  rejected: SafeNonnegativeIntegerSchema,
  allArchiveDigestsVerified: z.literal(true),
  exactSecondPassComplete: z.literal(true),
  accountingReconciles: z.literal(true),
  sourceEdgeInventory: CompactV31FileReceiptSchema,
  resourceLimitsRespected: z.literal(true),
  completedAt: IsoDateTimeSchema,
}).strict().superRefine((receipt, context) => {
  const expectedCount = receipt.corpus === 'lichess-broadcasts' ? 78 : 3
  if (receipt.sourceArchiveCount !== expectedCount || receipt.archiveReceipts.length !== expectedCount) {
    context.addIssue({ code: 'custom', path: ['archiveReceipts'], message: 'Corpus receipt does not cover every source archive' })
  }
  if (receipt.recordsSeen !== receipt.accepted + receipt.deduplicated + receipt.rejected) {
    context.addIssue({ code: 'custom', path: ['recordsSeen'], message: 'Corpus accounting does not reconcile' })
  }
  requireUniqueFileReceipts(receipt.archiveReceipts, context, 'archiveReceipts')
})

/**
 * A wiring proposal only. It is deliberately non-promotable: the deep
 * production audit must traverse and hash every referenced authorization,
 * manifest, plan, archive, delta, merge, corpus, family, engine, Scid, and
 * puzzle receipt before a separate release attestation can be created.
 */
export const CompactV31ProductionPromotionCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-production-promotion-candidate'),
  storageModel: z.literal(COMPACT_V31_STORAGE_MODEL),
  status: z.literal('pending-deep-audit'),
  releaseEligible: z.literal(false),
  releaseId: z.string().regex(/^release_[a-z0-9][a-z0-9._-]{2,127}$/u),
  productionAuthorizationSha256: Sha256Schema,
  benchmarkRepeatabilityBinding: CompactV31FileReceiptSchema,
  broadcastCorpusReceipt: CompactV31FileReceiptSchema,
  standardQ2CorpusReceipt: CompactV31FileReceiptSchema,
  familyPromotionIndex: CompactV31FileReceiptSchema,
  engineCampaign: CompactV31FileReceiptSchema,
  scidCampaign: CompactV31FileReceiptSchema,
  puzzlePromotion: CompactV31FileReceiptSchema,
  productionDataReadiness: CompactV31FileReceiptSchema,
  assembledAt: IsoDateTimeSchema,
}).strict()

export const CompactV31ProductionReadinessFactsSchema = z.object({
  authorizationDecision: z.enum(['missing', 'pending', 'approved', 'invalid']),
  exactBootstrapInputsPresent: z.boolean(),
  benchmarkPlansPresent: z.boolean(),
  benchmarkRunCount: z.number().int().min(0).max(2),
  repeatabilityBindingPresent: z.boolean(),
  productionPlanReviewsPresent: z.boolean(),
  broadcastCorpusReceiptPresent: z.boolean(),
  standardQ2CorpusReceiptPresent: z.boolean(),
  productionCohortOrchestratorImplemented: z.boolean(),
  productionArchiveAdapterImplemented: z.boolean(),
  deterministicMergeVerifierImplemented: z.boolean(),
  productionHandoffImplemented: z.boolean(),
  productionCandidateUsesAppWireV3: z.boolean(),
  familyEligibilityInventoryPresent: z.boolean(),
  q2AdaptivePly100Authorized: z.boolean(),
  familyPromotionPresent: z.boolean(),
  stockfishProvisionPresent: z.boolean(),
  scidProvisionPresent: z.boolean(),
  puzzleDigestApproved: z.boolean(),
  puzzlePromotionPresent: z.boolean(),
  editorialLedgerApproved: z.boolean(),
  availableMemoryBytes: SafeNonnegativeIntegerSchema,
  workerResidentBytes: SafeNonnegativeIntegerSchema,
  availableStorageBytes: SafeNonnegativeIntegerSchema,
  limits: CompactV31ResourceLimitsSchema,
}).strict()

export interface CompactV31ProductionBlocker {
  code: string
  detail: string
}

export function evaluateCompactV31ProductionReadiness(input: unknown): {
  status: 'blocked' | 'ready-for-authorized-execution'
  blockers: CompactV31ProductionBlocker[]
} {
  const facts = CompactV31ProductionReadinessFactsSchema.parse(input)
  const blockers: CompactV31ProductionBlocker[] = []
  const requireFact = (condition: boolean, code: string, detail: string): void => {
    if (!condition) blockers.push({ code, detail })
  }
  requireFact(facts.exactBootstrapInputsPresent, 'authorized-bootstrap-inputs-missing', 'Exact authorized proposal and observation bytes are missing.')
  requireFact(facts.benchmarkPlansPresent, 'benchmark-plans-missing', 'The authenticated 78-plan benchmark bundle is missing.')
  requireFact(facts.benchmarkRunCount === 2, 'benchmark-runs-incomplete', `Two clean benchmark runs are required; ${facts.benchmarkRunCount} are present.`)
  requireFact(facts.repeatabilityBindingPresent, 'repeatability-binding-missing', 'No byte-identical two-run binding is present.')
  requireFact(facts.authorizationDecision === 'approved', 'production-authorization-not-approved', `Production authorization is ${facts.authorizationDecision}.`)
  requireFact(
    facts.productionCohortOrchestratorImplemented,
    'production-orchestrator-missing',
    'The authenticated two-pass production cohort orchestrator is not implemented.',
  )
  requireFact(
    facts.productionArchiveAdapterImplemented,
    'production-archive-adapter-missing',
    'The streamed PGN-to-v3.1 delta adapter is not wired to the production cohort orchestrator.',
  )
  requireFact(
    facts.deterministicMergeVerifierImplemented,
    'deterministic-merge-verifier-missing',
    'No bounded verifier independently recomputes exact merged cohort/time-control counters from exact archive deltas.',
  )
  requireFact(facts.productionPlanReviewsPresent, 'production-plans-missing', 'Authorized production plan reviews for both corpora are missing.')
  requireFact(facts.broadcastCorpusReceiptPresent, 'broadcast-production-receipt-missing', 'The complete broadcast production corpus receipt is missing.')
  requireFact(facts.standardQ2CorpusReceiptPresent, 'q2-production-receipt-missing', 'The complete Q2 production corpus receipt is missing.')
  requireFact(facts.productionHandoffImplemented, 'production-handoff-missing', 'The v3.1 exact-state to family-evidence handoff is not implemented.')
  requireFact(
    facts.productionCandidateUsesAppWireV3,
    'production-candidate-app-wire-v3-missing',
    'The candidate build is not bound to the production app-wire-v3 manifest.',
  )
  requireFact(
    facts.familyEligibilityInventoryPresent,
    'family-eligibility-inventory-missing',
    'No deep-corpus-bound exact-state family/side eligibility inventory is present.',
  )
  requireFact(
    facts.q2AdaptivePly100Authorized,
    'q2-adaptive-ply100-scope-not-approved',
    'The separate source-bound authorization for v3.1 adaptive Q2 replay through ply 100 is not approved.',
  )
  requireFact(facts.familyPromotionPresent, 'family-promotion-missing', 'No audited family promotion index is present.')
  requireFact(facts.stockfishProvisionPresent, 'stockfish-provision-missing', 'The verified Stockfish 18 provision is missing.')
  requireFact(facts.scidProvisionPresent, 'scid-provision-missing', 'The pinned Scid oracle provision is missing.')
  requireFact(facts.puzzleDigestApproved, 'puzzle-digest-not-approved', 'The puzzle source digest is not approved.')
  requireFact(facts.puzzlePromotionPresent, 'puzzle-promotion-missing', 'No engine-approved tactical puzzle promotion is present.')
  requireFact(facts.editorialLedgerApproved, 'editorial-ledger-pending', 'The complete family editorial ledger is not human-approved.')
  requireFact(
    facts.availableMemoryBytes >= facts.limits.minimumAvailableMemoryBytes,
    'insufficient-available-memory',
    `Available memory ${facts.availableMemoryBytes} is below ${facts.limits.minimumAvailableMemoryBytes}.`,
  )
  requireFact(
    facts.workerResidentBytes <= facts.limits.maximumWorkerResidentBytes,
    'worker-rss-cap-exceeded',
    `Worker RSS ${facts.workerResidentBytes} exceeds ${facts.limits.maximumWorkerResidentBytes}.`,
  )
  requireFact(
    facts.availableStorageBytes >= facts.limits.minimumFreeReserveBytes,
    'free-storage-reserve-unavailable',
    `Available storage ${facts.availableStorageBytes} is below the ${facts.limits.minimumFreeReserveBytes} reserve.`,
  )
  return {
    status: blockers.length === 0 ? 'ready-for-authorized-execution' : 'blocked',
    blockers,
  }
}

export function compactV31ProductionConfigurationSha256(input: {
  sourceSnapshotSha256: string
  productionAuthorizationSha256: string
  benchmarkRepeatabilityBindingSha256: string
  corpus: z.infer<typeof CompactV31ProductionCorpusSchema>
  limits: CompactV31ResourceLimits
}): string {
  Sha256Schema.parse(input.sourceSnapshotSha256)
  Sha256Schema.parse(input.productionAuthorizationSha256)
  Sha256Schema.parse(input.benchmarkRepeatabilityBindingSha256)
  CompactV31ResourceLimitsSchema.parse(input.limits)
  return createHash('sha256').update(JSON.stringify({
    storageModel: COMPACT_V31_STORAGE_MODEL,
    pipelineVersion: '3.1.0',
    executionPurpose: 'evidence-candidate',
    ...input,
  })).digest('hex')
}

export function assessCompactV31ProductionResources(
  limitsInput: unknown,
  observation: CompactV31ResourceObservation,
): {
  safeToStart: boolean
  reasonCode: 'ready' | 'insufficient-memory' | 'worker-rss-cap-exceeded' | 'retained-delta-cap-exceeded' | 'insufficient-free-space'
  requiredAdditionalStorageBytes: number
  remainingStorageAtPeakBytes: number
} {
  const limits = CompactV31ResourceLimitsSchema.parse(limitsInput)
  for (const [name, value] of Object.entries(observation)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`)
  }
  const boundedSum = (values: readonly number[], label: string): number => values.reduce((sum, value) => {
    if (!Number.isSafeInteger(sum + value)) throw new Error(`${label} exceeds the safe integer range`)
    return sum + value
  }, 0)
  const remainingDeltaBudget = Math.max(0, limits.maximumRetainedDeltaBytes - observation.retainedDeltaBytes)
  const transientBytes = boundedSum([
    limits.maximumDeltaBytesPerArchive,
    limits.maximumPartitionRunBytes,
    limits.maximumMergeWorkspaceBytes,
    limits.maximumReceiptBytes,
    limits.maximumFinalStateBytes,
  ], 'Compact-v3.1 production transient storage')
  const requiredAdditionalStorageBytes = boundedSum(
    [remainingDeltaBudget, transientBytes],
    'Compact-v3.1 production storage requirement',
  )
  const remainingStorageAtPeakBytes = observation.availableStorageBytes - requiredAdditionalStorageBytes
  const result = (safeToStart: boolean, reasonCode: ReturnType<typeof assessCompactV31ProductionResources>['reasonCode']) => ({
    safeToStart,
    reasonCode,
    requiredAdditionalStorageBytes,
    remainingStorageAtPeakBytes,
  })
  if (observation.availableMemoryBytes < limits.minimumAvailableMemoryBytes) {
    return result(false, 'insufficient-memory')
  }
  if (observation.workerResidentBytes > limits.maximumWorkerResidentBytes) {
    return result(false, 'worker-rss-cap-exceeded')
  }
  if (observation.retainedDeltaBytes > limits.maximumRetainedDeltaBytes) {
    return result(false, 'retained-delta-cap-exceeded')
  }
  if (remainingStorageAtPeakBytes < limits.minimumFreeReserveBytes) {
    return result(false, 'insufficient-free-space')
  }
  return result(true, 'ready')
}

export type CompactV31ProductionAuthorization = z.infer<typeof CompactV31ProductionAuthorizationSchema>
export type CompactV31ProductionPlan = z.infer<typeof CompactV31ProductionPlanSchema>
export type CompactV31ProductionPlanReview = z.infer<typeof CompactV31ProductionPlanReviewSchema>
export type CompactV31ProductionArchiveReceipt = z.infer<typeof CompactV31ProductionArchiveReceiptSchema>
export type CompactV31ProductionDeltaReceipt = z.infer<typeof CompactV31ProductionDeltaReceiptSchema>
export type CompactV31ProductionMergeReceipt = z.infer<typeof CompactV31ProductionMergeReceiptSchema>
export type CompactV31ProductionCorpusReceipt = z.infer<typeof CompactV31ProductionCorpusReceiptSchema>
export type CompactV31ProductionPromotionCandidate = z.infer<typeof CompactV31ProductionPromotionCandidateSchema>

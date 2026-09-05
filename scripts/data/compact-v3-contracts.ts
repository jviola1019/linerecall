import { z } from 'zod'

export const COMPACT_EVIDENCE_SCHEMA_VERSION = 3 as const
export const COMPACT_ADAPTER_STATE_SCHEMA_VERSION = 2 as const
export const COMPACT_STORAGE_MODEL = 'bounded-two-pass-content-addressed-v3' as const
export const COMPLETE_BASELINE_MAX_PLY = 30 as const
export const ADAPTIVE_EVIDENCE_MAX_PLY = 100 as const
export const ADAPTIVE_CANDIDATE_MINIMUM_SAMPLE = 100 as const
export const COMPACT_MINIMUM_FREE_RESERVE_BYTES = 10 * 1024 * 1024 * 1024

export const COMPACT_EXECUTION_PURPOSES = [
  'evidence-candidate',
  'benchmark-bootstrap',
] as const

export type CompactExecutionPurpose = (typeof COMPACT_EXECUTION_PURPOSES)[number]

export const BOOK_TERMINAL_STATUSES = [
  'evidence_terminal',
  'depth_capped',
  'insufficient_sample',
  'quarantined',
] as const

export type BookTerminalStatus = (typeof BOOK_TERMINAL_STATUSES)[number]

const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const SafePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const MonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u)
const IsoDateTimeSchema = z.string().datetime({ offset: true })
const HttpsUrlSchema = z.string().url().startsWith('https://')
const ArchiveIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u)
const SourceIdSchema = z.enum(['lichess-broadcasts', 'lichess-standard-rated-q2-2026'])
const RelativeArtifactPathSchema = z.string().min(1).max(512).refine((value) => {
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}, 'Artifact paths must be canonical relative POSIX paths')

export const BookTerminalStatusSchema = z.enum(BOOK_TERMINAL_STATUSES)

export const CompactSourceArchiveSchema = z.object({
  archiveId: ArchiveIdSchema,
  sourceId: SourceIdSchema,
  sourceManifestSha256: Sha256Schema,
  licenseSpdxId: z.enum(['CC0-1.0', 'CC-BY-SA-4.0']),
  cutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  month: MonthSchema,
  filename: z.string().min(1).max(255),
  url: HttpsUrlSchema,
  compressedBytes: SafePositiveIntegerSchema,
  sha256: Sha256Schema,
  retrievedAt: IsoDateTimeSchema,
  etagObserved: z.string().min(1).max(512),
  lastModifiedObserved: z.string().min(1).max(512),
}).strict().superRefine((archive, context) => {
  const expectedLicense = archive.sourceId === 'lichess-broadcasts' ? 'CC-BY-SA-4.0' : 'CC0-1.0'
  if (archive.licenseSpdxId !== expectedLicense) {
    context.addIssue({
      code: 'custom',
      path: ['licenseSpdxId'],
      message: `Source ${archive.sourceId} requires ${expectedLicense}`,
    })
  }
})

export const CompactPipelineLimitsSchema = z.object({
  completeBaselineMaxPly: z.literal(COMPLETE_BASELINE_MAX_PLY),
  adaptiveEvidenceMaxPly: z.literal(ADAPTIVE_EVIDENCE_MAX_PLY),
  adaptiveCandidateMinimumSample: z.literal(ADAPTIVE_CANDIDATE_MINIMUM_SAMPLE),
  archiveConcurrency: z.literal(1),
  minimumFreeReserveBytes: SafePositiveIntegerSchema,
  countMinWidth: SafePositiveIntegerSchema,
  countMinDepth: z.number().int().min(2).max(16),
  maximumCandidates: SafePositiveIntegerSchema,
}).strict().refine(
  (limits) => limits.minimumFreeReserveBytes >= COMPACT_MINIMUM_FREE_RESERVE_BYTES,
  'The compact pipeline must reserve at least 10 GiB',
)

/**
 * These are enforced hard caps, not estimates derived from compressed-input
 * multipliers. Hitting any cap aborts an archive pass without promoting it.
 */
export const CompactStorageBoundsSchema = z.object({
  candidateSketchMaxBytes: SafePositiveIntegerSchema,
  candidateIndexMaxBytes: SafePositiveIntegerSchema,
  baselineShardMaxBytes: SafePositiveIntegerSchema,
  adaptiveShardMaxBytes: SafePositiveIntegerSchema,
  exactWorkMaxBytes: SafePositiveIntegerSchema,
  checkpointMaxBytes: SafePositiveIntegerSchema,
  atomicPromotionMaxBytes: SafePositiveIntegerSchema,
  inputStagingMaxBytes: SafeNonnegativeIntegerSchema,
  /**
   * Corpus-wide cap for every retained schema-v3 object: cumulative SQLite
   * states, immutable receipts, and archive checkpoints. Unlike the other
   * fields, this is not a one-pass workspace allowance.
   */
  retainedCorpusMaxBytes: SafePositiveIntegerSchema,
}).strict()

export const CompactExecutionPurposeSchema = z.enum(COMPACT_EXECUTION_PURPOSES)

export const CompactBenchmarkProofSchema = z.object({
  status: z.enum(['pending', 'approved']),
  method: z.literal('complete-broadcast-replay-with-enforced-hard-caps'),
  receiptSha256: Sha256Schema.nullable(),
  measuredAt: IsoDateTimeSchema.nullable(),
  acceptedGames: SafeNonnegativeIntegerSchema,
  observations: SafeNonnegativeIntegerSchema,
  peakResidentBytes: SafeNonnegativeIntegerSchema,
  peakAdditionalStorageBytes: SafeNonnegativeIntegerSchema,
  note: z.string().min(1).max(1024),
}).strict().superRefine((proof, context) => {
  const hasApprovalEvidence = proof.receiptSha256 !== null && proof.measuredAt !== null && proof.acceptedGames > 0
  if ((proof.status === 'approved') !== hasApprovalEvidence) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'Approved benchmark proof requires a receipt, timestamp, and accepted games',
    })
  }
})

export const CompactPreflightPlanSchema = z.object({
  schemaVersion: z.literal(COMPACT_EVIDENCE_SCHEMA_VERSION),
  storageModel: z.literal(COMPACT_STORAGE_MODEL),
  archive: CompactSourceArchiveSchema,
  limits: CompactPipelineLimitsSchema,
  bounds: CompactStorageBoundsSchema,
  benchmark: CompactBenchmarkProofSchema,
}).strict()

export const CompactArtifactReceiptSchema = z.object({
  path: RelativeArtifactPathSchema,
  bytes: SafePositiveIntegerSchema,
  sha256: Sha256Schema,
}).strict()

const HttpReceiptHeaderSchema = z.string().min(1).max(512).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  'HTTP receipt headers must not contain control characters',
)

/**
 * Network metadata is evidence about one successful, fully consumed stream.
 * The archive bytes and digest remain the authoritative identity. Headers are
 * retained for auditability but are never trusted instead of that identity.
 */
export const CompactRemoteInputAcquisitionSchema = z.object({
  transport: z.literal('approved-https'),
  requestedUrl: HttpsUrlSchema,
  finalUrl: HttpsUrlSchema,
  redirectCount: z.number().int().min(0).max(3),
  retrievedAt: IsoDateTimeSchema,
  etagObserved: HttpReceiptHeaderSchema.nullable(),
  lastModifiedObserved: HttpReceiptHeaderSchema.nullable(),
}).strict()

export type CompactRemoteInputAcquisition = z.infer<typeof CompactRemoteInputAcquisitionSchema>

const CompactPassReceiptBaseSchema = z.object({
  schemaVersion: z.literal(COMPACT_EVIDENCE_SCHEMA_VERSION),
  storageModel: z.literal(COMPACT_STORAGE_MODEL),
  executionPurpose: CompactExecutionPurposeSchema,
  releaseEligible: z.literal(false),
  archive: CompactSourceArchiveSchema,
  limits: CompactPipelineLimitsSchema,
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
  compressedInput: z.object({
    bytes: SafePositiveIntegerSchema,
    sha256: Sha256Schema,
    verified: z.literal(true),
    acquisition: CompactRemoteInputAcquisitionSchema.optional(),
  }).strict(),
  output: CompactArtifactReceiptSchema,
  recordsSeen: SafeNonnegativeIntegerSchema,
  accepted: SafeNonnegativeIntegerSchema,
  deduplicated: SafeNonnegativeIntegerSchema,
  rejected: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u), SafeNonnegativeIntegerSchema),
  toolchain: z.object({
    node: z.string().min(1),
    chessJs: z.string().min(1),
    zstd: z.string().min(1),
    sourceSnapshotSha256: Sha256Schema,
    adapterStateSchemaVersion: z.literal(COMPACT_ADAPTER_STATE_SCHEMA_VERSION),
  }).strict(),
}).strict()

const CompactCandidatePassReceiptSchema = CompactPassReceiptBaseSchema.extend({
  pass: z.literal('candidate'),
  priorCandidateStateSha256: Sha256Schema.nullable(),
  nextCandidateStateSha256: Sha256Schema,
  adaptiveObservationsSeen: SafeNonnegativeIntegerSchema,
  candidateRows: SafeNonnegativeIntegerSchema,
  candidateFalsePositivesAllowed: z.literal(true),
  candidateFalseNegativesAllowed: z.literal(false),
  hardCapReached: z.literal(false),
}).strict()

const CompactExactPassReceiptSchema = CompactPassReceiptBaseSchema.extend({
  pass: z.literal('exact'),
  priorExactStateSha256: Sha256Schema.nullable(),
  finalCandidateSetReceiptSha256: Sha256Schema,
  completeBaselineObservationsRetained: SafeNonnegativeIntegerSchema,
  adaptiveCandidateObservationsRetained: SafeNonnegativeIntegerSchema,
  adaptiveNoncandidateObservationsRejected: SafeNonnegativeIntegerSchema,
  normalizedPositionRows: SafeNonnegativeIntegerSchema,
  normalizedEdgeRows: SafeNonnegativeIntegerSchema,
  hardCapReached: z.literal(false),
}).strict()

export const CompactPassReceiptSchema = z.discriminatedUnion('pass', [
  CompactCandidatePassReceiptSchema,
  CompactExactPassReceiptSchema,
]).superRefine((receipt, context) => {
  if (
    receipt.compressedInput.bytes !== receipt.archive.compressedBytes ||
    receipt.compressedInput.sha256 !== receipt.archive.sha256
  ) {
    context.addIssue({
      code: 'custom',
      path: ['compressedInput'],
      message: 'Pass input must match the approved source archive exactly',
    })
  }
  const acquisition = receipt.compressedInput.acquisition
  if (acquisition && (
    acquisition.requestedUrl !== receipt.archive.url ||
    acquisition.finalUrl !== receipt.archive.url
  )) {
    context.addIssue({
      code: 'custom',
      path: ['compressedInput', 'acquisition'],
      message: 'Remote pass input must use the exact approved archive URL',
    })
  }
  const rejected = Object.values(receipt.rejected).reduce((sum, count) => sum + count, 0)
  if (receipt.recordsSeen !== receipt.accepted + receipt.deduplicated + rejected) {
    context.addIssue({
      code: 'custom',
      path: ['recordsSeen'],
      message: 'Accepted, deduplicated, and rejected totals must reconcile',
    })
  }
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
    context.addIssue({ code: 'custom', path: ['completedAt'], message: 'Pass completion precedes its start' })
  }
})

export const CompactArchiveCheckpointSchema = z.object({
  schemaVersion: z.literal(COMPACT_EVIDENCE_SCHEMA_VERSION),
  archive: CompactSourceArchiveSchema,
  candidateReceipt: CompactPassReceiptSchema.nullable(),
  exactReceipt: CompactPassReceiptSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  resumePolicy: z.literal('archive-pass-atomic-replay-from-start'),
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.candidateReceipt?.pass !== 'candidate' && checkpoint.candidateReceipt !== null) {
    context.addIssue({ code: 'custom', path: ['candidateReceipt'], message: 'Candidate receipt has the wrong pass' })
  }
  if (checkpoint.exactReceipt?.pass !== 'exact' && checkpoint.exactReceipt !== null) {
    context.addIssue({ code: 'custom', path: ['exactReceipt'], message: 'Exact receipt has the wrong pass' })
  }
  for (const [field, receipt] of [
    ['candidateReceipt', checkpoint.candidateReceipt],
    ['exactReceipt', checkpoint.exactReceipt],
  ] as const) {
    if (receipt && (
      receipt.archive.archiveId !== checkpoint.archive.archiveId ||
      receipt.archive.sha256 !== checkpoint.archive.sha256
    )) {
      context.addIssue({ code: 'custom', path: [field], message: 'Checkpoint receipt belongs to another archive' })
    }
  }
  if (checkpoint.exactReceipt !== null && checkpoint.candidateReceipt === null) {
    context.addIssue({ code: 'custom', path: ['exactReceipt'], message: 'Exact pass requires a candidate receipt' })
  }
  const candidateInput = checkpoint.candidateReceipt?.compressedInput
  const exactInput = checkpoint.exactReceipt?.compressedInput
  if (candidateInput && exactInput && (
    candidateInput.bytes !== exactInput.bytes ||
    candidateInput.sha256 !== exactInput.sha256
  )) {
    context.addIssue({
      code: 'custom',
      path: ['exactReceipt', 'compressedInput'],
      message: 'Candidate and exact passes must bind the same approved archive identity',
    })
  }
})

export const CompactBenchmarkBootstrapReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v3-benchmark-bootstrap'),
  executionPurpose: z.literal('benchmark-bootstrap'),
  provisional: z.literal(true),
  approvalStatus: z.literal('unapproved'),
  releaseEligible: z.literal(false),
  method: z.literal('complete-broadcast-replay-with-enforced-hard-caps'),
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/u),
  sourceManifestSha256: Sha256Schema,
  sourceSnapshotSha256: Sha256Schema,
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema,
  corpus: z.object({
    sourceId: z.literal('lichess-broadcasts'),
    archiveCount: z.literal(78),
    publishedGames: z.literal(1_146_297),
    candidatePasses: z.literal(78),
    exactPasses: z.literal(78),
  }).strict(),
  accounting: z.object({
    recordsSeen: z.literal(1_146_297),
    accepted: SafePositiveIntegerSchema,
    deduplicated: SafeNonnegativeIntegerSchema,
    rejected: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u), SafeNonnegativeIntegerSchema),
    observations: SafePositiveIntegerSchema,
  }).strict(),
  resources: z.object({
    sampleIntervalMs: z.number().int().min(100).max(10_000),
    samples: SafePositiveIntegerSchema,
    peakResidentBytes: SafePositiveIntegerSchema,
    peakAdditionalStorageBytes: SafeNonnegativeIntegerSchema,
    retainedStateBytes: SafePositiveIntegerSchema,
    wallClockMilliseconds: SafePositiveIntegerSchema,
    peakBytesPerAcceptedGame: z.number().finite().nonnegative(),
    retainedBytesPerAcceptedGame: z.number().finite().nonnegative(),
  }).strict(),
  enforcedLimits: CompactPipelineLimitsSchema,
  enforcedBounds: CompactStorageBoundsSchema,
  pipelineReceiptSha256s: z.array(Sha256Schema).length(156),
  note: z.string().min(1).max(2048),
}).strict().superRefine((receipt, context) => {
  const rejected = Object.values(receipt.accounting.rejected).reduce((sum, count) => sum + count, 0)
  if (
    receipt.accounting.recordsSeen !==
    receipt.accounting.accepted + receipt.accounting.deduplicated + rejected
  ) {
    context.addIssue({
      code: 'custom',
      path: ['accounting'],
      message: 'Benchmark accounting must reconcile exactly',
    })
  }
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
    context.addIssue({ code: 'custom', path: ['completedAt'], message: 'Benchmark completion precedes its start' })
  }
})

export const CompactBenchmarkApprovalReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v3-benchmark-approval'),
  approvalStatus: z.literal('approved'),
  releaseEligible: z.literal(false),
  approvedAt: IsoDateTimeSchema,
  approvedBy: z.string().min(1).max(256),
  reviewNote: z.string().min(1).max(2048),
  bootstrapReceiptSha256: Sha256Schema,
  bootstrap: CompactBenchmarkBootstrapReceiptSchema,
}).strict().superRefine((receipt, context) => {
  if (Date.parse(receipt.approvedAt) < Date.parse(receipt.bootstrap.completedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['approvedAt'],
      message: 'Benchmark approval cannot predate the completed bootstrap replay',
    })
  }
})

export type CompactSourceArchive = z.infer<typeof CompactSourceArchiveSchema>
export type CompactPipelineLimits = z.infer<typeof CompactPipelineLimitsSchema>
export type CompactStorageBounds = z.infer<typeof CompactStorageBoundsSchema>
export type CompactBenchmarkProof = z.infer<typeof CompactBenchmarkProofSchema>
export type CompactPreflightPlan = z.infer<typeof CompactPreflightPlanSchema>
export type CompactArtifactReceipt = z.infer<typeof CompactArtifactReceiptSchema>
export type CompactPassReceipt = z.infer<typeof CompactPassReceiptSchema>
export type CompactArchiveCheckpoint = z.infer<typeof CompactArchiveCheckpointSchema>
export type CompactBenchmarkBootstrapReceipt = z.infer<typeof CompactBenchmarkBootstrapReceiptSchema>
export type CompactBenchmarkApprovalReceipt = z.infer<typeof CompactBenchmarkApprovalReceiptSchema>

import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  FamilyIdSchema,
  FamilyReleaseIdSchema,
} from '../../src/domain/opening-family.ts'
import {
  PUZZLE_ENGINE_SETTINGS,
  PUZZLE_ENGINE_SETTINGS_SHA256,
  PUZZLE_SCHEMA_VERSION,
  PuzzleCandidateSchema,
  PuzzleSourceBindingSchema,
  VerifiedPuzzleRecordSchema,
} from './puzzle-contracts.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_SQLITE_PATH = /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,494}\.sqlite$/u
const SAFE_RECEIPT_PATH = /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,500}\.json$/u
const SafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const PositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const Sha256Schema = z.string().regex(SHA256)

function canonicalRelativePath(value: string): boolean {
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

const AssociationDatabasePathSchema = z.string().regex(SAFE_SQLITE_PATH).refine(
  canonicalRelativePath,
  'Association database path must be canonical and repository-relative',
)
const EngineReceiptPathSchema = z.string().regex(SAFE_RECEIPT_PATH).refine(
  canonicalRelativePath,
  'Engine receipt path must be canonical and repository-relative',
)
const PuzzleJsonReceiptPathSchema = z.string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,500}\.json(?:\.gz)?$/u)
  .refine(canonicalRelativePath, 'Puzzle evidence receipt path must be canonical and repository-relative')

export const PUZZLE_V3_WIRING_SCHEMA_VERSION = 1 as const
export const BROADCAST_PUBLISHED_GAMES = 1_146_297 as const
export const Q2_PUBLISHED_GAMES = 267_333_507 as const

export const PuzzleCompactCorpusBindingV1Schema = z.object({
  sourceId: z.enum(['lichess-broadcasts', 'lichess-standard-rated-q2-2026']),
  sourceManifestSha256: Sha256Schema,
  sourceSnapshotSha256: Sha256Schema,
  archiveCount: z.number().int().positive().max(78),
  recordsSeen: PositiveIntegerSchema,
  accepted: PositiveIntegerSchema,
  deduplicated: SafeIntegerSchema,
  rejected: SafeIntegerSchema,
  finalExactReceiptSha256: Sha256Schema,
  finalExactStateSha256: Sha256Schema,
  positions: PositiveIntegerSchema,
  edges: PositiveIntegerSchema,
  outcomes: PositiveIntegerSchema,
}).strict().superRefine((corpus, context) => {
  if (corpus.recordsSeen !== corpus.accepted + corpus.deduplicated + corpus.rejected) {
    context.addIssue({ code: 'custom', path: ['recordsSeen'], message: 'Compact corpus accounting does not reconcile' })
  }
  const expected = corpus.sourceId === 'lichess-broadcasts'
    ? { archiveCount: 78, recordsSeen: BROADCAST_PUBLISHED_GAMES }
    : { archiveCount: 3, recordsSeen: Q2_PUBLISHED_GAMES }
  if (corpus.archiveCount !== expected.archiveCount || corpus.recordsSeen !== expected.recordsSeen) {
    context.addIssue({
      code: 'custom',
      message: `Compact ${corpus.sourceId} binding is not the complete approved corpus`,
    })
  }
})

export type PuzzleCompactCorpusBindingV1 = z.infer<typeof PuzzleCompactCorpusBindingV1Schema>

export const PuzzleFamilyAssociationManifestV1Schema = z.object({
  schemaVersion: z.literal(PUZZLE_V3_WIRING_SCHEMA_VERSION),
  releaseId: FamilyReleaseIdSchema,
  status: z.literal('complete'),
  generatedAt: z.string().datetime({ offset: true }),
  database: z.object({
    path: AssociationDatabasePathSchema,
    bytes: PositiveIntegerSchema,
    sha256: Sha256Schema,
  }).strict(),
  compactEvidence: z.object({
    broadcastFinalExactStateSha256: Sha256Schema,
    broadcastFinalExactReceiptSha256: Sha256Schema,
    q2FinalExactStateSha256: Sha256Schema,
    q2FinalExactReceiptSha256: Sha256Schema,
    sourceSnapshotSha256: Sha256Schema,
  }).strict(),
  familyEvidence: z.object({
    catalogSha256: Sha256Schema,
    graphReconciliationSha256: Sha256Schema,
    taxonomyLineCount: z.literal(3_790),
    familyCount: PositiveIntegerSchema.max(3_790),
    exactPositionAssociations: PositiveIntegerSchema,
    tagAssociations: PositiveIntegerSchema,
    allTaxonomyRowsAssigned: z.literal(true),
    allEligibleEdgesRepresented: z.literal(true),
    topNPracticeCutoffApplied: z.literal(false),
    hiddenEligiblePracticeBranches: z.literal(0),
  }).strict(),
}).strict()

export type PuzzleFamilyAssociationManifestV1 = z.infer<typeof PuzzleFamilyAssociationManifestV1Schema>

export const PuzzleEngineCampaignV1Schema = z.object({
  schemaVersion: z.literal(PUZZLE_V3_WIRING_SCHEMA_VERSION),
  releaseId: FamilyReleaseIdSchema,
  status: z.literal('ready-for-analysis'),
  verifiedAt: z.string().datetime({ offset: true }),
  engine: z.object({
    name: z.literal('Stockfish 18'),
    releaseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    sourceManifestSha256: Sha256Schema,
    executableSha256: Sha256Schema,
    nnueSha256: z.array(Sha256Schema).min(1).max(8),
    settings: z.object({
      threads: z.literal(1),
      hashMb: z.literal(128),
      multiPv: z.literal(5),
      nodes: z.literal(250_000),
    }).strict(),
    settingsSha256: z.literal(PUZZLE_ENGINE_SETTINGS_SHA256),
  }).strict(),
  sourceReceipt: z.object({
    path: EngineReceiptPathSchema,
    bytes: PositiveIntegerSchema.max(4 * 1024 * 1024),
    sha256: Sha256Schema,
  }).strict(),
}).strict().superRefine((campaign, context) => {
  if (new Set(campaign.engine.nnueSha256).size !== campaign.engine.nnueSha256.length) {
    context.addIssue({ code: 'custom', path: ['engine', 'nnueSha256'], message: 'NNUE hashes must be unique' })
  }
  if (JSON.stringify(campaign.engine.settings) !== JSON.stringify(PUZZLE_ENGINE_SETTINGS)) {
    context.addIssue({ code: 'custom', path: ['engine', 'settings'], message: 'Puzzle engine settings changed' })
  }
})

export type PuzzleEngineCampaignV1 = z.infer<typeof PuzzleEngineCampaignV1Schema>

export const PuzzleV3EvidenceBindingV1Schema = z.object({
  schemaVersion: z.literal(PUZZLE_V3_WIRING_SCHEMA_VERSION),
  releaseId: FamilyReleaseIdSchema,
  storageModel: z.literal('bounded-two-pass-content-addressed-v3'),
  releaseEligible: z.literal(false),
  puzzleSource: PuzzleSourceBindingSchema,
  compactEvidence: z.object({
    broadcast: PuzzleCompactCorpusBindingV1Schema,
    q2: PuzzleCompactCorpusBindingV1Schema,
    sharedSourceSnapshotSha256: Sha256Schema,
  }).strict(),
  familyAssociation: z.object({
    manifestSha256: Sha256Schema,
    databaseSha256: Sha256Schema,
    catalogSha256: Sha256Schema,
    graphReconciliationSha256: Sha256Schema,
    familyCount: PositiveIntegerSchema.max(3_790),
    exactPositionAssociations: PositiveIntegerSchema,
    tagAssociations: PositiveIntegerSchema,
  }).strict(),
  engineCampaign: z.object({
    campaignSha256: Sha256Schema,
    sourceReceiptSha256: Sha256Schema,
    sourceManifestSha256: Sha256Schema,
    releaseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    executableSha256: Sha256Schema,
    nnueSha256: z.array(Sha256Schema).min(1).max(8),
    settingsSha256: z.literal(PUZZLE_ENGINE_SETTINGS_SHA256),
  }).strict(),
}).strict().superRefine((binding, context) => {
  const { broadcast, q2, sharedSourceSnapshotSha256 } = binding.compactEvidence
  if (broadcast.sourceId !== 'lichess-broadcasts') {
    context.addIssue({ code: 'custom', path: ['compactEvidence', 'broadcast', 'sourceId'], message: 'Broadcast binding uses the wrong corpus' })
  }
  if (q2.sourceId !== 'lichess-standard-rated-q2-2026') {
    context.addIssue({ code: 'custom', path: ['compactEvidence', 'q2', 'sourceId'], message: 'Q2 binding uses the wrong corpus' })
  }
  if (
    broadcast.sourceSnapshotSha256 !== sharedSourceSnapshotSha256 ||
    q2.sourceSnapshotSha256 !== sharedSourceSnapshotSha256
  ) {
    context.addIssue({ code: 'custom', path: ['compactEvidence'], message: 'Compact corpora use different source snapshots' })
  }
})

export type PuzzleV3EvidenceBindingV1 = z.infer<typeof PuzzleV3EvidenceBindingV1Schema>

export const PuzzleV3CandidateEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(PUZZLE_V3_WIRING_SCHEMA_VERSION),
  releaseId: FamilyReleaseIdSchema,
  evidenceBindingSha256: Sha256Schema,
  familyIds: z.array(FamilyIdSchema).min(1).max(256),
  candidate: PuzzleCandidateSchema,
}).strict().superRefine((envelope, context) => {
  if (new Set(envelope.familyIds).size !== envelope.familyIds.length) {
    context.addIssue({ code: 'custom', path: ['familyIds'], message: 'Candidate family associations must be unique' })
  }
  if (envelope.candidate.association.confidence === 'unlinked') {
    context.addIssue({ code: 'custom', path: ['candidate', 'association'], message: 'Unlinked puzzles cannot enter a family candidate shard' })
  }
})

export const PuzzleV3VerifiedEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(PUZZLE_V3_WIRING_SCHEMA_VERSION),
  releaseId: FamilyReleaseIdSchema,
  evidenceBindingSha256: Sha256Schema,
  familyIds: z.array(FamilyIdSchema).min(1).max(256),
  record: VerifiedPuzzleRecordSchema,
}).strict().superRefine((envelope, context) => {
  if (new Set(envelope.familyIds).size !== envelope.familyIds.length) {
    context.addIssue({ code: 'custom', path: ['familyIds'], message: 'Verified puzzle family associations must be unique' })
  }
  if (!envelope.record.releaseEligible || envelope.record.engineStatus !== 'verified') {
    context.addIssue({ code: 'custom', path: ['record'], message: 'Promotion accepts only release-eligible engine-verified puzzles' })
  }
})

export type PuzzleV3CandidateEnvelopeV1 = z.infer<typeof PuzzleV3CandidateEnvelopeV1Schema>
export type PuzzleV3VerifiedEnvelopeV1 = z.infer<typeof PuzzleV3VerifiedEnvelopeV1Schema>

const PuzzleSelectionSchema = z.object({
  openingTagsRequired: z.literal(true),
  minimumPlays: z.literal(100),
  minimumPopularity: z.literal(80),
  maximumRatingDeviation: z.literal(100),
  minimumLearnerDecisions: z.literal(1),
  maximumLearnerDecisions: z.literal(5),
  legalStandardChessRequired: z.literal(true),
  engineSanityCheckRequired: z.literal(true),
  sourceGameBulkFetchProhibited: z.literal(true),
}).strict()

const PuzzleTotalsSchema = z.object({
  rowsSeen: SafeIntegerSchema,
  candidates: SafeIntegerSchema,
  duplicates: SafeIntegerSchema,
  rejected: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u), SafeIntegerSchema),
  association: z.object({
    'exact-position': SafeIntegerSchema,
    'opening-family': SafeIntegerSchema,
    unlinked: SafeIntegerSchema,
  }).strict(),
}).strict().superRefine((totals, context) => {
  if (totals.candidates !== totals.association['exact-position'] + totals.association['opening-family']) {
    context.addIssue({ code: 'custom', path: ['candidates'], message: 'Candidate total does not match linked association totals' })
  }
  if ((totals.rejected.unlinked_association ?? 0) !== totals.association.unlinked) {
    context.addIssue({ code: 'custom', path: ['association', 'unlinked'], message: 'Unlinked associations must be rejected exactly once' })
  }
  let rejected = 0
  for (const count of Object.values(totals.rejected)) {
    rejected += count
    if (!Number.isSafeInteger(rejected)) {
      context.addIssue({ code: 'custom', path: ['rejected'], message: 'Rejected puzzle total exceeds the safe integer range' })
      return
    }
  }
  const represented = totals.candidates + totals.duplicates + rejected
  if (!Number.isSafeInteger(represented) || represented !== totals.rowsSeen) {
    context.addIssue({
      code: 'custom',
      path: ['rowsSeen'],
      message: 'Puzzle rows must equal candidates, duplicates, and every rejection exactly',
    })
  }
})

export const PuzzleV3CandidateManifestV1Schema = z.object({
  schemaVersion: z.literal(PUZZLE_V3_WIRING_SCHEMA_VERSION),
  releaseId: FamilyReleaseIdSchema,
  generatedAt: z.string().datetime({ offset: true }),
  releaseEligible: z.literal(false),
  evidence: PuzzleV3EvidenceBindingV1Schema,
  evidenceBindingSha256: Sha256Schema,
  selection: PuzzleSelectionSchema,
  totals: PuzzleTotalsSchema,
  candidates: z.object({
    path: z.literal('candidates.ndjson.gz'),
    bytes: PositiveIntegerSchema,
    sha256: Sha256Schema,
    contentEncoding: z.literal('gzip'),
    recordSchema: z.literal('PuzzleV3CandidateEnvelopeV1'),
  }).strict(),
  blockedGates: z.tuple([
    z.literal('stockfish-proof-per-learner-node'),
    z.literal('promoted-tactical-shards'),
  ]),
}).strict().superRefine((manifest, context) => {
  if (manifest.releaseId !== manifest.evidence.releaseId) {
    context.addIssue({ code: 'custom', path: ['releaseId'], message: 'Candidate manifest release differs from its evidence' })
  }
  if (sha256Json(manifest.evidence) !== manifest.evidenceBindingSha256) {
    context.addIssue({ code: 'custom', path: ['evidenceBindingSha256'], message: 'Evidence binding hash is invalid' })
  }
})

export const PuzzlePromotionReceiptV1Schema = z.object({
  schemaVersion: z.literal(1),
  releaseId: FamilyReleaseIdSchema,
  status: z.literal('pass'),
  completedAt: z.string().datetime({ offset: true }),
  gate: z.literal('lichess-puzzle-promotion'),
  sourceDigestApproved: z.literal(true),
  sourceSha256: Sha256Schema,
  promotedShardCount: z.number().int().positive().max(1_000),
  promotedPuzzleCount: PositiveIntegerSchema,
  legalityComplete: z.literal(true),
  associationComplete: z.literal(true),
  engineChecksComplete: z.literal(true),
  duplicatePuzzleIds: z.literal(0),
  evidenceBindingSha256: Sha256Schema,
  engineCampaignSha256: Sha256Schema,
  proofInventory: z.object({
    path: PuzzleJsonReceiptPathSchema,
    sha256: Sha256Schema,
    bytes: PositiveIntegerSchema.max(64 * 1024 * 1024),
    uncompressedBytes: PositiveIntegerSchema.max(256 * 1024 * 1024),
    encoding: z.enum(['identity', 'gzip']),
  }).strict(),
}).strict().superRefine((receipt, context) => {
  if (
    (receipt.proofInventory.encoding === 'identity') !==
    (receipt.proofInventory.path.endsWith('.json') && !receipt.proofInventory.path.endsWith('.json.gz'))
  ) {
    context.addIssue({ code: 'custom', path: ['proofInventory', 'path'], message: 'Proof inventory path and encoding disagree' })
  }
  if (
    receipt.proofInventory.encoding === 'identity' &&
    receipt.proofInventory.bytes !== receipt.proofInventory.uncompressedBytes
  ) {
    context.addIssue({ code: 'custom', path: ['proofInventory'], message: 'Identity proof inventory byte lengths must match' })
  }
})

export type PuzzleV3CandidateManifestV1 = z.infer<typeof PuzzleV3CandidateManifestV1Schema>
export type PuzzlePromotionReceiptV1 = z.infer<typeof PuzzlePromotionReceiptV1Schema>

/** Stable hashes are only used for already schema-normalized objects. */
export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function assertEngineProofsMatchCampaign(
  envelopeInput: unknown,
  evidenceInput: unknown,
): PuzzleV3VerifiedEnvelopeV1 {
  const envelope = PuzzleV3VerifiedEnvelopeV1Schema.parse(envelopeInput)
  const evidence = PuzzleV3EvidenceBindingV1Schema.parse(evidenceInput)
  if (envelope.releaseId !== evidence.releaseId || envelope.evidenceBindingSha256 !== sha256Json(evidence)) {
    throw new Error('Verified puzzle belongs to another evidence binding or release')
  }
  const acceptedNnue = new Set(evidence.engineCampaign.nnueSha256)
  for (const proof of envelope.record.engineChecks) {
    if (
      proof.engineSha256 !== evidence.engineCampaign.executableSha256 ||
      !acceptedNnue.has(proof.nnueSha256) ||
      proof.settingsSha256 !== evidence.engineCampaign.settingsSha256
    ) {
      throw new Error(`Puzzle ${envelope.record.puzzleId} has an engine proof outside the approved campaign`)
    }
  }
  return envelope
}

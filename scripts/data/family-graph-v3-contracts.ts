import { z } from 'zod'
import { MAXIMUM_AUDITED_FAMILY_PACKS } from './family-engine-v3-contracts.ts'
import { ImmutableJsonReceiptV1Schema } from '../release/lib/immutable-json-receipt.ts'
import {
  FamilyIdSchema,
  FamilyPackIdSchema,
  FamilyReleaseIdSchema,
} from '../../src/domain/opening-family.ts'
import {
  FamilyGraphProvenanceDocumentV1Schema,
  RepertoireEngineCheckSchema,
  RepertoireProvenanceRefSchema,
} from '../../src/domain/repertoire.ts'
import { EcoCodeSchema, EpdSchema, UciMoveSchema } from '../../src/domain/opening-data.ts'

export const FAMILY_GRAPH_BUILD_SCHEMA_VERSION = 1 as const

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const SafeRelativePathSchema = ImmutableJsonReceiptV1Schema.shape.path
const CohortIdSchema = z.string().regex(/^cohort_[a-z0-9-]{3,64}$/u)

export const CompactExactStateArtifactV1Schema = z.object({
  path: SafeRelativePathSchema,
  sha256: Sha256Schema,
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()

export const CompactExactCorpusGraphHandoffV1Schema = z.object({
  sourceId: z.enum(['lichess-broadcasts', 'lichess-standard-rated-q2-2026']),
  sourceManifest: ImmutableJsonReceiptV1Schema.refine(
    ({ encoding }) => encoding === 'identity',
    'Approved source manifests must be retained as their exact identity bytes',
  ),
  configurationSha256: Sha256Schema,
  checkpoints: z.array(ImmutableJsonReceiptV1Schema).min(1).max(78),
  finalExactState: CompactExactStateArtifactV1Schema,
}).strict()

/**
 * This is a direct receipt-chain handoff, not a boolean assertion that an
 * audit happened. The consumer replays every checkpoint link, approved source
 * identity, accounting total, and final SQLite identity before querying it.
 */
export const CompactExactFamilyGraphHandoffV1Schema = z.object({
  schemaVersion: z.literal(FAMILY_GRAPH_BUILD_SCHEMA_VERSION),
  kind: z.literal('linerecall-compact-v3-exact-family-graph-handoff'),
  releaseId: FamilyReleaseIdSchema,
  storageModel: z.literal('bounded-two-pass-content-addressed-v3'),
  corpora: z.array(CompactExactCorpusGraphHandoffV1Schema).length(2),
}).strict().superRefine((handoff, context) => {
  const sourceIds = handoff.corpora.map(({ sourceId }) => sourceId)
  if (new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({ code: 'custom', path: ['corpora'], message: 'Exact corpus handoffs must be unique' })
  }
  for (const required of ['lichess-broadcasts', 'lichess-standard-rated-q2-2026'] as const) {
    if (!sourceIds.includes(required)) {
      context.addIssue({ code: 'custom', path: ['corpora'], message: `Missing required exact corpus ${required}` })
    }
  }
  const paths = handoff.corpora.flatMap(({ sourceManifest, checkpoints, finalExactState }) => [
    sourceManifest.path,
    ...checkpoints.map(({ path }) => path),
    finalExactState.path,
  ])
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: 'custom', path: ['corpora'], message: 'Handoff resource paths must be unique' })
  }
})

export const FamilyGraphEvidenceCohortDeclarationV1Schema = z.object({
  cohortId: CohortIdSchema,
  exactSourceId: z.enum(['lichess-broadcasts', 'lichess-standard-rated-q2-2026']),
  source: z.enum(['broadcast', 'lichess-standard']),
  ratingSystem: z.enum(['broadcast-rating', 'lichess-glicko2']),
  timeControl: z.enum(['blitz', 'rapid', 'classical']),
  cutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
}).strict().superRefine((cohort, context) => {
  const isBroadcast = cohort.exactSourceId === 'lichess-broadcasts'
  if (cohort.source !== (isBroadcast ? 'broadcast' : 'lichess-standard')) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'Evidence source must match its exact corpus' })
  }
  if (cohort.ratingSystem !== (isBroadcast ? 'broadcast-rating' : 'lichess-glicko2')) {
    context.addIssue({ code: 'custom', path: ['ratingSystem'], message: 'Rating system must match its exact corpus' })
  }
})

export const FamilyGraphEngineProofV1Schema = z.object({
  fromEpd: EpdSchema,
  uci: UciMoveSchema,
  toEpd: EpdSchema,
  check: RepertoireEngineCheckSchema,
}).strict().superRefine((proof, context) => {
  if (proof.check.analyzedMoveUci !== proof.uci) {
    context.addIssue({ code: 'custom', path: ['check'], message: 'Engine proof must analyze its exact source edge' })
  }
})

export const FamilyGraphEngineProofSetV1Schema = z.object({
  schemaVersion: z.literal(FAMILY_GRAPH_BUILD_SCHEMA_VERSION),
  kind: z.literal('linerecall-stockfish-18-family-edge-proofs'),
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  packId: FamilyPackIdSchema,
  provenanceRef: RepertoireProvenanceRefSchema,
  candidatePackSha256: Sha256Schema,
  empiricalInventorySha256: Sha256Schema,
  proofs: z.array(FamilyGraphEngineProofV1Schema).max(200_000),
}).strict().superRefine((proofSet, context) => {
  const identities = proofSet.proofs.map(({ fromEpd, uci, toEpd }) => `${fromEpd}\0${uci}\0${toEpd}`)
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: 'custom', path: ['proofs'], message: 'Engine edge proofs must be unique' })
  }
})

export const FamilyGraphBranchRuleV1Schema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  canonicalName: z.string().min(1).max(80),
  /** Longest matching legal UCI prefix wins; ties are forbidden. */
  movePrefix: z.array(UciMoveSchema).min(1).max(100),
}).strict()

export const FamilyGraphPackBuildSpecV1Schema = z.object({
  schemaVersion: z.literal(FAMILY_GRAPH_BUILD_SCHEMA_VERSION),
  kind: z.literal('linerecall-compact-v3-family-pack-build-spec'),
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  canonicalName: z.string().min(1).max(128),
  packId: FamilyPackIdSchema,
  side: z.enum(['white', 'black']),
  rootEpd: EpdSchema,
  rootPly: z.number().int().min(0).max(99),
  ecoCodes: z.array(EcoCodeSchema).min(1).max(500),
  selectionCohortId: CohortIdSchema,
  cohorts: z.array(FamilyGraphEvidenceCohortDeclarationV1Schema).min(1).max(64),
  provenanceRef: RepertoireProvenanceRefSchema,
  /** Added after engine/Scid receipts exist; not required for the pre-engine traversal. */
  provenanceDocument: ImmutableJsonReceiptV1Schema.optional(),
  /** Absent only in the pre-engine candidate phase; final graph build fails closed without it. */
  engineCandidatePack: ImmutableJsonReceiptV1Schema.optional(),
  engineProofSet: ImmutableJsonReceiptV1Schema.optional(),
  branchRules: z.array(FamilyGraphBranchRuleV1Schema).max(10_000),
  limits: z.object({
    maximumNodes: z.number().int().min(2).max(100_000),
    maximumEdges: z.number().int().min(1).max(200_000),
    maximumPaths: z.number().int().min(1).max(100_000),
  }).strict(),
}).strict().superRefine((spec, context) => {
  if (new Set(spec.ecoCodes).size !== spec.ecoCodes.length) {
    context.addIssue({ code: 'custom', path: ['ecoCodes'], message: 'ECO codes must be unique' })
  }
  if (new Set(spec.cohorts.map(({ cohortId }) => cohortId)).size !== spec.cohorts.length) {
    context.addIssue({ code: 'custom', path: ['cohorts'], message: 'Cohort IDs must be unique' })
  }
  if (!spec.cohorts.some(({ cohortId }) => cohortId === spec.selectionCohortId)) {
    context.addIssue({ code: 'custom', path: ['selectionCohortId'], message: 'Selection cohort must be declared' })
  }
  if (new Set(spec.branchRules.map(({ id }) => id)).size !== spec.branchRules.length) {
    context.addIssue({ code: 'custom', path: ['branchRules'], message: 'Branch rule IDs must be unique' })
  }
  const prefixes = spec.branchRules.map(({ movePrefix }) => movePrefix.join(' '))
  if (new Set(prefixes).size !== prefixes.length) {
    context.addIssue({ code: 'custom', path: ['branchRules'], message: 'Branch move prefixes must be unique' })
  }
})

export const FamilyGraphBuildRequestV1Schema = z.object({
  schemaVersion: z.literal(FAMILY_GRAPH_BUILD_SCHEMA_VERSION),
  handoff: ImmutableJsonReceiptV1Schema,
  packSpecs: z.array(ImmutableJsonReceiptV1Schema).min(1).max(MAXIMUM_AUDITED_FAMILY_PACKS),
}).strict().superRefine((request, context) => {
  const paths = [request.handoff.path, ...request.packSpecs.map(({ path }) => path)]
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: 'custom', path: ['packSpecs'], message: 'Build input receipts must be unique' })
  }
})

export const FamilyGraphBuildOutputV1Schema = z.object({
  schemaVersion: z.literal(FAMILY_GRAPH_BUILD_SCHEMA_VERSION),
  kind: z.literal('linerecall-compact-v3-family-graph-build-output'),
  releaseId: FamilyReleaseIdSchema,
  exactHandoffSha256: Sha256Schema,
  selectionPolicy: z.object({
    practiceBranches: z.literal('all-eligible-audited'),
    maximumPracticeBranches: z.null(),
    minimumDrillSample: z.literal(500),
    minimumExploratorySample: z.literal(100),
    maximumPly: z.literal(100),
  }).strict(),
  packs: z.array(z.object({
    familyId: FamilyIdSchema,
    packId: FamilyPackIdSchema,
    graph: ImmutableJsonReceiptV1Schema,
    eligibleInventory: ImmutableJsonReceiptV1Schema,
    sourceExactStateSha256s: z.array(Sha256Schema).length(2),
  }).strict()).min(1).max(MAXIMUM_AUDITED_FAMILY_PACKS),
}).strict().superRefine((output, context) => {
  if (new Set(output.packs.map(({ packId }) => packId)).size !== output.packs.length) {
    context.addIssue({ code: 'custom', path: ['packs'], message: 'Output pack IDs must be unique' })
  }
  const paths = output.packs.flatMap(({ graph, eligibleInventory }) => [graph.path, eligibleInventory.path])
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: 'custom', path: ['packs'], message: 'Output artifact paths must be unique' })
  }
})

export type CompactExactFamilyGraphHandoffV1 = z.infer<typeof CompactExactFamilyGraphHandoffV1Schema>
export type FamilyGraphEvidenceCohortDeclarationV1 = z.infer<typeof FamilyGraphEvidenceCohortDeclarationV1Schema>
export type FamilyGraphEngineProofSetV1 = z.infer<typeof FamilyGraphEngineProofSetV1Schema>
export type FamilyGraphPackBuildSpecV1 = z.infer<typeof FamilyGraphPackBuildSpecV1Schema>
export type FamilyGraphBuildOutputV1 = z.infer<typeof FamilyGraphBuildOutputV1Schema>
export type FamilyGraphProvenanceDocumentV1 = z.infer<typeof FamilyGraphProvenanceDocumentV1Schema>

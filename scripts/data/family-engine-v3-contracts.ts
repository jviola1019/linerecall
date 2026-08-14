import { z } from 'zod'
import { ImmutableJsonReceiptV1Schema } from '../release/lib/immutable-json-receipt.ts'
import {
  FamilyIdSchema,
  FamilyPackIdSchema,
  FamilyReleaseIdSchema,
} from '../../src/domain/opening-family.ts'
import {
  RepertoireEngineCheckSchema,
  RepertoireProvenanceRefSchema,
} from '../../src/domain/repertoire.ts'
import { EpdSchema, UciMoveSchema } from '../../src/domain/opening-data.ts'

export const FAMILY_ENGINE_CAMPAIGN_SCHEMA_VERSION = 1 as const
export const FAMILY_ENGINE_SETTINGS = Object.freeze({
  threads: 1 as const,
  hashMb: 128 as const,
  multiPv: 5 as const,
  nodes: 250_000 as const,
})

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const PositionIdSchema = z.string().regex(/^pos_[a-f0-9]{16}$/u)

export const FamilyEngineCandidateEdgeV1Schema = z.object({
  fromEpd: EpdSchema,
  uci: UciMoveSchema,
  toEpd: EpdSchema,
}).strict()

export const FamilyEngineCandidateNodeV1Schema = z.object({
  positionId: PositionIdSchema,
  epd: EpdSchema,
  learnerSide: z.enum(['white', 'black']),
  candidateEdges: z.array(FamilyEngineCandidateEdgeV1Schema).min(1).max(256),
}).strict().superRefine((node, context) => {
  if (node.candidateEdges.some(({ fromEpd }) => fromEpd !== node.epd)) {
    context.addIssue({ code: 'custom', path: ['candidateEdges'], message: 'Every engine candidate edge must leave this exact EPD' })
  }
  const moves = node.candidateEdges.map(({ uci }) => uci)
  if (new Set(moves).size !== moves.length) {
    context.addIssue({ code: 'custom', path: ['candidateEdges'], message: 'A learner position may contain each candidate UCI move only once' })
  }
})

/**
 * Pre-engine empirical handoff emitted by the compact graph traversal. It is
 * deliberately separate from the promoted graph so engine claims cannot be
 * supplied by the final-graph caller.
 */
export const FamilyEngineCandidatePackV1Schema = z.object({
  schemaVersion: z.literal(FAMILY_ENGINE_CAMPAIGN_SCHEMA_VERSION),
  kind: z.literal('linerecall-family-engine-candidate-pack'),
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  packId: FamilyPackIdSchema,
  side: z.enum(['white', 'black']),
  provenanceRef: RepertoireProvenanceRefSchema,
  empiricalInventorySha256: Sha256Schema,
  learnerNodes: z.array(FamilyEngineCandidateNodeV1Schema).min(1).max(100_000),
}).strict().superRefine((pack, context) => {
  if (pack.learnerNodes.some(({ learnerSide }) => learnerSide !== pack.side)) {
    context.addIssue({ code: 'custom', path: ['learnerNodes'], message: 'Candidate learner-node side must equal the pack side' })
  }
  for (const key of [
    pack.learnerNodes.map(({ positionId }) => positionId),
    pack.learnerNodes.map(({ epd }) => epd),
  ]) {
    if (new Set(key).size !== key.length) {
      context.addIssue({ code: 'custom', path: ['learnerNodes'], message: 'Candidate learner positions must be unique in a pack' })
    }
  }
})

export const FamilyEngineCampaignRequestV1Schema = z.object({
  schemaVersion: z.literal(FAMILY_ENGINE_CAMPAIGN_SCHEMA_VERSION),
  kind: z.literal('linerecall-stockfish-18-family-campaign-request'),
  releaseId: FamilyReleaseIdSchema,
  settings: z.object({
    threads: z.literal(1),
    hashMb: z.literal(128),
    multiPv: z.literal(5),
    nodes: z.literal(250_000),
  }).strict(),
  candidatePacks: z.array(ImmutableJsonReceiptV1Schema).min(1).max(128),
}).strict().superRefine((request, context) => {
  const paths = request.candidatePacks.map(({ path }) => path)
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: 'custom', path: ['candidatePacks'], message: 'Candidate-pack receipt paths must be unique' })
  }
})

const EngineScoreV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('centipawn'), value: z.number().int().min(-100_000).max(100_000) }).strict(),
  z.object({ kind: z.literal('mate'), value: z.number().int().min(-1_000).max(1_000).refine((value) => value !== 0) }).strict(),
])

export const FamilyEnginePrincipalVariationV1Schema = z.object({
  multipv: z.number().int().min(1).max(5),
  depth: z.number().int().nonnegative().nullable(),
  selectiveDepth: z.number().int().nonnegative().nullable(),
  nodes: z.number().int().min(250_000),
  score: EngineScoreV1Schema,
  bound: z.literal('exact'),
  movesUci: z.array(UciMoveSchema).min(1).max(64),
}).strict()

export const FamilyEngineNodeAnalysisV1Schema = z.object({
  positionId: PositionIdSchema,
  epd: EpdSchema,
  learnerSide: z.enum(['white', 'black']),
  rootCacheKey: Sha256Schema,
  bestMoveUci: UciMoveSchema,
  topVariations: z.array(FamilyEnginePrincipalVariationV1Schema).min(1).max(5),
  edgeChecks: z.array(z.object({
    toEpd: EpdSchema,
    cacheKey: Sha256Schema,
    check: RepertoireEngineCheckSchema,
  }).strict()).min(1).max(256),
}).strict().superRefine((node, context) => {
  const best = node.topVariations.find(({ multipv }) => multipv === 1)
  if (best?.movesUci[0] !== node.bestMoveUci) {
    context.addIssue({ code: 'custom', path: ['topVariations'], message: 'MultiPV 1 must begin with the recorded best move' })
  }
  if (new Set(node.topVariations.map(({ multipv }) => multipv)).size !== node.topVariations.length) {
    context.addIssue({ code: 'custom', path: ['topVariations'], message: 'MultiPV ordinals must be unique' })
  }
  if (node.topVariations.some(({ multipv }, index) => multipv !== index + 1)) {
    context.addIssue({ code: 'custom', path: ['topVariations'], message: 'MultiPV ordinals must be contiguous and sorted from one' })
  }
  if (new Set(node.edgeChecks.map(({ check }) => check.analyzedMoveUci)).size !== node.edgeChecks.length) {
    context.addIssue({ code: 'custom', path: ['edgeChecks'], message: 'Each candidate move must have one exact edge check' })
  }
})

export const FamilyEnginePackProofDocumentV1Schema = z.object({
  schemaVersion: z.literal(FAMILY_ENGINE_CAMPAIGN_SCHEMA_VERSION),
  kind: z.literal('linerecall-stockfish-18-family-pack-proof-document'),
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  packId: FamilyPackIdSchema,
  side: z.enum(['white', 'black']),
  provenanceRef: RepertoireProvenanceRefSchema,
  candidatePackSha256: Sha256Schema,
  empiricalInventorySha256: Sha256Schema,
  engineSha256: Sha256Schema,
  nnueSha256: z.array(Sha256Schema).min(1).max(8),
  settingsSha256: Sha256Schema,
  analyses: z.array(FamilyEngineNodeAnalysisV1Schema).min(1).max(100_000),
}).strict().superRefine((document, context) => {
  if (new Set(document.nnueSha256).size !== document.nnueSha256.length) {
    context.addIssue({ code: 'custom', path: ['nnueSha256'], message: 'NNUE hashes must be unique' })
  }
  if (new Set(document.analyses.map(({ epd }) => epd)).size !== document.analyses.length) {
    context.addIssue({ code: 'custom', path: ['analyses'], message: 'Pack proof positions must be unique' })
  }
})

export const FamilyEngineCampaignProofInventoryV1Schema = z.object({
  schemaVersion: z.literal(FAMILY_ENGINE_CAMPAIGN_SCHEMA_VERSION),
  kind: z.literal('linerecall-stockfish-18-family-campaign-proof-inventory'),
  releaseId: FamilyReleaseIdSchema,
  completedAt: z.string().datetime({ offset: true }),
  engine: z.object({
    name: z.literal('Stockfish 18'),
    releaseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    sourceManifestSha256: Sha256Schema,
    provisionReceiptSha256: Sha256Schema,
    executableSha256: Sha256Schema,
    nnueSha256: z.array(Sha256Schema).min(1).max(8),
    settings: z.object({
      threads: z.literal(1),
      hashMb: z.literal(128),
      multiPv: z.literal(5),
      nodes: z.literal(250_000),
    }).strict(),
    settingsSha256: Sha256Schema,
  }).strict(),
  packs: z.array(z.object({
    familyId: FamilyIdSchema,
    packId: FamilyPackIdSchema,
    candidatePack: ImmutableJsonReceiptV1Schema,
    proofDocument: ImmutableJsonReceiptV1Schema,
    graphProofSet: ImmutableJsonReceiptV1Schema,
    learnerNodeCount: z.number().int().positive().max(100_000),
    candidateEdgeCount: z.number().int().positive().max(200_000),
    quarantinedEdgeCount: z.number().int().nonnegative().max(200_000),
  }).strict()).min(1).max(128),
  coverage: z.object({
    candidatePacks: z.number().int().positive().max(128),
    uniqueLearnerPositions: z.number().int().positive().max(100_000),
    learnerNodeMemberships: z.number().int().positive().max(12_800_000),
    expectedEdgeProofs: z.number().int().positive().max(25_600_000),
    emittedEdgeProofs: z.number().int().positive().max(25_600_000),
    missingEdgeProofs: z.literal(0),
    duplicateEdgeProofs: z.literal(0),
    crossReleaseCandidates: z.literal(0),
  }).strict(),
}).strict().superRefine((inventory, context) => {
  if (inventory.coverage.candidatePacks !== inventory.packs.length) {
    context.addIssue({ code: 'custom', path: ['coverage', 'candidatePacks'], message: 'Campaign pack count must reconcile exactly' })
  }
  if (inventory.coverage.expectedEdgeProofs !== inventory.coverage.emittedEdgeProofs) {
    context.addIssue({ code: 'custom', path: ['coverage'], message: 'Every candidate learner edge must have one emitted proof' })
  }
  for (const key of [
    inventory.packs.map(({ packId }) => packId),
    inventory.packs.map(({ candidatePack }) => candidatePack.path),
    inventory.packs.map(({ proofDocument }) => proofDocument.path),
    inventory.packs.map(({ graphProofSet }) => graphProofSet.path),
  ]) {
    if (new Set(key).size !== key.length) {
      context.addIssue({ code: 'custom', path: ['packs'], message: 'Campaign pack identities and receipt paths must be unique' })
    }
  }
})

/**
 * Release gate derived from the complete campaign inventory. Keeping the
 * inventory receipt in the gate prevents a hand-written summary from standing
 * in for the per-position Stockfish evidence used to build family graphs.
 */
export const FamilyEnginePromotionReceiptV1Schema = z.object({
  schemaVersion: z.literal(FAMILY_ENGINE_CAMPAIGN_SCHEMA_VERSION),
  releaseId: FamilyReleaseIdSchema,
  status: z.literal('pass'),
  completedAt: z.string().datetime({ offset: true }),
  gate: z.literal('stockfish-18-family-graphs'),
  proofInventory: ImmutableJsonReceiptV1Schema,
  engineName: z.literal('Stockfish 18'),
  threads: z.literal(1),
  hashMb: z.literal(128),
  multiPv: z.literal(5),
  nodesPerPosition: z.literal(250_000),
  learnerNodesChecked: z.number().int().positive().max(12_800_000),
  allDrillableLearnerNodesChecked: z.literal(true),
  candidatePacks: z.number().int().positive().max(128),
  expectedEdgeProofs: z.number().int().positive().max(25_600_000),
  emittedEdgeProofs: z.number().int().positive().max(25_600_000),
  missingEdgeProofs: z.literal(0),
  duplicateEdgeProofs: z.literal(0),
  engineSha256: Sha256Schema,
  nnueSha256: z.array(Sha256Schema).min(1).max(8),
}).strict().superRefine((receipt, context) => {
  if (receipt.expectedEdgeProofs !== receipt.emittedEdgeProofs) {
    context.addIssue({ code: 'custom', path: ['emittedEdgeProofs'], message: 'Every expected learner edge must have one Stockfish proof' })
  }
  if (new Set(receipt.nnueSha256).size !== receipt.nnueSha256.length) {
    context.addIssue({ code: 'custom', path: ['nnueSha256'], message: 'NNUE hashes must be unique' })
  }
})

export function deriveFamilyEnginePromotionReceipt(options: {
  inventory: FamilyEngineCampaignProofInventoryV1
  proofInventory: z.infer<typeof ImmutableJsonReceiptV1Schema>
  completedAt?: string
}): z.infer<typeof FamilyEnginePromotionReceiptV1Schema> {
  const inventory = FamilyEngineCampaignProofInventoryV1Schema.parse(options.inventory)
  return FamilyEnginePromotionReceiptV1Schema.parse({
    schemaVersion: FAMILY_ENGINE_CAMPAIGN_SCHEMA_VERSION,
    releaseId: inventory.releaseId,
    status: 'pass',
    completedAt: options.completedAt ?? inventory.completedAt,
    gate: 'stockfish-18-family-graphs',
    proofInventory: ImmutableJsonReceiptV1Schema.parse(options.proofInventory),
    engineName: inventory.engine.name,
    threads: inventory.engine.settings.threads,
    hashMb: inventory.engine.settings.hashMb,
    multiPv: inventory.engine.settings.multiPv,
    nodesPerPosition: inventory.engine.settings.nodes,
    learnerNodesChecked: inventory.coverage.learnerNodeMemberships,
    allDrillableLearnerNodesChecked: true,
    candidatePacks: inventory.coverage.candidatePacks,
    expectedEdgeProofs: inventory.coverage.expectedEdgeProofs,
    emittedEdgeProofs: inventory.coverage.emittedEdgeProofs,
    missingEdgeProofs: inventory.coverage.missingEdgeProofs,
    duplicateEdgeProofs: inventory.coverage.duplicateEdgeProofs,
    engineSha256: inventory.engine.executableSha256,
    nnueSha256: inventory.engine.nnueSha256,
  })
}

export type FamilyEngineCandidatePackV1 = z.infer<typeof FamilyEngineCandidatePackV1Schema>
export type FamilyEngineCampaignRequestV1 = z.infer<typeof FamilyEngineCampaignRequestV1Schema>
export type FamilyEnginePackProofDocumentV1 = z.infer<typeof FamilyEnginePackProofDocumentV1Schema>
export type FamilyEngineCampaignProofInventoryV1 = z.infer<typeof FamilyEngineCampaignProofInventoryV1Schema>
export type FamilyEnginePromotionReceiptV1 = z.infer<typeof FamilyEnginePromotionReceiptV1Schema>

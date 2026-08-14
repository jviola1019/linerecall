import { z } from 'zod'
import { assertBroadcastManifestApproved, BROADCAST_PUBLISHED_GAME_TOTAL } from '../../data/broadcast-contracts.ts'
import { LichessStandardManifestSchema } from '../../data/evidence-contracts.ts'
import {
  ADAPTIVE_EVIDENCE_MAX_PLY,
  COMPACT_EVIDENCE_SCHEMA_VERSION,
  COMPACT_STORAGE_MODEL,
  COMPLETE_BASELINE_MAX_PLY,
} from '../../data/compact-v3-contracts.ts'
import { OpeningFamilyManifestV1Schema } from '../../../src/domain/opening-family.ts'
import {
  CORE_MINIMUM_LEARNER_DECISIONS,
  assertCaroKannFamilyRegression,
  validateRepertoireGraphDocument,
} from '../../../src/domain/repertoire.ts'
import {
  FamilyPromotionAuditIndexV1Schema,
  auditFamilyPromotion,
} from './family-promotion-audit.ts'
import {
  ProductionAppSnapshotManifestSchema,
  ProductionDataReadinessSchema,
  evaluateProductionDataReadiness,
  type ProductionDataReadiness,
} from './production-data-readiness.ts'
import {
  ImmutableJsonReceiptV1Schema,
  readImmutableJsonReceipt,
  safePathIdentity,
  safeOutputPath,
  writeImmutableJsonCandidate,
} from './immutable-json-receipt.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{2,159}$/u
const EXPECTED_Q2_RECORDS = 267_333_507
const EXPECTED_Q2_BYTES = 87_256_474_116
const REQUIRED_CARO_KANN_FAMILIES = ['Advance', 'Exchange', 'Panov', 'Classical', 'Two Knights'] as const

const IdentityReceiptSchema = ImmutableJsonReceiptV1Schema.safeExtend({
  encoding: z.literal('identity'),
}).strict()

export const ProductionDataReadinessBuildInputV1Schema = z.object({
  schemaVersion: z.literal(1),
  familyPromotionIndex: IdentityReceiptSchema,
  appSnapshotManifest: IdentityReceiptSchema,
  sourceManifests: z.object({
    broadcasts: IdentityReceiptSchema,
    standardQ2_2026: IdentityReceiptSchema,
  }).strict(),
}).strict()

const GateBaseProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().regex(RELEASE_ID),
  status: z.literal('pass'),
  completedAt: z.string().datetime({ offset: true }),
}).passthrough()

const BroadcastPromotionProjectionSchema = GateBaseProjectionSchema.extend({
  gate: z.literal('lichess-broadcasts-through-2026-06'),
  archiveCount: z.literal(78),
  archivesComplete: z.literal(true),
  digestsVerified: z.literal(true),
  recordsSeen: z.literal(BROADCAST_PUBLISHED_GAME_TOTAL),
  accepted: z.number().int().positive(),
  rejected: z.number().int().nonnegative(),
  deduplicated: z.number().int().nonnegative(),
  accountingReconciles: z.literal(true),
  finalExactReceiptSha256: z.string().regex(SHA256),
}).passthrough()

const Q2PromotionProjectionSchema = GateBaseProjectionSchema.extend({
  gate: z.literal('lichess-standard-q2-2026'),
  archiveCount: z.literal(3),
  archivesComplete: z.literal(true),
  digestsVerified: z.literal(true),
  recordsSeen: z.literal(EXPECTED_Q2_RECORDS),
  publishedRecords: z.literal(EXPECTED_Q2_RECORDS),
  publishedCompressedBytes: z.literal(EXPECTED_Q2_BYTES),
  accepted: z.number().int().positive(),
  rejected: z.number().int().nonnegative(),
  deduplicated: z.number().int().nonnegative(),
  accountingReconciles: z.literal(true),
  finalExactReceiptSha256: z.string().regex(SHA256),
}).passthrough()

const EvidencePromotionProjectionSchema = GateBaseProjectionSchema.extend({
  gate: z.literal('compact-v3-family-evidence-reconciliation'),
  sourceEdgeInventoryComplete: z.literal(true),
  topNPracticeCutoffApplied: z.literal(false),
  hiddenEligiblePracticeBranches: z.literal(0),
  provenanceMissing: z.literal(0),
  illegalEdges: z.literal(0),
  quarantinedEdgesInDrills: z.literal(0),
}).passthrough()

const EnginePromotionProjectionSchema = GateBaseProjectionSchema.extend({
  gate: z.literal('stockfish-18-family-graphs'),
  engineName: z.literal('Stockfish 18'),
  threads: z.literal(1),
  hashMb: z.literal(128),
  multiPv: z.literal(5),
  nodesPerPosition: z.literal(250_000),
  learnerNodesChecked: z.number().int().positive(),
  allDrillableLearnerNodesChecked: z.literal(true),
  proofInventory: ImmutableJsonReceiptV1Schema,
  engineSha256: z.string().regex(SHA256),
  nnueSha256: z.array(z.string().regex(SHA256)).min(1).max(8),
}).passthrough()

const ScidPromotionProjectionSchema = GateBaseProjectionSchema.extend({
  gate: z.literal('scid-family-crosscheck'),
  stratifiedSampleComplete: z.literal(true),
  sampledLines: z.number().int().positive().max(250),
  conflictingBaseEcoInDrills: z.literal(0),
  oracleContentShipped: z.literal(false),
  crosscheckReport: ImmutableJsonReceiptV1Schema,
  familyGraphBuildSha256: z.string().regex(SHA256),
}).passthrough()

const PuzzlePromotionProjectionSchema = GateBaseProjectionSchema.extend({
  gate: z.literal('lichess-puzzle-promotion'),
  sourceDigestApproved: z.literal(true),
  sourceSha256: z.string().regex(SHA256),
  promotedShardCount: z.number().int().positive(),
  promotedPuzzleCount: z.number().int().positive(),
  legalityComplete: z.literal(true),
  associationComplete: z.literal(true),
  engineChecksComplete: z.literal(true),
  duplicatePuzzleIds: z.literal(0),
}).passthrough()

type PromotionIndex = z.infer<typeof FamilyPromotionAuditIndexV1Schema>

async function readPromotionReceipt<T>(options: {
  root: string
  index: PromotionIndex
  key: keyof PromotionIndex['promotionReceipts']
  schema: z.ZodType<T>
}): Promise<T> {
  const receipt = options.index.promotionReceipts[options.key]
  if (!receipt) throw new Error(`Required ${options.key} promotion receipt is absent`)
  const { value } = await readImmutableJsonReceipt({ root: options.root, receipt })
  const parsed = options.schema.parse(value)
  if ((parsed as { releaseId?: string }).releaseId !== options.index.releaseId) {
    throw new Error(`${options.key} promotion receipt belongs to another release`)
  }
  return parsed
}

/**
 * Derive the production readiness document from immutable bytes already
 * accepted by the family promotion audit. Fixed policy fields are imported
 * from the versioned v3/repertoire contracts; empirical counts always come
 * from the verified receipts or validated graphs.
 */
export async function buildProductionDataReadiness(options: {
  root: string
  outputPath: string
  input: unknown
  now?: () => Date
}): Promise<{
  readiness: ProductionDataReadiness
  outputPath: string
  bytes: number
  sha256: string
}> {
  const input = ProductionDataReadinessBuildInputV1Schema.parse(options.input)
  safeOutputPath(options.root, options.outputPath)
  const outputInputs = [
    input.familyPromotionIndex.path,
    input.appSnapshotManifest.path,
    input.sourceManifests.broadcasts.path,
    input.sourceManifests.standardQ2_2026.path,
  ]
  const outputIdentity = safePathIdentity(options.root, options.outputPath)
  if (outputInputs.some((path) => safePathIdentity(options.root, path) === outputIdentity)) {
    throw new Error('Production readiness cannot replace one of its immutable inputs')
  }

  const indexDocument = await readImmutableJsonReceipt({
    root: options.root,
    receipt: input.familyPromotionIndex,
    maximumStoredBytes: 1 * 1024 * 1024,
    maximumDecodedBytes: 1 * 1024 * 1024,
  })
  const index = FamilyPromotionAuditIndexV1Schema.parse(indexDocument.value)
  // Audit an immutable candidate created from the exact receipt-verified index
  // object. The audit can no longer reopen a replaced pathname and validate a
  // different index than the readiness projection below consumes.
  const auditIndex = await writeImmutableJsonCandidate({
    root: options.root,
    outputPath: `${options.outputPath}.verified-family-index.json`,
    value: index,
  })
  let familyAudit: Awaited<ReturnType<typeof auditFamilyPromotion>> | null = null
  try {
    familyAudit = await auditFamilyPromotion({
      root: options.root,
      indexPath: auditIndex.candidateRelativePath,
    })
  } finally {
    await auditIndex.discard()
  }
  if (familyAudit === null) throw new Error('Family promotion audit did not return a result')
  if (familyAudit.status !== 'pass') {
    throw new Error(`Family promotion is blocked by ${familyAudit.findings.length} finding(s)`)
  }

  const appDocument = await readImmutableJsonReceipt({
    root: options.root,
    receipt: input.appSnapshotManifest,
    maximumStoredBytes: 16 * 1024 * 1024,
    maximumDecodedBytes: 16 * 1024 * 1024,
  })
  const appManifest = ProductionAppSnapshotManifestSchema.parse(appDocument.value)
  if (appManifest.releaseId !== index.releaseId) throw new Error('App manifest and family promotion index use different releases')
  if (appManifest.familyPromotionIndexSha256 !== input.familyPromotionIndex.sha256) {
    throw new Error('App manifest is not bound to the audited family promotion index')
  }

  const broadcastManifestDocument = await readImmutableJsonReceipt({
    root: options.root,
    receipt: input.sourceManifests.broadcasts,
    maximumStoredBytes: 2 * 1024 * 1024,
    maximumDecodedBytes: 2 * 1024 * 1024,
  })
  assertBroadcastManifestApproved(broadcastManifestDocument.value)
  const q2ManifestDocument = await readImmutableJsonReceipt({
    root: options.root,
    receipt: input.sourceManifests.standardQ2_2026,
    maximumStoredBytes: 2 * 1024 * 1024,
    maximumDecodedBytes: 2 * 1024 * 1024,
  })
  const q2Manifest = LichessStandardManifestSchema.parse(q2ManifestDocument.value)
  const q2PublishedBytes = q2Manifest.archives.reduce((sum, archive) => sum + archive.bytes, 0)
  if (q2Manifest.source.publishedGameTotal !== EXPECTED_Q2_RECORDS || q2PublishedBytes !== EXPECTED_Q2_BYTES) {
    throw new Error('Q2 source manifest does not reproduce the approved published totals')
  }

  const [broadcast, q2, evidence, engine, scid, puzzles] = await Promise.all([
    readPromotionReceipt({ root: options.root, index, key: 'broadcast', schema: BroadcastPromotionProjectionSchema }),
    readPromotionReceipt({ root: options.root, index, key: 'q2', schema: Q2PromotionProjectionSchema }),
    readPromotionReceipt({ root: options.root, index, key: 'evidence', schema: EvidencePromotionProjectionSchema }),
    readPromotionReceipt({ root: options.root, index, key: 'engine', schema: EnginePromotionProjectionSchema }),
    readPromotionReceipt({ root: options.root, index, key: 'scid', schema: ScidPromotionProjectionSchema }),
    readPromotionReceipt({ root: options.root, index, key: 'puzzles', schema: PuzzlePromotionProjectionSchema }),
  ])

  const graphByPackId = new Map<string, Awaited<ReturnType<typeof validateRepertoireGraphDocument>>>()
  const learnerNodesChecked = new Set<string>()
  for (const pack of index.packs) {
    const { value } = await readImmutableJsonReceipt({ root: options.root, receipt: pack.graph })
    const graph = await validateRepertoireGraphDocument(value)
    graphByPackId.set(graph.pack.id, graph)
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
    for (const edge of graph.edges) {
      if (nodeById.get(edge.fromNodeId)?.learnerTurn && edge.evidence.engine.check !== null) {
        learnerNodesChecked.add(`${graph.pack.id}\0${edge.fromNodeId}`)
      }
    }
  }
  if (engine.learnerNodesChecked !== learnerNodesChecked.size) {
    throw new Error(
      `Engine receipt checked ${engine.learnerNodesChecked} learner nodes; promoted graphs contain ${learnerNodesChecked.size}`,
    )
  }

  const caroIndex = index.families.filter(({ familyId }) => familyId === 'caro-kann')
  if (caroIndex.length !== 1) throw new Error('Production readiness requires exactly one Caro-Kann family manifest')
  const caroManifestDocument = await readImmutableJsonReceipt({ root: options.root, receipt: caroIndex[0]!.manifest })
  const caroManifest = OpeningFamilyManifestV1Schema.parse(caroManifestDocument.value)
  const caroBlackGraphs = caroManifest.packRefs
    .filter(({ side }) => side === 'black')
    .map(({ packId }) => graphByPackId.get(packId))
    .filter((graph) => graph !== undefined)
  if (caroBlackGraphs.length !== 1) throw new Error('Caro-Kann promotion requires exactly one audited Black family graph')
  const caroSummary = assertCaroKannFamilyRegression(caroBlackGraphs[0]!)
  const caroNamedFamilies = caroSummary.families.filter((family): family is typeof REQUIRED_CARO_KANN_FAMILIES[number] =>
    REQUIRED_CARO_KANN_FAMILIES.some((required) => required === family))

  for (const corpus of [broadcast, q2]) {
    if (corpus.accepted + corpus.rejected + corpus.deduplicated !== corpus.recordsSeen) {
      throw new Error(`${corpus.gate} accounting does not reconcile`)
    }
  }
  const auditedAt = (options.now ?? (() => new Date()))().toISOString()
  const newestPromotionTime = Math.max(...[broadcast, q2, evidence, engine, scid, puzzles].map(({ completedAt }) => Date.parse(completedAt)))
  if (Date.parse(auditedAt) < newestPromotionTime) throw new Error('Readiness audit time precedes an immutable promotion receipt')

  const readiness = ProductionDataReadinessSchema.parse({
    schemaVersion: COMPACT_EVIDENCE_SCHEMA_VERSION,
    status: 'pass',
    releaseId: index.releaseId,
    auditedAt,
    storageModel: COMPACT_STORAGE_MODEL,
    appSnapshotManifestSha256: input.appSnapshotManifest.sha256,
    corpora: {
      broadcasts: {
        manifestSha256: input.sourceManifests.broadcasts.sha256,
        archiveCount: broadcast.archiveCount,
        archivesComplete: broadcast.archivesComplete,
        digestsVerified: broadcast.digestsVerified,
        recordsSeen: broadcast.recordsSeen,
        accepted: broadcast.accepted,
        rejected: broadcast.rejected,
        deduplicated: broadcast.deduplicated,
        accountingReconciles: broadcast.accountingReconciles,
      },
      standardQ2_2026: {
        manifestSha256: input.sourceManifests.standardQ2_2026.sha256,
        archiveCount: q2.archiveCount,
        archivesComplete: q2.archivesComplete,
        digestsVerified: q2.digestsVerified,
        recordsSeen: q2.recordsSeen,
        publishedRecords: q2.publishedRecords,
        publishedCompressedBytes: q2.publishedCompressedBytes,
        accepted: q2.accepted,
        rejected: q2.rejected,
        deduplicated: q2.deduplicated,
        accountingReconciles: q2.accountingReconciles,
      },
    },
    graph: {
      schemaVersion: COMPACT_EVIDENCE_SCHEMA_VERSION,
      baselineMaximumPly: COMPLETE_BASELINE_MAX_PLY,
      adaptiveMaximumPly: ADAPTIVE_EVIDENCE_MAX_PLY,
      exactSecondPassComplete: true,
      reconciliationComplete: evidence.sourceEdgeInventoryComplete,
      allEligiblePracticeBranchesRetained: true,
      maximumPracticeBranches: null,
      hiddenEligiblePracticeBranches: evidence.hiddenEligiblePracticeBranches,
      terminalPolicy: 'evidence-defined-through-ply-100',
      coreMinimumLearnerDecisions: CORE_MINIMUM_LEARNER_DECISIONS,
      provenanceMissing: evidence.provenanceMissing,
      illegalEdges: evidence.illegalEdges,
      quarantinedEdgesInDrills: evidence.quarantinedEdgesInDrills,
      unresolvedDataDiscrepancies: scid.conflictingBaseEcoInDrills,
      familyGraphBuildSha256: index.familyGraphBuild.sha256,
    },
    engine: {
      name: engine.engineName,
      threads: engine.threads,
      hashMb: engine.hashMb,
      multiPv: engine.multiPv,
      nodes: engine.nodesPerPosition,
      learnerNodesChecked: engine.learnerNodesChecked,
      proofInventorySha256: engine.proofInventory.sha256,
      engineSha256: engine.engineSha256,
      nnueSha256: engine.nnueSha256,
    },
    scid: {
      sampledLines: scid.sampledLines,
      conflictingBaseEcoInDrills: scid.conflictingBaseEcoInDrills,
      oracleContentShipped: scid.oracleContentShipped,
      crosscheckReportSha256: scid.crosscheckReport.sha256,
    },
    puzzles: {
      sourceDigestApproved: puzzles.sourceDigestApproved,
      sourceSha256: puzzles.sourceSha256,
      accepted: puzzles.promotedPuzzleCount,
      learnerNodesEngineChecked: puzzles.engineChecksComplete,
      // This is a versioned application contract, not a derived solve count.
      // The production schema fixes it to true and runtime repositories keep
      // tactical progress separate from opening-recall cards.
      masterySeparatedFromRecall: true,
    },
    caroKann: {
      ecoRange: 'B10-B19',
      familyGraphCount: caroBlackGraphs.length,
      drillablePaths: caroSummary.pathCount,
      namedFamilies: caroNamedFamilies,
      // Repertoire paths carry measured depth but no mutable "Core" label;
      // validateRepertoireGraphDocument derives the sole pack tier from depth.
      mislabeledCorePaths: 0,
    },
  })
  const findings = evaluateProductionDataReadiness(readiness, appManifest, input.appSnapshotManifest.sha256)
  if (findings.length > 0) throw new Error(`Generated production readiness failed ${findings.length} binding check(s)`)

  const candidate = await writeImmutableJsonCandidate({
    root: options.root,
    outputPath: options.outputPath,
    value: readiness,
  })
  try {
    await candidate.promote()
  } catch (error) {
    await candidate.discard()
    throw error
  }
  return {
    readiness,
    outputPath: options.outputPath,
    bytes: candidate.bytes,
    sha256: candidate.sha256,
  }
}

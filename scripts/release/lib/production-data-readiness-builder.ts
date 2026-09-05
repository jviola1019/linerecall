import { z } from 'zod'
import { assertBroadcastManifestApproved, BROADCAST_PUBLISHED_GAME_TOTAL } from '../../data/broadcast-contracts.ts'
import { LichessStandardManifestSchema } from '../../data/evidence-contracts.ts'
import {
  ADAPTIVE_EVIDENCE_MAX_PLY,
  COMPACT_EVIDENCE_SCHEMA_VERSION,
  COMPLETE_BASELINE_MAX_PLY,
} from '../../data/compact-v3-contracts.ts'
import { COMPACT_V31_STORAGE_MODEL } from '../../data/compact-v31-contracts.ts'
import { auditCompactV31ProductionCorpusChain } from '../../data/compact-v31-production-chain-audit.ts'
import { deriveCompactV31FamilyHandoff, readCompactV31ExactRows } from '../../data/compact-v31-family-handoff.ts'
import { OpeningFamilyManifestV1Schema, validateRequiredOpeningFamilyRegressions } from '../../../src/domain/opening-family.ts'
import {
  CompactV31FamilyEligibilityIndexSchema,
  CompactV31FamilyRootEdgeInventorySchema,
} from '../../data/compact-v31-family-eligibility.ts'
import { validatePinnedTaxonomyInventory } from '../../data/taxonomy-inventory.ts'
import { validateOpeningFamilyEditorialLedger } from '../../../src/domain/opening-family-editorial.ts'
import {
  CORE_MINIMUM_LEARNER_DECISIONS,
  assertCaroKannFamilyRegression,
  validateRepertoireGraphDocument,
  selectSessionPaths,
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

function assertAutonomousPracticeCycle(graph: Awaited<ReturnType<typeof validateRepertoireGraphDocument>>): void {
  const expected = new Set(graph.paths.map(({ id }) => id))
  const visited = new Set<string>()
  let previousCycle: Parameters<typeof selectSessionPaths>[0]['previousCycle'] = null
  const maximumBatches = Math.ceil(Math.max(1, expected.size) / 1_000) + 1
  for (let batch = 0; batch < maximumBatches; batch += 1) {
    const result = selectSessionPaths({ graph, dueCardIds: [], previousCycle, maximumPaths: 1_000 })
    if (result.selection.includedPathIds.length === 0) throw new Error(`Promoted graph ${graph.pack.id} has an empty autonomous practice batch`)
    for (const pathId of result.selection.includedPathIds) {
      if (!expected.has(pathId) || visited.has(pathId)) throw new Error(`Promoted graph ${graph.pack.id} autonomous cycle repeated or invented a path`)
      visited.add(pathId)
    }
    if (result.nextCycle.ordinal > 0) {
      if (visited.size !== expected.size) throw new Error(`Promoted graph ${graph.pack.id} autonomous cycle omitted a path`)
      return
    }
    previousCycle = result.nextCycle
  }
  throw new Error(`Promoted graph ${graph.pack.id} autonomous cycle did not complete`)
}

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
  compactV31Corpora: z.object({
    broadcasts: IdentityReceiptSchema,
    standardQ2_2026: IdentityReceiptSchema,
  }).strict(),
  // The exact-state eligibility index is required for every release. Fixture
  // data must carry a complete synthetic index rather than taking a gate
  // bypass based on its release id.
  familyEligibilityIndex: IdentityReceiptSchema,
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
  broadcastExactReceiptSha256: z.string().regex(SHA256),
  q2ExactReceiptSha256: z.string().regex(SHA256),
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
    input.compactV31Corpora.broadcasts.path,
    input.compactV31Corpora.standardQ2_2026.path,
    input.familyEligibilityIndex.path,
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

  const [taxonomySourceDocument, taxonomyInventoryDocument] = await Promise.all([
    readImmutableJsonReceipt({
      root: options.root,
      receipt: index.taxonomySourceManifest,
      maximumStoredBytes: 2 * 1024 * 1024,
      maximumDecodedBytes: 2 * 1024 * 1024,
    }),
    readImmutableJsonReceipt({
      root: options.root,
      receipt: index.taxonomyInventory,
      maximumStoredBytes: 8 * 1024 * 1024,
      maximumDecodedBytes: 8 * 1024 * 1024,
    }),
  ])
  const taxonomyInventory = validatePinnedTaxonomyInventory(
    taxonomyInventoryDocument.value,
    taxonomySourceDocument.value,
  )

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

  const [broadcastV31, q2V31] = await Promise.all([
    auditCompactV31ProductionCorpusChain({ root: options.root, corpusReceipt: input.compactV31Corpora.broadcasts }),
    auditCompactV31ProductionCorpusChain({ root: options.root, corpusReceipt: input.compactV31Corpora.standardQ2_2026 }),
  ])
  if (
    broadcastV31.receipt.corpus !== 'lichess-broadcasts' ||
    q2V31.receipt.corpus !== 'lichess-standard-rated-q2-2026' ||
    broadcastV31.receipt.releaseId !== index.releaseId || q2V31.receipt.releaseId !== index.releaseId
  ) throw new Error('Compact-v3.1 corpus receipts do not match the family release')
  if (
    broadcastV31.sourceManifestSha256 !== input.sourceManifests.broadcasts.sha256 ||
    q2V31.sourceManifestSha256 !== input.sourceManifests.standardQ2_2026.sha256
  ) throw new Error('Compact-v3.1 corpus receipts do not bind the supplied source manifests')

  const familyEligibilityDocument = await readImmutableJsonReceipt({
    root: options.root,
    receipt: input.familyEligibilityIndex,
    maximumStoredBytes: 16 * 1024 * 1024,
    maximumDecodedBytes: 16 * 1024 * 1024,
  })
  const familyEligibility = CompactV31FamilyEligibilityIndexSchema.parse(familyEligibilityDocument.value)
  if (familyEligibility.releaseId !== index.releaseId) {
    throw new Error('Family eligibility index belongs to another release')
  }
  if (
    familyEligibility.proposedFamilyCount !== taxonomyInventory.proposedFamilyCount ||
    familyEligibility.taxonomyInventorySha256 !== index.taxonomyInventory.sha256 ||
    familyEligibility.editorialLedgerSha256 !== index.editorialLedger.sha256
  ) {
    throw new Error('Family eligibility index must bind the exact reviewed proposal taxonomy inventory')
  }
  const expectedCorpusBindings = [
    {
      corpus: 'lichess-broadcasts' as const,
      corpusReceiptSha256: broadcastV31.corpusReceiptSha256,
      sourceManifestSha256: broadcastV31.sourceManifestSha256,
      exactMergeReceiptSha256: broadcastV31.exactMergeReceiptSha256,
      sourceEdgeInventorySha256: broadcastV31.sourceEdgeInventorySha256,
    },
    {
      corpus: 'lichess-standard-rated-q2-2026' as const,
      corpusReceiptSha256: q2V31.corpusReceiptSha256,
      sourceManifestSha256: q2V31.sourceManifestSha256,
      exactMergeReceiptSha256: q2V31.exactMergeReceiptSha256,
      sourceEdgeInventorySha256: q2V31.sourceEdgeInventorySha256,
    },
  ] as const
  if (JSON.stringify(familyEligibility.corpusBindings) !== JSON.stringify(expectedCorpusBindings)) {
    throw new Error('Family eligibility index is not bound to both deep-verified compact-v3.1 corpus chains')
  }
  const rootInventories = new Map<string, z.infer<typeof CompactV31FamilyRootEdgeInventorySchema>>()
  for (const root of familyEligibility.roots) {
    const rootDocument = await readImmutableJsonReceipt({
      root: options.root,
      receipt: root.edgeInventory,
      maximumStoredBytes: 64 * 1024 * 1024,
      maximumDecodedBytes: 64 * 1024 * 1024,
    })
    const inventory = CompactV31FamilyRootEdgeInventorySchema.parse(rootDocument.value)
    if (
      inventory.releaseId !== familyEligibility.releaseId || inventory.familyId !== root.familyId ||
      inventory.side !== root.side || inventory.packId !== root.packId ||
      inventory.eligibleEdgeIds.length !== root.eligibleEdgeCount ||
      JSON.stringify(inventory.corpusBindings) !== JSON.stringify(expectedCorpusBindings)
    ) throw new Error(`Family eligibility root ${root.packId} is not bound to its exact corpus inventories`)
    if (inventory.bookEdgeIds === undefined || inventory.exploratoryEdgeIds === undefined || inventory.taxonomyLineIds === undefined) {
      throw new Error(`Family eligibility root ${root.packId} must include book, exploratory, and taxonomy ownership arrays`)
    }
    const eligibleIds = new Set(inventory.eligibleEdgeIds)
    if (inventory.bookEdgeIds?.some((edgeId) => !eligibleIds.has(edgeId))) {
      throw new Error(`Family eligibility root ${root.packId} contains a book edge outside its eligible source inventory`)
    }
    if (inventory.exploratoryEdgeIds?.some((edgeId) => !eligibleIds.has(edgeId))) {
      throw new Error(`Family eligibility root ${root.packId} contains an exploratory edge outside its eligible source inventory`)
    }
    if (inventory.bookEdgeIds !== undefined && inventory.exploratoryEdgeIds !== undefined) {
      const classified = new Set([...inventory.bookEdgeIds, ...inventory.exploratoryEdgeIds])
      if (classified.size !== eligibleIds.size) {
        throw new Error(`Family eligibility root ${root.packId} leaves source-eligible edges unclassified`)
      }
    }
    rootInventories.set(root.packId, inventory)
  }
  // Re-derive the handoff from the exact merged partitions.  Receipt hashes
  // prove byte identity, but they do not prove that a caller listed the right
  // roots, dispositions, or edge IDs in a separately authored index.
  const editorialLedgerDocument = await readImmutableJsonReceipt({
    root: options.root,
    receipt: index.editorialLedger,
    maximumStoredBytes: 16 * 1024 * 1024,
    maximumDecodedBytes: 16 * 1024 * 1024,
  })
  const editorialLedger = validateOpeningFamilyEditorialLedger(editorialLedgerDocument.value)
  if (familyEligibility.proposedFamilyCount !== editorialLedger.proposedFamilyCount || familyEligibility.familyCount !== editorialLedger.families.length) {
    throw new Error('Family eligibility index canonical count does not match the approved editorial ledger')
  }
  const canonicalFamilyIds = new Set(editorialLedger.families.map(({ id }) => id))
  const resultingFamilyIds = new Set(editorialLedger.decisions.flatMap((entry) => entry.reviewStatus === 'approved' ? entry.decision.resultingFamilyIds : []))
  const orphanFamilies = editorialLedger.families.filter(({ id }) => !resultingFamilyIds.has(id)).map(({ id }) => id)
  if (orphanFamilies.length > 0) throw new Error(`Approved editorial ledger contains unowned canonical families: ${orphanFamilies.join(', ')}`)
  if ([...resultingFamilyIds].some((id) => !canonicalFamilyIds.has(id))) {
    throw new Error('Approved editorial ledger contains a resulting family outside its canonical family set')
  }
  const rederivedHandoff = await deriveCompactV31FamilyHandoff({
    releaseId: index.releaseId,
    completedAt: familyEligibility.completedAt,
    taxonomyInventory: taxonomyInventoryDocument.value,
    taxonomyManifest: taxonomySourceDocument.value,
    editorialLedger: editorialLedgerDocument.value,
    corpusBindings: expectedCorpusBindings,
    exactRows: [
      { corpus: expectedCorpusBindings[0].corpus, rows: readCompactV31ExactRows(options.root, broadcastV31.receipt.exactMergeReceipt) },
      { corpus: expectedCorpusBindings[1].corpus, rows: readCompactV31ExactRows(options.root, q2V31.receipt.exactMergeReceipt) },
    ],
  })
  if (JSON.stringify(rederivedHandoff.index.familyDispositions) !== JSON.stringify(familyEligibility.familyDispositions)) {
    throw new Error('Family eligibility dispositions differ from exact-state source rederivation')
  }
  const rederivedRoots = new Map(rederivedHandoff.rootInventories.map((root) => [root.packId, root]))
  if (rederivedRoots.size !== rootInventories.size) {
    throw new Error('Family eligibility root inventory differs from exact-state source rederivation')
  }
  for (const [packId, inventory] of rootInventories) {
    if (JSON.stringify(rederivedRoots.get(packId)) !== JSON.stringify(inventory)) {
      throw new Error(`Family eligibility root ${packId} differs from exact-state source rederivation`)
    }
  }
  const dispositionByKey = new Map(
    familyEligibility.familyDispositions.map((disposition) => [`${disposition.familyId}:${disposition.side}`, disposition] as const),
  )
  if (dispositionByKey.size !== familyEligibility.familyCount * 2) {
    throw new Error('Family eligibility dispositions must be unique for every canonical family and side')
  }
  if ([...dispositionByKey.keys()].some((key) => !canonicalFamilyIds.has(key.slice(0, key.lastIndexOf(':'))))) {
    throw new Error('Family eligibility contains a disposition for an orphan or unknown canonical family')
  }
  const taxonomyLinesByFamily = new Map(
    editorialLedger.families.map((family) => [family.id, family.primaryTaxonomyLineIds] as const),
  )
  for (const familyId of taxonomyLinesByFamily.keys()) {
    for (const side of ['white', 'black'] as const) {
      const disposition = dispositionByKey.get(`${familyId}:${side}`)
      if (!disposition) throw new Error(`Family eligibility is missing disposition for ${familyId}:${side}`)
      const expectedLines = taxonomyLinesByFamily.get(familyId)!
      if (JSON.stringify(disposition.taxonomyLineIds) !== JSON.stringify(expectedLines)) {
        throw new Error(`Family disposition ${familyId}:${side} is not source-derived from the pinned taxonomy ownership`)
      }
      const root = familyEligibility.roots.find(({ familyId: id, side: rootSide }) => id === familyId && rootSide === side)
      if (disposition.readiness === 'trainable') {
        if (disposition.reason !== 'eligible-root' || disposition.rootEpd === null || !root) {
          throw new Error(`Trainable family disposition ${familyId}:${side} lacks its exact eligible root`)
        }
        const inventory = rootInventories.get(root.packId)
        if (!inventory || inventory.rootEpd !== disposition.rootEpd || (inventory.bookEdgeIds ?? inventory.eligibleEdgeIds).length === 0) {
          throw new Error(`Trainable family disposition ${familyId}:${side} lacks a book-edge root inventory`)
        }
      } else if (disposition.reason === 'eligible-root') {
        throw new Error(`Study-only family disposition ${familyId}:${side} cannot claim an eligible root`)
      }
    }
  }

  const [broadcast, q2, evidence, engine, scid, puzzles] = await Promise.all([
    readPromotionReceipt({ root: options.root, index, key: 'broadcast', schema: BroadcastPromotionProjectionSchema }),
    readPromotionReceipt({ root: options.root, index, key: 'q2', schema: Q2PromotionProjectionSchema }),
    readPromotionReceipt({ root: options.root, index, key: 'evidence', schema: EvidencePromotionProjectionSchema }),
    readPromotionReceipt({ root: options.root, index, key: 'engine', schema: EnginePromotionProjectionSchema }),
    readPromotionReceipt({ root: options.root, index, key: 'scid', schema: ScidPromotionProjectionSchema }),
    readPromotionReceipt({ root: options.root, index, key: 'puzzles', schema: PuzzlePromotionProjectionSchema }),
  ])

  const familyManifests = new Map<string, z.infer<typeof OpeningFamilyManifestV1Schema>>()
  for (const familyIndex of index.families) {
    const familyDocument = await readImmutableJsonReceipt({ root: options.root, receipt: familyIndex.manifest })
    const familyManifest = OpeningFamilyManifestV1Schema.parse(familyDocument.value)
    if (familyManifest.id !== familyIndex.familyId || familyManifest.releaseId !== index.releaseId) {
      throw new Error(`Reviewed family manifest ${familyIndex.familyId} is not bound to the release index`)
    }
    familyManifests.set(familyManifest.id, familyManifest)
  }
  // These are mandatory production regression families, not optional checks
  // whose absence can be hidden by a changed canonical family count.  Run
  // this before graph validation so a release missing a required family is
  // rejected for that contract violation, rather than for a downstream graph
  // symptom.
  validateRequiredOpeningFamilyRegressions([...familyManifests.values()])

  const graphByPackId = new Map<string, Awaited<ReturnType<typeof validateRepertoireGraphDocument>>>()
  const learnerNodesChecked = new Set<string>()
  for (const pack of index.packs) {
    const { value } = await readImmutableJsonReceipt({ root: options.root, receipt: pack.graph })
    const graph = await validateRepertoireGraphDocument(value)
    assertAutonomousPracticeCycle(graph)
    if (graphByPackId.has(graph.pack.id)) throw new Error(`Duplicate promoted graph pack ${graph.pack.id}`)
    graphByPackId.set(graph.pack.id, graph)
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
    for (const edge of graph.edges) {
      if (nodeById.get(edge.fromNodeId)?.learnerTurn && edge.evidence.engine.check !== null) {
        learnerNodesChecked.add(`${graph.pack.id}\0${edge.fromNodeId}`)
      }
    }
  }
  // A promoted graph is valid only when it is backed by the exact source root
  // inventory for the same family-side.  Compare against the book subset when
  // the handoff also retains exploratory (N100-499) source edges: exploratory
  // edges are evidence, but are intentionally not selectable training moves.
  for (const pack of index.packs) {
    const graph = graphByPackId.get(pack.packId)
    if (!graph) throw new Error(`Promoted graph ${pack.packId} disappeared during validation`)
    const root = rootInventories.get(pack.packId)
    if (!root) throw new Error(`Promoted graph ${pack.packId} has no exact source eligibility root`)
    if (root.familyId !== pack.familyId || root.side !== graph.pack.side) {
      throw new Error(`Promoted graph ${pack.packId} is bound to the wrong family-side root`)
    }
    const expectedEdgeIds = [...(root.bookEdgeIds ?? root.eligibleEdgeIds)].sort()
    const emittedEdgeIds = graph.edges.filter(({ eligibleForDrill }) => eligibleForDrill).map(({ id }) => id).sort()
    if (expectedEdgeIds.length !== emittedEdgeIds.length || expectedEdgeIds.some((id, index) => id !== emittedEdgeIds[index])) {
      throw new Error(`Promoted graph ${pack.packId} does not emit every source-eligible book edge`)
    }
    const coveredEdgeIds = new Set(graph.paths.flatMap(({ edgeIds }) => edgeIds))
    if (emittedEdgeIds.some((edgeId) => !coveredEdgeIds.has(edgeId))) {
      throw new Error(`Promoted graph ${pack.packId} has a source-eligible edge that cannot train to a terminal path`)
    }
    const disposition = dispositionByKey.get(`${pack.familyId}:${graph.pack.side}` as `${string}:white` | `${string}:black`)
    if (!disposition || disposition.readiness !== 'trainable') {
      throw new Error(`Promoted graph ${pack.packId} is emitted for a non-trainable family disposition`)
    }
  }
  for (const root of familyEligibility.roots) {
    const disposition = dispositionByKey.get(`${root.familyId}:${root.side}`)
    if (!disposition) throw new Error(`Eligibility root ${root.packId} has no source disposition`)
    if (disposition.readiness === 'trainable' && !graphByPackId.has(root.packId)) {
      throw new Error(`Trainable family disposition ${root.familyId}:${root.side} has no promoted graph`)
    }
  }
  // The campaign intentionally analyzes the complete pre-quarantine candidate
  // graph. Descendants of a quarantined/inaccuracy edge remain proven in that
  // immutable campaign but are unreachable in the promoted drill graph.
  if (engine.learnerNodesChecked < learnerNodesChecked.size) {
    throw new Error(
      `Engine receipt checked only ${engine.learnerNodesChecked} learner nodes; promoted graphs contain ${learnerNodesChecked.size}`,
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

  // Keep named opening regressions explicit in the promotion path. Their
  // registry presence is mandatory even for a study-only family. Once a
  // Sicilian or Ruy Lopez side is promoted it must expose a traversable practice
  // path and pass the same autonomous-cycle gauntlet as every other pack.
  for (const familyId of ['sicilian-defence', 'ruy-lopez'] as const) {
    const manifest = familyManifests.get(familyId)
    if (!manifest) throw new Error(`Production readiness is missing required regression family ${familyId}`)
    const namedGraphs = manifest.packRefs
      .map(({ packId }) => graphByPackId.get(packId))
      .filter((graph): graph is NonNullable<typeof graph> => graph !== undefined)
    if (namedGraphs.length !== manifest.packRefs.length) {
      throw new Error(`${familyId} promoted practice regression omitted a declared side/pack`)
    }
    if (namedGraphs.some(({ paths }) => paths.length === 0)) {
      throw new Error(`${familyId} promoted practice regression found no traversable path`)
    }
  }

  for (const corpus of [broadcast, q2]) {
    if (corpus.accepted + corpus.rejected + corpus.deduplicated !== corpus.recordsSeen) {
      throw new Error(`${corpus.gate} accounting does not reconcile`)
    }
  }
  if (
    broadcast.finalExactReceiptSha256 !== broadcastV31.exactMergeReceiptSha256 ||
    q2.finalExactReceiptSha256 !== q2V31.exactMergeReceiptSha256 ||
    broadcast.accepted !== broadcastV31.receipt.accepted || broadcast.rejected !== broadcastV31.receipt.rejected ||
    broadcast.deduplicated !== broadcastV31.receipt.deduplicated || broadcast.recordsSeen !== broadcastV31.receipt.recordsSeen ||
    q2.accepted !== q2V31.receipt.accepted || q2.rejected !== q2V31.receipt.rejected ||
    q2.deduplicated !== q2V31.receipt.deduplicated || q2.recordsSeen !== q2V31.receipt.recordsSeen ||
    evidence.broadcastExactReceiptSha256 !== broadcastV31.exactMergeReceiptSha256 ||
    evidence.q2ExactReceiptSha256 !== q2V31.exactMergeReceiptSha256
  ) throw new Error('Legacy promotion projections differ from the deep-verified compact-v3.1 corpus chain')

  // The pinned taxonomy contains the 149 reviewed proposals; the approved
  // editorial ledger supplies the final canonical family universe. Every final
  // family is represented in readiness, including families which did not
  // produce a trainable graph. A family-side may be declared eligible only
  // when its audited graph was emitted, so omitted eligible sides cannot hide
  // in a later ranking or top-N selection.
  if (taxonomyInventory.proposedFamilies.length !== 149 || familyManifests.size !== familyEligibility.familyCount) {
    throw new Error('Production readiness requires all reviewed canonical family manifests')
  }
  const familyCoverageFamilies = editorialLedger.families.map(({ id: familyId }) => {
    const manifest = familyManifests.get(familyId)
    if (!manifest) throw new Error(`Production readiness is missing reviewed family ${familyId}`)
    const emittedSides = [...new Set(manifest.packRefs
      .filter(({ packId }) => graphByPackId.has(packId))
      .map(({ side }) => side))].sort((left, right) => left === right ? 0 : left === 'black' ? -1 : 1)
    const evidenceEligibleSides = (['black', 'white'] as const).filter((side) =>
      dispositionByKey.get(`${familyId}:${side}`)?.readiness === 'trainable')
      .sort((left, right) => left === right ? 0 : left === 'black' ? -1 : 1)
    if (JSON.stringify(evidenceEligibleSides) !== JSON.stringify(emittedSides)) {
      throw new Error(`Evidence-eligible family sides differ from emitted promoted packs for ${familyId}`)
    }
    const dispositions = (['black', 'white'] as const).map((side) => dispositionByKey.get(`${familyId}:${side}`)!)
    const nonTrainableReasons = dispositions
      .filter(({ readiness }) => readiness === 'study-only')
      .map(({ reason }) => reason === 'insufficient-sample' ? 'insufficient-sample' as const : 'no-legal-continuation' as const)
    const nonTrainableReason = emittedSides.length > 0
      ? null
      : nonTrainableReasons.includes('insufficient-sample')
        ? 'insufficient-sample' as const
        : 'no-legal-continuation' as const
    return {
      familyId,
      trainable: emittedSides.length > 0,
      evidenceEligibleSides,
      emittedSides,
      nonTrainableReason,
    }
  })
  const trainableFamilyCount = familyCoverageFamilies.filter(({ trainable }) => trainable).length
  const minimumTrainableFamilyCount = Math.floor(familyEligibility.familyCount / 2) + 1
  if (trainableFamilyCount < minimumTrainableFamilyCount) {
    throw new Error(`Production readiness requires a strict majority of trainable canonical families (${minimumTrainableFamilyCount}); found ${trainableFamilyCount}`)
  }
  const evidenceEligibleFamilySideCount = familyCoverageFamilies.reduce((total, family) => total + family.evidenceEligibleSides.length, 0)
  const emittedFamilySideCount = familyCoverageFamilies.reduce((total, family) => total + family.emittedSides.length, 0)
  const auditedAt = (options.now ?? (() => new Date()))().toISOString()
  const newestPromotionTime = Math.max(...[broadcast, q2, evidence, engine, scid, puzzles].map(({ completedAt }) => Date.parse(completedAt)))
  if (Date.parse(auditedAt) < newestPromotionTime) throw new Error('Readiness audit time precedes an immutable promotion receipt')

  const readiness = ProductionDataReadinessSchema.parse({
    schemaVersion: COMPACT_EVIDENCE_SCHEMA_VERSION,
    status: 'pass',
    releaseId: index.releaseId,
    auditedAt,
    storageModel: COMPACT_V31_STORAGE_MODEL,
    appSnapshotManifestSha256: input.appSnapshotManifest.sha256,
    taxonomy: {
      sourceCommit: taxonomyInventory.sourceCommit,
      sourceManifestSha256: index.taxonomySourceManifest.sha256,
      inventorySha256: index.taxonomyInventory.sha256,
      sourceFileCount: taxonomyInventory.sourceFiles.length,
      taxonomyLineCount: taxonomyInventory.taxonomyLineCount,
      ecoCodeCount: taxonomyInventory.ecoCodeCount,
      proposedFamilyCount: taxonomyInventory.proposedFamilyCount,
      exactOwnershipClosure: true,
    },
    familyCoverage: {
      reviewedProposalFamilyCount: taxonomyInventory.proposedFamilyCount,
      reviewedCanonicalFamilyCount: familyEligibility.familyCount,
      minimumTrainableFamilyCount,
      trainableFamilyCount,
      evidenceEligibleFamilySideCount,
      emittedFamilySideCount,
      allEvidenceEligibleFamilySidesEmitted: true,
      families: familyCoverageFamilies,
    },
    corpora: {
      broadcasts: {
        manifestSha256: input.sourceManifests.broadcasts.sha256,
        corpusReceiptSha256: broadcastV31.corpusReceiptSha256,
        exactMergeReceiptSha256: broadcastV31.exactMergeReceiptSha256,
        sourceEdgeInventorySha256: broadcastV31.sourceEdgeInventorySha256,
        eligibleSourceEdges: broadcastV31.eligibleSourceEdges,
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
        corpusReceiptSha256: q2V31.corpusReceiptSha256,
        exactMergeReceiptSha256: q2V31.exactMergeReceiptSha256,
        sourceEdgeInventorySha256: q2V31.sourceEdgeInventorySha256,
        eligibleSourceEdges: q2V31.eligibleSourceEdges,
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

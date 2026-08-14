import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { FamilyPromotionIndexBuildInputV1 } from '../../scripts/release/lib/family-promotion-index-builder.ts'
import type { ImmutableJsonReceiptV1 } from '../../scripts/release/lib/immutable-json-receipt.ts'
import type { ProductionDataReadinessBuildInputV1Schema } from '../../scripts/release/lib/production-data-readiness-builder.ts'
import type { z } from 'zod'
import { createSyntheticCaroKannGraph } from './synthetic-caro-kann-graph.ts'
import { derivePuzzlePromotionReceipt } from '../../scripts/data/puzzle-v3-promotion.ts'
import { createSyntheticVerifiedPuzzlePromotionEvidence } from './synthetic-puzzle-promotion-evidence.ts'
import {
  SYNTHETIC_GRAPH_PROVENANCE_REF,
  createSyntheticFamilyGraphProvenanceDocument,
} from './synthetic-repertoire-evidence.ts'
import { createSyntheticFamilyCampaignBindings } from './synthetic-family-campaign-bindings.ts'
import { productionBrowseManifestFixture } from './production-app-manifest.ts'

export const HANDOFF_FIXTURE_RELEASE = 'synthetic-handoff-release-not-for-shipping'
const HASH = 'a'.repeat(64)
const BROADCAST_EXACT_RECEIPT = 'b'.repeat(64)
const Q2_EXACT_RECEIPT = 'c'.repeat(64)

export type ReadinessBuildInput = z.infer<typeof ProductionDataReadinessBuildInputV1Schema>

async function createSyntheticBrowseSnapshot(root: string): Promise<{
  inputDirectory: string
  manifest: ImmutableJsonReceiptV1 & { encoding: 'identity' }
}> {
  const inputDirectory = join(root, 'browse')
  const plain = Buffer.from('{}\n', 'utf8')
  const stored = gzipSync(plain)
  const blobMetadata = {
    sha256: createHash('sha256').update(stored).digest('hex'),
    compressedBytes: stored.byteLength,
    uncompressedBytes: plain.byteLength,
  }
  const paths = [
    'search.json.gz',
    'audit.json.gz',
    'shards/s_0000000000000000.json.gz',
    'shards/s_1111111111111111.json.gz',
    ...Array.from({ length: 500 }, (_, index) => {
      const eco = `${String.fromCharCode(65 + Math.floor(index / 100))}${String(index % 100).padStart(2, '0')}`
      return `partitions/${eco}.json.gz`
    }),
  ]
  await Promise.all(paths.map(async (path) => {
    const outputPath = join(inputDirectory, path)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, stored, { flag: 'wx' })
  }))
  const manifest = await writeFixtureJson(
    root,
    'app/browse-wire-v2.json',
    productionBrowseManifestFixture(blobMetadata),
  )
  return { inputDirectory, manifest }
}

export function writeFixtureJson(
  root: string,
  path: string,
  value: unknown,
  encoding?: 'identity',
): Promise<ImmutableJsonReceiptV1 & { encoding: 'identity' }>
export function writeFixtureJson(
  root: string,
  path: string,
  value: unknown,
  encoding: 'gzip',
): Promise<ImmutableJsonReceiptV1 & { encoding: 'gzip' }>
export async function writeFixtureJson(
  root: string,
  path: string,
  value: unknown,
  encoding: 'identity' | 'gzip' = 'identity',
): Promise<ImmutableJsonReceiptV1> {
  const plain = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  const stored = encoding === 'gzip' ? gzipSync(plain) : plain
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), stored, { flag: 'wx' })
  return {
    path,
    sha256: createHash('sha256').update(stored).digest('hex'),
    bytes: stored.byteLength,
    uncompressedBytes: plain.byteLength,
    encoding,
  }
}

function contentReference(receipt: ImmutableJsonReceiptV1) {
  assert.equal(receipt.encoding, 'gzip')
  return {
    schemaVersion: 1 as const,
    id: `blob_${receipt.sha256.slice(0, 16)}`,
    releaseId: HANDOFF_FIXTURE_RELEASE,
    path: receipt.path,
    sha256: receipt.sha256,
    compressedBytes: receipt.bytes,
    uncompressedBytes: receipt.uncompressedBytes,
    contentType: 'application/json' as const,
    contentEncoding: 'gzip' as const,
  }
}

export async function createProductionHandoffFixture(options: {
  omitFirstEligibleEdge?: boolean
  engineLearnerNodesOverride?: number
} = {}): Promise<{
  root: string
  familyBuildInput: FamilyPromotionIndexBuildInputV1
  readinessInputs: Omit<ReadinessBuildInput, 'familyPromotionIndex' | 'appSnapshotManifest'>
  browseManifest: ImmutableJsonReceiptV1 & { encoding: 'identity' }
  browseInputDirectory: string
  learnerNodeCount: number
}> {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-production-handoff-'))
  const graph = await createSyntheticCaroKannGraph(HANDOFF_FIXTURE_RELEASE)
  const graphReceipt = await writeFixtureJson(root, 'resources/caro-graph.json.gz', graph, 'gzip')
  const eligibleEdgeIds = graph.edges.filter(({ eligibleForDrill }) => eligibleForDrill).map(({ id }) => id)
  const inventoryReceipt = await writeFixtureJson(root, 'resources/caro-inventory.json', {
    schemaVersion: 1,
    releaseId: HANDOFF_FIXTURE_RELEASE,
    packId: graph.pack.id,
    sourceReceiptSha256: HASH,
    eligibleEdgeIds: options.omitFirstEligibleEdge ? eligibleEdgeIds.slice(1) : eligibleEdgeIds,
  })
  const nestedEvidenceReceipts = await Promise.all(([
    'taxonomy',
    'broadcast-corpus',
    'lichess-standard-corpus',
    'engine',
    'scid',
  ] as const).map(async (kind) => {
    const receipt = await writeFixtureJson(root, `resources/evidence/${kind}.json`, {
      schemaVersion: 1,
      kind,
      synthetic: true,
      productionEvidence: false,
    })
    return { kind, path: receipt.path, sha256: receipt.sha256, bytes: receipt.bytes }
  }))
  const provenanceReceipt = await writeFixtureJson(
    root,
    'resources/caro-provenance.json.gz',
    createSyntheticFamilyGraphProvenanceDocument({
      releaseId: HANDOFF_FIXTURE_RELEASE,
      familyId: 'caro-kann',
      provenanceRefs: [SYNTHETIC_GRAPH_PROVENANCE_REF],
      receipts: nestedEvidenceReceipts,
    }),
    'gzip',
  )
  const learnerNodeCount = new Set(
    graph.edges
      .filter(({ eligibleForDrill, fromNodeId }) =>
        eligibleForDrill && graph.nodes.find(({ id }) => id === fromNodeId)?.learnerTurn)
      .map(({ fromNodeId }) => fromNodeId),
  ).size
  const completedAt = '2026-07-28T12:00:00.000Z'
  const broadcastPromotionReceipt = await writeFixtureJson(root, 'receipts/broadcast.json', {
    schemaVersion: 1, releaseId: HANDOFF_FIXTURE_RELEASE, status: 'pass', completedAt,
    gate: 'lichess-broadcasts-through-2026-06', archiveCount: 78,
    archivesComplete: true, digestsVerified: true,
    recordsSeen: 1_146_297, publishedRecords: 1_146_297,
    accepted: 800_176, rejected: 346_121, deduplicated: 0, accountingReconciles: true,
    finalExactReceiptSha256: BROADCAST_EXACT_RECEIPT,
  })
  const q2PromotionReceipt = await writeFixtureJson(root, 'receipts/q2.json', {
    schemaVersion: 1, releaseId: HANDOFF_FIXTURE_RELEASE, status: 'pass', completedAt,
    gate: 'lichess-standard-q2-2026', archiveMonths: ['2026-04', '2026-05', '2026-06'],
    archiveCount: 3, archivesComplete: true, digestsVerified: true,
    recordsSeen: 267_333_507, publishedRecords: 267_333_507, publishedCompressedBytes: 87_256_474_116,
    accepted: 200_000_000, rejected: 67_333_507, deduplicated: 0, accountingReconciles: true,
    finalExactReceiptSha256: Q2_EXACT_RECEIPT,
  })
  const evidencePromotionReceipt = await writeFixtureJson(root, 'receipts/evidence.json', {
    schemaVersion: 1, releaseId: HANDOFF_FIXTURE_RELEASE, status: 'pass', completedAt,
    gate: 'compact-v3-family-evidence-reconciliation',
    broadcastExactReceiptSha256: BROADCAST_EXACT_RECEIPT,
    q2ExactReceiptSha256: Q2_EXACT_RECEIPT,
    eligibleInventorySourceSha256s: [HASH],
    sourceEdgeInventoryComplete: true,
    topNPracticeCutoffApplied: false,
    hiddenEligiblePracticeBranches: 0,
    provenanceMissing: 0,
    illegalEdges: 0,
    quarantinedEdgesInDrills: 0,
  })
  const campaign = await createSyntheticFamilyCampaignBindings({
    releaseId: HANDOFF_FIXTURE_RELEASE,
    familyId: 'caro-kann',
    graph,
    graphReceipt,
    eligibleInventoryReceipt: inventoryReceipt,
    writeJson: (path, value) => writeFixtureJson(root, path, value),
    completedAt,
    ...(options.engineLearnerNodesOverride === undefined
      ? {}
      : { engineLearnerNodesOverride: options.engineLearnerNodesOverride }),
  })
  assert.equal(campaign.learnerNodeCount, learnerNodeCount)
  const verifiedPuzzle = createSyntheticVerifiedPuzzlePromotionEvidence({
    releaseId: HANDOFF_FIXTURE_RELEASE,
    familyId: 'caro-kann',
    puzzleSourceSha256: HASH,
    broadcastExactReceiptSha256: BROADCAST_EXACT_RECEIPT,
    q2ExactReceiptSha256: Q2_EXACT_RECEIPT,
    graphReconciliationSha256: evidencePromotionReceipt.sha256,
    engineSha256: HASH,
    nnueSha256: HASH,
  })
  const puzzleShard = {
    schemaVersion: 1,
    id: 'blob_0000000000000000',
    releaseId: HANDOFF_FIXTURE_RELEASE,
    generatedAt: '2026-07-28T12:00:00.000Z',
    familyIds: ['caro-kann'],
    puzzles: [verifiedPuzzle.puzzle],
  }
  const puzzleReceipt = await writeFixtureJson(root, 'resources/caro-puzzles.json.gz', puzzleShard, 'gzip')
  const puzzleProofInventory = {
    schemaVersion: 1,
    releaseId: HANDOFF_FIXTURE_RELEASE,
    generatedAt: '2026-07-28T12:00:00.000Z',
    evidence: verifiedPuzzle.evidence,
    evidenceBindingSha256: verifiedPuzzle.evidenceBindingSha256,
    shards: [{
      shardSha256: puzzleReceipt.sha256,
      familyIds: ['caro-kann'],
      verified: [verifiedPuzzle.envelope],
    }],
  }
  const puzzleProofInventoryReceipt = await writeFixtureJson(
    root,
    'resources/caro-puzzle-proof-inventory.json.gz',
    puzzleProofInventory,
    'gzip',
  )
  const puzzlePromotionReceipt = await writeFixtureJson(
    root,
    'receipts/puzzles.json',
    derivePuzzlePromotionReceipt({
      inventory: puzzleProofInventory,
      promotedShards: [{ sha256: puzzleReceipt.sha256, shard: puzzleShard }],
      proofInventory: puzzleProofInventoryReceipt,
      completedAt,
    }),
  )
  const taxonomyLineIds = Array.from(
    { length: 3_790 },
    (_, index) => `tax_${index.toString(16).padStart(24, '0')}`,
  )
  const branches = graph.paths.map((path, index) => ({
    schemaVersion: 1 as const,
    id: `variation-${index + 1}`,
    familyId: 'caro-kann',
    canonicalName: path.familyTags[0]!,
    aliases: [],
  }))
  const manifestReceipt = await writeFixtureJson(root, 'resources/caro-manifest.json.gz', {
    schemaVersion: 1,
    releaseId: HANDOFF_FIXTURE_RELEASE,
    id: 'caro-kann',
    canonicalName: 'Caro-Kann Defence',
    aliases: ['Caro-Kann'],
    ecoCodes: graph.pack.ecoCodes,
    taxonomyLineIds,
    packRefs: [{
      schemaVersion: 1,
      packId: graph.pack.id,
      side: graph.pack.side,
      rootNodeId: graph.pack.rootNodeId,
      graphShardRef: contentReference(graphReceipt),
    }],
    branches,
    pathMemberships: graph.paths.map(({ id }, index) => ({
      schemaVersion: 1,
      packId: graph.pack.id,
      pathId: id,
      primaryBranchId: branches[index]!.id,
      secondaryBranchIds: [],
    })),
    puzzleShardRefs: [contentReference(puzzleReceipt)],
    provenanceRef: contentReference(provenanceReceipt),
  }, 'gzip')
  const catalogReceipt = await writeFixtureJson(root, 'resources/family-catalog.json.gz', {
    schemaVersion: 1,
    releaseId: HANDOFF_FIXTURE_RELEASE,
    generatedAt: '2026-07-28T12:00:00.000Z',
    taxonomyLineCount: 3_790,
    familyCount: 1,
    families: [{
      schemaVersion: 1,
      id: 'caro-kann',
      canonicalName: 'Caro-Kann Defence',
      aliases: ['Caro-Kann'],
      ecoCodes: graph.pack.ecoCodes,
      taxonomyLineCount: 3_790,
      packCount: 1,
      cardCount: graph.nodes.filter(({ cardId }) => cardId !== undefined).length,
      availableSides: ['black'],
      manifestRef: contentReference(manifestReceipt),
    }],
  }, 'gzip')

  const promotionReceipts = {
    broadcast: broadcastPromotionReceipt,
    q2: q2PromotionReceipt,
    evidence: evidencePromotionReceipt,
    engine: campaign.enginePromotionReceipt,
    scid: campaign.scidPromotionReceipt,
    puzzles: puzzlePromotionReceipt,
  }

  const broadcastSource = JSON.parse(
    await readFile(join(process.cwd(), 'data/manifests/broadcasts.source.json'), 'utf8'),
  ) as unknown
  const q2Source = JSON.parse(
    await readFile(join(process.cwd(), 'data/manifests/lichess-standard-q2-2026.source.json'), 'utf8'),
  ) as unknown
  const sourceManifests = {
    broadcasts: await writeFixtureJson(root, 'sources/broadcasts.source.json', broadcastSource),
    standardQ2_2026: await writeFixtureJson(root, 'sources/standard-q2.source.json', q2Source),
  }
  const browse = await createSyntheticBrowseSnapshot(root)

  return {
    root,
    learnerNodeCount,
    browseManifest: browse.manifest,
    browseInputDirectory: browse.inputDirectory,
    familyBuildInput: {
      schemaVersion: 1,
      releaseId: HANDOFF_FIXTURE_RELEASE,
      selectionPolicy: { practiceBranches: 'all-eligible-audited', maximumPracticeBranches: null },
      catalog: catalogReceipt,
      familyGraphBuild: campaign.familyGraphBuild,
      engineProofInventory: campaign.engineProofInventory,
      scidCrosscheckReport: campaign.scidCrosscheckReport,
      families: [{ familyId: 'caro-kann', manifest: manifestReceipt, provenance: provenanceReceipt }],
      packs: [{
        familyId: 'caro-kann', packId: graph.pack.id,
        graph: graphReceipt, eligibleInventory: inventoryReceipt,
      }],
      puzzleShards: [{ familyIds: ['caro-kann'], shard: puzzleReceipt }],
      puzzleProofInventory: puzzleProofInventoryReceipt,
      promotionReceipts,
    },
    readinessInputs: { schemaVersion: 1, sourceManifests },
  }
}

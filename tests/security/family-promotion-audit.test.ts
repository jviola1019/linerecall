import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  auditFamilyPromotion,
} from '../../scripts/release/lib/family-promotion-audit.ts'
import { createSyntheticTranspositionGraph } from '../fixtures/synthetic-repertoire-graph.ts'
import { createSyntheticTacticalPuzzle } from '../fixtures/synthetic-tactical-puzzle.ts'

type Receipt = {
  path: string
  sha256: string
  bytes: number
  uncompressedBytes: number
  encoding: 'identity' | 'gzip'
}

const RELEASE = 'synthetic-fixture-release-not-for-shipping'
const HASH = 'a'.repeat(64)
const BROADCAST_EXACT_RECEIPT = 'b'.repeat(64)
const Q2_EXACT_RECEIPT = 'c'.repeat(64)

async function writeJson(root: string, path: string, value: unknown, encoding: 'identity' | 'gzip'): Promise<Receipt> {
  const plain = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  const stored = encoding === 'gzip' ? gzipSync(plain) : plain
  await mkdir(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true })
  await writeFile(join(root, path), stored)
  return {
    path,
    sha256: createHash('sha256').update(stored).digest('hex'),
    bytes: stored.byteLength,
    uncompressedBytes: plain.byteLength,
    encoding,
  }
}

function contentRef(receipt: Receipt) {
  assert.equal(receipt.encoding, 'gzip')
  return {
    schemaVersion: 1 as const,
    id: `blob_${receipt.sha256.slice(0, 16)}`,
    releaseId: RELEASE,
    path: receipt.path,
    sha256: receipt.sha256,
    compressedBytes: receipt.bytes,
    uncompressedBytes: receipt.uncompressedBytes,
    contentType: 'application/json' as const,
    contentEncoding: 'gzip' as const,
  }
}

async function fixture(): Promise<{ root: string; index: any }> {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-family-promotion-'))
  const graph = await createSyntheticTranspositionGraph()
  const graphReceipt = await writeJson(root, 'resources/graph.json.gz', graph, 'gzip')
  const inventoryReceipt = await writeJson(root, 'resources/inventory.json', {
    schemaVersion: 1,
    releaseId: RELEASE,
    packId: graph.pack.id,
    sourceReceiptSha256: HASH,
    eligibleEdgeIds: graph.edges.filter(({ eligibleForDrill }) => eligibleForDrill).map(({ id }) => id),
  }, 'identity')
  const provenanceReceipt = await writeJson(root, 'resources/provenance.json.gz', {
    schemaVersion: 1,
    releaseId: RELEASE,
    synthetic: true,
  }, 'gzip')
  const puzzleReceipt = await writeJson(root, 'resources/puzzles.json.gz', {
    schemaVersion: 1,
    id: 'blob_0000000000000000',
    releaseId: RELEASE,
    generatedAt: '2026-07-28T12:00:00.000Z',
    familyIds: ['synthetic-family'],
    puzzles: [createSyntheticTacticalPuzzle()],
  }, 'gzip')
  const taxonomyLineIds = Array.from(
    { length: 3_790 },
    (_, index) => `tax_${index.toString(16).padStart(24, '0')}`,
  )
  const manifestReceipt = await writeJson(root, 'resources/manifest.json.gz', {
    schemaVersion: 1,
    releaseId: RELEASE,
    id: 'synthetic-family',
    canonicalName: 'Synthetic Family',
    aliases: [],
    ecoCodes: ['A00'],
    taxonomyLineIds,
    packRefs: [{
      schemaVersion: 1,
      packId: graph.pack.id,
      side: graph.pack.side,
      rootNodeId: graph.pack.rootNodeId,
      graphShardRef: contentRef(graphReceipt),
    }],
    branches: [{
      schemaVersion: 1,
      id: 'main',
      familyId: 'synthetic-family',
      canonicalName: 'Main',
      aliases: [],
    }],
    pathMemberships: graph.paths.map(({ id }) => ({
      schemaVersion: 1,
      packId: graph.pack.id,
      pathId: id,
      primaryBranchId: 'main',
      secondaryBranchIds: [],
    })),
    puzzleShardRefs: [contentRef(puzzleReceipt)],
    provenanceRef: contentRef(provenanceReceipt),
  }, 'gzip')
  const catalogReceipt = await writeJson(root, 'resources/catalog.json.gz', {
    schemaVersion: 1,
    releaseId: RELEASE,
    generatedAt: '2026-07-28T12:00:00.000Z',
    taxonomyLineCount: 3_790,
    familyCount: 1,
    families: [{
      schemaVersion: 1,
      id: 'synthetic-family',
      canonicalName: 'Synthetic Family',
      aliases: [],
      ecoCodes: ['A00'],
      taxonomyLineCount: 3_790,
      packCount: 1,
      cardCount: graph.nodes.filter(({ cardId }) => cardId !== undefined).length,
      availableSides: [graph.pack.side],
      manifestRef: contentRef(manifestReceipt),
    }],
  }, 'gzip')

  const gates = {
    broadcast: await writeJson(root, 'receipts/broadcast.json', {
      schemaVersion: 1, releaseId: RELEASE, status: 'pass', completedAt: '2026-07-28T12:00:00.000Z',
      gate: 'lichess-broadcasts-through-2026-06', archiveCount: 78,
      archivesComplete: true, digestsVerified: true,
      recordsSeen: 1_146_297, publishedRecords: 1_146_297,
      accepted: 800_176, rejected: 346_121, deduplicated: 0, accountingReconciles: true,
      finalExactReceiptSha256: BROADCAST_EXACT_RECEIPT,
    }, 'identity'),
    q2: await writeJson(root, 'receipts/q2.json', {
      schemaVersion: 1, releaseId: RELEASE, status: 'pass', completedAt: '2026-07-28T12:00:00.000Z',
      gate: 'lichess-standard-q2-2026', archiveMonths: ['2026-04', '2026-05', '2026-06'],
      archiveCount: 3, archivesComplete: true, digestsVerified: true,
      recordsSeen: 267_333_507, publishedRecords: 267_333_507, publishedCompressedBytes: 87_256_474_116,
      accepted: 200_000_000, rejected: 67_333_507, deduplicated: 0, accountingReconciles: true,
      finalExactReceiptSha256: Q2_EXACT_RECEIPT,
    }, 'identity'),
    evidence: await writeJson(root, 'receipts/evidence-reconciliation.json', {
      schemaVersion: 1, releaseId: RELEASE, status: 'pass', completedAt: '2026-07-28T12:00:00.000Z',
      gate: 'compact-v3-family-evidence-reconciliation',
      broadcastExactReceiptSha256: BROADCAST_EXACT_RECEIPT,
      q2ExactReceiptSha256: Q2_EXACT_RECEIPT,
      eligibleInventorySourceSha256s: [HASH],
      sourceEdgeInventoryComplete: true,
      topNPracticeCutoffApplied: false,
    }, 'identity'),
    engine: await writeJson(root, 'receipts/engine.json', {
      schemaVersion: 1, releaseId: RELEASE, status: 'pass', completedAt: '2026-07-28T12:00:00.000Z',
      gate: 'stockfish-18-family-graphs', engineName: 'Stockfish 18', threads: 1, hashMb: 128,
      multiPv: 5, nodesPerPosition: 250_000, learnerNodesChecked: 3,
      allDrillableLearnerNodesChecked: true, engineSha256: HASH, nnueSha256: [HASH],
    }, 'identity'),
    scid: await writeJson(root, 'receipts/scid.json', {
      schemaVersion: 1, releaseId: RELEASE, status: 'pass', completedAt: '2026-07-28T12:00:00.000Z',
      gate: 'scid-family-crosscheck', stratifiedSampleComplete: true, sampledLines: 1,
      conflictingBaseEcoInDrills: 0, oracleContentShipped: false,
    }, 'identity'),
    puzzles: await writeJson(root, 'receipts/puzzle-promotion.json', {
      schemaVersion: 1, releaseId: RELEASE, status: 'pass', completedAt: '2026-07-28T12:00:00.000Z',
      gate: 'lichess-puzzle-promotion', sourceDigestApproved: true, sourceSha256: HASH,
      promotedShardCount: 1, promotedPuzzleCount: 1, legalityComplete: true,
      associationComplete: true, engineChecksComplete: true, duplicatePuzzleIds: 0,
    }, 'identity'),
  }
  const index = {
    schemaVersion: 1,
    releaseId: RELEASE,
    selectionPolicy: { practiceBranches: 'all-eligible-audited', maximumPracticeBranches: null },
    catalog: catalogReceipt,
    families: [{ familyId: 'synthetic-family', manifest: manifestReceipt, provenance: provenanceReceipt }],
    packs: [{ familyId: 'synthetic-family', packId: graph.pack.id, graph: graphReceipt, eligibleInventory: inventoryReceipt }],
    puzzleShards: [{ familyIds: ['synthetic-family'], shard: puzzleReceipt }],
    promotionReceipts: gates,
  }
  await writeJson(root, 'index.json', index, 'identity')
  return { root, index }
}

test('promotion audit passes only a complete receipt-bound family release with exact eligible-edge equality', async () => {
  const { root } = await fixture()
  const report = await auditFamilyPromotion({ root, indexPath: 'index.json', now: () => new Date('2026-07-28T13:00:00.000Z') })
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.counts.families, 1)
  assert.equal(report.counts.packs, 1)
  assert.equal(report.counts.puzzleShards, 1)
  assert.ok(report.counts.eligibleEdges > 0)
  assert.ok(report.gates.every(({ status }) => status === 'pass'))
})

test('promotion audit blocks absent hard-gate receipts, path traversal, and omitted eligible edges', async () => {
  const missing = await fixture()
  missing.index.promotionReceipts = {}
  await writeJson(missing.root, 'missing-receipt-index.json', missing.index, 'identity')
  const missingReport = await auditFamilyPromotion({ root: missing.root, indexPath: 'missing-receipt-index.json' })
  assert.equal(missingReport.status, 'blocked')
  for (const gate of ['broadcast', 'q2', 'evidence', 'engine', 'scid', 'puzzles']) {
    assert.ok(missingReport.findings.some(({ code }) => code === `${gate}-promotion-receipt-absent`))
  }

  const traversal = await auditFamilyPromotion({ root: missing.root, indexPath: '../index.json' })
  assert.equal(traversal.status, 'blocked')
  assert.ok(traversal.findings.some(({ code }) => code === 'promotion-index-invalid'))

  const omitted = await fixture()
  const graph = await createSyntheticTranspositionGraph()
  omitted.index.packs[0].eligibleInventory = await writeJson(omitted.root, 'resources/omitted-inventory.json', {
    schemaVersion: 1,
    releaseId: RELEASE,
    packId: graph.pack.id,
    sourceReceiptSha256: HASH,
    eligibleEdgeIds: graph.edges.filter(({ eligibleForDrill }) => eligibleForDrill).slice(1).map(({ id }) => id),
  }, 'identity')
  await writeJson(omitted.root, 'omitted-edge-index.json', omitted.index, 'identity')
  const omittedReport = await auditFamilyPromotion({ root: omitted.root, indexPath: 'omitted-edge-index.json' })
  assert.equal(omittedReport.status, 'blocked')
  assert.ok(omittedReport.findings.some(({ code, message }) =>
    code === 'pack-promotion-invalid' && /omitted/u.test(message)))
})

test('promotion audit rejects an eligible inventory not bound to reconciled exact-corpus evidence', async () => {
  const forged = await fixture()
  const graph = await createSyntheticTranspositionGraph()
  forged.index.packs[0].eligibleInventory = await writeJson(forged.root, 'resources/unbound-inventory.json', {
    schemaVersion: 1,
    releaseId: RELEASE,
    packId: graph.pack.id,
    sourceReceiptSha256: 'd'.repeat(64),
    eligibleEdgeIds: graph.edges.filter(({ eligibleForDrill }) => eligibleForDrill).map(({ id }) => id),
  }, 'identity')
  await writeJson(forged.root, 'unbound-inventory-index.json', forged.index, 'identity')
  const report = await auditFamilyPromotion({
    root: forged.root,
    indexPath: 'unbound-inventory-index.json',
  })
  assert.equal(report.status, 'blocked')
  assert.ok(report.findings.some(({ code }) => code === 'source-edge-reconciliation-mismatch'))
  assert.equal(report.gates.find(({ id }) => id === 'source-edge-evidence-chain')?.status, 'blocked')

  const mismatchedExact = await fixture()
  mismatchedExact.index.promotionReceipts.evidence = await writeJson(
    mismatchedExact.root,
    'receipts/mismatched-evidence-reconciliation.json',
    {
      schemaVersion: 1, releaseId: RELEASE, status: 'pass', completedAt: '2026-07-28T12:00:00.000Z',
      gate: 'compact-v3-family-evidence-reconciliation',
      broadcastExactReceiptSha256: 'e'.repeat(64),
      q2ExactReceiptSha256: Q2_EXACT_RECEIPT,
      eligibleInventorySourceSha256s: [HASH],
      sourceEdgeInventoryComplete: true,
      topNPracticeCutoffApplied: false,
    },
    'identity',
  )
  await writeJson(mismatchedExact.root, 'mismatched-exact-index.json', mismatchedExact.index, 'identity')
  const mismatchedReport = await auditFamilyPromotion({
    root: mismatchedExact.root,
    indexPath: 'mismatched-exact-index.json',
  })
  assert.equal(mismatchedReport.status, 'blocked')
  assert.ok(mismatchedReport.findings.some(({ code }) => code === 'source-edge-reconciliation-mismatch'))
})

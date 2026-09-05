import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProductionDataReadinessSchema,
  evaluateProductionDataReadiness,
} from '../../scripts/release/lib/production-data-readiness.ts'
import { productionAppManifestFixture } from '../fixtures/production-app-manifest.ts'

const hash = 'a'.repeat(64)

function completeFamilyCoverage(): unknown {
  return {
    reviewedProposalFamilyCount: 149,
    reviewedCanonicalFamilyCount: 149,
    minimumTrainableFamilyCount: 75,
    trainableFamilyCount: 149,
    evidenceEligibleFamilySideCount: 149,
    emittedFamilySideCount: 149,
    allEvidenceEligibleFamilySidesEmitted: true,
    families: Array.from({ length: 149 }, (_, index) => ({
      familyId: `fixture-family-${String(index).padStart(3, '0')}`,
      trainable: true,
      evidenceEligibleSides: ['black'],
      emittedSides: ['black'],
      nonTrainableReason: null,
    })),
  }
}

function completeReadiness(): unknown {
  return {
    schemaVersion: 3,
    status: 'pass',
    releaseId: 'release-2026-07-16',
    auditedAt: '2026-07-16T12:00:00.000Z',
    storageModel: 'log-structured-external-merge-v3.1',
    appSnapshotManifestSha256: hash,
    taxonomy: { sourceCommit: '17ee660257de02870636f36248e919f2e01d8e85', sourceManifestSha256: hash, inventorySha256: hash, sourceFileCount: 5, taxonomyLineCount: 3_790, ecoCodeCount: 500, proposedFamilyCount: 149, exactOwnershipClosure: true },
    familyCoverage: completeFamilyCoverage(),
    corpora: {
      broadcasts: { manifestSha256: hash, corpusReceiptSha256: hash, exactMergeReceiptSha256: hash, sourceEdgeInventorySha256: hash, eligibleSourceEdges: 1, archiveCount: 78, archivesComplete: true, digestsVerified: true, recordsSeen: 1_146_297, accepted: 800_176, rejected: 346_121, deduplicated: 0, accountingReconciles: true },
      standardQ2_2026: { manifestSha256: hash, corpusReceiptSha256: hash, exactMergeReceiptSha256: hash, sourceEdgeInventorySha256: hash, eligibleSourceEdges: 1, archiveCount: 3, archivesComplete: true, digestsVerified: true, recordsSeen: 267_333_507, publishedRecords: 267_333_507, publishedCompressedBytes: 87_256_474_116, accepted: 200_000_000, rejected: 67_333_507, deduplicated: 0, accountingReconciles: true },
    },
    graph: { schemaVersion: 3, baselineMaximumPly: 30, adaptiveMaximumPly: 100, exactSecondPassComplete: true, reconciliationComplete: true, allEligiblePracticeBranchesRetained: true, maximumPracticeBranches: null, hiddenEligiblePracticeBranches: 0, terminalPolicy: 'evidence-defined-through-ply-100', coreMinimumLearnerDecisions: 10, provenanceMissing: 0, illegalEdges: 0, quarantinedEdgesInDrills: 0, unresolvedDataDiscrepancies: 0, familyGraphBuildSha256: hash },
    engine: { name: 'Stockfish 18', threads: 1, hashMb: 128, multiPv: 5, nodes: 250_000, learnerNodesChecked: 1, proofInventorySha256: hash, engineSha256: hash, nnueSha256: [hash] },
    scid: { sampledLines: 250, conflictingBaseEcoInDrills: 0, oracleContentShipped: false, crosscheckReportSha256: hash },
    puzzles: { sourceDigestApproved: true, sourceSha256: hash, accepted: 1, learnerNodesEngineChecked: true, masterySeparatedFromRecall: true },
    caroKann: { ecoRange: 'B10-B19', familyGraphCount: 1, drillablePaths: 8, namedFamilies: ['Advance', 'Exchange', 'Panov', 'Classical', 'Two Knights'], mislabeledCorePaths: 0 },
  }
}

function v3AppManifest(): unknown {
  return productionAppManifestFixture('release-2026-07-16')
}

test('complete v3.1 corpus evidence and an exact app-manifest receipt satisfy the production data contract', () => {
  assert.doesNotThrow(() => ProductionDataReadinessSchema.parse(completeReadiness()))
  assert.deepEqual(evaluateProductionDataReadiness(completeReadiness(), v3AppManifest(), hash), [])
})

test('family coverage is mandatory even for synthetic-looking release IDs', () => {
  const readiness = completeReadiness() as Record<string, unknown>
  readiness.releaseId = 'synthetic-readiness-fixture'
  delete readiness.familyCoverage
  assert.throws(() => ProductionDataReadinessSchema.parse(readiness), /familyCoverage/u)
  const findings = evaluateProductionDataReadiness(readiness, v3AppManifest(), hash)
  assert.ok(findings.some(({ rule }) => rule === 'production-data-readiness-invalid'))
})

test('legacy top-three app snapshots are categorically rejected for production promotion', () => {
  const findings = evaluateProductionDataReadiness(completeReadiness(), {
    v: 2,
    schema: 'linerecall-app-wire-v2',
    maximumLinesPerEco: 3,
  }, hash)
  assert.ok(findings.some(({ rule }) => rule === 'legacy-or-invalid-app-snapshot'))
})

test('readiness must reconcile the embedded manifest and preserve all eligible practice branches', () => {
  const readiness = completeReadiness() as Record<string, any>
  readiness.appSnapshotManifestSha256 = 'b'.repeat(64)
  readiness.graph.maximumPracticeBranches = 3
  readiness.graph.hiddenEligiblePracticeBranches = 7
  const findings = evaluateProductionDataReadiness(readiness, v3AppManifest(), hash)
  assert.ok(findings.some(({ rule }) => rule === 'production-data-readiness-invalid'))
})

test('readiness requires a strict majority of reviewed families and explicit non-trainable reasons', () => {
  const readiness = completeReadiness() as Record<string, any>
  readiness.familyCoverage.families = readiness.familyCoverage.families.map((family: any, index: number) => index < 75
    ? { ...family, trainable: false, evidenceEligibleSides: [], emittedSides: [], nonTrainableReason: 'insufficient-sample' }
    : family)
  readiness.familyCoverage.trainableFamilyCount = 74
  readiness.familyCoverage.evidenceEligibleFamilySideCount = 74
  readiness.familyCoverage.emittedFamilySideCount = 74
  assert.throws(() => ProductionDataReadinessSchema.parse(readiness), /at least|reconcile|trainable/iu)

  const missingReason = completeReadiness() as Record<string, any>
  missingReason.familyCoverage.families[0].trainable = false
  missingReason.familyCoverage.families[0].evidenceEligibleSides = []
  missingReason.familyCoverage.families[0].emittedSides = []
  missingReason.familyCoverage.families[0].nonTrainableReason = null
  assert.throws(() => ProductionDataReadinessSchema.parse(missingReason), /non-trainable family/iu)
})

test('readiness majority derives from final canonical count after a split', () => {
  const readiness = structuredClone(completeReadiness()) as Record<string, any>
  readiness.familyCoverage.reviewedCanonicalFamilyCount = 150
  readiness.familyCoverage.minimumTrainableFamilyCount = 75
  readiness.familyCoverage.families.push({
    familyId: 'fixture-family-149-split',
    trainable: true,
    evidenceEligibleSides: ['black'],
    emittedSides: ['black'],
    nonTrainableReason: null,
  })
  readiness.familyCoverage.trainableFamilyCount = 150
  readiness.familyCoverage.evidenceEligibleFamilySideCount = 150
  readiness.familyCoverage.emittedFamilySideCount = 150
  assert.throws(() => ProductionDataReadinessSchema.parse(readiness), /strict over the canonical family count/iu)
  readiness.familyCoverage.minimumTrainableFamilyCount = 76
  assert.doesNotThrow(() => ProductionDataReadinessSchema.parse(readiness))
})

test('readiness rejects an evidence-eligible family side omitted from emitted packs', () => {
  const readiness = completeReadiness() as Record<string, any>
  readiness.familyCoverage.families[0].emittedSides = []
  readiness.familyCoverage.emittedFamilySideCount = 148
  assert.throws(() => ProductionDataReadinessSchema.parse(readiness), /eligible family side/iu)
})

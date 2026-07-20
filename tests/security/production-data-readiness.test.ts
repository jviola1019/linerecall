import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProductionDataReadinessSchema,
  evaluateProductionDataReadiness,
} from '../../scripts/release/lib/production-data-readiness.ts'

const hash = 'a'.repeat(64)

function completeReadiness(): unknown {
  return {
    schemaVersion: 3,
    status: 'pass',
    releaseId: 'release-2026-07-16',
    auditedAt: '2026-07-16T12:00:00.000Z',
    storageModel: 'bounded-two-pass-content-addressed-v3',
    appSnapshotManifestSha256: hash,
    corpora: {
      broadcasts: { manifestSha256: hash, archiveCount: 78, archivesComplete: true, digestsVerified: true, recordsSeen: 1_146_297, accepted: 800_176, rejected: 346_121, deduplicated: 0, accountingReconciles: true },
      standardQ2_2026: { manifestSha256: hash, archiveCount: 3, archivesComplete: true, digestsVerified: true, recordsSeen: 267_333_507, publishedRecords: 267_333_507, publishedCompressedBytes: 87_256_474_116, accepted: 200_000_000, rejected: 67_333_507, deduplicated: 0, accountingReconciles: true },
    },
    graph: { schemaVersion: 3, baselineMaximumPly: 30, adaptiveMaximumPly: 100, exactSecondPassComplete: true, reconciliationComplete: true, allEligiblePracticeBranchesRetained: true, maximumPracticeBranches: null, hiddenEligiblePracticeBranches: 0, terminalPolicy: 'evidence-defined-through-ply-100', coreMinimumLearnerDecisions: 10, provenanceMissing: 0, illegalEdges: 0, quarantinedEdgesInDrills: 0, unresolvedDataDiscrepancies: 0 },
    engine: { name: 'Stockfish 18', threads: 1, hashMb: 128, multiPv: 5, nodes: 250_000, learnerNodesChecked: 1, engineSha256: hash, nnueSha256: [hash] },
    scid: { sampledLines: 250, conflictingBaseEcoInDrills: 0, oracleContentShipped: false },
    puzzles: { sourceDigestApproved: true, sourceSha256: hash, accepted: 1, learnerNodesEngineChecked: true, masterySeparatedFromRecall: true },
    caroKann: { ecoRange: 'B10-B19', familyGraphCount: 1, drillablePaths: 8, namedFamilies: ['Advance', 'Exchange', 'Panov', 'Classical', 'Two Knights'], mislabeledCorePaths: 0 },
  }
}

function v3AppManifest(): unknown {
  return {
    v: 3,
    schema: 'linerecall-app-wire-v3',
    releaseId: 'release-2026-07-16',
    selectionPolicy: { practiceBranches: 'all-eligible-audited', maximumPracticeBranches: null, terminal: 'evidence-defined-through-ply-100' },
  }
}

test('complete v3 evidence and an exact app-manifest receipt satisfy the production data contract', () => {
  assert.doesNotThrow(() => ProductionDataReadinessSchema.parse(completeReadiness()))
  assert.deepEqual(evaluateProductionDataReadiness(completeReadiness(), v3AppManifest(), hash), [])
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

import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { embedProductionAppSnapshot } from '../../scripts/build/embed-app-snapshot.ts'
import { auditProductionCandidateBinding } from '../../scripts/release/check-production-candidate-binding.ts'
import { auditArtifact } from '../../scripts/security/audit-artifact.ts'
import { buildFamilyPromotionIndex } from '../../scripts/release/lib/family-promotion-index-builder.ts'
import { buildProductionAppSnapshotManifest } from '../../scripts/release/lib/production-app-snapshot-builder.ts'
import { EmbeddedProductionSnapshotPayloadV3Schema } from '../../src/data/embedded-contract.ts'
import { ProductionDataReadinessSchema } from '../../scripts/release/lib/production-data-readiness.ts'
import { createProductionHandoffFixture } from '../fixtures/production-handoff-fixture.ts'

function identityReceipt(result: { outputPath: string; sha256: string; bytes: number }) {
  return {
    path: result.outputPath,
    sha256: result.sha256,
    bytes: result.bytes,
    uncompressedBytes: result.bytes,
    encoding: 'identity' as const,
  }
}

function candidateHtml(value: unknown): string {
  const payload = JSON.stringify(value).replaceAll('<', '\\u003c')
  return `<!doctype html><html lang="en-US" dir="ltr"><head><meta name="viewport" content="width=device-width"></head><body><script id="linerecall-embedded-snapshot" type="application/json">${payload}</script></body></html>`
}

/**
 * This test exercises candidate byte binding, not the expensive production
 * handoff derivation. Keep a strict, receipt-shaped synthetic readiness value
 * at this boundary; production-data-readiness tests cover that builder's
 * source rederivation and fail-closed behavior separately.
 */
function syntheticCandidateReadiness(releaseId: string, appManifestSha256: string): unknown {
  const hash = 'a'.repeat(64)
  const families = Array.from({ length: 149 }, (_, index) => ({
    familyId: `fixture-family-${String(index).padStart(3, '0')}`,
    trainable: index < 75,
    evidenceEligibleSides: index < 75 ? ['black'] : [],
    emittedSides: index < 75 ? ['black'] : [],
    nonTrainableReason: index < 75 ? null : 'insufficient-sample',
  }))
  return ProductionDataReadinessSchema.parse({
    schemaVersion: 3,
    status: 'pass',
    releaseId,
    auditedAt: '2026-08-27T16:02:00.000Z',
    storageModel: 'log-structured-external-merge-v3.1',
    appSnapshotManifestSha256: appManifestSha256,
    taxonomy: {
      sourceCommit: '17ee660257de02870636f36248e919f2e01d8e85',
      sourceManifestSha256: hash,
      inventorySha256: hash,
      sourceFileCount: 5,
      taxonomyLineCount: 3_790,
      ecoCodeCount: 500,
      proposedFamilyCount: 149,
      exactOwnershipClosure: true,
    },
    familyCoverage: {
      reviewedProposalFamilyCount: 149,
      reviewedCanonicalFamilyCount: 149,
      minimumTrainableFamilyCount: 75,
      trainableFamilyCount: 75,
      evidenceEligibleFamilySideCount: 75,
      emittedFamilySideCount: 75,
      allEvidenceEligibleFamilySidesEmitted: true,
      families,
    },
    corpora: {
      broadcasts: { manifestSha256: hash, corpusReceiptSha256: hash, exactMergeReceiptSha256: hash, sourceEdgeInventorySha256: hash, eligibleSourceEdges: 1, archiveCount: 78, archivesComplete: true, digestsVerified: true, recordsSeen: 1_146_297, accepted: 800_176, rejected: 346_121, deduplicated: 0, accountingReconciles: true },
      standardQ2_2026: { manifestSha256: hash, corpusReceiptSha256: hash, exactMergeReceiptSha256: hash, sourceEdgeInventorySha256: hash, eligibleSourceEdges: 1, archiveCount: 3, archivesComplete: true, digestsVerified: true, recordsSeen: 267_333_507, publishedRecords: 267_333_507, publishedCompressedBytes: 87_256_474_116, accepted: 200_000_000, rejected: 67_333_507, deduplicated: 0, accountingReconciles: true },
    },
    graph: { schemaVersion: 3, baselineMaximumPly: 30, adaptiveMaximumPly: 100, exactSecondPassComplete: true, reconciliationComplete: true, allEligiblePracticeBranchesRetained: true, maximumPracticeBranches: null, hiddenEligiblePracticeBranches: 0, terminalPolicy: 'evidence-defined-through-ply-100', coreMinimumLearnerDecisions: 10, provenanceMissing: 0, illegalEdges: 0, quarantinedEdgesInDrills: 0, unresolvedDataDiscrepancies: 0, familyGraphBuildSha256: hash },
    engine: { name: 'Stockfish 18', threads: 1, hashMb: 128, multiPv: 5, nodes: 250_000, learnerNodesChecked: 1, proofInventorySha256: hash, engineSha256: hash, nnueSha256: [hash] },
    scid: { sampledLines: 250, conflictingBaseEcoInDrills: 0, oracleContentShipped: false, crosscheckReportSha256: hash },
    puzzles: { sourceDigestApproved: true, sourceSha256: hash, accepted: 1, learnerNodesEngineChecked: true, masterySeparatedFromRecall: true },
    caroKann: { ecoRange: 'B10-B19', familyGraphCount: 1, drillablePaths: 8, namedFamilies: ['Advance', 'Exchange', 'Panov', 'Classical', 'Two Knights'], mislabeledCorePaths: 0 },
  })
}

test('production candidate binding accepts only the exact readiness-bound v3 bytes', async () => {
  const fixture = await createProductionHandoffFixture()
  try {
    const family = await buildFamilyPromotionIndex({
      root: fixture.root,
      outputPath: 'handoff/family-promotion-index.json',
      input: fixture.familyBuildInput,
      now: () => new Date('2026-08-27T16:00:00.000Z'),
    })
    const app = await buildProductionAppSnapshotManifest({
      root: fixture.root,
      outputPath: 'handoff/app-wire-v3.json',
      input: {
        schemaVersion: 1,
        familyPromotionIndex: identityReceipt(family),
        browseManifest: fixture.browseManifest,
      },
      now: () => new Date('2026-08-27T16:01:00.000Z'),
    })
    const appValue = JSON.parse(await readFile(join(fixture.root, app.outputPath), 'utf8')) as { releaseId: string }
    const readinessValue = syntheticCandidateReadiness(appValue.releaseId, app.sha256)
    const readinessPath = resolve(fixture.root, 'handoff/production-data-readiness.json')
    await writeFile(readinessPath, `${JSON.stringify(readinessValue)}\n`, 'utf8')
    const embeddedPath = resolve(fixture.root, 'handoff/embedded-production.json')
    await embedProductionAppSnapshot({
      root: fixture.root,
      appManifestReceipt: identityReceipt(app),
      browseInputDirectory: fixture.browseInputDirectory,
      outputPath: embeddedPath,
    })
    const payload = EmbeddedProductionSnapshotPayloadV3Schema.parse(
      JSON.parse(await readFile(embeddedPath, 'utf8')) as unknown,
    )
    const candidatePath = resolve(fixture.root, 'handoff/linerecall.html')
    await writeFile(candidatePath, candidateHtml(payload), 'utf8')
    const exact = await auditProductionCandidateBinding({
      candidatePath,
      appManifestPath: resolve(fixture.root, app.outputPath),
      browseManifestPath: resolve(fixture.root, fixture.browseManifest.path),
      readinessPath,
    })
    assert.equal(exact.status, 'pass', JSON.stringify(exact.findings))
    assert.equal(
      (await auditArtifact(candidatePath)).find(({ id }) => id === 'embedded-snapshot-container')?.status,
      'pass',
    )

    const wrongManifestBinding = structuredClone(payload)
    wrongManifestBinding.appManifestSha256 = 'f'.repeat(64)
    await writeFile(candidatePath, candidateHtml(wrongManifestBinding), 'utf8')
    const mismatched = await auditProductionCandidateBinding({
      candidatePath,
      appManifestPath: resolve(fixture.root, app.outputPath),
      browseManifestPath: resolve(fixture.root, fixture.browseManifest.path),
      readinessPath,
    })
    assert.equal(mismatched.status, 'fail')
    assert.equal(
      mismatched.findings.some((finding) => finding.rule === 'candidate-app-manifest-digest-mismatch'),
      true,
    )

    await writeFile(candidatePath, candidateHtml(payload), 'utf8')
    const browseManifestPath = resolve(fixture.root, fixture.browseManifest.path)
    const browseSource = await readFile(browseManifestPath, 'utf8')
    const changedBrowse = JSON.parse(browseSource) as { g: string }
    changedBrowse.g = '2026-08-27T16:03:00.000Z'
    await writeFile(browseManifestPath, `${JSON.stringify(changedBrowse)}\n`, 'utf8')
    const browseMismatch = await auditProductionCandidateBinding({
      candidatePath,
      appManifestPath: resolve(fixture.root, app.outputPath),
      browseManifestPath,
      readinessPath,
    })
    assert.equal(browseMismatch.status, 'fail')
    assert.equal(
      browseMismatch.findings.some((finding) => finding.rule === 'candidate-browse-manifest-binding-mismatch'),
      true,
    )
    await writeFile(browseManifestPath, browseSource, 'utf8')

    await writeFile(candidatePath, candidateHtml(payload.base), 'utf8')
    const reviewPayload = await auditProductionCandidateBinding({
      candidatePath,
      appManifestPath: resolve(fixture.root, app.outputPath),
      browseManifestPath: resolve(fixture.root, fixture.browseManifest.path),
      readinessPath,
    })
    assert.equal(reviewPayload.status, 'fail')
    assert.equal(reviewPayload.findings[0]?.rule, 'production-candidate-binding-invalid')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

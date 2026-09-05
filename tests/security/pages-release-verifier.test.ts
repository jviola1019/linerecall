import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyPagesRelease } from '../../scripts/release/verify-pages-release.ts'
import { sha256File } from '../../scripts/security/lib/files.ts'
import {
  contentAddressEvidenceFile,
  GateConfigSchema,
  readEvidence,
  type GateResult,
} from '../../scripts/release/lib/evidence-integrity.ts'
import {
  canonicalJson,
  loadUnsignedReleaseBindings,
  loadVerifiedReleaseBindings,
} from '../../scripts/release/lib/release-bindings.ts'
import { createSourceSnapshot } from '../../scripts/release/lib/source-snapshot.ts'
import { productionAppManifestFixture } from '../fixtures/production-app-manifest.ts'

const releaseId = 'release-2026-07-16'
const sourceRoots = ['src'] as const

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readiness(appSnapshotManifestSha256: string) {
  const hash = 'a'.repeat(64)
  const families = Array.from({ length: 149 }, (_, index) => `fixture-family-${index}`).sort((left, right) => left.localeCompare(right, 'en'))
  const reviewedFamilies = families.map((familyId, index) => {
    const trainable = index < 75
    return {
      familyId,
      trainable,
      evidenceEligibleSides: trainable ? ['white' as const] : [],
      emittedSides: trainable ? ['white' as const] : [],
      nonTrainableReason: trainable ? null : 'insufficient-sample' as const,
    }
  })
  return {
    schemaVersion: 3,
    status: 'pass',
    releaseId,
    auditedAt: '2026-07-16T12:00:00.000Z',
    storageModel: 'log-structured-external-merge-v3.1',
    appSnapshotManifestSha256,
    taxonomy: { sourceCommit: '17ee660257de02870636f36248e919f2e01d8e85', sourceManifestSha256: hash, inventorySha256: hash, sourceFileCount: 5, taxonomyLineCount: 3_790, ecoCodeCount: 500, proposedFamilyCount: 149, exactOwnershipClosure: true },
    familyCoverage: {
      reviewedProposalFamilyCount: 149,
      reviewedCanonicalFamilyCount: 149,
      minimumTrainableFamilyCount: 75,
      trainableFamilyCount: 75,
      evidenceEligibleFamilySideCount: 75,
      emittedFamilySideCount: 75,
      allEvidenceEligibleFamilySidesEmitted: true,
      families: reviewedFamilies,
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
  }
}

interface Fixture {
  root: string
  artifactPath: string
  candidatePath: string
  reportPath: string
  markerPath: string
  evidencePath: string
  appManifestPath: string
  artifactSha256: string
}

async function passingFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-pages-'))
  for (const directory of [
    'src', 'config', 'build/candidate', 'dist', 'audit/generated', 'audit/evidence', 'audit/templates/evidence',
    'data/generated/v3', 'data/generated/app-snapshot',
  ]) await mkdir(join(root, ...directory.split('/')), { recursive: true })
  await writeFile(join(root, 'src/app.ts'), 'export const release = true\n', 'utf8')
  const sourceSnapshot = await createSourceSnapshot(root, sourceRoots)
  await writeJson(join(root, 'audit/generated/connected-source-snapshot.json'), sourceSnapshot)

  const candidatePath = join(root, 'build/candidate/linerecall.html')
  const artifactPath = join(root, 'dist/linerecall.html')
  const html = '<!doctype html><title>LineRecall</title>\n'
  await writeFile(candidatePath, html, 'utf8')
  await writeFile(artifactPath, html, 'utf8')
  const artifactSha256 = await sha256File(artifactPath)
  const candidate = { bytes: Buffer.byteLength(html), sha256: artifactSha256 }

  const appManifestPath = join(root, 'data/generated/app-snapshot/manifest.json')
  await writeJson(appManifestPath, productionAppManifestFixture(releaseId))
  const appManifestSha256 = await sha256File(appManifestPath)
  await writeJson(join(root, 'data/generated/v3/production-data-readiness.json'), readiness(appManifestSha256))

  const keys = generateKeyPairSync('ed25519')
  const keyId = 'fixture-release-key'
  await writeJson(join(root, 'config/release-signing-keys.json'), {
    schemaVersion: 1,
    keys: [{
      keyId,
      algorithm: 'ed25519',
      publicKeySpkiBase64: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      status: 'active',
    }],
  })
  const config = GateConfigSchema.parse({
    schemaVersion: 1,
    candidate: 'build/candidate/linerecall.html',
    artifact: 'dist/linerecall.html',
    marker: 'dist/SHIPPABLE.json',
    report: 'audit/generated/release-gate.json',
    automated: [{ id: 'tests', command: 'npm', args: ['test'] }],
    evidence: [{
      id: 'release-signing',
      path: 'audit/evidence/release-signing.json',
      template: 'audit/templates/evidence/release-signing.json',
      sourceSnapshot: 'audit/generated/connected-source-snapshot.json',
    }],
    releaseBindings: {
      sourceSnapshot: 'audit/generated/connected-source-snapshot.json',
      productionReadiness: 'data/generated/v3/production-data-readiness.json',
      appSnapshotManifest: 'data/generated/app-snapshot/manifest.json',
    },
    signing: {
      evidenceId: 'release-signing',
      trustedKeys: 'config/release-signing-keys.json',
      attestationSourcePath: 'audit/generated/release-signing-attestation.json',
    },
    limitations: ['Engineering evidence is not legal certification.'],
  })
  const configPath = join(root, 'config/release-gates.json')
  await writeJson(configPath, config)
  const requiredChecks = [
    'Exact release inputs are signed with a trusted Ed25519 key',
    'The signature payload binds candidate, source, data, automated, and evidence digests',
  ]
  await writeJson(join(root, 'audit/templates/evidence/release-signing.json'), {
    schemaVersion: 2,
    id: 'release-signing',
    status: 'not_run',
    completedAt: null,
    reviewer: null,
    artifactSha256: null,
    sourceSnapshotSha256: null,
    summary: 'Release signing has not been completed.',
    evidence: [],
    limitations: ['Signing is a hard release blocker.'],
    requiredChecks,
  })
  const automated: GateResult[] = [{ id: 'tests', status: 'pass', summary: 'Passed' }]
  const signingStub: GateResult = {
    id: 'release-signing',
    status: 'pass',
    summary: 'Signed',
    evidencePath: 'audit/evidence/release-signing.json',
    evidenceRecord: { path: 'audit/evidence/release-signing.json', sha256: 'b'.repeat(64) },
    evidenceReceipts: [],
    sourceSnapshot: {
      path: 'audit/generated/connected-source-snapshot.json',
      sha256: await sha256File(join(root, 'audit/generated/connected-source-snapshot.json')),
      treeSha256: sourceSnapshot.treeSha256,
    },
  }
  const unsigned = await loadUnsignedReleaseBindings({
    root,
    configPath: 'config/release-gates.json',
    config,
    automated,
    evidence: [signingStub],
    candidate,
    sourceRoots,
  })
  const payloadBytes = Buffer.from(canonicalJson(unsigned.expectedAttestationPayload), 'utf8')
  const attestationSourcePath = join(root, 'audit/generated/release-signing-attestation.json')
  await writeJson(attestationSourcePath, {
    schemaVersion: 1,
    algorithm: 'ed25519',
    keyId,
    payload: unsigned.expectedAttestationPayload,
    signatureBase64: sign(null, payloadBytes, keys.privateKey).toString('base64'),
  })
  const attestationReceipt = await contentAddressEvidenceFile(
    'audit/generated/release-signing-attestation.json', root, true,
  )
  const evidencePath = join(root, 'audit/evidence/release-signing.json')
  await writeJson(evidencePath, {
    schemaVersion: 2,
    id: 'release-signing',
    status: 'pass',
    completedAt: '2026-07-16T12:00:00.000Z',
    reviewer: 'Fixture signer',
    artifactSha256,
    sourceSnapshotSha256: sourceSnapshot.treeSha256,
    summary: 'Signed release inputs.',
    evidence: [attestationReceipt],
    limitations: [],
    requiredChecks,
    requirementResults: requiredChecks.map((requirement) => ({
      requirement,
      status: 'pass',
      evidencePaths: [attestationReceipt.path],
    })),
  })
  const evidence = [await readEvidence(
    'release-signing',
    'audit/evidence/release-signing.json',
    artifactSha256,
    root,
    'audit/generated/connected-source-snapshot.json',
    sourceRoots,
    'audit/templates/evidence/release-signing.json',
  )]
  assert.equal(evidence[0]!.status, 'pass')
  const bindings = await loadVerifiedReleaseBindings({
    root,
    configPath: 'config/release-gates.json',
    config,
    automated,
    evidence,
    candidate,
    sourceRoots,
  })
  const generatedAt = '2026-07-16T12:00:00.000Z'
  const reportPath = join(root, 'audit/generated/release-gate.json')
  const artifact = { path: 'dist/linerecall.html', ...candidate }
  await writeJson(reportPath, {
    schemaVersion: 2,
    generatedAt,
    status: 'pass',
    shippable: true,
    candidate: { path: 'build/candidate/linerecall.html', ...candidate },
    artifact,
    automated,
    evidence,
    bindings,
    blockers: [],
    limitations: config.limitations,
  })
  const markerPath = join(root, 'dist/SHIPPABLE.json')
  await writeJson(markerPath, {
    schemaVersion: 3,
    shippable: true,
    releaseId,
    auditedAt: generatedAt,
    artifact,
    report: 'audit/generated/release-gate.json',
    reportSha256: await sha256File(reportPath),
    bindings: {
      gateConfigSha256: bindings.gateConfig.sha256,
      sourceSnapshotSha256: bindings.sourceSnapshot.sha256,
      sourceTreeSha256: bindings.sourceSnapshot.treeSha256,
      productionReadinessSha256: bindings.productionReadiness.sha256,
      appSnapshotManifestSha256: bindings.appSnapshotManifest.sha256,
      automatedGateStatusSha256: bindings.automatedGateStatusSha256,
      preSigningEvidenceBundleSha256: bindings.preSigningEvidenceBundleSha256,
      evidenceBundleSha256: bindings.evidenceBundleSha256,
      signingAttestationSha256: bindings.signingAttestation.sha256,
      signingPayloadSha256: bindings.signingAttestation.payloadSha256,
      signingKeyId: bindings.signingAttestation.keyId,
    },
  })
  return { root, artifactPath, candidatePath, reportPath, markerPath, evidencePath, appManifestPath, artifactSha256 }
}

async function verify(fixture: Fixture) {
  return verifyPagesRelease({
    root: fixture.root,
    releaseId,
    sha256: fixture.artifactSha256,
    sourceRoots,
  })
}

test('release verifier binds exact gates, evidence, signature, source, data, candidate, and artifact bytes', async () => {
  const fixture = await passingFixture()
  try {
    assert.deepEqual(await verify(fixture), { releaseId, sha256: fixture.artifactSha256 })
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('release verifier rejects report and configured-gate mutation', async () => {
  const reportFixture = await passingFixture()
  try {
    const report = JSON.parse(await readFile(reportFixture.reportPath, 'utf8')) as Record<string, any>
    report.automated = []
    await writeJson(reportFixture.reportPath, report)
    await assert.rejects(() => verify(reportFixture))
  } finally {
    await rm(reportFixture.root, { recursive: true, force: true })
  }

  const configFixture = await passingFixture()
  try {
    const configPath = join(configFixture.root, 'config/release-gates.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>
    config.automated[0].args = ['run', 'different-command']
    await writeJson(configPath, config)
    await assert.rejects(() => verify(configFixture), /gate configuration|bindings changed/u)
  } finally {
    await rm(configFixture.root, { recursive: true, force: true })
  }
})

test('release verifier rejects configured limitation drift', async () => {
  const fixture = await passingFixture()
  try {
    const report = JSON.parse(await readFile(fixture.reportPath, 'utf8')) as Record<string, any>
    report.limitations = ['Substituted after audit.']
    await writeJson(fixture.reportPath, report)
    await assert.rejects(() => verify(fixture), /limitations do not match/u)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('release verifier rejects candidate, artifact, and operator digest mismatches', async () => {
  const candidateFixture = await passingFixture()
  try {
    await writeFile(candidateFixture.candidatePath, '<!doctype html><title>Changed</title>\n', 'utf8')
    await assert.rejects(() => verify(candidateFixture), /candidate bytes|receipt/u)
  } finally {
    await rm(candidateFixture.root, { recursive: true, force: true })
  }

  const artifactFixture = await passingFixture()
  try {
    await writeFile(artifactFixture.artifactPath, '<!doctype html><title>Changed artifact</title>\n', 'utf8')
    await assert.rejects(() => verify(artifactFixture), /candidate bytes|receipt/u)
  } finally {
    await rm(artifactFixture.root, { recursive: true, force: true })
  }

  const operatorFixture = await passingFixture()
  try {
    await assert.rejects(() => verifyPagesRelease({
      root: operatorFixture.root,
      releaseId,
      sha256: 'f'.repeat(64),
      sourceRoots,
    }), /operator-provided artifact digest/u)
  } finally {
    await rm(operatorFixture.root, { recursive: true, force: true })
  }
})

test('release verifier rejects evidence-record and app-manifest mutation', async () => {
  const evidenceFixture = await passingFixture()
  try {
    const evidence = JSON.parse(await readFile(evidenceFixture.evidencePath, 'utf8')) as Record<string, unknown>
    evidence.summary = 'Mutated after review.'
    await writeJson(evidenceFixture.evidencePath, evidence)
    await assert.rejects(() => verify(evidenceFixture), /binding changed/u)
  } finally {
    await rm(evidenceFixture.root, { recursive: true, force: true })
  }

  const appFixture = await passingFixture()
  try {
    await writeFile(appFixture.appManifestPath, '{}\n', 'utf8')
    await assert.rejects(() => verify(appFixture))
  } finally {
    await rm(appFixture.root, { recursive: true, force: true })
  }
})

test('release verifier rejects source, readiness, receipt, and marker binding mutation', async () => {
  const sourceFixture = await passingFixture()
  try {
    await writeFile(join(sourceFixture.root, 'src/app.ts'), 'export const release = false\n', 'utf8')
    await assert.rejects(() => verify(sourceFixture), /Source snapshot is invalid|bindings changed/u)
  } finally {
    await rm(sourceFixture.root, { recursive: true, force: true })
  }

  const readinessFixture = await passingFixture()
  try {
    const readinessPath = join(readinessFixture.root, 'data/generated/v3/production-data-readiness.json')
    const value = JSON.parse(await readFile(readinessPath, 'utf8')) as Record<string, unknown>
    value.auditedAt = '2026-07-17T12:00:00.000Z'
    await writeJson(readinessPath, value)
    await assert.rejects(
      () => verify(readinessFixture),
      /bindings changed|Signed release attestation does not bind/u,
    )
  } finally {
    await rm(readinessFixture.root, { recursive: true, force: true })
  }

  const receiptFixture = await passingFixture()
  try {
    const evidence = JSON.parse(await readFile(receiptFixture.evidencePath, 'utf8')) as Record<string, any>
    const receiptPath = join(receiptFixture.root, ...String(evidence.evidence[0].path).split('/'))
    await writeFile(receiptPath, '{}\n', 'utf8')
    await assert.rejects(() => verify(receiptFixture), /Evidence no longer passes/u)
  } finally {
    await rm(receiptFixture.root, { recursive: true, force: true })
  }

  const markerFixture = await passingFixture()
  try {
    const marker = JSON.parse(await readFile(markerFixture.markerPath, 'utf8')) as Record<string, any>
    marker.bindings.evidenceBundleSha256 = 'e'.repeat(64)
    await writeJson(markerFixture.markerPath, marker)
    await assert.rejects(() => verify(markerFixture), /does not bind the exact release report inputs/u)
  } finally {
    await rm(markerFixture.root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CompactV31ProductionAuthorizationSchema,
  CompactV31Q2AdaptiveReplayAuthorizationSchema,
  CompactV31ProductionPlanReviewSchema,
  CompactV31ProductionPlanSchema,
  CompactV31ProductionPromotionCandidateSchema,
  assessCompactV31ProductionResources,
  compactV31ProductionConfigurationSha256,
  evaluateCompactV31ProductionReadiness,
} from '../../scripts/data/compact-v31-production-contracts.ts'
import {
  runCompactV31ProductionCohort,
  validateCompactV31ProductionBundle,
  type CompactV31ProductionArchiveAdapter,
  type CompactV31ProductionPassArtifact,
} from '../../scripts/data/compact-v31-production-executor.ts'
import { CompactV31RepeatabilityBindingSchema } from '../../scripts/data/compact-v31-contracts.ts'
import {
  verifyCompactV31EligibleEdgePartitionPair,
  verifyCompactV31ExactMergePartition,
  verifyCompactV31ProductionFileReceipt,
} from '../../scripts/data/compact-v31-production-chain-audit.ts'
import {
  CompactV31FamilyEligibilityIndexSchema,
  assertCompleteFamilyPackInventory,
} from '../../scripts/data/compact-v31-family-eligibility.ts'

const gib = 1024 * 1024 * 1024
const hash = (character: string): string => character.repeat(64).slice(0, 64)
const canonicalBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
const digest = (value: unknown): string => createHash('sha256').update(canonicalBytes(value)).digest('hex')
const file = (path: string, character: string) => ({ path, bytes: 10, sha256: hash(character) })

const limits = {
  minimumAvailableMemoryBytes: 8 * gib,
  maximumWorkerResidentBytes: 6 * gib,
  minimumFreeReserveBytes: 10 * gib,
  archiveConcurrency: 1,
  maximumDeltaBytesPerArchive: 1 * gib,
  maximumPartitionRunBytes: 1 * gib,
  maximumMergeWorkspaceBytes: 4 * gib,
  maximumReceiptBytes: 16 * 1024 * 1024,
  maximumRetainedDeltaBytes: 16 * gib,
  maximumFinalStateBytes: 8 * gib,
  inputStagingBytes: 0,
} as const

function approvedBundle() {
  const binding = CompactV31RepeatabilityBindingSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-repeatability-binding',
    releaseEligible: false,
    firstRunId: 'fixture-run-one',
    secondRunId: 'fixture-run-two',
    firstRunReceiptSha256: hash('1'),
    secondRunReceiptSha256: hash('2'),
    sourceSnapshotSha256: hash('3'),
    configurationSha256: hash('4'),
    benchmarkAuthorizationSha256: hash('a'),
    planReviewSha256: hash('5'),
    candidateMergeSha256: hash('6'),
    exactMergeSha256: hash('7'),
    accountingSha256: hash('8'),
    result: 'byte-identical',
    comparedAt: '2026-08-28T05:00:00.000Z',
    note: 'Fixture-only repeatability proof.',
  })
  const bindingSha256 = digest(binding)
  const authorization = CompactV31ProductionAuthorizationSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-production-authorization',
    storageModel: 'log-structured-external-merge-v3.1',
    proposalCreatedAt: '2026-08-28T05:01:00.000Z',
    proposedBy: 'fixture',
    benchmarkAuthorizationSha256: hash('a'),
    sourceManifests: {
      broadcasts: file('data/manifests/broadcasts.source.json', 'b'),
      standardQ2_2026: file('data/manifests/lichess-standard-q2-2026.source.json', 'c'),
    },
    broadcastTransportIdentity: {
      proposal: file('data/manifests/compact-v31/bootstrap/proposal.json', 'd'),
      observation: file('data/manifests/compact-v31/bootstrap/observation.json', 'e'),
    },
    q2AdaptiveReplayApproval: file('evidence/q2-adaptive-replay.json', 'f'),
    limits,
    limitsSha256: createHash('sha256').update(JSON.stringify(limits)).digest('hex'),
    decision: 'approved',
    reviewedAt: '2026-08-28T05:02:00.000Z',
    reviewedBy: 'fixture-reviewer',
    benchmarkRepeatabilityBinding: { path: 'evidence/repeatability.json', bytes: canonicalBytes(binding).byteLength, sha256: bindingSha256 },
    authorizedCorpora: ['lichess-broadcasts', 'lichess-standard-rated-q2-2026'],
    q2IngestionAuthorized: true,
    productionExecutionAuthorized: true,
    promotionAuthorized: true,
    releaseEligible: false,
    note: 'Fixture-only approved authorization.',
  })
  const authorizationSha256 = digest(authorization)
  const authorizationReceipt = {
    path: 'evidence/production-authorization.json',
    bytes: canonicalBytes(authorization).byteLength,
    sha256: authorizationSha256,
  }
  const archiveRows = [
    { month: '2026-04', bytes: 29_325_351_334, games: 89_962_564, sha256: hash('d') },
    { month: '2026-05', bytes: 29_689_176_290, games: 90_887_615, sha256: hash('e') },
    { month: '2026-06', bytes: 28_241_946_492, games: 86_483_328, sha256: hash('f') },
  ] as const
  const configurationSha256 = compactV31ProductionConfigurationSha256({
    sourceSnapshotSha256: hash('3'),
    productionAuthorizationSha256: authorizationSha256,
    benchmarkRepeatabilityBindingSha256: bindingSha256,
    corpus: 'lichess-standard-rated-q2-2026',
    limits,
  })
  const plans = archiveRows.map((row, archiveOrdinal) => CompactV31ProductionPlanSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-production-archive-plan',
    storageModel: 'log-structured-external-merge-v3.1',
    pipelineVersion: '3.1.0',
    executionPurpose: 'evidence-candidate',
    releaseEligible: false,
    sourceSnapshotSha256: hash('3'),
    configurationSha256,
    productionAuthorizationSha256: authorizationSha256,
    benchmarkRepeatabilityBindingSha256: bindingSha256,
    corpus: 'lichess-standard-rated-q2-2026',
    archive: {
      archiveId: `standard-${row.month}`,
      sourceId: 'lichess-standard-rated-q2-2026',
      sourceManifestSha256: hash('c'),
      licenseSpdxId: 'CC0-1.0',
      cutoff: '2026-06-30',
      month: row.month,
      filename: `lichess_db_standard_rated_${row.month}.pgn.zst`,
      url: `https://database.lichess.org/standard/lichess_db_standard_rated_${row.month}.pgn.zst`,
      compressedBytes: row.bytes,
      sha256: row.sha256,
      retrievedAt: '2026-08-28T05:03:00.000Z',
      etagObserved: `fixture-${row.month}`,
      lastModifiedObserved: 'Thu, 28 Aug 2026 05:03:00 GMT',
    },
    archiveOrdinal,
    corpusArchiveCount: 3,
    limits,
    partitioning: {
      algorithm: 'sha256-prefix', prefixBits: 12,
      keyOrder: 'unsigned-byte-lexicographic', duplicatePolicy: 'merge-identical-key-counters',
    },
    replay: {
      completeBaselineMaxPly: 30, adaptiveEvidenceMaxPly: 100,
      adaptiveCandidateMinimumSample: 100,
      compressedInputReplay: 'from-byte-zero', sourceExpansion: 'stream-only',
    },
  }))
  const review = CompactV31ProductionPlanReviewSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-production-plan-review',
    reviewStatus: 'authorized-execution',
    releaseEligible: false,
    generatedAt: '2026-08-28T05:04:00.000Z',
    corpus: 'lichess-standard-rated-q2-2026',
    sourceSnapshotSha256: hash('3'),
    configurationSha256,
    productionAuthorizationSha256: authorizationSha256,
    benchmarkRepeatabilityBindingSha256: bindingSha256,
    archiveCount: 3,
    plans: plans.map((plan, archiveOrdinal) => ({
      archiveId: plan.archive.archiveId,
      archiveOrdinal,
      path: `${plan.archive.archiveId}.json`,
      bytes: canonicalBytes(plan).byteLength,
      sha256: digest(plan),
    })),
  })
  const reviewSha256 = digest(review)
  const reviewReceipt = {
    path: 'evidence/q2-plan-review.json',
    bytes: canonicalBytes(review).byteLength,
    sha256: reviewSha256,
  }
  return validateCompactV31ProductionBundle({
    authorization,
    authorizationReceipt,
    authorizationSha256,
    repeatabilityBinding: binding,
    repeatabilityBindingSha256: bindingSha256,
    review,
    reviewReceipt,
    reviewSha256,
    plans,
  })
}

test('checked-in production authorization is pending and cannot authorize Q2', async () => {
  const authorization = CompactV31ProductionAuthorizationSchema.parse(JSON.parse(
    await readFile('data/manifests/compact-v31-production.authorization.json', 'utf8'),
  ) as unknown)
  assert.equal(authorization.decision, 'pending')
  assert.equal(authorization.q2IngestionAuthorized, false)
  assert.equal(authorization.productionExecutionAuthorized, false)
  assert.equal(authorization.promotionAuthorized, false)
  assert.equal(authorization.releaseEligible, false)
})

test('adaptive Q2 replay through ply 100 has a separate pending source-bound decision', async () => {
  const approval = CompactV31Q2AdaptiveReplayAuthorizationSchema.parse(JSON.parse(
    await readFile('data/manifests/compact-v31-q2-adaptive-replay.authorization.json', 'utf8'),
  ) as unknown)
  assert.equal(approval.decision, 'pending')
  assert.equal(approval.completeBaselineMaxPly, 30)
  assert.equal(approval.adaptiveEvidenceMaxPly, 100)
  assert.equal(approval.releaseEligible, false)
})

test('production plans cover the canonical three Q2 archives and reject a broadcast identity', () => {
  const bundle = approvedBundle()
  assert.deepEqual(bundle.plans.map(({ archive }) => archive.archiveId), [
    'standard-2026-04', 'standard-2026-05', 'standard-2026-06',
  ])
  assert.throws(() => CompactV31ProductionPlanSchema.parse({
    ...bundle.plans[0],
    archive: { ...bundle.plans[0]!.archive, archiveId: 'broadcast-2020-01' },
  }), /canonical for this corpus/iu)
})

test('a pending production authorization fails before a plan or source can be used', async () => {
  const pending = JSON.parse(await readFile('data/manifests/compact-v31-production.authorization.json', 'utf8')) as unknown
  const fixture = approvedBundle()
  assert.throws(() => validateCompactV31ProductionBundle({
    authorization: pending,
    authorizationReceipt: {
      path: 'evidence/pending-authorization.json',
      bytes: canonicalBytes(pending).byteLength,
      sha256: digest(pending),
    },
    authorizationSha256: digest(pending),
    repeatabilityBinding: fixture.repeatabilityBinding,
    repeatabilityBindingSha256: fixture.repeatabilityBindingSha256,
    review: fixture.review,
    reviewReceipt: fixture.reviewReceipt,
    reviewSha256: fixture.reviewSha256,
    plans: fixture.plans,
  }), /not approved/iu)
})

function adapterFor(
  bundle: ReturnType<typeof approvedBundle>,
  availableMemoryBytes = 10 * gib,
  firstArchiveDeduplicated = 0,
): {
  adapter: CompactV31ProductionArchiveAdapter
  executeCalls: () => number
} {
  let calls = 0
  const games = [89_962_564, 90_887_615, 86_483_328]
  const adapter: CompactV31ProductionArchiveAdapter = {
    async observeResources() {
      return { availableStorageBytes: 100 * gib, retainedDeltaBytes: 0, availableMemoryBytes, workerResidentBytes: 1 * gib }
    },
    async executeArchive({ plan, pass }) {
      calls += 1
      const artifact: CompactV31ProductionPassArtifact = {
        pass,
        planSha256: digest(plan),
        deltaReceipt: file(`v31/${pass}/${plan.archive.archiveId}.json`, pass === 'candidate' ? '1' : '2'),
        compressedInput: { bytes: plan.archive.compressedBytes, sha256: plan.archive.sha256, verified: true },
        accounting: pass === 'candidate'
          ? { recordsSeen: games[plan.archiveOrdinal]!, accepted: games[plan.archiveOrdinal]!, deduplicated: 0, rejected: {} }
          : {
              recordsSeen: games[plan.archiveOrdinal]!,
              accepted: games[plan.archiveOrdinal]! - (plan.archiveOrdinal === 0 ? firstArchiveDeduplicated : 0),
              deduplicated: plan.archiveOrdinal === 0 ? firstArchiveDeduplicated : 0,
              rejected: {},
            },
        resources: {
          sampleCount: 1,
          maximumObservedWorkerResidentBytes: 1 * gib,
          minimumObservedFreeStorageBytes: 20 * gib,
          minimumObservedAvailableMemoryBytes: availableMemoryBytes,
          maximumObservedRetainedDeltaBytes: 1,
        },
        completedAt: '2026-08-28T05:05:00.000Z',
      }
      return artifact
    },
    async merge({ pass }) { return file(`v31/merged/${pass}.json`, pass === 'candidate' ? '3' : '4') },
    async persistArchiveReceipt(receipt) { return file(`v31/receipts/${receipt.archiveId}.json`, String(receipt.archiveOrdinal + 5)) },
    async sourceEdgeInventory() { return file('v31/source-edge-inventory.json', '9') },
  }
  return { adapter, executeCalls: () => calls }
}

test('Q2 cohort orchestration executes both passes, reproduces the published total, and stays release-ineligible', async () => {
  const bundle = approvedBundle()
  const fixture = adapterFor(bundle)
  const result = await runCompactV31ProductionCohort({
    bundle,
    releaseId: 'release_fixture-v31',
    adapter: fixture.adapter,
    now: () => new Date('2026-08-28T05:06:00.000Z'),
  })
  assert.equal(fixture.executeCalls(), 6)
  assert.equal(result.archiveReceipts.length, 3)
  assert.equal(result.receipt.recordsSeen, 267_333_507)
  assert.equal(result.receipt.accountingReconciles, true)
  assert.equal(result.receipt.releaseEligible, false)
})

test('candidate accounting may overcount exact accepted rows only by exact deduplications', async () => {
  const bundle = approvedBundle()
  const result = await runCompactV31ProductionCohort({
    bundle,
    releaseId: 'release_fixture-v31',
    adapter: adapterFor(bundle, 10 * gib, 7).adapter,
    now: () => new Date('2026-08-28T05:06:00.000Z'),
  })
  assert.equal(result.archiveReceipts[0]!.accounting.deduplicated, 7)
  assert.equal(result.receipt.deduplicated, 7)
  assert.equal(result.receipt.recordsSeen, result.receipt.accepted + result.receipt.deduplicated + result.receipt.rejected)
})

test('Q2 orchestration blocks on the 8 GiB preflight before opening a source', async () => {
  const bundle = approvedBundle()
  const fixture = adapterFor(bundle, 8 * gib - 1)
  await assert.rejects(
    runCompactV31ProductionCohort({ bundle, adapter: fixture.adapter, releaseId: 'release_fixture-v31' }),
    /insufficient-memory/iu,
  )
  assert.equal(fixture.executeCalls(), 0)
})

test('candidate preflight is sampled immediately before each archive is opened', async () => {
  const bundle = approvedBundle()
  const fixture = adapterFor(bundle)
  let observations = 0
  let executions = 0
  const adapter: CompactV31ProductionArchiveAdapter = {
    ...fixture.adapter,
    async observeResources(plan) {
      observations += 1
      if (observations === 2) {
        return {
          availableStorageBytes: 100 * gib,
          retainedDeltaBytes: 0,
          availableMemoryBytes: 8 * gib - 1,
          workerResidentBytes: 1 * gib,
        }
      }
      return fixture.adapter.observeResources(plan)
    },
    async executeArchive(input) {
      executions += 1
      return fixture.adapter.executeArchive(input)
    },
  }
  await assert.rejects(
    runCompactV31ProductionCohort({ bundle, adapter, releaseId: 'release_fixture-v31' }),
    /Candidate production preflight blocked.*insufficient-memory/iu,
  )
  assert.equal(executions, 1, 'the first source opens only after its own fresh preflight')
})

test('production resource assessment preserves memory, RSS, and storage gates', () => {
  assert.equal(assessCompactV31ProductionResources(limits, {
    availableStorageBytes: 100 * gib, retainedDeltaBytes: 0, availableMemoryBytes: 8 * gib - 1, workerResidentBytes: 1,
  }).reasonCode, 'insufficient-memory')
  assert.equal(assessCompactV31ProductionResources(limits, {
    availableStorageBytes: 100 * gib, retainedDeltaBytes: 0, availableMemoryBytes: 10 * gib, workerResidentBytes: 6 * gib + 1,
  }).reasonCode, 'worker-rss-cap-exceeded')
  assert.equal(assessCompactV31ProductionResources(limits, {
    availableStorageBytes: 10 * gib - 1, retainedDeltaBytes: 0, availableMemoryBytes: 10 * gib, workerResidentBytes: 1,
  }).reasonCode, 'insufficient-free-space')
})

test('readiness inventory names every missing execution and promotion proof without inventing totals', () => {
  const result = evaluateCompactV31ProductionReadiness({
    authorizationDecision: 'pending',
    exactBootstrapInputsPresent: true,
    benchmarkPlansPresent: true,
    benchmarkRunCount: 0,
    repeatabilityBindingPresent: false,
    productionPlanReviewsPresent: false,
    broadcastCorpusReceiptPresent: false,
    standardQ2CorpusReceiptPresent: false,
    productionCohortOrchestratorImplemented: true,
    productionArchiveAdapterImplemented: false,
    deterministicMergeVerifierImplemented: true,
    productionHandoffImplemented: false,
    productionCandidateUsesAppWireV3: false,
    familyEligibilityInventoryPresent: false,
    q2AdaptivePly100Authorized: false,
    familyPromotionPresent: false,
    stockfishProvisionPresent: true,
    scidProvisionPresent: true,
    puzzleDigestApproved: true,
    puzzlePromotionPresent: false,
    editorialLedgerApproved: false,
    availableMemoryBytes: 1 * gib,
    workerResidentBytes: 100 * 1024 * 1024,
    availableStorageBytes: 100 * gib,
    limits,
  })
  assert.equal(result.status, 'blocked')
  assert.ok(result.blockers.some(({ code }) => code === 'q2-production-receipt-missing'))
  assert.ok(result.blockers.some(({ code }) => code === 'production-archive-adapter-missing'))
  assert.ok(result.blockers.some(({ code }) => code === 'insufficient-available-memory'))
})

test('production promotion wiring cannot be parsed as release eligible', () => {
  const candidate = {
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-production-promotion-candidate',
    storageModel: 'log-structured-external-merge-v3.1',
    status: 'pending-deep-audit',
    releaseEligible: false,
    releaseId: 'release_fixture-v31',
    productionAuthorizationSha256: hash('a'),
    benchmarkRepeatabilityBinding: file('evidence/repeatability.json', 'b'),
    broadcastCorpusReceipt: file('evidence/broadcast.json', 'c'),
    standardQ2CorpusReceipt: file('evidence/q2.json', 'd'),
    familyPromotionIndex: file('evidence/families.json', 'e'),
    engineCampaign: file('evidence/engine.json', 'f'),
    scidCampaign: file('evidence/scid.json', '1'),
    puzzlePromotion: file('evidence/puzzles.json', '2'),
    productionDataReadiness: file('evidence/readiness.json', '3'),
    assembledAt: '2026-08-28T06:00:00.000Z',
  }
  assert.equal(CompactV31ProductionPromotionCandidateSchema.parse(candidate).releaseEligible, false)
  assert.throws(() => CompactV31ProductionPromotionCandidateSchema.parse({
    ...candidate,
    releaseEligible: true,
  }))
})

test('deep-chain binary receipt verification hashes bytes and rejects mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-v31-deep-file-'))
  const path = join(root, 'partition.bin')
  const bytes = Buffer.from('verified production partition')
  await writeFile(path, bytes)
  const receipt = {
    path: 'partition.bin',
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  await verifyCompactV31ProductionFileReceipt(root, receipt)
  await writeFile(path, Buffer.from('mutated production partition'))
  await assert.rejects(verifyCompactV31ProductionFileReceipt(root, receipt), /byte length|SHA-256|identity/iu)
})

test('eligible-edge partitions are recomputed from sorted exact-state NDJSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-v31-edge-derivation-'))
  const exactRows = [
    {
      edgeId: 'edge_0000000000000001', fromEpdSha256: hash('1'), toEpdSha256: hash('2'), uci: 'e2e4', sampleSize: 99,
      cells: [{ ratingSystem: 'broadcast-rating', timeControl: 'classical', ratingBand: '2400+', whiteWins: 50, draws: 20, blackWins: 29, n: 99 }],
    },
    {
      edgeId: 'edge_0000000000000002', fromEpdSha256: hash('3'), toEpdSha256: hash('4'), uci: 'c7c5', sampleSize: 100,
      cells: [{ ratingSystem: 'broadcast-rating', timeControl: 'classical', ratingBand: '2400+', whiteWins: 50, draws: 20, blackWins: 30, n: 100 }],
    },
  ]
  const exactBytes = Buffer.from(exactRows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const eligibleBytes = Buffer.from(`${JSON.stringify(exactRows[1])}\n`)
  await writeFile(join(root, 'exact.ndjson'), exactBytes)
  await writeFile(join(root, 'eligible.ndjson'), eligibleBytes)
  const exactReceipt = {
    path: 'exact.ndjson', bytes: exactBytes.byteLength,
    sha256: createHash('sha256').update(exactBytes).digest('hex'),
  }
  const eligibleReceipt = {
    path: 'eligible.ndjson', bytes: eligibleBytes.byteLength,
    sha256: createHash('sha256').update(eligibleBytes).digest('hex'),
  }
  const pair = {
    exactStatePartitionSha256: exactReceipt.sha256,
    exactStateFirstEdgeId: exactRows[0]!.edgeId,
    exactStateLastEdgeId: exactRows[1]!.edgeId,
    eligibleEdges: eligibleReceipt,
    eligibleEdgeCount: 1,
    eligibleFirstEdgeId: exactRows[1]!.edgeId,
    eligibleLastEdgeId: exactRows[1]!.edgeId,
  }
  assert.equal(await verifyCompactV31EligibleEdgePartitionPair({ root, exactReceipt, pair, minimumSampleSize: 100 }), 1)
  await writeFile(join(root, 'eligible.ndjson'), Buffer.from(`${JSON.stringify(exactRows[0])}\n`))
  await assert.rejects(
    verifyCompactV31EligibleEdgePartitionPair({ root, exactReceipt, pair, minimumSampleSize: 100 }),
    /derivation|byte length|SHA-256|identity/iu,
  )
})

test('exact merge verification recomputes evidence cells and rejects fabricated merged bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-v31-exact-merge-'))
  const base = { edgeId: 'edge_00000000000000aa', fromEpdSha256: hash('a'), toEpdSha256: hash('b'), uci: 'e2e4' }
  const first = { ...base, sampleSize: 60, cells: [{ ratingSystem: 'broadcast-rating', timeControl: 'classical', ratingBand: '2400+', whiteWins: 30, draws: 10, blackWins: 20, n: 60 }] }
  const second = { ...base, sampleSize: 50, cells: [{ ratingSystem: 'broadcast-rating', timeControl: 'classical', ratingBand: '2400+', whiteWins: 20, draws: 10, blackWins: 20, n: 50 }] }
  const merged = { ...base, sampleSize: 110, cells: [{ ratingSystem: 'broadcast-rating', timeControl: 'classical', ratingBand: '2400+', whiteWins: 50, draws: 20, blackWins: 40, n: 110 }] }
  const receiptFor = async (name: string, rows: unknown[]) => {
    const bytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    await writeFile(join(root, name), bytes)
    return { path: name, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  const deltaPartitions = [await receiptFor('delta-one.ndjson', [first]), await receiptFor('delta-two.ndjson', [second])]
  const mergedPartition = await receiptFor('merged.ndjson', [merged])
  assert.deepEqual(await verifyCompactV31ExactMergePartition({ root, deltaPartitions, mergedPartition }), {
    inputRows: 2, outputRows: 1, duplicateRowsMerged: 1,
  })
  const fabricated = await receiptFor('fabricated.ndjson', [{ ...merged, sampleSize: 111, cells: [{ ...merged.cells[0], whiteWins: 51, n: 111 }] }])
  await assert.rejects(
    verifyCompactV31ExactMergePartition({ root, deltaPartitions, mergedPartition: fabricated }),
    /differs from deterministic delta merge/iu,
  )
})

test('exact-state family inventory supports more than 128 packs and requires Sicilian/Ruy completeness', () => {
  const bindings = [
    {
      corpus: 'lichess-broadcasts' as const,
      corpusReceiptSha256: hash('1'), sourceManifestSha256: hash('2'),
      exactMergeReceiptSha256: hash('3'), sourceEdgeInventorySha256: hash('4'),
    },
    {
      corpus: 'lichess-standard-rated-q2-2026' as const,
      corpusReceiptSha256: hash('5'), sourceManifestSha256: hash('6'),
      exactMergeReceiptSha256: hash('7'), sourceEdgeInventorySha256: hash('8'),
    },
  ] as const
  const named = ['caro-kann', 'sicilian-defence', 'ruy-lopez']
  const roots = Array.from({ length: 129 }, (_, index) => {
    const familyId = named[index] ?? `fixture-family-${index}`
    return {
      familyId,
      side: 'black' as const,
      packId: `pack_${String(index).padStart(3, '0')}`,
      eligibleEdgeCount: 1,
      edgeInventory: {
        path: `eligibility/${String(index).padStart(3, '0')}.json`,
        bytes: 10,
        sha256: index.toString(16).padStart(64, '0'),
      },
    }
  })
  const dispositionFamilies = Array.from({ length: 149 }, (_, index) => named[index] ?? `fixture-family-${index}`)
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
  const familyDispositions = dispositionFamilies.flatMap((familyId) => (['white', 'black'] as const).map((side) => ({
    familyId,
    side,
    taxonomyLineIds: [`tax_${digest(`${familyId}:${side}`).slice(0, 24)}`],
    readiness: 'study-only' as const,
    reason: 'no-root' as const,
    rootEpd: null,
  })))
  const index = CompactV31FamilyEligibilityIndexSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-family-eligibility-index',
    releaseEligible: false,
    releaseId: 'release_fixture-v31',
    corpusBindings: bindings,
    taxonomyInventorySha256: digest('taxonomy-inventory'),
    editorialLedgerSha256: digest('editorial-ledger'),
    proposedFamilyCount: 149,
    familyCount: 149,
    familyDispositions,
    roots,
    completedAt: '2026-08-28T06:00:00.000Z',
  })
  assert.equal(assertCompleteFamilyPackInventory({ index, emittedPacks: roots }).packCount, 129)
  assert.throws(() => assertCompleteFamilyPackInventory({ index, emittedPacks: roots.slice(0, 128) }), /1 missing/iu)
  assert.ok(index.roots.some(({ familyId }) => familyId === 'sicilian-defence'))
  assert.ok(index.roots.some(({ familyId }) => familyId === 'ruy-lopez'))
})

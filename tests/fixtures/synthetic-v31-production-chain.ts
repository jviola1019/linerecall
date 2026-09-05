import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { compactV31ProductionConfigurationSha256 } from '../../scripts/data/compact-v31-production-contracts.ts'

type IdentityReceipt = {
  path: string
  sha256: string
  bytes: number
  uncompressedBytes: number
  encoding: 'identity'
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const file = ({ path, bytes, sha256 }: IdentityReceipt) => ({ path, bytes, sha256 })
const completedAt = '2026-07-28T12:00:00.000Z'
const gib = 1024 * 1024 * 1024
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

async function writeJson(root: string, path: string, value: unknown): Promise<IdentityReceipt> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), bytes, { flag: 'wx' })
  return {
    path, bytes: bytes.byteLength, uncompressedBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'identity',
  }
}

async function writeNdjson(root: string, path: string, rows: readonly unknown[]): Promise<IdentityReceipt> {
  const bytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), bytes, { flag: 'wx' })
  return {
    path,
    bytes: bytes.byteLength,
    uncompressedBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    encoding: 'identity',
  }
}

function resourceSummary() {
  return {
    sampleCount: 1,
    maximumObservedWorkerResidentBytes: 512 * 1024 * 1024,
    minimumObservedFreeStorageBytes: 20 * gib,
    minimumObservedAvailableMemoryBytes: 9 * gib,
    maximumObservedRetainedDeltaBytes: 1024,
  }
}

export async function createSyntheticV31ProductionChains(root: string): Promise<{
  sourceManifests: { broadcasts: IdentityReceipt; standardQ2_2026: IdentityReceipt }
  compactV31Corpora: { broadcasts: IdentityReceipt; standardQ2_2026: IdentityReceipt }
  broadcastExactMergeSha256: string
  q2ExactMergeSha256: string
  broadcastSourceEdgeInventorySha256: string
  q2SourceEdgeInventorySha256: string
}> {
  const broadcastSourceValue = JSON.parse(await readFile(join(process.cwd(), 'data/manifests/broadcasts.source.json'), 'utf8')) as {
    archives: Array<{ month: string; filename: string; url: string; sha256: string }>
    [key: string]: unknown
  }
  const q2SourceValue = JSON.parse(await readFile(join(process.cwd(), 'data/manifests/lichess-standard-q2-2026.source.json'), 'utf8')) as {
    archives: Array<{ month: string; filename: string; url: string; sha256: string; bytes: number; games: number; etagObserved: string; lastModifiedObserved: string }>
    [key: string]: unknown
  }
  const sourceManifests = {
    broadcasts: await writeJson(root, 'v31/sources/broadcasts.source.json', broadcastSourceValue),
    standardQ2_2026: await writeJson(root, 'v31/sources/standard-q2.source.json', q2SourceValue),
  }
  const observedAt = '2026-07-28T10:00:00.000Z'
  const observedArchives = broadcastSourceValue.archives.map((archive, archiveOrdinal) => ({
    archiveId: `broadcast-${archive.month}`,
    month: archive.month,
    filename: archive.filename,
    approvedUrl: archive.url,
    approvedSha256: archive.sha256,
    observation: {
      method: 'HEAD', requestedUrl: archive.url, finalUrl: archive.url, redirectCount: 0,
      contentLength: 1_000 + archiveOrdinal,
      etagObserved: `"fixture-${archiveOrdinal}"`,
      lastModifiedObserved: 'Tue, 28 Jul 2026 10:00:00 GMT', retrievedAt: observedAt,
    },
    localVerification: {
      status: 'verified', filename: archive.filename, bytes: 1_000 + archiveOrdinal, sha256: archive.sha256,
    },
  }))
  const observation = await writeJson(root, 'v31/auth/broadcast-observation.json', {
    schemaVersion: 1, kind: 'linerecall-broadcast-metadata-observation', reviewStatus: 'pending', releaseEligible: false,
    sourceId: 'lichess-broadcasts', sourceManifestSha256: sourceManifests.broadcasts.sha256,
    sourceSnapshotSha256: hash('fixture-observation-snapshot'), observedAt,
    policy: {
      method: 'HEAD', concurrency: 1, requestTimeoutMs: 30_000, maximumRedirects: 3,
      maximumResponseHeaderBytes: 16_384, maximumArchiveBytes: 8 * gib,
      redirectHostPolicy: 'same-approved-host-https-default-port', networkDateHeaderRetained: false,
    },
    archiveCount: 78, archives: observedArchives,
    note: 'Pending metadata observation only. It does not amend the approved manifest or authorize ingestion.',
  })
  const proposal = await writeJson(root, 'v31/auth/broadcast-proposal.json', {
    ...broadcastSourceValue,
    approval: {
      status: 'pending', approvedOn: null, scope: 'Synthetic fixture only.', basis: 'Synthetic fixture only.',
      reviewRequiredWhen: 'Always; this fixture is never production evidence.',
    },
    metadataObservation: {
      schemaVersion: 1, kind: 'linerecall-broadcast-metadata-observation-ref', receiptSha256: observation.sha256,
      sourceManifestSha256: sourceManifests.broadcasts.sha256,
      sourceSnapshotSha256: hash('fixture-observation-snapshot'), observedAt, archiveCount: 78, localArchivesVerified: true,
    },
    archives: broadcastSourceValue.archives.map((archive, archiveOrdinal) => ({
      ...archive,
      bytes: 1_000 + archiveOrdinal,
      etagObserved: `"fixture-${archiveOrdinal}"`,
      lastModifiedObserved: 'Tue, 28 Jul 2026 10:00:00 GMT',
    })),
  })
  const q2Adaptive = await writeJson(root, 'v31/auth/q2-adaptive.json', {
    schemaVersion: 1, kind: 'linerecall-compact-v31-q2-adaptive-replay-authorization',
    sourceManifest: file(sourceManifests.standardQ2_2026), completeBaselineMaxPly: 30,
    adaptiveEvidenceMaxPly: 100, adaptiveCandidateMinimumSample: 100, releaseEligible: false,
    note: 'Synthetic fixture approval; never production evidence.', decision: 'approved', reviewedAt: completedAt,
    reviewedBy: 'synthetic-fixture-reviewer',
  })
  const repeatability = await writeJson(root, 'v31/auth/repeatability.json', {
    schemaVersion: 1, kind: 'linerecall-compact-v31-repeatability-binding', releaseEligible: false,
    firstRunId: 'fixture-run-one', secondRunId: 'fixture-run-two', firstRunReceiptSha256: hash('run-one'),
    secondRunReceiptSha256: hash('run-two'), sourceSnapshotSha256: hash('fixture-source-snapshot'),
    configurationSha256: hash('fixture-benchmark-configuration'), benchmarkAuthorizationSha256: hash('fixture-benchmark-authorization'),
    planReviewSha256: hash('fixture-benchmark-review'), candidateMergeSha256: hash('fixture-benchmark-candidate'),
    exactMergeSha256: hash('fixture-benchmark-exact'), accountingSha256: hash('fixture-benchmark-accounting'),
    result: 'byte-identical', comparedAt: completedAt, note: 'Synthetic fixture only.',
  })
  const authorizationValue = {
    schemaVersion: 1, kind: 'linerecall-compact-v31-production-authorization', storageModel: 'log-structured-external-merge-v3.1',
    proposalCreatedAt: completedAt, proposedBy: 'synthetic-fixture', benchmarkAuthorizationSha256: hash('fixture-benchmark-authorization'),
    sourceManifests: { broadcasts: file(sourceManifests.broadcasts), standardQ2_2026: file(sourceManifests.standardQ2_2026) },
    broadcastTransportIdentity: { proposal: file(proposal), observation: file(observation) },
    q2AdaptiveReplayApproval: file(q2Adaptive), limits,
    limitsSha256: createHash('sha256').update(JSON.stringify(limits)).digest('hex'), decision: 'approved',
    reviewedAt: completedAt, reviewedBy: 'synthetic-fixture-reviewer', benchmarkRepeatabilityBinding: file(repeatability),
    authorizedCorpora: ['lichess-broadcasts', 'lichess-standard-rated-q2-2026'], q2IngestionAuthorized: true,
    productionExecutionAuthorized: true, promotionAuthorized: true, releaseEligible: false,
    note: 'Synthetic fixture authorization; never production evidence.',
  }
  const authorization = await writeJson(root, 'v31/auth/production-authorization.json', authorizationValue)

  async function corpusChain(options: {
    corpus: 'lichess-broadcasts' | 'lichess-standard-rated-q2-2026'
    source: IdentityReceipt
    archives: Array<{ month: string; filename: string; url: string; sha256: string; bytes: number; games: number; etagObserved: string; lastModifiedObserved: string; retrievedAt: string }>
    accepted: number
    rejected: number
    ratingSystem: 'broadcast-rating' | 'lichess-glicko2'
  }) {
    const configurationSha256 = compactV31ProductionConfigurationSha256({
      sourceSnapshotSha256: hash('fixture-source-snapshot'), productionAuthorizationSha256: authorization.sha256,
      benchmarkRepeatabilityBindingSha256: repeatability.sha256, corpus: options.corpus, limits,
    })
    const plans = options.archives.map((archive, archiveOrdinal) => ({
      schemaVersion: 1, kind: 'linerecall-compact-v31-production-archive-plan', storageModel: 'log-structured-external-merge-v3.1',
      pipelineVersion: '3.1.0', executionPurpose: 'evidence-candidate', releaseEligible: false,
      sourceSnapshotSha256: hash('fixture-source-snapshot'), configurationSha256,
      productionAuthorizationSha256: authorization.sha256, benchmarkRepeatabilityBindingSha256: repeatability.sha256,
      corpus: options.corpus,
      archive: {
        archiveId: options.corpus === 'lichess-broadcasts' ? `broadcast-${archive.month}` : `standard-${archive.month}`,
        sourceId: options.corpus, sourceManifestSha256: options.source.sha256,
        licenseSpdxId: options.corpus === 'lichess-broadcasts' ? 'CC-BY-SA-4.0' : 'CC0-1.0', cutoff: '2026-06-30',
        month: archive.month, filename: archive.filename, url: archive.url, compressedBytes: archive.bytes,
        sha256: archive.sha256, retrievedAt: archive.retrievedAt, etagObserved: archive.etagObserved,
        lastModifiedObserved: archive.lastModifiedObserved,
      },
      archiveOrdinal, corpusArchiveCount: options.archives.length,
      limits,
      partitioning: { algorithm: 'sha256-prefix', prefixBits: 12, keyOrder: 'unsigned-byte-lexicographic', duplicatePolicy: 'merge-identical-key-counters' },
      replay: { completeBaselineMaxPly: 30, adaptiveEvidenceMaxPly: 100, adaptiveCandidateMinimumSample: 100, compressedInputReplay: 'from-byte-zero', sourceExpansion: 'stream-only' },
    }))
    const planReceipts: IdentityReceipt[] = []
    for (const [index, plan] of plans.entries()) planReceipts.push(await writeJson(root, `v31/${options.corpus}/plans/${String(index).padStart(2, '0')}.json`, plan))
    const review = await writeJson(root, `v31/${options.corpus}/plan-review.json`, {
      schemaVersion: 1, kind: 'linerecall-compact-v31-production-plan-review', reviewStatus: 'authorized-execution', releaseEligible: false,
      generatedAt: completedAt, corpus: options.corpus, sourceSnapshotSha256: hash('fixture-source-snapshot'), configurationSha256,
      productionAuthorizationSha256: authorization.sha256, benchmarkRepeatabilityBindingSha256: repeatability.sha256,
      archiveCount: options.archives.length,
      plans: planReceipts.map((receipt, archiveOrdinal) => ({
        archiveId: plans[archiveOrdinal]!.archive.archiveId, archiveOrdinal, ...file(receipt),
      })),
    })
    const edgeBase = {
      edgeId: `edge_${hash(options.corpus).slice(0, 16)}`,
      fromEpdSha256: hash(`${options.corpus}:from`), toEpdSha256: hash(`${options.corpus}:to`), uci: 'e2e4',
    }
    const candidateDeltaReceipts: IdentityReceipt[] = []
    const exactDeltaReceipts: IdentityReceipt[] = []
    const archiveReceipts: IdentityReceipt[] = []
    let previousCandidate: string | null = null
    let previousExact: string | null = null
    let acceptedRemaining = options.accepted
    let rejectedRemaining = options.rejected
    let mergedWhite = 0
    let mergedDraws = 0
    let mergedBlack = 0
    for (const [archiveOrdinal, archive] of options.archives.entries()) {
      const archivesLeft = options.archives.length - archiveOrdinal
      const accepted = archiveOrdinal === options.archives.length - 1 ? acceptedRemaining : Math.floor(acceptedRemaining / archivesLeft)
      const rejected = archiveOrdinal === options.archives.length - 1 ? rejectedRemaining : Math.floor(rejectedRemaining / archivesLeft)
      acceptedRemaining -= accepted
      rejectedRemaining -= rejected
      const n = options.corpus === 'lichess-broadcasts' ? 10 : 50
      const whiteWins = Math.floor(n / 2)
      const draws = Math.floor(n / 5)
      const blackWins = n - whiteWins - draws
      mergedWhite += whiteWins; mergedDraws += draws; mergedBlack += blackWins
      const row = {
        ...edgeBase, sampleSize: n,
        cells: [{ ratingSystem: options.ratingSystem, timeControl: 'classical', ratingBand: '2400+', whiteWins, draws, blackWins, n }],
      }
      const candidatePartition = await writeNdjson(root, `v31/${options.corpus}/candidate/${archiveOrdinal}.ndjson`, [row])
      const exactPartition = await writeNdjson(root, `v31/${options.corpus}/exact/${archiveOrdinal}.ndjson`, [row])
      const accounting = { recordsSeen: accepted + rejected, accepted, deduplicated: 0, rejected: rejected === 0 ? {} : { fixture_filter: rejected } }
      const candidateDelta = await writeJson(root, `v31/${options.corpus}/candidate/${archiveOrdinal}.receipt.json`, {
        schemaVersion: 1, kind: 'linerecall-compact-v31-production-delta', storageModel: 'log-structured-external-merge-v3.1',
        pipelineVersion: '3.1.0', executionPurpose: 'evidence-candidate', releaseEligible: false, corpus: options.corpus, pass: 'candidate',
        productionAuthorizationSha256: authorization.sha256, sourceManifestSha256: options.source.sha256,
        planSha256: planReceipts[archiveOrdinal]!.sha256, archiveOrdinal, archiveId: plans[archiveOrdinal]!.archive.archiveId,
        previousDeltaReceiptSha256: previousCandidate,
        compressedInput: { bytes: archive.bytes, sha256: archive.sha256, verified: true }, accounting,
        outputPartitions: [{ partition: '00', ...file(candidatePartition) }], resources: resourceSummary(), completedAt,
      })
      const exactDelta = await writeJson(root, `v31/${options.corpus}/exact/${archiveOrdinal}.receipt.json`, {
        schemaVersion: 1, kind: 'linerecall-compact-v31-production-delta', storageModel: 'log-structured-external-merge-v3.1',
        pipelineVersion: '3.1.0', executionPurpose: 'evidence-candidate', releaseEligible: false, corpus: options.corpus, pass: 'exact',
        productionAuthorizationSha256: authorization.sha256, sourceManifestSha256: options.source.sha256,
        planSha256: planReceipts[archiveOrdinal]!.sha256, archiveOrdinal, archiveId: plans[archiveOrdinal]!.archive.archiveId,
        previousDeltaReceiptSha256: previousExact,
        compressedInput: { bytes: archive.bytes, sha256: archive.sha256, verified: true }, accounting,
        outputPartitions: [{ partition: '00', ...file(exactPartition) }], resources: resourceSummary(), completedAt,
      })
      previousCandidate = candidateDelta.sha256
      previousExact = exactDelta.sha256
      candidateDeltaReceipts.push(candidateDelta)
      exactDeltaReceipts.push(exactDelta)
      archiveReceipts.push(await writeJson(root, `v31/${options.corpus}/archives/${archiveOrdinal}.json`, {
        schemaVersion: 1, kind: 'linerecall-compact-v31-production-archive', storageModel: 'log-structured-external-merge-v3.1',
        pipelineVersion: '3.1.0', executionPurpose: 'evidence-candidate', releaseEligible: false, corpus: options.corpus,
        productionAuthorizationSha256: authorization.sha256, sourceManifestSha256: options.source.sha256,
        archiveOrdinal, archiveId: plans[archiveOrdinal]!.archive.archiveId, planSha256: planReceipts[archiveOrdinal]!.sha256,
        candidateDeltaReceipt: file(candidateDelta), exactDeltaReceipt: file(exactDelta),
        compressedInput: { bytes: archive.bytes, sha256: archive.sha256, verified: true }, accounting,
        resources: resourceSummary(), completedAt,
      }))
    }
    const mergedN = mergedWhite + mergedDraws + mergedBlack
    const mergedRow = {
      ...edgeBase, sampleSize: mergedN,
      cells: [{ ratingSystem: options.ratingSystem, timeControl: 'classical', ratingBand: '2400+', whiteWins: mergedWhite, draws: mergedDraws, blackWins: mergedBlack, n: mergedN }],
    }
    const candidatePartition = await writeNdjson(root, `v31/${options.corpus}/merged/candidate.ndjson`, [mergedRow])
    const exactPartition = await writeNdjson(root, `v31/${options.corpus}/merged/exact.ndjson`, [mergedRow])
    const mergeValue = (pass: 'candidate' | 'exact', partition: IdentityReceipt, inputs: IdentityReceipt[]) => ({
      schemaVersion: 1, kind: 'linerecall-compact-v31-production-merge', storageModel: 'log-structured-external-merge-v3.1',
      pipelineVersion: '3.1.0', executionPurpose: 'evidence-candidate', releaseEligible: false, corpus: options.corpus, pass,
      productionAuthorizationSha256: authorization.sha256, sourceManifestSha256: options.source.sha256,
      inputDeltaReceipts: inputs.map(file), outputPartitions: [{ partition: '00', ...file(partition) }],
      inputRows: options.archives.length, outputRows: 1, duplicateRowsMerged: options.archives.length - 1,
      resources: resourceSummary(), completedAt,
    })
    const candidateMerge = await writeJson(root, `v31/${options.corpus}/merged/candidate.receipt.json`, mergeValue('candidate', candidatePartition, candidateDeltaReceipts))
    const exactMerge = await writeJson(root, `v31/${options.corpus}/merged/exact.receipt.json`, mergeValue('exact', exactPartition, exactDeltaReceipts))
    const eligible = await writeNdjson(root, `v31/${options.corpus}/eligible/00.ndjson`, [mergedRow])
    const edgeInventory = await writeJson(root, `v31/${options.corpus}/eligible/inventory.json`, {
      schemaVersion: 1, kind: 'linerecall-compact-v31-production-source-edge-inventory', releaseEligible: false,
      releaseId: 'synthetic-handoff-release-not-for-shipping',
      corpus: options.corpus, productionAuthorizationSha256: authorization.sha256, sourceManifestSha256: options.source.sha256,
      exactMergeReceiptSha256: exactMerge.sha256, minimumSampleSize: 100,
      eligibleEdgePartitions: [{
        partition: '00', exactStatePartitionSha256: exactPartition.sha256,
        exactStateFirstEdgeId: edgeBase.edgeId, exactStateLastEdgeId: edgeBase.edgeId,
        eligibleEdges: file(eligible), eligibleEdgeCount: 1,
        eligibleFirstEdgeId: edgeBase.edgeId, eligibleLastEdgeId: edgeBase.edgeId,
      }],
      eligibleSourceEdges: 1, emittedEligibleSourceEdges: 1, omittedEligibleSourceEdges: 0, completedAt,
    })
    const corpusReceipt = await writeJson(root, `v31/${options.corpus}/corpus.json`, {
      schemaVersion: 1, kind: 'linerecall-compact-v31-production-corpus', storageModel: 'log-structured-external-merge-v3.1',
      pipelineVersion: '3.1.0', executionPurpose: 'evidence-candidate', releaseEligible: false,
      releaseId: 'synthetic-handoff-release-not-for-shipping', corpus: options.corpus,
      productionAuthorization: file(authorization), sourceManifest: file(options.source), benchmarkRepeatabilityBinding: file(repeatability),
      planReview: file(review), archiveReceipts: archiveReceipts.map(file), candidateMergeReceipt: file(candidateMerge),
      exactMergeReceipt: file(exactMerge), sourceArchiveCount: options.archives.length,
      recordsSeen: options.accepted + options.rejected, accepted: options.accepted, deduplicated: 0, rejected: options.rejected,
      allArchiveDigestsVerified: true, exactSecondPassComplete: true, accountingReconciles: true,
      sourceEdgeInventory: file(edgeInventory), resourceLimitsRespected: true, completedAt,
    })
    return { corpusReceipt, exactMerge, edgeInventory }
  }

  const broadcastArchives = broadcastSourceValue.archives.map((archive, index) => ({
    ...archive, bytes: 1_000 + index, games: 0, etagObserved: `"fixture-${index}"`,
    lastModifiedObserved: 'Tue, 28 Jul 2026 10:00:00 GMT', retrievedAt: observedAt,
  }))
  const q2Archives = q2SourceValue.archives.map((archive) => ({ ...archive, retrievedAt: completedAt }))
  const broadcast = await corpusChain({
    corpus: 'lichess-broadcasts', source: sourceManifests.broadcasts, archives: broadcastArchives,
    accepted: 800_176, rejected: 346_121, ratingSystem: 'broadcast-rating',
  })
  const q2 = await corpusChain({
    corpus: 'lichess-standard-rated-q2-2026', source: sourceManifests.standardQ2_2026, archives: q2Archives,
    accepted: 200_000_000, rejected: 67_333_507, ratingSystem: 'lichess-glicko2',
  })
  return {
    sourceManifests,
    compactV31Corpora: { broadcasts: broadcast.corpusReceipt, standardQ2_2026: q2.corpusReceipt },
    broadcastExactMergeSha256: broadcast.exactMerge.sha256,
    q2ExactMergeSha256: q2.exactMerge.sha256,
    broadcastSourceEdgeInventorySha256: broadcast.edgeInventory.sha256,
    q2SourceEdgeInventorySha256: q2.edgeInventory.sha256,
  }
}

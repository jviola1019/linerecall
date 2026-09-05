import { z } from 'zod'
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { assertBroadcastManifest, assertBroadcastManifestApproved, type BroadcastManifestV1 } from './broadcast-contracts.ts'
import { LichessStandardManifestSchema } from './evidence-contracts.ts'
import { PendingBroadcastMetadataInventorySchema } from './observe-broadcast-metadata.ts'
import { CompactV31FileReceiptSchema, CompactV31RepeatabilityBindingSchema } from './compact-v31-contracts.ts'
import {
  CompactV31ProductionArchiveReceiptSchema,
  CompactV31ProductionAuthorizationSchema,
  CompactV31ProductionCorpusReceiptSchema,
  CompactV31ProductionDeltaReceiptSchema,
  CompactV31ProductionEligibleEdgeRowSchema,
  CompactV31ProductionExactEdgeRowSchema,
  CompactV31ProductionMergeReceiptSchema,
  CompactV31ProductionPlanReviewSchema,
  CompactV31ProductionPlanSchema,
  CompactV31ProductionSourceEdgeInventorySchema,
  CompactV31Q2AdaptiveReplayAuthorizationSchema,
  compactV31ProductionConfigurationSha256,
  type CompactV31ProductionCorpusReceipt,
} from './compact-v31-production-contracts.ts'
import {
  readImmutableJsonReceipt,
  resolveReceiptRoot,
  resolveSafeReceiptPath,
} from '../release/lib/immutable-json-receipt.ts'

type FileReceipt = z.infer<typeof CompactV31FileReceiptSchema>
type ExactEdgeRow = z.infer<typeof CompactV31ProductionExactEdgeRowSchema>
const MAXIMUM_CONTROL_BYTES = 64 * 1024 * 1024
const MAXIMUM_NDJSON_LINE_BYTES = 4096
const STREAM_CHUNK_BYTES = 64 * 1024

async function readReceipt(root: string, receipt: FileReceipt): Promise<unknown> {
  const core = { path: receipt.path, bytes: receipt.bytes, sha256: receipt.sha256 }
  return (await readImmutableJsonReceipt({
    root,
    receipt: {
      ...core,
      uncompressedBytes: core.bytes,
      encoding: 'identity',
    },
    maximumStoredBytes: MAXIMUM_CONTROL_BYTES,
    maximumDecodedBytes: MAXIMUM_CONTROL_BYTES,
  })).value
}

export async function verifyCompactV31ProductionFileReceipt(root: string, receipt: FileReceipt): Promise<void> {
  const rootReal = await resolveReceiptRoot(root)
  const path = await resolveSafeReceiptPath(rootReal, receipt.path)
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size !== receipt.bytes) throw new Error(`File receipt byte length differs: ${receipt.path}`)
    const digest = createHash('sha256')
    const chunk = Buffer.alloc(Math.min(1024 * 1024, receipt.bytes))
    let offset = 0
    while (offset < receipt.bytes) {
      const requested = Math.min(chunk.byteLength, receipt.bytes - offset)
      const { bytesRead } = await handle.read(chunk, 0, requested, offset)
      if (bytesRead < 1) throw new Error(`File receipt changed while read: ${receipt.path}`)
      digest.update(chunk.subarray(0, bytesRead))
      offset += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || digest.digest('hex') !== receipt.sha256) {
      throw new Error(`File receipt SHA-256 or identity differs: ${receipt.path}`)
    }
  } finally {
    await handle.close()
  }
}

function sameReceipt(left: FileReceipt, right: FileReceipt): boolean {
  return left.path === right.path && left.bytes === right.bytes && left.sha256 === right.sha256
}

function rejectedTotal(rejected: Record<string, number>): number {
  return Object.values(rejected).reduce((sum, count) => sum + count, 0)
}

function sameAccounting(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameEdge(left: ExactEdgeRow, right: ExactEdgeRow): boolean {
  return left.edgeId === right.edgeId && left.fromEpdSha256 === right.fromEpdSha256 &&
    left.toEpdSha256 === right.toEpdSha256 && left.uci === right.uci && left.sampleSize === right.sampleSize &&
    JSON.stringify(left.cells) === JSON.stringify(right.cells)
}

function cellKey(cell: ExactEdgeRow['cells'][number]): string {
  return `${cell.ratingSystem}:${cell.timeControl}:${cell.ratingBand}`
}

function safeSum(left: number, right: number, label: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe integer range`)
  return result
}

async function* readEdgeRows(
  root: string,
  receipt: FileReceipt,
  eligibleOnly: boolean,
): AsyncGenerator<ExactEdgeRow> {
  const rootReal = await resolveReceiptRoot(root)
  const path = await resolveSafeReceiptPath(rootReal, receipt.path)
  const handle = await open(path, 'r')
  const digest = createHash('sha256')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunk = Buffer.alloc(STREAM_CHUNK_BYTES)
  let carry = ''
  let offset = 0
  let previousEdgeId: string | null = null
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size !== receipt.bytes) throw new Error(`NDJSON receipt byte length differs: ${receipt.path}`)
    while (offset < receipt.bytes) {
      const requested = Math.min(chunk.byteLength, receipt.bytes - offset)
      const { bytesRead } = await handle.read(chunk, 0, requested, offset)
      if (bytesRead < 1) throw new Error(`NDJSON receipt changed while read: ${receipt.path}`)
      const bytes = chunk.subarray(0, bytesRead)
      digest.update(bytes)
      carry += decoder.decode(bytes, { stream: true })
      offset += bytesRead
      while (true) {
        const newline = carry.indexOf('\n')
        if (newline < 0) break
        const line = carry.slice(0, newline)
        carry = carry.slice(newline + 1)
        if (Buffer.byteLength(line, 'utf8') > MAXIMUM_NDJSON_LINE_BYTES || line.length === 0 || line.includes('\r')) {
          throw new Error(`NDJSON edge row is empty, non-canonical, or oversized: ${receipt.path}`)
        }
        let value: unknown
        try { value = JSON.parse(line) as unknown } catch { throw new Error(`NDJSON edge row is invalid JSON: ${receipt.path}`) }
        const row = eligibleOnly
          ? CompactV31ProductionEligibleEdgeRowSchema.parse(value)
          : CompactV31ProductionExactEdgeRowSchema.parse(value)
        if (previousEdgeId !== null && previousEdgeId >= row.edgeId) {
          throw new Error(`NDJSON edge rows are duplicated or not sorted: ${receipt.path}`)
        }
        previousEdgeId = row.edgeId
        yield row
      }
      if (Buffer.byteLength(carry, 'utf8') > MAXIMUM_NDJSON_LINE_BYTES) {
        throw new Error(`NDJSON edge row exceeds the bounded line limit: ${receipt.path}`)
      }
    }
    carry += decoder.decode()
    if (carry.length > 0) throw new Error(`NDJSON edge partition lacks its final canonical newline: ${receipt.path}`)
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || digest.digest('hex') !== receipt.sha256) {
      throw new Error(`NDJSON receipt SHA-256 or identity differs: ${receipt.path}`)
    }
  } finally {
    await handle.close()
  }
}

export async function verifyCompactV31EligibleEdgePartitionPair(options: {
  root: string
  exactReceipt: FileReceipt
  pair: {
    exactStatePartitionSha256: string
    exactStateFirstEdgeId: string
    exactStateLastEdgeId: string
    eligibleEdges: FileReceipt
    eligibleEdgeCount: number
    eligibleFirstEdgeId: string | null
    eligibleLastEdgeId: string | null
  }
  minimumSampleSize: 100
}): Promise<number> {
  if (options.pair.exactStatePartitionSha256 !== options.exactReceipt.sha256) {
    throw new Error('Eligible-edge partition is not paired with its exact-state partition')
  }
  const eligibleIterator = readEdgeRows(options.root, options.pair.eligibleEdges, true)[Symbol.asyncIterator]()
  let eligibleInPartition = 0
  let exactFirst: string | null = null
  let exactLast: string | null = null
  let eligibleFirst: string | null = null
  let eligibleLast: string | null = null
  for await (const exactRow of readEdgeRows(options.root, options.exactReceipt, false)) {
    exactFirst ??= exactRow.edgeId
    exactLast = exactRow.edgeId
    if (exactRow.sampleSize < options.minimumSampleSize) continue
    const next = await eligibleIterator.next()
    if (next.done || !sameEdge(exactRow, next.value)) {
      throw new Error('Eligible-edge derivation differs from exact-state partition')
    }
    eligibleFirst ??= next.value.edgeId
    eligibleLast = next.value.edgeId
    eligibleInPartition += 1
  }
  if ((await eligibleIterator.next()).done !== true) {
    throw new Error('Eligible-edge partition contains rows absent from exact state')
  }
  if (
    exactFirst !== options.pair.exactStateFirstEdgeId || exactLast !== options.pair.exactStateLastEdgeId ||
    eligibleFirst !== options.pair.eligibleFirstEdgeId || eligibleLast !== options.pair.eligibleLastEdgeId ||
    eligibleInPartition !== options.pair.eligibleEdgeCount
  ) throw new Error('Eligible-edge partition count or bounds differ from exact state')
  return eligibleInPartition
}

/**
 * Independently k-way merge canonically sorted exact archive partitions. The
 * verifier holds one row per archive plus one edge's evidence cells in memory.
 */
export async function verifyCompactV31ExactMergePartition(options: {
  root: string
  deltaPartitions: readonly FileReceipt[]
  mergedPartition: FileReceipt
}): Promise<{ inputRows: number; outputRows: number; duplicateRowsMerged: number }> {
  if (options.deltaPartitions.length < 1) throw new Error('Exact merge verification requires source delta partitions')
  const sources = options.deltaPartitions.map((receipt) => ({
    iterator: readEdgeRows(options.root, receipt, false)[Symbol.asyncIterator](),
    head: null as IteratorResult<ExactEdgeRow> | null,
  }))
  for (const source of sources) source.head = await source.iterator.next()
  const merged = readEdgeRows(options.root, options.mergedPartition, false)[Symbol.asyncIterator]()
  let inputRows = 0
  let outputRows = 0
  while (sources.some(({ head }) => head?.done === false)) {
    const edgeId = sources.reduce<string | null>((minimum, source) => {
      if (source.head?.done !== false) return minimum
      return minimum === null || source.head.value.edgeId < minimum ? source.head.value.edgeId : minimum
    }, null)
    if (edgeId === null) break
    let identity: ExactEdgeRow | null = null
    const cells = new Map<string, ExactEdgeRow['cells'][number]>()
    for (const source of sources) {
      if (source.head?.done !== false || source.head.value.edgeId !== edgeId) continue
      const row = source.head.value
      if (identity !== null && (
        identity.fromEpdSha256 !== row.fromEpdSha256 || identity.toEpdSha256 !== row.toEpdSha256 || identity.uci !== row.uci
      )) throw new Error(`Exact delta edge identity conflicts for ${edgeId}`)
      identity ??= row
      for (const cell of row.cells) {
        const key = cellKey(cell)
        const existing = cells.get(key)
        cells.set(key, existing === undefined ? { ...cell } : {
          ...existing,
          whiteWins: safeSum(existing.whiteWins, cell.whiteWins, 'White-win count'),
          draws: safeSum(existing.draws, cell.draws, 'Draw count'),
          blackWins: safeSum(existing.blackWins, cell.blackWins, 'Black-win count'),
          n: safeSum(existing.n, cell.n, 'Evidence-cell sample count'),
        })
      }
      inputRows += 1
      source.head = await source.iterator.next()
    }
    const mergedCells = [...cells.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, cell]) => cell)
    const expected = CompactV31ProductionExactEdgeRowSchema.parse({
      edgeId,
      fromEpdSha256: identity!.fromEpdSha256,
      toEpdSha256: identity!.toEpdSha256,
      uci: identity!.uci,
      sampleSize: Math.max(...mergedCells.map(({ n }) => n)),
      cells: mergedCells,
    })
    const actual = await merged.next()
    if (actual.done || !sameEdge(expected, actual.value)) {
      throw new Error(`Exact merge partition differs from deterministic delta merge at ${edgeId}`)
    }
    outputRows += 1
  }
  if ((await merged.next()).done !== true) throw new Error('Exact merge partition contains rows absent from exact deltas')
  return { inputRows, outputRows, duplicateRowsMerged: inputRows - outputRows }
}

/**
 * Deeply traverse the production corpus chain. A caller may use the returned
 * audit as an input to family construction, but not as a shippable marker.
 * Every referenced file is opened beneath one root, size checked, hashed, and
 * schema validated before joins are evaluated.
 */
export async function auditCompactV31ProductionCorpusChain(options: {
  root: string
  corpusReceipt: FileReceipt
}): Promise<{
  status: 'pass'
  releaseEligible: false
  receipt: CompactV31ProductionCorpusReceipt
  corpusReceiptSha256: string
  sourceManifestSha256: string
  exactMergeReceiptSha256: string
  sourceEdgeInventorySha256: string
  eligibleSourceEdges: number
}> {
  const corpus = CompactV31ProductionCorpusReceiptSchema.parse(await readReceipt(options.root, options.corpusReceipt))
  const authorization = CompactV31ProductionAuthorizationSchema.parse(
    await readReceipt(options.root, corpus.productionAuthorization),
  )
  if (authorization.decision !== 'approved') throw new Error('Corpus chain uses a non-approved production authorization')
  const expectedSource = corpus.corpus === 'lichess-broadcasts'
    ? authorization.sourceManifests.broadcasts
    : authorization.sourceManifests.standardQ2_2026
  if (!sameReceipt(corpus.sourceManifest, expectedSource)) {
    throw new Error('Corpus chain source manifest differs from its production authorization')
  }
  const sourceManifest = await readReceipt(options.root, corpus.sourceManifest)
  let sourceArchives: Array<{ month: string; filename: string; url: string; sha256: string; bytes?: number; etagObserved?: string; lastModifiedObserved?: string }>
  let broadcastTransport: BroadcastManifestV1 | null = null
  let broadcastObservations: z.infer<typeof PendingBroadcastMetadataInventorySchema> | null = null
  if (corpus.corpus === 'lichess-broadcasts') {
    assertBroadcastManifestApproved(sourceManifest)
    sourceArchives = (sourceManifest as { archives: typeof sourceArchives }).archives
    const proposalValue = await readReceipt(options.root, authorization.broadcastTransportIdentity.proposal)
    assertBroadcastManifest(proposalValue)
    broadcastTransport = proposalValue
    broadcastObservations = PendingBroadcastMetadataInventorySchema.parse(
      await readReceipt(options.root, authorization.broadcastTransportIdentity.observation),
    )
    if (
      broadcastTransport.approval.status !== 'pending' ||
      broadcastTransport.metadataObservation?.receiptSha256 !== authorization.broadcastTransportIdentity.observation.sha256 ||
      broadcastTransport.metadataObservation.sourceManifestSha256 !== corpus.sourceManifest.sha256 ||
      broadcastObservations.sourceManifestSha256 !== corpus.sourceManifest.sha256 ||
      broadcastObservations.archiveCount !== sourceArchives.length
    ) throw new Error('Broadcast transport identity is not bound to the approved source manifest and authorization')
  } else {
    const q2 = LichessStandardManifestSchema.parse(sourceManifest)
    if (q2.source.id !== corpus.corpus || q2.approval.status !== 'approved') {
      throw new Error('Q2 corpus chain uses an unapproved or mismatched source manifest')
    }
    const adaptiveApproval = CompactV31Q2AdaptiveReplayAuthorizationSchema.parse(
      await readReceipt(options.root, authorization.q2AdaptiveReplayApproval),
    )
    if (adaptiveApproval.decision !== 'approved' || !sameReceipt(adaptiveApproval.sourceManifest, corpus.sourceManifest)) {
      throw new Error('Q2 adaptive replay through ply 100 lacks an approved, source-bound scope receipt')
    }
    sourceArchives = q2.archives
  }
  const repeatability = CompactV31RepeatabilityBindingSchema.parse(
    await readReceipt(options.root, corpus.benchmarkRepeatabilityBinding),
  )
  if (
    !sameReceipt(corpus.benchmarkRepeatabilityBinding, authorization.benchmarkRepeatabilityBinding) ||
    repeatability.benchmarkAuthorizationSha256 !== authorization.benchmarkAuthorizationSha256
  ) throw new Error('Corpus chain repeatability proof differs from its production authorization')
  const review = CompactV31ProductionPlanReviewSchema.parse(await readReceipt(options.root, corpus.planReview))
  const expectedConfigurationSha256 = compactV31ProductionConfigurationSha256({
    sourceSnapshotSha256: repeatability.sourceSnapshotSha256,
    productionAuthorizationSha256: corpus.productionAuthorization.sha256,
    benchmarkRepeatabilityBindingSha256: corpus.benchmarkRepeatabilityBinding.sha256,
    corpus: corpus.corpus,
    limits: authorization.limits,
  })
  if (
    review.corpus !== corpus.corpus ||
    review.productionAuthorizationSha256 !== corpus.productionAuthorization.sha256 ||
    review.benchmarkRepeatabilityBindingSha256 !== corpus.benchmarkRepeatabilityBinding.sha256 ||
    review.sourceSnapshotSha256 !== repeatability.sourceSnapshotSha256 ||
    review.configurationSha256 !== expectedConfigurationSha256
  ) throw new Error('Corpus plan review differs from its authorization, benchmark, or corpus')

  const plans = []
  for (const planReceipt of review.plans) {
    const plan = CompactV31ProductionPlanSchema.parse(await readReceipt(options.root, planReceipt))
    if (
      plan.corpus !== corpus.corpus || plan.productionAuthorizationSha256 !== corpus.productionAuthorization.sha256 ||
      plan.benchmarkRepeatabilityBindingSha256 !== corpus.benchmarkRepeatabilityBinding.sha256 ||
      plan.archive.sourceManifestSha256 !== corpus.sourceManifest.sha256 ||
      plan.sourceSnapshotSha256 !== review.sourceSnapshotSha256 ||
      plan.configurationSha256 !== review.configurationSha256 ||
      JSON.stringify(plan.limits) !== JSON.stringify(authorization.limits) ||
      planReceipt.sha256 !== review.plans[plan.archiveOrdinal]?.sha256
    ) throw new Error(`Production plan ${plan.archive.archiveId} is outside the authenticated corpus chain`)
    const approvedArchive = sourceArchives[plan.archiveOrdinal]
    if (
      !approvedArchive || approvedArchive.month !== plan.archive.month ||
      approvedArchive.filename !== plan.archive.filename || approvedArchive.url !== plan.archive.url ||
      approvedArchive.sha256 !== plan.archive.sha256
    ) throw new Error(`Production plan ${plan.archive.archiveId} differs from its approved source-manifest entry`)
    if (corpus.corpus === 'lichess-broadcasts') {
      const transport = broadcastTransport!.archives[plan.archiveOrdinal]
      const observation = broadcastObservations!.archives[plan.archiveOrdinal]
      if (
        !transport || !observation || transport.month !== approvedArchive.month ||
        transport.filename !== approvedArchive.filename || transport.url !== approvedArchive.url ||
        transport.sha256 !== approvedArchive.sha256 || transport.bytes !== plan.archive.compressedBytes ||
        transport.etagObserved !== plan.archive.etagObserved ||
        transport.lastModifiedObserved !== plan.archive.lastModifiedObserved ||
        observation.archiveId !== plan.archive.archiveId || observation.month !== plan.archive.month ||
        observation.approvedUrl !== plan.archive.url || observation.approvedSha256 !== plan.archive.sha256 ||
        observation.localVerification.status !== 'verified' ||
        observation.localVerification.bytes !== plan.archive.compressedBytes ||
        observation.localVerification.sha256 !== plan.archive.sha256 ||
        observation.observation.contentLength !== plan.archive.compressedBytes ||
        observation.observation.etagObserved !== plan.archive.etagObserved ||
        observation.observation.lastModifiedObserved !== plan.archive.lastModifiedObserved ||
        observation.observation.retrievedAt !== plan.archive.retrievedAt
      ) throw new Error(`Production plan ${plan.archive.archiveId} differs from its authorized transport observation`)
    } else if (
      approvedArchive.bytes !== plan.archive.compressedBytes ||
      approvedArchive.etagObserved !== plan.archive.etagObserved ||
      approvedArchive.lastModifiedObserved !== plan.archive.lastModifiedObserved
    ) throw new Error(`Production plan ${plan.archive.archiveId} differs from its approved Q2 archive identity`)
    plans.push(plan)
  }
  if (plans.length !== corpus.archiveReceipts.length) throw new Error('Corpus archive receipt inventory differs from its plans')

  const archives = []
  const exactDeltas: Array<z.infer<typeof CompactV31ProductionDeltaReceiptSchema>> = []
  let previousCandidate: string | null = null
  let previousExact: string | null = null
  for (const [ordinal, archiveReceipt] of corpus.archiveReceipts.entries()) {
    const archive = CompactV31ProductionArchiveReceiptSchema.parse(await readReceipt(options.root, archiveReceipt))
    const plan = plans[ordinal]!
    if (
      archive.archiveOrdinal !== ordinal || archive.archiveId !== plan.archive.archiveId ||
      archive.planSha256 !== review.plans[ordinal]!.sha256 ||
      archive.productionAuthorizationSha256 !== corpus.productionAuthorization.sha256 ||
      archive.sourceManifestSha256 !== corpus.sourceManifest.sha256 ||
      archive.compressedInput.bytes !== plan.archive.compressedBytes ||
      archive.compressedInput.sha256 !== plan.archive.sha256
    ) throw new Error(`Archive receipt ${ordinal} does not join its exact plan and source manifest`)
    const candidate = CompactV31ProductionDeltaReceiptSchema.parse(
      await readReceipt(options.root, archive.candidateDeltaReceipt),
    )
    const exact = CompactV31ProductionDeltaReceiptSchema.parse(
      await readReceipt(options.root, archive.exactDeltaReceipt),
    )
    for (const delta of [candidate, exact]) {
      if (
        delta.corpus !== corpus.corpus || delta.archiveOrdinal !== ordinal || delta.archiveId !== archive.archiveId ||
        delta.productionAuthorizationSha256 !== corpus.productionAuthorization.sha256 ||
        delta.sourceManifestSha256 !== corpus.sourceManifest.sha256 || delta.planSha256 !== archive.planSha256 ||
        delta.compressedInput.bytes !== archive.compressedInput.bytes ||
        delta.compressedInput.sha256 !== archive.compressedInput.sha256
      ) throw new Error(`Delta receipt ${archive.archiveId}/${delta.pass} is outside its archive chain`)
      for (const partition of delta.outputPartitions) await verifyCompactV31ProductionFileReceipt(options.root, partition)
    }
    if (
      candidate.pass !== 'candidate' || exact.pass !== 'exact' ||
      candidate.previousDeltaReceiptSha256 !== previousCandidate ||
      exact.previousDeltaReceiptSha256 !== previousExact ||
      candidate.accounting.recordsSeen !== exact.accounting.recordsSeen ||
      candidate.accounting.accepted !== exact.accounting.accepted + exact.accounting.deduplicated ||
      candidate.accounting.deduplicated !== 0 ||
      !sameAccounting(candidate.accounting.rejected, exact.accounting.rejected) ||
      !sameAccounting(exact.accounting, archive.accounting)
    ) throw new Error(`Candidate/exact delta chain differs at ${archive.archiveId}`)
    previousCandidate = archive.candidateDeltaReceipt.sha256
    previousExact = archive.exactDeltaReceipt.sha256
    exactDeltas.push(exact)
    archives.push(archive)
  }

  const candidateMerge = CompactV31ProductionMergeReceiptSchema.parse(
    await readReceipt(options.root, corpus.candidateMergeReceipt),
  )
  const exactMerge = CompactV31ProductionMergeReceiptSchema.parse(
    await readReceipt(options.root, corpus.exactMergeReceipt),
  )
  const expectedCandidateRefs = archives.map(({ candidateDeltaReceipt }) => candidateDeltaReceipt)
  const expectedExactRefs = archives.map(({ exactDeltaReceipt }) => exactDeltaReceipt)
  if (
    candidateMerge.pass !== 'candidate' || exactMerge.pass !== 'exact' ||
    candidateMerge.corpus !== corpus.corpus || exactMerge.corpus !== corpus.corpus ||
    candidateMerge.productionAuthorizationSha256 !== corpus.productionAuthorization.sha256 ||
    exactMerge.productionAuthorizationSha256 !== corpus.productionAuthorization.sha256 ||
    candidateMerge.sourceManifestSha256 !== corpus.sourceManifest.sha256 ||
    exactMerge.sourceManifestSha256 !== corpus.sourceManifest.sha256 ||
    JSON.stringify(candidateMerge.inputDeltaReceipts) !== JSON.stringify(expectedCandidateRefs) ||
    JSON.stringify(exactMerge.inputDeltaReceipts) !== JSON.stringify(expectedExactRefs)
  ) throw new Error('Production merge receipts do not consume the exact ordered delta chains')
  for (const partition of [...candidateMerge.outputPartitions, ...exactMerge.outputPartitions]) {
    await verifyCompactV31ProductionFileReceipt(options.root, partition)
  }
  const deltaPartitionIds = new Set(exactDeltas.flatMap((delta) => delta.outputPartitions.map(({ partition }) => partition)))
  const mergePartitionIds = new Set(exactMerge.outputPartitions.map(({ partition }) => partition))
  if (
    deltaPartitionIds.size !== mergePartitionIds.size ||
    [...deltaPartitionIds].some((partition) => !mergePartitionIds.has(partition))
  ) throw new Error('Exact merge partition inventory differs from exact archive deltas')
  let verifiedInputRows = 0
  let verifiedOutputRows = 0
  let verifiedDuplicates = 0
  for (const mergedPartition of exactMerge.outputPartitions) {
    const verification = await verifyCompactV31ExactMergePartition({
      root: options.root,
      deltaPartitions: exactDeltas.flatMap((delta) =>
        delta.outputPartitions.filter(({ partition }) => partition === mergedPartition.partition)),
      mergedPartition,
    })
    verifiedInputRows = safeSum(verifiedInputRows, verification.inputRows, 'Exact-merge input rows')
    verifiedOutputRows = safeSum(verifiedOutputRows, verification.outputRows, 'Exact-merge output rows')
    verifiedDuplicates = safeSum(verifiedDuplicates, verification.duplicateRowsMerged, 'Exact-merge duplicate rows')
  }
  if (
    verifiedInputRows !== exactMerge.inputRows || verifiedOutputRows !== exactMerge.outputRows ||
    verifiedDuplicates !== exactMerge.duplicateRowsMerged
  ) throw new Error('Exact merge receipt row accounting differs from independently merged delta bytes')
  const totals = archives.reduce((sum, archive) => ({
    recordsSeen: sum.recordsSeen + archive.accounting.recordsSeen,
    accepted: sum.accepted + archive.accounting.accepted,
    deduplicated: sum.deduplicated + archive.accounting.deduplicated,
    rejected: sum.rejected + rejectedTotal(archive.accounting.rejected),
  }), { recordsSeen: 0, accepted: 0, deduplicated: 0, rejected: 0 })
  if (
    totals.recordsSeen !== corpus.recordsSeen || totals.accepted !== corpus.accepted ||
    totals.deduplicated !== corpus.deduplicated || totals.rejected !== corpus.rejected
  ) throw new Error('Corpus aggregate accounting differs from its traversed archive receipts')

  const sourceEdges = CompactV31ProductionSourceEdgeInventorySchema.parse(
    await readReceipt(options.root, corpus.sourceEdgeInventory),
  )
  if (
    sourceEdges.releaseId !== corpus.releaseId ||
    sourceEdges.corpus !== corpus.corpus ||
    sourceEdges.productionAuthorizationSha256 !== corpus.productionAuthorization.sha256 ||
    sourceEdges.sourceManifestSha256 !== corpus.sourceManifest.sha256 ||
    sourceEdges.exactMergeReceiptSha256 !== corpus.exactMergeReceipt.sha256
  ) throw new Error('Source-edge inventory does not join the exact verified merge and source manifest')
  let eligibleEdgeCount = 0
  if (sourceEdges.minimumSampleSize !== 100 || sourceEdges.eligibleEdgePartitions.length !== exactMerge.outputPartitions.length) {
    throw new Error('Eligible-edge inventory does not cover every exact-state partition')
  }
  for (const [partitionIndex, pair] of sourceEdges.eligibleEdgePartitions.entries()) {
    const exactReceipt = exactMerge.outputPartitions[partitionIndex]!
    if (pair.partition !== exactReceipt.partition) throw new Error('Eligible-edge partition ID differs from exact state')
    eligibleEdgeCount += await verifyCompactV31EligibleEdgePartitionPair({
      root: options.root,
      exactReceipt,
      pair,
      minimumSampleSize: sourceEdges.minimumSampleSize,
    })
  }
  if (eligibleEdgeCount !== sourceEdges.eligibleSourceEdges) {
    throw new Error('Eligible-edge partition rows differ from the source-edge inventory total')
  }
  return {
    status: 'pass',
    releaseEligible: false,
    receipt: corpus,
    corpusReceiptSha256: options.corpusReceipt.sha256,
    sourceManifestSha256: corpus.sourceManifest.sha256,
    exactMergeReceiptSha256: corpus.exactMergeReceipt.sha256,
    sourceEdgeInventorySha256: corpus.sourceEdgeInventory.sha256,
    eligibleSourceEdges: sourceEdges.eligibleSourceEdges,
  }
}

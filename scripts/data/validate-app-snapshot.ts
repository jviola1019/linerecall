import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'
import { DataManifestSchema, OpeningPartitionSchema } from '../../src/domain/opening-data.ts'
import {
  WireAppManifestSchema,
  WireBlobReceiptSchema,
  WireEvidenceShardSchema,
  WirePartitionSchema,
  WireSearchSnapshotSchema,
  hydrateParsedWirePartition,
  type WireEvidenceShard,
  type WirePartition,
  type WirePartitionEvidence,
} from '../../src/data/wire.ts'

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing option ${name}`)
  return resolve(value)
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

interface ReceiptDecodeResult {
  value: unknown
  checksumMs: number
  decompressionMs: number
  jsonParseMs: number
}

interface PartitionBenchmarkSample {
  totalMs: number
  checksumMs: number
  decompressionMs: number
  jsonParseMs: number
  schemaValidationMs: number
  hydrationMs: number
  overheadMs: number
}

interface PartitionBenchmarkResult {
  eco: string
  shardCount: number
  compressedBytes: number
  uncompressedBytes: number
  representative: PartitionBenchmarkSample
  sampleTotalMs: number[]
}

const PARTITION_BENCHMARK_SAMPLES = 3

function decodeReceiptJson(
  compressed: Uint8Array,
  receipt: z.infer<typeof WireBlobReceiptSchema>,
): ReceiptDecodeResult {
  const checksumStarted = performance.now()
  if (compressed.byteLength !== receipt.compressedBytes || sha256(compressed) !== receipt.sha256) {
    throw new Error(`Compact blob integrity mismatch: ${receipt.path}`)
  }
  const checksumMs = performance.now() - checksumStarted

  const decompressionStarted = performance.now()
  const uncompressed = gunzipSync(compressed)
  const decompressionMs = performance.now() - decompressionStarted
  if (uncompressed.byteLength !== receipt.uncompressedBytes) {
    throw new Error(`Compact blob uncompressed size mismatch: ${receipt.path}`)
  }

  const jsonStarted = performance.now()
  const value = JSON.parse(uncompressed.toString('utf8')) as unknown
  const jsonParseMs = performance.now() - jsonStarted
  return { value, checksumMs, decompressionMs, jsonParseMs }
}

async function readReceiptJson(
  directory: string,
  receipt: z.infer<typeof WireBlobReceiptSchema>,
): Promise<ReceiptDecodeResult & { loadMs: number }> {
  const loadStarted = performance.now()
  const path = join(directory, ...receipt.path.split('/'))
  const compressed = await readFile(path)
  return { ...decodeReceiptJson(compressed, receipt), loadMs: performance.now() - loadStarted }
}

function benchmarkPartitionSample(options: {
  eco: string
  partitionBlob: { compressed: Uint8Array; receipt: z.infer<typeof WireBlobReceiptSchema> }
  shardBlobs: Array<{ id: string; compressed: Uint8Array; receipt: z.infer<typeof WireBlobReceiptSchema> }>
  search: z.infer<typeof WireSearchSnapshotSchema>
}): PartitionBenchmarkSample {
  const totalStarted = performance.now()
  const decoded = decodeReceiptJson(options.partitionBlob.compressed, options.partitionBlob.receipt)
  let schemaStarted = performance.now()
  const partition = WirePartitionSchema.parse(decoded.value)
  let schemaValidationMs = performance.now() - schemaStarted
  const evidence: WirePartitionEvidence = { positions: new Map(), engines: new Map() }
  const evidenceEpds = new Set<string>()
  const engineFens = new Set<string>()
  let shardChecksumMs = 0
  let shardDecompressionMs = 0
  let shardJsonParseMs = 0
  for (const blob of options.shardBlobs) {
    const shardDecoded = decodeReceiptJson(blob.compressed, blob.receipt)
    shardChecksumMs += shardDecoded.checksumMs
    shardDecompressionMs += shardDecoded.decompressionMs
    shardJsonParseMs += shardDecoded.jsonParseMs
    schemaStarted = performance.now()
    const shard = WireEvidenceShardSchema.parse(shardDecoded.value)
    schemaValidationMs += performance.now() - schemaStarted
    if (shard.s !== blob.id || shard.g !== partition.g || !shard.c.includes(options.eco)) {
      throw new Error(`Evidence shard ${blob.id} does not belong to ${options.eco}`)
    }
    for (const [index, position] of shard.p) {
      if (evidence.positions.has(index)) throw new Error(`Duplicate evidence position ${index} for ${options.eco}`)
      if (evidenceEpds.has(position[0])) throw new Error(`Duplicate evidence EPD ${position[0]} for ${options.eco}`)
      ;(evidence.positions as Map<number, typeof position>).set(index, position)
      evidenceEpds.add(position[0])
    }
    for (const [index, engine] of shard.a) {
      if (evidence.engines.has(index)) throw new Error(`Duplicate engine evidence ${index} for ${options.eco}`)
      if (engineFens.has(engine[0])) throw new Error(`Duplicate engine FEN ${engine[0]} for ${options.eco}`)
      ;(evidence.engines as Map<number, typeof engine>).set(index, engine)
      engineFens.add(engine[0])
    }
  }
  if (partition.e !== options.eco) throw new Error(`Compact partition key mismatch for ${options.eco}`)
  const hydrationStarted = performance.now()
  hydrateParsedWirePartition({
    search: options.search,
    partition,
    evidence,
  })
  const hydrationMs = performance.now() - hydrationStarted
  const totalMs = performance.now() - totalStarted
  const checksumMs = decoded.checksumMs + shardChecksumMs
  const decompressionMs = decoded.decompressionMs + shardDecompressionMs
  const jsonParseMs = decoded.jsonParseMs + shardJsonParseMs
  const measuredPhaseMs = checksumMs + decompressionMs + jsonParseMs +
    schemaValidationMs + hydrationMs
  return {
    totalMs,
    checksumMs,
    decompressionMs,
    jsonParseMs,
    schemaValidationMs,
    hydrationMs,
    overheadMs: Math.max(0, totalMs - measuredPhaseMs),
  }
}

function medianSample(samples: readonly PartitionBenchmarkSample[]): PartitionBenchmarkSample {
  if (samples.length !== PARTITION_BENCHMARK_SAMPLES) {
    throw new Error(`Expected ${PARTITION_BENCHMARK_SAMPLES} partition benchmark samples`)
  }
  return [...samples].sort((left, right) => left.totalMs - right.totalMs)[Math.floor(samples.length / 2)]!
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

type PartitionBenchmarkPhase =
  | 'checksumMs'
  | 'decompressionMs'
  | 'jsonParseMs'
  | 'schemaValidationMs'
  | 'hydrationMs'
  | 'overheadMs'

function maximumPhase(
  results: readonly PartitionBenchmarkResult[],
  phase: PartitionBenchmarkPhase,
): { eco: string; milliseconds: number } {
  const maximum = results.reduce((current, candidate) =>
    candidate.representative[phase] > current.representative[phase] ? candidate : current)
  return { eco: maximum.eco, milliseconds: rounded(maximum.representative[phase]) }
}

function assemblePartitionEvidence(options: {
  eco: string
  partition: WirePartition
  shards: ReadonlyMap<string, WireEvidenceShard>
  observedConsumers?: Map<string, Set<string>>
}): WirePartitionEvidence {
  const positions = new Map<number, WireEvidenceShard['p'][number][1]>()
  const engines = new Map<number, WireEvidenceShard['a'][number][1]>()
  const epds = new Set<string>()
  const fens = new Set<string>()
  for (const shardId of options.partition.s) {
    const shard = options.shards.get(shardId)
    if (!shard) throw new Error(`Compact partition ${options.eco} references missing evidence shard ${shardId}`)
    if (shard.s !== shardId || shard.g !== options.partition.g || !shard.c.includes(options.eco)) {
      throw new Error(`Evidence shard ${shardId} has invalid identity, generation, or consumer metadata for ${options.eco}`)
    }
    const consumers = options.observedConsumers?.get(shardId) ?? new Set<string>()
    consumers.add(options.eco)
    options.observedConsumers?.set(shardId, consumers)
    for (const [index, position] of shard.p) {
      if (positions.has(index)) throw new Error(`Evidence position ${index} is duplicated across shards for ${options.eco}`)
      if (epds.has(position[0])) throw new Error(`Evidence EPD ${position[0]} is duplicated across shards for ${options.eco}`)
      positions.set(index, position)
      epds.add(position[0])
    }
    for (const [index, engine] of shard.a) {
      if (engines.has(index)) throw new Error(`Engine position ${index} is duplicated across shards for ${options.eco}`)
      if (fens.has(engine[0])) throw new Error(`Engine FEN ${engine[0]} is duplicated across shards for ${options.eco}`)
      engines.set(index, engine)
      fens.add(engine[0])
    }
  }
  return { positions, engines }
}

function compareHydratedToAudit(
  hydrated: z.infer<typeof OpeningPartitionSchema>,
  audited: z.infer<typeof OpeningPartitionSchema>,
): void {
  if (JSON.stringify(hydrated.lines) !== JSON.stringify(audited.lines)) {
    throw new Error(`Hydrated browsable lines differ from audit partition ${hydrated.eco}`)
  }
  const auditedVariants = new Map(audited.verifiedLines.map((line) => [line.id, line]))
  if (auditedVariants.size !== audited.verifiedLines.length) {
    throw new Error(`Audited partition has duplicate variant IDs for ${hydrated.eco}`)
  }
  const hydratedVariantIds = hydrated.verifiedLines.map((line) => line.id).sort((left, right) => left.localeCompare(right, 'en'))
  const auditedVariantIds = audited.verifiedLines.map((line) => line.id).sort((left, right) => left.localeCompare(right, 'en'))
  if (JSON.stringify(hydratedVariantIds) !== JSON.stringify(auditedVariantIds)) {
    throw new Error(`Hydrated variant identities differ for ${hydrated.eco}`)
  }
  for (const line of hydrated.verifiedLines) {
    const expected = auditedVariants.get(line.id)
    if (!expected) throw new Error(`Hydrated partition has unknown variant ${line.id}`)
    for (const field of [
      'sourceLineId', 'eco', 'name', 'pgn', 'trainedSide', 'terminalSampleSize', 'drillEligible',
      'insufficientBacktestSample', 'selectedForEngineVerification', 'quarantined', 'crosscheckStatus', 'provenanceRef',
    ] as const) {
      if (line[field] !== expected[field]) throw new Error(`Variant field ${field} differs for ${line.id}`)
    }
    if (
      JSON.stringify(line.uci) !== JSON.stringify(expected.uci) ||
      JSON.stringify(line.terminalStats) !== JSON.stringify(expected.terminalStats) ||
      JSON.stringify(line.quarantineReasons) !== JSON.stringify(expected.quarantineReasons) ||
      line.nodes.length !== expected.nodes.length
    ) throw new Error(`Variant arrays differ for ${line.id}`)
    for (const [index, node] of line.nodes.entries()) {
      const auditedNode = expected.nodes[index]
      if (!auditedNode) throw new Error(`Missing audited node ${line.id}/${index}`)
      for (const field of ['id', 'ply', 'epd', 'fen', 'sideToMove', 'expectedMoveUci', 'nextNodeId', 'provenanceRef'] as const) {
        if (node[field] !== auditedNode[field]) throw new Error(`Node field ${field} differs for ${node.id}`)
      }
      if (
        JSON.stringify(node.equivalentPositionLineIds) !== JSON.stringify(auditedNode.equivalentPositionLineIds) ||
        JSON.stringify(node.engine) !== JSON.stringify(auditedNode.engine)
      ) throw new Error(`Node engine/transposition evidence differs for ${node.id}`)
      const hydratedMoves = new Map(node.moves.map((move) => [move.uci, move]))
      if (hydratedMoves.size !== node.moves.length || node.moves.length !== auditedNode.moves.length) {
        throw new Error(`Move evidence identities differ for ${node.id}`)
      }
      for (const auditedMove of auditedNode.moves) {
        const move = hydratedMoves.get(auditedMove.uci)
        if (!move || JSON.stringify(move) !== JSON.stringify(auditedMove)) {
          const differingFields = move === undefined
            ? ['missing']
            : Object.keys(auditedMove).filter((field) =>
                JSON.stringify(move[field as keyof typeof move]) !==
                JSON.stringify(auditedMove[field as keyof typeof auditedMove]),
              )
          throw new Error(
            `Move evidence differs for ${node.id}/${auditedMove.uci}: ${differingFields.join(', ')}`,
          )
        }
      }
    }
  }
  if (hydrated.verifiedLines.length !== audited.verifiedLines.length) {
    throw new Error(`Hydrated variant count differs for ${hydrated.eco}`)
  }
}

export async function validateAppSnapshot(options: {
  directory: string
  auditDirectory: string
  reportPath: string
}): Promise<Record<string, unknown>> {
  const manifestBytes = await readFile(join(options.directory, 'manifest.json'))
  const manifest = WireAppManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')) as unknown)
  if (Object.keys(manifest.partitions).length !== 500) throw new Error('Compact snapshot lacks 500 partitions')
  if (
    manifest.blobs.search.path !== 'search.json.gz' ||
    manifest.blobs.audit.path !== 'audit.json.gz'
  ) throw new Error('Compact core blob receipts are not canonical relative paths')
  for (const [eco, receipt] of Object.entries(manifest.partitions)) {
    if (receipt.path !== `partitions/${eco}.json.gz`) {
      throw new Error(`Compact partition ${eco} has a non-canonical receipt path`)
    }
  }
  for (const [shardId, receipt] of Object.entries(manifest.shards)) {
    if (receipt.path !== `shards/${shardId}.json.gz`) {
      throw new Error(`Compact evidence shard ${shardId} has a non-canonical receipt path`)
    }
  }
  const compressedTotal = [
    ...Object.values(manifest.blobs),
    ...Object.values(manifest.shards),
    ...Object.values(manifest.partitions),
  ].reduce((sum, receipt) => sum + receipt.compressedBytes, 0)
  if (compressedTotal !== manifest.totals.compressedBytes) throw new Error('Compact byte total does not reconcile')
  const estimatedBase64Bytes = [
    ...Object.values(manifest.blobs),
    ...Object.values(manifest.shards),
    ...Object.values(manifest.partitions),
  ].reduce((sum, receipt) => sum + Math.ceil(receipt.compressedBytes / 3) * 4, 0)
  if (estimatedBase64Bytes !== manifest.totals.estimatedBase64Bytes) {
    throw new Error('Compact base64 byte estimate does not reconcile')
  }

  const [searchResult, auditResult] = await Promise.all([
    readReceiptJson(options.directory, manifest.blobs.search),
    readReceiptJson(options.directory, manifest.blobs.audit),
  ])
  const search = WireSearchSnapshotSchema.parse(searchResult.value)
  const audit = DataManifestSchema.parse(auditResult.value)
  if (
    manifest.g !== search.g || manifest.g !== audit.generatedAt ||
    audit.audit.verifiedVariants !== manifest.totals.variants ||
    search.x.length !== audit.audit.drillableVariants
  ) throw new Error('Compact snapshot generation or totals do not match audit data')

  const sourceLineIndexes = new Map(search.l.map((line, index) => [line[0], index]))
  const observedVariantSummaries: typeof search.x = []

  const partitionEntries = Object.entries(manifest.partitions)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
  const partitionBytes = new Map<string, Uint8Array>()
  for (const [eco, receipt] of partitionEntries) {
    const compressed = await readFile(join(options.directory, ...receipt.path.split('/')))
    if (compressed.byteLength !== receipt.compressedBytes || sha256(compressed) !== receipt.sha256) {
      throw new Error(`Compact blob integrity mismatch: ${receipt.path}`)
    }
    partitionBytes.set(eco, compressed)
  }
  const shardBytes = new Map<string, Uint8Array>()
  const shards = new Map<string, WireEvidenceShard>()
  for (const [shardId, receipt] of Object.entries(manifest.shards)) {
    const compressed = await readFile(join(options.directory, ...receipt.path.split('/')))
    const decoded = decodeReceiptJson(compressed, receipt)
    const shard = WireEvidenceShardSchema.parse(decoded.value)
    if (shard.s !== shardId || shard.g !== manifest.g) {
      throw new Error(`Compact evidence shard key or generation mismatch for ${shardId}`)
    }
    shardBytes.set(shardId, compressed)
    shards.set(shardId, shard)
  }

  // Benchmark only the work performed by an embedded partition load. The
  // verbose audit comparison below allocates much larger objects and performs
  // deep JSON comparisons; interleaving it with one timed sample per ECO made
  // an unrelated audit GC pause look like partition hydration. Three complete
  // samples per partition retain the strict all-500 gate while a median rejects
  // a single scheduler/GC outlier. Browser evidence separately measures the
  // end-to-end wall time, including the HTML-embedded base64 decode.
  const partitionBenchmarks: PartitionBenchmarkResult[] = []
  for (const [eco, receipt] of partitionEntries) {
    const compressed = partitionBytes.get(eco)
    if (!compressed) throw new Error(`Compact partition bytes are missing for ${eco}`)
    const partition = WirePartitionSchema.parse(decodeReceiptJson(compressed, receipt).value)
    const shardBlobs = partition.s.map((id) => {
      const shardReceipt = manifest.shards[id]
      const shardCompressed = shardBytes.get(id)
      if (!shardReceipt || !shardCompressed) throw new Error(`Compact partition ${eco} references missing shard ${id}`)
      return { id, receipt: shardReceipt, compressed: shardCompressed }
    })
    const samples = Array.from({ length: PARTITION_BENCHMARK_SAMPLES }, () =>
      benchmarkPartitionSample({
        eco,
        partitionBlob: { compressed, receipt },
        shardBlobs,
        search,
      }))
    partitionBenchmarks.push({
      eco,
      shardCount: shardBlobs.length,
      compressedBytes: receipt.compressedBytes + shardBlobs.reduce((sum, blob) => sum + blob.receipt.compressedBytes, 0),
      uncompressedBytes: receipt.uncompressedBytes + shardBlobs.reduce((sum, blob) => sum + blob.receipt.uncompressedBytes, 0),
      representative: medianSample(samples),
      sampleTotalMs: samples.map((sample) => sample.totalMs),
    })
  }
  const slowestPartition = partitionBenchmarks.reduce((current, candidate) =>
    candidate.representative.totalMs > current.representative.totalMs ? candidate : current)
  const maximumPartitionLoadMs = slowestPartition.representative.totalMs

  let lines = 0
  let variants = 0
  let drillable = 0
  const engineFens = new Set<string>()
  const partitionPositionEpds = new Set<string>()
  const provenanceIds = new Set<string>()
  const observedShardConsumers = new Map<string, Set<string>>()
  let maximumSelectedShardCount = 0
  let maximumSelectedShardCompressedBytes = 0
  let maximumSelectedShardUncompressedBytes = 0
  const auditProvenance = new Map(audit.provenance.map((entry) => [entry.id, entry]))
  for (const [eco] of partitionEntries) {
    const receipt = manifest.partitions[eco]
    const compressed = partitionBytes.get(eco)
    if (!receipt || !compressed) throw new Error(`Compact partition receipt is missing for ${eco}`)
    const partitionResult = decodeReceiptJson(compressed, receipt)
    const partition = WirePartitionSchema.parse(partitionResult.value)
    if (partition.e !== eco) throw new Error(`Compact partition key mismatch for ${eco}`)
    if (partition.g !== manifest.g || JSON.stringify(partition.m) !== JSON.stringify(audit.engine)) {
      throw new Error(`Compact partition metadata differs from the audit manifest for ${eco}`)
    }
    const evidence = assemblePartitionEvidence({ eco, partition, shards, observedConsumers: observedShardConsumers })
    for (const position of evidence.positions.values()) partitionPositionEpds.add(position[0])
    for (const engine of evidence.engines.values()) engineFens.add(engine[0])
    const selectedShardReceipts = partition.s.map((id) => manifest.shards[id]!)
    maximumSelectedShardCount = Math.max(maximumSelectedShardCount, partition.s.length)
    maximumSelectedShardCompressedBytes = Math.max(
      maximumSelectedShardCompressedBytes,
      selectedShardReceipts.reduce((sum, selectedReceipt) => sum + selectedReceipt.compressedBytes, 0),
    )
    maximumSelectedShardUncompressedBytes = Math.max(
      maximumSelectedShardUncompressedBytes,
      selectedShardReceipts.reduce((sum, selectedReceipt) => sum + selectedReceipt.uncompressedBytes, 0),
    )
    for (const provenance of partition.r) {
      const expected = auditProvenance.get(provenance.id)
      if (!expected || JSON.stringify(expected) !== JSON.stringify(provenance)) {
        throw new Error(`Compact partition provenance differs from the audit manifest for ${provenance.id}`)
      }
      provenanceIds.add(provenance.id)
    }
    const hydrated = hydrateParsedWirePartition({ search, partition, evidence })
    const auditedCompressed = await readFile(join(options.auditDirectory, 'partitions', `${eco}.json.gz`))
    const audited = OpeningPartitionSchema.parse(JSON.parse(gunzipSync(auditedCompressed).toString('utf8')) as unknown)
    compareHydratedToAudit(hydrated, audited)
    for (const line of hydrated.verifiedLines) {
      if (!line.drillEligible) continue
      const sourceLineIndex = sourceLineIndexes.get(line.sourceLineId)
      if (sourceLineIndex === undefined) throw new Error(`Drillable variant ${line.id} has no search source`)
      observedVariantSummaries.push([
        line.id,
        sourceLineIndex,
        line.trainedSide === 'white' ? 0 : 1,
        line.nodes.length,
      ])
    }
    lines += hydrated.lines.length
    variants += hydrated.verifiedLines.length
    drillable += hydrated.verifiedLines.filter((line) => line.drillEligible).length
  }
  for (const [shardId, shard] of shards) {
    const observed = [...(observedShardConsumers.get(shardId) ?? [])]
      .sort((left, right) => left.localeCompare(right, 'en'))
    if (JSON.stringify(observed) !== JSON.stringify(shard.c)) {
      throw new Error(`Evidence shard ${shardId} consumer declarations do not exactly match partition references`)
    }
  }
  if (lines !== 3_790 || variants !== audit.audit.verifiedVariants || drillable !== audit.audit.drillableVariants) {
    throw new Error('Hydrated compact totals do not match the audited release snapshot')
  }
  if (engineFens.size !== manifest.totals.enginePositions || provenanceIds.size !== audit.provenance.length) {
    throw new Error('Partitioned engine or provenance evidence is incomplete')
  }
  if (
    maximumSelectedShardCount !== manifest.totals.maxSelectedEcoShards ||
    maximumSelectedShardCompressedBytes !== manifest.totals.maxSelectedEcoCompressedBytes ||
    maximumSelectedShardUncompressedBytes !== manifest.totals.maxSelectedEcoUncompressedBytes
  ) throw new Error('Selected-ECO evidence locality totals do not reconcile')
  if (maximumSelectedShardCount >= shards.size) {
    throw new Error('At least one ECO selection inflates the entire evidence store')
  }
  observedVariantSummaries.sort((left, right) => left[0].localeCompare(right[0], 'en'))
  if (JSON.stringify(observedVariantSummaries) !== JSON.stringify(search.x)) {
    throw new Error('Search variant card metadata differs from hydrated drillable partitions')
  }
  const gates = {
    blobChecksums: 'pass',
    wireSchemas: 'pass',
    exactShardConsumerReferences: 'pass',
    selectedEcoEvidenceIsLocal: maximumSelectedShardCount < shards.size ? 'pass' : 'fail',
    allPartitionsHydrated: 'pass',
    semanticParityWithAuditSnapshot: 'pass',
    artifactDataBudget: manifest.totals.estimatedBase64Bytes < 6_000_000 ? 'pass' : 'fail',
    partitionLoadUnder500Ms: maximumPartitionLoadMs < 500 ? 'pass' : 'fail',
  }
  const result = Object.values(gates).every((gate) => gate === 'pass') ? 'pass' : 'fail'
  const report = {
    schemaVersion: 2,
    validatedAt: new Date().toISOString(),
    result,
    manifestSha256: sha256(manifestBytes),
    totals: {
      lines,
      variants,
      drillable,
      positions: manifest.totals.positions,
      partitionEvidencePositions: partitionPositionEpds.size,
      enginePositions: engineFens.size,
      evidenceShards: shards.size,
      maxSelectedEcoShards: maximumSelectedShardCount,
      maxSelectedEcoCompressedBytes: maximumSelectedShardCompressedBytes,
      maxSelectedEcoUncompressedBytes: maximumSelectedShardUncompressedBytes,
      compressedBytes: compressedTotal,
      estimatedBase64Bytes: manifest.totals.estimatedBase64Bytes,
    },
    performance: {
      searchDecompressionMs: rounded(searchResult.decompressionMs),
      searchLoadMs: rounded(searchResult.loadMs),
      lazyAuditDecompressionMs: rounded(auditResult.decompressionMs),
      lazyAuditLoadMs: rounded(auditResult.loadMs),
      maximumPartitionLoadMs: rounded(maximumPartitionLoadMs),
      maximumPartitionDecompressionMs: maximumPhase(partitionBenchmarks, 'decompressionMs').milliseconds,
      maximumPartitionHydrationMs: maximumPhase(partitionBenchmarks, 'hydrationMs').milliseconds,
      partitionBenchmark: {
        method: 'maximum of three-sample median for every ECO; selected partition plus only its referenced evidence shards, with in-memory SHA-256, gzip, UTF-8/JSON, Zod, and hydration; excludes filesystem and verbose audit parity',
        samplesPerPartition: PARTITION_BENCHMARK_SAMPLES,
        partitionsMeasured: partitionBenchmarks.length,
        slowest: {
          eco: slowestPartition.eco,
          shardCount: slowestPartition.shardCount,
          compressedBytes: slowestPartition.compressedBytes,
          uncompressedBytes: slowestPartition.uncompressedBytes,
          medianLoadMs: rounded(slowestPartition.representative.totalMs),
          samplesMs: slowestPartition.sampleTotalMs.map(rounded).sort((left, right) => left - right),
        },
        phaseMaximums: {
          checksum: maximumPhase(partitionBenchmarks, 'checksumMs'),
          decompression: maximumPhase(partitionBenchmarks, 'decompressionMs'),
          jsonParse: maximumPhase(partitionBenchmarks, 'jsonParseMs'),
          schemaValidation: maximumPhase(partitionBenchmarks, 'schemaValidationMs'),
          hydration: maximumPhase(partitionBenchmarks, 'hydrationMs'),
          unattributedOverhead: maximumPhase(partitionBenchmarks, 'overheadMs'),
        },
      },
    },
    gates,
  }
  await mkdir(dirname(options.reportPath), { recursive: true })
  await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (report.gates.artifactDataBudget !== 'pass') throw new Error('Compact data exceeds its artifact budget')
  if (report.gates.partitionLoadUnder500Ms !== 'pass') {
    throw new Error(
      `Compact partition load exceeds 500 ms (${report.performance.maximumPartitionLoadMs} ms median observed for ${slowestPartition.eco})`,
    )
  }
  return report
}

const report = await validateAppSnapshot({
  directory: option('--directory', 'data/generated/app-snapshot'),
  auditDirectory: option('--audit-directory', 'data/generated/release'),
  reportPath: option('--report', 'data/generated/app-snapshot/validation-report.json'),
})
process.stdout.write(`Compact snapshot validation passed: ${JSON.stringify(report.totals)}\n`)

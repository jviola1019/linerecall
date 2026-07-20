import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import embeddedSnapshot from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import {
  EmbeddedSnapshotPayloadSchema,
  type EmbeddedBlobReceipt,
  type EmbeddedSnapshotPayload,
} from '../../src/data/embedded-contract.ts'
import {
  WireAppManifestSchema,
  WireEvidenceShardSchema,
  WirePartitionSchema,
  WireSearchSnapshotSchema,
  hydrateParsedWirePartition,
  type WireBlobReceipt,
  type WireEvidenceShard,
  type WirePartition,
} from '../../src/data/wire.ts'
import { DataManifestSchema, OpeningPartitionSchema } from '../../src/domain/opening-data.ts'

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing option ${name}`)
  return resolve(value)
}

function assertSafeOutputRoot(outputRoot: string): void {
  const workspace = resolve('.')
  const selected = resolve(outputRoot)
  const pathFromWorkspace = relative(workspace, selected)
  if (!pathFromWorkspace || pathFromWorkspace.startsWith('..') || resolve(workspace, pathFromWorkspace) !== selected) {
    throw new Error('Review fixture output must be a dedicated directory inside the workspace')
  }
  const normalized = pathFromWorkspace.replaceAll('\\', '/')
  if (normalized !== 'build/review-data' && normalized !== '.cache/review-data') {
    throw new Error('Review fixture output must be exactly build/review-data or .cache/review-data')
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function verifyReceipt(receipt: EmbeddedBlobReceipt, label: string): Buffer {
  const compressed = Buffer.from(receipt.base64, 'base64')
  if (compressed.toString('base64') !== receipt.base64) {
    throw new Error(`${label} is not canonical base64`)
  }
  if (compressed.byteLength !== receipt.compressedBytes) {
    throw new Error(`${label} compressed byte count differs from its receipt`)
  }
  if (sha256(compressed) !== receipt.sha256) {
    throw new Error(`${label} SHA-256 differs from its receipt`)
  }
  const uncompressed = gunzipSync(compressed)
  if (uncompressed.byteLength !== receipt.uncompressedBytes) {
    throw new Error(`${label} uncompressed byte count differs from its receipt`)
  }
  return compressed
}

function parseReceiptJson(receipt: EmbeddedBlobReceipt, label: string): unknown {
  const compressed = verifyReceipt(receipt, label)
  return JSON.parse(gunzipSync(compressed).toString('utf8')) as unknown
}

function manifestReceipt(path: string, receipt: EmbeddedBlobReceipt): WireBlobReceipt {
  return {
    path,
    compressedBytes: receipt.compressedBytes,
    uncompressedBytes: receipt.uncompressedBytes,
    sha256: receipt.sha256,
  }
}

async function writeAtomic(path: string, value: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, value)
  await rename(temporary, path)
}

async function materializeReviewFixture(options: { outputRoot: string }): Promise<void> {
  assertSafeOutputRoot(options.outputRoot)
  const payload = EmbeddedSnapshotPayloadSchema.parse(embeddedSnapshot) as EmbeddedSnapshotPayload
  const appRoot = resolve(options.outputRoot, 'app-snapshot')
  const releaseRoot = resolve(options.outputRoot, 'release')
  await rm(options.outputRoot, { recursive: true, force: true })

  const search = WireSearchSnapshotSchema.parse(parseReceiptJson(payload.blobs.search, 'search blob'))
  const audit = DataManifestSchema.parse(parseReceiptJson(payload.blobs.audit, 'audit blob'))
  if (search.g !== payload.generatedAt || audit.generatedAt !== payload.generatedAt) {
    throw new Error('Embedded search, audit, and envelope timestamps do not match')
  }

  await writeAtomic(resolve(appRoot, 'search.json.gz'), verifyReceipt(payload.blobs.search, 'search blob'))
  await writeAtomic(resolve(appRoot, 'audit.json.gz'), verifyReceipt(payload.blobs.audit, 'audit blob'))

  const parsedShards = new Map<string, WireEvidenceShard>()
  const shardReceipts: Record<string, WireBlobReceipt> = {}
  const engineIndexes = new Set<number>()
  for (const [shardId, receipt] of Object.entries(payload.shards).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    const shard = WireEvidenceShardSchema.parse(parseReceiptJson(receipt, `evidence shard ${shardId}`))
    if (shard.s !== shardId || shard.g !== payload.generatedAt) {
      throw new Error(`Evidence shard ${shardId} has mismatched identity metadata`)
    }
    parsedShards.set(shardId, shard)
    for (const [engineIndex] of shard.a) engineIndexes.add(engineIndex)
    shardReceipts[shardId] = manifestReceipt(`shards/${shardId}.json.gz`, receipt)
    await writeAtomic(resolve(appRoot, 'shards', `${shardId}.json.gz`), verifyReceipt(receipt, `evidence shard ${shardId}`))
  }

  const parsedPartitions = new Map<string, WirePartition>()
  const partitionReceipts: Record<string, WireBlobReceipt> = {}
  const selectedLoads: Array<{ shards: number; compressedBytes: number; uncompressedBytes: number }> = []
  for (const [eco, receipt] of Object.entries(payload.partitions).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    const partition = WirePartitionSchema.parse(parseReceiptJson(receipt, `partition ${eco}`))
    if (partition.e !== eco || partition.g !== payload.generatedAt) {
      throw new Error(`Partition ${eco} has mismatched identity metadata`)
    }
    const selectedReceipts = partition.s.map((shardId) => {
      const selected = payload.shards[shardId]
      if (!selected) throw new Error(`Partition ${eco} references missing shard ${shardId}`)
      return selected
    })
    selectedLoads.push({
      shards: partition.s.length,
      compressedBytes: selectedReceipts.reduce((sum, selected) => sum + selected.compressedBytes, 0),
      uncompressedBytes: selectedReceipts.reduce((sum, selected) => sum + selected.uncompressedBytes, 0),
    })
    parsedPartitions.set(eco, partition)
    partitionReceipts[eco] = manifestReceipt(`partitions/${eco}.json.gz`, receipt)
    await writeAtomic(resolve(appRoot, 'partitions', `${eco}.json.gz`), verifyReceipt(receipt, `partition ${eco}`))
  }

  const blobs = {
    search: manifestReceipt('search.json.gz', payload.blobs.search),
    audit: manifestReceipt('audit.json.gz', payload.blobs.audit),
  }
  const receipts = [...Object.values(blobs), ...Object.values(shardReceipts), ...Object.values(partitionReceipts)]
  const manifest = WireAppManifestSchema.parse({
    v: 2,
    g: payload.generatedAt,
    schema: payload.schema,
    blobs,
    shards: shardReceipts,
    partitions: partitionReceipts,
    totals: {
      lines: search.l.length,
      positions: 7_824,
      enginePositions: engineIndexes.size,
      variants: audit.audit.verifiedVariants,
      shards: Object.keys(shardReceipts).length,
      maxSelectedEcoShards: Math.max(...selectedLoads.map((selected) => selected.shards)),
      maxSelectedEcoCompressedBytes: Math.max(...selectedLoads.map((selected) => selected.compressedBytes)),
      maxSelectedEcoUncompressedBytes: Math.max(...selectedLoads.map((selected) => selected.uncompressedBytes)),
      partitions: Object.keys(partitionReceipts).length,
      compressedBytes: receipts.reduce((sum, receipt) => sum + receipt.compressedBytes, 0),
      estimatedBase64Bytes: receipts.reduce((sum, receipt) => sum + Math.ceil(receipt.compressedBytes / 3) * 4, 0),
    },
  })
  await writeAtomic(resolve(appRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`)

  const a30 = parsedPartitions.get('A30')
  if (!a30) throw new Error('Embedded review snapshot is missing A30')
  const a30Shards = a30.s.map((shardId) => {
    const shard = parsedShards.get(shardId)
    if (!shard) throw new Error(`A30 references missing shard ${shardId}`)
    return shard
  })
  const hydratedA30 = OpeningPartitionSchema.parse(hydrateParsedWirePartition({
    search,
    partition: a30,
    evidence: {
      positions: new Map(a30Shards.flatMap((shard) => shard.p)),
      engines: new Map(a30Shards.flatMap((shard) => shard.a)),
    },
  }))
  const auditedA30 = audit.catalog.find((entry) => entry.eco === 'A30')
  if (!auditedA30) throw new Error('Embedded audit manifest is missing the independent A30 receipt')
  const releaseA30Json = Buffer.from(`${JSON.stringify(hydratedA30)}\n`, 'utf8')
  const releaseA30 = gzipSync(releaseA30Json, { level: 9 })
  if (
    releaseA30Json.byteLength !== auditedA30.uncompressedBytes ||
    releaseA30.byteLength !== auditedA30.compressedBytes ||
    sha256(releaseA30) !== auditedA30.sha256
  ) {
    throw new Error('Hydrated A30 differs from its independently audited release receipt')
  }
  await writeAtomic(resolve(releaseRoot, 'partitions', 'A30.json.gz'), releaseA30)

  process.stdout.write(JSON.stringify({
    outputRoot: options.outputRoot,
    schema: payload.schema,
    partitions: Object.keys(partitionReceipts).length,
    shards: Object.keys(shardReceipts).length,
    a30Lines: hydratedA30.lines.length,
  }) + '\n')
}

await materializeReviewFixture({ outputRoot: option('--output', 'build/review-data') })

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { z } from 'zod'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const ReceiptSchema = z.object({
  path: z.string().min(1),
  compressedBytes: z.number().int().positive(),
  uncompressedBytes: z.number().int().positive(),
  sha256: Sha256Schema,
}).strict()
const ManifestSchema = z.object({
  v: z.literal(2),
  g: z.string().datetime({ offset: true }),
  schema: z.literal('linerecall-app-wire-v2'),
  blobs: z.object({
    search: ReceiptSchema,
    audit: ReceiptSchema,
  }).strict(),
  shards: z.record(z.string().regex(/^s_[a-f0-9]{16}$/u), ReceiptSchema),
  partitions: z.record(z.string().regex(/^[A-E][0-9]{2}$/u), ReceiptSchema),
  totals: z.object({
    lines: z.literal(3_790),
    positions: z.literal(7_824),
    enginePositions: z.number().int().positive(),
    variants: z.number().int().positive(),
    shards: z.number().int().positive(),
    maxSelectedEcoShards: z.number().int().positive(),
    maxSelectedEcoCompressedBytes: z.number().int().positive(),
    maxSelectedEcoUncompressedBytes: z.number().int().positive(),
    partitions: z.literal(500),
    compressedBytes: z.number().int().positive(),
    estimatedBase64Bytes: z.number().int().positive(),
  }).strict(),
}).strict()

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing option ${name}`)
  return resolve(value)
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function verifiedBlob(
  path: string,
  receipt: z.infer<typeof ReceiptSchema>,
): Promise<{ base64: string; compressedBytes: number; uncompressedBytes: number; sha256: string }> {
  const compressed = await readFile(path)
  if (compressed.byteLength !== receipt.compressedBytes) {
    throw new Error(`Compressed byte count differs for ${path}`)
  }
  const actualHash = sha256(compressed)
  if (actualHash !== receipt.sha256) throw new Error(`SHA-256 differs for ${path}`)
  const uncompressed = gunzipSync(compressed)
  if (uncompressed.byteLength !== receipt.uncompressedBytes) {
    throw new Error(`Uncompressed byte count differs for ${path}`)
  }
  return {
    base64: compressed.toString('base64'),
    compressedBytes: compressed.byteLength,
    uncompressedBytes: uncompressed.byteLength,
    sha256: actualHash,
  }
}

export async function embedAppSnapshot(options: {
  inputDirectory: string
  outputPath: string
}): Promise<{ outputPath: string; embeddedBytes: number; compressedBytes: number }> {
  const manifest = ManifestSchema.parse(JSON.parse(
    await readFile(join(options.inputDirectory, 'manifest.json'), 'utf8'),
  ) as unknown)
  const partitionEntries = Object.entries(manifest.partitions)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
  const shardEntries = Object.entries(manifest.shards)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
  if (partitionEntries.length !== 500) throw new Error(`Expected 500 partitions, found ${partitionEntries.length}`)
  if (shardEntries.length !== manifest.totals.shards) {
    throw new Error(`Expected ${manifest.totals.shards} evidence shards, found ${shardEntries.length}`)
  }

  const [search, audit, shards, partitions] = await Promise.all([
    verifiedBlob(join(options.inputDirectory, 'search.json.gz'), manifest.blobs.search),
    verifiedBlob(join(options.inputDirectory, 'audit.json.gz'), manifest.blobs.audit),
    Promise.all(shardEntries.map(async ([shardId, receipt]) => [
      shardId,
      await verifiedBlob(join(options.inputDirectory, 'shards', `${shardId}.json.gz`), receipt),
    ] as const)),
    Promise.all(partitionEntries.map(async ([eco, receipt]) => [
      eco,
      await verifiedBlob(join(options.inputDirectory, 'partitions', `${eco}.json.gz`), receipt),
    ] as const)),
  ])
  const all = [search, audit, ...shards.map(([, blob]) => blob), ...partitions.map(([, blob]) => blob)]
  const compressedBytes = all.reduce((sum, blob) => sum + blob.compressedBytes, 0)
  if (compressedBytes !== manifest.totals.compressedBytes) {
    throw new Error('Embedded compressed byte total does not reconcile with the compact manifest')
  }
  const payload = {
    version: 2,
    generatedAt: manifest.g,
    schema: manifest.schema,
    blobs: { search, audit },
    shards: Object.fromEntries(shards),
    partitions: Object.fromEntries(partitions),
  }
  const source = `${JSON.stringify(payload)}\n`
  await mkdir(dirname(options.outputPath), { recursive: true })
  await writeFile(options.outputPath, source, 'utf8')
  return { outputPath: options.outputPath, embeddedBytes: Buffer.byteLength(source), compressedBytes }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await embedAppSnapshot({
    inputDirectory: option('--input', 'data/generated/app-snapshot'),
    outputPath: option('--output', 'src/generated/embedded-snapshot.json'),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

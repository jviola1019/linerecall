import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readHandleBoundRegularFile } from '../lib/handle-bound-file.ts'
import {
  ImmutableJsonReceiptV1Schema,
  resolveSafeReceiptPath,
  resolveReceiptRoot,
} from '../release/lib/immutable-json-receipt.ts'
import { runFamilyEngineCampaign } from './family-engine-v3.ts'

const OPTIONS = new Set([
  '--receipt-root', '--input', '--output', '--output-prefix', '--engine', '--provision', '--manifest', '--cache',
])

function option(name: string, fallback?: string): string {
  const indexes = process.argv.flatMap((value, index) => value === name ? [index] : [])
  if (indexes.length > 1) throw new Error(`Duplicate option ${name}`)
  const value = indexes[0] === undefined ? fallback : process.argv[indexes[0] + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}

export async function main(): Promise<void> {
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index]!
    if (!value.startsWith('--')) continue
    if (!OPTIONS.has(value)) throw new Error(`Unknown option ${value}`)
    index += 1
  }
  const receiptRoot = resolve(option('--receipt-root', 'data/generated/v3/promotion'))
  const rootReal = await resolveReceiptRoot(receiptRoot)
  const input = option('--input', 'family-engine-campaign-request.json')
  ImmutableJsonReceiptV1Schema.shape.path.parse(input)
  const inputPath = await resolveSafeReceiptPath(rootReal, input)
  const bytes = await readHandleBoundRegularFile(inputPath, 'Family engine campaign request', 2 * 1024 * 1024)
  const requestReceipt = ImmutableJsonReceiptV1Schema.parse({
    path: relative(rootReal, inputPath).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    uncompressedBytes: bytes.byteLength,
    encoding: 'identity',
  })
  const inventory = await runFamilyEngineCampaign({
    receiptRoot,
    requestReceipt,
    outputPath: option('--output', 'engine/family-engine-proof-inventory.json'),
    outputPrefix: option('--output-prefix', 'engine/packs'),
    enginePath: resolve(option('--engine')),
    stockfishManifestPath: resolve(option('--manifest', 'data/manifests/stockfish-18.source.json')),
    provisionReceiptPath: resolve(option('--provision')),
    cacheDirectory: resolve(option('--cache', '.cache/linerecall/family-engine-v3')),
  })
  process.stdout.write(
    `Verified ${inventory.coverage.expectedEdgeProofs} learner-edge proof(s) across ${inventory.coverage.uniqueLearnerPositions} unique position(s).\n`,
  )
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invoked === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`Family Stockfish campaign failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

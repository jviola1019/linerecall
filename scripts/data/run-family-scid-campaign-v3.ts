import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readHandleBoundRegularFile } from '../lib/handle-bound-file.ts'
import { ImmutableJsonReceiptV1Schema, resolveReceiptRoot, resolveSafeReceiptPath } from '../release/lib/immutable-json-receipt.ts'
import { runFamilyScidCampaign } from './family-scid-v3.ts'

const OPTIONS = new Set(['--receipt-root', '--input', '--output', '--scid-eco', '--manifest'])

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
  const input = option('--input', 'scid/family-scid-campaign-request.json')
  ImmutableJsonReceiptV1Schema.shape.path.parse(input)
  const inputPath = await resolveSafeReceiptPath(rootReal, input)
  const bytes = await readHandleBoundRegularFile(inputPath, 'Family Scid campaign request', 2 * 1024 * 1024)
  const requestReceipt = ImmutableJsonReceiptV1Schema.parse({
    path: relative(rootReal, inputPath).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    uncompressedBytes: bytes.byteLength,
    encoding: 'identity',
  })
  const { report } = await runFamilyScidCampaign({
    receiptRoot,
    requestReceipt,
    outputPath: option('--output', 'scid/family-scid-campaign-report.json'),
    scidEcoPath: resolve(option('--scid-eco')),
    scidManifestPath: resolve(option('--manifest', 'data/manifests/scid.source.json')),
  })
  process.stdout.write(`Cross-checked ${report.sampling.selected}/${report.sampling.requiredSampleSize} stratified family line(s); ${report.summary.quarantined} require quarantine.\n`)
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invoked === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`Family Scid campaign failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

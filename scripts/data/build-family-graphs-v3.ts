import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildFamilyGraphCandidatesV3 } from './family-graph-v3-builder.ts'
import { readHandoffBuildInput } from '../release/lib/handoff-build-input.ts'

const ALLOWED_OPTIONS = new Set([
  '--receipt-root',
  '--artifact-root',
  '--output-root',
  '--input',
  '--output',
])

function option(name: string, fallback: string): string {
  const matches = process.argv.flatMap((value, index) => value === name ? [index] : [])
  if (matches.length > 1) throw new Error(`Duplicate option ${name}`)
  const index = matches[0]
  const value = index === undefined ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}

function validateArguments(): void {
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index]!
    if (!value.startsWith('--')) continue
    if (!ALLOWED_OPTIONS.has(value)) throw new Error(`Unknown option ${value}`)
    index += 1
  }
}

export async function main(): Promise<void> {
  validateArguments()
  const receiptRoot = resolve(option('--receipt-root', 'data/generated/v3/handoff'))
  const artifactRoot = resolve(option('--artifact-root', 'data/generated/v3/corpus'))
  const outputRoot = resolve(option('--output-root', 'data/generated/v3/promotion'))
  const inputPath = option('--input', 'family-graph-build-input.json')
  const outputPath = option('--output', 'family-graph-build-output.json')
  const input = await readHandoffBuildInput(receiptRoot, inputPath)
  const result = await buildFamilyGraphCandidatesV3({
    receiptRoot,
    artifactRoot,
    outputRoot,
    outputPath,
    requestValue: input,
  })
  process.stdout.write(
    `Built ${result.output.packs.length} compact-v3 family graph pack(s); manifest ${result.receipt.sha256}.\n`,
  )
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invoked === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`Compact-v3 family graph build failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

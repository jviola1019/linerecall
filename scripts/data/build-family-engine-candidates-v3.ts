import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildFamilyEngineCandidateResourcesV3 } from './family-graph-v3-builder.ts'
import { readHandoffBuildInput } from '../release/lib/handoff-build-input.ts'

const OPTIONS = new Set(['--receipt-root', '--artifact-root', '--output-root', '--input', '--output'])

function option(name: string, fallback: string): string {
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
  const receiptRoot = resolve(option('--receipt-root', 'data/generated/v3/handoff'))
  const artifactRoot = resolve(option('--artifact-root', 'data/generated/v3/corpus'))
  const outputRoot = resolve(option('--output-root', receiptRoot))
  const inputPath = option('--input', 'family-engine-candidate-build-input.json')
  const outputPath = option('--output', 'family-engine-campaign-request.json')
  const input = await readHandoffBuildInput(receiptRoot, inputPath)
  const result = await buildFamilyEngineCandidateResourcesV3({
    receiptRoot,
    artifactRoot,
    outputRoot,
    outputPath,
    requestValue: input,
  })
  process.stdout.write(
    `Prepared ${result.request.candidatePacks.length} exact empirical engine candidate pack(s); request ${result.receipt.sha256}.\n`,
  )
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invoked === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`Family engine candidate build failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

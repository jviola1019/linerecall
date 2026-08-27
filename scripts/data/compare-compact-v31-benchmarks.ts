#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CompactV31MergeReceiptSchema,
  CompactV31RunReceiptSchema,
  type CompactV31MergeReceipt,
  type CompactV31RunReceipt,
} from './compact-v31-contracts.ts'
import { writeCompactV31RepeatabilityBinding } from './compact-v31-executor.ts'
import { readBoundedRegularFile } from './compact-v3-orchestrator.ts'

const MAXIMUM_RECEIPT_BYTES = 64 * 1024 * 1024

interface Arguments {
  firstRun: string
  firstCandidate: string
  firstExact: string
  secondRun: string
  secondCandidate: string
  secondExact: string
  output: string
  comparedAt: string
}

function argumentsFor(argv: readonly string[]): Arguments {
  const options = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--') || options.has(name)) throw new Error(`Invalid option near ${name ?? '<end>'}`)
    options.set(name, value)
  }
  const required = [
    '--first-run', '--first-candidate-merge', '--first-exact-merge',
    '--second-run', '--second-candidate-merge', '--second-exact-merge',
    '--output', '--compared-at',
  ] as const
  for (const name of required) if (!options.get(name)) throw new Error(`Missing ${name}`)
  if (options.size !== required.length) throw new Error('Unknown repeatability option')
  return {
    firstRun: resolve(options.get('--first-run')!),
    firstCandidate: resolve(options.get('--first-candidate-merge')!),
    firstExact: resolve(options.get('--first-exact-merge')!),
    secondRun: resolve(options.get('--second-run')!),
    secondCandidate: resolve(options.get('--second-candidate-merge')!),
    secondExact: resolve(options.get('--second-exact-merge')!),
    output: resolve(options.get('--output')!),
    comparedAt: options.get('--compared-at')!,
  }
}

async function readReceipt<T>(path: string, parse: (value: unknown) => T): Promise<{ value: T; sha256: string }> {
  const bytes = await readBoundedRegularFile(path, MAXIMUM_RECEIPT_BYTES, 'Compact-v3.1 comparison receipt', 1)
  const value = parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
  const canonical = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (!bytes.equals(canonical)) throw new Error(`Receipt is not canonical JSON: ${path}`)
  return { value, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function main(): Promise<void> {
  const args = argumentsFor(process.argv.slice(2))
  const firstRun = await readReceipt<CompactV31RunReceipt>(args.firstRun, (value) => CompactV31RunReceiptSchema.parse(value))
  const secondRun = await readReceipt<CompactV31RunReceipt>(args.secondRun, (value) => CompactV31RunReceiptSchema.parse(value))
  const firstCandidate = await readReceipt<CompactV31MergeReceipt>(args.firstCandidate, (value) => CompactV31MergeReceiptSchema.parse(value))
  const firstExact = await readReceipt<CompactV31MergeReceipt>(args.firstExact, (value) => CompactV31MergeReceiptSchema.parse(value))
  const secondCandidate = await readReceipt<CompactV31MergeReceipt>(args.secondCandidate, (value) => CompactV31MergeReceiptSchema.parse(value))
  const secondExact = await readReceipt<CompactV31MergeReceipt>(args.secondExact, (value) => CompactV31MergeReceiptSchema.parse(value))
  const result = await writeCompactV31RepeatabilityBinding({
    first: { receipt: firstRun.value, receiptSha256: firstRun.sha256, path: args.firstRun },
    second: { receipt: secondRun.value, receiptSha256: secondRun.sha256, path: args.secondRun },
    firstCandidateMerge: firstCandidate.value,
    firstExactMerge: firstExact.value,
    secondCandidateMerge: secondCandidate.value,
    secondExactMerge: secondExact.value,
    outputPath: args.output,
    comparedAt: args.comparedAt,
    maximumBytes: MAXIMUM_RECEIPT_BYTES,
  })
  process.stdout.write(`${JSON.stringify({
    result: result.binding.result,
    output: result.path,
    sha256: result.sha256,
    releaseEligible: false,
  }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Compact-v3.1 comparison failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

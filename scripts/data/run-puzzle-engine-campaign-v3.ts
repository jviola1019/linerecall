#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PuzzleV3CandidateManifestV1Schema } from './puzzle-v3-contracts.ts'
import { ImmutableJsonReceiptV1Schema, resolveReceiptRoot, resolveSafeReceiptPath } from '../release/lib/immutable-json-receipt.ts'
import { readHandleBoundRegularFile } from '../lib/handle-bound-file.ts'
import { runPuzzleEngineCampaign } from './puzzle-engine-v3.ts'

const MAX_CONTROL_FILE_BYTES = 4 * 1024 * 1024

const OPTIONS = new Set([
  '--receipt-root', '--candidates', '--engine', '--manifest', '--provision', '--campaign', '--output', '--now',
])

function option(name: string, fallback?: string): string {
  const indexes = process.argv.flatMap((value, index) => value === name ? [index] : [])
  if (indexes.length > 1) throw new Error(`Duplicate option ${name}`)
  const index = indexes[0]
  const value = index === undefined ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}

function optionalOption(name: string): string | undefined {
  const indexes = process.argv.flatMap((value, index) => value === name ? [index] : [])
  if (indexes.length > 1) throw new Error(`Duplicate option ${name}`)
  const index = indexes[0]
  if (index === undefined) return undefined
  const value = process.argv[index + 1]
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
  const receiptRoot = resolve(option('--receipt-root', '.'))
  const root = await resolveReceiptRoot(receiptRoot)
  const candidateManifestPath = option('--candidates')
  const relativeManifest = candidateManifestPath.replaceAll('\\', '/')
  ImmutableJsonReceiptV1Schema.shape.path.parse(relativeManifest)
  const manifestPath = await resolveSafeReceiptPath(root, relativeManifest)
  const manifestBytes = await readHandleBoundRegularFile(manifestPath, 'Puzzle candidate manifest', MAX_CONTROL_FILE_BYTES)
  const manifest = PuzzleV3CandidateManifestV1Schema.parse(JSON.parse(manifestBytes.toString('utf8')) as unknown)
  const campaignPath = resolve(option('--campaign'))
  const receipt = ImmutableJsonReceiptV1Schema.parse({
    path: relativeManifest,
    bytes: manifestBytes.byteLength,
    uncompressedBytes: manifestBytes.byteLength,
    sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    encoding: 'identity',
  })
  const runOptions: Parameters<typeof runPuzzleEngineCampaign>[0] = {
    receiptRoot,
    candidateManifestReceipt: receipt,
    enginePath: resolve(option('--engine')),
    stockfishManifestPath: resolve(option('--manifest', 'data/manifests/stockfish-18.source.json')),
    provisionReceiptPath: resolve(option('--provision')),
    engineCampaignPath: campaignPath,
    outputPath: option('--output', 'data/generated/v3/puzzles/proof-inventory.json'),
  }
  const now = optionalOption('--now')
  if (now !== undefined) runOptions.now = () => new Date(now)
  const inventory = await runPuzzleEngineCampaign(runOptions)
  process.stdout.write(`Verified ${inventory.shards.reduce((total, shard) => total + shard.verified.length, 0)} puzzle candidate(s)\n`)
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invoked === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`Puzzle Stockfish campaign failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

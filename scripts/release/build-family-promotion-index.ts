import { resolve } from 'node:path'
import { buildFamilyPromotionIndex } from './lib/family-promotion-index-builder.ts'
import { commandOption, readHandoffBuildInput } from './lib/handoff-build-input.ts'

const root = resolve(commandOption('--root', '.'))
const inputPath = commandOption('--input', 'data/generated/v3/family-promotion-build-input.json')
const outputPath = commandOption('--output', 'data/generated/v3/family-promotion-index.json')
const input = await readHandoffBuildInput(root, inputPath)
const result = await buildFamilyPromotionIndex({ root, outputPath, input })
process.stdout.write(`${JSON.stringify({
  outputPath: result.outputPath,
  bytes: result.bytes,
  sha256: result.sha256,
  releaseId: result.index.releaseId,
  families: result.audit.counts.families,
  packs: result.audit.counts.packs,
  paths: result.audit.counts.paths,
  eligibleEdges: result.audit.counts.eligibleEdges,
  puzzleShards: result.audit.counts.puzzleShards,
  puzzles: result.audit.counts.puzzles,
})}\n`)

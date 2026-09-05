import { resolve } from 'node:path'
import { buildProductionAppSnapshotManifest } from './lib/production-app-snapshot-builder.ts'
import { commandOption, readHandoffBuildInput } from './lib/handoff-build-input.ts'

const root = resolve(commandOption('--root', '.'))
const inputPath = commandOption('--input', 'data/generated/v3/production-app-snapshot-build-input.json')
const outputPath = commandOption('--output', 'data/generated/v3/app-snapshot-manifest.json')
const input = await readHandoffBuildInput(root, inputPath)
const result = await buildProductionAppSnapshotManifest({ root, outputPath, input })

process.stdout.write(`${JSON.stringify({
  outputPath: result.outputPath,
  bytes: result.bytes,
  sha256: result.sha256,
  releaseId: result.manifest.releaseId,
  families: result.manifest.totals.families,
  packs: result.manifest.totals.packs,
  graphs: result.manifest.totals.graphs,
  puzzleShards: result.manifest.totals.puzzleShards,
  familyResources: result.manifest.totals.familyResources,
})}\n`)

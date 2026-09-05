import { resolve } from 'node:path'
import { buildProductionDataReadiness } from './lib/production-data-readiness-builder.ts'
import { commandOption, readHandoffBuildInput } from './lib/handoff-build-input.ts'

const root = resolve(commandOption('--root', '.'))
const inputPath = commandOption('--input', 'data/generated/v3/production-readiness-build-input.json')
const outputPath = commandOption('--output', 'data/generated/v3/production-data-readiness.json')
const input = await readHandoffBuildInput(root, inputPath)
const result = await buildProductionDataReadiness({ root, outputPath, input })
process.stdout.write(`${JSON.stringify({
  outputPath: result.outputPath,
  bytes: result.bytes,
  sha256: result.sha256,
  releaseId: result.readiness.releaseId,
  auditedAt: result.readiness.auditedAt,
})}\n`)

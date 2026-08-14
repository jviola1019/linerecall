import { resolve } from 'node:path'
import { z } from 'zod'
import { embedProductionAppSnapshot } from './embed-app-snapshot.ts'
import { commandOption, readHandoffBuildInput } from '../release/lib/handoff-build-input.ts'
import { ImmutableJsonReceiptV1Schema } from '../release/lib/immutable-json-receipt.ts'

const ProductionEmbedInputV1Schema = z.object({
  schemaVersion: z.literal(1),
  appManifest: ImmutableJsonReceiptV1Schema,
}).strict()

const root = resolve(commandOption('--root', '.'))
const inputPath = commandOption('--input', 'data/generated/v3/production-embed-input.json')
const browseInputDirectory = resolve(root, commandOption('--browse-input', 'data/generated/app-snapshot'))
const outputPath = resolve(root, commandOption('--output', 'build/production/embedded-snapshot.json'))
const input = ProductionEmbedInputV1Schema.parse(await readHandoffBuildInput(root, inputPath))
const result = await embedProductionAppSnapshot({
  root,
  appManifestReceipt: input.appManifest,
  browseInputDirectory,
  outputPath,
})

process.stdout.write(`${JSON.stringify(result)}\n`)

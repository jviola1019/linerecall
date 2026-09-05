import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadApprovedManifest } from './ingest-taxonomy.ts'
import { buildPinnedTaxonomyInventory } from './taxonomy-inventory.ts'
import { writeImmutableJsonCandidate } from '../release/lib/immutable-json-receipt.ts'

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

const root = resolve(option('--root', '.'))
const manifestPath = option('--manifest', 'data/manifests/taxonomy.source.json')
const sourceDirectory = resolve(root, option('--source-directory', '.cache/taxonomy/17ee660257de02870636f36248e919f2e01d8e85'))
const outputPath = option('--output', 'data/manifests/taxonomy.inventory.v1.json')
const manifest = await loadApprovedManifest(resolve(root, manifestPath))
const sourceBytes = new Map(await Promise.all(manifest.files.map(async (file) =>
  [file.path, new Uint8Array(await readFile(resolve(sourceDirectory, file.path)))] as const)))
const inventory = buildPinnedTaxonomyInventory({ manifest, sourceBytes })
const candidate = await writeImmutableJsonCandidate({ root, outputPath, value: inventory })
await candidate.promote()
process.stdout.write(`${JSON.stringify({ outputPath, sha256: candidate.sha256, bytes: candidate.bytes, rows: inventory.rows.length })}\n`)

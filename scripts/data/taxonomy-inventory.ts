import { createHash } from 'node:crypto'
import { z } from 'zod'
import { TaxonomySourceManifestSchema, type TaxonomySourceManifest } from '../../src/data/taxonomy-schema.ts'
import { EcoCodeSchema } from '../../src/domain/opening-data.ts'
import { FamilyIdSchema, TaxonomyLineIdSchema } from '../../src/domain/opening-family.ts'
import {
  assertManifestApproved,
  normalizeTaxonomyRow,
  parseTaxonomyTsv,
  verifySourceBytes,
} from './ingest-taxonomy.ts'
import { deriveOpeningFamilySeeds } from './opening-family-registry.ts'

export const PINNED_TAXONOMY_COMMIT = '17ee660257de02870636f36248e919f2e01d8e85'
export const PINNED_TAXONOMY_LINE_COUNT = 3_790
export const PINNED_TAXONOMY_ECO_COUNT = 500
export const PINNED_TAXONOMY_FAMILY_COUNT = 149
/** SHA-256 of the schema-normalized compact JSON value plus one LF. */
export const PINNED_TAXONOMY_INVENTORY_SHA256 = 'af212bc760e2d34875e0711428c81d52357d6e9f1c37a89c3f019780f2416e19'

export const PINNED_TAXONOMY_SOURCE_FILES = [
  { volume: 'A', path: 'a.tsv', bytes: 66_338, rows: 817, sha256: '41722fa3d44f294357326fe2ca1b956d9e56490b30efcfa68db61114c9df7e10' },
  { volume: 'B', path: 'b.tsv', bytes: 77_005, rows: 769, sha256: '28d5c2dfc3329d70e85be2a149d001a59e47c2176c9d2c6594eb3be88128a3fc' },
  { volume: 'C', path: 'c.tsv', bytes: 131_820, rows: 1_246, sha256: 'e90f063b3a04f5fbb24425682b13f574141a266a1ba877974cdd9c6595a3d942' },
  { volume: 'D', path: 'd.tsv', bytes: 67_414, rows: 602, sha256: '842f4b9e883d52a4b6ac51de45c336d6322852f0488fc307f1ac00dbde269906' },
  { volume: 'E', path: 'e.tsv', bytes: 42_664, rows: 356, sha256: 'b392f3b04bc7c7f0c028e601daea613007f26edce4fcdfd7ccda70d8cf078cf5' },
] as const

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const CanonicalBase64Schema = z.string().min(1).max(1_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/u)

const PinnedSourceFileSchema = z.object({
  volume: z.enum(['A', 'B', 'C', 'D', 'E']),
  path: z.enum(['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv']),
  bytes: z.number().int().positive().max(1_000_000),
  rows: z.number().int().positive().max(2_000),
  sha256: Sha256Schema,
  base64: CanonicalBase64Schema,
}).strict()

const TaxonomyInventoryRowV1Schema = z.object({
  id: TaxonomyLineIdSchema,
  eco: EcoCodeSchema,
  name: z.string().min(1).max(256),
  pgn: z.string().min(1).max(4_096),
  uci: z.array(z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u)).min(1).max(200),
  sourceFile: z.enum(['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv']),
  sourceRow: z.number().int().min(2).max(2_000),
  sourceSha256: Sha256Schema,
  proposedPrimaryFamilyId: FamilyIdSchema,
}).strict()

const ProposedFamilyOwnershipV1Schema = z.object({
  familyId: FamilyIdSchema,
  canonicalName: z.string().min(1).max(256),
  taxonomyLineIds: z.array(TaxonomyLineIdSchema).min(1).max(PINNED_TAXONOMY_LINE_COUNT),
}).strict()

export const PinnedTaxonomyInventoryV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-pinned-taxonomy-inventory'),
  sourceId: z.literal('lichess-chess-openings'),
  sourceCommit: z.literal(PINNED_TAXONOMY_COMMIT),
  licenseSpdxId: z.literal('CC0-1.0'),
  sourceFiles: z.array(PinnedSourceFileSchema).length(5),
  taxonomyLineCount: z.literal(PINNED_TAXONOMY_LINE_COUNT),
  ecoCodeCount: z.literal(PINNED_TAXONOMY_ECO_COUNT),
  proposedFamilyCount: z.literal(PINNED_TAXONOMY_FAMILY_COUNT),
  rows: z.array(TaxonomyInventoryRowV1Schema).length(PINNED_TAXONOMY_LINE_COUNT),
  proposedFamilies: z.array(ProposedFamilyOwnershipV1Schema).length(PINNED_TAXONOMY_FAMILY_COUNT),
}).strict()

export type PinnedTaxonomyInventoryV1 = z.infer<typeof PinnedTaxonomyInventoryV1Schema>

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function decodeCanonicalBase64(value: string, path: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error(`${path}: source bytes are not canonical base64`)
  return bytes
}

function assertPinnedManifest(manifest: TaxonomySourceManifest): void {
  assertManifestApproved(manifest)
  if (
    manifest.source.id !== 'lichess-chess-openings'
    || manifest.source.commit !== PINNED_TAXONOMY_COMMIT
    || manifest.license.spdxId !== 'CC0-1.0'
    || manifest.format.expectedRows !== PINNED_TAXONOMY_LINE_COUNT
    || manifest.format.expectedEcoCodes !== PINNED_TAXONOMY_ECO_COUNT
    || manifest.files.length !== 5
  ) throw new Error('Taxonomy inventory requires the exact approved Lichess source manifest')
  if (manifest.files.some((file, index) => {
    const expected = PINNED_TAXONOMY_SOURCE_FILES[index]
    return !expected || file.volume !== expected.volume || file.path !== expected.path
      || file.bytes !== expected.bytes || file.rows !== expected.rows || file.sha256 !== expected.sha256
      || file.url !== `https://raw.githubusercontent.com/lichess-org/chess-openings/${PINNED_TAXONOMY_COMMIT}/${expected.path}`
  })) {
    throw new Error('Taxonomy inventory source files differ from the exact pinned A-E TSV receipts')
  }
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

let canonicalInventoryRevalidated = false

export function buildPinnedTaxonomyInventory(options: {
  manifest: unknown
  sourceBytes: ReadonlyMap<string, Uint8Array>
}): PinnedTaxonomyInventoryV1 {
  const manifest = TaxonomySourceManifestSchema.parse(options.manifest)
  assertPinnedManifest(manifest)
  const normalizedRows = []
  const sourceFiles: z.infer<typeof PinnedSourceFileSchema>[] = []
  for (const file of manifest.files) {
    const bytes = options.sourceBytes.get(file.path)
    if (!bytes) throw new Error(`Taxonomy inventory is missing pinned source bytes for ${file.path}`)
    verifySourceBytes(bytes, file)
    sourceFiles.push({
      volume: file.volume,
      path: file.path as 'a.tsv' | 'b.tsv' | 'c.tsv' | 'd.tsv' | 'e.tsv',
      bytes: file.bytes,
      rows: file.rows,
      sha256: file.sha256,
      base64: Buffer.from(bytes).toString('base64'),
    })
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const rows = parseTaxonomyTsv(text, file)
    normalizedRows.push(...rows.map((row) => normalizeTaxonomyRow(row, manifest, '1970-01-01T00:00:00.000Z')))
  }
  if (normalizedRows.length !== PINNED_TAXONOMY_LINE_COUNT) throw new Error('Pinned taxonomy row total is incomplete')
  if (new Set(normalizedRows.map(({ id }) => id)).size !== PINNED_TAXONOMY_LINE_COUNT) {
    throw new Error('Pinned taxonomy IDs are not unique')
  }
  if (new Set(normalizedRows.map(({ eco }) => eco)).size !== PINNED_TAXONOMY_ECO_COUNT) {
    throw new Error('Pinned taxonomy does not cover all 500 ECO codes')
  }
  const seeds = deriveOpeningFamilySeeds(normalizedRows)
  if (seeds.length !== PINNED_TAXONOMY_FAMILY_COUNT) {
    throw new Error(`Pinned taxonomy produced ${seeds.length} proposed families instead of 149`)
  }
  const ownerByLineId = new Map(seeds.flatMap((family) =>
    family.taxonomyLineIds.map((id) => [id, family.id] as const)))
  if (ownerByLineId.size !== PINNED_TAXONOMY_LINE_COUNT) {
    throw new Error('Proposed family ownership does not cover every pinned taxonomy row once')
  }
  const rows = normalizedRows.map((line) => ({
    id: line.id,
    eco: line.eco,
    name: line.name,
    pgn: line.pgn,
    uci: line.uci,
    sourceFile: line.provenance.sourceFile as 'a.tsv' | 'b.tsv' | 'c.tsv' | 'd.tsv' | 'e.tsv',
    sourceRow: line.provenance.sourceRow,
    sourceSha256: line.provenance.sourceSha256,
    proposedPrimaryFamilyId: ownerByLineId.get(line.id)!,
  }))
  return PinnedTaxonomyInventoryV1Schema.parse({
    schemaVersion: 1,
    kind: 'linerecall-pinned-taxonomy-inventory',
    sourceId: manifest.source.id,
    sourceCommit: manifest.source.commit,
    licenseSpdxId: manifest.license.spdxId,
    sourceFiles,
    taxonomyLineCount: rows.length,
    ecoCodeCount: new Set(rows.map(({ eco }) => eco)).size,
    proposedFamilyCount: seeds.length,
    rows,
    proposedFamilies: seeds.map((family) => ({
      familyId: family.id,
      canonicalName: family.canonicalName,
      taxonomyLineIds: family.taxonomyLineIds,
    })).sort((left, right) => left.familyId.localeCompare(right.familyId, 'en')),
  })
}

/**
 * Reopens the embedded pinned bytes and derives every ID, field, legal move,
 * and mechanical family owner again. A self-consistent forged row list cannot
 * pass without also producing the five already-approved SHA-256 source bytes.
 */
export function validatePinnedTaxonomyInventory(
  input: unknown,
  manifestInput: unknown,
): PinnedTaxonomyInventoryV1 {
  const inventory = PinnedTaxonomyInventoryV1Schema.parse(input)
  const manifest = TaxonomySourceManifestSchema.parse(manifestInput)
  assertPinnedManifest(manifest)
  const inventoryDigest = sha256(`${JSON.stringify(inventory)}\n`)
  if (inventoryDigest !== PINNED_TAXONOMY_INVENTORY_SHA256) {
    throw new Error(`Taxonomy inventory digest differs from the pinned derived inventory: ${inventoryDigest}`)
  }
  if (canonicalInventoryRevalidated) return inventory
  const sourceBytes = new Map<string, Uint8Array>()
  for (const [index, expected] of manifest.files.entries()) {
    const actual = inventory.sourceFiles[index]
    if (
      !actual || actual.volume !== expected.volume || actual.path !== expected.path
      || actual.bytes !== expected.bytes || actual.rows !== expected.rows || actual.sha256 !== expected.sha256
    ) throw new Error(`Pinned taxonomy source receipt differs for ${expected.path}`)
    const bytes = decodeCanonicalBase64(actual.base64, expected.path)
    verifySourceBytes(bytes, expected)
    sourceBytes.set(expected.path, bytes)
  }
  const derived = buildPinnedTaxonomyInventory({ manifest, sourceBytes })
  if (sha256(`${JSON.stringify(derived)}\n`) !== sha256(`${JSON.stringify(inventory)}\n`)) {
    throw new Error('Taxonomy inventory differs from the rows re-derived from pinned TSV bytes')
  }
  for (const [index, row] of inventory.rows.entries()) {
    const expected = derived.rows[index]!
    if (
      row.id !== expected.id || row.eco !== expected.eco || row.name !== expected.name
      || row.pgn !== expected.pgn || !sameOrderedStrings(row.uci, expected.uci)
      || row.sourceFile !== expected.sourceFile || row.sourceRow !== expected.sourceRow
      || row.sourceSha256 !== expected.sourceSha256
      || row.proposedPrimaryFamilyId !== expected.proposedPrimaryFamilyId
    ) throw new Error(`Taxonomy row ${index} differs from pinned TSV derivation`)
  }
  canonicalInventoryRevalidated = true
  return inventory
}

export function assertExactTaxonomyPrimaryOwnership(options: {
  inventory: PinnedTaxonomyInventoryV1
  actualOwnership: ReadonlyMap<string, string>
}): void {
  const expectedIds = new Set(options.inventory.rows.map(({ id }) => id))
  if (options.actualOwnership.size !== expectedIds.size) {
    throw new Error(`Primary taxonomy ownership has ${options.actualOwnership.size} rows; expected ${expectedIds.size}`)
  }
  for (const id of expectedIds) {
    if (!options.actualOwnership.has(id)) throw new Error(`Primary taxonomy ownership is missing pinned row ${id}`)
  }
  for (const id of options.actualOwnership.keys()) {
    if (!expectedIds.has(id)) throw new Error(`Primary taxonomy ownership contains unknown row ${id}`)
  }
}

export function assertExactProposedFamilyOwnership(options: {
  inventory: PinnedTaxonomyInventoryV1
  decisions: readonly { candidateFamilyId: string; candidateTaxonomyLineIds: readonly string[] }[]
}): void {
  const actual = new Map(options.decisions.map((decision) => [decision.candidateFamilyId, decision.candidateTaxonomyLineIds]))
  if (actual.size !== options.inventory.proposedFamilies.length || actual.size !== options.decisions.length) {
    throw new Error('Editorial candidate-family inventory does not contain the exact 149 pinned proposals')
  }
  for (const expected of options.inventory.proposedFamilies) {
    const ids = actual.get(expected.familyId)
    if (!ids || !sameOrderedStrings(ids, expected.taxonomyLineIds)) {
      throw new Error(`Editorial candidate ownership differs for ${expected.familyId}`)
    }
  }
}

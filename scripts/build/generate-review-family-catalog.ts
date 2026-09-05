import { mkdir, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import embeddedSnapshot from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import { deriveOpeningFamilySeeds } from '../data/opening-family-registry.ts'
import { ReviewOpeningFamilyCatalogV1Schema } from '../../src/data/review-family-catalog.ts'
import { createPendingOpeningFamilyEditorialLedger } from '../data/opening-family-editorial.ts'
import { buildOpeningFamilyEditorialAudit } from '../data/opening-family-editorial-audit.ts'
import { WireSearchSnapshotSchema } from '../../src/data/wire.ts'
import { DataManifestSchema } from '../../src/domain/opening-data.ts'

const search = WireSearchSnapshotSchema.parse(JSON.parse(
  gunzipSync(Buffer.from(embeddedSnapshot.blobs.search.base64, 'base64')).toString('utf8'),
))
const audit = DataManifestSchema.parse(JSON.parse(
  gunzipSync(Buffer.from(embeddedSnapshot.blobs.audit.base64, 'base64')).toString('utf8'),
))
const rows = search.l.map(([sourceLineId, eco, name]) => ({ sourceLineId, eco, name }))
const seeds = deriveOpeningFamilySeeds(rows)
const variantsByTaxonomy = new Map<string, Array<{ side: 'white' | 'black'; cardCount: number }>>()
for (const [, sourceLineIndex, sideIndex, cardCount] of search.x) {
  const taxonomyLineId = search.l[sourceLineIndex]?.[0]
  if (!taxonomyLineId) throw new Error(`Variant references missing taxonomy row ${sourceLineIndex}`)
  const variants = variantsByTaxonomy.get(taxonomyLineId) ?? []
  variants.push({ side: sideIndex === 0 ? 'white' : 'black', cardCount })
  variantsByTaxonomy.set(taxonomyLineId, variants)
}

const catalog = ReviewOpeningFamilyCatalogV1Schema.parse({
  schemaVersion: 1,
  generatedAt: search.g,
  taxonomyCommit: audit.taxonomy.commit,
  taxonomyLineCount: 3_790,
  familyCount: seeds.length,
  families: seeds.map((seed) => {
    const variants = seed.taxonomyLineIds.flatMap((lineId) => variantsByTaxonomy.get(lineId) ?? [])
    return {
      schemaVersion: 1,
      id: seed.id,
      canonicalName: seed.canonicalName,
      aliases: seed.aliases,
      ecoCodes: seed.ecoCodes,
      taxonomyLineIds: seed.taxonomyLineIds,
      availableSides: [...new Set(variants.map(({ side }) => side))].sort(),
      legacyVariantCount: variants.length,
      legacyCardCount: variants.reduce((total, variant) => total + variant.cardCount, 0),
      maximumLegacyLineCards: variants.reduce((maximum, variant) => Math.max(maximum, variant.cardCount), 0),
      graphStatus: 'not-promoted',
    }
  }),
})

const target = resolve('src/generated/review-family-catalog.json')
await writeFile(target, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
const editorialTarget = resolve('data/manifests/opening-family-editorial.proposal.json')
const editorialProposal = createPendingOpeningFamilyEditorialLedger(catalog)
await writeFile(editorialTarget, `${JSON.stringify(editorialProposal, null, 2)}\n`, 'utf8')
const editorialAuditTarget = resolve('audit/generated/opening-family-editorial.audit.json')
const editorialAudit = buildOpeningFamilyEditorialAudit({
  ledger: editorialProposal,
  taxonomyRows: rows,
})
await mkdir(resolve('audit/generated'), { recursive: true })
await writeFile(editorialAuditTarget, `${JSON.stringify(editorialAudit, null, 2)}\n`, 'utf8')
process.stdout.write(`Wrote ${catalog.familyCount} opening families covering ${catalog.taxonomyLineCount} taxonomy rows to ${target}; the editorial ledger remains pending at ${editorialTarget}, with deterministic review triage at ${editorialAuditTarget}\n`)

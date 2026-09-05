import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Chess } from 'chess.js'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import { PinnedTaxonomyInventoryV1Schema } from '../../scripts/data/taxonomy-inventory.ts'
import { TaxonomySourceManifestSchema } from '../../src/data/taxonomy-schema.ts'
import { CompactV31ProductionExactEdgeRowSchema } from '../../scripts/data/compact-v31-production-contracts.ts'
import { deriveCompactV31FamilyHandoff } from '../../scripts/data/compact-v31-family-handoff.ts'
import { createSyntheticApprovedEditorialLedger } from '../fixtures/synthetic-editorial-ledger.ts'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const move = (value: string) => ({ from: value.slice(0, 2), to: value.slice(2, 4), ...(value.length > 4 ? { promotion: value[4] } : {}) })

test('v3.1 family handoff keeps proposal review separate from canonical merge/split counts', async () => {
  const inventory = PinnedTaxonomyInventoryV1Schema.parse(JSON.parse(await readFile('data/manifests/taxonomy.inventory.v1.json', 'utf8')) as unknown)
  const manifest = TaxonomySourceManifestSchema.parse(JSON.parse(await readFile('data/manifests/taxonomy.source.json', 'utf8')) as unknown)
  const families = inventory.proposedFamilies.map((family) => ({ id: family.familyId, canonicalName: family.canonicalName, aliases: [], ecoCodes: [...new Set(inventory.rows.filter((row) => family.taxonomyLineIds.includes(row.id)).map((row) => row.eco))], taxonomyLineIds: [...family.taxonomyLineIds] }))
  const ledger = createSyntheticApprovedEditorialLedger({ releaseId: 'fixture-editorial-v31', families })
  const target = families.find((family) => family.taxonomyLineIds.length === 1)!
  const line = inventory.rows.find((row) => row.id === target.taxonomyLineIds[0])!
  const chess = new Chess()
  for (const token of line.uci) chess.move(move(token))
  const rootEpd = normalizedEpd(chess)
  const next = chess.moves({ verbose: true }).sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`))[0]!
  const nextUci = `${next.from}${next.to}${next.promotion ?? ''}`
  const after = new Chess(chess.fen()); after.move(next)
  const row = CompactV31ProductionExactEdgeRowSchema.parse({
    edgeId: `edge_${hash(`${rootEpd}:${nextUci}`).slice(0, 16)}`, fromEpdSha256: hash(rootEpd), toEpdSha256: hash(normalizedEpd(after)), uci: nextUci,
    sampleSize: 499, cells: [{ ratingSystem: 'broadcast-rating', timeControl: 'classical', ratingBand: '2400+', whiteWins: 249, draws: 1, blackWins: 249, n: 499 }],
  })
  const next2 = after.moves({ verbose: true }).sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`))[0]!
  const next2Uci = `${next2.from}${next2.to}${next2.promotion ?? ''}`
  const after2 = new Chess(after.fen()); after2.move(next2)
  const continuation = CompactV31ProductionExactEdgeRowSchema.parse({
    edgeId: `edge_${hash(`${normalizedEpd(after)}:${next2Uci}`).slice(0, 16)}`, fromEpdSha256: hash(normalizedEpd(after)), toEpdSha256: hash(normalizedEpd(after2)), uci: next2Uci,
    sampleSize: 500, cells: [{ ratingSystem: 'broadcast-rating', timeControl: 'classical', ratingBand: '2400+', whiteWins: 250, draws: 0, blackWins: 250, n: 500 }],
  })
  const binding = { corpus: 'lichess-broadcasts' as const, corpusReceiptSha256: hash('broadcast-receipt'), sourceManifestSha256: hash('broadcast-source'), exactMergeReceiptSha256: hash('broadcast-merge'), sourceEdgeInventorySha256: hash('broadcast-edges') }
  const q2Binding = { corpus: 'lichess-standard-rated-q2-2026' as const, corpusReceiptSha256: hash('q2-receipt'), sourceManifestSha256: hash('q2-source'), exactMergeReceiptSha256: hash('q2-merge'), sourceEdgeInventorySha256: hash('q2-edges') }
  const result = await deriveCompactV31FamilyHandoff({ releaseId: 'release_fixture-v31', taxonomyInventory: inventory, taxonomyManifest: manifest, editorialLedger: ledger, corpusBindings: [binding, q2Binding], exactRows: [{ corpus: binding.corpus, rows: [row, continuation] }, { corpus: q2Binding.corpus, rows: [{ ...row, cells: [{ ...row.cells[0], ratingSystem: 'lichess-glicko2' }] }, { ...continuation, cells: [{ ...continuation.cells[0], ratingSystem: 'lichess-glicko2' }] }] }], rootHints: [{ familyId: target.id, side: rootEpd.split(' ')[1] === 'w' ? 'white' : 'black', rootEpd }] })
  assert.equal(result.index.familyDispositions?.length, 298)
  const root = result.rootInventories.find((entry) => entry.familyId === target.id && entry.rootEpd === rootEpd)!
  assert.deepEqual(root.bookEdgeIds, [continuation.edgeId])
  assert.deepEqual(root.exploratoryEdgeIds, [row.edgeId])
  assert.deepEqual(root.eligibleEdgeIds, [continuation.edgeId, row.edgeId].sort())
  assert.equal(result.index.taxonomyInventorySha256.length, 64)
  assert.equal(result.index.editorialLedgerSha256.length, 64)
  assert.equal(result.index.proposedFamilyCount, 149)
  assert.equal(result.index.familyCount, 149)
  assert.equal(new Set(result.index.familyDispositions?.map(({ familyId }) => familyId)).size, 149)

  const mergeSource = families.slice(0, 2)
  const mergeFamilies = [{
    ...mergeSource[0]!,
    id: 'merged-alekhine-amar',
    canonicalName: 'Merged Alekhine Amar',
    taxonomyLineIds: [...mergeSource[0]!.taxonomyLineIds, ...mergeSource[1]!.taxonomyLineIds],
  }, ...families.slice(2)]
  const splitSource = families[0]!
  const splitFamilies = [{
    ...splitSource,
    id: 'alekhine-defense-main',
    canonicalName: 'Alekhine Defense Main',
    taxonomyLineIds: splitSource.taxonomyLineIds.slice(0, 28),
  }, {
    ...splitSource,
    id: 'alekhine-defense-branch',
    canonicalName: 'Alekhine Defense Branch',
    taxonomyLineIds: splitSource.taxonomyLineIds.slice(28),
  }, ...families.slice(1)]
  const derive = (editedFamilies: typeof families, editorialLedger = createSyntheticApprovedEditorialLedger({ releaseId: 'release_fixture-v31', families: editedFamilies })) =>
    deriveCompactV31FamilyHandoff({
      releaseId: 'release_fixture-v31', taxonomyInventory: inventory, taxonomyManifest: manifest, editorialLedger,
      corpusBindings: [binding, q2Binding],
      exactRows: [{ corpus: binding.corpus, rows: [row, continuation] }, { corpus: q2Binding.corpus, rows: [{ ...row, cells: [{ ...row.cells[0], ratingSystem: 'lichess-glicko2' }] }, { ...continuation, cells: [{ ...continuation.cells[0], ratingSystem: 'lichess-glicko2' }] }] }],
    })
  const merged = await derive(mergeFamilies)
  assert.equal(merged.index.proposedFamilyCount, 149)
  assert.equal(merged.index.familyCount, 148)
  assert.equal(merged.index.familyDispositions.length, 296)
  const split = await derive(splitFamilies)
  assert.equal(split.index.proposedFamilyCount, 149)
  assert.equal(split.index.familyCount, 150)
  assert.equal(split.index.familyDispositions.length, 300)

  const orphanLedger = createSyntheticApprovedEditorialLedger({ releaseId: 'release_fixture-v31', families: splitFamilies }) as any
  const orphanId = 'alekhine-defense-branch'
  for (const decision of orphanLedger.decisions) {
    if (decision.decision.resultingFamilyIds.includes(orphanId)) {
      decision.decision.resultingFamilyIds = [...new Set(decision.decision.resultingFamilyIds.map((id: string) => id === orphanId ? 'alekhine-defense-main' : id))]
    }
  }
  await assert.rejects(derive(splitFamilies, orphanLedger), /canonical families unowned/iu)
})

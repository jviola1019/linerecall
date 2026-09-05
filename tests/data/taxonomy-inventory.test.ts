import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import {
  assertExactProposedFamilyOwnership,
  assertExactTaxonomyPrimaryOwnership,
  validatePinnedTaxonomyInventory,
} from '../../scripts/data/taxonomy-inventory.ts'

const inventoryUrl = new URL('../../data/manifests/taxonomy.inventory.v1.json', import.meta.url)
const manifestUrl = new URL('../../data/manifests/taxonomy.source.json', import.meta.url)

async function inputs(): Promise<{ inventory: any; manifest: any }> {
  return {
    inventory: JSON.parse(await readFile(inventoryUrl, 'utf8')),
    manifest: JSON.parse(await readFile(manifestUrl, 'utf8')),
  }
}

test('the immutable taxonomy inventory re-derives all rows, moves, and proposed owners from pinned bytes', async () => {
  const { inventory, manifest } = await inputs()
  const validated = validatePinnedTaxonomyInventory(inventory, manifest)
  assert.equal(validated.rows.length, 3_790)
  assert.equal(new Set(validated.rows.map(({ id }) => id)).size, 3_790)
  assert.equal(new Set(validated.rows.map(({ eco }) => eco)).size, 500)
  assert.equal(validated.proposedFamilies.length, 149)
  assert.equal(validated.sourceFiles.length, 5)
})

for (const [name, mutate] of [
  ['fake line ID', (value: any) => { value.rows[0].id = `tax_${'f'.repeat(24)}` }],
  ['altered ECO', (value: any) => { value.rows[0].eco = 'E99' }],
  ['altered name', (value: any) => { value.rows[0].name = 'Forged Opening' }],
  ['altered PGN moves', (value: any) => { value.rows[0].pgn = '1. e4' }],
  ['altered UCI moves', (value: any) => { value.rows[0].uci = ['e2e4'] }],
  ['missing row', (value: any) => { value.rows.pop() }],
  ['duplicate row', (value: any) => { value.rows[1] = structuredClone(value.rows[0]) }],
  ['wrong primary family', (value: any) => { value.rows[0].proposedPrimaryFamilyId = 'sicilian-defence' }],
  ['mismatched embedded TSV digest', (value: any) => { value.sourceFiles[0].sha256 = 'f'.repeat(64) }],
] as const) {
  test(`taxonomy inventory rejects ${name}`, async () => {
    const { inventory, manifest } = await inputs()
    mutate(inventory)
    assert.throws(() => validatePinnedTaxonomyInventory(inventory, manifest))
  })
}

test('exact primary ownership rejects unknown, missing, and duplicate-universe substitutions', async () => {
  const { inventory, manifest } = await inputs()
  const validated = validatePinnedTaxonomyInventory(inventory, manifest)
  const ownership = new Map(validated.rows.map(({ id }) => [id, 'reviewed-family']))
  assert.doesNotThrow(() => assertExactTaxonomyPrimaryOwnership({ inventory: validated, actualOwnership: ownership }))
  ownership.delete(validated.rows[0]!.id)
  ownership.set(`tax_${'f'.repeat(24)}`, 'reviewed-family')
  assert.throws(
    () => assertExactTaxonomyPrimaryOwnership({ inventory: validated, actualOwnership: ownership }),
    /missing pinned row|unknown row/u,
  )
})

test('editorial candidate ownership must equal the pinned 149-family proposal', async () => {
  const { inventory, manifest } = await inputs()
  const validated = validatePinnedTaxonomyInventory(inventory, manifest)
  const decisions = validated.proposedFamilies.map((family) => ({
    candidateFamilyId: family.familyId,
    candidateTaxonomyLineIds: [...family.taxonomyLineIds],
  }))
  assert.doesNotThrow(() => assertExactProposedFamilyOwnership({ inventory: validated, decisions }))
  const first = decisions[0]!
  const second = decisions[1]!
  const moved = first.candidateTaxonomyLineIds.pop()!
  second.candidateTaxonomyLineIds.push(moved)
  assert.throws(
    () => assertExactProposedFamilyOwnership({ inventory: validated, decisions }),
    /Editorial candidate ownership differs/u,
  )
})

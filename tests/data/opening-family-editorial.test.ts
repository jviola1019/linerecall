import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import reviewCatalogInput from '../../src/generated/review-family-catalog.json' with { type: 'json' }
import { validateReviewOpeningFamilyCatalog } from '../../src/data/review-family-catalog.ts'
import {
  validateApprovedOpeningFamilyEditorialLedger,
  validateOpeningFamilyEditorialLedger,
} from '../../src/domain/opening-family-editorial.ts'

const source = 'https://github.com/lichess-org/chess-openings/tree/17ee660257de02870636f36248e919f2e01d8e85'

async function pendingLedger(): Promise<Record<string, any>> {
  return JSON.parse(await readFile('data/manifests/opening-family-editorial.proposal.json', 'utf8')) as Record<string, any>
}

function approve(proposal: Record<string, any>): Record<string, any> {
  return {
    ...proposal,
    editorialStatus: 'approved',
    promotionEligible: true,
    decisions: proposal.decisions.map((decision: Record<string, any>) => ({
      ...decision,
      reviewStatus: 'approved',
      decision: { action: 'keep', resultingFamilyIds: [decision.candidateFamilyId] },
      reviewer: { name: 'Fixture chess editor', role: 'chess-editor' },
      reviewedAt: '2026-08-27T12:00:00.000Z',
      rationale: 'Fixture approval exercises the complete fail-closed contract.',
      sourceReferences: [source],
    })),
  }
}

test('mechanical 149-family worksheet covers all taxonomy rows but cannot promote', async () => {
  const ledger = validateOpeningFamilyEditorialLedger(await pendingLedger())
  assert.equal(ledger.proposedFamilyCount, 149)
  assert.equal(ledger.decisions.length, 149)
  assert.equal(ledger.decisions.flatMap(({ candidateTaxonomyLineIds }) => candidateTaxonomyLineIds).length, 3_790)
  assert.equal(ledger.editorialStatus, 'pending')
  assert.equal(ledger.promotionEligible, false)
  assert.throws(
    () => validateApprovedOpeningFamilyEditorialLedger(ledger, []),
    /review is pending/iu,
  )
})

test('an explicitly reviewed complete ledger can bind the exact promoted catalog', async () => {
  const catalog = validateReviewOpeningFamilyCatalog(reviewCatalogInput)
  const approved = validateApprovedOpeningFamilyEditorialLedger(
    approve(await pendingLedger()),
    catalog.families.map((family) => ({
      id: family.id,
      canonicalName: family.canonicalName,
      aliases: family.aliases,
      ecoCodes: family.ecoCodes,
      taxonomyLineIds: family.taxonomyLineIds,
    })),
  )
  assert.equal(approved.editorialStatus, 'approved')
  assert.equal(approved.families.length, 149)
})

test('duplicate ownership, alias collisions, cycles, and partial review fail closed', async () => {
  const base = approve(await pendingLedger())
  const duplicate = structuredClone(base)
  duplicate.families[1].primaryTaxonomyLineIds[0] = duplicate.families[0].primaryTaxonomyLineIds[0]
  assert.throws(() => validateOpeningFamilyEditorialLedger(duplicate), /own all 3,790 taxonomy rows exactly once/iu)

  const aliases = structuredClone(base)
  aliases.families[1].aliases.push(aliases.families[0].canonicalName)
  assert.throws(() => validateOpeningFamilyEditorialLedger(aliases), /conflicts between/iu)

  const cycle = structuredClone(base)
  cycle.families[0].parentFamilyId = cycle.families[1].id
  cycle.families[1].parentFamilyId = cycle.families[0].id
  assert.throws(() => validateOpeningFamilyEditorialLedger(cycle), /contains a cycle/iu)

  const partial = structuredClone(base)
  partial.decisions[148] = {
    ...partial.decisions[148],
    reviewStatus: 'pending',
    decision: null,
    reviewer: null,
    reviewedAt: null,
    rationale: null,
  }
  assert.throws(() => validateOpeningFamilyEditorialLedger(partial), /status does not match/iu)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import embeddedSnapshot from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import reviewCatalogInput from '../../src/generated/review-family-catalog.json' with { type: 'json' }
import { validateReviewOpeningFamilyCatalog } from '../../src/data/review-family-catalog.ts'
import { WireSearchSnapshotSchema } from '../../src/data/wire.ts'
import {
  buildOpeningFamilyEditorialAudit,
  OpeningFamilyEditorialAuditV1Schema,
} from '../../scripts/data/opening-family-editorial-audit.ts'
import {
  validateApprovedOpeningFamilyEditorialLedger,
  validateOpeningFamilyEditorialLedger,
} from '../../src/domain/opening-family-editorial.ts'

const source = 'https://github.com/lichess-org/chess-openings/tree/17ee660257de02870636f36248e919f2e01d8e85'

async function pendingLedger(): Promise<Record<string, any>> {
  return JSON.parse(await readFile('data/manifests/opening-family-editorial.proposal.json', 'utf8')) as Record<string, any>
}

async function pendingAudit() {
  const search = WireSearchSnapshotSchema.parse(JSON.parse(gunzipSync(
    Buffer.from(embeddedSnapshot.blobs.search.base64, 'base64'),
  ).toString('utf8')))
  return buildOpeningFamilyEditorialAudit({
    ledger: validateOpeningFamilyEditorialLedger(await pendingLedger()),
    taxonomyRows: search.l.map(([sourceLineId, eco, name]) => ({ sourceLineId, eco, name })),
  })
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

test('deterministic editorial triage covers all 149 families without claiming human review', async () => {
  const proposal = validateOpeningFamilyEditorialLedger(await pendingLedger())
  const search = WireSearchSnapshotSchema.parse(JSON.parse(gunzipSync(
    Buffer.from(embeddedSnapshot.blobs.search.base64, 'base64'),
  ).toString('utf8')))
  const rebuilt = buildOpeningFamilyEditorialAudit({
    ledger: proposal,
    taxonomyRows: search.l.map(([sourceLineId, eco, name]) => ({ sourceLineId, eco, name })),
  })
  assert.deepEqual(rebuilt, OpeningFamilyEditorialAuditV1Schema.parse(await pendingAudit()))
  assert.deepEqual(rebuilt, buildOpeningFamilyEditorialAudit({
    ledger: proposal,
    taxonomyRows: [...search.l].reverse().map(([sourceLineId, eco, name]) => ({ sourceLineId, eco, name })),
  }))
  assert.equal(rebuilt.machineValidatedFamilyCount, 149)
  assert.equal(rebuilt.pendingHumanReviewCount, 149)
  assert.equal(rebuilt.familiesMissingIndependentReference, 149)
  assert.equal(rebuilt.promotionEligible, false)
  assert.equal(rebuilt.entries.every(({ machineValidation }) => machineValidation === 'pass'), true)
  assert.equal(rebuilt.entries.every(({ humanReviewStatus }) => humanReviewStatus === 'pending'), true)
})

test('editorial triage surfaces compound roots, umbrella relations, scope, and source slots', async () => {
  const audit = OpeningFamilyEditorialAuditV1Schema.parse(await pendingAudit())
  const counts = new Map(audit.anomalyCounts.map(({ code, familyCount }) => [code, familyCount]))
  assert.equal(counts.get('accepted-declined-root'), 15)
  assert.equal(counts.get('qualified-with-root'), 9)
  assert.equal(counts.get('singleton-taxonomy-ownership'), 39)
  assert.equal(counts.get('broad-taxonomy-ownership'), 9)
  assert.equal(counts.get('encoding-artifact'), 0)

  const benko = audit.entries.find(({ candidateFamilyId }) => candidateFamilyId === 'benko-gambit')!
  assert.equal(benko.anomalyCodes.includes('umbrella-parent-candidate'), true)
  assert.deepEqual(benko.relatedCandidateFamilyIds, ['benko-gambit-accepted', 'benko-gambit-declined'])
  const accepted = audit.entries.find(({ candidateFamilyId }) => candidateFamilyId === 'benko-gambit-accepted')!
  assert.equal(accepted.anomalyCodes.includes('accepted-declined-root'), true)
  assert.equal(accepted.anomalyCodes.includes('qualified-child-candidate'), true)
  assert.deepEqual(accepted.relatedCandidateFamilyIds, ['benko-gambit'])

  const withQualifier = audit.entries.find(({ candidateFamilyId }) => candidateFamilyId === 'kings-indian-attack-with-bf5')!
  assert.equal(withQualifier.anomalyCodes.includes('qualified-with-root'), true)
  assert.equal(withQualifier.checklist.includes('review-with-qualifier-placement'), true)
  assert.deepEqual(withQualifier.relatedCandidateFamilyIds, ['kings-indian-attack'])
  assert.deepEqual(withQualifier.sourceReferenceSlots.map(({ kind, status }) => [kind, status]), [
    ['pinned-taxonomy-source', 'present'],
    ['independent-chess-reference', 'missing'],
    ['relationship-or-historical-reference', 'missing'],
  ])
})

test('editorial triage rejects an incomplete taxonomy source instead of hiding assignments', async () => {
  const proposal = validateOpeningFamilyEditorialLedger(await pendingLedger())
  const search = WireSearchSnapshotSchema.parse(JSON.parse(gunzipSync(
    Buffer.from(embeddedSnapshot.blobs.search.base64, 'base64'),
  ).toString('utf8')))
  assert.throws(
    () => buildOpeningFamilyEditorialAudit({
      ledger: proposal,
      taxonomyRows: search.l.slice(1).map(([sourceLineId, eco, name]) => ({ sourceLineId, eco, name })),
    }),
    /expected array.*3790 items/iu,
  )
})

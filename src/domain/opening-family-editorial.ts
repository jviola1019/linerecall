import { z } from 'zod'
import {
  FamilyIdSchema,
  REQUIRED_OPENING_FAMILY_REGRESSIONS,
  TaxonomyLineIdSchema,
} from './opening-family.ts'
import { EcoCodeSchema } from './opening-data.ts'

const CanonicalTextSchema = z.string().min(1).max(256).refine(
  (value) => value === value.normalize('NFC').trim().replace(/\s+/gu, ' ')
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  'Editorial text must be NFC-normalized, trimmed, and free of control characters',
)
const Sha256Schema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u)
const IsoDateTimeSchema = z.string().datetime({ offset: true })
const HttpsUrlSchema = z.string().url().startsWith('https://').max(1024)

const EditorialReviewerSchema = z.object({
  name: CanonicalTextSchema,
  role: z.enum(['chess-editor', 'taxonomy-editor', 'legal-reviewer']),
}).strict()

const EditorialActionSchema = z.enum(['keep', 'merge', 'split', 'nest'])

const PendingDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  candidateFamilyId: FamilyIdSchema,
  candidateCanonicalName: CanonicalTextSchema,
  candidateTaxonomyLineIds: z.array(TaxonomyLineIdSchema).min(1).max(3_790),
  reviewStatus: z.literal('pending'),
  decision: z.null(),
  reviewer: z.null(),
  reviewedAt: z.null(),
  rationale: z.null(),
  sourceReferences: z.array(HttpsUrlSchema).max(32),
}).strict()

const ApprovedDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  candidateFamilyId: FamilyIdSchema,
  candidateCanonicalName: CanonicalTextSchema,
  candidateTaxonomyLineIds: z.array(TaxonomyLineIdSchema).min(1).max(3_790),
  reviewStatus: z.literal('approved'),
  decision: z.object({
    action: EditorialActionSchema,
    resultingFamilyIds: z.array(FamilyIdSchema).min(1).max(64),
  }).strict(),
  reviewer: EditorialReviewerSchema,
  reviewedAt: IsoDateTimeSchema,
  rationale: CanonicalTextSchema,
  sourceReferences: z.array(HttpsUrlSchema).min(1).max(32),
}).strict()

export const OpeningFamilyEditorialDecisionV1Schema = z.discriminatedUnion('reviewStatus', [
  PendingDecisionSchema,
  ApprovedDecisionSchema,
]).superRefine((decision, context) => {
  if (new Set(decision.candidateTaxonomyLineIds).size !== decision.candidateTaxonomyLineIds.length) {
    context.addIssue({ code: 'custom', path: ['candidateTaxonomyLineIds'], message: 'Candidate taxonomy assignments must be unique' })
  }
  if (decision.reviewStatus === 'approved' && new Set(decision.decision.resultingFamilyIds).size !== decision.decision.resultingFamilyIds.length) {
    context.addIssue({ code: 'custom', path: ['decision', 'resultingFamilyIds'], message: 'Resulting family IDs must be unique' })
  }
})

const HistoricalFamilyLinkSchema = z.object({
  familyId: FamilyIdSchema,
  relationship: z.enum(['transposes-to', 'historically-related', 'also-indexed-as']),
  rationale: CanonicalTextSchema,
  sourceReferences: z.array(HttpsUrlSchema).min(1).max(16),
}).strict()

export const OpeningFamilyEditorialFamilyV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: FamilyIdSchema,
  canonicalName: CanonicalTextSchema,
  aliases: z.array(CanonicalTextSchema).max(64),
  ecoCodes: z.array(EcoCodeSchema).min(1).max(500),
  parentFamilyId: FamilyIdSchema.nullable(),
  primaryTaxonomyLineIds: z.array(TaxonomyLineIdSchema).min(1).max(3_790),
  secondaryFamilyLinks: z.array(HistoricalFamilyLinkSchema).max(256),
}).strict().superRefine((family, context) => {
  for (const [field, values] of [
    ['aliases', family.aliases],
    ['ecoCodes', family.ecoCodes],
    ['primaryTaxonomyLineIds', family.primaryTaxonomyLineIds],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} must be unique` })
    }
  }
  if (family.parentFamilyId === family.id) {
    context.addIssue({ code: 'custom', path: ['parentFamilyId'], message: 'A family cannot be its own parent' })
  }
  if (family.secondaryFamilyLinks.some(({ familyId }) => familyId === family.id)) {
    context.addIssue({ code: 'custom', path: ['secondaryFamilyLinks'], message: 'A family cannot link to itself' })
  }
})

export const OpeningFamilyEditorialLedgerV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-opening-family-editorial-ledger'),
  releaseId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,159}$/u),
  generatedAt: IsoDateTimeSchema,
  taxonomyCommit: Sha256Schema,
  taxonomyLineCount: z.literal(3_790),
  proposedFamilyCount: z.literal(149),
  editorialStatus: z.enum(['pending', 'approved']),
  promotionEligible: z.boolean(),
  automatedProposalMethod: z.literal('lichess-name-prefix-plus-regression-overrides'),
  decisions: z.array(OpeningFamilyEditorialDecisionV1Schema).length(149),
  families: z.array(OpeningFamilyEditorialFamilyV1Schema).min(1).max(3_790),
  sourceReferences: z.array(HttpsUrlSchema).min(1).max(32),
  note: CanonicalTextSchema,
}).strict()

function normalizedName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
}

function assertNoFamilyCycles(families: readonly z.infer<typeof OpeningFamilyEditorialFamilyV1Schema>[]): void {
  const parents = new Map(families.map(({ id, parentFamilyId }) => [id, parentFamilyId]))
  for (const id of parents.keys()) {
    const visited = new Set<string>()
    let current: string | null | undefined = id
    while (current !== null && current !== undefined) {
      if (visited.has(current)) throw new Error(`Opening family editorial hierarchy contains a cycle at ${current}`)
      visited.add(current)
      current = parents.get(current)
    }
  }
}

export function validateOpeningFamilyEditorialLedger(input: unknown): OpeningFamilyEditorialLedgerV1 {
  const ledger = OpeningFamilyEditorialLedgerV1Schema.parse(input)
  if ((ledger.editorialStatus === 'approved') !== ledger.promotionEligible) {
    throw new Error('Only a fully approved editorial ledger may be promotion eligible')
  }
  const expectedDecisionStatus = ledger.editorialStatus === 'approved' ? 'approved' : 'pending'
  if (ledger.decisions.some(({ reviewStatus }) => reviewStatus !== expectedDecisionStatus)) {
    throw new Error('Editorial ledger status does not match every candidate-family decision')
  }
  if (new Set(ledger.decisions.map(({ candidateFamilyId }) => candidateFamilyId)).size !== ledger.decisions.length) {
    throw new Error('Every proposed family must have exactly one editorial decision')
  }
  const candidateTaxonomyIds = ledger.decisions.flatMap(({ candidateTaxonomyLineIds }) => candidateTaxonomyLineIds)
  if (candidateTaxonomyIds.length !== ledger.taxonomyLineCount || new Set(candidateTaxonomyIds).size !== candidateTaxonomyIds.length) {
    throw new Error('Editorial decisions must cover all 3,790 proposed taxonomy assignments exactly once')
  }
  if (new Set(ledger.families.map(({ id }) => id)).size !== ledger.families.length) {
    throw new Error('Editorial family IDs must be unique')
  }
  const familyIds = new Set(ledger.families.map(({ id }) => id))
  const primaryTaxonomyIds = ledger.families.flatMap(({ primaryTaxonomyLineIds }) => primaryTaxonomyLineIds)
  if (primaryTaxonomyIds.length !== ledger.taxonomyLineCount || new Set(primaryTaxonomyIds).size !== primaryTaxonomyIds.length) {
    throw new Error('Editorial families must own all 3,790 taxonomy rows exactly once')
  }
  if (candidateTaxonomyIds.some((id) => !primaryTaxonomyIds.includes(id))) {
    throw new Error('Editorial result omitted a taxonomy row from the automated proposal')
  }
  for (const family of ledger.families) {
    if (family.parentFamilyId !== null && !familyIds.has(family.parentFamilyId)) {
      throw new Error(`Editorial family ${family.id} names a missing parent`)
    }
    if (family.secondaryFamilyLinks.some(({ familyId }) => !familyIds.has(familyId))) {
      throw new Error(`Editorial family ${family.id} names a missing secondary family`)
    }
  }
  assertNoFamilyCycles(ledger.families)

  const nameOwners = new Map<string, string>()
  for (const family of ledger.families) {
    for (const name of [family.canonicalName, ...family.aliases]) {
      const key = normalizedName(name)
      const prior = nameOwners.get(key)
      if (prior !== undefined && prior !== family.id) throw new Error(`Editorial alias ${name} conflicts between ${prior} and ${family.id}`)
      nameOwners.set(key, family.id)
    }
  }
  if (ledger.editorialStatus === 'approved') {
    for (const decision of ledger.decisions) {
      if (decision.reviewStatus !== 'approved') throw new Error('Approved editorial ledger contains a pending decision')
      if (decision.decision.resultingFamilyIds.some((id) => !familyIds.has(id))) {
        throw new Error(`Editorial decision ${decision.candidateFamilyId} names a missing resulting family`)
      }
    }
  }
  return ledger
}

export interface ExpectedEditorialFamily {
  id: string
  canonicalName: string
  aliases: readonly string[]
  ecoCodes: readonly string[]
  taxonomyLineIds: readonly string[]
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function validateApprovedOpeningFamilyEditorialLedger(
  input: unknown,
  expectedFamilies: readonly ExpectedEditorialFamily[],
): OpeningFamilyEditorialLedgerV1 {
  const ledger = validateOpeningFamilyEditorialLedger(input)
  if (!ledger.promotionEligible || ledger.editorialStatus !== 'approved') {
    throw new Error('Opening family editorial review is pending; production family promotion is blocked')
  }
  const byId = new Map(ledger.families.map((family) => [family.id, family]))
  if (byId.size !== expectedFamilies.length) throw new Error('Approved editorial family count differs from the promoted catalog')
  for (const expected of expectedFamilies) {
    const family = byId.get(expected.id)
    if (!family) throw new Error(`Approved editorial ledger is missing promoted family ${expected.id}`)
    if (
      family.canonicalName !== expected.canonicalName ||
      !sameOrderedValues(family.aliases, expected.aliases) ||
      !sameOrderedValues(family.ecoCodes, expected.ecoCodes) ||
      !sameOrderedValues(family.primaryTaxonomyLineIds, expected.taxonomyLineIds)
    ) {
      throw new Error(`Approved editorial family ${expected.id} differs from the promoted catalog`)
    }
  }
  for (const required of REQUIRED_OPENING_FAMILY_REGRESSIONS) {
    const family = byId.get(required.id)
    const expected = expectedFamilies.find(({ id }) => id === required.id)
    if (expected && (!family || !sameOrderedValues(family.ecoCodes, required.ecoCodes))) {
      throw new Error(`Approved editorial ledger has incomplete ${required.id} ECO ownership`)
    }
  }
  return ledger
}

export type OpeningFamilyEditorialDecisionV1 = z.infer<typeof OpeningFamilyEditorialDecisionV1Schema>
export type OpeningFamilyEditorialFamilyV1 = z.infer<typeof OpeningFamilyEditorialFamilyV1Schema>
export type OpeningFamilyEditorialLedgerV1 = z.infer<typeof OpeningFamilyEditorialLedgerV1Schema>

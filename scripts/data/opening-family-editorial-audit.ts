import { z } from 'zod'
import { EcoCodeSchema } from '../../src/domain/opening-data.ts'
import {
  FamilyIdSchema,
  TaxonomyLineIdSchema,
} from '../../src/domain/opening-family.ts'
import {
  validateOpeningFamilyEditorialLedger,
  type OpeningFamilyEditorialLedgerV1,
} from '../../src/domain/opening-family-editorial.ts'

const CanonicalTextSchema = z.string().min(1).max(512).refine(
  (value) => value === value.normalize('NFC').trim().replace(/\s+/gu, ' ')
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  'Editorial audit text must be NFC-normalized, trimmed, and free of control characters',
)
const HttpsUrlSchema = z.string().url().startsWith('https://').max(1024)

export const EditorialAnomalyCodeSchema = z.enum([
  'accepted-declined-root',
  'broad-taxonomy-ownership',
  'cross-volume-eco-ownership',
  'defence-orthography-choice',
  'discontinuous-eco-ownership',
  'encoding-artifact',
  'generic-root-name',
  'qualified-child-candidate',
  'qualified-with-root',
  'singleton-taxonomy-ownership',
  'umbrella-parent-candidate',
])

export const EditorialChecklistCodeSchema = z.enum([
  'confirm-canonical-name-and-aliases',
  'confirm-independent-chess-reference',
  'confirm-primary-taxonomy-ownership',
  'confirm-transpositions-by-exact-epd',
  'review-accepted-declined-scope',
  'review-broad-scope',
  'review-defence-orthography',
  'review-eco-discontinuity',
  'review-generic-root',
  'review-sparse-scope',
  'review-top-level-versus-nested',
  'review-with-qualifier-placement',
])

const EditorialSourceSlotSchema = z.object({
  kind: z.enum([
    'pinned-taxonomy-source',
    'independent-chess-reference',
    'relationship-or-historical-reference',
  ]),
  required: z.boolean(),
  status: z.enum(['present', 'missing']),
  references: z.array(HttpsUrlSchema).max(32),
}).strict().superRefine((slot, context) => {
  if ((slot.references.length > 0) !== (slot.status === 'present')) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'Source-slot status must match whether references are present',
    })
  }
})

const TaxonomyExampleSchema = z.object({
  id: TaxonomyLineIdSchema,
  eco: EcoCodeSchema,
  name: CanonicalTextSchema,
}).strict()

const EditorialFamilyAuditEntryV1Schema = z.object({
  schemaVersion: z.literal(1),
  candidateFamilyId: FamilyIdSchema,
  candidateCanonicalName: CanonicalTextSchema,
  taxonomyLineCount: z.number().int().positive().max(3_790),
  ecoCodes: z.array(EcoCodeSchema).min(1).max(500),
  sourceRoots: z.array(CanonicalTextSchema).min(1).max(64),
  taxonomyExamples: z.array(TaxonomyExampleSchema).min(1).max(5),
  anomalyCodes: z.array(EditorialAnomalyCodeSchema).max(11),
  relatedCandidateFamilyIds: z.array(FamilyIdSchema).max(149),
  checklist: z.array(EditorialChecklistCodeSchema).min(4).max(12),
  sourceReferenceSlots: z.array(EditorialSourceSlotSchema).length(3),
  machineValidation: z.literal('pass'),
  humanReviewStatus: z.literal('pending'),
}).strict().superRefine((entry, context) => {
  for (const [field, values] of [
    ['ecoCodes', entry.ecoCodes],
    ['sourceRoots', entry.sourceRoots],
    ['anomalyCodes', entry.anomalyCodes],
    ['relatedCandidateFamilyIds', entry.relatedCandidateFamilyIds],
    ['checklist', entry.checklist],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} must be unique` })
    }
  }
})

const AnomalyCountSchema = z.object({
  code: EditorialAnomalyCodeSchema,
  familyCount: z.number().int().nonnegative().max(149),
}).strict()

export const OpeningFamilyEditorialAuditV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-opening-family-editorial-audit'),
  releaseId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,159}$/u),
  generatedAt: z.string().datetime({ offset: true }),
  taxonomyCommit: z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u),
  proposalReleaseId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,159}$/u),
  familyCount: z.literal(149),
  taxonomyLineCount: z.literal(3_790),
  machineValidatedFamilyCount: z.literal(149),
  pendingHumanReviewCount: z.number().int().nonnegative().max(149),
  familiesRequiringEditorialAttention: z.number().int().nonnegative().max(149),
  familiesMissingIndependentReference: z.number().int().nonnegative().max(149),
  anomalyCounts: z.array(AnomalyCountSchema).length(EditorialAnomalyCodeSchema.options.length),
  entries: z.array(EditorialFamilyAuditEntryV1Schema).length(149),
  promotionEligible: z.literal(false),
  humanReviewBoundary: CanonicalTextSchema,
}).strict().superRefine((audit, context) => {
  if (audit.pendingHumanReviewCount !== audit.entries.filter(({ humanReviewStatus }) => humanReviewStatus === 'pending').length) {
    context.addIssue({ code: 'custom', path: ['pendingHumanReviewCount'], message: 'Pending-review total does not reconcile' })
  }
  if (audit.familiesRequiringEditorialAttention !== audit.entries.filter(({ anomalyCodes }) => anomalyCodes.length > 0).length) {
    context.addIssue({ code: 'custom', path: ['familiesRequiringEditorialAttention'], message: 'Editorial-attention total does not reconcile' })
  }
  const missingIndependent = audit.entries.filter(({ sourceReferenceSlots }) =>
    sourceReferenceSlots.some(({ kind, required, status }) => kind === 'independent-chess-reference' && required && status === 'missing')).length
  if (audit.familiesMissingIndependentReference !== missingIndependent) {
    context.addIssue({ code: 'custom', path: ['familiesMissingIndependentReference'], message: 'Independent-reference total does not reconcile' })
  }
  const anomalyCounts = new Map(audit.anomalyCounts.map(({ code, familyCount }) => [code, familyCount]))
  for (const code of EditorialAnomalyCodeSchema.options) {
    const expected = audit.entries.filter(({ anomalyCodes }) => anomalyCodes.includes(code)).length
    if (anomalyCounts.get(code) !== expected) {
      context.addIssue({ code: 'custom', path: ['anomalyCounts'], message: `Anomaly total does not reconcile for ${code}` })
    }
  }
  if (audit.promotionEligible && audit.pendingHumanReviewCount > 0) {
    context.addIssue({ code: 'custom', path: ['promotionEligible'], message: 'Pending human review cannot be promotion eligible' })
  }
})

const AuditTaxonomyRowSchema = z.object({
  sourceLineId: TaxonomyLineIdSchema,
  eco: EcoCodeSchema,
  name: CanonicalTextSchema,
}).strict()

export interface OpeningFamilyEditorialAuditInput {
  ledger: OpeningFamilyEditorialLedgerV1
  taxonomyRows: readonly {
    sourceLineId: string
    eco: string
    name: string
  }[]
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
}

function sourceRoot(name: string): string {
  return name.split(':', 1)[0]!.trim().replace(/\s+/gu, ' ')
}

function ecoBlocks(ecoCodes: readonly string[]): number {
  const byVolume = new Map<string, number[]>()
  for (const eco of ecoCodes) {
    const values = byVolume.get(eco[0]!) ?? []
    values.push(Number.parseInt(eco.slice(1), 10))
    byVolume.set(eco[0]!, values)
  }
  let blocks = 0
  for (const values of byVolume.values()) {
    const sorted = [...new Set(values)].sort((left, right) => left - right)
    for (let index = 0; index < sorted.length; index += 1) {
      if (index === 0 || sorted[index]! !== sorted[index - 1]! + 1) blocks += 1
    }
  }
  return blocks
}

function hasEncodingArtifact(value: string): boolean {
  return /\uFFFD|(?:Ã.|Â.|â(?:€|€™|€“|€”|€¦))/u.test(value)
}

const GENERIC_ROOT_NAMES = new Set(['formation', 'global opening'])
const TAXONOMY_TREE_PREFIX = 'https://github.com/lichess-org/chess-openings/tree/'

function relatedFamilies(
  familyId: string,
  canonicalName: string,
  namesById: ReadonlyMap<string, string>,
): string[] {
  const normalized = normalizedName(canonicalName)
  const related: string[] = []
  for (const [otherId, otherName] of namesById) {
    if (otherId === familyId) continue
    const other = normalizedName(otherName)
    if (
      normalized.startsWith(`${other} `)
      || normalized.startsWith(`${other},`)
      || other.startsWith(`${normalized} `)
      || other.startsWith(`${normalized},`)
    ) related.push(otherId)
  }
  return related.sort((left, right) => left.localeCompare(right, 'en'))
}

export function buildOpeningFamilyEditorialAudit(
  input: OpeningFamilyEditorialAuditInput,
): OpeningFamilyEditorialAuditV1 {
  const ledger = validateOpeningFamilyEditorialLedger(input.ledger)
  if (ledger.editorialStatus !== 'pending' || ledger.promotionEligible) {
    throw new Error('Deterministic editorial triage accepts only the pending machine proposal; approved review evidence uses the promotion validator')
  }
  const taxonomyRows = z.array(AuditTaxonomyRowSchema).length(3_790).parse(input.taxonomyRows)
  if (new Set(taxonomyRows.map(({ sourceLineId }) => sourceLineId)).size !== taxonomyRows.length) {
    throw new Error('Editorial audit taxonomy rows must have unique sourceLineId values')
  }
  const taxonomyById = new Map(taxonomyRows.map((row) => [row.sourceLineId, row]))
  const namesById = new Map(ledger.decisions.map(({ candidateFamilyId, candidateCanonicalName }) =>
    [candidateFamilyId, candidateCanonicalName] as const))

  const entries = ledger.decisions.map((decision) => {
    const family = ledger.families.find(({ id }) => id === decision.candidateFamilyId)
    if (!family) throw new Error(`Editorial audit is missing family ${decision.candidateFamilyId}`)
    if (
      family.primaryTaxonomyLineIds.length !== decision.candidateTaxonomyLineIds.length
      || family.primaryTaxonomyLineIds.some((id, index) => id !== decision.candidateTaxonomyLineIds[index])
    ) throw new Error(`Pending editorial proposal ownership differs for ${family.id}`)
    const rows = decision.candidateTaxonomyLineIds.map((id) => {
      const row = taxonomyById.get(id)
      if (!row) throw new Error(`Editorial audit is missing taxonomy row ${id}`)
      return row
    }).sort((left, right) => left.eco.localeCompare(right.eco, 'en')
      || left.name.localeCompare(right.name, 'en')
      || left.sourceLineId.localeCompare(right.sourceLineId, 'en'))
    const ecoCodes = [...new Set(rows.map(({ eco }) => eco))].sort((left, right) => left.localeCompare(right, 'en'))
    if (ecoCodes.length !== family.ecoCodes.length || ecoCodes.some((eco, index) => eco !== family.ecoCodes[index])) {
      throw new Error(`Editorial audit ECO ownership differs for ${family.id}`)
    }
    const roots = [...new Set(rows.map(({ name }) => sourceRoot(name)))].sort((left, right) => left.localeCompare(right, 'en'))
    const related = relatedFamilies(family.id, family.canonicalName, namesById)
    const normalized = normalizedName(family.canonicalName)
    const anomalies = new Set<z.infer<typeof EditorialAnomalyCodeSchema>>()
    if (/\s+(?:accepted|declined)$/u.test(normalized)) anomalies.add('accepted-declined-root')
    if (family.primaryTaxonomyLineIds.length >= 100) anomalies.add('broad-taxonomy-ownership')
    if (new Set(ecoCodes.map((eco) => eco[0])).size > 1) anomalies.add('cross-volume-eco-ownership')
    if (/\bdefen[cs]e\b/u.test(normalized)) anomalies.add('defence-orthography-choice')
    if (ecoBlocks(ecoCodes) > new Set(ecoCodes.map((eco) => eco[0])).size) anomalies.add('discontinuous-eco-ownership')
    if ([family.canonicalName, ...family.aliases, ...roots].some(hasEncodingArtifact)) anomalies.add('encoding-artifact')
    if (GENERIC_ROOT_NAMES.has(normalized)) anomalies.add('generic-root-name')
    if (related.some((id) => {
      const other = normalizedName(namesById.get(id)!)
      return normalized.startsWith(`${other} `) || normalized.startsWith(`${other},`)
    })) anomalies.add('qualified-child-candidate')
    if (/,\s*with\b/u.test(normalized)) anomalies.add('qualified-with-root')
    if (family.primaryTaxonomyLineIds.length === 1) anomalies.add('singleton-taxonomy-ownership')
    if (related.some((id) => {
      const other = normalizedName(namesById.get(id)!)
      return other.startsWith(`${normalized} `) || other.startsWith(`${normalized},`)
    })) anomalies.add('umbrella-parent-candidate')

    const checklist = new Set<z.infer<typeof EditorialChecklistCodeSchema>>([
      'confirm-canonical-name-and-aliases',
      'confirm-independent-chess-reference',
      'confirm-primary-taxonomy-ownership',
      'confirm-transpositions-by-exact-epd',
    ])
    if (anomalies.has('accepted-declined-root')) checklist.add('review-accepted-declined-scope')
    if (anomalies.has('broad-taxonomy-ownership')) checklist.add('review-broad-scope')
    if (anomalies.has('defence-orthography-choice')) checklist.add('review-defence-orthography')
    if (anomalies.has('cross-volume-eco-ownership') || anomalies.has('discontinuous-eco-ownership')) checklist.add('review-eco-discontinuity')
    if (anomalies.has('generic-root-name')) checklist.add('review-generic-root')
    if (anomalies.has('singleton-taxonomy-ownership')) checklist.add('review-sparse-scope')
    if (anomalies.has('qualified-child-candidate') || anomalies.has('umbrella-parent-candidate')) checklist.add('review-top-level-versus-nested')
    if (anomalies.has('qualified-with-root')) checklist.add('review-with-qualifier-placement')

    const pinnedReferences = decision.sourceReferences.filter((reference) => reference.startsWith(TAXONOMY_TREE_PREFIX))
    const independentReferences = decision.sourceReferences.filter((reference) => !reference.startsWith(TAXONOMY_TREE_PREFIX))
    const relationshipRequired = related.length > 0 || anomalies.has('generic-root-name')
    return EditorialFamilyAuditEntryV1Schema.parse({
      schemaVersion: 1,
      candidateFamilyId: decision.candidateFamilyId,
      candidateCanonicalName: decision.candidateCanonicalName,
      taxonomyLineCount: rows.length,
      ecoCodes,
      sourceRoots: roots,
      taxonomyExamples: rows.slice(0, 5).map(({ sourceLineId, eco, name }) => ({ id: sourceLineId, eco, name })),
      anomalyCodes: [...anomalies].sort((left, right) => left.localeCompare(right, 'en')),
      relatedCandidateFamilyIds: related,
      checklist: [...checklist].sort((left, right) => left.localeCompare(right, 'en')),
      sourceReferenceSlots: [
        {
          kind: 'pinned-taxonomy-source',
          required: true,
          status: pinnedReferences.length > 0 ? 'present' : 'missing',
          references: pinnedReferences,
        },
        {
          kind: 'independent-chess-reference',
          required: true,
          status: independentReferences.length > 0 ? 'present' : 'missing',
          references: independentReferences,
        },
        {
          kind: 'relationship-or-historical-reference',
          required: relationshipRequired,
          status: independentReferences.length > 0 ? 'present' : 'missing',
          references: independentReferences,
        },
      ],
      machineValidation: 'pass',
      humanReviewStatus: decision.reviewStatus,
    })
  }).sort((left, right) => left.candidateCanonicalName.localeCompare(right.candidateCanonicalName, 'en'))

  const anomalyCounts = EditorialAnomalyCodeSchema.options.map((code) => ({
    code,
    familyCount: entries.filter(({ anomalyCodes }) => anomalyCodes.includes(code)).length,
  }))
  return OpeningFamilyEditorialAuditV1Schema.parse({
    schemaVersion: 1,
    kind: 'linerecall-opening-family-editorial-audit',
    releaseId: `${ledger.releaseId}-audit`,
    generatedAt: ledger.generatedAt,
    taxonomyCommit: ledger.taxonomyCommit,
    proposalReleaseId: ledger.releaseId,
    familyCount: 149,
    taxonomyLineCount: 3_790,
    machineValidatedFamilyCount: 149,
    pendingHumanReviewCount: entries.filter(({ humanReviewStatus }) => humanReviewStatus === 'pending').length,
    familiesRequiringEditorialAttention: entries.filter(({ anomalyCodes }) => anomalyCodes.length > 0).length,
    familiesMissingIndependentReference: entries.filter(({ sourceReferenceSlots }) =>
      sourceReferenceSlots.some(({ kind, status }) => kind === 'independent-chess-reference' && status === 'missing')).length,
    anomalyCounts,
    entries,
    promotionEligible: false,
    humanReviewBoundary: 'Machine checks reconcile all 149 candidate families and 3,790 taxonomy rows and only identify review prompts. A named human chess or taxonomy editor must decide keep, merge, split, or nest; verify aliases and ownership; add independent references; and approve every decision before promotion.',
  })
}

export type EditorialAnomalyCode = z.infer<typeof EditorialAnomalyCodeSchema>
export type OpeningFamilyEditorialAuditV1 = z.infer<typeof OpeningFamilyEditorialAuditV1Schema>

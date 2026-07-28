import { z } from 'zod'
import {
  FamilyIdSchema,
  REQUIRED_OPENING_FAMILY_REGRESSIONS,
  TaxonomyLineIdSchema,
} from '../domain/opening-family.ts'
import { EcoCodeSchema } from '../domain/opening-data.ts'

const CanonicalTextSchema = z.string().min(1).max(128).refine(
  (value) => value === value.normalize('NFC').trim().replace(/\s+/gu, ' ')
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  'Family text must be normalized and free of control characters',
)

export const ReviewOpeningFamilyEntryV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: FamilyIdSchema,
  canonicalName: CanonicalTextSchema,
  aliases: z.array(CanonicalTextSchema).max(64),
  ecoCodes: z.array(EcoCodeSchema).min(1).max(500),
  taxonomyLineIds: z.array(TaxonomyLineIdSchema).min(1).max(3_790),
  availableSides: z.array(z.enum(['white', 'black'])).max(2),
  legacyVariantCount: z.number().int().nonnegative().max(1_200),
  legacyCardCount: z.number().int().nonnegative().max(100_000),
  maximumLegacyLineCards: z.number().int().nonnegative().max(100),
  graphStatus: z.literal('not-promoted'),
}).strict().superRefine((entry, context) => {
  for (const [field, values] of [
    ['ecoCodes', entry.ecoCodes],
    ['taxonomyLineIds', entry.taxonomyLineIds],
    ['availableSides', entry.availableSides],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', path: [field], message: `${field} must be unique` })
    }
  }
})

export const ReviewOpeningFamilyCatalogV1Schema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  taxonomyCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  taxonomyLineCount: z.literal(3_790),
  familyCount: z.number().int().positive().max(3_790),
  families: z.array(ReviewOpeningFamilyEntryV1Schema).min(1).max(3_790),
}).strict().superRefine((catalog, context) => {
  if (catalog.familyCount !== catalog.families.length) {
    context.addIssue({ code: 'custom', path: ['familyCount'], message: 'Family count does not reconcile' })
  }
  if (new Set(catalog.families.map(({ id }) => id)).size !== catalog.families.length) {
    context.addIssue({ code: 'custom', path: ['families'], message: 'Family IDs must be unique' })
  }
  const taxonomyIds = catalog.families.flatMap(({ taxonomyLineIds }) => taxonomyLineIds)
  if (taxonomyIds.length !== catalog.taxonomyLineCount || new Set(taxonomyIds).size !== taxonomyIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['families'],
      message: 'Every taxonomy line must have exactly one primary family',
    })
  }
})

export type ReviewOpeningFamilyEntryV1 = z.infer<typeof ReviewOpeningFamilyEntryV1Schema>
export type ReviewOpeningFamilyCatalogV1 = z.infer<typeof ReviewOpeningFamilyCatalogV1Schema>

export function validateReviewOpeningFamilyCatalog(input: unknown): ReviewOpeningFamilyCatalogV1 {
  const catalog = ReviewOpeningFamilyCatalogV1Schema.parse(input)
  for (const required of REQUIRED_OPENING_FAMILY_REGRESSIONS) {
    const matches = catalog.families.filter(({ id }) => id === required.id)
    if (matches.length !== 1) throw new Error(`Review catalog must contain one ${required.id} family`)
    const actual = matches[0]!.ecoCodes
    if (actual.length !== required.ecoCodes.length || actual.some((eco, index) => eco !== required.ecoCodes[index])) {
      throw new Error(`Review catalog ${required.id} ECO ownership is incomplete`)
    }
  }
  return catalog
}

import { z } from 'zod'
import { EcoCodeSchema } from './opening-data.ts'
import { FamilyIdSchema, FamilyReleaseIdSchema } from './opening-family.ts'

export const FamilyCatalogReadinessSchema = z.enum([
  'unknown',
  'loading',
  'ready',
  'study-only',
  'error',
  'corrupt',
])

export const FamilyCatalogSummaryV2Schema = z.object({
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  canonicalName: z.string().min(1).max(128),
  ecoCodes: z.array(EcoCodeSchema).min(1).max(500),
  readiness: FamilyCatalogReadinessSchema,
  readySides: z.array(z.enum(['white', 'black'])).max(2),
  totalPaths: z.number().int().nonnegative().max(100_000),
  completedPaths: z.number().int().nonnegative().max(100_000),
  dueCards: z.number().int().nonnegative().max(100_000),
  learnerDepthRange: z.tuple([
    z.number().int().positive().max(100),
    z.number().int().positive().max(100),
  ]).optional(),
  lastReviewedAt: z.string().datetime({ offset: true }).optional(),
}).strict().superRefine((summary, context) => {
  if (new Set(summary.ecoCodes).size !== summary.ecoCodes.length) {
    context.addIssue({ code: 'custom', path: ['ecoCodes'], message: 'ECO codes must be unique' })
  }
  if (new Set(summary.readySides).size !== summary.readySides.length) {
    context.addIssue({ code: 'custom', path: ['readySides'], message: 'Ready sides must be unique' })
  }
  if (summary.completedPaths > summary.totalPaths) {
    context.addIssue({ code: 'custom', path: ['completedPaths'], message: 'Completed paths cannot exceed total paths' })
  }
  if (summary.learnerDepthRange && summary.learnerDepthRange[0] > summary.learnerDepthRange[1]) {
    context.addIssue({ code: 'custom', path: ['learnerDepthRange'], message: 'Learner depth range must be ordered' })
  }
  if (summary.readiness === 'ready' && (summary.readySides.length === 0 || summary.totalPaths === 0)) {
    context.addIssue({
      code: 'custom',
      path: ['readiness'],
      message: 'A ready family must declare at least one side and one path',
    })
  }
  if (summary.readiness !== 'ready' && summary.readySides.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['readySides'],
      message: 'Only a ready family can expose trainable sides',
    })
  }
})

export const FamilyCatalogSummaryIndexV2Schema = z.object({
  schemaVersion: z.literal(2),
  releaseId: FamilyReleaseIdSchema,
  generatedAt: z.string().datetime({ offset: true }),
  families: z.array(FamilyCatalogSummaryV2Schema).min(1).max(3_790),
}).strict().superRefine((index, context) => {
  if (new Set(index.families.map(({ familyId }) => familyId)).size !== index.families.length) {
    context.addIssue({ code: 'custom', path: ['families'], message: 'Family summary IDs must be unique' })
  }
  if (index.families.some(({ releaseId }) => releaseId !== index.releaseId)) {
    context.addIssue({ code: 'custom', path: ['families'], message: 'Every family summary must belong to the index release' })
  }
})

export const NextTrainingTargetV1Schema = z.object({
  familyId: FamilyIdSchema,
  side: z.enum(['white', 'black']),
  mode: z.enum(['learn', 'review']),
  reason: z.enum(['due', 'unfinished', 'recent', 'selected']),
  cursorId: z.string().min(1).max(192).optional(),
  pathId: z.string().regex(/^path_[a-f0-9]{20}$/u).optional(),
}).strict().superRefine((target, context) => {
  if (target.reason === 'due' && target.mode !== 'review') {
    context.addIssue({ code: 'custom', path: ['mode'], message: 'Due work must use review mode' })
  }
  if (target.reason !== 'due' && target.mode !== 'learn') {
    context.addIssue({ code: 'custom', path: ['mode'], message: 'Non-due targets must use learn mode' })
  }
  if (target.reason === 'unfinished' && target.cursorId === undefined) {
    context.addIssue({ code: 'custom', path: ['cursorId'], message: 'An unfinished target requires its saved cursor' })
  }
})

export type FamilyCatalogSummaryV2 = z.infer<typeof FamilyCatalogSummaryV2Schema>
export type FamilyCatalogSummaryIndexV2 = z.infer<typeof FamilyCatalogSummaryIndexV2Schema>
export type NextTrainingTargetV1 = z.infer<typeof NextTrainingTargetV1Schema>

export interface FamilySideDueCountsV1 {
  white: number
  black: number
}

export interface NextTrainingTargetSelection {
  summaries: readonly FamilyCatalogSummaryV2[]
  dueByFamilySide?: Readonly<Record<string, FamilySideDueCountsV1>>
  unfinishedTargets?: readonly NextTrainingTargetV1[]
  selectedFamilyId?: string | null
  selectedSide?: 'white' | 'black'
}

function targetIsReady(
  summaries: ReadonlyMap<string, FamilyCatalogSummaryV2>,
  target: NextTrainingTargetV1,
): boolean {
  const summary = summaries.get(target.familyId)
  return summary?.readiness === 'ready' && summary.readySides.includes(target.side)
}

/**
 * One deterministic target selector feeds Today and any resume affordance in
 * Repertoire or Progress. It never guesses that study-only data is trainable.
 */
export function selectNextTrainingTarget(
  input: NextTrainingTargetSelection,
): NextTrainingTargetV1 | null {
  const summaries = input.summaries.map((summary) => FamilyCatalogSummaryV2Schema.parse(summary))
  const byId = new Map(summaries.map((summary) => [summary.familyId, summary] as const))
  const dueCandidates = summaries.flatMap((summary) => {
    if (summary.readiness !== 'ready' || summary.dueCards === 0) return []
    const counts = input.dueByFamilySide?.[summary.familyId] ?? { white: 0, black: 0 }
    return summary.readySides
      .filter((side) => counts[side] > 0)
      .map((side) => ({ summary, side, count: counts[side] }))
  }).sort((left, right) =>
    right.count - left.count
    || (left.summary.lastReviewedAt ?? '').localeCompare(right.summary.lastReviewedAt ?? '', 'en')
    || left.summary.canonicalName.localeCompare(right.summary.canonicalName, 'en')
    || left.side.localeCompare(right.side, 'en'))
  const due = dueCandidates[0]
  if (due) {
    return NextTrainingTargetV1Schema.parse({
      familyId: due.summary.familyId,
      side: due.side,
      mode: 'review',
      reason: 'due',
    })
  }

  const unfinished = (input.unfinishedTargets ?? [])
    .map((target) => NextTrainingTargetV1Schema.parse(target))
    .filter((target) => target.reason === 'unfinished' && targetIsReady(byId, target))
    .sort((left, right) => {
      const leftSummary = byId.get(left.familyId)!
      const rightSummary = byId.get(right.familyId)!
      return (rightSummary.lastReviewedAt ?? '').localeCompare(leftSummary.lastReviewedAt ?? '', 'en')
        || leftSummary.canonicalName.localeCompare(rightSummary.canonicalName, 'en')
        || left.side.localeCompare(right.side, 'en')
    })[0]
  if (unfinished) return unfinished

  const recent = summaries
    .filter((summary) => summary.readiness === 'ready' && summary.readySides.length > 0 && summary.lastReviewedAt)
    .sort((left, right) =>
      right.lastReviewedAt!.localeCompare(left.lastReviewedAt!, 'en')
      || left.canonicalName.localeCompare(right.canonicalName, 'en'))[0]
  if (recent) {
    return NextTrainingTargetV1Schema.parse({
      familyId: recent.familyId,
      side: recent.readySides[0]!,
      mode: 'learn',
      reason: 'recent',
    })
  }

  const selected = input.selectedFamilyId ? byId.get(input.selectedFamilyId) : undefined
  if (selected?.readiness === 'ready' && selected.readySides.length > 0) {
    const side = input.selectedSide && selected.readySides.includes(input.selectedSide)
      ? input.selectedSide
      : selected.readySides[0]!
    return NextTrainingTargetV1Schema.parse({
      familyId: selected.familyId,
      side,
      mode: 'learn',
      reason: 'selected',
    })
  }

  return null
}

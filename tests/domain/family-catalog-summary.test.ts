import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FamilyCatalogSummaryV2Schema,
  NextTrainingTargetV1Schema,
  selectNextTrainingTarget,
  type FamilyCatalogSummaryV2,
} from '../../src/domain/family-catalog-summary.ts'

function summary(overrides: Partial<FamilyCatalogSummaryV2> = {}): FamilyCatalogSummaryV2 {
  return FamilyCatalogSummaryV2Schema.parse({
    releaseId: 'release-v3-test',
    familyId: 'caro-kann',
    canonicalName: 'Caro–Kann',
    ecoCodes: ['B10', 'B11'],
    readiness: 'ready',
    readySides: ['black'],
    totalPaths: 14,
    completedPaths: 3,
    dueCards: 0,
    learnerDepthRange: [4, 12],
    ...overrides,
  })
}

test('family summaries fail closed on impossible readiness and completion totals', () => {
  assert.equal(FamilyCatalogSummaryV2Schema.safeParse({
    ...summary(),
    readiness: 'study-only',
    readySides: ['black'],
  }).success, false)
  assert.equal(FamilyCatalogSummaryV2Schema.safeParse({
    ...summary(),
    completedPaths: 15,
  }).success, false)
})

test('next training selection prioritizes due, unfinished, recent, then selected work', () => {
  const caro = summary({ dueCards: 2, lastReviewedAt: '2026-08-25T12:00:00.000Z' })
  const sicilian = summary({
    familyId: 'sicilian-defence',
    canonicalName: 'Sicilian Defence',
    ecoCodes: ['B20'],
    readySides: ['white', 'black'],
    dueCards: 5,
    lastReviewedAt: '2026-08-26T12:00:00.000Z',
  })
  assert.deepEqual(selectNextTrainingTarget({
    summaries: [caro, sicilian],
    dueByFamilySide: {
      'caro-kann': { white: 0, black: 2 },
      'sicilian-defence': { white: 4, black: 1 },
    },
  }), {
    familyId: 'sicilian-defence',
    side: 'white',
    mode: 'review',
    reason: 'due',
  })

  const noDue = [
    { ...caro, dueCards: 0 },
    { ...sicilian, dueCards: 0 },
  ]
  const unfinished = NextTrainingTargetV1Schema.parse({
    familyId: 'caro-kann',
    side: 'black',
    mode: 'learn',
    reason: 'unfinished',
    cursorId: 'caro_black::coverage:4',
  })
  assert.deepEqual(selectNextTrainingTarget({ summaries: noDue, unfinishedTargets: [unfinished] }), unfinished)
  assert.equal(selectNextTrainingTarget({ summaries: noDue })?.familyId, 'sicilian-defence')
  assert.equal(selectNextTrainingTarget({
    summaries: noDue.map((entry) => ({ ...entry, lastReviewedAt: undefined })),
  }), null)
  assert.equal(selectNextTrainingTarget({
    summaries: noDue.map((entry) => ({ ...entry, lastReviewedAt: undefined })),
    selectedFamilyId: 'caro-kann',
    selectedSide: 'black',
  })?.reason, 'selected')
})

test('selector never trains study-only or corrupt data', () => {
  const unavailable = summary({
    readiness: 'study-only',
    readySides: [],
    totalPaths: 0,
    completedPaths: 0,
    dueCards: 0,
    learnerDepthRange: undefined,
  })
  assert.equal(selectNextTrainingTarget({ summaries: [unavailable], selectedFamilyId: unavailable.familyId }), null)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FamilyCatalogSummaryV2Schema,
  FamilyCatalogSummaryIndexV2Schema,
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

test('summary and target schemas reject contradictory and cross-release input', () => {
  for (const invalid of [
    { ecoCodes: ['B10', 'B10'] },
    { readySides: ['black', 'black'] },
    { learnerDepthRange: [12, 4] },
    { readySides: [] },
    { totalPaths: 0, completedPaths: 0 },
  ]) {
    assert.equal(FamilyCatalogSummaryV2Schema.safeParse({ ...summary(), ...invalid }).success, false)
  }
  const index = {
    schemaVersion: 2,
    releaseId: 'release-v3-test',
    generatedAt: '2026-09-04T12:00:00.000Z',
    families: [summary()],
  }
  assert.equal(FamilyCatalogSummaryIndexV2Schema.safeParse(index).success, true)
  assert.equal(FamilyCatalogSummaryIndexV2Schema.safeParse({ ...index, families: [summary(), summary()] }).success, false)
  assert.equal(FamilyCatalogSummaryIndexV2Schema.safeParse({
    ...index, families: [summary({ releaseId: 'another-release' })],
  }).success, false)
  for (const target of [
    { mode: 'learn', reason: 'due' },
    { mode: 'review', reason: 'selected' },
    { mode: 'learn', reason: 'unfinished' },
  ]) {
    assert.equal(NextTrainingTargetV1Schema.safeParse({
      familyId: 'caro-kann', side: 'black', ...target,
    }).success, false)
  }
})

test('due ordering is deterministic and never guesses unavailable side ownership', () => {
  const a = summary({ familyId: 'a-family', canonicalName: 'A family', readySides: ['white', 'black'], dueCards: 4 })
  const z = summary({ familyId: 'z-family', canonicalName: 'Z family', dueCards: 2 })
  const dueByFamilySide = {
    'a-family': { white: 2, black: 2 },
    'z-family': { white: 0, black: 2 },
  }
  for (const summaries of [[a, z], [z, a]]) {
    assert.deepEqual(selectNextTrainingTarget({ summaries, dueByFamilySide }), {
      familyId: 'a-family', side: 'black', mode: 'review', reason: 'due',
    })
  }
  // Equal counts prefer the less recently studied family before name/side ties.
  assert.equal(selectNextTrainingTarget({
    summaries: [a, { ...z, lastReviewedAt: '2026-09-04T12:00:00.000Z' }], dueByFamilySide,
  })?.familyId, 'a-family')
  assert.equal(selectNextTrainingTarget({
    summaries: [{ ...a, lastReviewedAt: '2026-09-04T12:00:00.000Z' }, z], dueByFamilySide,
  })?.familyId, 'z-family')
  assert.equal(selectNextTrainingTarget({ summaries: [a] }), null)
  assert.equal(selectNextTrainingTarget({
    summaries: [z], dueByFamilySide: { 'z-family': { white: 2, black: 0 } },
  }), null)
})

test('saved targets retain deterministic recency order and reject unavailable families or sides', () => {
  const a = summary({ familyId: 'a-family', canonicalName: 'A family', readySides: ['white', 'black'] })
  const z = summary({ familyId: 'z-family', canonicalName: 'Z family' })
  const target = (familyId: string, side: 'white' | 'black') => NextTrainingTargetV1Schema.parse({
    familyId, side, mode: 'learn', reason: 'unfinished', cursorId: `${familyId}::coverage:1`,
  })
  const unfinishedTargets = [target('z-family', 'black'), target('a-family', 'white'), target('a-family', 'black')]
  assert.deepEqual(selectNextTrainingTarget({ summaries: [z, a], unfinishedTargets }), target('a-family', 'black'))
  assert.deepEqual(selectNextTrainingTarget({
    summaries: [a, { ...z, lastReviewedAt: '2026-09-04T12:00:00.000Z' }], unfinishedTargets,
  }), target('z-family', 'black'))
  assert.deepEqual(selectNextTrainingTarget({
    summaries: [z, { ...a, lastReviewedAt: '2026-09-04T12:00:00.000Z' }], unfinishedTargets,
  }), target('a-family', 'black'))
  assert.equal(selectNextTrainingTarget({
    summaries: [z],
    unfinishedTargets: [target('missing-family', 'black'), target('z-family', 'white'), {
      familyId: 'z-family', side: 'black', mode: 'learn', reason: 'selected',
    }],
  }), null)
  const lastReviewedAt = '2026-09-04T12:00:00.000Z'
  assert.equal(selectNextTrainingTarget({
    summaries: [{ ...z, lastReviewedAt }, { ...a, lastReviewedAt }],
  })?.familyId, 'a-family')
  for (const selectedSide of [undefined, 'white'] as const) {
    assert.equal(selectNextTrainingTarget({
      summaries: [z], selectedFamilyId: 'z-family', ...(selectedSide ? { selectedSide } : {}),
    })?.side, 'black')
  }
  assert.equal(selectNextTrainingTarget({ summaries: [z], selectedFamilyId: 'missing-family' }), null)
})

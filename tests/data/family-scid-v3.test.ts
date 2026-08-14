import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import {
  FamilyScidCampaignReportV1Schema,
  FamilyScidCandidateInventoryV1Schema,
  buildFamilyScidCampaignReport,
  deriveFamilyScidPromotionReceipt,
  selectFamilyScidSample,
} from '../../scripts/data/family-scid-v3.ts'
import { parseScidEco } from '../../scripts/verification/lib/scid-crosscheck.ts'

const HASH = 'a'.repeat(64)
const RELEASE = 'release-2026-08-scid-test'
const receipt = { path: 'scid/candidates.json', sha256: HASH, bytes: 10, uncompressedBytes: 10, encoding: 'identity' as const }

function line(index: number, eco: string, movesUci: string[], overrides: Record<string, unknown> = {}) {
  return {
    lineId: `scidline_${index.toString(16).padStart(20, '0')}`,
    familyId: 'synthetic-family',
    packId: 'synthetic_white',
    pathId: `path_${(index + 100).toString(16).padStart(20, '0')}`,
    expectedBaseEco: eco,
    canonicalName: 'Synthetic taxonomy name',
    movesUci,
    drillEligible: true,
    engineQuarantined: false,
    ...overrides,
  }
}

async function fixture() {
  const source = await readFile('tests/verification/fixtures/scid-mini.eco', 'utf8')
  const parsed = parseScidEco(source)
  assert.deepEqual(parsed.failures, [])
  return parsed.entries
}

function inventory(lines: unknown[], releaseId = RELEASE) {
  return FamilyScidCandidateInventoryV1Schema.parse({
    schemaVersion: 1,
    kind: 'linerecall-family-scid-candidate-inventory',
    releaseId,
    familyGraphBuildSha256: 'b'.repeat(64),
    lines,
  })
}

describe('family Scid v3 campaign', () => {
  test('selects a deterministic complete round-robin sample across ECO volumes A-E', () => {
    const value = inventory([
      line(1, 'A04', ['g1f3', 'd7d5', 'g2g3']),
      line(2, 'B00', ['e2e4']),
      line(3, 'C20', ['e2e4', 'e7e5']),
      line(4, 'D00', ['d2d4', 'd7d5']),
      line(5, 'E00', ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'g2g3']),
      line(6, 'B20', ['e2e4', 'c7c5']),
    ])
    const selected = selectFamilyScidSample(value, 250, 'fixed-seed')
    assert.equal(selected.length, 6)
    assert.deepEqual(selected.slice(0, 5).map(({ expectedBaseEco }) => expectedBaseEco[0]), ['A', 'B', 'C', 'D', 'E'])
  })

  test('emits only derived comparison facts and binds base-ECO conflicts to quarantine', async () => {
    const value = inventory([
      line(1, 'B00', ['e2e4']),
      line(2, 'C20', ['e2e4', 'c7c5']),
    ])
    const report = buildFamilyScidCampaignReport({
      releaseId: RELEASE,
      inventory: value,
      inventoryReceipt: receipt,
      oracleEntries: await fixture(),
      oracle: { repositoryCommit: 'c'.repeat(40), sourceManifestSha256: 'd'.repeat(64), sha256: 'e'.repeat(64) },
      seed: 'fixed-seed',
      completedAt: '2026-08-06T12:00:00.000Z',
    })
    assert.equal(report.sampling.complete, true)
    assert.equal(report.summary.baseEcoMismatch, 1)
    assert.equal(report.summary.quarantined, 1)
    assert.equal(JSON.stringify(report).includes('Sicilian Defense'), false, 'Scid oracle names are not copied into campaign evidence')
    const conflict = report.results.find(({ quarantined }) => quarantined)!
    assert.throws(
      () => deriveFamilyScidPromotionReceipt({
        report,
        reportReceipt: { ...receipt, path: 'scid/report.json' },
        promotedDrillPathIds: new Set([conflict.pathId]),
        completedAt: '2026-08-06T13:00:00.000Z',
      }),
      /conflict remains/u,
    )
    const promotion = deriveFamilyScidPromotionReceipt({
      report,
      reportReceipt: { ...receipt, path: 'scid/report.json' },
      promotedDrillPathIds: new Set(report.results.filter(({ quarantined }) => !quarantined).map(({ pathId }) => pathId)),
      completedAt: '2026-08-06T13:00:00.000Z',
    })
    assert.equal(promotion.conflictingBaseEcoResults, 1)
    assert.equal(promotion.conflictingBaseEcoInDrills, 0)
  })

  test('rejects incomplete reports, cross-release inventories, and illegal candidate lines', async () => {
    const value = inventory([line(1, 'B00', ['e2e4'])])
    const report = buildFamilyScidCampaignReport({
      releaseId: RELEASE,
      inventory: value,
      inventoryReceipt: receipt,
      oracleEntries: await fixture(),
      oracle: { repositoryCommit: 'c'.repeat(40), sourceManifestSha256: 'd'.repeat(64), sha256: 'e'.repeat(64) },
      seed: 'fixed-seed',
      completedAt: '2026-08-06T12:00:00.000Z',
    })
    const incomplete = structuredClone(report)
    incomplete.sampling.selected = 0
    assert.equal(FamilyScidCampaignReportV1Schema.safeParse(incomplete).success, false)
    assert.throws(() => buildFamilyScidCampaignReport({
      releaseId: 'different-release',
      inventory: value,
      inventoryReceipt: receipt,
      oracleEntries: [],
      oracle: { repositoryCommit: 'c'.repeat(40), sourceManifestSha256: 'd'.repeat(64), sha256: 'e'.repeat(64) },
      seed: 'fixed-seed',
      completedAt: '2026-08-06T12:00:00.000Z',
    }), /another release/u)
    assert.throws(() => buildFamilyScidCampaignReport({
      releaseId: RELEASE,
      inventory: inventory([line(9, 'B00', ['e2e5'])]),
      inventoryReceipt: receipt,
      oracleEntries: [],
      oracle: { repositoryCommit: 'c'.repeat(40), sourceManifestSha256: 'd'.repeat(64), sha256: 'e'.repeat(64) },
      seed: 'fixed-seed',
      completedAt: '2026-08-06T12:00:00.000Z',
    }), /illegal move/u)
  })
})

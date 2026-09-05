import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildFamilyPromotionIndex, FamilyPromotionIndexBuildError } from '../../scripts/release/lib/family-promotion-index-builder.ts'
import { buildProductionAppSnapshotManifest } from '../../scripts/release/lib/production-app-snapshot-builder.ts'
import { buildProductionDataReadiness } from '../../scripts/release/lib/production-data-readiness-builder.ts'
import {
  createProductionHandoffFixture,
  writeFixtureJson,
} from '../fixtures/production-handoff-fixture.ts'

async function absent(path: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
  }
}

function identityReceipt(result: { outputPath: string; sha256: string; bytes: number }) {
  return {
    path: result.outputPath,
    sha256: result.sha256,
    bytes: result.bytes,
    uncompressedBytes: result.bytes,
    encoding: 'identity' as const,
  }
}

async function buildBoundApp(
  fixture: Awaited<ReturnType<typeof createProductionHandoffFixture>>,
  family: Awaited<ReturnType<typeof buildFamilyPromotionIndex>>,
) {
  return buildProductionAppSnapshotManifest({
    root: fixture.root,
    outputPath: 'handoff/app-wire-v3.json',
    input: {
      schemaVersion: 1,
      familyPromotionIndex: identityReceipt(family),
      browseManifest: fixture.browseManifest,
    },
    now: () => new Date('2026-07-28T13:30:00.000Z'),
  })
}

test('builders reject a receipt-complete handoff without mandatory regression families', async () => {
  const fixture = await createProductionHandoffFixture()
  const family = await buildFamilyPromotionIndex({
    root: fixture.root,
    outputPath: 'handoff/family-promotion-index.json',
    input: fixture.familyBuildInput,
    now: () => new Date('2026-07-28T13:00:00.000Z'),
  })
  assert.equal(family.audit.status, 'pass')
  assert.equal(family.audit.counts.families, 1)
  assert.equal(family.audit.counts.packs, 1)

  const familyPromotionIndex = identityReceipt(family)
  const app = await buildBoundApp(fixture, family)
  await assert.rejects(
    buildProductionDataReadiness({
      root: fixture.root,
      outputPath: 'handoff/production-data-readiness.json',
      input: {
        ...fixture.readinessInputs,
        familyPromotionIndex,
        appSnapshotManifest: identityReceipt(app),
      },
      now: () => new Date('2026-07-28T14:00:00.000Z'),
    }),
    /Required family sicilian-defence must appear exactly once/u,
  )
  assert.equal(await absent(join(fixture.root, 'handoff/production-data-readiness.json')), true)
})

test('family index builder discards its candidate when exact eligible-edge inventory is incomplete', async () => {
  const fixture = await createProductionHandoffFixture({ omitFirstEligibleEdge: true })
  const outputPath = join(fixture.root, 'handoff/family-promotion-index.json')
  await assert.rejects(
    buildFamilyPromotionIndex({
      root: fixture.root,
      outputPath: 'handoff/family-promotion-index.json',
      input: fixture.familyBuildInput,
    }),
    (error: unknown) => error instanceof FamilyPromotionIndexBuildError
      && error.report?.findings.some(({ message }) => /omitted/u.test(message)) === true,
  )
  assert.equal(await absent(outputPath), true)
})

test('builders reject normalized output/input aliases, release mismatches, and changed receipt bytes', async () => {
  const selfReference = await createProductionHandoffFixture()
  const aliasedInput = structuredClone(selfReference.familyBuildInput)
  aliasedInput.catalog.path = 'resources//family-catalog.json.gz'
  await assert.rejects(
    buildFamilyPromotionIndex({
      root: selfReference.root,
      outputPath: 'resources/family-catalog.json.gz',
      input: aliasedInput,
    }),
    /Invalid string/u,
  )
  await assert.rejects(
    buildFamilyPromotionIndex({
      root: selfReference.root,
      outputPath: 'resources/family-catalog.json.gz',
      input: selfReference.familyBuildInput,
    }),
    /cannot replace one of its immutable inputs/u,
  )

  const releaseMismatch = await createProductionHandoffFixture()
  const family = await buildFamilyPromotionIndex({
    root: releaseMismatch.root,
    outputPath: 'handoff/family-promotion-index.json',
    input: releaseMismatch.familyBuildInput,
  })
  const indexReceipt = identityReceipt(family)
  const validApp = await buildBoundApp(releaseMismatch, family)
  const appValue = JSON.parse(
    await readFile(join(releaseMismatch.root, validApp.outputPath), 'utf8'),
  ) as {
    familyPromotionIndexSha256: string
    puzzlePromotion: { familyPromotionIndexSha256: string }
  }
  appValue.familyPromotionIndexSha256 = 'f'.repeat(64)
  appValue.puzzlePromotion.familyPromotionIndexSha256 = 'f'.repeat(64)
  const unboundApp = await writeFixtureJson(releaseMismatch.root, 'handoff/unbound-app-wire-v3.json', appValue)
  await assert.rejects(
    buildProductionDataReadiness({
      root: releaseMismatch.root,
      outputPath: 'handoff/production-data-readiness.json',
      input: {
        ...releaseMismatch.readinessInputs,
        familyPromotionIndex: indexReceipt,
        appSnapshotManifest: unboundApp,
      },
    }),
    /not bound to the audited family promotion index/u,
  )
  assert.equal(await absent(join(releaseMismatch.root, 'handoff/production-data-readiness.json')), true)

  const changed = await createProductionHandoffFixture()
  const changedFamily = await buildFamilyPromotionIndex({
    root: changed.root,
    outputPath: 'handoff/family-promotion-index.json',
    input: changed.familyBuildInput,
  })
  const changedReceipt = identityReceipt(changedFamily)
  const changedApp = await buildBoundApp(changed, changedFamily)
  await writeFixtureJson(changed.root, 'handoff/other.json', { not: 'the promoted index' })
  const forged = { ...changedReceipt, path: 'handoff/other.json' }
  await assert.rejects(
    buildProductionDataReadiness({
      root: changed.root,
      outputPath: 'handoff/production-data-readiness.json',
      input: {
        ...changed.readinessInputs,
        familyPromotionIndex: forged,
        appSnapshotManifest: identityReceipt(changedApp),
      },
    }),
    /Receipt (?:SHA-256 mismatch|byte length does not match)/u,
  )
})

test('family promotion rejects an engine inventory that does not exactly cover promoted learner nodes', async () => {
  const fixture = await createProductionHandoffFixture({ engineLearnerNodesOverride: 1 })
  await assert.rejects(
    buildFamilyPromotionIndex({
      root: fixture.root,
      outputPath: 'handoff/family-promotion-index.json',
      input: fixture.familyBuildInput,
    }),
    (error: unknown) => error instanceof FamilyPromotionIndexBuildError
      && error.report?.findings.some(({ code }) => code === 'engine-campaign-proof-inventory-invalid') === true,
  )
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { embedProductionAppSnapshot } from '../../scripts/build/embed-app-snapshot.ts'
import { buildFamilyPromotionIndex } from '../../scripts/release/lib/family-promotion-index-builder.ts'
import { buildProductionAppSnapshotManifest } from '../../scripts/release/lib/production-app-snapshot-builder.ts'
import {
  EmbeddedProductionSnapshotPayloadV3Schema,
  MAX_EMBEDDED_FAMILY_UNCOMPRESSED_BLOB_BYTES,
  type EmbeddedProductionSnapshotPayloadV3,
} from '../../src/data/embedded-contract.ts'
import { createEmbeddedOpeningDataSource } from '../../src/data/embedded-production-data-source.ts'
import { supportsOpeningFamilies } from '../../src/data/opening-data-source.ts'
import {
  ProductionWireAppManifestV3Schema,
  type ProductionWireAppManifestV3,
} from '../../src/data/production-wire.ts'
import { productionAppManifestFixture } from '../fixtures/production-app-manifest.ts'
import { createProductionHandoffFixture } from '../fixtures/production-handoff-fixture.ts'

function identityReceipt(result: { outputPath: string; sha256: string; bytes: number }) {
  return {
    path: result.outputPath,
    sha256: result.sha256,
    bytes: result.bytes,
    uncompressedBytes: result.bytes,
    encoding: 'identity' as const,
  }
}

function mutateProductionManifest(
  source: ProductionWireAppManifestV3,
  mutation: (candidate: ProductionWireAppManifestV3) => void,
): ProductionWireAppManifestV3 {
  const candidate = structuredClone(source)
  mutation(candidate)
  return candidate
}

function mutateEmbeddedPayload(
  source: EmbeddedProductionSnapshotPayloadV3,
  mutation: (candidate: EmbeddedProductionSnapshotPayloadV3) => void,
): EmbeddedProductionSnapshotPayloadV3 {
  const candidate = structuredClone(source)
  mutation(candidate)
  return candidate
}

test('production manifest reconciliation rejects every independently mutable inventory invariant', () => {
  const manifest = ProductionWireAppManifestV3Schema.parse(
    productionAppManifestFixture('release-2026q2'),
  )
  const catalogId = manifest.familyCatalogRef.id
  const alternateId = `blob_${'c'.repeat(16)}`
  const invalid = [
    mutateProductionManifest(manifest, (candidate) => { candidate.totals.familyResources += 1 }),
    mutateProductionManifest(manifest, (candidate) => {
      candidate.familyResources[alternateId] = candidate.familyResources[catalogId]!
      delete candidate.familyResources[catalogId]
    }),
    mutateProductionManifest(manifest, (candidate) => {
      candidate.familyResources[catalogId]!.releaseId = 'another-release'
    }),
    mutateProductionManifest(manifest, (candidate) => {
      candidate.familyResources[alternateId] = {
        ...candidate.familyResources[catalogId]!, id: alternateId,
      }
      candidate.totals.familyResources += 1
      candidate.totals.compressedBytes += 1
      candidate.totals.estimatedBase64Bytes += 4
    }),
    mutateProductionManifest(manifest, (candidate) => {
      candidate.familyCatalogRef.path = 'families/other-catalog.json.gz'
    }),
    mutateProductionManifest(manifest, (candidate) => {
      candidate.familyCatalogRef.sha256 = 'd'.repeat(64)
    }),
    mutateProductionManifest(manifest, (candidate) => { candidate.familyCatalogRef.compressedBytes += 1 }),
    mutateProductionManifest(manifest, (candidate) => { candidate.familyCatalogRef.uncompressedBytes += 1 }),
    mutateProductionManifest(manifest, (candidate) => { candidate.totals.compressedBytes += 1 }),
    mutateProductionManifest(manifest, (candidate) => { candidate.totals.estimatedBase64Bytes += 4 }),
  ]
  for (const candidate of invalid) {
    assert.equal(ProductionWireAppManifestV3Schema.safeParse(candidate).success, false)
  }
})

test('production embed rechecks every promoted byte and exposes the family graph through the runtime source', async () => {
  const fixture = await createProductionHandoffFixture()
  const family = await buildFamilyPromotionIndex({
    root: fixture.root,
    outputPath: 'handoff/family-promotion-index.json',
    input: fixture.familyBuildInput,
  })
  const app = await buildProductionAppSnapshotManifest({
    root: fixture.root,
    outputPath: 'handoff/app-wire-v3.json',
    input: {
      schemaVersion: 1,
      familyPromotionIndex: identityReceipt(family),
      browseManifest: fixture.browseManifest,
    },
  })
  const outputPath = resolve(fixture.root, 'embedded/production-snapshot.json')
  const embedded = await embedProductionAppSnapshot({
    root: fixture.root,
    appManifestReceipt: identityReceipt(app),
    browseInputDirectory: fixture.browseInputDirectory,
    outputPath,
  })
  const payload = EmbeddedProductionSnapshotPayloadV3Schema.parse(
    JSON.parse(await readFile(outputPath, 'utf8')) as unknown,
  )
  assert.equal(payload.appManifestSha256, app.sha256)
  assert.equal(embedded.compressedBytes, app.manifest.totals.compressedBytes)

  const resourceId = Object.keys(payload.familyResources).find((id) => id !== payload.familyCatalogRef.id)!
  const alternateId = `blob_${'9'.repeat(16)}`
  const invalidPayloads = [
    mutateEmbeddedPayload(payload, (candidate) => {
      candidate.familyResources[resourceId]!.blob.sha256 = '8'.repeat(64)
    }),
    mutateEmbeddedPayload(payload, (candidate) => {
      candidate.familyResources[resourceId]!.blob.compressedBytes += 1
    }),
    mutateEmbeddedPayload(payload, (candidate) => {
      candidate.familyResources[resourceId]!.blob.uncompressedBytes += 1
    }),
    mutateEmbeddedPayload(payload, (candidate) => {
      const resource = candidate.familyResources[resourceId]!
      candidate.familyResources[alternateId] = resource
      delete candidate.familyResources[resourceId]
    }),
    mutateEmbeddedPayload(payload, (candidate) => {
      candidate.familyResources[resourceId]!.reference.releaseId = 'another-release'
    }),
    mutateEmbeddedPayload(payload, (candidate) => {
      candidate.familyResources[alternateId] = {
        reference: { ...candidate.familyResources[resourceId]!.reference, id: alternateId },
        blob: { ...candidate.familyResources[resourceId]!.blob },
      }
    }),
    mutateEmbeddedPayload(payload, (candidate) => {
      candidate.familyCatalogRef.path = 'families/other-catalog.json.gz'
    }),
    mutateEmbeddedPayload(payload, (candidate) => {
      candidate.familyCatalogRef.sha256 = '7'.repeat(64)
    }),
    mutateEmbeddedPayload(payload, (candidate) => { candidate.familyCatalogRef.compressedBytes += 1 }),
    mutateEmbeddedPayload(payload, (candidate) => { candidate.familyCatalogRef.uncompressedBytes += 1 }),
  ]
  for (const candidate of invalidPayloads) {
    assert.equal(EmbeddedProductionSnapshotPayloadV3Schema.safeParse(candidate).success, false)
  }

  const source = createEmbeddedOpeningDataSource(payload)
  assert.equal(supportsOpeningFamilies(source), true)
  if (!supportsOpeningFamilies(source)) throw new Error('Production source did not expose family operations')
  const catalog = await source.loadFamilyCatalog()
  assert.equal(catalog.familyCount, 1)
  const manifest = await source.loadFamilyManifest('caro-kann')
  const graph = await source.loadRepertoirePack(manifest.packRefs[0]!)
  assert.equal(graph.paths.length, 8)
  assert.equal(graph.pack.pathIds.length, graph.paths.length)
  await assert.rejects(source.loadFamilyCatalog(AbortSignal.abort()), /cancelled/u)
  assert.throws(() => createEmbeddedOpeningDataSource(), /No embedded opening database was supplied/u)
  assert.throws(() => createEmbeddedOpeningDataSource({}), /failed runtime validation/u)

  await assert.rejects(
    embedProductionAppSnapshot({
      root: fixture.root,
      appManifestReceipt: identityReceipt(app),
      browseInputDirectory: fixture.browseInputDirectory,
      outputPath,
    }),
    /EEXIST|exist/u,
  )
})

test('runtime family reads fail closed when an embedded promoted blob changes', async () => {
  const fixture = await createProductionHandoffFixture()
  const family = await buildFamilyPromotionIndex({
    root: fixture.root,
    outputPath: 'handoff/family-promotion-index.json',
    input: fixture.familyBuildInput,
  })
  const app = await buildProductionAppSnapshotManifest({
    root: fixture.root,
    outputPath: 'handoff/app-wire-v3.json',
    input: {
      schemaVersion: 1,
      familyPromotionIndex: identityReceipt(family),
      browseManifest: fixture.browseManifest,
    },
  })
  const outputPath = resolve(fixture.root, 'embedded/production-snapshot.json')
  await embedProductionAppSnapshot({
    root: fixture.root,
    appManifestReceipt: identityReceipt(app),
    browseInputDirectory: fixture.browseInputDirectory,
    outputPath,
  })
  const payload = EmbeddedProductionSnapshotPayloadV3Schema.parse(
    JSON.parse(await readFile(outputPath, 'utf8')) as unknown,
  )
  const catalogResource = payload.familyResources[payload.familyCatalogRef.id]!
  const replacement = catalogResource.blob.base64[0] === 'A' ? 'B' : 'A'
  catalogResource.blob.base64 = `${replacement}${catalogResource.blob.base64.slice(1)}`
  const source = createEmbeddedOpeningDataSource(payload)
  assert.equal(supportsOpeningFamilies(source), true)
  if (!supportsOpeningFamilies(source)) throw new Error('Production source did not expose family operations')
  await assert.rejects(source.loadFamilyCatalog(), /SHA-256 integrity check/u)
})

test('embedded production resources reject pathological decompression sizes', async () => {
  const fixture = await createProductionHandoffFixture()
  const family = await buildFamilyPromotionIndex({
    root: fixture.root,
    outputPath: 'handoff/family-promotion-index.json',
    input: fixture.familyBuildInput,
  })
  const app = await buildProductionAppSnapshotManifest({
    root: fixture.root,
    outputPath: 'handoff/app-wire-v3.json',
    input: {
      schemaVersion: 1,
      familyPromotionIndex: identityReceipt(family),
      browseManifest: fixture.browseManifest,
    },
  })
  const outputPath = resolve(fixture.root, 'embedded/production-snapshot.json')
  await embedProductionAppSnapshot({
    root: fixture.root,
    appManifestReceipt: identityReceipt(app),
    browseInputDirectory: fixture.browseInputDirectory,
    outputPath,
  })
  const payload = JSON.parse(await readFile(outputPath, 'utf8')) as Record<string, unknown>
  const resources = payload.familyResources as Record<string, {
    reference: { uncompressedBytes: number }
    blob: { uncompressedBytes: number }
  }>
  const resource = Object.values(resources)[0]!
  resource.reference.uncompressedBytes = MAX_EMBEDDED_FAMILY_UNCOMPRESSED_BLOB_BYTES + 1
  resource.blob.uncompressedBytes = MAX_EMBEDDED_FAMILY_UNCOMPRESSED_BLOB_BYTES + 1
  assert.equal(EmbeddedProductionSnapshotPayloadV3Schema.safeParse(payload).success, false)
})

import {
  ContentAddressedRefV1Schema,
  OpeningFamilyCatalogV1Schema,
  OpeningFamilyManifestV1Schema,
  type ContentAddressedRefV1,
} from '../../src/domain/opening-family.ts'
import type { ReviewOpeningFamilyEntryV1 } from '../../src/data/review-family-catalog.ts'
import { ContentAddressedFamilyOpeningDataSource } from '../../src/data/family-opening-data-source.ts'
import type { OpeningDataSource } from '../../src/data/opening-data-source.ts'
import { createSyntheticFamilyPromotion } from '../fixtures/synthetic-family-promotion.ts'

interface EncodedResource {
  reference: ContentAddressedRefV1
  bytes: Uint8Array
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function encodeResource(
  value: unknown,
  releaseId: string,
  path: string,
): Promise<EncodedResource> {
  const uncompressed = new TextEncoder().encode(JSON.stringify(value))
  const compressedStream = new Blob([exactBuffer(uncompressed)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))
  const bytes = new Uint8Array(await new Response(compressedStream).arrayBuffer())
  const sha256 = hex(await crypto.subtle.digest('SHA-256', exactBuffer(bytes)))
  return {
    reference: ContentAddressedRefV1Schema.parse({
      schemaVersion: 1,
      id: `blob_${sha256.slice(0, 16)}`,
      releaseId,
      path,
      sha256,
      compressedBytes: bytes.byteLength,
      uncompressedBytes: uncompressed.byteLength,
      contentType: 'application/json',
      contentEncoding: 'gzip',
    }),
    bytes,
  }
}

/**
 * Review-only transport. Every payload is gzip-compressed, byte-bounded, and
 * SHA-256-addressed exactly as a promoted shard would be. No value here is
 * production evidence and this module is excluded from normal build inputs.
 */
export async function createReviewFixtureDataSource(
  base: OpeningDataSource,
  family: ReviewOpeningFamilyEntryV1,
): Promise<ContentAddressedFamilyOpeningDataSource> {
  const promotion = await createSyntheticFamilyPromotion(family, { packCount: 1 })
  const graph = promotion.graphs[0]
  if (!graph) throw new Error('The review fixture graph is missing')
  const releaseId = graph.releaseId
  const graphResource = await encodeResource(
    graph,
    releaseId,
    `review/graphs/${family.id}.json.gz`,
  )
  const provenanceResource = await encodeResource(
    {
      fixtureOnly: true,
      notice: 'Synthetic Playwright review evidence. Never promote or ship.',
    },
    releaseId,
    `review/provenance/${family.id}.json.gz`,
  )
  const manifest = OpeningFamilyManifestV1Schema.parse({
    ...promotion.manifest,
    packRefs: promotion.manifest.packRefs.map((packRef) => ({
      ...packRef,
      graphShardRef: graphResource.reference,
    })),
    provenanceRef: provenanceResource.reference,
  })
  const manifestResource = await encodeResource(
    manifest,
    releaseId,
    `review/manifests/${family.id}.json.gz`,
  )
  const catalog = OpeningFamilyCatalogV1Schema.parse({
    schemaVersion: 1,
    releaseId,
    generatedAt: '2026-07-28T12:00:00.000Z',
    taxonomyLineCount: 3_790,
    familyCount: 1,
    families: [{
      schemaVersion: 1,
      id: family.id,
      canonicalName: family.canonicalName,
      aliases: family.aliases,
      ecoCodes: family.ecoCodes,
      taxonomyLineCount: family.taxonomyLineIds.length,
      packCount: manifest.packRefs.length,
      cardCount: graph.nodes.filter(({ cardId }) => cardId !== undefined).length,
      availableSides: ['white'],
      manifestRef: manifestResource.reference,
    }],
  })
  const catalogResource = await encodeResource(
    catalog,
    releaseId,
    'review/catalog/families.json.gz',
  )
  const resources = new Map<string, Uint8Array>([
    [catalogResource.reference.path, catalogResource.bytes],
    [manifestResource.reference.path, manifestResource.bytes],
    [graphResource.reference.path, graphResource.bytes],
    [provenanceResource.reference.path, provenanceResource.bytes],
  ])

  return new ContentAddressedFamilyOpeningDataSource(base, {
    trustedCatalogRef: catalogResource.reference,
    expectedReleaseId: releaseId,
    reader: {
      async read({ path, maxBytes, signal }) {
        if (signal?.aborted) throw new DOMException('Review fixture read aborted', 'AbortError')
        const bytes = resources.get(path)
        if (!bytes) throw new Error('Review fixture resource is absent')
        if (bytes.byteLength > maxBytes) throw new Error('Review fixture resource exceeded its byte cap')
        return bytes.slice()
      },
    },
  })
}

export function productionAppManifestFixture(
  releaseId: string,
  hash = 'a'.repeat(64),
): unknown {
  const blob = (path: string) => ({
    path,
    compressedBytes: 1,
    uncompressedBytes: 1,
    sha256: hash,
  })
  const partitions = Object.fromEntries(Array.from({ length: 500 }, (_, index) => {
    const eco = `${String.fromCharCode(65 + Math.floor(index / 100))}${String(index % 100).padStart(2, '0')}`
    return [eco, blob(`partitions/${eco}.json.gz`)]
  }))
  const shards = {
    s_0000000000000000: blob('shards/s_0000000000000000.json.gz'),
    s_1111111111111111: blob('shards/s_1111111111111111.json.gz'),
  }
  const browseCompressedBytes = 504
  const browseBase64Bytes = 2_016
  const catalogHash = 'b'.repeat(64)
  const familyCatalogRef = {
    schemaVersion: 1,
    id: `blob_${catalogHash.slice(0, 16)}`,
    releaseId,
    path: 'families/catalog.json.gz',
    sha256: catalogHash,
    compressedBytes: 1,
    uncompressedBytes: 1,
    contentType: 'application/json',
    contentEncoding: 'gzip',
  }
  return {
    v: 3,
    schema: 'linerecall-app-wire-v3',
    releaseId,
    g: '2026-07-16T12:00:00.000Z',
    selectionPolicy: {
      practiceBranches: 'all-eligible-audited',
      maximumPracticeBranches: null,
      terminal: 'evidence-defined-through-ply-100',
    },
    familyPromotionIndexSha256: hash,
    browseManifestSha256: hash,
    browse: {
      v: 2,
      g: '2026-07-16T12:00:00.000Z',
      schema: 'linerecall-app-wire-v2',
      blobs: {
        search: blob('search.json.gz'),
        audit: blob('audit.json.gz'),
      },
      shards,
      partitions,
      totals: {
        lines: 3_790,
        positions: 7_824,
        enginePositions: 1,
        variants: 1,
        shards: 2,
        maxSelectedEcoShards: 1,
        maxSelectedEcoCompressedBytes: 1,
        maxSelectedEcoUncompressedBytes: 1,
        partitions: 500,
        compressedBytes: browseCompressedBytes,
        estimatedBase64Bytes: browseBase64Bytes,
      },
    },
    familyCatalogRef,
    familyResources: {
      [familyCatalogRef.id]: familyCatalogRef,
    },
    totals: {
      families: 1,
      packs: 1,
      graphs: 1,
      puzzleShards: 1,
      familyResources: 1,
      compressedBytes: browseCompressedBytes + 1,
      estimatedBase64Bytes: browseBase64Bytes + 4,
    },
  }
}

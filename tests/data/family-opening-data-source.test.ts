import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import {
  ContentAddressedFamilyOpeningDataSource,
  FamilyResourceError,
  type BoundedFamilyResourceReadRequest,
  type BoundedFamilyResourceReader,
} from '../../src/data/family-opening-data-source.ts'
import type { OpeningDataSource } from '../../src/data/opening-data-source.ts'
import {
  ContentAddressedRefV1Schema,
  OpeningFamilyCatalogV1Schema,
  OpeningFamilyManifestV1Schema,
  TacticalPuzzleShardV1Schema,
  type ContentAddressedRefV1,
  type OpeningFamilyCatalogV1,
  type OpeningFamilyManifestV1,
  type TacticalPuzzleShardV1,
} from '../../src/domain/opening-family.ts'
import type { RepertoireGraphDocument } from '../../src/domain/repertoire.ts'
import { createSyntheticTacticalPuzzle } from '../fixtures/synthetic-tactical-puzzle.ts'
import { createSyntheticTranspositionGraph } from '../fixtures/synthetic-repertoire-graph.ts'

const RELEASE_ID = 'family-loader-fixture-1'
const GENERATED_AT = '2026-07-28T12:00:00.000Z'
const FAMILY_ID = 'fixture-opening'

interface Encoded<T> {
  value: T
  bytes: Uint8Array
  ref: ContentAddressedRefV1
}

function encode<T>(value: T, path: string, releaseId = RELEASE_ID): Encoded<T> {
  const uncompressed = Buffer.from(JSON.stringify(value), 'utf8')
  const bytes = new Uint8Array(gzipSync(uncompressed, { level: 9 }))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    value,
    bytes,
    ref: ContentAddressedRefV1Schema.parse({
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
  }
}

class FixtureReader implements BoundedFamilyResourceReader {
  readonly calls = new Map<string, number>()

  constructor(readonly resources: ReadonlyMap<string, Uint8Array>) {}

  async read(request: BoundedFamilyResourceReadRequest): Promise<Uint8Array> {
    this.calls.set(request.path, (this.calls.get(request.path) ?? 0) + 1)
    if (request.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const bytes = this.resources.get(request.path)
    if (!bytes) throw new Error('Missing fixture resource')
    if (bytes.byteLength > request.maxBytes) throw new Error('Fixture exceeded bounded reader limit')
    return new Uint8Array(bytes)
  }
}

interface FamilyFixture {
  catalog: OpeningFamilyCatalogV1
  catalogRef: ContentAddressedRefV1
  manifest: OpeningFamilyManifestV1
  graph: RepertoireGraphDocument
  puzzleShard: TacticalPuzzleShardV1
  resources: Map<string, Uint8Array>
}

async function familyFixture(): Promise<FamilyFixture> {
  const graph = await createSyntheticTranspositionGraph()
  graph.releaseId = RELEASE_ID
  const graphBlob = encode(graph, 'graphs/fixture-opening.json.gz')

  const puzzleShard = TacticalPuzzleShardV1Schema.parse({
    schemaVersion: 1,
    id: `blob_${'f'.repeat(16)}`,
    releaseId: RELEASE_ID,
    generatedAt: GENERATED_AT,
    familyIds: [FAMILY_ID],
    puzzles: [createSyntheticTacticalPuzzle()],
  })
  const puzzleBlob = encode(puzzleShard, 'puzzles/fixture-opening.json.gz')
  const provenanceBlob = encode(
    { schemaVersion: 1, releaseId: RELEASE_ID, source: 'synthetic-test-only' },
    'provenance/fixture-opening.json.gz',
  )
  const branchId = 'main-line'
  const manifest = OpeningFamilyManifestV1Schema.parse({
    schemaVersion: 1,
    releaseId: RELEASE_ID,
    id: FAMILY_ID,
    canonicalName: 'Fixture Opening',
    aliases: ['Fixture System'],
    ecoCodes: ['A00'],
    taxonomyLineIds: [`tax_${'a'.repeat(24)}`],
    packRefs: [{
      schemaVersion: 1,
      packId: graph.pack.id,
      side: graph.pack.side,
      rootNodeId: graph.pack.rootNodeId,
      graphShardRef: graphBlob.ref,
    }],
    branches: [{
      schemaVersion: 1,
      id: branchId,
      familyId: FAMILY_ID,
      canonicalName: 'Main line',
      aliases: [],
    }],
    pathMemberships: graph.paths.map(({ id }) => ({
      schemaVersion: 1,
      packId: graph.pack.id,
      pathId: id,
      primaryBranchId: branchId,
      secondaryBranchIds: [],
    })),
    puzzleShardRefs: [puzzleBlob.ref],
    provenanceRef: provenanceBlob.ref,
  })
  const manifestBlob = encode(manifest, `families/${FAMILY_ID}.json.gz`)
  const catalog = OpeningFamilyCatalogV1Schema.parse({
    schemaVersion: 1,
    releaseId: RELEASE_ID,
    generatedAt: GENERATED_AT,
    taxonomyLineCount: 1,
    familyCount: 1,
    families: [{
      schemaVersion: 1,
      id: FAMILY_ID,
      canonicalName: manifest.canonicalName,
      aliases: manifest.aliases,
      ecoCodes: manifest.ecoCodes,
      taxonomyLineCount: 1,
      packCount: 1,
      cardCount: graph.nodes.filter(({ cardId }) => cardId !== undefined).length,
      availableSides: ['white'],
      manifestRef: manifestBlob.ref,
    }],
  })
  const catalogBlob = encode(catalog, 'catalog/opening-families.json.gz')
  return {
    catalog,
    catalogRef: catalogBlob.ref,
    manifest,
    graph,
    puzzleShard,
    resources: new Map([
      [catalogBlob.ref.path, catalogBlob.bytes],
      [manifestBlob.ref.path, manifestBlob.bytes],
      [graphBlob.ref.path, graphBlob.bytes],
      [puzzleBlob.ref.path, puzzleBlob.bytes],
      [provenanceBlob.ref.path, provenanceBlob.bytes],
    ]),
  }
}

function unusedBaseSource(): OpeningDataSource {
  return {
    async initialize() { throw new Error('Not used by this fixture') },
    async loadPartition() { throw new Error('Not used by this fixture') },
    async loadAudit() { throw new Error('Not used by this fixture') },
  }
}

function source(
  fixture: FamilyFixture,
  reader: BoundedFamilyResourceReader = new FixtureReader(fixture.resources),
  catalogRef = fixture.catalogRef,
  expectedReleaseId = RELEASE_ID,
): ContentAddressedFamilyOpeningDataSource {
  return new ContentAddressedFamilyOpeningDataSource(unusedBaseSource(), {
    trustedCatalogRef: catalogRef,
    expectedReleaseId,
    reader,
  })
}

function isCode(code: FamilyResourceError['code']): (error: unknown) => boolean {
  return (error) => error instanceof FamilyResourceError && error.code === code
}

test('loads, binds, freezes, and caches each validated family resource once per session', async () => {
  const fixture = await familyFixture()
  const reader = new FixtureReader(fixture.resources)
  const data = source(fixture, reader)

  const catalog = await data.loadFamilyCatalog()
  const manifest = await data.loadFamilyManifest(FAMILY_ID)
  const graph = await data.loadRepertoirePack(manifest.packRefs[0]!)
  const puzzles = await data.loadPuzzleShard(manifest.puzzleShardRefs[0]!)

  assert.equal(catalog.releaseId, RELEASE_ID)
  assert.equal(graph.pack.id, fixture.graph.pack.id)
  assert.equal(puzzles.puzzles[0]?.puzzleId, fixture.puzzleShard.puzzles[0]?.puzzleId)
  assert.equal(Object.isFrozen(catalog), true)
  assert.equal(Object.isFrozen(manifest.packRefs[0]), true)
  assert.equal(Object.isFrozen(graph.nodes[0]), true)
  assert.equal(Object.isFrozen(puzzles.puzzles[0]), true)

  assert.equal(await data.loadFamilyCatalog(), catalog)
  assert.equal(await data.loadFamilyManifest(FAMILY_ID), manifest)
  assert.equal(await data.loadRepertoirePack(manifest.packRefs[0]!), graph)
  assert.equal(await data.loadPuzzleShard(manifest.puzzleShardRefs[0]!), puzzles)
  for (const path of [
    fixture.catalogRef.path,
    fixture.catalog.families[0]!.manifestRef.path,
    manifest.packRefs[0]!.graphShardRef.path,
    manifest.puzzleShardRefs[0]!.path,
  ]) assert.equal(reader.calls.get(path), 1)
})

test('rejects checksum and exact compressed or uncompressed size mismatches', async () => {
  const fixture = await familyFixture()
  const corrupted = new Map(fixture.resources)
  const wrongDigestBytes = new Uint8Array(corrupted.get(fixture.catalogRef.path)!)
  const lastByte = wrongDigestBytes.length - 1
  wrongDigestBytes[lastByte] = wrongDigestBytes[lastByte]! ^ 1
  corrupted.set(fixture.catalogRef.path, wrongDigestBytes)
  await assert.rejects(source(fixture, new FixtureReader(corrupted)).loadFamilyCatalog(), isCode('corrupt'))

  const short = new Map(fixture.resources)
  short.set(fixture.catalogRef.path, short.get(fixture.catalogRef.path)!.slice(0, -1))
  await assert.rejects(source(fixture, new FixtureReader(short)).loadFamilyCatalog(), isCode('corrupt'))

  const wrongUncompressedSize = ContentAddressedRefV1Schema.parse({
    ...fixture.catalogRef,
    uncompressedBytes: fixture.catalogRef.uncompressedBytes + 1,
  })
  await assert.rejects(source(fixture, undefined, wrongUncompressedSize).loadFamilyCatalog(), isCode('corrupt'))
})

test('uses fatal gzip, UTF-8, JSON, and Zod validation', async () => {
  const fixture = await familyFixture()
  const cases = [
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array(gzipSync(new Uint8Array([0xff]))),
    new Uint8Array(gzipSync(Buffer.from('{', 'utf8'))),
    new Uint8Array(gzipSync(Buffer.from(JSON.stringify({ schemaVersion: 1 }), 'utf8'))),
  ]
  for (const [index, bytes] of cases.entries()) {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const ref = ContentAddressedRefV1Schema.parse({
      ...fixture.catalogRef,
      id: `blob_${sha256.slice(0, 16)}`,
      path: `catalog/corrupt-${index}.json.gz`,
      sha256,
      compressedBytes: bytes.byteLength,
      uncompressedBytes: index === 0 ? 4 : index === 1 ? 1 : index === 2 ? 1 : JSON.stringify({ schemaVersion: 1 }).length,
    })
    const reader = new FixtureReader(new Map([[ref.path, bytes]]))
    await assert.rejects(source(fixture, reader, ref).loadFamilyCatalog(), isCode('corrupt'))
  }
})

test('fails closed for unsafe identifiers, unapproved paths, and cross-release or resource identity drift', async () => {
  const fixture = await familyFixture()
  const data = source(fixture)
  await assert.rejects(data.loadFamilyManifest('../fixture-opening'), isCode('missing'))
  await assert.rejects(data.loadRepertoirePack(fixture.manifest.packRefs[0]!), isCode('missing'))

  const manifest = await data.loadFamilyManifest(FAMILY_ID)
  const wrongPathPack = structuredClone(manifest.packRefs[0]!)
  wrongPathPack.graphShardRef.path = 'graphs/a-different-safe-path.json.gz'
  await assert.rejects(data.loadRepertoirePack(wrongPathPack), isCode('missing'))

  const crossReleaseCatalog = structuredClone(fixture.catalog)
  crossReleaseCatalog.releaseId = 'another-release'
  crossReleaseCatalog.families[0]!.manifestRef.releaseId = 'another-release'
  const crossReleaseBlob = encode(crossReleaseCatalog, 'catalog/cross-release.json.gz')
  await assert.rejects(
    source(
      fixture,
      new FixtureReader(new Map([[crossReleaseBlob.ref.path, crossReleaseBlob.bytes]])),
      crossReleaseBlob.ref,
    ).loadFamilyCatalog(),
    isCode('corrupt'),
  )

  const wrongManifest = structuredClone(fixture.manifest)
  wrongManifest.id = 'another-family'
  wrongManifest.branches = wrongManifest.branches.map((branch) => ({ ...branch, familyId: 'another-family' }))
  const wrongManifestBlob = encode(wrongManifest, 'families/wrong-identity.json.gz')
  const wrongCatalog = structuredClone(fixture.catalog)
  wrongCatalog.families[0]!.manifestRef = wrongManifestBlob.ref
  const wrongCatalogBlob = encode(wrongCatalog, 'catalog/wrong-manifest.json.gz')
  const resources = new Map(fixture.resources)
  resources.set(wrongCatalogBlob.ref.path, wrongCatalogBlob.bytes)
  resources.set(wrongManifestBlob.ref.path, wrongManifestBlob.bytes)
  const wrongIdentitySource = source(
    fixture,
    new FixtureReader(resources),
    wrongCatalogBlob.ref,
  )
  await assert.rejects(wrongIdentitySource.loadFamilyManifest(FAMILY_ID), isCode('corrupt'))
})

test('propagates aborts, avoids reads for pre-aborted calls, and evicts cancelled in-flight work for retry', async () => {
  const fixture = await familyFixture()
  const preAborted = new AbortController()
  preAborted.abort()
  const unusedReader = new FixtureReader(fixture.resources)
  await assert.rejects(source(fixture, unusedReader).loadFamilyCatalog(preAborted.signal), isCode('aborted'))
  assert.equal(unusedReader.calls.size, 0)

  let calls = 0
  const retryingReader: BoundedFamilyResourceReader = {
    async read(request) {
      calls += 1
      if (calls > 1) return new Uint8Array(fixture.resources.get(request.path)!)
      return new Promise<Uint8Array>((_resolve, reject) => {
        request.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      })
    },
  }
  const data = source(fixture, retryingReader)
  const controller = new AbortController()
  const pending = data.loadFamilyCatalog(controller.signal)
  controller.abort()
  await assert.rejects(pending, isCode('aborted'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal((await data.loadFamilyCatalog()).releaseId, RELEASE_ID)
  assert.equal(calls, 2)
})

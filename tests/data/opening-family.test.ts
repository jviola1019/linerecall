import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { Chess } from 'chess.js'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import {
  ContentAddressedRefV1Schema,
  OpeningFamilyCatalogV1Schema,
  OpeningFamilyManifestV1Schema,
  OpeningFamilyRegistryError,
  summarizeFamilyBranchRoutes,
  validateFamilyPackGraphOwnership,
  validateOpeningFamilyRegistry,
  validateRequiredOpeningFamilyRegressions,
  type ContentAddressedRefV1,
  type OpeningFamilyCatalogV1,
  type OpeningFamilyManifestV1,
} from '../../src/domain/opening-family.ts'
import {
  stableRepertoireCardId,
  stableRepertoireEdgeId,
  stableRepertoirePathId,
  stableRepertoirePositionId,
  type RepertoireGraphDocument,
} from '../../src/domain/repertoire.ts'
import {
  buildOpeningFamilyCatalog,
  deriveOpeningFamilySeeds,
} from '../../scripts/data/opening-family-registry.ts'
import embeddedSnapshot from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import reviewFamilyCatalog from '../../src/generated/review-family-catalog.json' with { type: 'json' }
import { validateReviewOpeningFamilyCatalog } from '../../src/data/review-family-catalog.ts'
import {
  SYNTHETIC_GRAPH_PROVENANCE_REF,
  createSyntheticRepertoireEvidence,
} from '../fixtures/synthetic-repertoire-evidence.ts'

const RELEASE_ID = 'family-fixture-release-1'
const GENERATED_AT = '2026-07-28T12:00:00.000Z'
const TAXONOMY_IDS = {
  caro: `tax_${'a'.repeat(24)}`,
  sicilian: `tax_${'b'.repeat(24)}`,
  ruy: `tax_${'c'.repeat(24)}`,
}

test('content-addressed family resource paths reject ambiguous separators', () => {
  assert.equal(ContentAddressedRefV1Schema.safeParse(ref(42, 'resources//family.json.gz')).success, false)
})

function ecoRange(volume: string, first: number, last: number): string[] {
  return Array.from({ length: last - first + 1 }, (_, index) => `${volume}${String(first + index).padStart(2, '0')}`)
}

function ref(index: number, path: string): ContentAddressedRefV1 {
  const digestPrefix = index.toString(16).padStart(16, '0')
  return {
    schemaVersion: 1,
    id: `blob_${digestPrefix}`,
    releaseId: RELEASE_ID,
    path,
    sha256: `${digestPrefix}${'0'.repeat(48)}`,
    compressedBytes: 100,
    uncompressedBytes: 200,
    contentType: 'application/json',
    contentEncoding: 'gzip',
  }
}

async function graph(packId: string, eco: string): Promise<RepertoireGraphDocument> {
  const root = new Chess()
  const rootEpd = normalizedEpd(root)
  const move = root.move({ from: 'e2', to: 'e4' })
  const terminalEpd = normalizedEpd(root)
  const rootId = await stableRepertoirePositionId(rootEpd)
  const terminalId = await stableRepertoirePositionId(terminalEpd)
  const edgeId = await stableRepertoireEdgeId(rootEpd, 'e2e4', terminalEpd)
  const pathId = await stableRepertoirePathId(packId, [edgeId])
  return {
    schemaVersion: 1,
    releaseId: RELEASE_ID,
    pack: {
      schemaVersion: 1,
      id: packId,
      side: 'white',
      rootNodeId: rootId,
      rootPly: 0,
      tier: 'primer',
      coreDepth: 1,
      opponentBranchCountAfterRoot: 0,
      coverage: 1,
      ecoCodes: [eco],
      nodeIds: [rootId, terminalId],
      edgeIds: [edgeId],
      pathIds: [pathId],
      provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    },
    nodes: [
      {
        schemaVersion: 1,
        id: rootId,
        epd: rootEpd,
        learnerTurn: true,
        outgoingEdgeIds: [edgeId],
        cardId: stableRepertoireCardId(packId, rootId),
        provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
      },
      {
        schemaVersion: 1,
        id: terminalId,
        epd: terminalEpd,
        learnerTurn: false,
        outgoingEdgeIds: [],
        provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
      },
    ],
    edges: [{
      schemaVersion: 1,
      id: edgeId,
      fromNodeId: rootId,
      toNodeId: terminalId,
      uci: 'e2e4',
      san: move.san,
      role: 'book',
      eligibleForDrill: true,
      acceptedBookTransposition: false,
      evidence: createSyntheticRepertoireEvidence({ uci: 'e2e4', trainedSide: 'white', moveN: 500, reachN: 500 }),
      provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    }],
    paths: [{
      schemaVersion: 1,
      id: pathId,
      packId,
      nodeIds: [rootId, terminalId],
      edgeIds: [edgeId],
      learnerDecisionCount: 1,
      terminalPly: 1,
      terminalStatus: 'evidence_terminal',
      familyTags: ['Fixture line'],
      conditionalUsage: 1,
      provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    }],
  }
}

interface RegistryFixture {
  catalog: OpeningFamilyCatalogV1
  manifests: OpeningFamilyManifestV1[]
  graphs: RepertoireGraphDocument[]
}

async function registryFixture(): Promise<RegistryFixture> {
  const definitions = [
    {
      id: 'caro-kann',
      canonicalName: 'Caro–Kann',
      aliases: ['Caro-Kann', 'Caro-Kann Defense'],
      ecoCodes: ecoRange('B', 10, 19),
      taxonomyLineId: TAXONOMY_IDS.caro,
      packId: 'caro_kann_white',
      eco: 'B10',
      referenceIndex: 1,
    },
    {
      id: 'sicilian-defence',
      canonicalName: 'Sicilian Defence',
      aliases: ['Sicilian Defense'],
      ecoCodes: ecoRange('B', 20, 99),
      taxonomyLineId: TAXONOMY_IDS.sicilian,
      packId: 'sicilian_white',
      eco: 'B20',
      referenceIndex: 4,
    },
    {
      id: 'ruy-lopez',
      canonicalName: 'Ruy Lopez',
      aliases: ['Ruy Lopez Opening'],
      ecoCodes: ecoRange('C', 60, 99),
      taxonomyLineId: TAXONOMY_IDS.ruy,
      packId: 'ruy_lopez_white',
      eco: 'C60',
      referenceIndex: 7,
    },
  ] as const
  const graphs = await Promise.all(definitions.map((definition) => graph(definition.packId, definition.eco)))
  const manifests = definitions.map((definition, index): OpeningFamilyManifestV1 => {
    const graphDocument = graphs[index]!
    return OpeningFamilyManifestV1Schema.parse({
      schemaVersion: 1,
      releaseId: RELEASE_ID,
      id: definition.id,
      canonicalName: definition.canonicalName,
      aliases: definition.aliases,
      ecoCodes: definition.ecoCodes,
      taxonomyLineIds: [definition.taxonomyLineId],
      packRefs: [{
        schemaVersion: 1,
        packId: definition.packId,
        side: 'white',
        rootNodeId: graphDocument.pack.rootNodeId,
        graphShardRef: ref(definition.referenceIndex + 1, `graphs/${definition.id}.json.gz`),
      }],
      branches: [{
        schemaVersion: 1,
        id: 'main-line',
        familyId: definition.id,
        canonicalName: 'Main line',
        aliases: [],
      }],
      pathMemberships: [{
        schemaVersion: 1,
        packId: definition.packId,
        pathId: graphDocument.pack.pathIds[0],
        primaryBranchId: 'main-line',
        secondaryBranchIds: [],
      }],
      puzzleShardRefs: [],
      provenanceRef: ref(definition.referenceIndex + 2, `provenance/${definition.id}.json.gz`),
    })
  })
  const catalog = OpeningFamilyCatalogV1Schema.parse({
    schemaVersion: 1,
    releaseId: RELEASE_ID,
    generatedAt: GENERATED_AT,
    taxonomyLineCount: 3,
    familyCount: 3,
    families: definitions.map((definition, index) => ({
      schemaVersion: 1,
      id: definition.id,
      canonicalName: definition.canonicalName,
      aliases: definition.aliases,
      ecoCodes: definition.ecoCodes,
      taxonomyLineCount: 1,
      packCount: 1,
      cardCount: 1,
      availableSides: ['white'],
      manifestRef: ref(definition.referenceIndex, `families/${definition.id}.json.gz`),
    })),
  })
  return { catalog, manifests, graphs }
}

test('build-time family derivation uses colon roots and reviewed canonical overrides', () => {
  const rows = [
    { sourceLineId: TAXONOMY_IDS.caro, eco: 'B10', name: 'Caro-Kann Defense: Advance Variation' },
    { sourceLineId: TAXONOMY_IDS.sicilian, eco: 'B20', name: 'Sicilian Defense: Alapin Variation' },
    { sourceLineId: TAXONOMY_IDS.ruy, eco: 'C60', name: 'Ruy Lopez: Berlin Defense' },
    { sourceLineId: `tax_${'d'.repeat(24)}`, eco: 'A11', name: 'English Opening: Caro-Kann Defensive System' },
  ]
  const seeds = deriveOpeningFamilySeeds(rows)
  assert.deepEqual(
    seeds.map(({ id }) => id).sort(),
    ['caro-kann', 'english-opening', 'ruy-lopez', 'sicilian-defence'],
  )
  assert.deepEqual(seeds.find(({ id }) => id === 'caro-kann')?.ecoCodes, ['B10'])
  assert.deepEqual(seeds.find(({ id }) => id === 'english-opening')?.ecoCodes, ['A11'])

  const catalog = buildOpeningFamilyCatalog({
    releaseId: RELEASE_ID,
    generatedAt: GENERATED_AT,
    rows,
    manifestReferences: seeds.map((seed, index) => ({
      familyId: seed.id,
      manifestRef: ref(20 + index, `families/${seed.id}.json.gz`),
    })),
    packSummaries: [
      { familyId: 'caro-kann', packId: 'caro_kann_white', side: 'white', cardCount: 42 },
      { familyId: 'caro-kann', packId: 'caro_kann_black', side: 'black', cardCount: 37 },
    ],
  })
  const caro = catalog.families.find(({ id }) => id === 'caro-kann')
  assert.deepEqual(caro?.availableSides, ['black', 'white'])
  assert.equal(caro?.packCount, 2)
  assert.equal(caro?.cardCount, 79)
  assert.equal(catalog.taxonomyLineCount, rows.length)
})

test('the complete embedded taxonomy receives one deterministic primary family assignment per row', () => {
  const search = JSON.parse(gunzipSync(
    Buffer.from(embeddedSnapshot.blobs.search.base64, 'base64'),
  ).toString('utf8')) as {
    l: Array<[string, string, string]>
  }
  const seeds = deriveOpeningFamilySeeds(search.l.map(([sourceLineId, eco, name]) => ({
    sourceLineId,
    eco,
    name,
  })))
  assert.equal(seeds.reduce((total, seed) => total + seed.taxonomyLineIds.length, 0), 3_790)
  assert.equal(new Set(seeds.flatMap(({ taxonomyLineIds }) => taxonomyLineIds)).size, 3_790)
  assert.equal(seeds.filter(({ id }) => id === 'caro-kann').length, 1)
  assert.equal(seeds.filter(({ id }) => id === 'sicilian-defence').length, 1)
  assert.equal(seeds.filter(({ id }) => id === 'ruy-lopez').length, 1)
  assert.deepEqual(seeds.find(({ id }) => id === 'caro-kann')?.ecoCodes, ecoRange('B', 10, 19))
  assert.deepEqual(seeds.find(({ id }) => id === 'sicilian-defence')?.ecoCodes, ecoRange('B', 20, 99))
  assert.deepEqual(seeds.find(({ id }) => id === 'ruy-lopez')?.ecoCodes, ecoRange('C', 60, 99))
})

test('the generated browse catalog is build-time grouped without duplicate Repertoire families', () => {
  const catalog = validateReviewOpeningFamilyCatalog(reviewFamilyCatalog)
  assert.equal(catalog.familyCount, 149)
  assert.equal(catalog.taxonomyLineCount, 3_790)
  assert.equal(catalog.families.filter(({ id }) => id === 'caro-kann').length, 1)
  assert.equal(catalog.families.filter(({ id }) => id === 'sicilian-defence').length, 1)
  assert.equal(catalog.families.filter(({ id }) => id === 'ruy-lopez').length, 1)
  const caro = catalog.families.find(({ id }) => id === 'caro-kann')
  assert.equal(caro?.taxonomyLineIds.length, 110)
  assert.equal(caro?.legacyVariantCount, 40)
  assert.equal(caro?.maximumLegacyLineCards, 8)
})

test('registry validates one canonical Caro-Kann, Sicilian, and Ruy Lopez family', async () => {
  const fixture = await registryFixture()
  const registry = await validateOpeningFamilyRegistry({
    catalog: fixture.catalog,
    manifests: fixture.manifests,
    repertoireGraphs: fixture.graphs,
    expectedTaxonomyLineIds: Object.values(TAXONOMY_IDS),
  })
  assert.equal(registry.manifests.length, 3)
  assert.equal(validateRequiredOpeningFamilyRegressions(registry.manifests).length, 3)
  assert.deepEqual(registry.manifests.find(({ id }) => id === 'caro-kann')?.ecoCodes, ecoRange('B', 10, 19))
  assert.deepEqual(registry.manifests.find(({ id }) => id === 'sicilian-defence')?.ecoCodes, ecoRange('B', 20, 99))
  assert.deepEqual(registry.manifests.find(({ id }) => id === 'ruy-lopez')?.ecoCodes, ecoRange('C', 60, 99))
})

test('registry rejects duplicate primary taxonomy, aliases, release drift, and path ownership conflicts', async () => {
  const fixture = await registryFixture()
  const duplicateTaxonomy = structuredClone(fixture.manifests)
  duplicateTaxonomy[1]!.taxonomyLineIds = [TAXONOMY_IDS.caro]
  await assert.rejects(
    validateOpeningFamilyRegistry({
      catalog: fixture.catalog,
      manifests: duplicateTaxonomy,
      repertoireGraphs: fixture.graphs,
      expectedTaxonomyLineIds: Object.values(TAXONOMY_IDS),
    }),
    (error: unknown) => error instanceof OpeningFamilyRegistryError
      && /multiple primary families/u.test(error.message),
  )

  const aliasConflict = structuredClone(fixture.catalog)
  aliasConflict.families[2]!.aliases = ['SICILIAN DEFENSE']
  await assert.rejects(validateOpeningFamilyRegistry({
    catalog: aliasConflict,
    manifests: fixture.manifests,
    repertoireGraphs: fixture.graphs,
    expectedTaxonomyLineIds: Object.values(TAXONOMY_IDS),
  }))

  const releaseDrift = structuredClone(fixture.graphs)
  releaseDrift[0]!.releaseId = 'another-release'
  await assert.rejects(
    validateOpeningFamilyRegistry({
      catalog: fixture.catalog,
      manifests: fixture.manifests,
      repertoireGraphs: releaseDrift,
      expectedTaxonomyLineIds: Object.values(TAXONOMY_IDS),
    }),
    (error: unknown) => error instanceof OpeningFamilyRegistryError
      && /uses another release/u.test(error.message),
  )

  const pathConflict = structuredClone(fixture.manifests)
  pathConflict[0]!.pathMemberships[0]!.pathId = `path_${'f'.repeat(20)}`
  await assert.rejects(
    validateOpeningFamilyRegistry({
      catalog: fixture.catalog,
      manifests: pathConflict,
      repertoireGraphs: fixture.graphs,
      expectedTaxonomyLineIds: Object.values(TAXONOMY_IDS),
    }),
    (error: unknown) => error instanceof OpeningFamilyRegistryError
      && /do not exactly cover/u.test(error.message),
  )
})

test('family contracts reject noncanonical identifiers, unsafe paths, cycles, and incorrect required ECO ranges', async () => {
  const fixture = await registryFixture()
  const unsafeRef = structuredClone(fixture.catalog.families[0]!.manifestRef)
  unsafeRef.path = '../families/caro-kann.json.gz'
  assert.equal(OpeningFamilyCatalogV1Schema.safeParse({
    ...fixture.catalog,
    families: [{ ...fixture.catalog.families[0], manifestRef: unsafeRef }, ...fixture.catalog.families.slice(1)],
  }).success, false)

  const cyclic = structuredClone(fixture.manifests[0]!)
  cyclic.branches = [
    { schemaVersion: 1, id: 'first', familyId: 'caro-kann', canonicalName: 'First', parentId: 'second', aliases: [] },
    { schemaVersion: 1, id: 'second', familyId: 'caro-kann', canonicalName: 'Second', parentId: 'first', aliases: [] },
  ]
  cyclic.pathMemberships[0]!.primaryBranchId = 'first'
  assert.equal(OpeningFamilyManifestV1Schema.safeParse(cyclic).success, false)

  const wrongRange = structuredClone(fixture.manifests)
  wrongRange[0]!.ecoCodes = wrongRange[0]!.ecoCodes.slice(0, -1)
  assert.throws(
    () => validateRequiredOpeningFamilyRegressions(wrongRange),
    (error: unknown) => error instanceof OpeningFamilyRegistryError && /B10-B19/u.test(error.message),
  )
})

test('pack ownership and branch summaries use the manifest instead of graph display labels', async () => {
  const fixture = await registryFixture()
  const manifest = fixture.manifests[0]!
  const graphDocument = structuredClone(fixture.graphs[0]!)
  graphDocument.paths[0]!.familyTags = ['Untrusted graph label']

  const owned = validateFamilyPackGraphOwnership({
    manifest,
    packId: graphDocument.pack.id,
    graph: graphDocument,
  })
  assert.equal(owned.packRef.packId, graphDocument.pack.id)
  const summaries = summarizeFamilyBranchRoutes({
    manifest,
    side: 'white',
    paths: graphDocument.paths.map((path) => ({
      packId: graphDocument.pack.id,
      pathId: path.id,
      learnerDecisionCount: path.learnerDecisionCount,
      terminalStatus: path.terminalStatus,
    })),
  })
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0]!.canonicalName, 'Main line')
  assert.equal(summaries[0]!.searchText.includes('untrusted'), false)

  const wrongRelease = structuredClone(graphDocument)
  wrongRelease.releaseId = 'another-release'
  assert.throws(
    () => validateFamilyPackGraphOwnership({
      manifest,
      packId: wrongRelease.pack.id,
      graph: wrongRelease,
    }),
    (error: unknown) => error instanceof OpeningFamilyRegistryError
      && /another release/u.test(error.message),
  )
})

test('family manifests reject broken branch, membership, and content ownership independently', async () => {
  const { manifests } = await registryFixture()
  const baseline = manifests[0]!
  const mutations: Array<[string, (manifest: OpeningFamilyManifestV1) => void]> = [
    ['branch family', (m) => { m.branches[0]!.familyId = 'other-family' }],
    ['missing parent', (m) => { m.branches[0]!.parentId = 'missing-parent' }],
    ['self parent', (m) => { m.branches[0]!.parentId = m.branches[0]!.id }],
    ['missing primary branch', (m) => { m.pathMemberships[0]!.primaryBranchId = 'missing-branch' }],
    ['missing secondary branch', (m) => { m.pathMemberships[0]!.secondaryBranchIds = ['missing-branch'] }],
    ['primary repeated as secondary', (m) => { m.pathMemberships[0]!.secondaryBranchIds = ['main-line'] }],
    ['missing pack', (m) => { m.pathMemberships[0]!.packId = 'other_pack' }],
    ['duplicate pack', (m) => { m.packRefs.push(structuredClone(m.packRefs[0]!)) }],
    ['duplicate path', (m) => { m.pathMemberships.push(structuredClone(m.pathMemberships[0]!)) }],
    ['duplicate branch', (m) => { m.branches.push(structuredClone(m.branches[0]!)) }],
    ['duplicate taxonomy row', (m) => { m.taxonomyLineIds.push(m.taxonomyLineIds[0]!) }],
    ['duplicate ECO', (m) => { m.ecoCodes.push(m.ecoCodes[0]!) }],
    ['foreign provenance', (m) => { m.provenanceRef.releaseId = 'other-release' }],
    ['duplicate puzzle shard', (m) => { m.puzzleShardRefs = [ref(55, 'puzzles/a.json.gz'), ref(55, 'puzzles/a.json.gz')] }],
  ]
  for (const [label, mutate] of mutations) {
    const value = structuredClone(baseline)
    mutate(value)
    assert.equal(OpeningFamilyManifestV1Schema.safeParse(value).success, false, label)
  }
  assert.throws(() => validateRequiredOpeningFamilyRegressions(manifests.slice(1)), /must appear exactly once/u)
})

test('registry rejects incomplete inventories and contradictory catalog summaries', async () => {
  const fixture = await registryFixture()
  type Input = Parameters<typeof validateOpeningFamilyRegistry>[0]
  const base: Input = {
    catalog: fixture.catalog,
    manifests: fixture.manifests,
    repertoireGraphs: fixture.graphs,
    expectedTaxonomyLineIds: Object.values(TAXONOMY_IDS),
  }
  const cases: Array<[string, (input: Input) => void, RegExp]> = [
    ['duplicate expected row', (i) => { i.expectedTaxonomyLineIds = [TAXONOMY_IDS.caro, TAXONOMY_IDS.caro, TAXONOMY_IDS.ruy] }, /Expected taxonomy line IDs must be unique/u],
    ['missing expected row', (i) => { i.expectedTaxonomyLineIds = [TAXONOMY_IDS.caro] }, /taxonomy total does not match/u],
    ['unexpected row', (i) => { i.expectedTaxonomyLineIds = [TAXONOMY_IDS.caro, TAXONOMY_IDS.sicilian, `tax_${'d'.repeat(24)}`] }, /has no primary family.*unexpected taxonomy/u],
    ['missing manifest', (i) => { i.manifests = i.manifests.slice(1) }, /has no manifest/u],
    ['duplicate manifest', (i) => { i.manifests = [...i.manifests, i.manifests[0]] }, /manifest IDs must be unique/u],
    ['duplicate graph', (i) => { i.repertoireGraphs = [...i.repertoireGraphs, i.repertoireGraphs[0]] }, /pack IDs must be globally unique/u],
    ['missing graph', (i) => { i.repertoireGraphs = i.repertoireGraphs.slice(1) }, /missing graph pack/u],
    ['name', (i) => { (i.catalog as OpeningFamilyCatalogV1).families[0]!.canonicalName = 'Different opening' }, /summary.*does not match/u],
    ['aliases', (i) => { (i.catalog as OpeningFamilyCatalogV1).families[0]!.aliases = [] }, /summary.*does not match/u],
    ['ECO', (i) => { (i.catalog as OpeningFamilyCatalogV1).families[0]!.ecoCodes = ['B10'] }, /summary.*does not match/u],
    ['line count', (i) => { (i.catalog as OpeningFamilyCatalogV1).families[0]!.taxonomyLineCount = 2 }, /summary.*does not match/u],
    ['pack count', (i) => { (i.catalog as OpeningFamilyCatalogV1).families[0]!.packCount = 2 }, /summary.*does not match/u],
    ['sides', (i) => { (i.catalog as OpeningFamilyCatalogV1).families[0]!.availableSides = ['black'] }, /Catalog sides/u],
    ['cards', (i) => { (i.catalog as OpeningFamilyCatalogV1).families[0]!.cardCount = 2 }, /Catalog card count/u],
    ['pack side', (i) => { (i.manifests[0] as OpeningFamilyManifestV1).packRefs[0]!.side = 'black' }, /side does not match/u],
    ['pack root', (i) => { (i.manifests[0] as OpeningFamilyManifestV1).packRefs[0]!.rootNodeId = fixture.graphs[0]!.nodes[1]!.id }, /root does not match/u],
    ['graph reference reuse', (i) => {
      const manifests = i.manifests as OpeningFamilyManifestV1[]
      manifests[1]!.packRefs[0]!.graphShardRef = structuredClone(manifests[0]!.packRefs[0]!.graphShardRef)
    }, /assigned to multiple packs/u],
    ['manifest absent from catalog', (i) => {
      const catalog = i.catalog as OpeningFamilyCatalogV1
      catalog.families = catalog.families.slice(1)
      catalog.familyCount = catalog.families.length
    }, /manifest is absent from the catalog/u],
    ['unreferenced graph', (i) => {
      const manifest = i.manifests[0] as OpeningFamilyManifestV1
      manifest.packRefs = []
      manifest.pathMemberships = []
    }, /not referenced by a family/u],
    ['missing puzzle shard', (i) => {
      (i.manifests[0] as OpeningFamilyManifestV1).puzzleShardRefs = [ref(55, 'puzzles/expected.json.gz')]
      i.puzzleShards = []
    }, /Referenced puzzle shard.*was not loaded/u],
  ]
  for (const [label, mutate, expected] of cases) {
    const input = structuredClone(base)
    mutate(input)
    await assert.rejects(validateOpeningFamilyRegistry(input), (error: unknown) =>
      error instanceof OpeningFamilyRegistryError && expected.test(error.message), label)
  }
})

test('pack boundary and branch syllabus reject mismatched identities without inferring ownership', async () => {
  const { manifests, graphs } = await registryFixture()
  const manifest = manifests[0]!
  const baseline = graphs[0]!
  assert.throws(() => validateFamilyPackGraphOwnership({ manifest, graph: baseline, packId: 'unknown_pack' }), /not owned/u)
  for (const [change, expected] of [
    [{ id: 'other_pack' }, /another pack identity/u],
    [{ side: 'black' }, /another learner side/u],
    [{ rootNodeId: baseline.nodes[1]!.id }, /another root position/u],
    [{ ecoCodes: ['A00'] }, /ECO code outside/u],
    [{ pathIds: ['path_ffffffffffffffffffff'] }, /do not exactly cover/u],
  ] as const) {
    assert.throws(() => validateFamilyPackGraphOwnership({
      manifest, packId: baseline.pack.id, graph: { ...baseline, pack: { ...baseline.pack, ...change } },
    }), expected)
  }
  const fact = {
    packId: baseline.pack.id, pathId: baseline.paths[0]!.id,
    learnerDecisionCount: 1, terminalStatus: 'evidence_terminal' as const,
  }
  for (const [paths, expected] of [
    [[fact, fact], /more than once/u],
    [[{ ...fact, packId: 'other_pack' }], /another learner side/u],
    [[], /do not exactly cover/u],
    [[{ ...fact, pathId: 'path_ffffffffffffffffffff' }], /do not exactly cover/u],
  ] as const) assert.throws(() => summarizeFamilyBranchRoutes({ manifest, side: 'white', paths }), expected)
  assert.deepEqual(summarizeFamilyBranchRoutes({ manifest, side: 'black', paths: [] }), [])
})

test('syllabus preserves hierarchy, aliases, secondary names, depths, and distinct routes', async () => {
  const { manifests, graphs } = await registryFixture()
  const manifest = structuredClone(manifests[0]!)
  const first = manifest.branches[0]!
  first.parentId = 'parent'
  first.aliases = ['Historical line', 'Alternate name']
  manifest.branches.push(
    { ...first, id: 'same-name', aliases: [], parentId: 'parent' },
    { ...first, id: 'parent', canonicalName: 'Parent family', aliases: [], parentId: undefined },
    { ...first, id: 'secondary', canonicalName: 'Related line', aliases: [], parentId: undefined },
  )
  manifest.pathMemberships[0]!.secondaryBranchIds = ['secondary']
  const original = manifest.pathMemberships[0]!
  const secondId = 'path_ffffffffffffffffffff'
  manifest.pathMemberships.push({ ...original, pathId: secondId, primaryBranchId: 'same-name', secondaryBranchIds: [] })
  const summaries = summarizeFamilyBranchRoutes({ manifest, side: 'white', paths: [
    { packId: graphs[0]!.pack.id, pathId: original.pathId, learnerDecisionCount: 10, terminalStatus: 'depth_capped' },
    { packId: graphs[0]!.pack.id, pathId: secondId, learnerDecisionCount: 4, terminalStatus: 'insufficient_sample' },
  ] })
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0]!.canonicalName, 'Parent family / Main line')
  assert.equal(summaries[0]!.routeCount, 2)
  assert.deepEqual([summaries[0]!.minimumDepth, summaries[0]!.maximumDepth], [4, 10])
  assert.deepEqual(summaries[0]!.aliases, ['Alternate name', 'Historical line'])
  assert.deepEqual(summaries[0]!.terminalStatuses, ['depth_capped', 'insufficient_sample'])
  assert.match(summaries[0]!.searchText, /related line/u)
})

import type { ReviewOpeningFamilyEntryV1 } from '../../src/data/review-family-catalog.ts'
import {
  OpeningFamilyManifestV1Schema,
  type ContentAddressedRefV1,
  type OpeningFamilyManifestV1,
} from '../../src/domain/opening-family.ts'
import {
  stableRepertoireCardId,
  stableRepertoirePathId,
  type RepertoireGraphDocument,
} from '../../src/domain/repertoire.ts'
import { GRAPH_TRAINING_CONTRACT_ID } from '../../src/domain/graph-training-session.ts'
import type { FamilyGraphResourceSet } from '../../src/app/components/OpeningFamilyView.tsx'
import { createSyntheticTranspositionGraph } from './synthetic-repertoire-graph.ts'

function contentRef(
  releaseId: string,
  sequence: number,
  path: string,
): ContentAddressedRefV1 {
  const nibble = (sequence % 16).toString(16)
  const sha256 = nibble.repeat(64)
  return {
    schemaVersion: 1,
    id: `blob_${sha256.slice(0, 16)}`,
    releaseId,
    path,
    sha256,
    compressedBytes: 1_024 + sequence,
    uncompressedBytes: 4_096 + sequence,
    contentType: 'application/json',
    contentEncoding: 'gzip',
  }
}

async function repackGraph(
  source: RepertoireGraphDocument,
  packId: string,
  ecoCode: string,
  untrustedFamilyLabel: string,
): Promise<RepertoireGraphDocument> {
  const graph = structuredClone(source)
  graph.pack.id = packId
  graph.pack.ecoCodes = [ecoCode]
  for (const node of graph.nodes) {
    if (node.cardId !== undefined) node.cardId = stableRepertoireCardId(packId, node.id)
  }
  for (const [index, path] of graph.paths.entries()) {
    path.packId = packId
    path.id = await stableRepertoirePathId(packId, path.edgeIds)
    path.familyTags = [`${untrustedFamilyLabel} ${index + 1}`]
  }
  graph.pack.pathIds = graph.paths.map(({ id }) => id)
  return graph
}

export async function createSyntheticFamilyPromotion(
  family: ReviewOpeningFamilyEntryV1,
  options: {
    packCount?: number
    branchLabel?: string
    side?: 'white' | 'black'
  } = {},
): Promise<{
  manifest: OpeningFamilyManifestV1
  graphs: RepertoireGraphDocument[]
  resources: FamilyGraphResourceSet
}> {
  const packCount = options.packCount ?? 2
  const side = options.side ?? 'white'
  if (side !== 'white') {
    throw new Error('The synthetic transposition fixture currently models White learner decisions only')
  }
  const branchLabel = options.branchLabel ?? 'Manifest variation'
  const source = await createSyntheticTranspositionGraph()
  const ecoCode = family.ecoCodes[0]!
  const graphs = await Promise.all(Array.from({ length: packCount }, async (_, index) =>
    repackGraph(source, `fixture_${family.id}_pack_${index + 1}`, ecoCode, 'Untrusted graph label')))
  const releaseId = source.releaseId
  const packRefs = graphs.map((graph, index) => ({
    schemaVersion: 1 as const,
    packId: graph.pack.id,
    side,
    rootNodeId: graph.pack.rootNodeId,
    graphShardRef: contentRef(releaseId, index + 1, `graphs/family-pack-${index + 1}.json.gz`),
  }))
  const branches = graphs.flatMap((graph, graphIndex) => graph.paths.map((_, pathIndex) => ({
    schemaVersion: 1 as const,
    id: `signed-branch-${graphIndex + 1}-${pathIndex + 1}`,
    familyId: family.id,
    canonicalName: branchLabel,
    aliases: [`${branchLabel} alias ${graphIndex + 1}-${pathIndex + 1}`],
  })))
  let branchIndex = 0
  const pathMemberships = graphs.flatMap((graph) => graph.paths.map((path) => ({
    schemaVersion: 1 as const,
    packId: graph.pack.id,
    pathId: path.id,
    primaryBranchId: branches[branchIndex++]!.id,
    secondaryBranchIds: [],
  })))
  const manifest = OpeningFamilyManifestV1Schema.parse({
    schemaVersion: 1,
    releaseId,
    id: family.id,
    canonicalName: family.canonicalName,
    aliases: family.aliases,
    ecoCodes: family.ecoCodes,
    taxonomyLineIds: family.taxonomyLineIds,
    packRefs,
    branches,
    pathMemberships,
    puzzleShardRefs: [],
    provenanceRef: contentRef(releaseId, 15, 'provenance/family.json.gz'),
  })
  const packResources = Object.fromEntries(graphs.map((graph) => [
    graph.pack.id,
    {
      status: 'ready' as const,
      envelope: { contractId: GRAPH_TRAINING_CONTRACT_ID, graph },
    },
  ]))
  const primaryResource = packResources[graphs[0]!.pack.id]
  if (!primaryResource) throw new Error('Synthetic family promotion did not create its primary pack resource')
  return {
    manifest,
    graphs,
    resources: {
      manifest,
      packResources,
      white: primaryResource,
    },
  }
}

import {
  stableRepertoireCardId,
  stableRepertoirePathId,
  type EligibleSourceEdgeInventoryV1,
  type RepertoireGraphDocument,
} from '../../src/domain/repertoire.ts'
import { createSyntheticCaroKannGraph } from './synthetic-caro-kann-graph.ts'

/**
 * A promoted-pack-shaped fixture used by the all-family playthrough test.
 * Nothing in this fixture is corpus evidence: all graphs are derived from a
 * legal synthetic graph and carry the fixture provenance marker from that
 * graph.
 */
export interface SyntheticPromotedFamilyPack {
  familyId: string
  side: 'black'
  packId: string
  graph: RepertoireGraphDocument
  eligibleInventory: EligibleSourceEdgeInventoryV1
}

const SYNTHETIC_SOURCE_RECEIPT = 'a'.repeat(64)

/** Clone a legal synthetic graph while giving the pack and paths new stable identities. */
export async function cloneSyntheticPromotedPack(options: {
  source: RepertoireGraphDocument
  familyId: string
  packId: string
  pathFamilyTags?: readonly string[]
}): Promise<SyntheticPromotedFamilyPack> {
  const { source, familyId, packId } = options
  const tags = [...(options.pathFamilyTags ?? [familyId])]
  const nodes = source.nodes.map((node) => node.learnerTurn
    ? { ...node, cardId: stableRepertoireCardId(packId, node.id) }
    : { ...node })
  const paths = await Promise.all(source.paths.map(async (path, index) => ({
    ...path,
    id: await stableRepertoirePathId(packId, path.edgeIds),
    packId,
    familyTags: tags.length === source.paths.length ? [tags[index]!] : tags,
  })))
  const graph: RepertoireGraphDocument = {
    ...source,
    pack: {
      ...source.pack,
      id: packId,
      pathIds: paths.map(({ id }) => id),
      nodeIds: nodes.map(({ id }) => id),
    },
    nodes,
    paths,
  }
  const eligibleInventory: EligibleSourceEdgeInventoryV1 = {
    schemaVersion: 1,
    releaseId: graph.releaseId,
    packId,
    sourceReceiptSha256: SYNTHETIC_SOURCE_RECEIPT,
    eligibleEdgeIds: graph.edges.filter(({ eligibleForDrill }) => eligibleForDrill).map(({ id }) => id),
  }
  return { familyId, side: 'black', packId, graph, eligibleInventory }
}

/**
 * Construct one promoted-shaped pack for each canonical family. Eight legal
 * root-to-terminal paths per family give 1,192 total fixture paths. This checks
 * family/side/pack ownership with small batches; the separate 1,001-path
 * graph-session tests check the real per-family batch boundary.
 */
export async function createSyntheticPromotedFamilyUniverse(
  familyIds: readonly string[],
  releaseId = 'synthetic-family-playthrough-not-for-shipping',
): Promise<SyntheticPromotedFamilyPack[]> {
  const source = await createSyntheticCaroKannGraph(releaseId)
  return Promise.all(familyIds.map((familyId) => cloneSyntheticPromotedPack({
    source,
    familyId,
    packId: `${familyId}_black`,
  })))
}

/** Three named promoted-practice fixtures share the same legal synthetic graph
 * shape. Their Caro/Sicilian/Ruy labels exercise ownership/UI behavior only;
 * they are not opening-accuracy claims. */
export async function createSyntheticNamedPromotedPracticeFixtures(): Promise<{
  caroKann: SyntheticPromotedFamilyPack
  sicilian: SyntheticPromotedFamilyPack
  ruyLopez: SyntheticPromotedFamilyPack
}> {
  const source = await createSyntheticCaroKannGraph()
  const [caroKann, sicilian, ruyLopez] = await Promise.all([
    cloneSyntheticPromotedPack({
      source,
      familyId: 'caro-kann',
      packId: 'caro_kann_black',
      pathFamilyTags: ['Advance', 'Advance', 'Exchange', 'Panov', 'Classical', 'Two Knights', 'Fantasy', 'Gurgenidze'],
    }),
    cloneSyntheticPromotedPack({ source, familyId: 'sicilian-defence', packId: 'sicilian_black' }),
    cloneSyntheticPromotedPack({ source, familyId: 'ruy-lopez', packId: 'ruy_lopez_black' }),
  ])
  return { caroKann, sicilian, ruyLopez }
}

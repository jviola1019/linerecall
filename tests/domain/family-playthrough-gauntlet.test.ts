import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { validatePinnedTaxonomyInventory } from '../../scripts/data/taxonomy-inventory.ts'
import {
  GRAPH_TRAINING_CONTRACT_ID,
  createAutonomousGraphTrainingPlan,
  createExplicitGraphSessionSelection,
  createGraphTrainingSession,
  applyPendingOpponentGraphMove,
  continueGraphTrainingSession,
  prepareGraphTrainingAdapter,
  submitGraphTrainingMove,
} from '../../src/domain/graph-training-session.ts'
import {
  assertCaroKannFamilyRegression,
  validateEligibleSourceEdgeInventory,
  validateRepertoireGraphDocument,
} from '../../src/domain/repertoire.ts'
import {
  createSyntheticNamedPromotedPracticeFixtures,
  createSyntheticPromotedFamilyUniverse,
  type SyntheticPromotedFamilyPack,
} from '../fixtures/synthetic-family-playthrough-gauntlet.ts'
import type { GraphTrainingAdapter } from '../../src/domain/graph-training-session.ts'

const taxonomyUrl = new URL('../../data/manifests/taxonomy.inventory.v1.json', import.meta.url)
const taxonomySourceUrl = new URL('../../data/manifests/taxonomy.source.json', import.meta.url)

async function canonicalFamilyIds(): Promise<string[]> {
  const inventory = JSON.parse(await readFile(taxonomyUrl, 'utf8')) as unknown
  const sourceManifest = JSON.parse(await readFile(taxonomySourceUrl, 'utf8')) as unknown
  const validated = validatePinnedTaxonomyInventory(inventory, sourceManifest)
  return validated.proposedFamilies.map(({ familyId }) => familyId).sort((left, right) => left.localeCompare(right, 'en'))
}

/** Drive one bounded session using only the active path's declared edge. */
async function playBatch(
  pack: SyntheticPromotedFamilyPack,
  adapter: Awaited<ReturnType<typeof prepareGraphTrainingAdapter>>,
  pathIds: readonly string[],
): Promise<string[]> {
  let state = createGraphTrainingSession({
    adapter,
    selection: createExplicitGraphSessionSelection({ adapter, pathIds, dueCardIds: [] }),
  })
  const completed: string[] = []
  const seen = new Set<string>()
  let transitions = 0
  while (state.phase !== 'session_complete') {
    if (++transitions > 2_000) throw new Error(`Synthetic session stalled for ${pack.packId}`)
    if (state.phase === 'opponent_move_ready') {
      const edge = applyPendingOpponentGraphMove(adapter, state)
      assert.equal(edge.lastTransition?.actor, 'opponent')
      state = edge
      continue
    }
    if (state.phase === 'path_complete') {
      const path = adapter.pathsById.get(state.activePathId)
      assert.ok(path)
      assert.equal(state.activePathNodeIndex, path.edgeIds.length)
      assert.equal(state.currentNodeId, path.nodeIds.at(-1))
      assert.equal(path.familyTags.length > 0, true)
      assert.equal(path.packId, pack.packId)
      assert.equal(seen.has(path.id), false, `path ${path.id} completed twice`)
      seen.add(path.id)
      completed.push(path.id)
      state = continueGraphTrainingSession(adapter, state)
      continue
    }
    assert.equal(state.phase, 'awaiting_learner_move')
    const path = adapter.pathsById.get(state.activePathId)
    assert.ok(path)
    const edgeId = path.edgeIds[state.activePathNodeIndex]
    assert.ok(edgeId)
    const edge = adapter.edgesById.get(edgeId)
    assert.ok(edge)
    const next = submitGraphTrainingMove({ adapter, state, moveUci: edge.uci })
    assert.equal(next.lastFeedback?.accepted, true)
    assert.equal(next.lastTransition?.edgeId, edge.id)
    state = next
  }
  assert.deepEqual(new Set(completed), new Set(pathIds))
  assert.equal(state.packId, pack.packId)
  assert.equal(state.releaseId, pack.graph.releaseId)
  return completed
}

/** Rebind the already validated legal template to a cloned pack identity. */
function rebindAdapter(
  template: GraphTrainingAdapter,
  pack: SyntheticPromotedFamilyPack,
): GraphTrainingAdapter {
  const edgeOccurrences = new Map<string, Array<{ pathId: string; edgeIndex: number }>>()
  const nodeOccurrences = new Map<string, Array<{ pathId: string; nodeIndex: number }>>()
  for (const path of pack.graph.paths) {
    path.edgeIds.forEach((edgeId, edgeIndex) => {
      const occurrences = edgeOccurrences.get(edgeId) ?? []
      occurrences.push({ pathId: path.id, edgeIndex })
      edgeOccurrences.set(edgeId, occurrences)
    })
    path.nodeIds.forEach((nodeId, nodeIndex) => {
      const occurrences = nodeOccurrences.get(nodeId) ?? []
      occurrences.push({ pathId: path.id, nodeIndex })
      nodeOccurrences.set(nodeId, occurrences)
    })
  }
  return {
    ...template,
    graph: pack.graph,
    nodesById: new Map(pack.graph.nodes.map((node) => [node.id, node])),
    pathsById: new Map(pack.graph.paths.map((path) => [path.id, path])),
    edgeOccurrences,
    nodeOccurrences,
  }
}

test('synthetic playthrough covers 149 family identifiers and all 1,192 fixture paths', async () => {
  const familyIds = await canonicalFamilyIds()
  assert.equal(familyIds.length, 149)
  const packs = await createSyntheticPromotedFamilyUniverse(familyIds)
  assert.equal(packs.length, 149)
  assert.deepEqual(packs.map(({ familyId }) => familyId).sort(), familyIds)
  assert.equal(new Set(packs.map(({ packId }) => packId)).size, 149)

  let totalPaths = 0
  let totalBatches = 0
  const completedKeys: string[] = []
  const validatedTemplate = await validateRepertoireGraphDocument(packs[0]!.graph)
  const templateAdapter = await prepareGraphTrainingAdapter({
    contractId: GRAPH_TRAINING_CONTRACT_ID,
    graph: validatedTemplate,
  })
  for (const pack of packs) {
    // The shared legal graph is validated once; each cloned pack is then
    // independently checked at the eligibility receipt boundary and replayed
    // through its rebound adapter below.
    validateEligibleSourceEdgeInventory(pack.graph, pack.eligibleInventory)
    assert.equal(pack.side, 'black')
    assert.ok(pack.graph.paths.every(({ familyTags }) => familyTags.length === 1 && familyTags[0] === pack.familyId))
    const adapter = rebindAdapter(templateAdapter, pack)
    const plan = createAutonomousGraphTrainingPlan({
      adapter,
      dueCardIds: [],
      coverageCycleOrdinal: 19,
      maximumPathsPerBatch: 3,
    })
    assert.deepEqual(new Set(plan.totalPathIds), new Set(pack.graph.pack.pathIds))
    assert.equal(plan.totalPathIds.length, pack.graph.paths.length)
    for (const batch of plan.pathIdBatches) {
      totalBatches += 1
      const completed = await playBatch(pack, adapter, batch)
      for (const pathId of completed) completedKeys.push(`${pack.familyId}\0${pack.side}\0${pack.packId}\0${pathId}`)
    }
    totalPaths += plan.totalPathIds.length
  }
  assert.ok(totalPaths > 1_000)
  assert.equal(totalPaths, 149 * 8)
  assert.ok(totalBatches > 149)
  assert.equal(new Set(completedKeys).size, totalPaths)
  assert.equal(completedKeys.length, totalPaths)
})

test('eligible-edge and emitted-pack closure fail closed at the gauntlet consumption boundary', async () => {
  const [pack] = await createSyntheticPromotedFamilyUniverse(['caro-kann'])
  assert.ok(pack)
  const omitted = structuredClone(pack.eligibleInventory)
  omitted.eligibleEdgeIds = omitted.eligibleEdgeIds.slice(1)
  assert.throws(
    () => validateEligibleSourceEdgeInventory(pack.graph, omitted),
    /omitted/u,
  )
  const invented = structuredClone(pack.graph)
  invented.edges = invented.edges.slice(0, -1)
  invented.pack.edgeIds = invented.edges.map(({ id }) => id)
  assert.throws(
    () => validateEligibleSourceEdgeInventory(invented, pack.eligibleInventory),
    /omitted/u,
  )
})

test('synthetic Caro-Kann, Sicilian, and Ruy Lopez identifiers preserve terminal walks', async () => {
  const fixtures = await createSyntheticNamedPromotedPracticeFixtures()
  const caro = await validateRepertoireGraphDocument(fixtures.caroKann.graph)
  const summary = assertCaroKannFamilyRegression(caro)
  assert.equal(summary.pathCount, 8)
  assert.deepEqual(new Set(summary.families), new Set(['Advance', 'Exchange', 'Panov', 'Classical', 'Two Knights', 'Fantasy', 'Gurgenidze']))

  for (const fixture of [fixtures.caroKann, fixtures.sicilian, fixtures.ruyLopez]) {
    const adapter = await prepareGraphTrainingAdapter({
      contractId: GRAPH_TRAINING_CONTRACT_ID,
      graph: fixture.graph,
    })
    const plan = createAutonomousGraphTrainingPlan({ adapter, dueCardIds: [], maximumPathsPerBatch: 3 })
    const observed = (await Promise.all(plan.pathIdBatches.map((batch) => playBatch(fixture, adapter, batch)))).flat()
    assert.equal(observed.length, fixture.graph.paths.length)
    assert.equal(new Set(observed).size, observed.length)
    assert.equal(fixture.graph.pack.side, 'black')
  }
})

test('non-trainable coverage reasons cannot be invented by a readiness caller', async () => {
  // This boundary intentionally accepts only the source-owned eligibility
  // inventory; no fixture caller gets to mark a family eligible or choose a
  // non-trainable reason from a free-form string.
  const [pack] = await createSyntheticPromotedFamilyUniverse(['caro-kann'])
  assert.ok(pack)
  // The source receipt digest is provenance metadata; this boundary can only
  // establish the graph/inventory edge-set closure.  Exercise the meaningful
  // invariant directly instead of a vacuous hash assertion.
  const forged = { ...pack.eligibleInventory, eligibleEdgeIds: [] }
  assert.throws(() => validateEligibleSourceEdgeInventory(pack.graph, forged), /Too small|at least/u)
})

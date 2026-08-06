import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess } from 'chess.js'
import {
  GRAPH_TRAINING_BATCH_PATH_LIMIT,
  GRAPH_TRAINING_CONTRACT_ID,
  applyPendingOpponentGraphMove,
  continueGraphTrainingSession,
  createAutonomousGraphTrainingPlan,
  createBoundedGraphTrainingPlan,
  createExplicitGraphSessionSelection,
  createFamilyTrainingCursorSnapshot,
  createGraphTrainingPathCompletion,
  createGraphTrainingSession,
  coverageCycleOrdinalFromId,
  deferGraphTrainingPathToCycleEnd,
  expectedGraphTrainingMoves,
  graphTrainingFen,
  listGraphTrainingPaths,
  markGraphTrainingHint,
  nextNonemptyGraphTrainingBatch,
  pendingOpponentGraphMove,
  prepareGraphTrainingAdapter,
  removeTransferredPathFromFutureBatches,
  restoreGraphTrainingCycleFromCursor,
  skipCurrentGraphTrainingPath,
  submitGraphTrainingMove,
  summarizeGraphTrainingCoverage,
  type GraphTrainingAdapter,
  type GraphTrainingSessionState,
} from '../../src/domain/graph-training-session.ts'
import { stableRepertoireCardId } from '../../src/domain/repertoire.ts'
import { createSyntheticTranspositionGraph } from '../fixtures/synthetic-repertoire-graph.ts'

async function adapterFixture() {
  const graph = await createSyntheticTranspositionGraph()
  const adapter = await prepareGraphTrainingAdapter({ contractId: GRAPH_TRAINING_CONTRACT_ID, graph })
  return { graph, adapter }
}

function expandAdapterForBatchBoundary(
  adapter: GraphTrainingAdapter,
  pathCount: number,
): { adapter: GraphTrainingAdapter; dueCardIds: string[] } {
  const template = adapter.graph.paths[0]!
  const templateLearnerNode = adapter.nodesById.get(template.nodeIds[2]!)!
  const paths = Array.from({ length: pathCount }, (_, index) => {
    const suffix = index.toString(16)
    const pathId = `path_f${suffix.padStart(19, '0')}`
    const learnerNodeId = `pos_f${suffix.padStart(15, '0')}`
    const nodeIds = [...template.nodeIds]
    nodeIds[2] = learnerNodeId
    return { ...template, id: pathId, nodeIds }
  })
  const syntheticLearnerNodes = paths.map((path) => {
    const id = path.nodeIds[2]!
    return {
      ...templateLearnerNode,
      id,
      cardId: stableRepertoireCardId(adapter.graph.pack.id, id),
    }
  })
  const graph = {
    ...adapter.graph,
    pack: {
      ...adapter.graph.pack,
      pathIds: paths.map(({ id }) => id),
      nodeIds: [...adapter.graph.pack.nodeIds, ...syntheticLearnerNodes.map(({ id }) => id)],
    },
    paths,
    nodes: [...adapter.graph.nodes, ...syntheticLearnerNodes],
  }
  return {
    adapter: {
      ...adapter,
      graph,
      pathsById: new Map(paths.map((path) => [path.id, path])),
      nodesById: new Map(graph.nodes.map((node) => [node.id, node])),
    },
    dueCardIds: syntheticLearnerNodes.map(({ cardId }) => cardId),
  }
}

test('the v3 feature boundary rejects raw v2-shaped input and validates every learner card', async () => {
  const graph = await createSyntheticTranspositionGraph()
  await assert.rejects(() => prepareGraphTrainingAdapter(graph), /contractId|Invalid input/u)
  await assert.rejects(
    () => prepareGraphTrainingAdapter({ contractId: 'linerecall.legacy-line.v2', graph }),
    /Invalid input/u,
  )

  const missingCard = structuredClone(graph)
  const learner = missingCard.nodes.find((node) => node.learnerTurn && node.outgoingEdgeIds.length > 0)!
  delete learner.cardId
  await assert.rejects(
    () => prepareGraphTrainingAdapter({ contractId: GRAPH_TRAINING_CONTRACT_ID, graph: missingCard }),
    /missing its stable graph-training card identity/u,
  )
})

test('all audited paths are exposed and explicit selection never applies a top-N visibility cutoff', async () => {
  const { adapter } = await adapterFixture()
  const paths = listGraphTrainingPaths(adapter)
  assert.equal(paths.length, adapter.graph.paths.length)
  assert.deepEqual(new Set(paths.map(({ id }) => id)), new Set(adapter.graph.pack.pathIds))
  assert.equal(paths[0]?.familyTags[0], 'Knight first')

  const selection = createExplicitGraphSessionSelection({
    adapter,
    pathIds: paths.map(({ id }) => id),
    dueCardIds: [],
  })
  assert.deepEqual(new Set(selection.includedPathIds), new Set(adapter.graph.pack.pathIds))
})

test('autonomous planning batches every audited path exactly once and progress counts families without a top-N cutoff', async () => {
  const { adapter } = await adapterFixture()
  const plan = createAutonomousGraphTrainingPlan({
    adapter,
    dueCardIds: [],
    coverageCycleOrdinal: 3,
    maximumPathsPerBatch: 1,
  })
  assert.equal(plan.coverageCycleOrdinal, 3)
  assert.equal(plan.pathIdBatches.length, adapter.graph.paths.length)
  assert.ok(plan.pathIdBatches.every((batch) => batch.length === 1))
  assert.deepEqual(new Set(plan.totalPathIds), new Set(adapter.graph.pack.pathIds))

  const completed = [plan.totalPathIds[0]!, plan.totalPathIds[0]!, 'path_ffffffffffffffffffff']
  const progress = summarizeGraphTrainingCoverage({ adapter, includedPathIds: plan.totalPathIds, completedPathIds: completed })
  assert.equal(progress.totalPathCount, 2)
  assert.equal(progress.completedPathCount, 1)
  assert.equal(progress.remainingPathCount, 1)
  assert.deepEqual(progress.families.map(({ family }) => family), ['Fianchetto first', 'Knight first'])
  assert.equal(progress.families.reduce((sum, family) => sum + family.completedPathCount, 0), 1)

  assert.throws(() => createAutonomousGraphTrainingPlan({ adapter, dueCardIds: [], maximumPathsPerBatch: 0 }), /1 through 1000/u)
  assert.throws(() => createAutonomousGraphTrainingPlan({ adapter, dueCardIds: [], maximumPathsPerBatch: 1_001 }), /1 through 1000/u)
  assert.throws(() => createAutonomousGraphTrainingPlan({ adapter, dueCardIds: [], maximumPathsPerBatch: 1.5 }), /1 through 1000/u)
  assert.throws(() => createAutonomousGraphTrainingPlan({ adapter, dueCardIds: [], coverageCycleOrdinal: -1 }), /nonnegative/u)
  assert.throws(() => createAutonomousGraphTrainingPlan({ adapter, dueCardIds: [], coverageCycleOrdinal: 1.5 }), /nonnegative/u)
  assert.throws(
    () => summarizeGraphTrainingCoverage({ adapter, includedPathIds: [], completedPathIds: [] }),
    /at least one/u,
  )
  assert.throws(
    () => summarizeGraphTrainingCoverage({ adapter, includedPathIds: ['path_ffffffffffffffffffff'], completedPathIds: [] }),
    /unavailable path/u,
  )
})

test('an authoritative due-card set survives the 1,000-path batch boundary', async () => {
  const fixture = await adapterFixture()
  const expanded = expandAdapterForBatchBoundary(fixture.adapter, 1_001)
  const plan = createAutonomousGraphTrainingPlan({
    adapter: expanded.adapter,
    dueCardIds: expanded.dueCardIds,
  })
  assert.deepEqual(plan.pathIdBatches.map(({ length }) => length), [1_000, 1])
  const branchPlan = createBoundedGraphTrainingPlan({
    adapter: expanded.adapter,
    pathIds: plan.totalPathIds,
    dueCardIds: expanded.dueCardIds,
    coverageCycleOrdinal: 3,
  })
  assert.deepEqual(branchPlan.pathIdBatches.map(({ length }) => length), [1_000, 1])
  assert.deepEqual(branchPlan.totalPathIds, plan.totalPathIds)

  const firstSelection = createExplicitGraphSessionSelection({
    adapter: expanded.adapter,
    pathIds: plan.pathIdBatches[0]!,
    dueCardIds: expanded.dueCardIds,
  })
  const firstSession = createGraphTrainingSession({ adapter: expanded.adapter, selection: firstSelection })
  assert.equal(firstSession.dueCardIds.length, 1_001)

  const firstBatchNodeIds = new Set(
    plan.pathIdBatches[0]!.flatMap((pathId) => expanded.adapter.pathsById.get(pathId)!.nodeIds),
  )
  const unreviewedAfterFirstBatch = firstSession.dueCardIds.filter((cardId) => {
    const nodeId = cardId.slice(cardId.indexOf('::') + 2)
    return !firstBatchNodeIds.has(nodeId)
  })
  assert.equal(unreviewedAfterFirstBatch.length, 1)

  const secondSelection = createExplicitGraphSessionSelection({
    adapter: expanded.adapter,
    pathIds: plan.pathIdBatches[1]!,
    dueCardIds: unreviewedAfterFirstBatch,
  })
  assert.deepEqual(secondSelection.dueCardIds, unreviewedAfterFirstBatch)
})

test('a path transferred from a future 1,001-path batch is claimed once and skipped by later batches', async () => {
  const fixture = await adapterFixture()
  const expanded = expandAdapterForBatchBoundary(fixture.adapter, 1_001)
  const plan = createAutonomousGraphTrainingPlan({
    adapter: expanded.adapter,
    dueCardIds: expanded.dueCardIds,
  })
  const transferredPathId = plan.pathIdBatches[1]![0]!
  const claimed = removeTransferredPathFromFutureBatches({
    plan,
    activeBatchIndex: 0,
    transferredPathId,
  })
  const firstSelection = createExplicitGraphSessionSelection({
    adapter: expanded.adapter,
    pathIds: plan.pathIdBatches[0]!,
    dueCardIds: expanded.dueCardIds,
  })
  const firstSession = createGraphTrainingSession({
    adapter: expanded.adapter,
    selection: firstSelection,
  })
  const transferredPath = expanded.adapter.pathsById.get(transferredPathId)!
  const switchedSession: GraphTrainingSessionState = {
    ...firstSession,
    activePathId: transferredPathId,
    activePathNodeIndex: 0,
    currentNodeId: transferredPath.nodeIds[0]!,
    sessionPathIds: [...firstSession.sessionPathIds, transferredPathId],
    pendingPathIds: [
      ...firstSession.pendingPathIds.filter((pathId) => pathId !== firstSession.activePathId),
      firstSession.activePathId,
    ],
  }
  const cursorOptions = {
    adapter: expanded.adapter,
    familyId: 'synthetic-family',
    activeBatchIndex: 0,
    completedBeforeBatch: [] as string[],
    session: switchedSession,
    authoritativeDueCardIds: expanded.dueCardIds,
  }
  const stalePlanCursor = createFamilyTrainingCursorSnapshot({ ...cursorOptions, plan })
  const claimedPlanCursor = createFamilyTrainingCursorSnapshot({ ...cursorOptions, plan: claimed })

  assert.equal(plan.pathIdBatches[1]?.includes(transferredPathId), true)
  assert.equal(claimed.pathIdBatches.flat().includes(transferredPathId), false)
  assert.equal(claimed.totalPathIds.includes(transferredPathId), true)
  assert.equal(nextNonemptyGraphTrainingBatch(claimed, 0), null)
  assert.deepEqual(stalePlanCursor, claimedPlanCursor)
  assert.equal(
    [...claimedPlanCursor.completedPathIds, ...claimedPlanCursor.pendingPathIds]
      .filter((pathId) => pathId === transferredPathId).length,
    1,
  )
  assert.equal(
    [transferredPathId, ...claimed.pathIdBatches.slice(1).flat()]
      .filter((pathId) => pathId === transferredPathId).length,
    1,
  )
  assert.throws(
    () => removeTransferredPathFromFutureBatches({
      plan,
      activeBatchIndex: -1,
      transferredPathId,
    }),
    /nonnegative/u,
  )
  const admitted = removeTransferredPathFromFutureBatches({
    plan,
    activeBatchIndex: 0,
    transferredPathId: 'path_ffffffffffffffffffff',
  })
  assert.equal(admitted.totalPathIds.at(-1), 'path_ffffffffffffffffffff')
  assert.throws(
    () => removeTransferredPathFromFutureBatches({
      plan,
      activeBatchIndex: 0,
      transferredPathId: '<script>',
    }),
    /invalid audited path identity/u,
  )
})

test('a skipped path at the 1,000-path boundary moves behind every future batch without duplication', async () => {
  const fixture = await adapterFixture()
  const expanded = expandAdapterForBatchBoundary(fixture.adapter, 1_001)
  const plan = createAutonomousGraphTrainingPlan({
    adapter: expanded.adapter,
    dueCardIds: expanded.dueCardIds,
  })
  const deferredPathId = plan.pathIdBatches[0]!.at(-1)!
  const deferred = deferGraphTrainingPathToCycleEnd({
    plan,
    activeBatchIndex: 0,
    pathId: deferredPathId,
  })

  assert.equal(deferred.pathIdBatches[0]!.includes(deferredPathId), false)
  assert.equal(deferred.pathIdBatches.at(-1)!.at(-1), deferredPathId)
  assert.equal(deferred.pathIdBatches.flat().filter((pathId) => pathId === deferredPathId).length, 1)
  assert.deepEqual(new Set(deferred.pathIdBatches.flat()), new Set(plan.totalPathIds))
  assert.ok(deferred.pathIdBatches.every((batch) => batch.length <= 1_000))
  assert.throws(
    () => deferGraphTrainingPathToCycleEnd({
      plan: { ...plan, pathIdBatches: [plan.pathIdBatches[0]!] },
      activeBatchIndex: 0,
      pathId: deferredPathId,
    }),
    /No unfinished variation/u,
  )
})

test('bounded family planning rejects malformed limits and preserves every batch-helper boundary', async () => {
  const { adapter } = await adapterFixture()
  const path = listGraphTrainingPaths(adapter)[0]!
  const otherPath = listGraphTrainingPaths(adapter)[1]!

  assert.throws(
    () => createBoundedGraphTrainingPlan({
      adapter,
      pathIds: [path.id],
      dueCardIds: [],
      coverageCycleOrdinal: -1,
    }),
    /nonnegative/u,
  )
  assert.throws(
    () => createBoundedGraphTrainingPlan({
      adapter,
      pathIds: [path.id],
      dueCardIds: [],
      coverageCycleOrdinal: 1.5,
    }),
    /nonnegative/u,
  )
  for (const maximumPathsPerBatch of [0, 1.5, 1_001]) {
    assert.throws(
      () => createBoundedGraphTrainingPlan({
        adapter,
        pathIds: [path.id],
        dueCardIds: [],
        maximumPathsPerBatch,
      }),
      /1 through 1000/u,
    )
  }
  assert.throws(
    () => createBoundedGraphTrainingPlan({ adapter, pathIds: [], dueCardIds: [] }),
    /at least one/u,
  )
  assert.throws(
    () => createBoundedGraphTrainingPlan({ adapter, pathIds: [path.id, path.id], dueCardIds: [] }),
    /must be unique/u,
  )
  assert.throws(
    () => createBoundedGraphTrainingPlan({
      adapter,
      pathIds: Array.from(
        { length: 100_001 },
        (_, index) => `path_${index.toString(16).padStart(20, '0')}`,
      ),
      dueCardIds: [],
    }),
    /cursor path limit/u,
  )
  assert.throws(
    () => createBoundedGraphTrainingPlan({
      adapter,
      pathIds: ['path_ffffffffffffffffffff'],
      dueCardIds: [],
    }),
    /unavailable path/u,
  )
  assert.throws(
    () => createBoundedGraphTrainingPlan({
      adapter,
      pathIds: [path.id],
      dueCardIds: ['another_pack::pos_0000000000000000'],
    }),
    /selected graph pack/u,
  )
  assert.throws(
    () => createBoundedGraphTrainingPlan({
      adapter,
      pathIds: [path.id],
      dueCardIds: [`${adapter.graph.pack.id}::pos_0000000000000000`],
    }),
    /not a learner card/u,
  )

  const plan = createBoundedGraphTrainingPlan({
    adapter,
    pathIds: [path.id, otherPath.id],
    dueCardIds: [],
    maximumPathsPerBatch: 1,
  })
  assert.strictEqual(removeTransferredPathFromFutureBatches({
    plan,
    activeBatchIndex: 0,
    transferredPathId: path.id,
  }), plan)
  assert.deepEqual(nextNonemptyGraphTrainingBatch(plan, 0), {
    batchIndex: 1,
    pathIds: [otherPath.id],
  })

  assert.throws(
    () => deferGraphTrainingPathToCycleEnd({ plan, activeBatchIndex: -1, pathId: path.id }),
    /nonnegative/u,
  )
  assert.throws(
    () => deferGraphTrainingPathToCycleEnd({ plan, activeBatchIndex: 0.5, pathId: path.id }),
    /nonnegative/u,
  )
  assert.throws(
    () => deferGraphTrainingPathToCycleEnd({ plan, activeBatchIndex: 0, pathId: '<script>' }),
    /invalid audited path identity/u,
  )
  assert.throws(
    () => deferGraphTrainingPathToCycleEnd({
      plan,
      activeBatchIndex: 0,
      pathId: 'path_ffffffffffffffffffff',
    }),
    /outside the active coverage plan/u,
  )

  const fullFutureBatch = Array.from(
    { length: GRAPH_TRAINING_BATCH_PATH_LIMIT },
    (_, index) => `path_e${index.toString(16).padStart(19, '0')}`,
  )
  const appendedBatch = deferGraphTrainingPathToCycleEnd({
    plan: {
      ...plan,
      totalPathIds: [path.id, ...fullFutureBatch],
      pathIdBatches: [[path.id], fullFutureBatch],
    },
    activeBatchIndex: 0,
    pathId: path.id,
  })
  assert.deepEqual(appendedBatch.pathIdBatches.at(-1), [path.id])

  const trailingEmptyBatch = deferGraphTrainingPathToCycleEnd({
    plan: {
      ...plan,
      pathIdBatches: [[path.id], [otherPath.id], []],
    },
    activeBatchIndex: 0,
    pathId: path.id,
  })
  assert.deepEqual(trailingEmptyBatch.pathIdBatches, [[], [otherPath.id, path.id], []])
})

test('a 1,001-path cursor remount preserves every due card and bounded pending batch', async () => {
  const fixture = await adapterFixture()
  const expanded = expandAdapterForBatchBoundary(fixture.adapter, 1_001)
  const plan = createAutonomousGraphTrainingPlan({
    adapter: expanded.adapter,
    dueCardIds: expanded.dueCardIds,
    coverageCycleOrdinal: 4,
  })
  const selection = createExplicitGraphSessionSelection({
    adapter: expanded.adapter,
    pathIds: plan.pathIdBatches[0]!,
    dueCardIds: expanded.dueCardIds,
    coverageCycleOrdinal: plan.coverageCycleOrdinal,
  })
  const session = createGraphTrainingSession({ adapter: expanded.adapter, selection })
  const cursor = createFamilyTrainingCursorSnapshot({
    adapter: expanded.adapter,
    familyId: 'synthetic-family',
    plan,
    activeBatchIndex: 0,
    completedBeforeBatch: [],
    session,
    authoritativeDueCardIds: expanded.dueCardIds,
  })
  const restored = restoreGraphTrainingCycleFromCursor({
    adapter: expanded.adapter,
    familyId: 'synthetic-family',
    cursor,
  })

  assert.equal(cursor.pendingPathIds.length, 1_001)
  assert.equal(restored.plan.totalPathIds.length, 1_001)
  assert.deepEqual(restored.plan.pathIdBatches.map(({ length }) => length), [1_000, 1])
  assert.deepEqual(restored.authoritativeDueCardIds, expanded.dueCardIds)
  assert.deepEqual(restored.session.dueCardIds, expanded.dueCardIds)
})

test('family cursor snapshots restore authoritative due, pending, completed, batch, and cycle state', async () => {
  const { adapter } = await adapterFixture()
  const rootCard = stableRepertoireCardId(adapter.graph.pack.id, adapter.graph.pack.rootNodeId)
  const plan = createAutonomousGraphTrainingPlan({
    adapter,
    dueCardIds: [rootCard],
    coverageCycleOrdinal: 7,
    maximumPathsPerBatch: 1,
  })
  const selection = createExplicitGraphSessionSelection({
    adapter,
    pathIds: plan.pathIdBatches[0]!,
    dueCardIds: [rootCard],
    coverageCycleOrdinal: plan.coverageCycleOrdinal,
  })
  let state = createGraphTrainingSession({ adapter, selection })
  while (state.phase !== 'path_complete') {
    state = state.phase === 'opponent_move_ready'
      ? applyPendingOpponentGraphMove(adapter, state)
      : submitGraphTrainingMove({ adapter, state, moveUci: activePathMove(adapter, state) })
  }
  state = continueGraphTrainingSession(adapter, state)
  assert.equal(state.phase, 'session_complete')

  const cursor = createFamilyTrainingCursorSnapshot({
    adapter,
    familyId: 'synthetic-family',
    plan,
    activeBatchIndex: 0,
    completedBeforeBatch: [],
    session: state,
    authoritativeDueCardIds: [rootCard],
  })
  assert.equal(cursor.coverageCycleId, `${adapter.graph.pack.id}::coverage:7`)
  assert.equal(cursor.completedPathIds.length, 1)
  assert.equal(cursor.pendingPathIds.length, 1)
  assert.deepEqual(cursor.reviewedCardIds, [rootCard])

  const restored = restoreGraphTrainingCycleFromCursor({
    adapter,
    familyId: 'synthetic-family',
    cursor,
  })
  assert.equal(restored.activeBatchIndex, 0)
  assert.deepEqual(restored.completedBeforeBatch, cursor.completedPathIds)
  assert.equal(restored.session.activePathId, cursor.pendingPathIds[0])
  assert.deepEqual(restored.session.dueCardIds, [])
  assert.deepEqual(restored.authoritativeDueCardIds, [rootCard])
  assert.equal(restored.plan.coverageCycleOrdinal, 7)
  assert.equal(coverageCycleOrdinalFromId(adapter.graph.pack.id, cursor.coverageCycleId), 7)
  const laterBatch = restoreGraphTrainingCycleFromCursor({
    adapter,
    familyId: 'synthetic-family',
    cursor: { ...cursor, batchIndex: 4 },
  })
  assert.equal(laterBatch.activeBatchIndex, 4)
  assert.deepEqual(laterBatch.plan.pathIdBatches.slice(0, 4), [[], [], [], []])
  assert.deepEqual(laterBatch.plan.pathIdBatches[4], cursor.pendingPathIds)
  assert.throws(
    () => coverageCycleOrdinalFromId('another-pack', cursor.coverageCycleId),
    /another graph pack/u,
  )
  assert.throws(
    () => coverageCycleOrdinalFromId(adapter.graph.pack.id, `${adapter.graph.pack.id}::coverage:-1`),
    /invalid cycle ordinal/u,
  )
  assert.throws(
    () => coverageCycleOrdinalFromId(adapter.graph.pack.id, `${adapter.graph.pack.id}::coverage:1.5`),
    /invalid cycle ordinal/u,
  )
  assert.throws(
    () => createFamilyTrainingCursorSnapshot({
      adapter,
      familyId: 'synthetic-family',
      plan,
      activeBatchIndex: -1,
      completedBeforeBatch: [],
      session: state,
      authoritativeDueCardIds: [rootCard],
    }),
    /nonnegative integer/u,
  )
  assert.throws(
    () => createFamilyTrainingCursorSnapshot({
      adapter,
      familyId: 'synthetic-family',
      plan: { ...plan, releaseId: 'another-release' },
      activeBatchIndex: 0,
      completedBeforeBatch: [],
      session: state,
      authoritativeDueCardIds: [rootCard],
    }),
    /inconsistent/u,
  )
  assert.throws(
    () => restoreGraphTrainingCycleFromCursor({
      adapter,
      familyId: 'another-family',
      cursor,
    }),
    /another release, family, or side/u,
  )
  assert.throws(
    () => restoreGraphTrainingCycleFromCursor({
      adapter,
      familyId: 'synthetic-family',
      cursor: { ...cursor, releaseId: 'another-release' },
    }),
    /another release, family, or side/u,
  )
})

test('warm-ups traverse legal edges but only due learner positions emit review inferences', async () => {
  const { adapter } = await adapterFixture()
  const path = listGraphTrainingPaths(adapter).find(({ familyTags }) => familyTags.includes('Knight first'))!
  const fullPath = adapter.pathsById.get(path.id)!
  const dueNodeId = fullPath.nodeIds[2]!
  const dueCardId = stableRepertoireCardId(adapter.graph.pack.id, dueNodeId)
  const selection = createExplicitGraphSessionSelection({ adapter, pathIds: [path.id], dueCardIds: [dueCardId] })
  assert.deepEqual(selection.warmupNodeIds, [adapter.graph.pack.rootNodeId])

  let state = createGraphTrainingSession({ adapter, selection })
  const first = submitGraphTrainingMove({ adapter, state, moveUci: 'g1f3' })
  assert.equal(first.lastFeedback?.warmup, true)
  assert.equal(first.lastFeedback?.review, null)
  assert.equal(first.phase, 'opponent_move_ready')
  assert.equal(pendingOpponentGraphMove(adapter, first)?.uci, 'd7d5')

  state = applyPendingOpponentGraphMove(adapter, first)
  assert.equal(new Chess(graphTrainingFen(adapter, state)).turn(), 'w')
  state = submitGraphTrainingMove({ adapter, state, moveUci: 'g2g3' })
  assert.equal(state.lastFeedback?.review?.grade, 'good')
  assert.equal(state.lastFeedback?.review?.source, 'due')
  assert.equal(state.dueCardIds.length, 0)
})

test('an alternate audited root edge switches to its real path and preserves the exact transposition', async () => {
  const { adapter } = await adapterFixture()
  const paths = listGraphTrainingPaths(adapter)
  const knightPath = paths.find(({ familyTags }) => familyTags.includes('Knight first'))!
  const fianchettoPath = paths.find(({ familyTags }) => familyTags.includes('Fianchetto first'))!
  const selection = createExplicitGraphSessionSelection({
    adapter,
    pathIds: [knightPath.id],
    dueCardIds: [stableRepertoireCardId(adapter.graph.pack.id, adapter.graph.pack.rootNodeId)],
  })
  let state = createGraphTrainingSession({ adapter, selection, preferredPathId: knightPath.id })
  assert.deepEqual(state.sessionPathIds, [knightPath.id])

  state = submitGraphTrainingMove({ adapter, state, moveUci: 'g2g3' })
  assert.equal(state.activePathId, fianchettoPath.id)
  assert.equal(state.lastFeedback?.switchedPath, true)
  assert.equal(state.lastFeedback?.classification, 'book')
  assert.equal(state.lastFeedback?.review?.grade, 'good')
  assert.equal(new Chess(graphTrainingFen(adapter, state)).get('g3')?.type, 'p')
  assert.equal(state.pendingPathIds.at(-1), knightPath.id)
  assert.deepEqual(new Set(state.sessionPathIds), new Set([knightPath.id, fianchettoPath.id]))

  state = applyPendingOpponentGraphMove(adapter, state)
  state = submitGraphTrainingMove({ adapter, state, moveUci: 'g1f3' })
  const transpositionEdge = adapter.edgesById.get(state.lastTransition!.edgeId)!
  assert.equal(transpositionEdge.acceptedBookTransposition, true)
  const sharedPosition = adapter.pathsById.get(knightPath.id)!.nodeIds[3]
  assert.equal(state.currentNodeId, sharedPosition)
  assert.equal(state.lastTransition?.toNodeId, sharedPosition)

  while (state.phase !== 'path_complete') {
    state = state.phase === 'opponent_move_ready'
      ? applyPendingOpponentGraphMove(adapter, state)
      : submitGraphTrainingMove({ adapter, state, moveUci: activePathMove(adapter, state) })
  }
  assert.doesNotThrow(() => createGraphTrainingPathCompletion({
    adapter,
    state,
    pathId: fianchettoPath.id,
    completedAt: '2026-07-28T12:00:00.000Z',
  }))
  const resumed = continueGraphTrainingSession(adapter, state)
  assert.equal(resumed.activePathId, knightPath.id)
  assert.equal(resumed.completedPathIds.filter((pathId) => pathId === fianchettoPath.id).length, 1)
})

test('incorrect recall requires correction, infers Again, and replays the failed card at session end', async () => {
  const { adapter } = await adapterFixture()
  const path = listGraphTrainingPaths(adapter)[0]!
  const rootCard = stableRepertoireCardId(adapter.graph.pack.id, adapter.graph.pack.rootNodeId)
  const selection = createExplicitGraphSessionSelection({ adapter, pathIds: [path.id], dueCardIds: [rootCard] })
  let state = createGraphTrainingSession({ adapter, selection })

  state = submitGraphTrainingMove({ adapter, state, moveUci: 'e2e4' })
  assert.equal(state.phase, 'correction_required')
  assert.equal(state.lastFeedback?.classification, 'unverified')
  state = submitGraphTrainingMove({ adapter, state, moveUci: expectedGraphTrainingMoves(adapter, state)[0]!.uci })
  assert.equal(state.lastFeedback?.review?.grade, 'again')
  assert.deepEqual(state.repeatCardIds, [rootCard])

  while (state.phase !== 'path_complete') {
    if (state.phase === 'opponent_move_ready') state = applyPendingOpponentGraphMove(adapter, state)
    else {
      const move = expectedGraphTrainingMoves(adapter, state)[0]
      assert.ok(move)
      state = submitGraphTrainingMove({ adapter, state, moveUci: move.uci })
    }
  }
  const replay = continueGraphTrainingSession(adapter, state)
  assert.equal(replay.activePathId, path.id)
  assert.equal(replay.currentNodeId, adapter.graph.pack.rootNodeId)
  assert.equal(replay.phase, 'awaiting_learner_move')
})

test('hinted due recall is Hard, opponent moves cannot be applied early, and stale releases fail closed', async () => {
  const { adapter } = await adapterFixture()
  const path = listGraphTrainingPaths(adapter)[0]!
  const rootCard = stableRepertoireCardId(adapter.graph.pack.id, adapter.graph.pack.rootNodeId)
  const selection = createExplicitGraphSessionSelection({ adapter, pathIds: [path.id], dueCardIds: [rootCard] })
  let state = createGraphTrainingSession({ adapter, selection })
  assert.throws(() => applyPendingOpponentGraphMove(adapter, state), /no opponent move/u)
  state = markGraphTrainingHint(adapter, state)
  state = submitGraphTrainingMove({ adapter, state, moveUci: expectedGraphTrainingMoves(adapter, state)[0]!.uci })
  assert.equal(state.lastFeedback?.review?.grade, 'hard')
  assert.throws(
    () => graphTrainingFen(adapter, { ...state, releaseId: 'another-release' }),
    /another validated graph release/u,
  )
})

function replaceRootEdge(
  adapter: GraphTrainingAdapter,
  uci: string,
  update: (edge: GraphTrainingAdapter['graph']['edges'][number]) => GraphTrainingAdapter['graph']['edges'][number],
): GraphTrainingAdapter {
  const root = adapter.nodesById.get(adapter.graph.pack.rootNodeId)!
  const edge = root.outgoingEdgeIds.map((id) => adapter.edgesById.get(id)!).find((candidate) => candidate.uci === uci)!
  const edgesById = new Map(adapter.edgesById)
  edgesById.set(edge.id, update(edge))
  return { ...adapter, edgesById }
}

function activePathMove(adapter: GraphTrainingAdapter, state: GraphTrainingSessionState): string {
  const path = adapter.pathsById.get(state.activePathId)!
  const edgeId = path.edgeIds[state.activePathNodeIndex]!
  return adapter.edgesById.get(edgeId)!.uci
}

test('selection and stale-state guards reject unsafe pack, path, card, cycle, and cursor input', async () => {
  const { adapter } = await adapterFixture()
  const paths = listGraphTrainingPaths(adapter)
  const firstPath = adapter.pathsById.get(paths[0]!.id)!
  const secondPath = adapter.pathsById.get(paths[1]!.id)!
  assert.throws(() => createExplicitGraphSessionSelection({ adapter, pathIds: [], dueCardIds: [] }), /At least one/u)
  assert.throws(() => createExplicitGraphSessionSelection({
    adapter,
    pathIds: Array.from({ length: 1_001 }, (_, index) => `path_${index.toString(16).padStart(20, '0')}`),
    dueCardIds: [],
  }), /at most 1000/u)
  assert.throws(() => createExplicitGraphSessionSelection({
    adapter, pathIds: ['path_ffffffffffffffffffff'], dueCardIds: [],
  }), /not part/u)
  assert.throws(() => createExplicitGraphSessionSelection({
    adapter, pathIds: [firstPath.id], dueCardIds: ['another_pack::pos_0000000000000000'],
  }), /belong/u)
  const opponentNode = adapter.graph.nodes.find((node) => !node.learnerTurn)!
  assert.throws(() => createExplicitGraphSessionSelection({
    adapter,
    pathIds: [firstPath.id],
    dueCardIds: [`${adapter.graph.pack.id}::${opponentNode.id}`],
  }), /not a learner card/u)
  assert.throws(() => createExplicitGraphSessionSelection({
    adapter, pathIds: [firstPath.id], dueCardIds: [], coverageCycleOrdinal: -1,
  }), /nonnegative/u)

  const uniqueSecondLearner = secondPath.nodeIds
    .map((id) => adapter.nodesById.get(id)!)
    .find((node) => node.learnerTurn && !firstPath.nodeIds.includes(node.id))!
  const filtered = createExplicitGraphSessionSelection({
    adapter,
    pathIds: [firstPath.id],
    dueCardIds: [uniqueSecondLearner.cardId!],
    coverageCycleOrdinal: 4,
  })
  assert.deepEqual(filtered.dueCardIds, [uniqueSecondLearner.cardId])
  assert.match(filtered.coverageCycleId, /:4$/u)

  const selection = createExplicitGraphSessionSelection({ adapter, pathIds: [firstPath.id], dueCardIds: [] })
  assert.throws(() => createGraphTrainingSession({ adapter, selection: { ...selection, packId: 'another_pack' } }), /another graph pack/u)
  assert.equal(createGraphTrainingSession({ adapter, selection, preferredPathId: secondPath.id }).activePathId, firstPath.id)

  const noPathAdapter: GraphTrainingAdapter = { ...adapter, pathsById: new Map() }
  assert.throws(() => createGraphTrainingSession({ adapter: noPathAdapter, selection }), /unavailable path/u)
  const fakePathId = 'path_ffffffffffffffffffff'
  assert.throws(() => createGraphTrainingSession({
    adapter,
    selection: { ...selection, includedPathIds: [firstPath.id, fakePathId] },
  }), /unavailable path/u)

  const wrongRootPath = { ...firstPath, nodeIds: [firstPath.nodeIds[1]!, ...firstPath.nodeIds.slice(1)] }
  const wrongRootAdapter: GraphTrainingAdapter = {
    ...adapter,
    pathsById: new Map([...adapter.pathsById].map(([id, path]) => [id, id === firstPath.id ? wrongRootPath : path])),
  }
  assert.throws(() => createGraphTrainingSession({ adapter: wrongRootAdapter, selection }), /pack root/u)

  const state = createGraphTrainingSession({ adapter, selection })
  assert.throws(() => graphTrainingFen(adapter, { ...state, currentNodeId: 'pos_0000000000000000' }), /stale or inconsistent/u)
  assert.throws(() => graphTrainingFen(adapter, { ...state, activePathId: fakePathId }), /stale or inconsistent/u)
  assert.throws(() => graphTrainingFen(adapter, { ...state, activePathNodeIndex: 2 }), /stale or inconsistent/u)
})

test('move evidence classes fail closed while a proven playable continuation is accepted as Hard', async () => {
  const { adapter } = await adapterFixture()
  const paths = listGraphTrainingPaths(adapter)
  const rootCard = stableRepertoireCardId(adapter.graph.pack.id, adapter.graph.pack.rootNodeId)
  const selection = createExplicitGraphSessionSelection({ adapter, pathIds: paths.map(({ id }) => id), dueCardIds: [rootCard] })
  const state = createGraphTrainingSession({ adapter, selection, preferredPathId: paths[0]!.id })

  const malformed = submitGraphTrainingMove({ adapter, state, moveUci: 'not-a-move' })
  assert.equal(malformed.lastFeedback?.classification, 'illegal')
  assert.equal(malformed.lastFeedback?.reason, 'illegal_move')
  const illegal = submitGraphTrainingMove({ adapter, state, moveUci: 'e2e5' })
  assert.equal(illegal.lastFeedback?.classification, 'illegal')

  const exploratoryAdapter = replaceRootEdge(adapter, 'g2g3', (edge) => ({ ...edge, role: 'exploratory', eligibleForDrill: false }))
  const exploratory = submitGraphTrainingMove({ adapter: exploratoryAdapter, state, moveUci: 'g2g3' })
  assert.equal(exploratory.lastFeedback?.classification, 'exploratory')
  assert.equal(exploratory.lastFeedback?.reason, 'insufficient_sample')

  const quarantineAdapter = replaceRootEdge(adapter, 'g2g3', (edge) => ({
    ...edge,
    eligibleForDrill: false,
    evidence: {
      ...edge.evidence,
      engine: { status: 'quarantined', centipawnLoss: 120, forcedMateAgainstLearner: false, quarantineReasons: ['fixture'] },
    },
  }))
  const quarantined = submitGraphTrainingMove({ adapter: quarantineAdapter, state, moveUci: 'g2g3' })
  assert.equal(quarantined.lastFeedback?.classification, 'quarantined')
  assert.equal(quarantined.lastFeedback?.reason, 'quarantined_evidence')

  const playableAdapter = replaceRootEdge(adapter, 'g2g3', (edge) => ({ ...edge, role: 'playable', eligibleForDrill: false }))
  const playable = submitGraphTrainingMove({ adapter: playableAdapter, state, moveUci: 'g2g3' })
  assert.equal(playable.lastFeedback?.accepted, true)
  assert.equal(playable.lastFeedback?.classification, 'playable')
  assert.equal(playable.lastFeedback?.review?.grade, 'hard')

  const playableEdge = playableAdapter.nodesById.get(adapter.graph.pack.rootNodeId)!.outgoingEdgeIds
    .map((id) => playableAdapter.edgesById.get(id)!)
    .find(({ uci }) => uci === 'g2g3')!
  const noContinuationAdapter: GraphTrainingAdapter = {
    ...playableAdapter,
    edgeOccurrences: new Map([...playableAdapter.edgeOccurrences].filter(([id]) => id !== playableEdge.id)),
    nodeOccurrences: new Map([...playableAdapter.nodeOccurrences].filter(([id]) => id !== playableEdge.toNodeId)),
  }
  const noContinuation = submitGraphTrainingMove({ adapter: noContinuationAdapter, state, moveUci: 'g2g3' })
  assert.equal(noContinuation.lastFeedback?.classification, 'unverified')
  assert.equal(noContinuation.lastFeedback?.reason, 'no_audited_continuation')

  const bookWithoutPath: GraphTrainingAdapter = {
    ...adapter,
    edgeOccurrences: new Map([...adapter.edgeOccurrences].filter(([id]) => id !== playableEdge.id)),
  }
  assert.equal(submitGraphTrainingMove({ adapter: bookWithoutPath, state, moveUci: 'g2g3' }).lastFeedback?.accepted, false)
})

test('opponent and boundary transitions reject corrupt state and complete or advance deterministically', async () => {
  const { adapter } = await adapterFixture()
  const paths = listGraphTrainingPaths(adapter)
  const selection = createExplicitGraphSessionSelection({ adapter, pathIds: paths.map(({ id }) => id), dueCardIds: [] })
  let state = createGraphTrainingSession({ adapter, selection })
  assert.deepEqual(expectedGraphTrainingMoves(adapter, { ...state, phase: 'path_complete' }), expectedGraphTrainingMoves(adapter, state))
  const pausedState: GraphTrainingSessionState = { ...state, phase: 'path_complete' }
  assert.strictEqual(markGraphTrainingHint(adapter, pausedState), pausedState)
  assert.throws(() => continueGraphTrainingSession(adapter, state), /not complete/u)
  assert.throws(() => submitGraphTrainingMove({ adapter, state: { ...state, phase: 'path_complete' }, moveUci: 'g1f3' }), /not waiting/u)

  state = submitGraphTrainingMove({ adapter, state, moveUci: expectedGraphTrainingMoves(adapter, state)[0]!.uci })
  assert.deepEqual(expectedGraphTrainingMoves(adapter, state), [])
  const currentOpponent = adapter.nodesById.get(state.currentNodeId)!
  const learnerFlagAdapter: GraphTrainingAdapter = {
    ...adapter,
    nodesById: new Map([...adapter.nodesById].map(([id, node]) => [id, id === currentOpponent.id ? { ...node, learnerTurn: true } : node])),
  }
  assert.throws(() => pendingOpponentGraphMove(learnerFlagAdapter, state), /learner position/u)

  const opponentEdge = pendingOpponentGraphMove(adapter, state)!
  const missingEdgeAdapter: GraphTrainingAdapter = {
    ...adapter,
    edgesById: new Map([...adapter.edgesById].filter(([id]) => id !== opponentEdge.id)),
  }
  assert.throws(() => pendingOpponentGraphMove(missingEdgeAdapter, state), /no audited continuation/u)
  const wrongEdgeAdapter: GraphTrainingAdapter = {
    ...adapter,
    edgesById: new Map([...adapter.edgesById].map(([id, edge]) => [id, id === opponentEdge.id ? { ...edge, fromNodeId: adapter.graph.pack.rootNodeId } : edge])),
  }
  assert.throws(() => pendingOpponentGraphMove(wrongEdgeAdapter, state), /no audited continuation/u)

  state = applyPendingOpponentGraphMove(adapter, state)
  while (state.phase !== 'path_complete') {
    state = state.phase === 'opponent_move_ready'
      ? applyPendingOpponentGraphMove(adapter, state)
      : submitGraphTrainingMove({ adapter, state, moveUci: activePathMove(adapter, state) })
  }
  const completion = createGraphTrainingPathCompletion({
    adapter,
    state,
    pathId: state.activePathId,
    completedAt: '2026-07-19T12:00:00.000Z',
  })
  assert.deepEqual(completion, {
    contractId: 'linerecall.graph-path-completion.v1',
    schemaVersion: 1,
    releaseId: adapter.graph.releaseId,
    packId: adapter.graph.pack.id,
    pathId: state.activePathId,
    familyTags: adapter.pathsById.get(state.activePathId)!.familyTags,
    coverageCycleId: selection.coverageCycleId,
    completedAt: '2026-07-19T12:00:00.000Z',
  })
  assert.throws(
    () => createGraphTrainingPathCompletion({ adapter, state: { ...state, completedPathIds: [] }, pathId: state.activePathId, completedAt: completion.completedAt }),
    /requires a completed/u,
  )
  const nextPath = continueGraphTrainingSession(adapter, state)
  assert.equal(nextPath.activePathId, state.pendingPathIds[0])
  assert.equal(nextPath.pathBoundaryCount, 1)

  let final = nextPath
  while (final.phase !== 'path_complete') {
    final = final.phase === 'opponent_move_ready'
      ? applyPendingOpponentGraphMove(adapter, final)
      : submitGraphTrainingMove({ adapter, state: final, moveUci: activePathMove(adapter, final) })
  }
  const complete = continueGraphTrainingSession(adapter, final)
  assert.equal(complete.phase, 'session_complete')
  assert.equal(complete.lastTransition, null)
  assert.equal(new Set(complete.completedPathIds).size, complete.completedPathIds.length)

  assert.throws(() => continueGraphTrainingSession(adapter, {
    ...final,
    pendingPathIds: [],
    repeatCardIds: [`${adapter.graph.pack.id}::pos_0000000000000000`],
  }), /no selectable path/u)
})

test('a successful session-end repeat removes the failed card and allows completion', async () => {
  const { adapter } = await adapterFixture()
  const path = listGraphTrainingPaths(adapter)[0]!
  const rootCard = stableRepertoireCardId(adapter.graph.pack.id, adapter.graph.pack.rootNodeId)
  const selection = createExplicitGraphSessionSelection({ adapter, pathIds: [path.id], dueCardIds: [rootCard] })
  let state = createGraphTrainingSession({ adapter, selection })
  state = submitGraphTrainingMove({ adapter, state: submitGraphTrainingMove({ adapter, state, moveUci: 'e2e4' }), moveUci: expectedGraphTrainingMoves(adapter, state)[0]!.uci })
  while (state.phase !== 'path_complete') {
    state = state.phase === 'opponent_move_ready'
      ? applyPendingOpponentGraphMove(adapter, state)
      : submitGraphTrainingMove({ adapter, state, moveUci: activePathMove(adapter, state) })
  }
  state = continueGraphTrainingSession(adapter, state)
  const repeated = submitGraphTrainingMove({ adapter, state, moveUci: expectedGraphTrainingMoves(adapter, state)[0]!.uci })
  assert.equal(repeated.lastFeedback?.review?.source, 'repeat')
  assert.equal(repeated.lastFeedback?.review?.grade, 'good')
  assert.deepEqual(repeated.repeatCardIds, [])
})

test('skipping rotates an unfinished path without grading or completing it', async () => {
  const { adapter } = await adapterFixture()
  const paths = listGraphTrainingPaths(adapter)
  const rootCard = stableRepertoireCardId(adapter.graph.pack.id, adapter.graph.pack.rootNodeId)
  const selection = createExplicitGraphSessionSelection({
    adapter,
    pathIds: paths.map(({ id }) => id),
    dueCardIds: [rootCard],
  })
  const initial = createGraphTrainingSession({ adapter, selection })
  const partiallyTraversed = submitGraphTrainingMove({
    adapter,
    state: initial,
    moveUci: activePathMove(adapter, initial),
  })
  const skipped = skipCurrentGraphTrainingPath(adapter, partiallyTraversed)

  assert.equal(skipped.activePathId, initial.pendingPathIds[0])
  assert.equal(skipped.currentNodeId, adapter.graph.pack.rootNodeId)
  assert.equal(skipped.pendingPathIds.at(-1), initial.activePathId)
  assert.deepEqual(skipped.completedPathIds, [])
  assert.deepEqual(skipped.dueCardIds, partiallyTraversed.dueCardIds)
  assert.deepEqual(skipped.repeatCardIds, partiallyTraversed.repeatCardIds)
  assert.equal(skipped.pathBoundaryCount, 1)
  assert.throws(
    () => skipCurrentGraphTrainingPath(adapter, { ...initial, pendingPathIds: [] }),
    /No other unfinished/u,
  )
  assert.throws(
    () => skipCurrentGraphTrainingPath(adapter, { ...initial, phase: 'path_complete' }),
    /Only an unfinished/u,
  )
})

test('a Black pack starts with its audited opponent edge before asking Black for a move', async () => {
  const graph = structuredClone(await createSyntheticTranspositionGraph())
  graph.pack.side = 'black'
  graph.pack.coreDepth = 2
  graph.pack.opponentBranchCountAfterRoot = 1
  for (const path of graph.paths) path.learnerDecisionCount = 2
  for (const node of graph.nodes) {
    node.learnerTurn = node.epd.split(' ')[1] === 'b'
    if (node.learnerTurn) node.cardId = stableRepertoireCardId(graph.pack.id, node.id)
    else delete node.cardId
  }
  const adapter = await prepareGraphTrainingAdapter({ contractId: GRAPH_TRAINING_CONTRACT_ID, graph })
  const path = listGraphTrainingPaths(adapter)[0]!
  const fullPath = adapter.pathsById.get(path.id)!
  const firstBlackNodeId = fullPath.nodeIds[1]!
  const selection = createExplicitGraphSessionSelection({
    adapter,
    pathIds: [path.id],
    dueCardIds: [stableRepertoireCardId(graph.pack.id, firstBlackNodeId)],
  })
  let state = createGraphTrainingSession({ adapter, selection })
  assert.equal(state.phase, 'opponent_move_ready')
  assert.equal(pendingOpponentGraphMove(adapter, state)?.uci, 'g1f3')
  state = applyPendingOpponentGraphMove(adapter, state)
  assert.equal(state.phase, 'awaiting_learner_move')
  assert.equal(expectedGraphTrainingMoves(adapter, state)[0]?.uci, 'd7d5')
})

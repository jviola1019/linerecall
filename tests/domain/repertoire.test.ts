import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess, type Move } from 'chess.js'
import {
  CORE_MINIMUM_LEARNER_DECISIONS,
  CoverageCycleStateSchema,
  EligibleSourceEdgeInventoryV1Schema,
  EvidenceCohortResultSchema,
  FamilyGraphProvenanceDocumentV1Schema,
  REPERTOIRE_SCHEMA_VERSION,
  RepertoireBranchEvidenceSchema,
  RepertoireEdgeSchema,
  RepertoireGraphDocumentSchema,
  RepertoireNodeSchema,
  RepertoirePackSchema,
  RepertoirePathSchema,
  SessionPathSelectionSchema,
  TrainingValueSummarySchema,
  assertCaroKannFamilyRegression,
  classifyBookTerminalStatus,
  classifyRepertoireTier,
  selectSessionPaths,
  stableRepertoireCardId,
  stableRepertoireEdgeId,
  stableRepertoirePathId,
  stableRepertoirePositionId,
  validateRepertoireGraphDocument,
  validateEligibleSourceEdgeInventory,
  type BookTerminalStatus,
  type RepertoireEdge,
  type RepertoireGraphDocument,
  type RepertoireNode,
  type RepertoirePath,
} from '../../src/domain/repertoire.ts'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import {
  SYNTHETIC_GRAPH_PROVENANCE_REF,
  createSyntheticFamilyGraphProvenanceDocument,
  createSyntheticRepertoireEvidence,
} from '../fixtures/synthetic-repertoire-evidence.ts'

interface SyntheticLine {
  moves: string[]
  family: string
  usage: number
  terminalStatus?: BookTerminalStatus
  exposePath?: boolean
}

interface RawEdge {
  fromEpd: string
  toEpd: string
  uci: string
  san: string
}

function moveInput(uci: string): { from: string; to: string; promotion?: string } {
  return uci[4] === undefined
    ? { from: uci.slice(0, 2), to: uci.slice(2, 4) }
    : { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }
}

/**
 * Test-only graph builder. Its cohort name and provenance make it impossible
 * to mistake fixture thresholds for observed production statistics.
 */
async function syntheticGraph(options: {
  id: string
  side: 'white' | 'black'
  root: Chess
  rootPly: number
  lines: SyntheticLine[]
  ecoCodes?: string[]
}): Promise<RepertoireGraphDocument> {
  const rootEpd = normalizedEpd(options.root)
  const rawEdges = new Map<string, RawEdge>()
  const rawPaths: Array<SyntheticLine & { nodeEpds: string[]; edgeKeys: string[] }> = []
  const epds = new Set<string>([rootEpd])

  for (const line of options.lines) {
    const chess = new Chess(options.root.fen())
    const nodeEpds = [rootEpd]
    const edgeKeys: string[] = []
    for (const uci of line.moves) {
      const fromEpd = normalizedEpd(chess)
      const move = chess.move(moveInput(uci))
      const toEpd = normalizedEpd(chess)
      const key = `${fromEpd}\0${uci}`
      const prior = rawEdges.get(key)
      if (prior && prior.toEpd !== toEpd) throw new Error('Synthetic fixture produced a nondeterministic edge')
      rawEdges.set(key, { fromEpd, toEpd, uci, san: move.san })
      edgeKeys.push(key)
      nodeEpds.push(toEpd)
      epds.add(toEpd)
    }
    rawPaths.push({ ...line, nodeEpds, edgeKeys })
  }

  const positionIds = new Map(await Promise.all([...epds].map(async (epd) => [epd, await stableRepertoirePositionId(epd)] as const)))
  const edgeIds = new Map(await Promise.all([...rawEdges.entries()].map(async ([key, edge]) => [
    key,
    await stableRepertoireEdgeId(edge.fromEpd, edge.uci, edge.toEpd),
  ] as const)))
  const outgoing = new Map<string, string[]>()
  const edges: RepertoireEdge[] = [...rawEdges.entries()].map(([key, edge]) => {
    const id = edgeIds.get(key)!
    const fromNodeId = positionIds.get(edge.fromEpd)!
    const ids = outgoing.get(fromNodeId) ?? []
    ids.push(id)
    outgoing.set(fromNodeId, ids)
    return {
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id,
      fromNodeId,
      toNodeId: positionIds.get(edge.toEpd)!,
      uci: edge.uci,
      san: edge.san,
      role: 'book',
      eligibleForDrill: true,
      acceptedBookTransposition: false,
      evidence: createSyntheticRepertoireEvidence({ uci: edge.uci, trainedSide: options.side }),
      provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    }
  })
  const nodes: RepertoireNode[] = [...epds].map((epd) => {
    const id = positionIds.get(epd)!
    const turn = epd.split(' ')[1]
    const learnerTurn = turn === (options.side === 'white' ? 'w' : 'b')
    return {
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id,
      epd,
      learnerTurn,
      outgoingEdgeIds: [...(outgoing.get(id) ?? [])].sort(),
      ...(learnerTurn ? { cardId: stableRepertoireCardId(options.id, id) } : {}),
      provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    }
  })
  const paths: RepertoirePath[] = []
  for (const raw of rawPaths.filter(({ exposePath = true }) => exposePath)) {
    const pathEdgeIds = raw.edgeKeys.map((key) => edgeIds.get(key)!)
    const nodeIds = raw.nodeEpds.map((epd) => positionIds.get(epd)!)
    paths.push({
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id: await stableRepertoirePathId(options.id, pathEdgeIds),
      packId: options.id,
      nodeIds,
      edgeIds: pathEdgeIds,
      learnerDecisionCount: raw.nodeEpds.slice(0, -1).filter((epd) =>
        epd.split(' ')[1] === (options.side === 'white' ? 'w' : 'b'),
      ).length,
      terminalPly: options.rootPly + pathEdgeIds.length,
      terminalStatus: raw.terminalStatus ?? 'evidence_terminal',
      familyTags: [raw.family],
      conditionalUsage: raw.usage,
      provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    })
  }

  const reachableNodeIds = new Set<string>()
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const visit = (nodeId: string): void => {
    if (reachableNodeIds.has(nodeId)) return
    reachableNodeIds.add(nodeId)
    for (const edgeId of nodeById.get(nodeId)?.outgoingEdgeIds ?? []) visit(edgeById.get(edgeId)!.toNodeId)
  }
  visit(positionIds.get(rootEpd)!)
  const coreDepth = Math.max(...paths.map(({ learnerDecisionCount }) => learnerDecisionCount))
  let opponentBranches = 0
  for (const node of nodes) {
    if (node.id === positionIds.get(rootEpd) || node.learnerTurn || !reachableNodeIds.has(node.id)) continue
    opponentBranches = Math.max(opponentBranches, node.outgoingEdgeIds.length)
  }
  return {
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    releaseId: 'synthetic-regression-fixture-only',
    pack: {
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id: options.id,
      side: options.side,
      rootNodeId: positionIds.get(rootEpd)!,
      rootPly: options.rootPly,
      tier: coreDepth >= 10 && opponentBranches >= 2 ? 'core' : 'primer',
      coreDepth,
      opponentBranchCountAfterRoot: opponentBranches,
      coverage: 0.9,
      ecoCodes: (options.ecoCodes ?? ['A00']) as RepertoireGraphDocument['pack']['ecoCodes'],
      nodeIds: nodes.map(({ id }) => id),
      edgeIds: edges.map(({ id }) => id),
      pathIds: paths.map(({ id }) => id),
      provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    },
    nodes,
    edges,
    paths,
  }
}

function extendWithoutRepeating(root: Chess, seed: readonly string[], targetPlies: number): string[] {
  const chess = new Chess(root.fen())
  const moves = [...seed]
  const seen = new Set<string>([normalizedEpd(chess)])
  for (const uci of seed) {
    chess.move(moveInput(uci))
    seen.add(normalizedEpd(chess))
  }
  while (moves.length < targetPlies) {
    const candidates = chess.moves({ verbose: true })
      .map((move) => ({ move, uci: `${move.from}${move.to}${move.promotion ?? ''}` }))
      .sort((left, right) => left.uci.localeCompare(right.uci, 'en'))
    let selected: { move: Move; uci: string } | undefined
    for (const candidate of candidates) {
      const next = new Chess(chess.fen())
      next.move(candidate.move)
      if (!seen.has(normalizedEpd(next)) && (!next.isGameOver() || moves.length + 1 === targetPlies)) {
        selected = candidate
        break
      }
    }
    if (!selected) throw new Error('Could not extend the synthetic legal-move fixture')
    chess.move(selected.move)
    moves.push(selected.uci)
    seen.add(normalizedEpd(chess))
  }
  return moves
}

test('stable IDs and exact legal EPD replay reject false transpositions', async () => {
  const graph = await syntheticGraph({
    id: 'white_regression',
    side: 'white',
    root: new Chess(),
    rootPly: 0,
    lines: [{ moves: ['g1f3', 'd7d5', 'g2g3'], family: 'Route A', usage: 1 }],
  })
  const validated = await validateRepertoireGraphDocument(graph)
  assert.match(validated.pack.rootNodeId, /^pos_[a-f0-9]{16}$/u)
  assert.equal(validated.nodes.find(({ learnerTurn }) => learnerTurn)?.cardId?.startsWith('white_regression::pos_'), true)

  const wrong = structuredClone(graph)
  wrong.edges[0]!.toNodeId = wrong.pack.rootNodeId
  await assert.rejects(() => validateRepertoireGraphDocument(wrong), /stable move identity|exact EPD/u)
})

test('promotion requires exact equality with the reconciled eligible source-edge inventory', async () => {
  const graph = await syntheticGraph({
    id: 'source_inventory',
    side: 'white',
    root: new Chess(),
    rootPly: 0,
    lines: [
      { moves: ['e2e4', 'e7e5', 'g1f3'], family: 'Route A', usage: 0.6 },
      { moves: ['d2d4', 'd7d5', 'c2c4'], family: 'Route B', usage: 0.4 },
    ],
  })
  await validateRepertoireGraphDocument(graph)
  const eligibleEdgeIds = graph.edges.filter(({ eligibleForDrill }) => eligibleForDrill).map(({ id }) => id)
  const inventory = EligibleSourceEdgeInventoryV1Schema.parse({
    schemaVersion: 1,
    releaseId: graph.releaseId,
    packId: graph.pack.id,
    sourceReceiptSha256: 'a'.repeat(64),
    eligibleEdgeIds,
  })
  assert.deepEqual(validateEligibleSourceEdgeInventory(graph, inventory), inventory)

  assert.throws(
    () => validateEligibleSourceEdgeInventory(graph, {
      ...inventory,
      eligibleEdgeIds: eligibleEdgeIds.slice(1),
    }),
    /inventory mismatch: 0 omitted and 1 invented|inventory mismatch: 1 omitted and 0 invented/u,
  )
  assert.throws(
    () => validateEligibleSourceEdgeInventory(graph, { ...inventory, releaseId: 'another-release' }),
    /another release/u,
  )
  assert.throws(
    () => validateEligibleSourceEdgeInventory(graph, { ...inventory, packId: 'another_pack' }),
    /another pack/u,
  )
})

test('public repertoire contracts are strict and explicitly versioned', async () => {
  const graph = await syntheticGraph({
    id: 'strict_contract', side: 'white', root: new Chess(), rootPly: 0,
    lines: [{ moves: ['e2e4'], family: 'Contract', usage: 1 }],
  })
  assert.equal(RepertoireGraphDocumentSchema.parse(graph).schemaVersion, 1)
  assert.throws(
    () => RepertoireGraphDocumentSchema.parse({ ...graph, schemaVersion: 2 }),
    /Invalid input/u,
  )
  assert.throws(
    () => RepertoirePathSchema.parse({ ...graph.paths[0], undocumentedField: true }),
    /Unrecognized key/u,
  )
})

test('public schemas fail closed at evidence, identity, path, and cycle-state boundaries', async () => {
  const graph = await syntheticGraph({
    id: 'schema_boundaries', side: 'white', root: new Chess(), rootPly: 0,
    lines: [{ moves: ['e2e4'], family: 'Contract', usage: 1 }],
  })
  const evidence = graph.edges[0]!.evidence
  const invalidEvidence = [
    { ...evidence, cohorts: [evidence.cohorts[0]!, evidence.cohorts[0]!] },
    { ...evidence, engine: { ...evidence.engine, centipawnLoss: null } },
    { ...evidence, engine: { ...evidence.engine, status: 'unverified', centipawnLoss: 1 } },
    { ...evidence, engine: { ...evidence.engine, status: 'quarantined', quarantineReasons: [] } },
    { ...evidence, engine: { ...evidence.engine, quarantineReasons: ['not quarantined'] } },
    { ...evidence, engine: { ...evidence.engine, forcedMateAgainstLearner: true } },
    { ...evidence, engine: { ...evidence.engine, centipawnLoss: 100 } },
  ]
  for (const candidate of invalidEvidence) assert.equal(RepertoireBranchEvidenceSchema.safeParse(candidate).success, false)

  const baseEdge = graph.edges[0]!
  const lowSample = createSyntheticRepertoireEvidence({ uci: baseEdge.uci, trainedSide: 'white', moveN: 99, reachN: 396 })
  const exploratorySample = createSyntheticRepertoireEvidence({ uci: baseEdge.uci, trainedSide: 'white', moveN: 499, reachN: 1_996 })
  const unsound = createSyntheticRepertoireEvidence({ uci: baseEdge.uci, trainedSide: 'white', centipawnLoss: 51 })
  const edgeCases: Array<[unknown, boolean]> = [
    [{ ...baseEdge, role: 'playable' }, false],
    [{ ...baseEdge, evidence: lowSample }, false],
    [{ ...baseEdge, evidence: unsound }, false],
    [{ ...baseEdge, eligibleForDrill: false }, false],
    [{ ...baseEdge, role: 'playable', eligibleForDrill: false }, true],
    [{ ...baseEdge, role: 'playable', eligibleForDrill: false, evidence: lowSample }, false],
    [{ ...baseEdge, role: 'playable', eligibleForDrill: false, evidence: unsound }, false],
    [{ ...baseEdge, role: 'exploratory', eligibleForDrill: false, evidence: exploratorySample }, true],
    [{ ...baseEdge, role: 'exploratory', eligibleForDrill: false, evidence: lowSample }, false],
    [{ ...baseEdge, role: 'exploratory', evidence: exploratorySample }, false],
    [{ ...baseEdge, role: 'exploratory', eligibleForDrill: false }, false],
    [{ ...baseEdge, eligibleForDrill: false, acceptedBookTransposition: true }, false],
    [{
      ...baseEdge,
      eligibleForDrill: false,
      evidence: createSyntheticRepertoireEvidence({
        uci: baseEdge.uci,
        trainedSide: 'white',
        status: 'quarantined',
        centipawnLoss: 100,
        quarantineReasons: ['fixture'],
      }),
    }, true],
  ]
  for (const [candidate, success] of edgeCases) assert.equal(RepertoireEdgeSchema.safeParse(candidate).success, success)

  assert.equal(RepertoireNodeSchema.safeParse({
    ...graph.nodes[0], outgoingEdgeIds: [graph.edges[0]!.id, graph.edges[0]!.id],
  }).success, false)
  const basePath = graph.paths[0]!
  const pathCases = [
    { ...basePath, nodeIds: [basePath.nodeIds[0]!, basePath.nodeIds[0]!] },
    { ...basePath, nodeIds: [...basePath.nodeIds, basePath.nodeIds[0]!], edgeIds: [...basePath.edgeIds, basePath.edgeIds[0]!] },
    { ...basePath, familyTags: ['Contract', 'Contract'] },
    { ...basePath, terminalStatus: 'depth_capped', terminalPly: 1 },
  ]
  for (const candidate of pathCases) assert.equal(RepertoirePathSchema.safeParse(candidate).success, false)

  for (const key of ['ecoCodes', 'nodeIds', 'edgeIds', 'pathIds'] as const) {
    const duplicate = graph.pack[key][0]!
    assert.equal(RepertoirePackSchema.safeParse({ ...graph.pack, [key]: [...graph.pack[key], duplicate] }).success, false)
  }
  assert.equal(CoverageCycleStateSchema.safeParse({
    schemaVersion: 1, packId: graph.pack.id, ordinal: 0,
    remainingPathIds: [basePath.id, basePath.id],
  }).success, false)
  const selection = selectSessionPaths({ graph, dueCardIds: [], previousCycle: null, maximumPaths: 1 }).selection
  for (const key of ['includedPathIds', 'warmupNodeIds'] as const) {
    const value = key === 'warmupNodeIds' ? graph.pack.rootNodeId : selection.includedPathIds[0]!
    assert.equal(SessionPathSelectionSchema.safeParse({ ...selection, [key]: [value, value] }).success, false)
  }
  const foreignDue = `${'other_pack'}::${graph.pack.rootNodeId}`
  assert.equal(SessionPathSelectionSchema.safeParse({ ...selection, dueCardIds: [foreignDue] }).success, false)
  assert.equal(TrainingValueSummarySchema.safeParse({
    schemaVersion: 1, soundnessTier: 1, empiricalDepth: 100,
    coverage: 0.85, usage: 500, scoreLowerBound: 0.5,
  }).success, true)
})

test('cohort evidence preserves source dimensions and rejects inconsistent arithmetic without pooling', async () => {
  const evidence = createSyntheticRepertoireEvidence({
    uci: 'e2e4',
    trainedSide: 'white',
    moveN: 500,
    reachN: 1_000,
  })
  assert.deepEqual(evidence.cohorts.map(({ source }) => source), ['broadcast', 'lichess-standard'])
  assert.equal(evidence.cohorts[0]!.canonicalBands.length, 5)
  assert.equal(evidence.cohorts[1]!.lichessBeginnerBands.length, 3)

  const broadcast = evidence.cohorts[0]!
  const invalidCohorts = [
    { ...broadcast, ratingSystem: 'lichess-glicko2' },
    { ...broadcast, aggregate: { ...broadcast.aggregate, whiteWins: broadcast.aggregate.whiteWins + 1 } },
    { ...broadcast, aggregate: { ...broadcast.aggregate, wins: broadcast.aggregate.wins + 1 } },
    { ...broadcast, aggregate: { ...broadcast.aggregate, score: 0.123 } },
    { ...broadcast, aggregate: { ...broadcast.aggregate, conditionalUsage: 0.75 } },
    { ...broadcast, aggregate: { ...broadcast.aggregate, scoreInterval: { ...broadcast.aggregate.scoreInterval!, low: 0 } } },
    { ...broadcast, canonicalBands: broadcast.canonicalBands.map((band, index) => index === 1 ? { ...band, band: '<1800' as const } : band) },
    { ...broadcast, lichessBeginnerBands: evidence.cohorts[1]!.lichessBeginnerBands },
  ]
  for (const candidate of invalidCohorts) {
    assert.equal(EvidenceCohortResultSchema.safeParse(candidate).success, false)
  }
  assert.equal(RepertoireBranchEvidenceSchema.safeParse({
    ...evidence,
    selectionCohortId: evidence.cohorts[1]!.cohortId,
    conditionalUsage: evidence.cohorts[1]!.aggregate.conditionalUsage + 0.1,
  }).success, false)
})

test('engine checks derive trained-side loss and mate state and graph validation legally replays PVs', async () => {
  const evidence = createSyntheticRepertoireEvidence({ uci: 'e2e4', trainedSide: 'white' })
  const inconsistent = structuredClone(evidence)
  inconsistent.engine.check!.moveEvaluation.value -= 20
  assert.equal(RepertoireBranchEvidenceSchema.safeParse(inconsistent).success, false)

  const losingMate = structuredClone(evidence)
  losingMate.engine.status = 'quarantined'
  losingMate.engine.centipawnLoss = null
  losingMate.engine.forcedMateAgainstLearner = true
  losingMate.engine.quarantineReasons = ['forced losing mate in synthetic fixture']
  losingMate.engine.check!.moveEvaluation = {
    kind: 'mate', value: -3, unit: 'signed-plies-to-mate', perspective: 'trained-side',
  }
  losingMate.engine.check!.centipawnLoss = null
  losingMate.engine.check!.forcedMateAgainstLearner = true
  assert.equal(RepertoireBranchEvidenceSchema.safeParse(losingMate).success, true)

  const graph = await syntheticGraph({
    id: 'illegal_pv_guard', side: 'white', root: new Chess(), rootPly: 0,
    lines: [{ moves: ['e2e4'], family: 'PV guard', usage: 1 }],
  })
  graph.edges[0]!.evidence.engine.check!.bestPrincipalVariationUci.push('a1a8')
  await assert.rejects(() => validateRepertoireGraphDocument(graph), /principal variation is illegal/u)
})

test('engine evidence rejects every inconsistent summary and handles mate evaluations without centipawn claims', () => {
  const verified = createSyntheticRepertoireEvidence({ uci: 'e2e4', trainedSide: 'white' })
  const invalid = [
    { ...verified, engine: { ...verified.engine, check: null } },
    { ...verified, engine: { ...verified.engine, check: null, centipawnLoss: 1 } },
    { ...verified, engine: { ...verified.engine, check: null, forcedMateAgainstLearner: true } },
    { ...verified, engine: { ...verified.engine, check: { ...verified.engine.check!, centipawnLoss: 1 } } },
    { ...verified, engine: { ...verified.engine, check: { ...verified.engine.check!, forcedMateAgainstLearner: true } } },
    { ...verified, engine: { ...verified.engine, status: 'quarantined' as const, quarantineReasons: [] } },
    { ...verified, engine: { ...verified.engine, quarantineReasons: ['verified records cannot carry quarantine prose'] } },
    {
      ...verified,
      engine: {
        ...verified.engine,
        check: {
          ...verified.engine.check!,
          bestEvaluation: { kind: 'centipawn' as const, value: 20, unit: 'centipawn' as const, perspective: 'trained-side' as const },
          moveEvaluation: { kind: 'centipawn' as const, value: 30, unit: 'centipawn' as const, perspective: 'trained-side' as const },
          centipawnLoss: 0,
        },
      },
    },
  ]
  for (const candidate of invalid) {
    assert.equal(RepertoireBranchEvidenceSchema.safeParse(candidate).success, false)
  }

  const winningMate = structuredClone(verified)
  winningMate.engine.check!.bestEvaluation = {
    kind: 'mate', value: 3, unit: 'signed-plies-to-mate', perspective: 'trained-side',
  }
  winningMate.engine.check!.moveEvaluation = {
    kind: 'mate', value: 5, unit: 'signed-plies-to-mate', perspective: 'trained-side',
  }
  winningMate.engine.check!.centipawnLoss = 0
  assert.equal(RepertoireBranchEvidenceSchema.safeParse(winningMate).success, true)

  const incomparable = structuredClone(verified)
  incomparable.engine.centipawnLoss = null
  incomparable.engine.check!.bestEvaluation = {
    kind: 'mate', value: 3, unit: 'signed-plies-to-mate', perspective: 'trained-side',
  }
  incomparable.engine.check!.centipawnLoss = null
  assert.equal(RepertoireBranchEvidenceSchema.safeParse(incomparable).success, true)
})

test('family provenance binds graph references to immutable taxonomy, corpus, engine, and Scid receipts', () => {
  const document = createSyntheticFamilyGraphProvenanceDocument({
    releaseId: 'synthetic-provenance-release',
    familyId: 'synthetic-family',
  })
  assert.equal(FamilyGraphProvenanceDocumentV1Schema.parse(document).bindings.length, 1)
  const wrongKind = structuredClone(document)
  wrongKind.bindings[0]!.engineReceiptId = wrongKind.bindings[0]!.taxonomyReceiptId
  assert.equal(FamilyGraphProvenanceDocumentV1Schema.safeParse(wrongKind).success, false)
  const unsafeAlias = structuredClone(document)
  unsafeAlias.receipts[0]!.path = 'receipts//taxonomy.json'
  assert.equal(FamilyGraphProvenanceDocumentV1Schema.safeParse(unsafeAlias).success, false)
  const orphan = structuredClone(document)
  orphan.bindings[0]!.corpusReceiptIds = [orphan.bindings[0]!.corpusReceiptIds[0]!]
  assert.equal(FamilyGraphProvenanceDocumentV1Schema.safeParse(orphan).success, false)
  const wrongCorpusKind = structuredClone(document)
  wrongCorpusKind.bindings[0]!.corpusReceiptIds = [wrongCorpusKind.bindings[0]!.taxonomyReceiptId]
  assert.equal(FamilyGraphProvenanceDocumentV1Schema.safeParse(wrongCorpusKind).success, false)
  const mismatchedReceiptId = structuredClone(document)
  mismatchedReceiptId.receipts[0]!.id = 'receipt_0000000000000000'
  assert.equal(FamilyGraphProvenanceDocumentV1Schema.safeParse(mismatchedReceiptId).success, false)
})

test('all eligible branches remain selectable across a starvation-free coverage cycle', async () => {
  const graph = await syntheticGraph({
    id: 'all_branches',
    side: 'white',
    root: new Chess(),
    rootPly: 0,
    lines: [
      { moves: ['e2e4', 'e7e5'], family: 'One', usage: 0.52 },
      { moves: ['e2e4', 'c7c5'], family: 'Two', usage: 0.24 },
      { moves: ['e2e4', 'c7c6'], family: 'Three', usage: 0.1 },
      { moves: ['d2d4', 'd7d5'], family: 'Four', usage: 0.05 },
      { moves: ['d2d4', 'g8f6'], family: 'Five', usage: 0.04 },
      { moves: ['c2c4', 'e7e5'], family: 'Six', usage: 0.03 },
      { moves: ['g1f3', 'd7d5'], family: 'Seven', usage: 0.02 },
    ],
  })
  await validateRepertoireGraphDocument(graph)
  const seen: string[] = []
  let cycle = null
  while (cycle === null || cycle.ordinal === 0) {
    const result = selectSessionPaths({ graph, dueCardIds: [], previousCycle: cycle, maximumPaths: 2 })
    seen.push(...result.selection.includedPathIds)
    cycle = result.nextCycle
  }
  assert.equal(seen.length, 7)
  assert.deepEqual(new Set(seen), new Set(graph.paths.map(({ id }) => id)))
  assert.equal(cycle.ordinal, 1)
  assert.deepEqual(cycle.remainingPathIds, [])
})

test('due cards are prioritized while path prefixes are marked as warm-ups', async () => {
  const graph = await syntheticGraph({
    id: 'due_routes',
    side: 'white',
    root: new Chess(),
    rootPly: 0,
    lines: [
      { moves: ['e2e4', 'e7e5', 'g1f3'], family: 'Due', usage: 0.1 },
      { moves: ['d2d4', 'd7d5', 'c2c4'], family: 'Popular', usage: 0.9 },
    ],
  })
  await validateRepertoireGraphDocument(graph)
  const duePath = graph.paths.find(({ familyTags }) => familyTags.includes('Due'))!
  const dueNodeId = duePath.nodeIds[2]!
  const dueCardId = stableRepertoireCardId(graph.pack.id, dueNodeId)
  const result = selectSessionPaths({ graph, dueCardIds: [dueCardId], previousCycle: null, maximumPaths: 1 })
  assert.deepEqual(result.selection.includedPathIds, [duePath.id])
  assert.deepEqual(result.selection.dueCardIds, [dueCardId])
  assert.ok(result.selection.warmupNodeIds.includes(graph.pack.rootNodeId))
  assert.ok(!result.selection.warmupNodeIds.includes(dueNodeId))
})

test('terminal status distinguishes evidence exhaustion, sparse continuation, and the ply-100 cap', async () => {
  assert.equal(classifyBookTerminalStatus({
    terminalPly: 100,
    hasEligibleContinuation: true,
    hasExploratoryContinuation: false,
    hasQuarantinedContinuation: false,
  }), 'depth_capped')
  assert.equal(classifyRepertoireTier(10, 2), 'core')
  assert.equal(classifyRepertoireTier(9, 20), 'primer')
  assert.throws(() => classifyBookTerminalStatus({
    terminalPly: 99,
    hasEligibleContinuation: true,
    hasExploratoryContinuation: false,
    hasQuarantinedContinuation: false,
  }), /book continuation remained/u)

  const evidenceTerminal = await syntheticGraph({
    id: 'terminal_evidence', side: 'white', root: new Chess(), rootPly: 0,
    lines: [{ moves: ['e2e4'], family: 'Terminal', usage: 1 }],
  })
  await validateRepertoireGraphDocument(evidenceTerminal)

  const capped = await syntheticGraph({
    id: 'terminal_cap', side: 'white', root: new Chess(), rootPly: 99,
    lines: [
      { moves: ['e2e4'], family: 'Capped', usage: 1, terminalStatus: 'depth_capped' },
      { moves: ['e2e4', 'e7e5'], family: 'Evidence only', usage: 0, exposePath: false },
    ],
  })
  await validateRepertoireGraphDocument(capped)

  const premature = structuredClone(capped)
  premature.pack.rootPly = 0
  premature.paths[0]!.terminalPly = 1
  premature.paths[0]!.terminalStatus = 'evidence_terminal'
  await assert.rejects(() => validateRepertoireGraphDocument(premature), /book continuation remained|hidden from every selectable path/u)

  const sparse = structuredClone(evidenceTerminal)
  const terminal = sparse.nodes.find(({ id }) => id === sparse.paths[0]!.nodeIds.at(-1))!
  const chess = new Chess(`${terminal.epd} 0 1`)
  const move = chess.move('e5')
  const targetEpd = normalizedEpd(chess)
  const targetId = await stableRepertoirePositionId(targetEpd)
  const edgeId = await stableRepertoireEdgeId(terminal.epd, 'e7e5', targetEpd)
  terminal.outgoingEdgeIds.push(edgeId)
  sparse.nodes.push({
    schemaVersion: 1, id: targetId, epd: targetEpd, learnerTurn: true,
    outgoingEdgeIds: [], cardId: stableRepertoireCardId(sparse.pack.id, targetId),
    provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
  })
  sparse.edges.push({
    schemaVersion: 1, id: edgeId, fromNodeId: terminal.id, toNodeId: targetId,
    uci: 'e7e5', san: move.san, role: 'exploratory', eligibleForDrill: false,
    acceptedBookTransposition: false,
    evidence: createSyntheticRepertoireEvidence({
      uci: 'e7e5',
      trainedSide: 'white',
      moveN: 499,
      reachN: 1_996,
      status: 'unverified',
    }),
    provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
  })
  sparse.pack.nodeIds.push(targetId)
  sparse.pack.edgeIds.push(edgeId)
  sparse.paths[0]!.terminalStatus = 'insufficient_sample'
  await validateRepertoireGraphDocument(sparse)
})

test('Core requires ten learner decisions and a real opponent response branch', async () => {
  const root = new Chess()
  const longA = extendWithoutRepeating(root, ['e2e4', 'e7e5'], 20)
  const longB = extendWithoutRepeating(root, ['e2e4', 'c7c5'], 20)
  const graph = await syntheticGraph({
    id: 'core_threshold', side: 'white', root, rootPly: 0,
    lines: [
      { moves: longA, family: 'A', usage: 0.6 },
      { moves: longB, family: 'B', usage: 0.4 },
    ],
  })
  const validated = await validateRepertoireGraphDocument(graph)
  assert.equal(validated.pack.coreDepth, CORE_MINIMUM_LEARNER_DECISIONS)
  assert.equal(validated.pack.opponentBranchCountAfterRoot, 2)
  assert.equal(validated.pack.tier, 'core')

  const overstated = structuredClone(graph)
  overstated.pack.coreDepth = 11
  await assert.rejects(() => validateRepertoireGraphDocument(overstated), /core depth must be 10/u)
})

test('accepted transpositions require exact convergence and an audited continuation', async () => {
  const graph = await syntheticGraph({
    id: 'transposition_guard', side: 'white', root: new Chess(), rootPly: 0,
    lines: [
      { moves: ['g1f3', 'd7d5', 'g2g3', 'g8f6'], family: 'Nf3 first', usage: 0.5 },
      { moves: ['g2g3', 'd7d5', 'g1f3', 'g8f6'], family: 'g3 first', usage: 0.5 },
    ],
  })
  const transposedTarget = graph.paths[0]!.nodeIds[3]!
  const acceptedEdgeId = graph.paths[1]!.edgeIds[2]!
  graph.edges.find(({ id }) => id === acceptedEdgeId)!.acceptedBookTransposition = true
  assert.equal(graph.edges.filter(({ toNodeId }) => toNodeId === transposedTarget).length, 2)
  await validateRepertoireGraphDocument(graph)

  const noContinuation = structuredClone(graph)
  for (const path of noContinuation.paths) {
    path.nodeIds = path.nodeIds.slice(0, 4)
    path.edgeIds = path.edgeIds.slice(0, 3)
    path.terminalPly = 3
    path.learnerDecisionCount = 2
    path.id = await stableRepertoirePathId(noContinuation.pack.id, path.edgeIds)
  }
  const continuationIds = new Set(graph.paths.flatMap((path) => path.edgeIds.slice(3)))
  noContinuation.edges = noContinuation.edges.filter(({ id }) => !continuationIds.has(id))
  noContinuation.pack.edgeIds = noContinuation.edges.map(({ id }) => id)
  noContinuation.pack.pathIds = noContinuation.paths.map(({ id }) => id)
  for (const node of noContinuation.nodes) node.outgoingEdgeIds = node.outgoingEdgeIds.filter((id) => !continuationIds.has(id))
  noContinuation.pack.coreDepth = 2
  noContinuation.pack.tier = 'primer'
  await assert.rejects(() => validateRepertoireGraphDocument(noContinuation), /known audited continuation/u)

  const singleRoute = await syntheticGraph({
    id: 'false_transposition', side: 'white', root: new Chess(), rootPly: 0,
    lines: [{ moves: ['e2e4', 'e7e5'], family: 'Single route', usage: 1 }],
  })
  singleRoute.edges[0]!.acceptedBookTransposition = true
  await assert.rejects(() => validateRepertoireGraphDocument(singleRoute), /another exact route/u)
})

test('semantic graph audit reports corrupt relationships without trusting stable-looking IDs', async () => {
  const base = await syntheticGraph({
    id: 'semantic_failures', side: 'white', root: new Chess(), rootPly: 0,
    lines: [
      { moves: ['e2e4', 'e7e5'], family: 'One', usage: 0.6 },
      { moves: ['d2d4', 'd7d5'], family: 'Two', usage: 0.4 },
    ],
  })
  const rejects = async (
    mutate: (graph: RepertoireGraphDocument) => void | Promise<void>,
    pattern: RegExp,
  ): Promise<void> => {
    const graph = structuredClone(base)
    await mutate(graph)
    await assert.rejects(() => validateRepertoireGraphDocument(graph), pattern)
  }

  await rejects((graph) => { graph.pack.rootNodeId = 'pos_0000000000000000' }, /root node is missing/u)
  await rejects((graph) => { graph.pack.nodeIds.pop() }, /node index/u)
  await rejects((graph) => { graph.pack.edgeIds.pop() }, /edge index/u)
  await rejects((graph) => { graph.pack.pathIds.pop() }, /path index/u)
  await rejects((graph) => { graph.nodes[0]!.learnerTurn = false }, /learner-turn flag/u)
  await rejects((graph) => {
    const learner = graph.nodes.find(({ cardId }) => cardId !== undefined)!
    learner.cardId = `${graph.pack.id}::pos_0000000000000000`
  }, /stable card identity/u)
  await rejects((graph) => {
    graph.edges[0]!.fromNodeId = 'pos_0000000000000000'
  }, /references a missing node/u)
  await rejects((graph) => {
    const source = graph.nodes.find(({ id }) => id === graph.edges[0]!.fromNodeId)!
    source.outgoingEdgeIds = source.outgoingEdgeIds.filter((id) => id !== graph.edges[0]!.id)
  }, /missing from its source node/u)
  await rejects((graph) => { graph.edges[0]!.san = 'NotSAN' }, /SAN does not match/u)
  await rejects((graph) => {
    const terminal = graph.nodes.find(({ outgoingEdgeIds }) => outgoingEdgeIds.length === 0)!
    terminal.outgoingEdgeIds.push('edge_00000000000000000000')
  }, /references missing edge/u)
  await rejects((graph) => {
    const terminal = graph.nodes.find(({ outgoingEdgeIds }) => outgoingEdgeIds.length === 0)!
    terminal.outgoingEdgeIds.push(graph.edges[0]!.id)
  }, /edge owned by another position/u)
  await rejects((graph) => {
    graph.paths[0]!.packId = 'different_pack'
  }, /belongs to another pack/u)
  await rejects((graph) => {
    graph.paths[0]!.id = 'path_00000000000000000000'
    graph.pack.pathIds[0] = graph.paths[0]!.id
  }, /stable edge identity/u)
  await rejects((graph) => {
    graph.paths[0]!.nodeIds = [...graph.paths[0]!.nodeIds].reverse()
  }, /does not begin at the pack root|not a contiguous graph walk/u)
  await rejects((graph) => { graph.paths[0]!.learnerDecisionCount = 0 }, /learner-decision count/u)
  await rejects((graph) => { graph.paths[0]!.terminalPly += 1 }, /incorrect terminal ply/u)
  await rejects((graph) => { graph.paths[0]!.terminalStatus = 'quarantined' }, /terminal status/u)
  await rejects((graph) => {
    graph.pack.opponentBranchCountAfterRoot += 1
  }, /opponent branch count/u)
  await rejects((graph) => { graph.pack.tier = 'core' }, /tier must be primer/u)

  const cycle = await syntheticGraph({
    id: 'cycle_guard', side: 'white', root: new Chess(), rootPly: 0,
    lines: [
      { moves: ['e2e4'], family: 'Visible', usage: 1 },
      { moves: ['g1f3', 'g8f6', 'f3g1', 'f6g8'], family: 'Hidden cycle', usage: 0, exposePath: false },
    ],
  })
  await assert.rejects(() => validateRepertoireGraphDocument(cycle), /contains a cycle/u)

  const unreachable = structuredClone(base)
  const isolated = new Chess()
  isolated.move('a3')
  const isolatedSourceEpd = normalizedEpd(isolated)
  const isolatedSourceId = await stableRepertoirePositionId(isolatedSourceEpd)
  const isolatedMove = isolated.move('e5')
  const isolatedTargetEpd = normalizedEpd(isolated)
  const isolatedTargetId = await stableRepertoirePositionId(isolatedTargetEpd)
  const isolatedEdgeId = await stableRepertoireEdgeId(isolatedSourceEpd, 'e7e5', isolatedTargetEpd)
  unreachable.nodes.push(
    {
      schemaVersion: 1, id: isolatedSourceId, epd: isolatedSourceEpd, learnerTurn: false,
      outgoingEdgeIds: [isolatedEdgeId], provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    },
    {
      schemaVersion: 1, id: isolatedTargetId, epd: isolatedTargetEpd, learnerTurn: true,
      outgoingEdgeIds: [], cardId: stableRepertoireCardId(unreachable.pack.id, isolatedTargetId),
      provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    },
  )
  unreachable.edges.push({
    ...structuredClone(unreachable.edges[0]!),
    id: isolatedEdgeId,
    fromNodeId: isolatedSourceId,
    toNodeId: isolatedTargetId,
    uci: 'e7e5',
    san: isolatedMove.san,
    evidence: createSyntheticRepertoireEvidence({ uci: 'e7e5', trainedSide: 'white' }),
  })
  unreachable.pack.nodeIds.push(isolatedSourceId, isolatedTargetId)
  unreachable.pack.edgeIds.push(isolatedEdgeId)
  await assert.rejects(() => validateRepertoireGraphDocument(unreachable), /unreachable from the pack root/u)
})

test('session selection rejects stale or cross-pack scheduling state', async () => {
  const graph = await syntheticGraph({
    id: 'selection_guards', side: 'white', root: new Chess(), rootPly: 0,
    lines: [
      { moves: ['e2e4'], family: 'One', usage: 0.9 },
      { moves: ['d2d4'], family: 'Two', usage: 0.1 },
    ],
  })
  assert.throws(() => selectSessionPaths({ graph, dueCardIds: [], previousCycle: null, maximumPaths: 0 }), /maximumPaths/u)
  assert.throws(() => selectSessionPaths({ graph, dueCardIds: [], previousCycle: null, maximumPaths: 1.5 }), /maximumPaths/u)
  assert.throws(() => selectSessionPaths({
    graph, dueCardIds: [`other_pack::${graph.pack.rootNodeId}`], previousCycle: null, maximumPaths: 1,
  }), /selected pack/u)
  assert.throws(() => selectSessionPaths({
    graph,
    dueCardIds: [],
    previousCycle: { schemaVersion: 1, packId: 'other_pack', ordinal: 0, remainingPathIds: [] },
    maximumPaths: 1,
  }), /another pack/u)
  assert.throws(() => selectSessionPaths({
    graph,
    dueCardIds: [],
    previousCycle: {
      schemaVersion: 1, packId: graph.pack.id, ordinal: 0,
      remainingPathIds: ['path_00000000000000000000'],
    },
    maximumPaths: 1,
  }), /unavailable path/u)
})

test('synthetic Caro-Kann family regression spans B10-B19 with eight deep selectable paths', async () => {
  const root = new Chess()
  root.move('e4')
  root.move('c6')
  const seeds = [
    { family: 'Advance', moves: ['d2d4', 'd7d5', 'e4e5', 'c8f5'], usage: 0.24 },
    { family: 'Advance', moves: ['d2d4', 'd7d5', 'e4e5', 'c8f5', 'h2h4'], usage: 0.08 },
    { family: 'Exchange', moves: ['d2d4', 'd7d5', 'e4d5', 'c6d5'], usage: 0.18 },
    { family: 'Panov', moves: ['d2d4', 'd7d5', 'e4d5', 'c6d5', 'c2c4'], usage: 0.14 },
    { family: 'Classical', moves: ['d2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4'], usage: 0.14 },
    { family: 'Two Knights', moves: ['b1c3', 'd7d5', 'g1f3'], usage: 0.1 },
    { family: 'Fantasy', moves: ['d2d4', 'd7d5', 'f2f3'], usage: 0.07 },
    { family: 'Gurgenidze', moves: ['d2d4', 'd7d5', 'b1c3', 'g7g6'], usage: 0.05 },
  ]
  const graph = await syntheticGraph({
    id: 'caro_kann_black', side: 'black', root, rootPly: 2,
    ecoCodes: Array.from({ length: 10 }, (_, index) => `B${10 + index}`),
    lines: seeds.map((seed) => ({ ...seed, moves: extendWithoutRepeating(root, seed.moves, 20) })),
  })
  await validateRepertoireGraphDocument(graph)
  const summary = assertCaroKannFamilyRegression(graph)
  assert.equal(summary.pathCount, 8)
  assert.equal(summary.corePathCount, 8)
  assert.ok(summary.families.includes('Panov'))
  assert.equal(graph.paths.every(({ learnerDecisionCount }) => learnerDecisionCount === 10), true)

  const onlyTopThree = structuredClone(graph)
  onlyTopThree.paths = onlyTopThree.paths.slice(0, 3)
  onlyTopThree.pack.pathIds = onlyTopThree.paths.map(({ id }) => id)
  await assert.rejects(() => validateRepertoireGraphDocument(onlyTopThree), /hidden from every selectable path|ended while/u)
  assert.throws(() => assertCaroKannFamilyRegression(onlyTopThree), /at least eight/u)
})

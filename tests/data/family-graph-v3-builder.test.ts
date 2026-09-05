import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Chess } from 'chess.js'
import { evidenceFingerprint } from '../../scripts/data/compact-v3-foundation.ts'
import {
  buildFamilyEngineCandidatePackFromVerifiedExactStates,
  buildFamilyGraphFromVerifiedExactStates,
  type VerifiedCompactExactFamilyGraphHandoff,
} from '../../scripts/data/family-graph-v3-builder.ts'
import {
  CompactExactFamilyGraphHandoffV1Schema,
  FamilyGraphEngineProofSetV1Schema,
  FamilyGraphPackBuildSpecV1Schema,
} from '../../scripts/data/family-graph-v3-contracts.ts'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import { validateRepertoireGraphDocument } from '../../src/domain/repertoire.ts'
import {
  createSyntheticFamilyGraphProvenanceDocument,
  createSyntheticRepertoireEvidence,
  SYNTHETIC_GRAPH_PROVENANCE_REF,
} from '../fixtures/synthetic-repertoire-evidence.ts'
import { createSyntheticCaroKannGraph } from '../fixtures/synthetic-caro-kann-graph.ts'

const RELEASE = 'synthetic-v3-family-graph-test-not-production'
const HASH = 'a'.repeat(64)

interface LineDefinition {
  familyId: string
  canonicalName: string
  packId: string
  ecoCodes: string[]
  side: 'white' | 'black'
  rootMoves: string[]
  moves: string[]
}

const LINES: LineDefinition[] = [
  {
    familyId: 'caro-kann', canonicalName: 'Caro–Kann Defence', packId: 'caro_kann_black', ecoCodes: ['B10'], side: 'black',
    rootMoves: ['e2e4', 'c7c6'], moves: ['d2d4', 'd7d5', 'e4e5', 'c8f5'],
  },
  {
    familyId: 'sicilian-defence', canonicalName: 'Sicilian Defence', packId: 'sicilian_black', ecoCodes: ['B20'], side: 'black',
    rootMoves: ['e2e4', 'c7c5'], moves: ['g1f3', 'd7d6', 'd2d4', 'c5d4'],
  },
  {
    familyId: 'ruy-lopez', canonicalName: 'Ruy Lopez', packId: 'ruy_lopez_black', ecoCodes: ['C60'], side: 'black',
    rootMoves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'], moves: ['a7a6', 'b5a4', 'g8f6'],
  },
]

function moveInput(uci: string) {
  return uci[4] === undefined
    ? { from: uci.slice(0, 2), to: uci.slice(2, 4) }
    : { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }
}

function rootPosition(line: LineDefinition): Chess {
  const chess = new Chess()
  for (const uci of line.rootMoves) chess.move(moveInput(uci))
  return chess
}

function setupEvidenceDatabase(path: string, source: 'broadcast' | 'standard'): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE positions(position_id INTEGER PRIMARY KEY, fingerprint BLOB NOT NULL, epd TEXT NOT NULL UNIQUE);
    CREATE TABLE edges(edge_id INTEGER PRIMARY KEY, fingerprint BLOB NOT NULL, from_position_id INTEGER NOT NULL,
      uci TEXT NOT NULL, san TEXT NOT NULL, to_position_id INTEGER NOT NULL);
    CREATE TABLE outcomes(kind TEXT NOT NULL, reference_id INTEGER NOT NULL, cohort_id TEXT NOT NULL,
      month TEXT NOT NULL, time_control TEXT NOT NULL, rating_band TEXT NOT NULL, rating_detail TEXT NOT NULL,
      min_ply INTEGER NOT NULL, n INTEGER NOT NULL, white_wins INTEGER NOT NULL, draws INTEGER NOT NULL,
      black_wins INTEGER NOT NULL);
  `)
  const positionIds = new Map<string, number>()
  const position = (epd: string): number => {
    const prior = positionIds.get(epd)
    if (prior !== undefined) return prior
    const id = positionIds.size + 1
    database.prepare('INSERT INTO positions VALUES (?, ?, ?)').run(
      id,
      Buffer.from(evidenceFingerprint({ kind: 'position', epd }), 'hex'),
      epd,
    )
    positionIds.set(epd, id)
    return id
  }
  let edgeId = 0
  for (const line of LINES) {
    const chess = rootPosition(line)
    let ply = line.rootMoves.length
    for (const uci of line.moves) {
      const fromEpd = normalizedEpd(chess)
      const fromId = position(fromEpd)
      const move = chess.move(moveInput(uci))
      const toEpd = normalizedEpd(chess)
      const toId = position(toEpd)
      edgeId += 1
      database.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?)').run(
        edgeId,
        Buffer.from(evidenceFingerprint({ kind: 'edge', fromEpd, uci, toEpd }), 'hex'),
        fromId,
        uci,
        move.san,
        toId,
      )
      const cohortId = source === 'broadcast' ? 'cohort_broadcast-classical' : 'cohort_lichess-standard-classical'
      const detail = source === 'broadcast' ? '' : '<1200'
      database.prepare('INSERT INTO outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'edge', edgeId, cohortId, '2026-06', 'classical', '<1800', detail, ply + 1, 600, 240, 120, 240,
      )
      ply += 1
    }
  }
  for (const [epd, id] of positionIds) {
    const cohortId = source === 'broadcast' ? 'cohort_broadcast-classical' : 'cohort_lichess-standard-classical'
    const detail = source === 'broadcast' ? '' : '<1200'
    database.prepare('INSERT INTO outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'position', id, cohortId, '2026-06', 'classical', '<1800', detail, 0, 1_000, 400, 200, 400,
    )
    assert.equal(epd, epd.normalize('NFC'))
  }
  // One sampled but non-drillable continuation at the final Caro learner node.
  const caro = rootPosition(LINES[0]!)
  for (const uci of LINES[0]!.moves.slice(0, 3)) caro.move(moveInput(uci))
  const fromEpd = normalizedEpd(caro)
  const fromId = positionIds.get(fromEpd)!
  const alternate = caro.move(moveInput('c8g4'))
  const toEpd = normalizedEpd(caro)
  const toId = position(toEpd)
  edgeId += 1
  database.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?)').run(
    edgeId,
    Buffer.from(evidenceFingerprint({ kind: 'edge', fromEpd, uci: 'c8g4', toEpd }), 'hex'),
    fromId,
    'c8g4',
    alternate.san,
    toId,
  )
  const cohortId = source === 'broadcast' ? 'cohort_broadcast-classical' : 'cohort_lichess-standard-classical'
  const detail = source === 'broadcast' ? '' : '<1200'
  database.prepare('INSERT INTO outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'edge', edgeId, cohortId, '2026-06', 'classical', '<1800', detail, 6, 200, 80, 40, 80,
  )
  return database
}

function appendCaroKnightCycle(database: DatabaseSync, source: 'broadcast' | 'standard'): void {
  const line = LINES[0]!
  const chess = rootPosition(line)
  const cohortId = source === 'broadcast' ? 'cohort_broadcast-classical' : 'cohort_lichess-standard-classical'
  const detail = source === 'broadcast' ? '' : '<1200'
  const ensurePosition = (epd: string): number => {
    const found = database.prepare('SELECT position_id AS id FROM positions WHERE epd = ?').get(epd) as { id: number } | undefined
    if (found) return found.id
    const id = (database.prepare('SELECT coalesce(max(position_id), 0) + 1 AS id FROM positions').get() as { id: number }).id
    database.prepare('INSERT INTO positions VALUES (?, ?, ?)').run(
      id, Buffer.from(evidenceFingerprint({ kind: 'position', epd }), 'hex'), epd,
    )
    database.prepare('INSERT INTO outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'position', id, cohortId, '2026-06', 'classical', '<1800', detail, 0, 1_000, 400, 200, 400,
    )
    return id
  }
  database.prepare(`
    UPDATE outcomes SET n = 2000, white_wins = 800, draws = 400, black_wins = 800
    WHERE kind = 'position' AND reference_id = (SELECT position_id FROM positions WHERE epd = ?)
  `).run(normalizedEpd(chess))
  for (const uci of ['g1f3', 'g8f6', 'f3g1', 'f6g8']) {
    const fromEpd = normalizedEpd(chess)
    const fromId = ensurePosition(fromEpd)
    const move = chess.move(moveInput(uci))
    const toEpd = normalizedEpd(chess)
    const toId = ensurePosition(toEpd)
    const edgeId = (database.prepare('SELECT coalesce(max(edge_id), 0) + 1 AS id FROM edges').get() as { id: number }).id
    database.prepare('INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?)').run(
      edgeId,
      Buffer.from(evidenceFingerprint({ kind: 'edge', fromEpd, uci, toEpd }), 'hex'),
      fromId,
      uci,
      move.san,
      toId,
    )
    database.prepare('INSERT INTO outcomes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'edge', edgeId, cohortId, '2026-06', 'classical', '<1800', detail, 0, 600, 240, 120, 240,
    )
  }
  assert.equal(normalizedEpd(chess), normalizedEpd(rootPosition(line)))
}

function verifiedFixture(broadcast: DatabaseSync, standard: DatabaseSync): VerifiedCompactExactFamilyGraphHandoff {
  return {
    handoff: {
      schemaVersion: 1,
      kind: 'linerecall-compact-v3-exact-family-graph-handoff',
      releaseId: RELEASE,
      storageModel: 'bounded-two-pass-content-addressed-v3',
      corpora: [],
    },
    handoffReceipt: { path: 'handoff.json', sha256: HASH, bytes: 1, uncompressedBytes: 1, encoding: 'identity' },
    states: [
      { sourceId: 'lichess-broadcasts', database: broadcast },
      { sourceId: 'lichess-standard-rated-q2-2026', database: standard },
    ],
    closeAndVerify: async () => undefined,
  } as unknown as VerifiedCompactExactFamilyGraphHandoff
}

function baseSpec(line: LineDefinition) {
  const root = rootPosition(line)
  return {
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-family-pack-build-spec',
    releaseId: RELEASE,
    familyId: line.familyId,
    canonicalName: line.canonicalName,
    packId: line.packId,
    side: line.side,
    rootEpd: normalizedEpd(root),
    rootPly: line.rootMoves.length,
    ecoCodes: line.ecoCodes,
    selectionCohortId: 'cohort_broadcast-classical',
    cohorts: [
      {
        cohortId: 'cohort_broadcast-classical', exactSourceId: 'lichess-broadcasts', source: 'broadcast',
        ratingSystem: 'broadcast-rating', timeControl: 'classical', cutoff: '2026-06-30',
      },
      {
        cohortId: 'cohort_lichess-standard-classical', exactSourceId: 'lichess-standard-rated-q2-2026',
        source: 'lichess-standard', ratingSystem: 'lichess-glicko2', timeControl: 'classical', cutoff: '2026-06-30',
      },
    ],
    provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    provenanceDocument: { path: 'provenance.json', sha256: HASH, bytes: 1, uncompressedBytes: 1, encoding: 'identity' },
    branchRules: [{ id: `${line.familyId}-main`, canonicalName: line.canonicalName, movePrefix: [line.moves[0]!] }],
    limits: { maximumNodes: 100, maximumEdges: 200, maximumPaths: 100 },
  }
}

function engineCheck(from: Chess, uci: string) {
  const next = new Chess(from.fen())
  next.move(moveInput(uci))
  return {
    engineName: 'Stockfish 18' as const,
    engineSha256: 'f'.repeat(64),
    nnueSha256: ['e'.repeat(64)],
    settings: { threads: 1 as const, hashMb: 128 as const, multiPv: 5 as const, nodes: 250_000 as const },
    analyzedAt: '2026-07-01T00:00:00.000Z',
    analyzedMoveUci: uci,
    bestMoveUci: uci,
    bestEvaluation: { kind: 'centipawn' as const, value: 20, unit: 'centipawn' as const, perspective: 'trained-side' as const },
    moveEvaluation: { kind: 'centipawn' as const, value: 20, unit: 'centipawn' as const, perspective: 'trained-side' as const },
    centipawnLoss: 0,
    forcedMateAgainstLearner: false,
    bestPrincipalVariationUci: [uci],
    movePrincipalVariationUci: [uci],
  }
}

async function identityJson(root: string, path: string, value: unknown) {
  const content = `${JSON.stringify(value, null, 2)}\n`
  const bytes = Buffer.from(content)
  await mkdir(join(root, path.slice(0, path.lastIndexOf('/'))), { recursive: true })
  await writeFile(join(root, path), bytes)
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    uncompressedBytes: bytes.byteLength,
    encoding: 'identity' as const,
  }
}

async function finalSpecFor(
  root: string,
  line: LineDefinition,
  verified: VerifiedCompactExactFamilyGraphHandoff,
  checkFor: (from: Chess, uci: string) => ReturnType<typeof engineCheck> = engineCheck,
) {
  const unsigned = FamilyGraphPackBuildSpecV1Schema.parse(baseSpec(line))
  const candidates = buildFamilyEngineCandidatePackFromVerifiedExactStates({ verified, specValue: unsigned })
  const candidateReceipt = await identityJson(root, 'receipts/engine-candidates.json', candidates)
  const proofs = candidates.learnerNodes.flatMap(({ epd, candidateEdges }) => candidateEdges.map(({ uci, toEpd }) => ({
    fromEpd: epd,
    uci,
    toEpd,
    check: checkFor(new Chess(`${epd} 0 1`), uci),
  })))
  const proofValue = FamilyGraphEngineProofSetV1Schema.parse({
    schemaVersion: 1,
    kind: 'linerecall-stockfish-18-family-edge-proofs',
    releaseId: RELEASE,
    familyId: line.familyId,
    packId: line.packId,
    provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    candidatePackSha256: candidateReceipt.sha256,
    empiricalInventorySha256: candidates.empiricalInventorySha256,
    proofs,
  })
  const proofReceipt = await identityJson(root, 'receipts/engine.json', proofValue)
  const nested = []
  for (const [kind, path] of [
    ['taxonomy', 'receipts/taxonomy.json'],
    ['broadcast-corpus', 'receipts/broadcast.json'],
    ['lichess-standard-corpus', 'receipts/standard.json'],
    ['scid', 'receipts/scid.json'],
  ] as const) {
    const receipt = await identityJson(root, path, { synthetic: true, kind })
    nested.push({ kind, path: receipt.path, sha256: receipt.sha256, bytes: receipt.bytes })
  }
  nested.push({ kind: 'engine' as const, path: proofReceipt.path, sha256: proofReceipt.sha256, bytes: proofReceipt.bytes })
  const provenance = createSyntheticFamilyGraphProvenanceDocument({
    releaseId: RELEASE,
    familyId: line.familyId,
    receipts: nested,
  })
  const provenanceReceipt = await identityJson(root, 'receipts/provenance.json', provenance)
  return FamilyGraphPackBuildSpecV1Schema.parse({
    ...unsigned,
    provenanceDocument: provenanceReceipt,
    engineCandidatePack: candidateReceipt,
    engineProofSet: proofReceipt,
  })
}

test('pre-engine traversal produces distinct Caro-Kann, Sicilian, and Ruy learner candidate packs', () => {
  const broadcast = setupEvidenceDatabase(':memory:', 'broadcast')
  const standard = setupEvidenceDatabase(':memory:', 'standard')
  try {
    const verified = verifiedFixture(broadcast, standard)
    const packs = LINES.map((line) => buildFamilyEngineCandidatePackFromVerifiedExactStates({
      verified,
      specValue: FamilyGraphPackBuildSpecV1Schema.parse(baseSpec(line)),
    }))
    assert.deepEqual(packs.map(({ familyId }) => familyId), ['caro-kann', 'sicilian-defence', 'ruy-lopez'])
    assert.ok(packs.every(({ learnerNodes }) => learnerNodes.length >= 1))
    assert.ok(packs.every(({ empiricalInventorySha256 }) => /^[a-f0-9]{64}$/u.test(empiricalInventorySha256)))
    assert.equal(packs[0]!.learnerNodes.some(({ candidateEdges }) => candidateEdges.some(({ uci }) => uci === 'c8g4')), false)
  } finally {
    broadcast.close()
    standard.close()
  }
})

test('final graph keeps empirical opponent edges, exact learner proofs, exploratory edges, and inventory equality', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-family-graph-'))
  const broadcast = setupEvidenceDatabase(':memory:', 'broadcast')
  const standard = setupEvidenceDatabase(':memory:', 'standard')
  try {
    const line = LINES[0]!
    const verified = verifiedFixture(broadcast, standard)
    const spec = await finalSpecFor(root, line, verified)
    const result = await buildFamilyGraphFromVerifiedExactStates({
      receiptRoot: root,
      verified,
      specValue: spec,
    })
    assert.equal(result.graph.edges.filter(({ eligibleForDrill }) => eligibleForDrill).length, line.moves.length)
    assert.equal(result.inventory.eligibleEdgeIds.length, line.moves.length)
    assert.equal(result.graph.edges.some(({ role, uci }) => role === 'exploratory' && uci === 'c8g4'), true)
    const nodes = new Map(result.graph.nodes.map((node) => [node.id, node]))
    for (const edge of result.graph.edges.filter(({ eligibleForDrill }) => eligibleForDrill)) {
      const learnerTurn = nodes.get(edge.fromNodeId)!.learnerTurn
      assert.equal(edge.evidence.engine.status, learnerTurn ? 'verified' : 'unverified')
    }
    await validateRepertoireGraphDocument(result.graph)
  } finally {
    broadcast.close()
    standard.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('51-99cp learner edges remain visible as blocked inaccuracies and pruned descendants do not invalidate proofs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-family-inaccuracy-'))
  const broadcast = setupEvidenceDatabase(':memory:', 'broadcast')
  const standard = setupEvidenceDatabase(':memory:', 'standard')
  try {
    const line = LINES[0]!
    const verified = verifiedFixture(broadcast, standard)
    const spec = await finalSpecFor(root, line, verified, (from, uci) => {
      const check = engineCheck(from, uci)
      if (uci !== 'd7d5') return check
      return {
        ...check,
        bestMoveUci: 'g8f6',
        bestEvaluation: { ...check.bestEvaluation, value: 95 },
        moveEvaluation: { ...check.moveEvaluation, value: 20 },
        centipawnLoss: 75,
        bestPrincipalVariationUci: ['g8f6'],
      }
    })
    const result = await buildFamilyGraphFromVerifiedExactStates({
      receiptRoot: root,
      verified,
      specValue: spec,
    })
    const inaccuracy = result.graph.edges.find(({ uci }) => uci === 'd7d5')
    assert.equal(inaccuracy?.role, 'inaccuracy')
    assert.equal(inaccuracy?.eligibleForDrill, false)
    assert.equal(inaccuracy?.evidence.engine.centipawnLoss, 75)
    assert.equal(result.graph.edges.some(({ uci }) => uci === 'c8f5'), false,
      'a sound proof below the blocked edge stays in the campaign but is not emitted as reachable graph content')
    await validateRepertoireGraphDocument(result.graph)
  } finally {
    broadcast.close()
    standard.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('learner edges without exact proofs fail while empirical opponent edges remain valid', async () => {
  const graph = await createSyntheticCaroKannGraph()
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const learnerEdge = graph.edges.find((edge) => nodes.get(edge.fromNodeId)?.learnerTurn)!
  learnerEdge.evidence = createSyntheticRepertoireEvidence({
    uci: learnerEdge.uci,
    trainedSide: graph.pack.side,
    status: 'unverified',
  })
  await assert.rejects(validateRepertoireGraphDocument(graph), /Learner edge .* lacks its exact sound Stockfish verification/u)

  const opponentGraph = await createSyntheticCaroKannGraph()
  const opponentNodes = new Map(opponentGraph.nodes.map((node) => [node.id, node]))
  const opponentEdge = opponentGraph.edges.find((edge) => !opponentNodes.get(edge.fromNodeId)?.learnerTurn)!
  opponentEdge.evidence = createSyntheticRepertoireEvidence({
    uci: opponentEdge.uci,
    trainedSide: opponentGraph.pack.side,
    status: 'unverified',
  })
  await validateRepertoireGraphDocument(opponentGraph)
})

test('handoff schema rejects duplicate corpus ownership and resource aliases', () => {
  const resource = { path: 'receipts/source.json', sha256: HASH, bytes: 1, uncompressedBytes: 1, encoding: 'identity' as const }
  const corpus = {
    sourceId: 'lichess-broadcasts' as const,
    sourceManifest: resource,
    configurationSha256: HASH,
    checkpoints: [{ ...resource, path: 'receipts/checkpoint.json' }],
    finalExactState: { path: 'states/final.sqlite', sha256: HASH, bytes: 1 },
  }
  assert.throws(() => CompactExactFamilyGraphHandoffV1Schema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-exact-family-graph-handoff',
    releaseId: RELEASE,
    storageModel: 'bounded-two-pass-content-addressed-v3',
    corpora: [corpus, corpus],
  }), /unique|Missing required/u)
})

test('builder fails closed on exact EPD cycles rather than truncating a path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-family-cycle-'))
  const broadcast = setupEvidenceDatabase(':memory:', 'broadcast')
  const standard = setupEvidenceDatabase(':memory:', 'standard')
  try {
    appendCaroKnightCycle(broadcast, 'broadcast')
    appendCaroKnightCycle(standard, 'standard')
    const verified = verifiedFixture(broadcast, standard)
    const spec = await finalSpecFor(root, LINES[0]!, verified)
    await assert.rejects(
      buildFamilyGraphFromVerifiedExactStates({ receiptRoot: root, verified, specValue: spec }),
      /cycle/u,
    )
  } finally {
    broadcast.close()
    standard.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('corrupt source identities and missing provenance bindings never produce candidates', async () => {
  const broadcast = setupEvidenceDatabase(':memory:', 'broadcast')
  const standard = setupEvidenceDatabase(':memory:', 'standard')
  const verified = verifiedFixture(broadcast, standard)
  const line = LINES[0]!
  const rootEpd = normalizedEpd(rootPosition(line))
  broadcast.prepare(`
    UPDATE edges SET fingerprint = zeroblob(32)
    WHERE from_position_id = (SELECT position_id FROM positions WHERE epd = ?) AND uci = 'd2d4'
  `).run(rootEpd)
  try {
    assert.throws(
      () => buildFamilyEngineCandidatePackFromVerifiedExactStates({ verified, specValue: baseSpec(line) }),
      /fingerprint differs/u,
    )
  } finally {
    broadcast.close()
    standard.close()
  }

  const receiptRoot = await mkdtemp(join(tmpdir(), 'linerecall-family-provenance-'))
  const cleanBroadcast = setupEvidenceDatabase(':memory:', 'broadcast')
  const cleanStandard = setupEvidenceDatabase(':memory:', 'standard')
  try {
    const cleanVerified = verifiedFixture(cleanBroadcast, cleanStandard)
    const spec = await finalSpecFor(receiptRoot, line, cleanVerified)
    await assert.rejects(
      buildFamilyGraphFromVerifiedExactStates({
        receiptRoot,
        verified: cleanVerified,
        specValue: { ...spec, provenanceRef: 'missing-provenance-binding' },
      }),
      /no immutable binding/u,
    )
  } finally {
    cleanBroadcast.close()
    cleanStandard.close()
    await rm(receiptRoot, { recursive: true, force: true })
  }
})

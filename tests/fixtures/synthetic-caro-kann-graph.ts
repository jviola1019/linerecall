import { Chess, type Move } from 'chess.js'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import {
  REPERTOIRE_SCHEMA_VERSION,
  stableRepertoireCardId,
  stableRepertoireEdgeId,
  stableRepertoirePathId,
  stableRepertoirePositionId,
  type RepertoireEdge,
  type RepertoireGraphDocument,
  type RepertoireNode,
  type RepertoirePath,
} from '../../src/domain/repertoire.ts'
import {
  SYNTHETIC_GRAPH_PROVENANCE_REF,
  createSyntheticRepertoireEvidence,
} from './synthetic-repertoire-evidence.ts'

interface FixtureLine {
  family: string
  moves: string[]
  usage: number
}

function moveInput(uci: string): { from: string; to: string; promotion?: string } {
  return uci[4] === undefined
    ? { from: uci.slice(0, 2), to: uci.slice(2, 4) }
    : { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }
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
    if (!selected) throw new Error('Could not extend synthetic Caro-Kann fixture')
    chess.move(selected.move)
    moves.push(selected.uci)
    seen.add(normalizedEpd(chess))
  }
  return moves
}

export async function createSyntheticCaroKannGraph(
  releaseId = 'synthetic-handoff-release-not-for-shipping',
): Promise<RepertoireGraphDocument> {
  const packId = 'caro_kann_black'
  const root = new Chess()
  root.move('e4')
  root.move('c6')
  const seeds: FixtureLine[] = [
    { family: 'Advance', moves: ['d2d4', 'd7d5', 'e4e5', 'c8f5'], usage: 0.24 },
    { family: 'Advance', moves: ['d2d4', 'd7d5', 'e4e5', 'c8f5', 'h2h4'], usage: 0.08 },
    { family: 'Exchange', moves: ['d2d4', 'd7d5', 'e4d5', 'c6d5'], usage: 0.18 },
    { family: 'Panov', moves: ['d2d4', 'd7d5', 'e4d5', 'c6d5', 'c2c4'], usage: 0.14 },
    { family: 'Classical', moves: ['d2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4'], usage: 0.14 },
    { family: 'Two Knights', moves: ['b1c3', 'd7d5', 'g1f3'], usage: 0.10 },
    { family: 'Fantasy', moves: ['d2d4', 'd7d5', 'f2f3'], usage: 0.07 },
    { family: 'Gurgenidze', moves: ['d2d4', 'd7d5', 'b1c3', 'g7g6'], usage: 0.05 },
  ].map((line) => ({ ...line, moves: extendWithoutRepeating(root, line.moves, 20) }))
  const rootEpd = normalizedEpd(root)
  const rawEdges = new Map<string, { fromEpd: string; toEpd: string; uci: string; san: string }>()
  const rawPaths: Array<FixtureLine & { nodeEpds: string[]; edgeKeys: string[] }> = []
  const epds = new Set<string>([rootEpd])
  for (const line of seeds) {
    const chess = new Chess(root.fen())
    const nodeEpds = [rootEpd]
    const edgeKeys: string[] = []
    for (const uci of line.moves) {
      const fromEpd = normalizedEpd(chess)
      const move = chess.move(moveInput(uci))
      const toEpd = normalizedEpd(chess)
      const key = `${fromEpd}\0${uci}`
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
    const values = outgoing.get(fromNodeId) ?? []
    values.push(id)
    outgoing.set(fromNodeId, values)
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
      evidence: createSyntheticRepertoireEvidence({ uci: edge.uci, trainedSide: 'black' }),
      provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    }
  })
  const nodes: RepertoireNode[] = [...epds].map((epd) => {
    const id = positionIds.get(epd)!
    const learnerTurn = epd.split(' ')[1] === 'b'
    return {
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id,
      epd,
      learnerTurn,
      outgoingEdgeIds: [...(outgoing.get(id) ?? [])].sort(),
      ...(learnerTurn ? { cardId: stableRepertoireCardId(packId, id) } : {}),
      provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    }
  })
  const paths: RepertoirePath[] = []
  for (const raw of rawPaths) {
    const pathEdgeIds = raw.edgeKeys.map((key) => edgeIds.get(key)!)
    paths.push({
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id: await stableRepertoirePathId(packId, pathEdgeIds),
      packId,
      nodeIds: raw.nodeEpds.map((epd) => positionIds.get(epd)!),
      edgeIds: pathEdgeIds,
      learnerDecisionCount: raw.nodeEpds.slice(0, -1).filter((epd) => epd.split(' ')[1] === 'b').length,
      terminalPly: 2 + pathEdgeIds.length,
      terminalStatus: 'evidence_terminal',
      familyTags: [raw.family],
      conditionalUsage: raw.usage,
      provenanceRef: SYNTHETIC_GRAPH_PROVENANCE_REF,
    })
  }
  let opponentBranchesAfterRoot = 0
  for (const node of nodes) {
    if (node.id === positionIds.get(rootEpd) || node.learnerTurn) continue
    opponentBranchesAfterRoot = Math.max(opponentBranchesAfterRoot, node.outgoingEdgeIds.length)
  }
  return {
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    releaseId,
    pack: {
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id: packId,
      side: 'black',
      rootNodeId: positionIds.get(rootEpd)!,
      rootPly: 2,
      tier: 'core',
      coreDepth: 10,
      opponentBranchCountAfterRoot: opponentBranchesAfterRoot,
      coverage: 0.9,
      ecoCodes: Array.from({ length: 10 }, (_, index) => `B${10 + index}`) as RepertoireGraphDocument['pack']['ecoCodes'],
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

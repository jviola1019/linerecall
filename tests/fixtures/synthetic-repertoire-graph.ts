import { Chess, type PieceSymbol, type Square } from 'chess.js'
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

interface FixtureLine {
  moves: string[]
  family: string
  usage: number
}

interface RawEdge {
  key: string
  fromEpd: string
  toEpd: string
  uci: string
  san: string
}

function moveParts(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

/** Synthetic legal graph only. No values in this fixture represent observed evidence. */
export async function createSyntheticTranspositionGraph(): Promise<RepertoireGraphDocument> {
  const packId = 'fixture_route_pack'
  const lines: FixtureLine[] = [
    { moves: ['g1f3', 'd7d5', 'g2g3', 'e7e6', 'f1g2'], family: 'Knight first', usage: 0.7 },
    { moves: ['g2g3', 'd7d5', 'g1f3', 'e7e6', 'f1g2'], family: 'Fianchetto first', usage: 0.3 },
  ]
  const root = new Chess()
  const rootEpd = normalizedEpd(root)
  const epds = new Set<string>([rootEpd])
  const rawEdges = new Map<string, RawEdge>()
  const rawPaths: Array<FixtureLine & { nodeEpds: string[]; edgeKeys: string[] }> = []

  for (const line of lines) {
    const chess = new Chess()
    const nodeEpds = [rootEpd]
    const edgeKeys: string[] = []
    for (const uci of line.moves) {
      const fromEpd = normalizedEpd(chess)
      const move = chess.move(moveParts(uci))
      const toEpd = normalizedEpd(chess)
      const key = `${fromEpd}\0${uci}`
      rawEdges.set(key, { key, fromEpd, toEpd, uci, san: move.san })
      epds.add(toEpd)
      nodeEpds.push(toEpd)
      edgeKeys.push(key)
    }
    rawPaths.push({ ...line, nodeEpds, edgeKeys })
  }

  const nodeIds = new Map(await Promise.all([...epds].map(async (epd) => [epd, await stableRepertoirePositionId(epd)] as const)))
  const edgeIds = new Map(await Promise.all([...rawEdges].map(async ([key, edge]) => [
    key,
    await stableRepertoireEdgeId(edge.fromEpd, edge.uci, edge.toEpd),
  ] as const)))
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()

  for (const edge of rawEdges.values()) {
    const edgeId = edgeIds.get(edge.key)!
    const fromNodeId = nodeIds.get(edge.fromEpd)!
    const toNodeId = nodeIds.get(edge.toEpd)!
    outgoing.set(fromNodeId, [...(outgoing.get(fromNodeId) ?? []), edgeId])
    incoming.set(toNodeId, [...(incoming.get(toNodeId) ?? []), edgeId])
  }

  const edges: RepertoireEdge[] = [...rawEdges.values()].map((edge) => {
    const toNodeId = nodeIds.get(edge.toEpd)!
    const hasKnownContinuation = (outgoing.get(toNodeId)?.length ?? 0) > 0
    return {
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id: edgeIds.get(edge.key)!,
      fromNodeId: nodeIds.get(edge.fromEpd)!,
      toNodeId,
      uci: edge.uci,
      san: edge.san,
      role: 'book',
      eligibleForDrill: true,
      acceptedBookTransposition: (incoming.get(toNodeId)?.length ?? 0) > 1 && hasKnownContinuation,
      evidence: {
        cohorts: [{ cohortId: 'cohort_synthetic-fixture-only', n: 500 }],
        conditionalUsage: edge.uci === 'g1f3' ? 0.7 : 0.3,
        engine: {
          status: 'verified',
          centipawnLoss: 0,
          forcedMateAgainstLearner: false,
          quarantineReasons: [],
        },
      },
      provenanceRef: 'synthetic-fixture-not-production-evidence',
    }
  })
  const nodes: RepertoireNode[] = [...epds].map((epd) => {
    const id = nodeIds.get(epd)!
    const learnerTurn = epd.split(' ')[1] === 'w'
    return {
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id,
      epd,
      learnerTurn,
      outgoingEdgeIds: [...(outgoing.get(id) ?? [])].sort((left, right) => left.localeCompare(right, 'en')),
      ...(learnerTurn ? { cardId: stableRepertoireCardId(packId, id) } : {}),
    }
  })
  const paths: RepertoirePath[] = []
  for (const rawPath of rawPaths) {
    const pathEdgeIds = rawPath.edgeKeys.map((key) => edgeIds.get(key)!)
    paths.push({
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id: await stableRepertoirePathId(packId, pathEdgeIds),
      packId,
      nodeIds: rawPath.nodeEpds.map((epd) => nodeIds.get(epd)!),
      edgeIds: pathEdgeIds,
      learnerDecisionCount: 3,
      terminalPly: 5,
      terminalStatus: 'evidence_terminal',
      familyTags: [rawPath.family],
      conditionalUsage: rawPath.usage,
    })
  }

  return {
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    releaseId: 'synthetic-fixture-release-not-for-shipping',
    pack: {
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id: packId,
      side: 'white',
      rootNodeId: nodeIds.get(rootEpd)!,
      rootPly: 0,
      tier: 'primer',
      coreDepth: 3,
      opponentBranchCountAfterRoot: 1,
      coverage: 1,
      ecoCodes: ['A00'],
      nodeIds: nodes.map(({ id }) => id),
      edgeIds: edges.map(({ id }) => id),
      pathIds: paths.map(({ id }) => id),
      provenanceRef: 'synthetic-fixture-not-production-evidence',
    },
    nodes,
    edges,
    paths,
  }
}

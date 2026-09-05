import { Chess, type PieceSymbol, type Square } from 'chess.js'
import type { MoveEvidence, PositionNode, VerifiedLine } from './opening-data.ts'
import { normalizedEpd } from './input-validation.ts'

export interface PositionGraphEdge {
  lineId: string
  sourceLineId: string
  ply: number | null
  beforeEpd: string
  moveUci: string
  afterEpd: string | null
}

export interface PositionGraph {
  edgesByPosition: ReadonlyMap<string, readonly PositionGraphEdge[]>
  edgesByPositionMove: ReadonlyMap<string, readonly PositionGraphEdge[]>
}

export type DeviationReason =
  | 'exact_book'
  | 'accepted_book_transposition'
  | 'playable_alternative'
  | 'engine_inaccuracy'
  | 'engine_mistake'
  | 'known_line_unverified'
  | 'unsupported_unverified'
  | 'illegal_move'

export interface DeviationFeedback {
  legal: boolean
  selectedLineId: string
  playedMoveUci: string
  playedMoveSan: string | null
  expectedMoveUci: string
  classification: MoveEvidence['classification'] | 'illegal'
  reason: DeviationReason
  evidence: MoveEvidence | null
  expectedEvidence: MoveEvidence
  resultingEpd: string | null
  knownLineIds: string[]
  selectedLineResumePly: number | null
  selectedLineResumeNodeId: string | null
}

function moveParts(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

function key(epd: string, uci: string): string {
  return `${epd}\0${uci}`
}

export function buildPositionGraph(
  lines: readonly Pick<VerifiedLine, 'id' | 'sourceLineId' | 'uci'>[],
): PositionGraph {
  const byPosition = new Map<string, PositionGraphEdge[]>()
  const byPositionMove = new Map<string, PositionGraphEdge[]>()
  for (const line of lines) {
    const chess = new Chess()
    for (const [ply, moveUci] of line.uci.entries()) {
      const beforeEpd = normalizedEpd(chess)
      try {
        chess.move(moveParts(moveUci))
      } catch {
        throw new Error(`Line ${line.id} contains illegal move ${moveUci} at ply ${ply}`)
      }
      const edge: PositionGraphEdge = {
        lineId: line.id,
        sourceLineId: line.sourceLineId,
        ply,
        beforeEpd,
        moveUci,
        afterEpd: normalizedEpd(chess),
      }
      const positionEdges = byPosition.get(beforeEpd) ?? []
      positionEdges.push(edge)
      byPosition.set(beforeEpd, positionEdges)
      const moveEdges = byPositionMove.get(key(beforeEpd, moveUci)) ?? []
      moveEdges.push(edge)
      byPositionMove.set(key(beforeEpd, moveUci), moveEdges)
    }
  }
  const sortEdges = (edges: PositionGraphEdge[]): void => {
    edges.sort((left, right) =>
      left.lineId.localeCompare(right.lineId, 'en') || (left.ply ?? Number.MAX_SAFE_INTEGER) - (right.ply ?? Number.MAX_SAFE_INTEGER)
    )
  }
  for (const edges of byPosition.values()) sortEdges(edges)
  for (const edges of byPositionMove.values()) sortEdges(edges)
  return { edgesByPosition: byPosition, edgesByPositionMove: byPositionMove }
}

function reasonFor(
  evidence: MoveEvidence | undefined,
  knownElsewhere: boolean,
  exactExpected: boolean,
  acceptedBookTransposition: boolean,
): DeviationReason {
  if (exactExpected) return 'exact_book'
  if (acceptedBookTransposition) return 'accepted_book_transposition'
  // A stored `book` flag is descriptive data, not sufficient proof that a
  // deviation reaches this repertoire's graph. Fail closed unless exact EPD
  // replay and a known continuation established the transposition above.
  if (!evidence || evidence.classification === 'book') {
    return knownElsewhere ? 'known_line_unverified' : 'unsupported_unverified'
  }
  if (evidence.classification === 'playable') return 'playable_alternative'
  if (evidence.classification === 'inaccuracy') return 'engine_inaccuracy'
  if (evidence.classification === 'mistake') return 'engine_mistake'
  return knownElsewhere ? 'known_line_unverified' : 'unsupported_unverified'
}

export function evaluateMove(options: {
  selectedLine: Pick<VerifiedLine, 'id' | 'sourceLineId' | 'nodes'>
  node: PositionNode
  playedMoveUci: string
  graph: PositionGraph
}): DeviationFeedback {
  const { selectedLine, node, playedMoveUci, graph } = options
  const expectedEvidence = node.moves.find((move) => move.uci === node.expectedMoveUci)
  if (!expectedEvidence) throw new Error(`Node ${node.id} has no expected-move evidence`)
  const chess = new Chess(node.fen)
  let playedSan: string
  try {
    const move = chess.move(moveParts(playedMoveUci))
    if (!move) throw new Error('move returned null')
    playedSan = move.san
  } catch {
    return {
      legal: false,
      selectedLineId: selectedLine.id,
      playedMoveUci,
      playedMoveSan: null,
      expectedMoveUci: node.expectedMoveUci,
      classification: 'illegal',
      reason: 'illegal_move',
      evidence: null,
      expectedEvidence,
      resultingEpd: null,
      knownLineIds: [],
      selectedLineResumePly: null,
      selectedLineResumeNodeId: null,
    }
  }
  const resultingEpd = normalizedEpd(chess)
  const evidence = node.moves.find((move) => move.uci === playedMoveUci)
  const beforeEpd = normalizedEpd(new Chess(node.fen))
  const knownEdges = node.epd === beforeEpd
    ? graph.edgesByPositionMove.get(key(beforeEpd, playedMoveUci)) ?? []
    : []
  const knownLineIds = [...new Set(knownEdges.map((edge) => edge.lineId))].sort((left, right) => left.localeCompare(right, 'en'))
  // Compact wire graphs index taxonomy/source IDs, while drill lines add a
  // trained-side suffix. Match the stable source identity across both graph
  // representations instead of comparing incompatible IDs.
  const selectedEdge = knownEdges.find((edge) =>
    edge.sourceLineId === selectedLine.sourceLineId
    && edge.afterEpd !== null
    && edge.afterEpd === resultingEpd
  )
  const resumeNode = selectedLine.nodes.find((candidate) => candidate.epd === resultingEpd)
  const selectedContinuation = (graph.edgesByPosition.get(resultingEpd) ?? []).find((edge) =>
    edge.sourceLineId === selectedLine.sourceLineId
    && edge.beforeEpd === resultingEpd
  )
  const exactExpected = playedMoveUci === node.expectedMoveUci
    && evidence === expectedEvidence
    && expectedEvidence.expected
    && expectedEvidence.classification === 'book'
  const acceptedBookTransposition = !exactExpected
    && evidence?.classification === 'book'
    && evidence.acceptedBookTransposition
    && selectedEdge !== undefined
    && resumeNode !== undefined
    && selectedContinuation !== undefined
  const isPlayable = evidence?.classification === 'playable'
  const playableContinuation = isPlayable
    && selectedEdge !== undefined
    && resumeNode !== undefined
    && selectedContinuation !== undefined
  const mayResumeSelected = exactExpected || acceptedBookTransposition || playableContinuation
  const classification: DeviationFeedback['classification'] = exactExpected || acceptedBookTransposition
    ? 'book'
    : evidence?.classification === 'book'
      ? 'unverified_deviation'
      : evidence?.classification ?? 'unverified_deviation'
  return {
    legal: true,
    selectedLineId: selectedLine.id,
    playedMoveUci,
    playedMoveSan: playedSan,
    expectedMoveUci: node.expectedMoveUci,
    classification,
    reason: reasonFor(evidence, knownEdges.length > 0, exactExpected, acceptedBookTransposition),
    evidence: evidence ?? null,
    expectedEvidence,
    resultingEpd,
    knownLineIds,
    selectedLineResumePly: mayResumeSelected && (selectedEdge || exactExpected)
      ? (selectedEdge?.ply ?? node.ply)
      : null,
    selectedLineResumeNodeId: mayResumeSelected
      ? (exactExpected ? (resumeNode?.id ?? node.nextNodeId) : (resumeNode?.id ?? null))
      : null,
  }
}

import { createHash } from 'node:crypto'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { normalizedEpd } from './broadcast-pgn.ts'
import {
  MINIMUM_DRILL_SAMPLE,
  MINIMUM_EXPLORATORY_SAMPLE,
  stableCardId,
} from './evidence-contracts.ts'
import { trinomialScoreProfileLikelihoodInterval } from '../../src/domain/statistics.ts'

export { trinomialScoreProfileLikelihoodInterval } from '../../src/domain/statistics.ts'

export type EvidenceMoveClassification =
  | 'book'
  | 'playable'
  | 'inaccuracy'
  | 'mistake'
  | 'unverified'

export interface EmpiricalMoveEvidence {
  uci: string
  san: string
  fromEpd: string
  toEpd: string
  n: number
  parentN: number
  whiteWins: number
  draws: number
  blackWins: number
  trainedSide: 'white' | 'black'
  engine: {
    verified: boolean
    centipawnLoss: number | null
    forcedMateAgainstTrainedSide: boolean
    exactScore: boolean
  } | null
  expected?: boolean
  acceptedBookTransposition?: boolean
  coverageAdjustedDepth: number
}

export interface TrainingValueSummary {
  soundnessTier: 1 | 2
  empiricalDepth: number
  coverage: number
  usage: number
  scoreLowerBound: number
}

export interface RankedLearnerMove {
  move: EmpiricalMoveEvidence
  classification: EvidenceMoveClassification
  value: TrainingValueSummary
}

export interface OpponentSelection {
  /** Coverage-priority branches shown first in a session. */
  selected: EmpiricalMoveEvidence[]
  /** Audited branches outside the initial coverage target; never discarded. */
  extended: EmpiricalMoveEvidence[]
  /** Every sampled branch eligible for audited practice. */
  allEligible: EmpiricalMoveEvidence[]
  coveredN: number
  coverage: number
  residualN: number
  thresholdMet: boolean
}

export interface PositionGraphEdgeInput {
  uci: string
  san: string
  fromEpd: string
  toEpd: string
}

export interface RepertoireGraphEdge extends PositionGraphEdgeInput {
  id: string
}

export interface RepertoireGraphNode {
  id: string
  epd: string
  outgoingEdgeIds: string[]
}

export interface RepertoireGraph {
  nodesByEpd: Map<string, RepertoireGraphNode>
  edgesById: Map<string, RepertoireGraphEdge>
  edgesByPositionMove: Map<string, RepertoireGraphEdge[]>
}

function moveInput(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(uci)) throw new Error(`Invalid UCI move: ${uci}`)
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
}

export function scoreConfidenceInterval(move: EmpiricalMoveEvidence): { low: number; high: number } | null {
  if (!Number.isSafeInteger(move.n) || move.n < 0) throw new Error('Move sample size must be a nonnegative safe integer')
  if (move.whiteWins + move.draws + move.blackWins !== move.n) {
    throw new Error('Move White/Draw/Black counts must sum to N')
  }
  const wins = move.trainedSide === 'white' ? move.whiteWins : move.blackWins
  const losses = move.trainedSide === 'white' ? move.blackWins : move.whiteWins
  return trinomialScoreProfileLikelihoodInterval(wins, move.draws, losses)
}

export function classifyEvidenceMove(move: EmpiricalMoveEvidence): EvidenceMoveClassification {
  const engine = move.engine
  if (!engine?.verified || !engine.exactScore || engine.centipawnLoss === null) return 'unverified'
  if (engine.forcedMateAgainstTrainedSide || engine.centipawnLoss >= 100) return 'mistake'
  if ((move.expected || move.acceptedBookTransposition) && move.n >= MINIMUM_DRILL_SAMPLE) return 'book'
  if (move.n < MINIMUM_EXPLORATORY_SAMPLE) return 'unverified'
  if (engine.centipawnLoss <= 50) return 'playable'
  if (engine.centipawnLoss <= 99) return 'inaccuracy'
  return 'mistake'
}

function trainingValue(move: EmpiricalMoveEvidence): TrainingValueSummary {
  const loss = move.engine?.centipawnLoss
  if (loss === null || loss === undefined || loss > 50) {
    throw new Error(`Move ${move.uci} is not a sound, verified learner candidate`)
  }
  return {
    soundnessTier: loss <= 20 ? 1 : 2,
    empiricalDepth: move.coverageAdjustedDepth,
    coverage: move.parentN === 0 ? 0 : move.n / move.parentN,
    usage: move.n,
    scoreLowerBound: scoreConfidenceInterval(move)?.low ?? 0,
  }
}

function validateRankableMoveInputs(moves: readonly EmpiricalMoveEvidence[]): void {
  const seenUci = new Set<string>()
  for (const move of moves) {
    moveInput(move.uci)
    if (seenUci.has(move.uci)) throw new Error(`Duplicate empirical move UCI ${move.uci}`)
    seenUci.add(move.uci)
    if (!Number.isSafeInteger(move.n) || move.n < 0) throw new Error(`Move ${move.uci} N must be a nonnegative safe integer`)
    if (!Number.isSafeInteger(move.parentN) || move.parentN < 0) throw new Error(`Move ${move.uci} parent N must be a nonnegative safe integer`)
    if (move.n > move.parentN) throw new Error(`Move ${move.uci} N cannot exceed its parent reach N`)
    if (!Number.isFinite(move.coverageAdjustedDepth)
      || !Number.isSafeInteger(move.coverageAdjustedDepth)
      || move.coverageAdjustedDepth < 0
      || move.coverageAdjustedDepth > 100) {
      throw new Error(`Move ${move.uci} coverage-adjusted depth must be an integer from 0 through 100`)
    }
  }
}

/**
 * Deterministic, transparent learner-edge rank. Historical score is the last
 * substantive tie-break and remains descriptive rather than causal.
 */
export function rankLearnerMoves(moves: readonly EmpiricalMoveEvidence[]): RankedLearnerMove[] {
  validateRankableMoveInputs(moves)
  return moves
    .filter((move) =>
      move.n >= MINIMUM_DRILL_SAMPLE &&
      move.engine?.verified === true &&
      move.engine.exactScore &&
      move.engine.centipawnLoss !== null &&
      move.engine.centipawnLoss <= 50 &&
      !move.engine.forcedMateAgainstTrainedSide,
    )
    .map((move) => ({ move, classification: classifyEvidenceMove(move), value: trainingValue(move) }))
    .sort((left, right) =>
      left.value.soundnessTier - right.value.soundnessTier ||
      right.value.empiricalDepth - left.value.empiricalDepth ||
      right.value.coverage - left.value.coverage ||
      right.value.usage - left.value.usage ||
      right.value.scoreLowerBound - left.value.scoreLowerBound ||
      left.move.uci.localeCompare(right.move.uci, 'en'),
    )
}

export function selectOpponentCoverage(
  moves: readonly EmpiricalMoveEvidence[],
  parentN: number,
  targetCoverage = 0.85,
): OpponentSelection {
  if (!Number.isSafeInteger(parentN) || parentN < 0) throw new Error('parentN must be a nonnegative integer')
  if (!(targetCoverage > 0 && targetCoverage <= 1)) throw new Error('targetCoverage must be in (0, 1]')
  validateRankableMoveInputs(moves)
  const eligible = moves
    .filter((move) => move.n >= MINIMUM_DRILL_SAMPLE)
    .sort((left, right) => right.n - left.n || left.uci.localeCompare(right.uci, 'en'))
  const eligibleN = eligible.reduce((sum, move) => sum + move.n, 0)
  if (!Number.isSafeInteger(eligibleN) || eligibleN > parentN) {
    throw new Error('Eligible opponent move counts cannot exceed the parent reach count')
  }
  const selected: EmpiricalMoveEvidence[] = []
  let coveredN = 0
  for (const move of eligible) {
    if (parentN > 0 && coveredN / parentN >= targetCoverage) break
    selected.push(move)
    coveredN += move.n
  }
  const selectedIds = new Set(selected.map(({ uci }) => uci))
  const extended = eligible.filter(({ uci }) => !selectedIds.has(uci))
  const boundedCovered = Math.min(parentN, coveredN)
  const coverage = parentN === 0 ? 0 : boundedCovered / parentN
  return {
    selected,
    extended,
    allEligible: eligible,
    coveredN: boundedCovered,
    coverage,
    residualN: Math.max(0, parentN - boundedCovered),
    thresholdMet: coverage >= targetCoverage,
  }
}

export function verifyGraphEdge(edge: PositionGraphEdgeInput): RepertoireGraphEdge {
  const chess = new Chess(`${edge.fromEpd} 0 1`)
  if (normalizedEpd(chess) !== edge.fromEpd) throw new Error(`Noncanonical source EPD: ${edge.fromEpd}`)
  const applied = chess.move(moveInput(edge.uci))
  if (!applied) throw new Error(`Illegal graph edge ${edge.uci} at ${edge.fromEpd}`)
  const actualToEpd = normalizedEpd(chess)
  if (actualToEpd !== edge.toEpd) {
    throw new Error(`Graph edge ${edge.uci} reaches ${actualToEpd}, not ${edge.toEpd}`)
  }
  if (applied.san !== edge.san) throw new Error(`Graph edge SAN mismatch for ${edge.uci}`)
  return {
    ...edge,
    id: `edge_${createHash('sha256').update(`${edge.fromEpd}\0${edge.uci}\0${edge.toEpd}`).digest('hex').slice(0, 20)}`,
  }
}

function graphMoveKey(epd: string, uci: string): string {
  return `${epd}\0${uci}`
}

export function buildRepertoireGraph(inputs: readonly PositionGraphEdgeInput[]): RepertoireGraph {
  const nodesByEpd = new Map<string, RepertoireGraphNode>()
  const edgesById = new Map<string, RepertoireGraphEdge>()
  const edgesByPositionMove = new Map<string, RepertoireGraphEdge[]>()
  const node = (epd: string): RepertoireGraphNode => {
    let existing = nodesByEpd.get(epd)
    if (!existing) {
      const canonical = normalizedEpd(new Chess(`${epd} 0 1`))
      if (canonical !== epd) throw new Error(`Noncanonical graph node EPD: ${epd}`)
      existing = {
        id: `node_${createHash('sha256').update(epd).digest('hex').slice(0, 20)}`,
        epd,
        outgoingEdgeIds: [],
      }
      nodesByEpd.set(epd, existing)
    }
    return existing
  }
  for (const input of inputs) {
    const edge = verifyGraphEdge(input)
    if (edgesById.has(edge.id)) throw new Error(`Duplicate graph edge ${edge.id}`)
    const from = node(edge.fromEpd)
    node(edge.toEpd)
    from.outgoingEdgeIds.push(edge.id)
    edgesById.set(edge.id, edge)
    const key = graphMoveKey(edge.fromEpd, edge.uci)
    const alternatives = edgesByPositionMove.get(key) ?? []
    alternatives.push(edge)
    edgesByPositionMove.set(key, alternatives)
  }
  for (const graphNode of nodesByEpd.values()) graphNode.outgoingEdgeIds.sort()
  for (const edges of edgesByPositionMove.values()) {
    edges.sort((left, right) => left.toEpd.localeCompare(right.toEpd, 'en'))
  }
  return { nodesByEpd, edgesById, edgesByPositionMove }
}

/** A transposition is proven only by the exact legal resulting EPD. */
export function isProvenTransposition(
  graph: RepertoireGraph,
  fromEpd: string,
  uci: string,
  expectedResultEpd: string,
): boolean {
  return (graph.edgesByPositionMove.get(graphMoveKey(fromEpd, uci)) ?? [])
    .some((edge) => edge.toEpd === expectedResultEpd && graph.nodesByEpd.has(edge.toEpd))
}

export function repertoireDepthTier(learnerDecisions: number, opponentBranchesAfterRoot: number): 'core' | 'primer' {
  if (!Number.isSafeInteger(learnerDecisions) || learnerDecisions < 0) {
    throw new Error('learnerDecisions must be a nonnegative integer')
  }
  if (!Number.isSafeInteger(opponentBranchesAfterRoot) || opponentBranchesAfterRoot < 0) {
    throw new Error('opponentBranchesAfterRoot must be a nonnegative integer')
  }
  return learnerDecisions >= 6 && opponentBranchesAfterRoot >= 2 ? 'core' : 'primer'
}

export function cardIdentityForGraphNode(packId: string, epd: string): string {
  return stableCardId(packId, normalizedEpd(new Chess(`${epd} 0 1`)))
}

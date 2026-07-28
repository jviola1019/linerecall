import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { z } from 'zod'
import { EcoCodeSchema, EpdSchema, UciMoveSchema } from './opening-data.ts'
import { normalizedEpd } from './input-validation.ts'

export const REPERTOIRE_SCHEMA_VERSION = 1 as const
export const REPERTOIRE_MAX_PLY = 100 as const
export const CORE_MINIMUM_LEARNER_DECISIONS = 10 as const
export const CORE_MINIMUM_OPPONENT_BRANCHES = 2 as const
export const DEFAULT_PRIMARY_COVERAGE = 0.85 as const
// This is a corruption guard above the known legal-move maximum, not a branch
// selection limit. Every audited eligible move remains represented.
export const REPERTOIRE_MAX_POSITION_EDGES = 256 as const

const PackIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}$/u)
const PositionIdSchema = z.string().regex(/^pos_[a-f0-9]{16}$/u)
const EdgeIdSchema = z.string().regex(/^edge_[a-f0-9]{20}$/u)
const PathIdSchema = z.string().regex(/^path_[a-f0-9]{20}$/u)
const CohortIdSchema = z.string().regex(/^cohort_[a-z0-9-]{3,64}$/u)
const CardIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::pos_[a-f0-9]{16}$/u)

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

export const BookTerminalStatusSchema = z.enum([
  'evidence_terminal',
  'depth_capped',
  'insufficient_sample',
  'quarantined',
])

export const RepertoireBranchEvidenceSchema = z.object({
  cohorts: z.array(z.object({
    cohortId: CohortIdSchema,
    n: z.number().int().nonnegative(),
  }).strict()).min(1).max(64),
  conditionalUsage: z.number().min(0).max(1),
  engine: z.object({
    status: z.enum(['verified', 'unverified', 'quarantined']),
    centipawnLoss: z.number().int().nonnegative().nullable(),
    forcedMateAgainstLearner: z.boolean(),
    quarantineReasons: z.array(z.string().min(1).max(500)).max(32),
  }).strict(),
}).strict().superRefine((evidence, context) => {
  if (!unique(evidence.cohorts.map(({ cohortId }) => cohortId))) {
    context.addIssue({ code: 'custom', path: ['cohorts'], message: 'Cohort IDs must be unique' })
  }
  const { status, centipawnLoss, forcedMateAgainstLearner, quarantineReasons } = evidence.engine
  if (status === 'verified' && centipawnLoss === null) {
    context.addIssue({ code: 'custom', path: ['engine', 'centipawnLoss'], message: 'Verified evidence requires an exact centipawn loss' })
  }
  if (status === 'unverified' && centipawnLoss !== null) {
    context.addIssue({ code: 'custom', path: ['engine', 'centipawnLoss'], message: 'Unverified evidence cannot claim a centipawn loss' })
  }
  if (status === 'quarantined' && quarantineReasons.length === 0) {
    context.addIssue({ code: 'custom', path: ['engine', 'quarantineReasons'], message: 'Quarantined evidence requires a reason' })
  }
  if (status !== 'quarantined' && quarantineReasons.length > 0) {
    context.addIssue({ code: 'custom', path: ['engine', 'quarantineReasons'], message: 'Only quarantined evidence may carry quarantine reasons' })
  }
  if ((forcedMateAgainstLearner || (centipawnLoss ?? 0) >= 100) && status !== 'quarantined') {
    context.addIssue({ code: 'custom', path: ['engine', 'status'], message: 'Losing-mate and 100cp-loss evidence must be quarantined' })
  }
})

export const RepertoireNodeSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  id: PositionIdSchema,
  epd: EpdSchema,
  learnerTurn: z.boolean(),
  outgoingEdgeIds: z.array(EdgeIdSchema).max(REPERTOIRE_MAX_POSITION_EDGES),
  cardId: CardIdSchema.optional(),
}).strict().superRefine((node, context) => {
  if (!unique(node.outgoingEdgeIds)) {
    context.addIssue({ code: 'custom', path: ['outgoingEdgeIds'], message: 'Outgoing edge IDs must be unique' })
  }
})

export const RepertoireEdgeSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  id: EdgeIdSchema,
  fromNodeId: PositionIdSchema,
  toNodeId: PositionIdSchema,
  uci: UciMoveSchema,
  san: z.string().min(1).max(32),
  role: z.enum(['book', 'playable', 'exploratory']),
  eligibleForDrill: z.boolean(),
  acceptedBookTransposition: z.boolean(),
  evidence: RepertoireBranchEvidenceSchema,
  provenanceRef: z.string().min(1).max(160),
}).strict().superRefine((edge, context) => {
  const maximumCohortN = Math.max(...edge.evidence.cohorts.map(({ n }) => n))
  const engine = edge.evidence.engine
  const soundAndVerified = engine.status === 'verified'
    && engine.centipawnLoss !== null
    && engine.centipawnLoss <= 50
    && !engine.forcedMateAgainstLearner

  if (edge.eligibleForDrill && (edge.role !== 'book' || maximumCohortN < 500 || !soundAndVerified)) {
    context.addIssue({
      code: 'custom',
      path: ['eligibleForDrill'],
      message: 'Drill edges must be verified sound book moves with N>=500 in one cohort',
    })
  }
  if (edge.role === 'book' && !edge.eligibleForDrill && engine.status !== 'quarantined') {
    context.addIssue({
      code: 'custom',
      path: ['role'],
      message: 'A non-drillable book edge must be explicitly quarantined',
    })
  }
  if (edge.role === 'playable' && (
    edge.eligibleForDrill
    || maximumCohortN < 100
    || !soundAndVerified
  )) {
    context.addIssue({
      code: 'custom',
      path: ['role'],
      message: 'Playable edges require N>=100 and verified loss of at most 50cp, and are not book drills',
    })
  }
  if (edge.role === 'exploratory' && (
    edge.eligibleForDrill
    || maximumCohortN < 100
    || maximumCohortN >= 500
  )) {
    context.addIssue({
      code: 'custom',
      path: ['role'],
      message: 'Exploratory edges require 100<=N<500 and cannot be drilled',
    })
  }
  if (edge.acceptedBookTransposition && !edge.eligibleForDrill) {
    context.addIssue({
      code: 'custom',
      path: ['acceptedBookTransposition'],
      message: 'Only an audited drill edge can be an accepted book transposition',
    })
  }
})

export const RepertoirePathSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  id: PathIdSchema,
  packId: PackIdSchema,
  nodeIds: z.array(PositionIdSchema).min(2).max(REPERTOIRE_MAX_PLY + 1),
  edgeIds: z.array(EdgeIdSchema).min(1).max(REPERTOIRE_MAX_PLY),
  learnerDecisionCount: z.number().int().nonnegative().max(50),
  terminalPly: z.number().int().min(1).max(REPERTOIRE_MAX_PLY),
  terminalStatus: BookTerminalStatusSchema,
  familyTags: z.array(z.string().min(1).max(80)).min(1).max(32),
  conditionalUsage: z.number().min(0).max(1),
}).strict().superRefine((path, context) => {
  if (path.nodeIds.length !== path.edgeIds.length + 1) {
    context.addIssue({ code: 'custom', path: ['nodeIds'], message: 'A path must contain one more node than edge' })
  }
  if (!unique(path.nodeIds)) {
    context.addIssue({ code: 'custom', path: ['nodeIds'], message: 'A drill path cannot repeat a position' })
  }
  if (!unique(path.edgeIds)) {
    context.addIssue({ code: 'custom', path: ['edgeIds'], message: 'A drill path cannot repeat an edge' })
  }
  if (!unique(path.familyTags)) {
    context.addIssue({ code: 'custom', path: ['familyTags'], message: 'Family tags must be unique' })
  }
  if (path.terminalStatus === 'depth_capped' && path.terminalPly !== REPERTOIRE_MAX_PLY) {
    context.addIssue({ code: 'custom', path: ['terminalStatus'], message: 'A depth-capped path must end at ply 100' })
  }
})

export const RepertoirePackSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  id: PackIdSchema,
  side: z.enum(['white', 'black']),
  rootNodeId: PositionIdSchema,
  rootPly: z.number().int().nonnegative().max(REPERTOIRE_MAX_PLY - 1),
  tier: z.enum(['core', 'primer']),
  coreDepth: z.number().int().nonnegative().max(50),
  opponentBranchCountAfterRoot: z.number().int().nonnegative().max(REPERTOIRE_MAX_POSITION_EDGES),
  coverage: z.number().min(0).max(1),
  ecoCodes: z.array(EcoCodeSchema).min(1).max(500),
  nodeIds: z.array(PositionIdSchema).min(2).max(100_000),
  edgeIds: z.array(EdgeIdSchema).min(1).max(200_000),
  pathIds: z.array(PathIdSchema).min(1).max(100_000),
  provenanceRef: z.string().min(1).max(160),
}).strict().superRefine((pack, context) => {
  for (const [key, values] of [
    ['ecoCodes', pack.ecoCodes],
    ['nodeIds', pack.nodeIds],
    ['edgeIds', pack.edgeIds],
    ['pathIds', pack.pathIds],
  ] as const) {
    if (!unique(values)) context.addIssue({ code: 'custom', path: [key], message: `${key} must be unique` })
  }
})

export const RepertoireGraphDocumentSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  releaseId: z.string().min(1).max(160),
  pack: RepertoirePackSchema,
  nodes: z.array(RepertoireNodeSchema).min(2).max(100_000),
  edges: z.array(RepertoireEdgeSchema).min(1).max(200_000),
  paths: z.array(RepertoirePathSchema).min(1).max(100_000),
}).strict()

/**
 * Exact output of the reconciled source-evidence eligibility pass. Promotion
 * compares it with the emitted graph because graph validation alone cannot
 * detect an eligible source edge omitted before graph construction.
 */
export const EligibleSourceEdgeInventoryV1Schema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().min(1).max(160),
  packId: PackIdSchema,
  sourceReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  eligibleEdgeIds: z.array(EdgeIdSchema).min(1).max(200_000),
}).strict().superRefine((inventory, context) => {
  if (!unique(inventory.eligibleEdgeIds)) {
    context.addIssue({
      code: 'custom',
      path: ['eligibleEdgeIds'],
      message: 'Eligible source-edge IDs must be unique',
    })
  }
})

export const CoverageCycleStateSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  packId: PackIdSchema,
  ordinal: z.number().int().nonnegative(),
  remainingPathIds: z.array(PathIdSchema).max(100_000),
}).strict().superRefine((state, context) => {
  if (!unique(state.remainingPathIds)) {
    context.addIssue({ code: 'custom', path: ['remainingPathIds'], message: 'Remaining paths must be unique' })
  }
})

export const SessionPathSelectionSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  packId: PackIdSchema,
  dueCardIds: z.array(CardIdSchema).max(10_000),
  includedPathIds: z.array(PathIdSchema).min(1).max(1_000),
  warmupNodeIds: z.array(PositionIdSchema).max(100_000),
  coverageCycleId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::coverage:[0-9]+$/u),
}).strict().superRefine((selection, context) => {
  for (const [key, values] of [
    ['dueCardIds', selection.dueCardIds],
    ['includedPathIds', selection.includedPathIds],
    ['warmupNodeIds', selection.warmupNodeIds],
  ] as const) {
    if (!unique(values)) context.addIssue({ code: 'custom', path: [key], message: `${key} must be unique` })
  }
  if (selection.dueCardIds.some((cardId) => !cardId.startsWith(`${selection.packId}::`))) {
    context.addIssue({ code: 'custom', path: ['dueCardIds'], message: 'Due cards must belong to the selected pack' })
  }
})

export const TrainingValueSummarySchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  soundnessTier: z.union([z.literal(1), z.literal(2)]),
  empiricalDepth: z.number().int().nonnegative().max(REPERTOIRE_MAX_PLY),
  coverage: z.number().min(0).max(1),
  usage: z.number().int().nonnegative(),
  scoreLowerBound: z.number().min(0).max(1),
}).strict()

export type BookTerminalStatus = z.infer<typeof BookTerminalStatusSchema>
export type RepertoireBranchEvidence = z.infer<typeof RepertoireBranchEvidenceSchema>
export type RepertoireNode = z.infer<typeof RepertoireNodeSchema>
export type RepertoireEdge = z.infer<typeof RepertoireEdgeSchema>
export type RepertoirePath = z.infer<typeof RepertoirePathSchema>
export type RepertoirePack = z.infer<typeof RepertoirePackSchema>
export type RepertoireGraphDocument = z.infer<typeof RepertoireGraphDocumentSchema>
export type EligibleSourceEdgeInventoryV1 = z.infer<typeof EligibleSourceEdgeInventoryV1Schema>
export type CoverageCycleState = z.infer<typeof CoverageCycleStateSchema>
export type SessionPathSelection = z.infer<typeof SessionPathSelectionSchema>
export type TrainingValueSummary = z.infer<typeof TrainingValueSummarySchema>

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function stableRepertoirePositionId(epd: string): Promise<string> {
  const canonical = normalizedEpd(new Chess(`${epd} 0 1`))
  if (canonical !== epd) throw new Error(`Noncanonical repertoire EPD: ${epd}`)
  return `pos_${(await sha256Hex(epd)).slice(0, 16)}`
}

export async function stableRepertoireEdgeId(fromEpd: string, uci: string, toEpd: string): Promise<string> {
  UciMoveSchema.parse(uci)
  return `edge_${(await sha256Hex(`${fromEpd}\0${uci}\0${toEpd}`)).slice(0, 20)}`
}

export async function stableRepertoirePathId(packId: string, edgeIds: readonly string[]): Promise<string> {
  PackIdSchema.parse(packId)
  z.array(EdgeIdSchema).min(1).max(REPERTOIRE_MAX_PLY).parse(edgeIds)
  return `path_${(await sha256Hex(`${packId}\0${edgeIds.join('\0')}`)).slice(0, 20)}`
}

export function stableRepertoireCardId(packId: string, positionId: string): string {
  return CardIdSchema.parse(`${PackIdSchema.parse(packId)}::${PositionIdSchema.parse(positionId)}`)
}

function moveParts(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

export function classifyBookTerminalStatus(options: {
  terminalPly: number
  hasEligibleContinuation: boolean
  hasExploratoryContinuation: boolean
  hasQuarantinedContinuation: boolean
}): BookTerminalStatus {
  if (!Number.isSafeInteger(options.terminalPly) || options.terminalPly < 1 || options.terminalPly > REPERTOIRE_MAX_PLY) {
    throw new Error('terminalPly must be an integer from 1 through 100')
  }
  if (options.terminalPly === REPERTOIRE_MAX_PLY && options.hasEligibleContinuation) return 'depth_capped'
  if (options.hasEligibleContinuation) {
    throw new Error('A path ended while an audited book continuation remained')
  }
  if (options.hasQuarantinedContinuation) return 'quarantined'
  if (options.hasExploratoryContinuation) return 'insufficient_sample'
  return 'evidence_terminal'
}

export function classifyRepertoireTier(
  learnerDecisions: number,
  opponentBranchesAfterRoot: number,
): RepertoirePack['tier'] {
  if (!Number.isSafeInteger(learnerDecisions) || learnerDecisions < 0 || learnerDecisions > 50) {
    throw new Error('learnerDecisions must be an integer from 0 through 50')
  }
  if (
    !Number.isSafeInteger(opponentBranchesAfterRoot)
    || opponentBranchesAfterRoot < 0
    || opponentBranchesAfterRoot > REPERTOIRE_MAX_POSITION_EDGES
  ) {
    throw new Error(`opponentBranchesAfterRoot must be an integer from 0 through ${REPERTOIRE_MAX_POSITION_EDGES}`)
  }
  return learnerDecisions >= CORE_MINIMUM_LEARNER_DECISIONS
    && opponentBranchesAfterRoot >= CORE_MINIMUM_OPPONENT_BRANCHES
    ? 'core'
    : 'primer'
}

function cycleExists(rootNodeId: string, nodes: ReadonlyMap<string, RepertoireNode>, edges: ReadonlyMap<string, RepertoireEdge>): boolean {
  const active = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (active.has(nodeId)) return true
    if (visited.has(nodeId)) return false
    active.add(nodeId)
    const node = nodes.get(nodeId)
    for (const edgeId of node?.outgoingEdgeIds ?? []) {
      const edge = edges.get(edgeId)
      if (edge?.eligibleForDrill && visit(edge.toNodeId)) return true
    }
    active.delete(nodeId)
    visited.add(nodeId)
    return false
  }
  return visit(rootNodeId)
}

/**
 * Parses the public wire contract, then performs checks that require chess
 * replay or relationships across records. No caller should train from a graph
 * that has not passed this function.
 */
export async function validateRepertoireGraphDocument(input: unknown): Promise<RepertoireGraphDocument> {
  const graph = RepertoireGraphDocumentSchema.parse(input)
  const issues: string[] = []
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]))
  const paths = new Map(graph.paths.map((path) => [path.id, path]))
  if (nodes.size !== graph.nodes.length) issues.push('Node IDs must be unique')
  if (edges.size !== graph.edges.length) issues.push('Edge IDs must be unique')
  if (paths.size !== graph.paths.length) issues.push('Path IDs must be unique')

  if (!nodes.has(graph.pack.rootNodeId)) issues.push('Pack root node is missing')
  if (graph.pack.nodeIds.length !== graph.nodes.length || graph.pack.nodeIds.some((id) => !nodes.has(id))) {
    issues.push('Pack node index must contain every graph node exactly once')
  }
  if (graph.pack.edgeIds.length !== graph.edges.length || graph.pack.edgeIds.some((id) => !edges.has(id))) {
    issues.push('Pack edge index must contain every graph edge exactly once')
  }
  if (graph.pack.pathIds.length !== graph.paths.length || graph.pack.pathIds.some((id) => !paths.has(id))) {
    issues.push('Pack path index must contain every graph path exactly once')
  }

  await Promise.all(graph.nodes.map(async (node) => {
    try {
      const expectedId = await stableRepertoirePositionId(node.epd)
      if (node.id !== expectedId) issues.push(`Node ${node.id} does not match its stable EPD identity`)
      const turn = node.epd.split(' ')[1]
      const learnerTurn = turn === (graph.pack.side === 'white' ? 'w' : 'b')
      if (node.learnerTurn !== learnerTurn) issues.push(`Node ${node.id} has an incorrect learner-turn flag`)
      if (node.cardId !== undefined && node.cardId !== stableRepertoireCardId(graph.pack.id, node.id)) {
        issues.push(`Node ${node.id} has an incorrect stable card identity`)
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error))
    }
  }))

  await Promise.all(graph.edges.map(async (edge) => {
    const from = nodes.get(edge.fromNodeId)
    const to = nodes.get(edge.toNodeId)
    if (!from || !to) {
      issues.push(`Edge ${edge.id} references a missing node`)
      return
    }
    if (!from.outgoingEdgeIds.includes(edge.id)) issues.push(`Edge ${edge.id} is missing from its source node`)
    try {
      const expectedId = await stableRepertoireEdgeId(from.epd, edge.uci, to.epd)
      if (edge.id !== expectedId) issues.push(`Edge ${edge.id} does not match its stable move identity`)
      const chess = new Chess(`${from.epd} 0 1`)
      const move = chess.move(moveParts(edge.uci))
      if (move.san !== edge.san) issues.push(`Edge ${edge.id} SAN does not match legal replay`)
      if (normalizedEpd(chess) !== to.epd) issues.push(`Edge ${edge.id} does not reach its declared exact EPD`)
    } catch {
      issues.push(`Edge ${edge.id} is illegal from its declared source EPD`)
    }
  }))

  for (const node of graph.nodes) {
    for (const edgeId of node.outgoingEdgeIds) {
      const edge = edges.get(edgeId)
      if (!edge) issues.push(`Node ${node.id} references missing edge ${edgeId}`)
      else if (edge.fromNodeId !== node.id) issues.push(`Node ${node.id} references an edge owned by another position`)
    }
  }

  for (const path of graph.paths) {
    if (path.packId !== graph.pack.id) issues.push(`Path ${path.id} belongs to another pack`)
    try {
      const expectedId = await stableRepertoirePathId(path.packId, path.edgeIds)
      if (path.id !== expectedId) issues.push(`Path ${path.id} does not match its stable edge identity`)
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error))
    }
    if (path.nodeIds[0] !== graph.pack.rootNodeId) issues.push(`Path ${path.id} does not begin at the pack root`)
    let learnerDecisions = 0
    for (const [index, edgeId] of path.edgeIds.entries()) {
      const edge = edges.get(edgeId)
      const fromNodeId = path.nodeIds[index]
      const toNodeId = path.nodeIds[index + 1]
      if (!edge || edge.fromNodeId !== fromNodeId || edge.toNodeId !== toNodeId) {
        issues.push(`Path ${path.id} is not a contiguous graph walk at edge ${index}`)
        continue
      }
      if (!edge.eligibleForDrill) issues.push(`Path ${path.id} contains non-drillable edge ${edge.id}`)
      if (nodes.get(fromNodeId)?.learnerTurn) learnerDecisions += 1
    }
    if (learnerDecisions !== path.learnerDecisionCount) issues.push(`Path ${path.id} has an incorrect learner-decision count`)
    if (graph.pack.rootPly + path.edgeIds.length !== path.terminalPly) issues.push(`Path ${path.id} has an incorrect terminal ply`)
    const terminal = nodes.get(path.nodeIds.at(-1) ?? '')
    if (!terminal) issues.push(`Path ${path.id} has a missing terminal node`)
    else {
      const outgoing = terminal.outgoingEdgeIds.flatMap((id) => {
        const edge = edges.get(id)
        return edge ? [edge] : []
      })
      try {
        const expected = classifyBookTerminalStatus({
          terminalPly: path.terminalPly,
          hasEligibleContinuation: outgoing.some((edge) => edge.eligibleForDrill),
          hasExploratoryContinuation: outgoing.some((edge) => edge.role === 'exploratory'),
          hasQuarantinedContinuation: outgoing.some((edge) =>
            edge.role === 'book' && edge.evidence.engine.status === 'quarantined',
          ),
        })
        if (expected !== path.terminalStatus) issues.push(`Path ${path.id} has terminal status ${path.terminalStatus}; expected ${expected}`)
      } catch (error) {
        issues.push(`Path ${path.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  if (cycleExists(graph.pack.rootNodeId, nodes, edges)) issues.push('The drillable repertoire graph contains a cycle')

  const coveredEligibleEdges = new Set(graph.paths.flatMap((path) => path.edgeIds))
  const depthCappedTerminalNodes = new Set(
    graph.paths
      .filter(({ terminalStatus }) => terminalStatus === 'depth_capped')
      .flatMap((path) => path.nodeIds.at(-1) ?? []),
  )
  const selectableSourceNodes = new Set(
    graph.paths.flatMap((path) =>
      path.nodeIds.filter((_, index) => graph.pack.rootPly + index < REPERTOIRE_MAX_PLY),
    ),
  )
  for (const edge of graph.edges) {
    // The first qualifying continuation beyond ply 100 is retained as evidence
    // for the depth-capped label, but cannot itself become a selectable drill.
    if (
      edge.eligibleForDrill
      && !coveredEligibleEdges.has(edge.id)
      && !(depthCappedTerminalNodes.has(edge.fromNodeId) && !selectableSourceNodes.has(edge.fromNodeId))
    ) {
      issues.push(`Eligible edge ${edge.id} is hidden from every selectable path`)
    }
  }

  const incoming = new Map<string, RepertoireEdge[]>()
  for (const edge of graph.edges) {
    if (!edge.eligibleForDrill) continue
    const values = incoming.get(edge.toNodeId) ?? []
    values.push(edge)
    incoming.set(edge.toNodeId, values)
  }
  for (const edge of graph.edges.filter(({ acceptedBookTransposition }) => acceptedBookTransposition)) {
    const target = nodes.get(edge.toNodeId)
    const hasAnotherIncomingRoute = (incoming.get(edge.toNodeId) ?? []).some(({ id }) => id !== edge.id)
    const hasKnownContinuation = (target?.outgoingEdgeIds ?? []).some((id) => edges.get(id)?.eligibleForDrill)
    if (!hasAnotherIncomingRoute || !hasKnownContinuation) {
      issues.push(`Accepted transposition ${edge.id} requires another exact route and a known audited continuation`)
    }
  }

  const reachable = new Set<string>()
  const visit = (nodeId: string): void => {
    if (reachable.has(nodeId)) return
    reachable.add(nodeId)
    for (const edgeId of nodes.get(nodeId)?.outgoingEdgeIds ?? []) {
      const edge = edges.get(edgeId)
      if (edge?.eligibleForDrill) visit(edge.toNodeId)
    }
  }
  visit(graph.pack.rootNodeId)
  for (const edge of graph.edges.filter(({ eligibleForDrill }) => eligibleForDrill)) {
    if (!reachable.has(edge.fromNodeId)) issues.push(`Eligible edge ${edge.id} is unreachable from the pack root`)
  }

  const coreDepth = Math.max(...graph.paths.map(({ learnerDecisionCount }) => learnerDecisionCount))
  let opponentBranchesAfterRoot = 0
  for (const node of graph.nodes) {
    if (node.id === graph.pack.rootNodeId || node.learnerTurn || !reachable.has(node.id)) continue
    opponentBranchesAfterRoot = Math.max(
      opponentBranchesAfterRoot,
      node.outgoingEdgeIds.filter((id) => edges.get(id)?.eligibleForDrill).length,
    )
  }
  const expectedTier = classifyRepertoireTier(coreDepth, opponentBranchesAfterRoot)
  if (graph.pack.coreDepth !== coreDepth) issues.push(`Pack core depth must be ${coreDepth}`)
  if (graph.pack.opponentBranchCountAfterRoot !== opponentBranchesAfterRoot) {
    issues.push(`Pack opponent branch count must be ${opponentBranchesAfterRoot}`)
  }
  if (graph.pack.tier !== expectedTier) issues.push(`Pack tier must be ${expectedTier}`)

  if (issues.length > 0) throw new Error(`Invalid repertoire graph:\n- ${issues.join('\n- ')}`)
  return graph
}

export function validateEligibleSourceEdgeInventory(
  graphInput: unknown,
  inventoryInput: unknown,
): EligibleSourceEdgeInventoryV1 {
  const graph = RepertoireGraphDocumentSchema.parse(graphInput)
  const inventory = EligibleSourceEdgeInventoryV1Schema.parse(inventoryInput)
  if (inventory.releaseId !== graph.releaseId) {
    throw new Error('Eligible source-edge inventory belongs to another release')
  }
  if (inventory.packId !== graph.pack.id) {
    throw new Error('Eligible source-edge inventory belongs to another pack')
  }

  const emitted = graph.edges
    .filter(({ eligibleForDrill }) => eligibleForDrill)
    .map(({ id }) => id)
    .sort()
  const source = [...inventory.eligibleEdgeIds].sort()
  if (emitted.length !== source.length || emitted.some((edgeId, index) => edgeId !== source[index])) {
    const emittedSet = new Set(emitted)
    const sourceSet = new Set(source)
    const omitted = source.filter((edgeId) => !emittedSet.has(edgeId))
    const invented = emitted.filter((edgeId) => !sourceSet.has(edgeId))
    throw new Error(
      `Eligible source-edge inventory mismatch: ${omitted.length} omitted and ${invented.length} invented edge(s)`,
    )
  }
  return inventory
}

function orderedCoverageCycle(paths: readonly RepertoirePath[], ordinal: number): RepertoirePath[] {
  const ranked = [...paths].sort((left, right) =>
    right.conditionalUsage - left.conditionalUsage || left.id.localeCompare(right.id, 'en'),
  )
  let primaryCount = 0
  let coverage = 0
  while (primaryCount < ranked.length && coverage < DEFAULT_PRIMARY_COVERAGE) {
    coverage = Math.min(1, coverage + (ranked[primaryCount]?.conditionalUsage ?? 0))
    primaryCount += 1
  }
  const primary = ranked.slice(0, primaryCount)
  const extended = ranked.slice(primaryCount)
  if (extended.length === 0) return primary
  const rotation = ordinal % extended.length
  return [...primary, ...extended.slice(rotation), ...extended.slice(0, rotation)]
}

export interface SelectSessionPathsOptions {
  graph: RepertoireGraphDocument
  dueCardIds: readonly string[]
  previousCycle: CoverageCycleState | null
  maximumPaths: number
}

export interface SessionPathSelectionResult {
  selection: SessionPathSelection
  nextCycle: CoverageCycleState
}

/**
 * Each cycle contains every selectable path exactly once. High-coverage and
 * due paths are ordered first, but removing selected paths from the persisted
 * cycle guarantees that an extended branch cannot starve.
 */
export function selectSessionPaths(options: SelectSessionPathsOptions): SessionPathSelectionResult {
  const graph = RepertoireGraphDocumentSchema.parse(options.graph)
  if (!Number.isSafeInteger(options.maximumPaths) || options.maximumPaths < 1 || options.maximumPaths > 1_000) {
    throw new Error('maximumPaths must be an integer from 1 through 1000')
  }
  const suppliedDue = [...new Set(options.dueCardIds)]
  for (const cardId of suppliedDue) CardIdSchema.parse(cardId)
  if (suppliedDue.some((cardId) => !cardId.startsWith(`${graph.pack.id}::`))) {
    throw new Error('Due cards must belong to the selected pack')
  }

  const prior = options.previousCycle === null ? null : CoverageCycleStateSchema.parse(options.previousCycle)
  if (prior && prior.packId !== graph.pack.id) throw new Error('Coverage-cycle state belongs to another pack')
  const pathById = new Map(graph.paths.map((path) => [path.id, path]))
  if (prior?.remainingPathIds.some((pathId) => !pathById.has(pathId))) {
    throw new Error('Coverage-cycle state references an unavailable path')
  }
  const ordinal = prior?.ordinal ?? 0
  const remaining = prior && prior.remainingPathIds.length > 0
    ? prior.remainingPathIds.map((id) => pathById.get(id)!)
    : orderedCoverageCycle(graph.paths, ordinal)
  const dueNodeIds = new Set(suppliedDue.map((cardId) => cardId.slice(cardId.indexOf('::') + 2)))
  const duePaths = remaining.filter((path) => path.nodeIds.some((nodeId) => dueNodeIds.has(nodeId)))
  const nonDuePaths = remaining.filter((path) => !duePaths.includes(path))
  const included = [...duePaths, ...nonDuePaths].slice(0, options.maximumPaths)
  const includedIds = new Set(included.map(({ id }) => id))
  const remainingPathIds = remaining.filter(({ id }) => !includedIds.has(id)).map(({ id }) => id)

  const addressedNodeIds = new Set(included.flatMap(({ nodeIds }) => nodeIds).filter((id) => dueNodeIds.has(id)))
  const dueCardIds = suppliedDue.filter((cardId) => addressedNodeIds.has(cardId.slice(cardId.indexOf('::') + 2)))
  const warmupNodeIds: string[] = []
  const warmupSeen = new Set<string>()
  for (const path of included) {
    const dueIndexes = path.nodeIds.flatMap((nodeId, index) => dueNodeIds.has(nodeId) ? [index] : [])
    if (dueIndexes.length === 0) continue
    const lastWarmupIndex = Math.max(...dueIndexes)
    for (const nodeId of path.nodeIds.slice(0, lastWarmupIndex)) {
      if (!dueNodeIds.has(nodeId) && !warmupSeen.has(nodeId)) {
        warmupSeen.add(nodeId)
        warmupNodeIds.push(nodeId)
      }
    }
  }

  const cycleComplete = remainingPathIds.length === 0
  const selection = SessionPathSelectionSchema.parse({
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    packId: graph.pack.id,
    dueCardIds,
    includedPathIds: included.map(({ id }) => id),
    warmupNodeIds,
    coverageCycleId: `${graph.pack.id}::coverage:${ordinal}`,
  })
  const nextCycle = CoverageCycleStateSchema.parse({
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    packId: graph.pack.id,
    ordinal: cycleComplete ? ordinal + 1 : ordinal,
    remainingPathIds,
  })
  return { selection, nextCycle }
}

const REQUIRED_CARO_KANN_ECOS = Array.from({ length: 10 }, (_, index) => `B${10 + index}`)
const REQUIRED_CARO_KANN_FAMILIES = ['Advance', 'Exchange', 'Panov', 'Classical', 'Two Knights'] as const

export interface CaroKannRegressionSummary {
  pathCount: number
  corePathCount: number
  families: string[]
}

/** Release regression only; this checks structure and never supplies evidence. */
export function assertCaroKannFamilyRegression(graph: RepertoireGraphDocument): CaroKannRegressionSummary {
  const parsed = RepertoireGraphDocumentSchema.parse(graph)
  const issues: string[] = []
  if (parsed.pack.side !== 'black') issues.push('The Caro-Kann pack must train Black')
  for (const eco of REQUIRED_CARO_KANN_ECOS) {
    if (!parsed.pack.ecoCodes.includes(eco as z.infer<typeof EcoCodeSchema>)) issues.push(`The Caro-Kann pack is missing ${eco}`)
  }
  const drillablePaths = parsed.paths.filter(({ terminalStatus }) => terminalStatus !== 'quarantined')
  if (drillablePaths.length < 8) issues.push('The Caro-Kann pack requires at least eight drillable root-to-terminal paths')
  const families = [...new Set(drillablePaths.flatMap(({ familyTags }) => familyTags))].sort((a, b) => a.localeCompare(b, 'en'))
  for (const family of REQUIRED_CARO_KANN_FAMILIES) {
    if (!families.includes(family)) issues.push(`The Caro-Kann pack is missing the ${family} family`)
  }
  const corePathCount = drillablePaths.filter(({ learnerDecisionCount }) => learnerDecisionCount >= CORE_MINIMUM_LEARNER_DECISIONS).length
  if (parsed.pack.tier !== 'core' || corePathCount === 0) issues.push('The Caro-Kann pack must contain a validated Core path')
  if (issues.length > 0) throw new Error(`Caro-Kann regression failed:\n- ${issues.join('\n- ')}`)
  return { pathCount: drillablePaths.length, corePathCount, families }
}

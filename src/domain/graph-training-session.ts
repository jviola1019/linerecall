import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { z } from 'zod'
import { defaultReviewGrade, ReviewGradeSchema, type ReviewGrade } from './progress.ts'
import {
  FamilyTrainingCursorV1Schema,
  type FamilyTrainingCursorV1,
} from './opening-family.ts'
import {
  REPERTOIRE_SCHEMA_VERSION,
  SessionPathSelectionSchema,
  selectSessionPaths,
  stableRepertoireCardId,
  validateRepertoireGraphDocument,
  type RepertoireEdge,
  type RepertoireGraphDocument,
  type RepertoireNode,
  type RepertoirePath,
  type SessionPathSelection,
} from './repertoire.ts'

export const GRAPH_TRAINING_CONTRACT_ID = 'linerecall.repertoire-graph.v1' as const

const GraphTrainingEnvelopeSchema = z.object({
  contractId: z.literal(GRAPH_TRAINING_CONTRACT_ID),
  graph: z.unknown(),
}).strict()

export interface GraphTrainingEnvelope {
  contractId: typeof GRAPH_TRAINING_CONTRACT_ID
  graph: unknown
}

interface PathOccurrence {
  pathId: string
  edgeIndex: number
}

interface NodeOccurrence {
  pathId: string
  nodeIndex: number
}

/**
 * Runtime-validated boundary between the review-only v2 artifact and the v3
 * graph trainer. Callers cannot construct this adapter from a legacy line.
 */
export interface GraphTrainingAdapter {
  readonly contractId: typeof GRAPH_TRAINING_CONTRACT_ID
  readonly graph: RepertoireGraphDocument
  readonly nodesById: ReadonlyMap<string, RepertoireNode>
  readonly edgesById: ReadonlyMap<string, RepertoireEdge>
  readonly pathsById: ReadonlyMap<string, RepertoirePath>
  readonly edgeOccurrences: ReadonlyMap<string, readonly PathOccurrence[]>
  readonly nodeOccurrences: ReadonlyMap<string, readonly NodeOccurrence[]>
}

export type GraphTrainingPhase =
  | 'awaiting_learner_move'
  | 'correction_required'
  | 'opponent_move_ready'
  | 'path_complete'
  | 'session_complete'

export type GraphMoveClassification =
  | 'book'
  | 'playable'
  | 'inaccuracy'
  | 'exploratory'
  | 'quarantined'
  | 'unverified'
  | 'illegal'

export interface GraphTrainingReviewInference {
  cardId: string
  packId: string
  nodeId: string
  grade: ReviewGrade
  source: 'due' | 'repeat'
  moveUci: string
  edgeId: string
}

export interface GraphTrainingMoveFeedback {
  moveUci: string
  classification: GraphMoveClassification
  accepted: boolean
  reason:
    | 'eligible_book_edge'
    | 'accepted_playable_continuation'
    | 'engine_inaccuracy'
    | 'insufficient_sample'
    | 'quarantined_evidence'
    | 'unsupported_move'
    | 'no_audited_continuation'
    | 'illegal_move'
  expectedMoveUcis: string[]
  switchedPath: boolean
  warmup: boolean
  review: GraphTrainingReviewInference | null
}

export interface GraphTrainingTransition {
  edgeId: string
  moveUci: string
  fromNodeId: string
  toNodeId: string
  actor: 'learner' | 'opponent'
}

export interface GraphTrainingSessionState {
  schemaVersion: typeof REPERTOIRE_SCHEMA_VERSION
  releaseId: string
  packId: string
  selection: SessionPathSelection
  /**
   * Validated paths admitted to this session. This begins with the bounded
   * selection and grows only when a legal audited move transfers the learner
   * to another path in the same graph.
   */
  sessionPathIds: string[]
  activePathId: string
  activePathNodeIndex: number
  currentNodeId: string
  pendingPathIds: string[]
  completedPathIds: string[]
  traversedEdgeIds: string[]
  /**
   * Edges actually played since the most recent explicit path boundary.
   * Unlike `traversedEdgeIds`, this is reset when the next path starts. It
   * lets the UI report recall for the active audited path without crediting a
   * destination path's unplayed prefix after a transposition.
   */
  activePathRunEdgeIds: string[]
  dueCardIds: string[]
  repeatCardIds: string[]
  phase: GraphTrainingPhase
  usedHint: boolean
  revealedAnswer: boolean
  incorrectAttempts: number
  lastFeedback: GraphTrainingMoveFeedback | null
  lastTransition: GraphTrainingTransition | null
  pathBoundaryCount: number
}

export interface GraphTrainingPathSummary {
  id: string
  familyTags: string[]
  learnerDecisionCount: number
  terminalPly: number
  terminalStatus: RepertoirePath['terminalStatus']
  conditionalUsage: number
}

export const GRAPH_TRAINING_BATCH_PATH_LIMIT = 1_000 as const

export interface AutonomousGraphTrainingPlan {
  releaseId: string
  packId: string
  coverageCycleOrdinal: number
  totalPathIds: string[]
  pathIdBatches: string[][]
}

export interface RestoredGraphTrainingCycle {
  plan: AutonomousGraphTrainingPlan
  session: GraphTrainingSessionState
  activeBatchIndex: number
  completedBeforeBatch: string[]
  authoritativeDueCardIds: string[]
}

export interface GraphTrainingFamilyProgress {
  family: string
  totalPathCount: number
  completedPathCount: number
  remainingPathCount: number
}

export interface GraphTrainingCoverageProgress {
  totalPathCount: number
  completedPathCount: number
  remainingPathCount: number
  completedPathIds: string[]
  remainingPathIds: string[]
  families: GraphTrainingFamilyProgress[]
}

export interface GraphTrainingPathLearningProgress {
  pathId: string
  completedLearnerDecisions: number
  totalLearnerDecisions: number
  currentLearnerDecision: number | null
  terminalPly: number
  terminalStatus: RepertoirePath['terminalStatus']
}

export const GraphTrainingPathCompletionV1Schema = z.object({
  contractId: z.literal('linerecall.graph-path-completion.v1'),
  schemaVersion: z.literal(1),
  releaseId: z.string().min(1).max(160),
  packId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}$/u),
  pathId: z.string().regex(/^path_[a-f0-9]{20}$/u),
  familyTags: z.array(z.string().min(1).max(80)).min(1).max(32),
  coverageCycleId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::coverage:[0-9]+$/u),
  completedAt: z.iso.datetime({ offset: true }),
}).strict()

export type GraphTrainingPathCompletionV1 = z.infer<typeof GraphTrainingPathCompletionV1Schema>

export function createGraphTrainingPathCompletion(options: {
  adapter: GraphTrainingAdapter
  state: GraphTrainingSessionState
  pathId: string
  completedAt: string
}): GraphTrainingPathCompletionV1 {
  assertCurrentState(options.adapter, options.state)
  if (!options.state.completedPathIds.includes(options.pathId)) {
    throw new Error('A path completion record requires a completed session path')
  }
  const path = options.adapter.pathsById.get(options.pathId)
  if (!path || !options.state.sessionPathIds.includes(path.id)) {
    throw new Error('A path completion record must belong to the active validated session membership')
  }
  return GraphTrainingPathCompletionV1Schema.parse({
    contractId: 'linerecall.graph-path-completion.v1',
    schemaVersion: 1,
    releaseId: options.adapter.graph.releaseId,
    packId: options.adapter.graph.pack.id,
    pathId: path.id,
    familyTags: [...path.familyTags],
    coverageCycleId: options.state.selection.coverageCycleId,
    completedAt: options.completedAt,
  })
}

function appendMapValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? []
  values.push(value)
  map.set(key, values)
}

export async function prepareGraphTrainingAdapter(input: unknown): Promise<GraphTrainingAdapter> {
  const envelope = GraphTrainingEnvelopeSchema.parse(input)
  const graph = await validateRepertoireGraphDocument(envelope.graph)
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]))
  const pathsById = new Map(graph.paths.map((path) => [path.id, path]))
  const edgeOccurrences = new Map<string, PathOccurrence[]>()
  const nodeOccurrences = new Map<string, NodeOccurrence[]>()

  for (const path of graph.paths) {
    path.edgeIds.forEach((edgeId, edgeIndex) => appendMapValue(edgeOccurrences, edgeId, { pathId: path.id, edgeIndex }))
    path.nodeIds.forEach((nodeId, nodeIndex) => appendMapValue(nodeOccurrences, nodeId, { pathId: path.id, nodeIndex }))
  }

  const drillSourceNodeIds = new Set(
    graph.paths.flatMap((path) => path.nodeIds.slice(0, -1)),
  )
  for (const nodeId of drillSourceNodeIds) {
    const node = nodesById.get(nodeId)
    if (node?.learnerTurn && node.cardId !== stableRepertoireCardId(graph.pack.id, node.id)) {
      throw new Error(`Learner position ${node.id} is missing its stable graph-training card identity`)
    }
  }

  return {
    contractId: GRAPH_TRAINING_CONTRACT_ID,
    graph,
    nodesById,
    edgesById,
    pathsById,
    edgeOccurrences,
    nodeOccurrences,
  }
}

export function listGraphTrainingPaths(adapter: GraphTrainingAdapter): GraphTrainingPathSummary[] {
  return adapter.graph.paths
    .map((path) => ({
      id: path.id,
      familyTags: [...path.familyTags],
      learnerDecisionCount: path.learnerDecisionCount,
      terminalPly: path.terminalPly,
      terminalStatus: path.terminalStatus,
      conditionalUsage: path.conditionalUsage,
    }))
    .sort((left, right) =>
      right.conditionalUsage - left.conditionalUsage
      || right.learnerDecisionCount - left.learnerDecisionCount
      || left.id.localeCompare(right.id, 'en'),
    )
}

/**
 * Build a bounded sequence of sessions that contains every audited path once.
 * The existing 1,000-path session contract remains intact; larger packs are
 * continued in subsequent batches instead of hiding their extended branches.
 */
export function createAutonomousGraphTrainingPlan(options: {
  adapter: GraphTrainingAdapter
  dueCardIds: readonly string[]
  coverageCycleOrdinal?: number
  maximumPathsPerBatch?: number
}): AutonomousGraphTrainingPlan {
  const ordinal = options.coverageCycleOrdinal ?? 0
  const maximumPaths = options.maximumPathsPerBatch ?? GRAPH_TRAINING_BATCH_PATH_LIMIT
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('Coverage-cycle ordinal must be a nonnegative integer')
  if (!Number.isSafeInteger(maximumPaths) || maximumPaths < 1 || maximumPaths > GRAPH_TRAINING_BATCH_PATH_LIMIT) {
    throw new Error(`Autonomous graph batches must contain from 1 through ${GRAPH_TRAINING_BATCH_PATH_LIMIT} paths`)
  }

  const pathIdBatches: string[][] = []
  let previousCycle: { schemaVersion: typeof REPERTOIRE_SCHEMA_VERSION; packId: string; ordinal: number; remainingPathIds: string[] } | null = {
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    packId: options.adapter.graph.pack.id,
    ordinal,
    remainingPathIds: [],
  }
  let firstBatch = true
  while (firstBatch || previousCycle.remainingPathIds.length > 0) {
    const result = selectSessionPaths({
      graph: options.adapter.graph,
      dueCardIds: options.dueCardIds,
      previousCycle,
      maximumPaths,
    })
    const pathIds = [...result.selection.includedPathIds]
    if (pathIds.length === 0) throw new Error('The validated graph did not produce an autonomous training batch')
    pathIdBatches.push(pathIds)
    firstBatch = false
    previousCycle = result.nextCycle
    if (previousCycle.remainingPathIds.length === 0) break
    if (pathIdBatches.length > options.adapter.graph.paths.length) {
      throw new Error('Autonomous graph planning did not make bounded progress')
    }
  }

  const totalPathIds = pathIdBatches.flat()
  if (totalPathIds.length !== options.adapter.graph.paths.length || new Set(totalPathIds).size !== totalPathIds.length) {
    throw new Error('Autonomous graph planning must include every audited path exactly once')
  }
  return {
    releaseId: options.adapter.graph.releaseId,
    packId: options.adapter.graph.pack.id,
    coverageCycleOrdinal: ordinal,
    totalPathIds,
    pathIdBatches,
  }
}

/** Builds a bounded plan for one manifest branch or other explicit path set. */
export function createBoundedGraphTrainingPlan(options: {
  adapter: GraphTrainingAdapter
  pathIds: readonly string[]
  dueCardIds: readonly string[]
  coverageCycleOrdinal?: number
  maximumPathsPerBatch?: number
}): AutonomousGraphTrainingPlan {
  const ordinal = options.coverageCycleOrdinal ?? 0
  const maximumPaths = options.maximumPathsPerBatch ?? GRAPH_TRAINING_BATCH_PATH_LIMIT
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error('Coverage-cycle ordinal must be a nonnegative integer')
  }
  if (!Number.isSafeInteger(maximumPaths) || maximumPaths < 1 || maximumPaths > GRAPH_TRAINING_BATCH_PATH_LIMIT) {
    throw new Error(`Explicit graph batches must contain from 1 through ${GRAPH_TRAINING_BATCH_PATH_LIMIT} paths`)
  }
  const totalPathIds = uniqueInOrder(options.pathIds)
  if (totalPathIds.length === 0) throw new Error('Explicit graph planning requires at least one audited path')
  if (totalPathIds.length !== options.pathIds.length) {
    throw new Error('Explicit graph planning path IDs must be unique')
  }
  if (totalPathIds.length > 100_000) {
    throw new Error('Explicit graph planning exceeds the versioned cursor path limit')
  }
  for (const pathId of totalPathIds) {
    if (!options.adapter.pathsById.has(pathId)) {
      throw new Error(`Explicit graph planning references unavailable path ${pathId}`)
    }
  }
  assertAuthoritativeGraphCards(options.adapter, uniqueInOrder(options.dueCardIds))
  return {
    releaseId: options.adapter.graph.releaseId,
    packId: options.adapter.graph.pack.id,
    coverageCycleOrdinal: ordinal,
    totalPathIds,
    pathIdBatches: chunkPathIds(totalPathIds, maximumPaths),
  }
}

export function coverageCycleOrdinalFromId(packId: string, coverageCycleId: string): number {
  const prefix = `${packId}::coverage:`
  if (!coverageCycleId.startsWith(prefix)) {
    throw new Error('Coverage cursor belongs to another graph pack')
  }
  const value = Number(coverageCycleId.slice(prefix.length))
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Coverage cursor has an invalid cycle ordinal')
  }
  return value
}

/**
 * An alternate path may be selected from a later bounded batch. The live
 * session owns that transferred path immediately, so it must be removed from
 * every future batch or it would be traversed a second time.
 */
export function removeTransferredPathFromFutureBatches(options: {
  plan: AutonomousGraphTrainingPlan
  activeBatchIndex: number
  transferredPathId: string
}): AutonomousGraphTrainingPlan {
  if (!Number.isSafeInteger(options.activeBatchIndex) || options.activeBatchIndex < 0) {
    throw new Error('Active graph batch index must be a nonnegative integer')
  }
  if (!/^path_[a-f0-9]{20}$/u.test(options.transferredPathId)) {
    throw new Error('Transferred path has an invalid audited path identity')
  }
  const totalPathIds = options.plan.totalPathIds.includes(options.transferredPathId)
    ? options.plan.totalPathIds
    : [...options.plan.totalPathIds, options.transferredPathId]
  let removed = false
  const pathIdBatches = options.plan.pathIdBatches.map((pathIds, batchIndex) => {
    if (batchIndex <= options.activeBatchIndex) return [...pathIds]
    const filtered = pathIds.filter((pathId) => pathId !== options.transferredPathId)
    if (filtered.length !== pathIds.length) removed = true
    return filtered
  })
  return removed || totalPathIds !== options.plan.totalPathIds
    ? { ...options.plan, totalPathIds: [...totalPathIds], pathIdBatches }
    : options.plan
}

/**
 * Moves the active path behind every future bounded batch. This keeps Skip
 * meaningful at a batch boundary without dropping the path from the coverage
 * cycle or creating a batch larger than the public 1,000-path limit.
 */
export function deferGraphTrainingPathToCycleEnd(options: {
  plan: AutonomousGraphTrainingPlan
  activeBatchIndex: number
  pathId: string
}): AutonomousGraphTrainingPlan {
  if (!Number.isSafeInteger(options.activeBatchIndex) || options.activeBatchIndex < 0) {
    throw new Error('Active graph batch index must be a nonnegative integer')
  }
  if (!/^path_[a-f0-9]{20}$/u.test(options.pathId)) {
    throw new Error('Deferred path has an invalid audited path identity')
  }
  if (!options.plan.totalPathIds.includes(options.pathId)) {
    throw new Error('Deferred path is outside the active coverage plan')
  }
  const pathIdBatches = options.plan.pathIdBatches.map((pathIds, batchIndex) =>
    batchIndex < options.activeBatchIndex
      ? [...pathIds]
      : pathIds.filter((pathId) => pathId !== options.pathId))
  const futurePathCount = pathIdBatches
    .slice(options.activeBatchIndex + 1)
    .reduce((total, pathIds) => total + pathIds.length, 0)
  if (futurePathCount === 0) {
    throw new Error('No unfinished variation is available after the active batch')
  }
  let destinationIndex = pathIdBatches.length - 1
  while (destinationIndex > options.activeBatchIndex && pathIdBatches[destinationIndex]?.length === 0) {
    destinationIndex -= 1
  }
  if (
    destinationIndex <= options.activeBatchIndex
    || (pathIdBatches[destinationIndex]?.length ?? 0) >= GRAPH_TRAINING_BATCH_PATH_LIMIT
  ) {
    pathIdBatches.push([options.pathId])
  } else {
    pathIdBatches[destinationIndex] = [...pathIdBatches[destinationIndex]!, options.pathId]
  }
  return {
    ...options.plan,
    totalPathIds: [...options.plan.totalPathIds],
    pathIdBatches,
  }
}

export function nextNonemptyGraphTrainingBatch(
  plan: AutonomousGraphTrainingPlan,
  activeBatchIndex: number,
): { batchIndex: number; pathIds: string[] } | null {
  for (let index = activeBatchIndex + 1; index < plan.pathIdBatches.length; index += 1) {
    const pathIds = plan.pathIdBatches[index]
    if (pathIds && pathIds.length > 0) return { batchIndex: index, pathIds: [...pathIds] }
  }
  return null
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function assertAuthoritativeGraphCards(
  adapter: GraphTrainingAdapter,
  cardIds: readonly string[],
): void {
  for (const cardId of cardIds) {
    if (!cardId.startsWith(`${adapter.graph.pack.id}::`)) {
      throw new Error('Authoritative due cards must belong to the selected graph pack')
    }
    const node = adapter.nodesById.get(cardNodeId(cardId))
    if (!node || !node.learnerTurn || node.cardId !== cardId) {
      throw new Error(`Authoritative due card ${cardId} is not a learner card in this graph`)
    }
  }
}

function chunkPathIds(
  pathIds: readonly string[],
  maximumPaths: number = GRAPH_TRAINING_BATCH_PATH_LIMIT,
): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < pathIds.length; index += maximumPaths) {
    chunks.push(pathIds.slice(index, index + maximumPaths))
  }
  return chunks
}

export function createFamilyTrainingCursorSnapshot(options: {
  adapter: GraphTrainingAdapter
  familyId: string
  plan: AutonomousGraphTrainingPlan
  activeBatchIndex: number
  completedBeforeBatch: readonly string[]
  session: GraphTrainingSessionState
  authoritativeDueCardIds: readonly string[]
}): FamilyTrainingCursorV1 {
  assertCurrentState(options.adapter, options.session)
  if (
    options.plan.releaseId !== options.adapter.graph.releaseId
    || options.plan.packId !== options.adapter.graph.pack.id
    || options.plan.coverageCycleOrdinal !== coverageCycleOrdinalFromId(
      options.adapter.graph.pack.id,
      options.session.selection.coverageCycleId,
    )
  ) {
    throw new Error('Autonomous coverage plan is inconsistent with the active graph session')
  }
  if (!Number.isSafeInteger(options.activeBatchIndex) || options.activeBatchIndex < 0) {
    throw new Error('Active graph batch index must be a nonnegative integer')
  }
  const planPathIds = new Set(options.plan.totalPathIds)
  const completedPathIds = uniqueInOrder([
    ...options.completedBeforeBatch,
    ...options.session.completedPathIds,
  ])
  const completed = new Set(completedPathIds)
  const activePending = options.session.phase !== 'path_complete'
    && options.session.phase !== 'session_complete'
    && !completed.has(options.session.activePathId)
    ? [options.session.activePathId]
    : []
  const futureBatchPathIds = options.plan.pathIdBatches
    .slice(options.activeBatchIndex + 1)
    .flat()
  const pendingPathIds = uniqueInOrder([
    ...activePending,
    ...options.session.pendingPathIds,
    ...futureBatchPathIds,
  ]).filter((pathId) => !completed.has(pathId))
  for (const pathId of [...completedPathIds, ...pendingPathIds]) {
    if (!planPathIds.has(pathId) || !options.adapter.pathsById.has(pathId)) {
      throw new Error('Family cursor references a path outside the active coverage plan')
    }
  }
  const represented = new Set([...completedPathIds, ...pendingPathIds])
  if (
    represented.size !== planPathIds.size
    || [...planPathIds].some((pathId) => !represented.has(pathId))
  ) {
    throw new Error('Family cursor must represent every selected path exactly once')
  }
  const authoritativeDueCardIds = uniqueInOrder(options.authoritativeDueCardIds)
  assertAuthoritativeGraphCards(options.adapter, authoritativeDueCardIds)
  const remainingDue = new Set(options.session.dueCardIds)
  const reviewedCardIds = authoritativeDueCardIds.filter((cardId) => !remainingDue.has(cardId))
  return FamilyTrainingCursorV1Schema.parse({
    schemaVersion: 1,
    releaseId: options.adapter.graph.releaseId,
    familyId: options.familyId,
    side: options.adapter.graph.pack.side,
    coverageCycleId: options.session.selection.coverageCycleId,
    authoritativeDueCardIds,
    reviewedCardIds,
    completedPathIds,
    pendingPathIds,
    batchIndex: options.activeBatchIndex,
  })
}

/**
 * Cursor restoration intentionally resumes at the root of the first unfinished
 * audited path. The cursor preserves authoritative due work, exact path
 * completion, pending order, and bounded-batch position without pretending to
 * persist an uncommitted board gesture.
 */
export function restoreGraphTrainingCycleFromCursor(options: {
  adapter: GraphTrainingAdapter
  familyId: string
  cursor: FamilyTrainingCursorV1
}): RestoredGraphTrainingCycle {
  const cursor = FamilyTrainingCursorV1Schema.parse(options.cursor)
  if (
    cursor.releaseId !== options.adapter.graph.releaseId
    || cursor.familyId !== options.familyId
    || cursor.side !== options.adapter.graph.pack.side
  ) {
    throw new Error('Saved family training cursor belongs to another release, family, or side')
  }
  const ordinal = coverageCycleOrdinalFromId(options.adapter.graph.pack.id, cursor.coverageCycleId)
  assertAuthoritativeGraphCards(options.adapter, cursor.authoritativeDueCardIds)
  const totalPathIds = uniqueInOrder([...cursor.completedPathIds, ...cursor.pendingPathIds])
  if (totalPathIds.length === 0) throw new Error('Saved family training cursor contains no paths')
  for (const pathId of totalPathIds) {
    if (!options.adapter.pathsById.has(pathId)) {
      throw new Error(`Saved family training cursor references unavailable path ${pathId}`)
    }
  }
  const remainingDueCardIds = cursor.authoritativeDueCardIds.filter(
    (cardId) => !cursor.reviewedCardIds.includes(cardId),
  )
  const pendingBatches = chunkPathIds(cursor.pendingPathIds)
  const prefixBatches = Array.from({ length: cursor.batchIndex }, () => [] as string[])

  if (pendingBatches.length > 0) {
    const selection = createExplicitGraphSessionSelection({
      adapter: options.adapter,
      pathIds: pendingBatches[0]!,
      dueCardIds: remainingDueCardIds,
      coverageCycleOrdinal: ordinal,
    })
    return {
      plan: {
        releaseId: options.adapter.graph.releaseId,
        packId: options.adapter.graph.pack.id,
        coverageCycleOrdinal: ordinal,
        totalPathIds,
        pathIdBatches: [...prefixBatches, ...pendingBatches],
      },
      session: createGraphTrainingSession({
        adapter: options.adapter,
        selection,
        preferredPathId: cursor.pendingPathIds[0]!,
      }),
      activeBatchIndex: cursor.batchIndex,
      completedBeforeBatch: [...cursor.completedPathIds],
      authoritativeDueCardIds: [...cursor.authoritativeDueCardIds],
    }
  }

  const finalBatch = cursor.completedPathIds.slice(-GRAPH_TRAINING_BATCH_PATH_LIMIT)
  if (finalBatch.length === 0) throw new Error('Completed family cursor contains no auditable path')
  const selection = createExplicitGraphSessionSelection({
    adapter: options.adapter,
    pathIds: finalBatch,
    dueCardIds: remainingDueCardIds,
    coverageCycleOrdinal: ordinal,
  })
  const baseSession = createGraphTrainingSession({
    adapter: options.adapter,
    selection,
    preferredPathId: finalBatch[0]!,
  })
  return {
    plan: {
      releaseId: options.adapter.graph.releaseId,
      packId: options.adapter.graph.pack.id,
      coverageCycleOrdinal: ordinal,
      totalPathIds,
      pathIdBatches: [...prefixBatches, finalBatch],
    },
    session: {
      ...baseSession,
      completedPathIds: [...finalBatch],
      pendingPathIds: [],
      phase: 'session_complete',
    },
    activeBatchIndex: cursor.batchIndex,
    completedBeforeBatch: cursor.completedPathIds.slice(0, -finalBatch.length),
    authoritativeDueCardIds: [...cursor.authoritativeDueCardIds],
  }
}

export function summarizeGraphTrainingCoverage(options: {
  adapter: GraphTrainingAdapter
  includedPathIds: readonly string[]
  completedPathIds: readonly string[]
}): GraphTrainingCoverageProgress {
  const includedPathIds = [...new Set(options.includedPathIds)]
  if (includedPathIds.length === 0) throw new Error('Coverage progress requires at least one included path')
  const included = includedPathIds.map((pathId) => {
    const path = options.adapter.pathsById.get(pathId)
    if (!path) throw new Error(`Coverage progress references unavailable path ${pathId}`)
    return path
  })
  const includedSet = new Set(includedPathIds)
  const completedPathIds = [...new Set(options.completedPathIds)].filter((pathId) => includedSet.has(pathId))
  const completedSet = new Set(completedPathIds)
  const remainingPathIds = includedPathIds.filter((pathId) => !completedSet.has(pathId))
  const families = new Map<string, { total: Set<string>; completed: Set<string> }>()
  for (const path of included) {
    for (const family of path.familyTags) {
      const progress = families.get(family) ?? { total: new Set<string>(), completed: new Set<string>() }
      progress.total.add(path.id)
      if (completedSet.has(path.id)) progress.completed.add(path.id)
      families.set(family, progress)
    }
  }
  return {
    totalPathCount: includedPathIds.length,
    completedPathCount: completedPathIds.length,
    remainingPathCount: remainingPathIds.length,
    completedPathIds,
    remainingPathIds,
    families: [...families].map(([family, progress]) => ({
      family,
      totalPathCount: progress.total.size,
      completedPathCount: progress.completed.size,
      remainingPathCount: progress.total.size - progress.completed.size,
    })).sort((left, right) => left.family.localeCompare(right.family, 'en')),
  }
}

function cardNodeId(cardId: string): string {
  const separator = cardId.indexOf('::')
  return separator < 0 ? '' : cardId.slice(separator + 2)
}

export function createExplicitGraphSessionSelection(options: {
  adapter: GraphTrainingAdapter
  pathIds: readonly string[]
  dueCardIds: readonly string[]
  coverageCycleOrdinal?: number
}): SessionPathSelection {
  const pathIds = [...new Set(options.pathIds)]
  if (pathIds.length === 0) throw new Error('At least one audited path must be selected')
  if (pathIds.length > 1_000) throw new Error('A session may contain at most 1000 paths; every path remains individually selectable')
  const paths = pathIds.map((pathId) => {
    const path = options.adapter.pathsById.get(pathId)
    if (!path) throw new Error(`Selected path ${pathId} is not part of this validated graph`)
    return path
  })
  const selectedNodeIds = new Set(paths.flatMap(({ nodeIds }) => nodeIds))
  /*
   * Keep the full authoritative due set in every bounded selection. A session
   * consumes only cards it reaches, then passes the unconsumed set to the next
   * autonomous batch. Narrowing here would silently turn later-batch due cards
   * into warm-ups.
   */
  const dueCardIds = [...new Set(options.dueCardIds)]
  for (const cardId of dueCardIds) {
    if (!cardId.startsWith(`${options.adapter.graph.pack.id}::`)) {
      throw new Error('Due cards must belong to the selected graph pack')
    }
    const node = options.adapter.nodesById.get(cardNodeId(cardId))
    if (!node || !node.learnerTurn || node.cardId !== cardId) throw new Error(`Due card ${cardId} is not a learner card in this graph`)
  }
  const dueNodeIds = new Set(dueCardIds.map(cardNodeId).filter((nodeId) => selectedNodeIds.has(nodeId)))
  const warmupNodeIds: string[] = []
  const warmupSeen = new Set<string>()
  for (const path of paths) {
    const lastDueIndex = Math.max(-1, ...path.nodeIds.flatMap((nodeId, index) => dueNodeIds.has(nodeId) ? [index] : []))
    for (const nodeId of path.nodeIds.slice(0, lastDueIndex)) {
      const node = options.adapter.nodesById.get(nodeId)
      if (node?.learnerTurn && !dueNodeIds.has(nodeId) && !warmupSeen.has(nodeId)) {
        warmupSeen.add(nodeId)
        warmupNodeIds.push(nodeId)
      }
    }
  }
  const ordinal = options.coverageCycleOrdinal ?? 0
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('Coverage-cycle ordinal must be a nonnegative integer')
  return SessionPathSelectionSchema.parse({
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    packId: options.adapter.graph.pack.id,
    dueCardIds,
    includedPathIds: pathIds,
    warmupNodeIds,
    coverageCycleId: `${options.adapter.graph.pack.id}::coverage:${ordinal}`,
  })
}

function phaseForNode(adapter: GraphTrainingAdapter, path: RepertoirePath, nodeIndex: number): GraphTrainingPhase {
  if (nodeIndex >= path.edgeIds.length) return 'path_complete'
  const node = adapter.nodesById.get(path.nodeIds[nodeIndex] ?? '')
  if (!node) throw new Error('The active path references a missing node')
  return node.learnerTurn ? 'awaiting_learner_move' : 'opponent_move_ready'
}

export function createGraphTrainingSession(options: {
  adapter: GraphTrainingAdapter
  selection: SessionPathSelection
  preferredPathId?: string
}): GraphTrainingSessionState {
  const selection = SessionPathSelectionSchema.parse(options.selection)
  if (selection.packId !== options.adapter.graph.pack.id) throw new Error('Session selection belongs to another graph pack')
  const preferred = options.preferredPathId
  const activePathId = preferred && selection.includedPathIds.includes(preferred)
    ? preferred
    : selection.includedPathIds[0]
  if (!activePathId) throw new Error('Session selection has no path')
  const activePath = options.adapter.pathsById.get(activePathId)
  if (!activePath) throw new Error('Session selection references an unavailable path')
  for (const pathId of selection.includedPathIds) {
    if (!options.adapter.pathsById.has(pathId)) throw new Error('Session selection references an unavailable path')
  }
  if (activePath.nodeIds[0] !== options.adapter.graph.pack.rootNodeId) throw new Error('Training path does not begin at the pack root')
  return {
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    releaseId: options.adapter.graph.releaseId,
    packId: options.adapter.graph.pack.id,
    selection,
    sessionPathIds: [...selection.includedPathIds],
    activePathId,
    activePathNodeIndex: 0,
    currentNodeId: activePath.nodeIds[0]!,
    pendingPathIds: selection.includedPathIds.filter((pathId) => pathId !== activePathId),
    completedPathIds: [],
    traversedEdgeIds: [],
    activePathRunEdgeIds: [],
    dueCardIds: [...selection.dueCardIds],
    repeatCardIds: [],
    phase: phaseForNode(options.adapter, activePath, 0),
    usedHint: false,
    revealedAnswer: false,
    incorrectAttempts: 0,
    lastFeedback: null,
    lastTransition: null,
    pathBoundaryCount: 0,
  }
}

function assertCurrentState(adapter: GraphTrainingAdapter, state: GraphTrainingSessionState): { path: RepertoirePath; node: RepertoireNode } {
  if (state.packId !== adapter.graph.pack.id || state.releaseId !== adapter.graph.releaseId) {
    throw new Error('Training state belongs to another validated graph release')
  }
  if (
    new Set(state.sessionPathIds).size !== state.sessionPathIds.length
    || !state.sessionPathIds.includes(state.activePathId)
    || state.sessionPathIds.some((pathId) => !adapter.pathsById.has(pathId))
    || new Set(state.pendingPathIds).size !== state.pendingPathIds.length
    || new Set(state.completedPathIds).size !== state.completedPathIds.length
    || state.pendingPathIds.some((pathId) => !state.sessionPathIds.includes(pathId))
    || state.completedPathIds.some((pathId) => !state.sessionPathIds.includes(pathId))
  ) {
    throw new Error('Training state is stale or inconsistent with validated session membership')
  }
  const path = adapter.pathsById.get(state.activePathId)
  const node = adapter.nodesById.get(state.currentNodeId)
  if (!path || !node || path.nodeIds[state.activePathNodeIndex] !== node.id) {
    throw new Error('Training state is stale or inconsistent with the active graph path')
  }
  return { path, node }
}

export function graphTrainingFen(adapter: GraphTrainingAdapter, state: GraphTrainingSessionState): string {
  const { node } = assertCurrentState(adapter, state)
  return `${node.epd} 0 1`
}

/**
 * Reports recall progress for the exact audited path instead of treating every
 * board ply as a learner move. Credit requires an edge from the active path to
 * have actually been played during this path run. A later transposition can
 * therefore continue on another audited path without claiming that path's
 * divergent prefix was recalled.
 */
export function graphTrainingPathLearningProgress(
  adapter: GraphTrainingAdapter,
  state: GraphTrainingSessionState,
): GraphTrainingPathLearningProgress {
  const { path, node } = assertCurrentState(adapter, state)
  const learnerDecisionIndexes = path.nodeIds
    .slice(0, -1)
    .flatMap((nodeId, index) => adapter.nodesById.get(nodeId)?.learnerTurn ? [index] : [])
  if (learnerDecisionIndexes.length !== path.learnerDecisionCount) {
    throw new Error('Audited path learner-decision count is inconsistent with its position graph')
  }
  const playedThisRun = new Set(state.activePathRunEdgeIds)
  const completedLearnerDecisions = learnerDecisionIndexes.filter((index) => {
    const edgeId = path.edgeIds[index]
    return edgeId !== undefined && playedThisRun.has(edgeId)
  }).length
  const currentLearnerDecision = node.learnerTurn
    && state.activePathNodeIndex < path.edgeIds.length
    ? completedLearnerDecisions + 1
    : null
  return {
    pathId: path.id,
    completedLearnerDecisions,
    totalLearnerDecisions: path.learnerDecisionCount,
    currentLearnerDecision,
    terminalPly: path.terminalPly,
    terminalStatus: path.terminalStatus,
  }
}

export function expectedGraphTrainingMoves(adapter: GraphTrainingAdapter, state: GraphTrainingSessionState): RepertoireEdge[] {
  const { node } = assertCurrentState(adapter, state)
  if (!node.learnerTurn) return []
  return node.outgoingEdgeIds
    .flatMap((edgeId) => {
      const edge = adapter.edgesById.get(edgeId)
      return edge?.eligibleForDrill ? [edge] : []
    })
    .sort((left, right) =>
      right.evidence.conditionalUsage - left.evidence.conditionalUsage || left.uci.localeCompare(right.uci, 'en'),
    )
}

export function markGraphTrainingHint(adapter: GraphTrainingAdapter, state: GraphTrainingSessionState): GraphTrainingSessionState {
  assertCurrentState(adapter, state)
  if (state.phase !== 'awaiting_learner_move' && state.phase !== 'correction_required') return state
  return { ...state, usedHint: true }
}

export function markGraphTrainingReveal(adapter: GraphTrainingAdapter, state: GraphTrainingSessionState): GraphTrainingSessionState {
  assertCurrentState(adapter, state)
  if (state.phase !== 'awaiting_learner_move' && state.phase !== 'correction_required') return state
  return { ...state, phase: 'correction_required', usedHint: true, revealedAnswer: true }
}

/** Confirm or change an inferred review before Manual Pacing persists it. */
export function overrideLastGraphTrainingReviewGrade(
  state: GraphTrainingSessionState,
  input: ReviewGrade,
): GraphTrainingSessionState {
  const grade = ReviewGradeSchema.parse(input)
  const review = state.lastFeedback?.review
  if (!review || !state.lastFeedback?.accepted) {
    throw new Error('The graph session has no accepted review to grade')
  }
  const repeatCardIds = grade === 'again'
    ? appendUniqueAtEnd(state.repeatCardIds, review.cardId)
    : state.repeatCardIds.filter((cardId) => cardId !== review.cardId)
  return {
    ...state,
    repeatCardIds,
    lastFeedback: {
      ...state.lastFeedback,
      review: { ...review, grade },
    },
  }
}

function moveParts(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

function isLegalFrom(node: RepertoireNode, uci: string): boolean {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(uci)) return false
  try {
    new Chess(`${node.epd} 0 1`).move(moveParts(uci))
    return true
  } catch {
    return false
  }
}

function rankPathCandidates<T extends PathOccurrence | NodeOccurrence>(
  adapter: GraphTrainingAdapter,
  state: GraphTrainingSessionState,
  candidates: readonly T[],
): T[] {
  const pendingRank = new Map(state.pendingPathIds.map((pathId, index) => [pathId, index]))
  return [...candidates].sort((left, right) => {
    const leftActive = Number(left.pathId === state.activePathId)
    const rightActive = Number(right.pathId === state.activePathId)
    if (leftActive !== rightActive) return rightActive - leftActive
    const leftCompleted = Number(state.completedPathIds.includes(left.pathId))
    const rightCompleted = Number(state.completedPathIds.includes(right.pathId))
    if (leftCompleted !== rightCompleted) return leftCompleted - rightCompleted
    const leftPending = pendingRank.get(left.pathId)
    const rightPending = pendingRank.get(right.pathId)
    if (leftPending !== undefined || rightPending !== undefined) {
      if (leftPending === undefined) return 1
      if (rightPending === undefined) return -1
      if (leftPending !== rightPending) return leftPending - rightPending
    }
    const leftPath = adapter.pathsById.get(left.pathId)!
    const rightPath = adapter.pathsById.get(right.pathId)!
    return rightPath.conditionalUsage - leftPath.conditionalUsage || left.pathId.localeCompare(right.pathId, 'en')
  })
}

function continuationForEdge(
  adapter: GraphTrainingAdapter,
  state: GraphTrainingSessionState,
  edge: RepertoireEdge,
): { path: RepertoirePath; nodeIndex: number } | null {
  const exact = (adapter.edgeOccurrences.get(edge.id) ?? []).filter((occurrence) => {
    const path = adapter.pathsById.get(occurrence.pathId)
    return path?.nodeIds[occurrence.edgeIndex] === state.currentNodeId
  })
  const exactChoice = rankPathCandidates(adapter, state, exact)[0]
  if (exactChoice) return { path: adapter.pathsById.get(exactChoice.pathId)!, nodeIndex: exactChoice.edgeIndex + 1 }

  if (edge.role !== 'playable') return null
  const target = (adapter.nodeOccurrences.get(edge.toNodeId) ?? []).filter((occurrence) => {
    const path = adapter.pathsById.get(occurrence.pathId)
    return path !== undefined && occurrence.nodeIndex < path.nodeIds.length
  })
  const targetChoice = rankPathCandidates(adapter, state, target)[0]
  return targetChoice
    ? { path: adapter.pathsById.get(targetChoice.pathId)!, nodeIndex: targetChoice.nodeIndex }
    : null
}

function membershipAfterPathSwitch(
  state: GraphTrainingSessionState,
  nextPathId: string,
): { pendingPathIds: string[]; sessionPathIds: string[] } {
  if (nextPathId === state.activePathId) {
    return {
      pendingPathIds: state.pendingPathIds,
      sessionPathIds: state.sessionPathIds,
    }
  }
  const completed = new Set(state.completedPathIds)
  const withoutNext = state.pendingPathIds.filter(
    (pathId) => pathId !== nextPathId && pathId !== state.activePathId && !completed.has(pathId),
  )
  return {
    pendingPathIds: completed.has(state.activePathId)
      ? withoutNext
      : [...withoutNext, state.activePathId],
    sessionPathIds: state.sessionPathIds.includes(nextPathId)
      ? state.sessionPathIds
      : [...state.sessionPathIds, nextPathId],
  }
}

function appendUniqueAtEnd(values: readonly string[], value: string): string[] {
  return [...values.filter((candidate) => candidate !== value), value]
}

function settleAfterTransition(options: {
  adapter: GraphTrainingAdapter
  state: GraphTrainingSessionState
  path: RepertoirePath
  nodeIndex: number
  edge: RepertoireEdge
  actor: 'learner' | 'opponent'
  feedback: GraphTrainingMoveFeedback | null
  dueCardIds?: string[]
  repeatCardIds?: string[]
  pendingPathIds?: string[]
  sessionPathIds?: string[]
}): GraphTrainingSessionState {
  const currentNodeId = options.path.nodeIds[options.nodeIndex]
  if (!currentNodeId || currentNodeId !== options.edge.toNodeId) {
    throw new Error('Graph transition did not reach the selected path continuation')
  }
  const phase = phaseForNode(options.adapter, options.path, options.nodeIndex)
  return {
    ...options.state,
    activePathId: options.path.id,
    activePathNodeIndex: options.nodeIndex,
    currentNodeId,
    pendingPathIds: options.pendingPathIds ?? options.state.pendingPathIds,
    sessionPathIds: options.sessionPathIds ?? options.state.sessionPathIds,
    completedPathIds: phase === 'path_complete' && !options.state.completedPathIds.includes(options.path.id)
      ? [...options.state.completedPathIds, options.path.id]
      : options.state.completedPathIds,
    traversedEdgeIds: [...options.state.traversedEdgeIds, options.edge.id],
    activePathRunEdgeIds: [...options.state.activePathRunEdgeIds, options.edge.id],
    dueCardIds: options.dueCardIds ?? options.state.dueCardIds,
    repeatCardIds: options.repeatCardIds ?? options.state.repeatCardIds,
    phase,
    usedHint: false,
    revealedAnswer: false,
    incorrectAttempts: 0,
    lastFeedback: options.feedback,
    lastTransition: {
      edgeId: options.edge.id,
      moveUci: options.edge.uci,
      fromNodeId: options.edge.fromNodeId,
      toNodeId: options.edge.toNodeId,
      actor: options.actor,
    },
  }
}

export function submitGraphTrainingMove(options: {
  adapter: GraphTrainingAdapter
  state: GraphTrainingSessionState
  moveUci: string
}): GraphTrainingSessionState {
  const { adapter, moveUci } = options
  const state = options.state
  const { node } = assertCurrentState(adapter, state)
  if (state.phase !== 'awaiting_learner_move' && state.phase !== 'correction_required') {
    throw new Error('The graph session is not waiting for a learner move')
  }
  if (!node.learnerTurn) throw new Error('The current graph position belongs to the opponent')
  const expectedMoveUcis = expectedGraphTrainingMoves(adapter, state).map(({ uci }) => uci)
  const edge = node.outgoingEdgeIds
    .map((edgeId) => adapter.edgesById.get(edgeId))
    .find((candidate) => candidate?.uci === moveUci)
  const legal = isLegalFrom(node, moveUci)

  let classification: GraphMoveClassification = 'unverified'
  let reason: GraphTrainingMoveFeedback['reason'] = 'unsupported_move'
  if (!legal) {
    classification = 'illegal'
    reason = 'illegal_move'
  } else if (edge?.evidence.engine.status === 'quarantined') {
    classification = 'quarantined'
    reason = 'quarantined_evidence'
  } else if (edge?.role === 'exploratory') {
    classification = 'exploratory'
    reason = 'insufficient_sample'
  } else if (edge?.role === 'inaccuracy') {
    classification = 'inaccuracy'
    reason = 'engine_inaccuracy'
  } else if (edge?.eligibleForDrill) {
    classification = 'book'
    reason = 'eligible_book_edge'
  } else if (edge?.role === 'playable') {
    classification = 'playable'
    reason = 'accepted_playable_continuation'
  }

  const continuation = edge ? continuationForEdge(adapter, state, edge) : null
  const accepted = legal
    && edge !== undefined
    && continuation !== null
    && (classification === 'book' || classification === 'playable')
  if (!accepted) {
    if (classification === 'playable' && continuation === null) {
      classification = 'unverified'
      reason = 'no_audited_continuation'
    }
    const feedback: GraphTrainingMoveFeedback = {
      moveUci,
      classification,
      accepted: false,
      reason,
      expectedMoveUcis,
      switchedPath: false,
      warmup: false,
      review: null,
    }
    return {
      ...state,
      phase: 'correction_required',
      incorrectAttempts: state.incorrectAttempts + 1,
      lastFeedback: feedback,
      lastTransition: null,
    }
  }

  const cardId = node.cardId ?? stableRepertoireCardId(state.packId, node.id)
  const due = state.dueCardIds.includes(cardId)
  const repeat = state.repeatCardIds.includes(cardId)
  const warmup = !due && !repeat
  const grade = state.revealedAnswer ? 'again' : defaultReviewGrade({
    incorrectAttempts: state.incorrectAttempts,
    usedHint: state.usedHint,
    playedPlayableAlternative: classification === 'playable',
  })
  const review: GraphTrainingReviewInference | null = warmup ? null : {
    cardId,
    packId: state.packId,
    nodeId: node.id,
    grade,
    source: repeat ? 'repeat' : 'due',
    moveUci,
    edgeId: edge.id,
  }
  const dueCardIds = state.dueCardIds.filter((candidate) => candidate !== cardId)
  const repeatCardIds = review === null
    ? state.repeatCardIds
    : grade === 'again'
      ? appendUniqueAtEnd(state.repeatCardIds, cardId)
      : state.repeatCardIds.filter((candidate) => candidate !== cardId)
  const switchedPath = continuation.path.id !== state.activePathId
  const feedback: GraphTrainingMoveFeedback = {
    moveUci,
    classification,
    accepted: true,
    reason,
    expectedMoveUcis,
    switchedPath,
    warmup,
    review,
  }
  const membership = membershipAfterPathSwitch(state, continuation.path.id)
  return settleAfterTransition({
    adapter,
    state,
    path: continuation.path,
    nodeIndex: continuation.nodeIndex,
    edge,
    actor: 'learner',
    feedback,
    dueCardIds,
    repeatCardIds,
    pendingPathIds: membership.pendingPathIds,
    sessionPathIds: membership.sessionPathIds,
  })
}

export function pendingOpponentGraphMove(
  adapter: GraphTrainingAdapter,
  state: GraphTrainingSessionState,
): RepertoireEdge | null {
  const { path, node } = assertCurrentState(adapter, state)
  if (state.phase !== 'opponent_move_ready') return null
  if (node.learnerTurn) throw new Error('Opponent transition requested from a learner position')
  const edgeId = path.edgeIds[state.activePathNodeIndex]
  const edge = edgeId ? adapter.edgesById.get(edgeId) : undefined
  if (!edge || edge.fromNodeId !== node.id || !edge.eligibleForDrill) {
    throw new Error('The selected opponent branch has no audited continuation')
  }
  return edge
}

/** Apply this only after the prior visual move transition has completed. */
export function applyPendingOpponentGraphMove(
  adapter: GraphTrainingAdapter,
  state: GraphTrainingSessionState,
): GraphTrainingSessionState {
  const edge = pendingOpponentGraphMove(adapter, state)
  if (!edge) throw new Error('The graph session has no opponent move ready')
  const path = adapter.pathsById.get(state.activePathId)!
  return settleAfterTransition({
    adapter,
    state,
    path,
    nodeIndex: state.activePathNodeIndex + 1,
    edge,
    actor: 'opponent',
    feedback: state.lastFeedback,
  })
}

function pathForRepeatCard(adapter: GraphTrainingAdapter, cardId: string): RepertoirePath | null {
  const nodeId = cardNodeId(cardId)
  const candidates = (adapter.nodeOccurrences.get(nodeId) ?? [])
    .map(({ pathId }) => adapter.pathsById.get(pathId))
    .filter((path): path is RepertoirePath => path !== undefined)
    .sort((left, right) =>
      right.conditionalUsage - left.conditionalUsage || left.id.localeCompare(right.id, 'en'),
    )
  return candidates[0] ?? null
}

/**
 * A root reset is allowed only at an explicit path boundary. Moves within a
 * path always use declared legal edges, including alternate transpositions.
 */
export function continueGraphTrainingSession(
  adapter: GraphTrainingAdapter,
  state: GraphTrainingSessionState,
): GraphTrainingSessionState {
  assertCurrentState(adapter, state)
  if (state.phase !== 'path_complete') throw new Error('The current graph path is not complete')
  const completed = new Set(state.completedPathIds)
  const unfinishedPendingPathIds = state.pendingPathIds.filter((pathId) => !completed.has(pathId))
  const pendingPathId = unfinishedPendingPathIds[0]
  const repeatPath = pendingPathId ? null : pathForRepeatCard(adapter, state.repeatCardIds[0] ?? '')
  const nextPath = pendingPathId ? adapter.pathsById.get(pendingPathId) : repeatPath
  if (!nextPath) {
    if (state.repeatCardIds.length > 0) throw new Error('A failed card has no selectable path for its session-end repeat')
    return { ...state, phase: 'session_complete', lastTransition: null, pathBoundaryCount: state.pathBoundaryCount + 1 }
  }
  return {
    ...state,
    activePathId: nextPath.id,
    activePathNodeIndex: 0,
    currentNodeId: nextPath.nodeIds[0]!,
    pendingPathIds: pendingPathId ? unfinishedPendingPathIds.slice(1) : unfinishedPendingPathIds,
    phase: phaseForNode(adapter, nextPath, 0),
    usedHint: false,
    revealedAnswer: false,
    incorrectAttempts: 0,
    lastFeedback: null,
    lastTransition: null,
    activePathRunEdgeIds: [],
    pathBoundaryCount: state.pathBoundaryCount + 1,
  }
}

/**
 * Move an unfinished path to the back of the active queue. Skipping is an
 * explicit path boundary: it may reset the board to the next audited root, but
 * it never completes, grades, or removes due/repeat work from the skipped path.
 */
export function skipCurrentGraphTrainingPath(
  adapter: GraphTrainingAdapter,
  state: GraphTrainingSessionState,
): GraphTrainingSessionState {
  assertCurrentState(adapter, state)
  if (
    state.phase === 'path_complete'
    || state.phase === 'session_complete'
    || state.completedPathIds.includes(state.activePathId)
  ) {
    throw new Error('Only an unfinished graph path can be skipped')
  }
  const completed = new Set(state.completedPathIds)
  const unfinishedPendingPathIds = state.pendingPathIds.filter(
    (pathId) => pathId !== state.activePathId && !completed.has(pathId),
  )
  const nextPathId = unfinishedPendingPathIds[0]
  const nextPath = nextPathId ? adapter.pathsById.get(nextPathId) : undefined
  if (!nextPath) throw new Error('No other unfinished graph path is available')
  return {
    ...state,
    activePathId: nextPath.id,
    activePathNodeIndex: 0,
    currentNodeId: nextPath.nodeIds[0]!,
    pendingPathIds: [...unfinishedPendingPathIds.slice(1), state.activePathId],
    phase: phaseForNode(adapter, nextPath, 0),
    usedHint: false,
    revealedAnswer: false,
    incorrectAttempts: 0,
    lastFeedback: null,
    lastTransition: null,
    activePathRunEdgeIds: [],
    pathBoundaryCount: state.pathBoundaryCount + 1,
  }
}

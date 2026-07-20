import type { PositionGraph, DeviationFeedback } from './deviation.ts'
import { evaluateMove } from './deviation.ts'
import type { PositionNode, VerifiedLine } from './opening-data.ts'
import {
  createCard,
  defaultReviewGrade,
  enqueueFailedCard,
  scheduleReview,
  type CardProgress,
  type ReviewGrade,
} from './progress.ts'

export type TrainingPhase = 'awaiting_move' | 'answer_ready' | 'complete'

export interface TrainingSessionState {
  lineId: string
  queue: string[]
  currentNodeId: string | null
  phase: TrainingPhase
  feedback: DeviationFeedback | null
  usedHint: boolean
  incorrectAttempts: number
  suggestedGrade: ReviewGrade | null
  opponentAutoMoveUci: string | null
}

export interface CompletedReview {
  state: TrainingSessionState
  card: CardProgress
  appliedGrade: ReviewGrade
  repeatAtSessionEnd: boolean
}

function nodeById(line: Pick<VerifiedLine, 'nodes'>, nodeId: string | null): PositionNode | null {
  if (nodeId === null) return null
  return line.nodes.find((node) => node.id === nodeId) ?? null
}

export function createTrainingSession(
  line: Pick<VerifiedLine, 'id' | 'drillEligible' | 'nodes'>,
  dueNodeIds?: readonly string[],
): TrainingSessionState {
  if (!line.drillEligible) throw new Error('This variation is not eligible for drills')
  const known = new Set(line.nodes.map((node) => node.id))
  const queue = dueNodeIds === undefined
    ? line.nodes.map((node) => node.id)
    : [...new Set(dueNodeIds)].filter((nodeId) => known.has(nodeId))
  return {
    lineId: line.id,
    queue,
    currentNodeId: queue[0] ?? null,
    phase: queue.length === 0 ? 'complete' : 'awaiting_move',
    feedback: null,
    usedHint: false,
    incorrectAttempts: 0,
    suggestedGrade: null,
    opponentAutoMoveUci: null,
  }
}

export function useHint(state: TrainingSessionState): TrainingSessionState {
  if (state.phase !== 'awaiting_move') return state
  return { ...state, usedHint: true }
}

export function submitTrainingMove(options: {
  state: TrainingSessionState
  line: Pick<VerifiedLine, 'id' | 'sourceLineId' | 'nodes'>
  graph: PositionGraph
  moveUci: string
}): TrainingSessionState {
  if (options.state.phase !== 'awaiting_move') throw new Error('The session is not waiting for a move')
  const node = nodeById(options.line, options.state.currentNodeId)
  if (!node) throw new Error('The current drill node is missing')
  const feedback = evaluateMove({
    selectedLine: options.line,
    node,
    playedMoveUci: options.moveUci,
    graph: options.graph,
  })
  if (!feedback.legal) {
    return { ...options.state, feedback, incorrectAttempts: options.state.incorrectAttempts + 1 }
  }
  const recalledBook = feedback.classification === 'book'
  const playedPlayableAlternative = feedback.classification === 'playable'
  const canContinueCoherently = feedback.reason === 'exact_book' || feedback.selectedLineResumeNodeId !== null
  const incorrect = (!recalledBook && !playedPlayableAlternative) || !canContinueCoherently
  const incorrectAttempts = options.state.incorrectAttempts + (incorrect ? 1 : 0)
  const suggestedGrade = defaultReviewGrade({
    incorrectAttempts,
    usedHint: options.state.usedHint,
    playedPlayableAlternative,
  })
  return {
    ...options.state,
    phase: incorrect ? 'awaiting_move' : 'answer_ready',
    feedback,
    incorrectAttempts,
    suggestedGrade,
  }
}

export function completeTrainingReview(options: {
  state: TrainingSessionState
  line: Pick<VerifiedLine, 'id' | 'uci' | 'nodes'>
  existingCard: CardProgress | null
  grade?: ReviewGrade
  now: Date
}): CompletedReview {
  if (options.state.phase !== 'answer_ready' || options.state.currentNodeId === null) {
    throw new Error('The session has no answer ready to grade')
  }
  const node = nodeById(options.line, options.state.currentNodeId)
  if (!node) throw new Error('The reviewed node is missing')
  const grade = options.grade ?? options.state.suggestedGrade
  if (!grade) throw new Error('A review grade is required')
  const cardId = `${options.line.id}::${node.id}`
  if (options.existingCard && (
    options.existingCard.cardId !== cardId
    || options.existingCard.lineId !== options.line.id
    || options.existingCard.nodeId !== node.id
  )) {
    throw new Error('Stored card identity does not match the reviewed learner position')
  }
  const existing = options.existingCard ?? createCard(cardId, options.line.id, node.id, options.now)
  const outcome = scheduleReview(existing, grade, options.now)
  const withoutCurrent = options.state.queue.filter((nodeId) => nodeId !== node.id)
  const queue = outcome.repeatAtSessionEnd
    ? enqueueFailedCard(withoutCurrent, node.id)
    : withoutCurrent
  const nextNodeId = queue[0] ?? null
  const nextNode = nodeById(options.line, nextNodeId)
  const opponentAutoMoveUci = nextNode && nextNode.ply === node.ply + 2
    ? options.line.uci[node.ply + 1] ?? null
    : null
  return {
    card: outcome.card,
    appliedGrade: grade,
    repeatAtSessionEnd: outcome.repeatAtSessionEnd,
    state: {
      lineId: options.state.lineId,
      queue,
      currentNodeId: nextNodeId,
      phase: nextNodeId === null ? 'complete' : 'awaiting_move',
      feedback: null,
      usedHint: false,
      incorrectAttempts: 0,
      suggestedGrade: null,
      opponentAutoMoveUci,
    },
  }
}

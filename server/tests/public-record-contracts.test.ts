import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess } from 'chess.js'
import {
  FamilyCoverageCycleEventV1Schema,
  FamilyCoverageEventV1Schema,
  FamilyCursorQuerySchema,
  FamilyTrainingCursorV1Schema,
  FamilyTrainingSyncRequestV1Schema,
} from '../src/family-training-contracts.js'
import { PuzzleRecordV1Schema, type PuzzleRecordV1 } from '../src/puzzle-record.js'
import { DEVICE_ID, tacticalPuzzle } from './helpers.js'

test('family records reject duplicate, cross-pack, and contradictory journal identities', () => {
  const packId = 'caro_kann_black'
  const card = `${packId}::pos_${'a'.repeat(16)}`
  const path = `path_${'a'.repeat(20)}`
  const cursor = {
    schemaVersion: 1, releaseId: 'release-2026q2', familyId: 'caro-kann', side: 'black',
    coverageCycleId: `${packId}::coverage:0`, authoritativeDueCardIds: [card],
    reviewedCardIds: [card], completedPathIds: [path], pendingPathIds: [`path_${'b'.repeat(20)}`], batchIndex: 0,
  }
  assert.equal(FamilyTrainingCursorV1Schema.safeParse(cursor).success, true)
  for (const key of ['authoritativeDueCardIds', 'reviewedCardIds', 'completedPathIds', 'pendingPathIds'] as const) {
    assert.equal(FamilyTrainingCursorV1Schema.safeParse({ ...cursor, [key]: [...cursor[key], ...cursor[key]] }).success, false, key)
  }
  for (const change of [
    { reviewedCardIds: [`${packId}::pos_${'b'.repeat(16)}`] },
    { authoritativeDueCardIds: [`other_pack::pos_${'a'.repeat(16)}`], reviewedCardIds: [] },
    { authoritativeDueCardIds: [`other_pack::pos_${'a'.repeat(16)}`], reviewedCardIds: [`other_pack::pos_${'a'.repeat(16)}`] },
    { pendingPathIds: [path] },
  ]) assert.equal(FamilyTrainingCursorV1Schema.safeParse({ ...cursor, ...change }).success, false)

  const query = { releaseId: cursor.releaseId, familyId: cursor.familyId, side: cursor.side, packId }
  assert.equal(FamilyCursorQuerySchema.safeParse(query).success, true)
  assert.equal(FamilyCursorQuerySchema.safeParse({ ...query, coverageCycleId: cursor.coverageCycleId }).success, true)
  assert.equal(FamilyCursorQuerySchema.safeParse({ ...query, coverageCycleId: 'other_pack::coverage:0' }).success, false)

  const event = {
    schemaVersion: 1, releaseId: cursor.releaseId, familyId: cursor.familyId,
    eventId: DEVICE_ID, packId, pathId: path, coverageCycleId: cursor.coverageCycleId,
    completedAt: '2026-07-14T12:00:00.000Z',
  }
  assert.equal(FamilyCoverageEventV1Schema.safeParse(event).success, true)
  assert.equal(FamilyCoverageEventV1Schema.safeParse({ ...event, coverageCycleId: 'other_pack::coverage:0' }).success, false)
  const binding = {
    schemaVersion: 1, eventId: DEVICE_ID, releaseId: cursor.releaseId, familyId: cursor.familyId,
    side: cursor.side, generationId: DEVICE_ID, generationOrdinal: 0,
    occurredAt: event.completedAt, kind: 'pack_bound', packId, packCoverageCycleId: cursor.coverageCycleId,
  }
  assert.equal(FamilyCoverageCycleEventV1Schema.safeParse(binding).success, true)
  assert.equal(FamilyCoverageCycleEventV1Schema.safeParse({ ...binding, packCoverageCycleId: 'other_pack::coverage:0' }).success, false)
  assert.equal(FamilyTrainingSyncRequestV1Schema.safeParse({ deviceId: DEVICE_ID }).success, true)
  assert.equal(FamilyTrainingSyncRequestV1Schema.safeParse({ deviceId: DEVICE_ID, coverageEvents: [event, event] }).success, false)
  assert.equal(FamilyTrainingSyncRequestV1Schema.safeParse({ deviceId: DEVICE_ID, cycleEvents: [binding, binding] }).success, false)
})

/** Legal synthetic replay; these positions are not promoted puzzle evidence. */
function replayPuzzle(initialFen: string, movesUci: string[]): PuzzleRecordV1 {
  const chess = new Chess(initialFen)
  const move = (uci: string) => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) })
  move(movesUci[0]!)
  const presentationFen = chess.fen()
  const learnerNodes: PuzzleRecordV1['learnerNodes'] = []
  for (let i = 1; i < movesUci.length; i += 2) {
    const fen = chess.fen()
    const epd = fen.split(' ').slice(0, 4).join(' ')
    const forcedReplyUci = movesUci[i + 1] ?? null
    move(movesUci[i]!)
    learnerNodes.push({
      learnerIndex: learnerNodes.length, solutionMoveIndex: i, fen, epd,
      expectedMoveUci: movesUci[i]!, forcedReplyUci, mateInOne: chess.isCheckmate(),
      engineProofRef: `pengine_${String(i).padStart(16, '0')}`,
    })
    if (forcedReplyUci) move(forcedReplyUci)
  }
  return { ...tacticalPuzzle(), initialFen, presentationFen, movesUci, learnerNodes,
    engine: { name: 'Stockfish 18', allLearnerNodesVerified: true, proofRefs: learnerNodes.map(({ engineProofRef }) => engineProofRef) } }
}

test('tactical record validation replays forced replies, special moves, and every learner proof', () => {
  const ordinary = replayPuzzle(tacticalPuzzle().initialFen, ['e7e5', 'g1f3', 'b8c6', 'f1b5'])
  const mate = replayPuzzle('7k/5Q2/6K1/8/8/8/8/r7 b - - 0 1', ['a1a2', 'f7e8'])
  for (const puzzle of [
    ordinary, mate,
    replayPuzzle('7k/1P6/6K1/8/8/8/8/r7 b - - 0 1', ['a1a2', 'b7b8q']),
    replayPuzzle('4k3/8/8/8/8/8/8/4K2R b K - 0 1', ['e8d7', 'e1g1']),
    replayPuzzle('4k3/3p4/8/4P3/8/8/8/4K3 w - - 0 1', ['e1f1', 'd7d5', 'e5d6', 'e8d7']),
    replayPuzzle('4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1', ['d7d5', 'e5d6']),
  ]) assert.equal(PuzzleRecordV1Schema.safeParse(puzzle).success, true, puzzle.initialFen)

  const mutations: Array<[string, (puzzle: PuzzleRecordV1) => void]> = [
    ['missing learner', (p) => { p.learnerNodes.pop(); p.engine.proofRefs.pop() }],
    ['missing proof', (p) => { p.engine.proofRefs.pop() }],
    ['presentation', (p) => { p.presentationFen = p.initialFen }],
    ['learner index', (p) => { p.learnerNodes[0]!.learnerIndex = 1 }],
    ['solution index', (p) => { p.learnerNodes[0]!.solutionMoveIndex = 2 }],
    ['node FEN', (p) => { p.learnerNodes[0]!.fen = p.initialFen }],
    ['node EPD', (p) => { p.learnerNodes[0]!.epd = p.initialFen.split(' ').slice(0, 4).join(' ') }],
    ['expected move', (p) => { p.learnerNodes[0]!.expectedMoveUci = 'g1h3' }],
    ['proof order', (p) => { p.engine.proofRefs.reverse() }],
    ['mate flag', (p) => { p.learnerNodes[0]!.mateInOne = true }],
    ['forced reply', (p) => { p.learnerNodes[0]!.forcedReplyUci = null }],
    ['invalid FEN', (p) => { p.initialFen = 'invalid' }],
    ['illegal setup', (p) => { p.movesUci[0] = 'e7e4' }],
    ['illegal learner', (p) => { p.movesUci[1] = 'g1g4'; p.learnerNodes[0]!.expectedMoveUci = 'g1g4' }],
    ['illegal reply', (p) => { p.movesUci[2] = 'b8b5'; p.learnerNodes[0]!.forcedReplyUci = 'b8b5' }],
  ]
  for (const [name, mutate] of mutations) {
    const puzzle = structuredClone(ordinary)
    mutate(puzzle)
    assert.equal(PuzzleRecordV1Schema.safeParse(puzzle).success, false, name)
  }
  mate.movesUci.push('a2a1')
  mate.learnerNodes[0]!.forcedReplyUci = 'a2a1'
  assert.equal(PuzzleRecordV1Schema.safeParse(mate).success, false, 'a forced reply after checkmate')
})

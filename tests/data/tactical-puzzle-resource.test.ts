import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import {
  TacticalPuzzleResourceSchema,
  createTestOnlyTrustedTacticalPuzzleResource,
  isTrustedTacticalPuzzleResource,
  validateTacticalPuzzleRecords,
  validateTacticalPuzzleResource,
} from '../../src/data/tactical-puzzle-resource.ts'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import { PuzzleRecordV1Schema, type PuzzleRecord } from '../../src/domain/tactical-puzzles.ts'

function apply(chess: Chess, uci: string): void {
  const promotion = uci[4] as PieceSymbol | undefined
  chess.move({
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    ...(promotion ? { promotion } : {}),
  })
}

function puzzle(puzzleId: string): PuzzleRecord {
  const initialFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
  const chess = new Chess(initialFen)
  apply(chess, 'e7e5')
  const presentationFen = chess.fen()
  const proof = 'pengine_0000000000000001'
  return PuzzleRecordV1Schema.parse({
    version: 1,
    puzzleId,
    initialFen,
    presentationFen,
    movesUci: ['e7e5', 'g1f3'],
    learnerNodes: [{
      learnerIndex: 0,
      solutionMoveIndex: 1,
      fen: presentationFen,
      epd: normalizedEpd(chess),
      expectedMoveUci: 'g1f3',
      forcedReplyUci: null,
      mateInOne: false,
      engineProofRef: proof,
    }],
    rating: 1600,
    ratingDeviation: 70,
    attempts: 1_000,
    popularity: 90,
    themes: ['opening'],
    association: { confidence: 'opening-family', taxonomyLineId: null, openingTag: 'Kings_Pawn' },
    source: {
      id: 'lichess-puzzle-database',
      license: 'CC0-1.0',
      sha256: 'a'.repeat(64),
      retrievedAt: '2026-07-20T12:00:00.000Z',
    },
    engine: { name: 'Stockfish 18', allLearnerNodesVerified: true, proofRefs: [proof] },
  })
}

test('resource schema exposes every explicit tactical data state', () => {
  const states = [
    { status: 'disabled', reason: 'No promoted shard.' },
    { status: 'loading' },
    { status: 'empty', reason: 'No matching puzzles.' },
    { status: 'offline', puzzles: [], reason: 'No verified shard is cached.', release: null },
    { status: 'rate-limited', retryAt: '2026-07-20T12:01:00.000Z', retryAfterSeconds: 60, reason: 'Try again shortly.' },
    { status: 'corrupt', reason: 'The puzzle shard failed validation.' },
    { status: 'error', reason: 'The puzzle shard could not be loaded.' },
  ]
  for (const state of states) assert.equal(TacticalPuzzleResourceSchema.safeParse(state).success, true)
})

test('direct validation cannot mint puzzle release trust from caller-provided metadata', () => {
  const record = puzzle('Puzzle1')
  const forged = {
    status: 'ready',
    puzzles: [record],
    release: {
      status: 'pass',
      sourceSha256: record.source.sha256,
      familyPromotionIndexSha256: 'a'.repeat(64),
    },
  }
  assert.equal(TacticalPuzzleResourceSchema.safeParse(forged).success, false)
  assert.throws(() => validateTacticalPuzzleResource(forged))
  assert.throws(() => validateTacticalPuzzleRecords([record, structuredClone(record)]), /Duplicate puzzle ID/u)
  assert.throws(() => validateTacticalPuzzleRecords([{ ...record, movesUci: ['e7e4', 'g1f3'] }]))
})

test('rate-limit and error metadata are bounded and strict', () => {
  assert.equal(TacticalPuzzleResourceSchema.safeParse({
    status: 'rate-limited',
    retryAt: 'not-a-date',
    retryAfterSeconds: 0,
    reason: '',
  }).success, false)
  assert.equal(TacticalPuzzleResourceSchema.safeParse({
    status: 'corrupt',
    reason: 'Corrupt.',
    puzzles: [puzzle('Puzzle1')],
  }).success, false)
})

test('test-only nominal resources are immutable and cannot be cloned or record-swapped', () => {
  const first = puzzle('Puzzle1')
  const second = puzzle('Puzzle2')
  const resource = createTestOnlyTrustedTacticalPuzzleResource({
    puzzles: [first, second],
    collectionIdentity: 'ordered-fixture',
  })
  assert.equal(isTrustedTacticalPuzzleResource(resource), true)
  assert.equal(validateTacticalPuzzleResource(resource), resource)
  assert.equal(Object.isFrozen(resource), true)
  assert.equal(Object.isFrozen(resource.puzzles), true)
  assert.equal(isTrustedTacticalPuzzleResource(structuredClone(resource)), false)
  assert.throws(() => validateTacticalPuzzleResource(structuredClone(resource)))
  assert.equal(TacticalPuzzleResourceSchema.safeParse({
    ...resource,
    puzzles: [second, first],
  }).success, false)
})

test('test-only nominal resources reject production-looking releases and mixed source receipts', () => {
  const first = puzzle('Puzzle1')
  const secondBase = puzzle('Puzzle2')
  const second = {
    ...secondBase,
    source: {
      ...secondBase.source,
      sha256: 'b'.repeat(64),
    },
  }

  assert.throws(() => createTestOnlyTrustedTacticalPuzzleResource({
    puzzles: [first],
    collectionIdentity: 'production-looking-release',
    releaseId: 'release-2026-08',
  }), /explicitly synthetic release ID/u)
  assert.throws(() => createTestOnlyTrustedTacticalPuzzleResource({
    puzzles: [first, second],
    collectionIdentity: 'mixed-source-receipts',
  }), /one source digest/u)

  const explicitFixture = createTestOnlyTrustedTacticalPuzzleResource({
    puzzles: [first],
    collectionIdentity: 'explicit-test-ownership',
    releaseId: 'test-puzzle-review-v2',
    familyId: 'test-kings-pawn',
  })
  assert.equal(explicitFixture.release.releaseId, 'test-puzzle-review-v2')
  assert.equal(explicitFixture.release.familyId, 'test-kings-pawn')
})

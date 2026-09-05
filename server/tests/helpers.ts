import type { ReviewEventV1 } from '../src/contracts.js'
import { PuzzleRecordV1Schema, type PuzzleRecordV1 } from '../src/puzzle-record.js'

export const NOW = new Date('2026-07-14T12:00:00.000Z')
export const DEVICE_ID = '0198a5c0-1000-7000-8000-000000000001'
export const AUDITED_MEMORY_OPTIONS = {
  supportedSnapshots: ['release-2026q2'],
  snapshotMembership: {
    'release-2026q2': [
      { packId: 'pack-e4', nodeId: 'pos_0123456789abcdef', cardId: 'pack-e4::pos_0123456789abcdef' },
      { packId: 'pack-e4', nodeId: 'pos_fedcba9876543210', cardId: 'pack-e4::pos_fedcba9876543210' },
    ],
  },
  puzzleMembership: { 'release-2026q2': ['puzzle-001'] },
  familyMembership: {
    'release-2026q2': [{
      familyId: 'king-pawn',
      packId: 'pack-e4',
      side: 'white' as const,
      pathIds: ['path_0123456789abcdef0123', 'path_fedcba9876543210fedc'],
    }],
  },
} as const

export function reviewEvent(overrides: Partial<ReviewEventV1> = {}): ReviewEventV1 {
  return {
    eventId: '0198a5c0-1000-7000-8000-000000000002',
    deviceId: DEVICE_ID,
    cardId: 'pack-e4::pos_0123456789abcdef',
    packId: 'pack-e4',
    nodeId: 'pos_0123456789abcdef',
    grade: 'good',
    occurredAt: '2026-07-14T11:55:00.000Z',
    localDate: '2026-07-14',
    timeZone: 'America/New_York',
    snapshotVersion: 'release-2026q2',
    ...overrides,
  }
}

export function tacticalPuzzle(puzzleId = 'Puzzle001'): PuzzleRecordV1 {
  const presentationFen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'
  const proof = 'pengine_0000000000000001'
  return PuzzleRecordV1Schema.parse({
    version: 1,
    puzzleId,
    initialFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    presentationFen,
    movesUci: ['e7e5', 'g1f3'],
    learnerNodes: [{
      learnerIndex: 0,
      solutionMoveIndex: 1,
      fen: presentationFen,
      epd: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -',
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
      retrievedAt: '2026-07-14T12:00:00.000Z',
    },
    engine: { name: 'Stockfish 18', allLearnerNodesVerified: true, proofRefs: [proof] },
  })
}

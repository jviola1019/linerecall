import {
  PUZZLE_ENGINE_SETTINGS_SHA256,
  parsePuzzleSourceFields,
  puzzleCandidateFromRow,
} from '../../scripts/data/puzzle-contracts.ts'
import {
  PuzzleV3EvidenceBindingV1Schema,
  PuzzleV3VerifiedEnvelopeV1Schema,
  sha256Json,
} from '../../scripts/data/puzzle-v3-contracts.ts'
import { tacticalPuzzleFromVerifiedEnvelope } from '../../scripts/data/puzzle-v3-promotion.ts'

export function createSyntheticVerifiedPuzzlePromotionEvidence(options: {
  releaseId: string
  familyId: string
  puzzleSourceSha256: string
  broadcastExactReceiptSha256: string
  q2ExactReceiptSha256: string
  graphReconciliationSha256: string
  engineSha256: string
  nnueSha256: string
  engineCampaignSha256?: string
  puzzleId?: string
}) {
  const puzzleId = options.puzzleId ?? 'Puzzle1'
  const parsed = parsePuzzleSourceFields([
    puzzleId,
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    'e7e5 g1f3 b8c6 f1b5',
    '1700',
    '70',
    '95',
    '4000',
    'opening tactic',
    'https://lichess.org/Ab12Cd34/black#2',
    'Synthetic_Opening',
  ])
  if (!parsed.accepted) throw new Error(`Synthetic puzzle source was rejected: ${parsed.reason}`)

  const candidate = puzzleCandidateFromRow(parsed.row, {
    hasExactPosition: () => true,
    taxonomyLineIdsForTag: () => [],
  })
  const { engineStatus: _engineStatus, releaseEligible: _releaseEligible, ...candidateBase } = candidate
  const engineChecks = candidate.learnerNodes.map((node) => ({
    learnerIndex: node.learnerIndex,
    positionEpd: node.epd,
    expectedMoveUci: node.expectedMoveUci,
    engineBestMoveUci: node.expectedMoveUci,
    centipawnLoss: 0,
    mateConsistent: true,
    status: 'pass' as const,
    engine: 'Stockfish 18' as const,
    engineSha256: options.engineSha256,
    nnueSha256: options.nnueSha256,
    settingsSha256: PUZZLE_ENGINE_SETTINGS_SHA256,
    settings: { threads: 1 as const, hashMb: 128 as const, multiPv: 5 as const, nodes: 250_000 as const },
    principalVariationUci: [node.expectedMoveUci],
    analyzedAt: '2026-07-28T11:00:00.000Z',
  }))
  const evidence = PuzzleV3EvidenceBindingV1Schema.parse({
    schemaVersion: 1,
    releaseId: options.releaseId,
    storageModel: 'bounded-two-pass-content-addressed-v3',
    releaseEligible: false,
    puzzleSource: {
      schemaVersion: 3,
      sourceId: 'lichess-puzzle-database',
      sourceUrl: 'https://database.lichess.org/lichess_db_puzzle.csv.zst',
      sourceAsOf: '2026-07-05',
      publishedPuzzleTotal: 6_057_356,
      licenseSpdxId: 'CC0-1.0',
      bytes: 302_111_223,
      sha256: options.puzzleSourceSha256,
      observedEtag: 'synthetic-etag',
      observedLastModified: 'Wed, 01 Jul 2026 08:58:23 GMT',
      digestComputedAt: '2026-07-16T12:00:00.000Z',
      approvedOn: '2026-07-17',
      approvedBy: 'synthetic-fixture',
      selectionSha256: '1'.repeat(64),
    },
    compactEvidence: {
      broadcast: {
        sourceId: 'lichess-broadcasts', sourceManifestSha256: '2'.repeat(64),
        sourceSnapshotSha256: '3'.repeat(64), archiveCount: 78, recordsSeen: 1_146_297,
        accepted: 800_176, deduplicated: 0, rejected: 346_121,
        finalExactReceiptSha256: options.broadcastExactReceiptSha256,
        finalExactStateSha256: '4'.repeat(64), positions: 1, edges: 1, outcomes: 1,
      },
      q2: {
        sourceId: 'lichess-standard-rated-q2-2026', sourceManifestSha256: '5'.repeat(64),
        sourceSnapshotSha256: '3'.repeat(64), archiveCount: 3, recordsSeen: 267_333_507,
        accepted: 200_000_000, deduplicated: 0, rejected: 67_333_507,
        finalExactReceiptSha256: options.q2ExactReceiptSha256,
        finalExactStateSha256: '6'.repeat(64), positions: 1, edges: 1, outcomes: 1,
      },
      sharedSourceSnapshotSha256: '3'.repeat(64),
    },
    familyAssociation: {
      manifestSha256: '7'.repeat(64), databaseSha256: '8'.repeat(64),
      catalogSha256: '9'.repeat(64), graphReconciliationSha256: options.graphReconciliationSha256,
      familyCount: 1, exactPositionAssociations: 1, tagAssociations: 3_790,
    },
    engineCampaign: {
      campaignSha256: options.engineCampaignSha256 ?? 'd'.repeat(64),
      sourceReceiptSha256: 'e'.repeat(64), sourceManifestSha256: 'f'.repeat(64),
      releaseCommit: 'a'.repeat(40), executableSha256: options.engineSha256,
      nnueSha256: [options.nnueSha256], settingsSha256: PUZZLE_ENGINE_SETTINGS_SHA256,
    },
  })
  const evidenceBindingSha256 = sha256Json(evidence)
  const envelope = PuzzleV3VerifiedEnvelopeV1Schema.parse({
    schemaVersion: 1,
    releaseId: options.releaseId,
    evidenceBindingSha256,
    familyIds: [options.familyId],
    record: {
      ...candidateBase,
      engineStatus: 'verified',
      engineChecks,
      releaseEligible: true,
    },
  })
  return {
    evidence,
    evidenceBindingSha256,
    envelope,
    puzzle: tacticalPuzzleFromVerifiedEnvelope(envelope, evidence),
  }
}

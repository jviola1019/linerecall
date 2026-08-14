import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  PUZZLE_ENGINE_SETTINGS_SHA256,
  parsePuzzleSourceLine,
  puzzleCandidateFromRow,
} from '../../scripts/data/puzzle-contracts.ts'
import {
  PuzzleEngineCampaignV1Schema,
  PuzzleFamilyAssociationManifestV1Schema,
  PuzzleV3CandidateManifestV1Schema,
  PuzzleV3EvidenceBindingV1Schema,
  PuzzleV3VerifiedEnvelopeV1Schema,
  sha256Json,
} from '../../scripts/data/puzzle-v3-contracts.ts'
import {
  PuzzlePromotionProofInventoryV1Schema,
  derivePuzzlePromotionReceipt,
  puzzleEngineProofRef,
  tacticalPuzzleFromVerifiedEnvelope,
  validatePromotedPuzzleShardAgainstInventory,
  validatePuzzlePromotionProofInventory,
} from '../../scripts/data/puzzle-v3-promotion.ts'
import { openValidatedPuzzleFamilyAssociation } from '../../scripts/data/puzzle-v3-prerequisites.ts'

const RELEASE = 'release-2026.08.06'
const SNAPSHOT = '9'.repeat(64)
const ENGINE = '1'.repeat(64)
const NNUE = '2'.repeat(64)
const SHARD_SHA = 'a'.repeat(64)
const FAMILY = 'kings-pawn-game'

const validLine = [
  'Ab12C',
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  'e7e5 g1f3',
  '1200',
  '80',
  '90',
  '500',
  'opening short',
  'https://lichess.org/Ab12Cd34/black#2',
  'Kings_Pawn_Game',
].join(',')

function evidence() {
  return PuzzleV3EvidenceBindingV1Schema.parse({
    schemaVersion: 1,
    releaseId: RELEASE,
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
      sha256: '5'.repeat(64),
      observedEtag: 'etag',
      observedLastModified: 'Wed, 01 Jul 2026 08:58:23 GMT',
      digestComputedAt: '2026-07-14T05:13:22.457Z',
      approvedOn: '2026-07-15',
      approvedBy: 'workspace-owner',
      selectionSha256: '6'.repeat(64),
    },
    compactEvidence: {
      broadcast: {
        sourceId: 'lichess-broadcasts',
        sourceManifestSha256: 'b'.repeat(64),
        sourceSnapshotSha256: SNAPSHOT,
        archiveCount: 78,
        recordsSeen: 1_146_297,
        accepted: 800_176,
        deduplicated: 0,
        rejected: 346_121,
        finalExactReceiptSha256: 'c'.repeat(64),
        finalExactStateSha256: 'd'.repeat(64),
        positions: 1,
        edges: 1,
        outcomes: 1,
      },
      q2: {
        sourceId: 'lichess-standard-rated-q2-2026',
        sourceManifestSha256: 'e'.repeat(64),
        sourceSnapshotSha256: SNAPSHOT,
        archiveCount: 3,
        recordsSeen: 267_333_507,
        accepted: 267_000_000,
        deduplicated: 333_507,
        rejected: 0,
        finalExactReceiptSha256: 'f'.repeat(64),
        finalExactStateSha256: '0'.repeat(64),
        positions: 1,
        edges: 1,
        outcomes: 1,
      },
      sharedSourceSnapshotSha256: SNAPSHOT,
    },
    familyAssociation: {
      manifestSha256: '3'.repeat(64),
      databaseSha256: '4'.repeat(64),
      catalogSha256: '7'.repeat(64),
      graphReconciliationSha256: '8'.repeat(64),
      familyCount: 1,
      exactPositionAssociations: 1,
      tagAssociations: 3_790,
    },
    engineCampaign: {
      campaignSha256: 'a'.repeat(64),
      sourceReceiptSha256: 'b'.repeat(64),
      sourceManifestSha256: 'c'.repeat(64),
      releaseCommit: 'd'.repeat(40),
      executableSha256: ENGINE,
      nnueSha256: [NNUE],
      settingsSha256: PUZZLE_ENGINE_SETTINGS_SHA256,
    },
  })
}

function verifiedEnvelope() {
  const parsed = parsePuzzleSourceLine(validLine)
  assert.equal(parsed.accepted, true)
  if (!parsed.accepted) throw new Error('fixture failed')
  const candidate = puzzleCandidateFromRow(parsed.row, {
    hasExactPosition: () => true,
    taxonomyLineIdsForTag: () => [],
  })
  const { engineStatus: _engineStatus, releaseEligible: _releaseEligible, ...base } = candidate
  const proof = {
    learnerIndex: candidate.learnerNodes[0]!.learnerIndex,
    positionEpd: candidate.learnerNodes[0]!.epd,
    expectedMoveUci: candidate.learnerNodes[0]!.expectedMoveUci,
    engineBestMoveUci: candidate.learnerNodes[0]!.expectedMoveUci,
    centipawnLoss: 0,
    mateConsistent: true,
    status: 'pass' as const,
    engine: 'Stockfish 18' as const,
    engineSha256: ENGINE,
    nnueSha256: NNUE,
    settingsSha256: PUZZLE_ENGINE_SETTINGS_SHA256,
    settings: { threads: 1 as const, hashMb: 128 as const, multiPv: 5 as const, nodes: 250_000 as const },
    principalVariationUci: [candidate.learnerNodes[0]!.expectedMoveUci],
    analyzedAt: '2026-08-06T12:00:00.000Z',
  }
  const bound = evidence()
  return PuzzleV3VerifiedEnvelopeV1Schema.parse({
    schemaVersion: 1,
    releaseId: RELEASE,
    evidenceBindingSha256: sha256Json(bound),
    familyIds: [FAMILY],
    record: {
      ...base,
      engineStatus: 'verified',
      engineChecks: [proof],
      releaseEligible: true,
    },
  })
}

function inventory() {
  const bound = evidence()
  return PuzzlePromotionProofInventoryV1Schema.parse({
    schemaVersion: 1,
    releaseId: RELEASE,
    generatedAt: '2026-08-06T12:00:00.000Z',
    evidence: bound,
    evidenceBindingSha256: sha256Json(bound),
    shards: [{ shardSha256: SHARD_SHA, familyIds: [FAMILY], verified: [verifiedEnvelope()] }],
  })
}

function tacticalShard() {
  return {
    schemaVersion: 1 as const,
    id: `blob_${SHARD_SHA.slice(0, 16)}`,
    releaseId: RELEASE,
    generatedAt: '2026-08-06T12:00:00.000Z',
    familyIds: [FAMILY],
    puzzles: [tacticalPuzzleFromVerifiedEnvelope(verifiedEnvelope(), evidence())],
  }
}

test('candidate manifest accounting is exact, association-consistent, and safe', () => {
  const bound = evidence()
  const base = {
    schemaVersion: 1 as const,
    releaseId: RELEASE,
    generatedAt: '2026-08-06T12:00:00.000Z',
    releaseEligible: false as const,
    evidence: bound,
    evidenceBindingSha256: sha256Json(bound),
    selection: {
      openingTagsRequired: true as const,
      minimumPlays: 100 as const,
      minimumPopularity: 80 as const,
      maximumRatingDeviation: 100 as const,
      minimumLearnerDecisions: 1 as const,
      maximumLearnerDecisions: 5 as const,
      legalStandardChessRequired: true as const,
      engineSanityCheckRequired: true as const,
      sourceGameBulkFetchProhibited: true as const,
    },
    totals: {
      rowsSeen: 3,
      candidates: 1,
      duplicates: 1,
      rejected: { unlinked_association: 1 },
      association: { 'exact-position': 1, 'opening-family': 0, unlinked: 1 },
    },
    candidates: {
      path: 'candidates.ndjson.gz' as const,
      bytes: 100,
      sha256: '7'.repeat(64),
      contentEncoding: 'gzip' as const,
      recordSchema: 'PuzzleV3CandidateEnvelopeV1' as const,
    },
    blockedGates: ['stockfish-proof-per-learner-node', 'promoted-tactical-shards'] as const,
  }
  assert.equal(PuzzleV3CandidateManifestV1Schema.safeParse(base).success, true)
  assert.equal(PuzzleV3CandidateManifestV1Schema.safeParse({
    ...base, totals: { ...base.totals, rowsSeen: 4 },
  }).success, false)
  assert.equal(PuzzleV3CandidateManifestV1Schema.safeParse({
    ...base, totals: { ...base.totals, rejected: {}, association: { ...base.totals.association, unlinked: 1 } },
  }).success, false)
  assert.equal(PuzzleV3CandidateManifestV1Schema.safeParse({
    ...base,
    totals: {
      ...base.totals,
      rowsSeen: Number.MAX_SAFE_INTEGER,
      rejected: { malformed_csv: Number.MAX_SAFE_INTEGER, invalid_id: 1 },
    },
  }).success, false)
})

test('new prerequisite receipts require canonical repository-relative paths', () => {
  const association = {
    schemaVersion: 1,
    releaseId: RELEASE,
    status: 'complete',
    generatedAt: '2026-08-06T12:00:00.000Z',
    database: { path: 'data/generated/association.sqlite', bytes: 1, sha256: '1'.repeat(64) },
    compactEvidence: {
      broadcastFinalExactStateSha256: '2'.repeat(64),
      broadcastFinalExactReceiptSha256: '3'.repeat(64),
      q2FinalExactStateSha256: '4'.repeat(64),
      q2FinalExactReceiptSha256: '5'.repeat(64),
      sourceSnapshotSha256: '6'.repeat(64),
    },
    familyEvidence: {
      catalogSha256: '7'.repeat(64), graphReconciliationSha256: '8'.repeat(64),
      taxonomyLineCount: 3_790, familyCount: 1, exactPositionAssociations: 1, tagAssociations: 1,
      allTaxonomyRowsAssigned: true, allEligibleEdgesRepresented: true,
      topNPracticeCutoffApplied: false, hiddenEligiblePracticeBranches: 0,
    },
  }
  assert.equal(PuzzleFamilyAssociationManifestV1Schema.safeParse(association).success, true)
  assert.equal(PuzzleFamilyAssociationManifestV1Schema.safeParse({
    ...association, database: { ...association.database, path: 'data//association.sqlite' },
  }).success, false)
  const campaign = {
    schemaVersion: 1,
    releaseId: RELEASE,
    status: 'ready-for-analysis',
    verifiedAt: '2026-08-06T12:00:00.000Z',
    engine: {
      name: 'Stockfish 18', releaseCommit: 'a'.repeat(40), sourceManifestSha256: 'b'.repeat(64),
      executableSha256: ENGINE, nnueSha256: [NNUE],
      settings: { threads: 1, hashMb: 128, multiPv: 5, nodes: 250_000 },
      settingsSha256: PUZZLE_ENGINE_SETTINGS_SHA256,
    },
    sourceReceipt: { path: 'data/generated/provision.json', bytes: 1, sha256: 'c'.repeat(64) },
  }
  assert.equal(PuzzleEngineCampaignV1Schema.safeParse(campaign).success, true)
  assert.equal(PuzzleEngineCampaignV1Schema.safeParse({
    ...campaign, sourceReceipt: { ...campaign.sourceReceipt, path: 'data/../provision.json' },
  }).success, false)
})

test('promotion pass is derived from full proofs and exact shipped proof references', () => {
  const promoted = tacticalShard()
  const proofInventory = inventory()
  assert.doesNotThrow(() => validatePuzzlePromotionProofInventory(proofInventory))
  assert.doesNotThrow(() => validatePromotedPuzzleShardAgainstInventory({
    shardSha256: SHARD_SHA,
    shard: promoted,
    inventory: proofInventory,
  }))
  const receipt = derivePuzzlePromotionReceipt({
    inventory: proofInventory,
    promotedShards: [{ sha256: SHARD_SHA, shard: promoted }],
    proofInventory: {
      path: 'data/generated/v3/puzzles/proof-inventory.json.gz',
      sha256: 'b'.repeat(64),
      bytes: 100,
      uncompressedBytes: 200,
      encoding: 'gzip',
    },
    completedAt: '2026-08-06T13:00:00.000Z',
  })
  assert.equal(receipt.engineChecksComplete, true)
  assert.equal(receipt.promotedPuzzleCount, 1)
  assert.equal(receipt.evidenceBindingSha256, proofInventory.evidenceBindingSha256)
  assert.equal(
    promoted.puzzles[0]!.engine.proofRefs[0],
    puzzleEngineProofRef(verifiedEnvelope().record.engineChecks[0]!),
  )
  assert.throws(() => derivePuzzlePromotionReceipt({
    inventory: proofInventory,
    promotedShards: [{ sha256: SHARD_SHA, shard: promoted }],
    proofInventory: {
      path: 'data//proof-inventory.json.gz', sha256: 'b'.repeat(64),
      bytes: 100, uncompressedBytes: 200, encoding: 'gzip',
    },
    completedAt: '2026-08-06T13:00:00.000Z',
  }))
})

test('promotion rejects arbitrary proof references, missing envelopes, and cross-campaign proofs', () => {
  const arbitrary = structuredClone(tacticalShard())
  const arbitraryRef = `pengine_${'f'.repeat(16)}`
  arbitrary.puzzles[0]!.engine.proofRefs[0] = arbitraryRef
  arbitrary.puzzles[0]!.learnerNodes[0]!.engineProofRef = arbitraryRef
  assert.throws(() => validatePromotedPuzzleShardAgainstInventory({
    shardSha256: SHARD_SHA, shard: arbitrary, inventory: inventory(),
  }), /differs from its verified proof envelope/u)

  const missing = structuredClone(inventory())
  missing.shards[0]!.verified[0]!.record.puzzleId = 'Other1'
  assert.throws(() => validatePromotedPuzzleShardAgainstInventory({
    shardSha256: SHARD_SHA, shard: tacticalShard(), inventory: missing,
  }), /no verified envelope/u)

  const crossCampaign = structuredClone(inventory())
  crossCampaign.evidence.engineCampaign.executableSha256 = 'e'.repeat(64)
  crossCampaign.evidenceBindingSha256 = sha256Json(crossCampaign.evidence)
  for (const envelope of crossCampaign.shards[0]!.verified) {
    envelope.evidenceBindingSha256 = crossCampaign.evidenceBindingSha256
  }
  assert.throws(
    () => validatePuzzlePromotionProofInventory(crossCampaign),
    /engine proof outside the approved campaign/u,
  )

  const noProof = structuredClone(verifiedEnvelope())
  noProof.record.engineChecks = []
  assert.equal(PuzzleV3VerifiedEnvelopeV1Schema.safeParse(noProof).success, false)
})

function writeAssociationDatabase(path: string, epd: string): void {
  const database = new DatabaseSync(path)
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE puzzle_family_metadata (
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        release_id TEXT NOT NULL,
        status TEXT NOT NULL,
        broadcast_final_exact_state_sha256 TEXT NOT NULL,
        broadcast_final_exact_receipt_sha256 TEXT NOT NULL,
        q2_final_exact_state_sha256 TEXT NOT NULL,
        q2_final_exact_receipt_sha256 TEXT NOT NULL,
        source_snapshot_sha256 TEXT NOT NULL,
        family_catalog_sha256 TEXT NOT NULL,
        graph_reconciliation_sha256 TEXT NOT NULL,
        exact_position_associations INTEGER NOT NULL,
        tag_associations INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE puzzle_family_positions (epd TEXT NOT NULL, family_id TEXT NOT NULL) STRICT;
      CREATE TABLE puzzle_family_tags (tag TEXT NOT NULL, taxonomy_line_id TEXT NOT NULL, family_id TEXT NOT NULL) STRICT;
    `)
    database.prepare(`
      INSERT INTO puzzle_family_metadata VALUES (1, 1, ?, 'complete', ?, ?, ?, ?, ?, ?, ?, 1, 3790)
    `).run(RELEASE, '2'.repeat(64), '3'.repeat(64), '4'.repeat(64), '5'.repeat(64), '6'.repeat(64), '7'.repeat(64), '8'.repeat(64))
    database.prepare('INSERT INTO puzzle_family_positions VALUES (?, ?)').run(epd, FAMILY)
    const insertTag = database.prepare('INSERT INTO puzzle_family_tags VALUES (?, ?, ?)')
    database.exec('BEGIN IMMEDIATE')
    for (let index = 0; index < 3_790; index += 1) {
      insertTag.run(`Tag_${index}`, `tax_${index.toString(16).padStart(24, '0')}`, FAMILY)
    }
    database.exec('COMMIT')
  } finally {
    database.close()
  }
}

async function associationManifestFor(path: string) {
  const bytes = await readFile(path)
  return {
    schemaVersion: 1 as const,
    releaseId: RELEASE,
    status: 'complete' as const,
    generatedAt: '2026-08-06T12:00:00.000Z',
    database: {
      path: 'association.sqlite',
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    compactEvidence: {
      broadcastFinalExactStateSha256: '2'.repeat(64),
      broadcastFinalExactReceiptSha256: '3'.repeat(64),
      q2FinalExactStateSha256: '4'.repeat(64),
      q2FinalExactReceiptSha256: '5'.repeat(64),
      sourceSnapshotSha256: '6'.repeat(64),
    },
    familyEvidence: {
      catalogSha256: '7'.repeat(64), graphReconciliationSha256: '8'.repeat(64),
      taxonomyLineCount: 3_790 as const, familyCount: 1,
      exactPositionAssociations: 1, tagAssociations: 3_790,
      allTaxonomyRowsAssigned: true as const, allEligibleEdgesRepresented: true as const,
      topNPracticeCutoffApplied: false as const, hiddenEligiblePracticeBranches: 0 as const,
    },
  }
}

test('association database is validated by content before and after SQLite inspection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-puzzle-association-'))
  const live = join(root, 'association.sqlite')
  const replacement = join(root, 'replacement.sqlite')
  try {
    writeAssociationDatabase(live, '8/8/8/8/8/8/8/K6k w - -')
    const manifest = await associationManifestFor(live)
    const association = await openValidatedPuzzleFamilyAssociation({ root, manifest })
    assert.equal(association.hasExactPosition('8/8/8/8/8/8/8/K6k w - -'), true)
    assert.deepEqual(association.familyIdsForAssociation({
      confidence: 'exact-position', positionEpd: '8/8/8/8/8/8/8/K6k w - -', taxonomyLineId: null, openingTag: null,
    }), [FAMILY])
    association.close()

    writeAssociationDatabase(replacement, '8/8/8/8/8/8/8/K5k1 w - -')
    await assert.rejects(() => openValidatedPuzzleFamilyAssociation({
      root,
      manifest,
      afterInitialDigest: async () => {
        await unlink(live)
        await rename(replacement, live)
      },
    }), /SHA-256|byte length/u)
    assert.equal((await stat(live)).isFile(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

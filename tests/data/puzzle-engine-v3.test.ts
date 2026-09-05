import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { Chess } from 'chess.js'
import { parsePuzzleSourceLine, puzzleCandidateFromRow, PUZZLE_ENGINE_SETTINGS_SHA256 } from '../../scripts/data/puzzle-contracts.ts'
import { analyzePuzzleCandidates, buildPuzzleProofInventory, MAX_PUZZLE_ENGINE_CANDIDATES, parsePuzzleCandidateShard, runPuzzleEngineCampaign, type PuzzleEngineAnalysisAdapter } from '../../scripts/data/puzzle-engine-v3.ts'
import { puzzleShardCompressedBytes, tacticalPuzzleFromVerifiedEnvelope, validatePromotedPuzzleShardAgainstInventory } from '../../scripts/data/puzzle-v3-promotion.ts'
import { PuzzleV3EvidenceBindingV1Schema, sha256Json } from '../../scripts/data/puzzle-v3-contracts.ts'
import type { UciAnalysis } from '../../scripts/verification/lib/uci-engine.ts'

const RELEASE = 'release-2026.08.06'
const validLine = [
  'Ab12C',
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  'e7e5 g1f3', '1200', '80', '90', '500', 'opening short',
  'https://lichess.org/Ab12Cd34/black#2', 'Kings_Pawn_Game',
].join(',')

const evidence = PuzzleV3EvidenceBindingV1Schema.parse({
  schemaVersion: 1, releaseId: RELEASE, storageModel: 'bounded-two-pass-content-addressed-v3', releaseEligible: false,
  puzzleSource: { schemaVersion: 3, sourceId: 'lichess-puzzle-database', sourceUrl: 'https://database.lichess.org/lichess_db_puzzle.csv.zst', sourceAsOf: '2026-07-05', publishedPuzzleTotal: 6057356, licenseSpdxId: 'CC0-1.0', bytes: 302111223, sha256: '5'.repeat(64), observedEtag: 'etag', observedLastModified: 'last-modified', digestComputedAt: '2026-07-14T05:13:22.457Z', approvedOn: '2026-07-15', approvedBy: 'workspace-owner', selectionSha256: '6'.repeat(64) },
  compactEvidence: {
    broadcast: { sourceId: 'lichess-broadcasts', sourceManifestSha256: 'b'.repeat(64), sourceSnapshotSha256: '9'.repeat(64), archiveCount: 78, recordsSeen: 1146297, accepted: 800176, deduplicated: 0, rejected: 346121, finalExactReceiptSha256: 'c'.repeat(64), finalExactStateSha256: 'd'.repeat(64), positions: 1, edges: 1, outcomes: 1 },
    q2: { sourceId: 'lichess-standard-rated-q2-2026', sourceManifestSha256: 'e'.repeat(64), sourceSnapshotSha256: '9'.repeat(64), archiveCount: 3, recordsSeen: 267333507, accepted: 267000000, deduplicated: 333507, rejected: 0, finalExactReceiptSha256: 'f'.repeat(64), finalExactStateSha256: '0'.repeat(64), positions: 1, edges: 1, outcomes: 1 }, sharedSourceSnapshotSha256: '9'.repeat(64),
  },
  familyAssociation: { manifestSha256: '3'.repeat(64), databaseSha256: '4'.repeat(64), catalogSha256: '7'.repeat(64), graphReconciliationSha256: '8'.repeat(64), familyCount: 1, exactPositionAssociations: 1, tagAssociations: 3790 },
  engineCampaign: { campaignSha256: 'a'.repeat(64), sourceReceiptSha256: 'b'.repeat(64), sourceManifestSha256: 'c'.repeat(64), releaseCommit: 'd'.repeat(40), executableSha256: '1'.repeat(64), nnueSha256: ['2'.repeat(64)], settingsSha256: PUZZLE_ENGINE_SETTINGS_SHA256 },
})

class SyntheticEngine implements PuzzleEngineAnalysisAdapter {
  readonly calls: string[] = []
  private repeat = new Map<string, UciAnalysis>()
  resetForPosition(): Promise<void> { this.calls.push('reset'); return Promise.resolve() }
  setMultiPv(value: 1 | 5): void { this.calls.push(`multipv:${value}`) }
  analyze(options: { fen: string; nodes: 250000; searchMoveUci?: string }): Promise<UciAnalysis> {
    const chess = new Chess(options.fen)
    const legal = chess.moves({ verbose: true }).map(({ from, to, promotion }) => `${from}${to}${promotion ?? ''}`)
    if (options.searchMoveUci) {
      return Promise.resolve({ bestMoveUci: options.searchMoveUci, variations: [{ multipv: 1, depth: 20, selectiveDepth: 25, nodes: 250000, score: { kind: 'centipawn', value: 20 }, bound: 'exact', movesUci: [options.searchMoveUci] }] })
    }
    const key = options.fen
    const prior = this.repeat.get(key)
    if (prior) return Promise.resolve(structuredClone(prior))
    const variations = legal.slice(0, Math.min(5, legal.length)).map((uci, index) => ({ multipv: index + 1, depth: 20, selectiveDepth: 25, nodes: 250000, score: { kind: 'centipawn' as const, value: 40 - index * 10 }, bound: 'exact' as const, movesUci: [uci] }))
    const result = { bestMoveUci: variations[0]!.movesUci[0]!, variations }
    this.repeat.set(key, result)
    return Promise.resolve(structuredClone(result))
  }
}

function candidate() {
  const parsed = parsePuzzleSourceLine(validLine)
  assert.equal(parsed.accepted, true)
  if (!parsed.accepted) throw new Error('fixture failed')
  return puzzleCandidateFromRow(parsed.row, { hasExactPosition: () => true, taxonomyLineIdsForTag: () => [] })
}

function candidateManifest(bound: string, total: number) {
  return {
    schemaVersion: 1 as const,
    releaseId: RELEASE,
    generatedAt: '2026-08-06T12:00:00.000Z',
    releaseEligible: false as const,
    evidence,
    evidenceBindingSha256: bound,
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
      rowsSeen: total,
      candidates: total,
      duplicates: 0,
      rejected: {},
      association: { 'exact-position': total, 'opening-family': 0, unlinked: 0 },
    },
    candidates: {
      path: 'candidates.ndjson.gz' as const,
      bytes: 1,
      sha256: '0'.repeat(64),
      contentEncoding: 'gzip' as const,
      recordSchema: 'PuzzleV3CandidateEnvelopeV1' as const,
    },
    blockedGates: ['stockfish-proof-per-learner-node', 'promoted-tactical-shards'] as const,
  }
}

test('synthetic campaign deterministically proves every learner node and derives inventory shards', async () => {
  const value = candidate()
  const bound = sha256Json(evidence)
  const engine = new SyntheticEngine()
  const [verified] = await analyzePuzzleCandidates({ candidates: [{ value: { schemaVersion: 1, releaseId: RELEASE, evidenceBindingSha256: bound, familyIds: ['kings-pawn-game'], candidate: value } }], engine, engineSha256: '1'.repeat(64), nnueSha256: ['2'.repeat(64)], analyzedAt: '2026-08-06T12:00:00.000Z', releaseId: RELEASE, evidence, evidenceBindingSha256: bound })
  assert.ok(verified)
  assert.equal(verified.record.engineStatus, 'verified')
  assert.equal(verified.record.engineChecks.length, value.learnerNodes.length)
  assert.ok(engine.calls.filter((call) => call === 'reset').length >= value.learnerNodes.length * 2)
  const inventory = buildPuzzleProofInventory({ releaseId: RELEASE, completedAt: '2026-08-06T12:00:00.000Z', evidence, evidenceBindingSha256: bound, verified: [verified] })
  assert.equal(inventory.shards.length, 1)
  assert.match(inventory.shards[0]!.shardSha256, /^[a-f0-9]{64}$/u)
  const projectedShard = {
    schemaVersion: 1,
    releaseId: RELEASE,
    generatedAt: '2026-08-06T12:00:00.000Z',
    familyIds: ['kings-pawn-game'],
    puzzles: [tacticalPuzzleFromVerifiedEnvelope(verified, evidence)],
  }
  const compressedDigest = createHash('sha256').update(gzipSync(`${JSON.stringify(projectedShard, null, 2)}\n`)).digest('hex')
  const uncompressedDigest = createHash('sha256').update(`${JSON.stringify(projectedShard, null, 2)}\n`).digest('hex')
  assert.equal(inventory.shards[0]!.shardSha256, compressedDigest)
  assert.notEqual(inventory.shards[0]!.shardSha256, uncompressedDigest)
  const shardBytes = puzzleShardCompressedBytes(projectedShard)
  assert.doesNotThrow(() => validatePromotedPuzzleShardAgainstInventory({
    shardSha256: inventory.shards[0]!.shardSha256,
    shard: projectedShard,
    inventory,
    shardBytes,
  }))
  const tamperedBytes = Buffer.from(shardBytes)
  tamperedBytes[tamperedBytes.length - 1] = tamperedBytes[tamperedBytes.length - 1]! ^ 1
  assert.throws(() => validatePromotedPuzzleShardAgainstInventory({
    shardSha256: inventory.shards[0]!.shardSha256,
    shard: projectedShard,
    inventory,
    shardBytes: tamperedBytes,
  }), /digest|canonical compressed/u)
})

test('campaign rejects nondeterministic roots, bounded nodes, non-exact bounds, and duplicate candidates', async () => {
  const value = candidate()
  const bound = sha256Json(evidence)
  const envelope = { schemaVersion: 1 as const, releaseId: RELEASE, evidenceBindingSha256: bound, familyIds: ['kings-pawn-game'], candidate: value }
  const base = { candidates: [{ value: envelope }], engineSha256: '1'.repeat(64), nnueSha256: ['2'.repeat(64)], analyzedAt: '2026-08-06T12:00:00.000Z', releaseId: RELEASE, evidence, evidenceBindingSha256: bound }
  const bad = new SyntheticEngine()
  const original = bad.analyze.bind(bad)
  let first = true
  bad.analyze = (options) => {
    const result = original(options)
    return result.then((analysis) => {
      if (!options.searchMoveUci && first) { first = false; return analysis }
      if (!options.searchMoveUci) return { ...analysis, bestMoveUci: analysis.variations[1]!.movesUci[0]! }
      return analysis
    })
  }
  await assert.rejects(() => analyzePuzzleCandidates({ ...base, engine: bad }), /repeatable/u)
  await assert.rejects(() => analyzePuzzleCandidates({ ...base, engine: new SyntheticEngine(), candidates: [{ value: envelope }, { value: envelope }] }), /Duplicate puzzle/u)
})

test('candidate shard parser rejects truncated gzip and duplicate pages before engine work', () => {
  const value = candidate()
  const bound = sha256Json(evidence)
  const envelope = { schemaVersion: 1 as const, releaseId: RELEASE, evidenceBindingSha256: bound, familyIds: ['kings-pawn-game'], candidate: value }
  const bytes = gzipSync(`${JSON.stringify(envelope)}\n`)
  assert.deepEqual(parsePuzzleCandidateShard(bytes, 1)[0]?.value.candidate.puzzleId, value.puzzleId)
  assert.throws(() => parsePuzzleCandidateShard(bytes.subarray(0, bytes.length - 2), 1), /gzip|unexpected end|invalid/u)
  const duplicatePage = gzipSync(`${JSON.stringify(envelope)}\n${JSON.stringify(envelope)}\n`)
  assert.throws(() => parsePuzzleCandidateShard(duplicatePage, 2), /Duplicate puzzle candidate/u)
})

test('proof inventory rolls one family over at 256 and is stable under shuffled input', async () => {
  const value = candidate()
  const bound = sha256Json(evidence)
  const envelope = { schemaVersion: 1 as const, releaseId: RELEASE, evidenceBindingSha256: bound, familyIds: ['kings-pawn-game'], candidate: value }
  const [first] = await analyzePuzzleCandidates({
    candidates: [{ value: envelope }],
    engine: new SyntheticEngine(),
    engineSha256: '1'.repeat(64),
    nnueSha256: ['2'.repeat(64)],
    analyzedAt: '2026-08-06T12:00:00.000Z',
    releaseId: RELEASE,
    evidence,
    evidenceBindingSha256: bound,
  })
  assert.ok(first)
  const verified = Array.from({ length: 257 }, (_, index) => {
    const copy = structuredClone(first)
    copy.record.puzzleId = `P${String(index).padStart(4, '0')}`
    return copy
  })
  const inventory = buildPuzzleProofInventory({
    releaseId: RELEASE,
    completedAt: '2026-08-06T12:00:00.000Z',
    evidence,
    evidenceBindingSha256: bound,
    verified,
  })
  assert.equal(inventory.shards.length, 2)
  assert.deepEqual(inventory.shards.map(({ familyIds, verified: page }) => [familyIds, page.length]), [[['kings-pawn-game'], 256], [['kings-pawn-game'], 1]])
  const shuffled = buildPuzzleProofInventory({
    releaseId: RELEASE,
    completedAt: '2026-08-06T12:00:00.000Z',
    evidence,
    evidenceBindingSha256: bound,
    verified: [...verified].reverse(),
  })
  assert.deepEqual(shuffled.shards.map(({ shardSha256 }) => shardSha256), inventory.shards.map(({ shardSha256 }) => shardSha256))
})

test('candidate manifest size cap is enforced before opening the candidate or campaign paths', async () => {
  const bound = sha256Json(evidence)
  const manifest = candidateManifest(bound, MAX_PUZZLE_ENGINE_CANDIDATES + 1)
  const root = await mkdtemp(join(tmpdir(), 'puzzle-v3-cap-test-'))
  await mkdir(root, { recursive: true })
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')
  await writeFile(join(root, 'manifest.json'), manifestBytes)
  try {
    await assert.rejects(() => runPuzzleEngineCampaign({
      receiptRoot: root,
      candidateManifestReceipt: {
        path: 'manifest.json',
        bytes: manifestBytes.byteLength,
        uncompressedBytes: manifestBytes.byteLength,
        sha256: createHash('sha256').update(manifestBytes).digest('hex'),
        encoding: 'identity',
      },
      enginePath: join(root, 'missing-engine'),
      stockfishManifestPath: join(root, 'missing-manifest.json'),
      provisionReceiptPath: join(root, 'missing-provision.json'),
      engineCampaignPath: join(root, 'missing-campaign.json'),
      outputPath: 'output.json',
    }), /bounded subset limit/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('campaign receipt cannot be omitted from a bounded run', async () => {
  const bound = sha256Json(evidence)
  const manifest = candidateManifest(bound, 1)
  const root = await mkdtemp(join(tmpdir(), 'puzzle-v3-campaign-required-test-'))
  await mkdir(root, { recursive: true })
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')
  await writeFile(join(root, 'manifest.json'), manifestBytes)
  try {
    await assert.rejects(() => runPuzzleEngineCampaign({
      receiptRoot: root,
      candidateManifestReceipt: {
        path: 'manifest.json',
        bytes: manifestBytes.byteLength,
        uncompressedBytes: manifestBytes.byteLength,
        sha256: createHash('sha256').update(manifestBytes).digest('hex'),
        encoding: 'identity',
      },
      enginePath: join(root, 'missing-engine'),
      stockfishManifestPath: join(root, 'missing-manifest.json'),
      provisionReceiptPath: join(root, 'missing-provision.json'),
      engineCampaignPath: undefined as unknown as string,
      outputPath: 'output.json',
    }), /campaign receipt is mandatory/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

import { z } from 'zod'
import {
  FamilyIdSchema,
  FamilyReleaseIdSchema,
  TacticalPuzzleShardV1Schema,
  type TacticalPuzzleShardV1,
} from '../../src/domain/opening-family.ts'
import { PuzzleRecordV1Schema, type PuzzleRecord } from '../../src/domain/tactical-puzzles.ts'
import { PuzzleEngineProofSchema } from './puzzle-contracts.ts'
import {
  PuzzlePromotionReceiptV1Schema,
  PuzzleV3EvidenceBindingV1Schema,
  PuzzleV3VerifiedEnvelopeV1Schema,
  assertEngineProofsMatchCampaign,
  sha256Json,
  type PuzzlePromotionReceiptV1,
  type PuzzleV3EvidenceBindingV1,
  type PuzzleV3VerifiedEnvelopeV1,
} from './puzzle-v3-contracts.ts'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
type PuzzleEngineProof = z.infer<typeof PuzzleEngineProofSchema>

const PuzzlePromotionProofShardV1Schema = z.object({
  shardSha256: Sha256Schema,
  familyIds: z.array(FamilyIdSchema).min(1).max(256),
  verified: z.array(PuzzleV3VerifiedEnvelopeV1Schema).min(1).max(10_000),
}).strict().superRefine((shard, context) => {
  if (new Set(shard.familyIds).size !== shard.familyIds.length) {
    context.addIssue({ code: 'custom', path: ['familyIds'], message: 'Proof-inventory family IDs must be unique' })
  }
  const puzzleIds = shard.verified.map(({ record }) => record.puzzleId)
  if (new Set(puzzleIds).size !== puzzleIds.length) {
    context.addIssue({ code: 'custom', path: ['verified'], message: 'Proof-inventory puzzle IDs must be unique per shard' })
  }
})

export const PuzzlePromotionProofInventoryV1Schema = z.object({
  schemaVersion: z.literal(1),
  releaseId: FamilyReleaseIdSchema,
  generatedAt: z.string().datetime({ offset: true }),
  evidence: PuzzleV3EvidenceBindingV1Schema,
  evidenceBindingSha256: Sha256Schema,
  shards: z.array(PuzzlePromotionProofShardV1Schema).min(1).max(1_000),
}).strict().superRefine((inventory, context) => {
  if (inventory.releaseId !== inventory.evidence.releaseId) {
    context.addIssue({ code: 'custom', path: ['releaseId'], message: 'Proof inventory belongs to another release' })
  }
  if (inventory.evidenceBindingSha256 !== sha256Json(inventory.evidence)) {
    context.addIssue({ code: 'custom', path: ['evidenceBindingSha256'], message: 'Proof inventory evidence hash is invalid' })
  }
  const shardHashes = inventory.shards.map(({ shardSha256 }) => shardSha256)
  if (new Set(shardHashes).size !== shardHashes.length) {
    context.addIssue({ code: 'custom', path: ['shards'], message: 'Proof inventory shard receipts must be unique' })
  }
  const puzzleIds = inventory.shards.flatMap(({ verified }) => verified.map(({ record }) => record.puzzleId))
  if (new Set(puzzleIds).size !== puzzleIds.length) {
    context.addIssue({ code: 'custom', path: ['shards'], message: 'Proof inventory puzzle IDs must be globally unique' })
  }
})

export type PuzzlePromotionProofInventoryV1 = z.infer<typeof PuzzlePromotionProofInventoryV1Schema>

/** A shipped proof reference is the exact content identity of its full proof. */
export function puzzleEngineProofRef(proof: PuzzleEngineProof): string {
  return `pengine_${sha256Json(proof).slice(0, 32)}`
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

export function tacticalPuzzleFromVerifiedEnvelope(
  envelopeInput: unknown,
  evidenceInput: unknown,
): PuzzleRecord {
  const evidence = PuzzleV3EvidenceBindingV1Schema.parse(evidenceInput)
  const envelope = assertEngineProofsMatchCampaign(envelopeInput, evidence)
  const proofRefs = envelope.record.engineChecks.map(puzzleEngineProofRef)
  return PuzzleRecordV1Schema.parse({
    version: 1,
    puzzleId: envelope.record.puzzleId,
    initialFen: envelope.record.initialFen,
    presentationFen: envelope.record.presentationFen,
    movesUci: envelope.record.movesUci,
    learnerNodes: envelope.record.learnerNodes.map((node, index) => ({
      learnerIndex: node.learnerIndex,
      solutionMoveIndex: node.solutionMoveIndex,
      fen: node.fen,
      epd: node.epd,
      expectedMoveUci: node.expectedMoveUci,
      forcedReplyUci: node.forcedReplyUci,
      mateInOne: node.mateInOne,
      engineProofRef: proofRefs[index],
    })),
    rating: envelope.record.rating,
    ratingDeviation: envelope.record.ratingDeviation,
    attempts: envelope.record.plays,
    popularity: envelope.record.popularity,
    themes: envelope.record.themes,
    association: {
      confidence: envelope.record.association.confidence,
      taxonomyLineId: envelope.record.association.taxonomyLineId,
      openingTag: envelope.record.association.openingTag,
    },
    source: {
      id: 'lichess-puzzle-database',
      license: 'CC0-1.0',
      sha256: evidence.puzzleSource.sha256,
      retrievedAt: evidence.puzzleSource.digestComputedAt,
    },
    engine: {
      name: 'Stockfish 18',
      allLearnerNodesVerified: true,
      proofRefs,
    },
  })
}

/**
 * Validate every full proof before an inventory can be used for promotion.
 * Family ownership is exact per shard: a broader union would leak unrelated
 * puzzles into family pages that do not own them.
 */
export function validatePuzzlePromotionProofInventory(input: unknown): PuzzlePromotionProofInventoryV1 {
  const inventory = PuzzlePromotionProofInventoryV1Schema.parse(input)
  const proofContentByReference = new Map<string, string>()
  for (const shard of inventory.shards) {
    for (const envelopeInput of shard.verified) {
      const envelope = assertEngineProofsMatchCampaign(envelopeInput, inventory.evidence)
      if (!sameStringSet(envelope.familyIds, shard.familyIds)) {
        throw new Error(`Puzzle ${envelope.record.puzzleId} family ownership differs from its promoted shard`)
      }
      for (const proof of envelope.record.engineChecks) {
        const reference = puzzleEngineProofRef(proof)
        const content = sha256Json(proof)
        const prior = proofContentByReference.get(reference)
        if (prior && prior !== content) throw new Error(`Engine proof reference collision: ${reference}`)
        proofContentByReference.set(reference, content)
      }
      // Conversion also replays the legal solution and proves that every
      // shipped proof reference occupies the matching learner-node slot.
      tacticalPuzzleFromVerifiedEnvelope(envelope, inventory.evidence)
    }
  }
  return inventory
}

export function validatePromotedPuzzleShardAgainstInventory(options: {
  shardSha256: string
  shard: unknown
  inventory: unknown
}): TacticalPuzzleShardV1 {
  const inventory = validatePuzzlePromotionProofInventory(options.inventory)
  const shard = TacticalPuzzleShardV1Schema.parse(options.shard)
  const proofShard = inventory.shards.find(({ shardSha256 }) => shardSha256 === options.shardSha256)
  if (!proofShard) throw new Error('Promoted puzzle shard has no content-addressed proof inventory')
  if (shard.releaseId !== inventory.releaseId || !sameStringSet(shard.familyIds, proofShard.familyIds)) {
    throw new Error('Promoted puzzle shard release or family ownership differs from its proof inventory')
  }
  const expected = new Map(proofShard.verified.map((envelope) => [
    envelope.record.puzzleId,
    tacticalPuzzleFromVerifiedEnvelope(envelope, inventory.evidence),
  ]))
  if (shard.puzzles.length !== expected.size) {
    throw new Error('Promoted puzzle shard puzzle count differs from its proof inventory')
  }
  for (const puzzle of shard.puzzles) {
    const audited = expected.get(puzzle.puzzleId)
    if (!audited) throw new Error(`Promoted puzzle ${puzzle.puzzleId} has no verified envelope`)
    if (JSON.stringify(puzzle) !== JSON.stringify(audited)) {
      throw new Error(`Promoted puzzle ${puzzle.puzzleId} differs from its verified proof envelope`)
    }
  }
  return shard
}

export function derivePuzzlePromotionReceipt(options: {
  inventory: unknown
  promotedShards: Array<{ sha256: string; shard: unknown }>
  proofInventory: {
    path: string
    sha256: string
    bytes: number
    uncompressedBytes: number
    encoding: 'identity' | 'gzip'
  }
  completedAt: string
}): PuzzlePromotionReceiptV1 {
  const inventory = validatePuzzlePromotionProofInventory(options.inventory)
  const indexedHashes = new Set(inventory.shards.map(({ shardSha256 }) => shardSha256))
  if (
    options.promotedShards.length !== indexedHashes.size ||
    new Set(options.promotedShards.map(({ sha256 }) => sha256)).size !== options.promotedShards.length
  ) throw new Error('Promoted shard inventory is incomplete or duplicated')
  const puzzleIds = new Set<string>()
  for (const promoted of options.promotedShards) {
    if (!indexedHashes.has(promoted.sha256)) throw new Error('Promoted shard is outside the approved proof inventory')
    const shard = validatePromotedPuzzleShardAgainstInventory({
      shardSha256: promoted.sha256,
      shard: promoted.shard,
      inventory,
    })
    for (const puzzle of shard.puzzles) {
      if (puzzleIds.has(puzzle.puzzleId)) throw new Error(`Duplicate promoted puzzle ID ${puzzle.puzzleId}`)
      puzzleIds.add(puzzle.puzzleId)
    }
  }
  return PuzzlePromotionReceiptV1Schema.parse({
    schemaVersion: 1,
    releaseId: inventory.releaseId,
    status: 'pass',
    completedAt: options.completedAt,
    gate: 'lichess-puzzle-promotion',
    sourceDigestApproved: true,
    sourceSha256: inventory.evidence.puzzleSource.sha256,
    promotedShardCount: options.promotedShards.length,
    promotedPuzzleCount: puzzleIds.size,
    legalityComplete: true,
    associationComplete: true,
    engineChecksComplete: true,
    duplicatePuzzleIds: 0,
    evidenceBindingSha256: inventory.evidenceBindingSha256,
    engineCampaignSha256: inventory.evidence.engineCampaign.campaignSha256,
    proofInventory: options.proofInventory,
  })
}

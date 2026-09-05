import { z } from 'zod'
import {
  FamilyIdSchema,
  TacticalPuzzlePromotionBindingV1Schema,
  type ContentAddressedRefV1,
  type OpeningFamilyManifestV1,
  type TacticalPuzzlePromotionBindingV1,
} from '../domain/opening-family.ts'
import {
  PuzzleRecordListV1Schema,
  type PuzzleRecord,
} from '../domain/tactical-puzzles.ts'
import type { TrustedPuzzleOpeningDataSource } from './opening-data-source.ts'

const ResourceMessageSchema = z.string().trim().min(1).max(512)

export const MAX_TACTICAL_RESOURCE_SHARDS = 32
export const MAX_TACTICAL_RESOURCE_PUZZLES = 20_000
export const MAX_TACTICAL_RESOURCE_COMPRESSED_BYTES = 8 * 1024 * 1024
export const MAX_TACTICAL_RESOURCE_UNCOMPRESSED_BYTES = 32 * 1024 * 1024

/**
 * States which can safely arrive from an ordinary runtime boundary. Puzzle
 * records are deliberately absent: parsing an object must never mint release
 * trust from caller-provided hashes or labels.
 */
export const TacticalPuzzleResourceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('disabled'), reason: ResourceMessageSchema }).strict(),
  z.object({ status: z.literal('loading') }).strict(),
  z.object({ status: z.literal('empty'), reason: ResourceMessageSchema }).strict(),
  z.object({
    status: z.literal('offline'),
    puzzles: z.tuple([]),
    reason: ResourceMessageSchema,
    release: z.null(),
  }).strict(),
  z.object({
    status: z.literal('rate-limited'),
    retryAt: z.string().datetime({ offset: true }),
    retryAfterSeconds: z.number().int().min(1).max(86_400),
    reason: ResourceMessageSchema,
  }).strict(),
  z.object({ status: z.literal('corrupt'), reason: ResourceMessageSchema }).strict(),
  z.object({ status: z.literal('error'), reason: ResourceMessageSchema }).strict(),
])

type UntrustedTacticalPuzzleResource = z.infer<typeof TacticalPuzzleResourceSchema>

export interface TrustedTacticalPuzzleRelease {
  readonly schemaVersion: 1
  readonly releaseId: string
  readonly familyId: string
  readonly status: 'pass'
  readonly gate: 'lichess-puzzle-promotion'
  readonly familyPromotionIndexSha256: string
  readonly promotionReceiptSha256: string
  readonly proofInventorySha256: string
  readonly sourceSha256: string
  readonly evidenceBindingSha256: string
  readonly engineCampaignSha256: string
  readonly promotedAt: string
  readonly shardIds: readonly string[]
  readonly presentedPuzzleCount: number
  /** Stable identity computed once from the authenticated release and refs. */
  readonly collectionIdentity: string
}

type TrustedTacticalPuzzleReadyResource = Readonly<{
  status: 'ready'
  puzzles: readonly PuzzleRecord[]
  release: TrustedTacticalPuzzleRelease
}>

type TrustedTacticalPuzzleStaleResource = Readonly<{
  status: 'stale'
  puzzles: readonly PuzzleRecord[]
  staleAt: string
  reason: string
  release: TrustedTacticalPuzzleRelease
}>

type TrustedTacticalPuzzleOfflineResource = Readonly<{
  status: 'offline'
  puzzles: readonly PuzzleRecord[]
  reason: string
  release: TrustedTacticalPuzzleRelease
}>

export type TrustedTacticalPuzzleResource =
  | TrustedTacticalPuzzleReadyResource
  | TrustedTacticalPuzzleStaleResource
  | TrustedTacticalPuzzleOfflineResource

export type TacticalPuzzleResource = UntrustedTacticalPuzzleResource | TrustedTacticalPuzzleResource

const trustedResources = new WeakSet<TrustedTacticalPuzzleResource>()

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function trustedResource<T extends TrustedTacticalPuzzleResource>(resource: T): T {
  Object.freeze(resource.puzzles)
  Object.freeze(resource.release.shardIds)
  Object.freeze(resource.release)
  Object.freeze(resource)
  trustedResources.add(resource)
  return resource
}

export function isTrustedTacticalPuzzleResource(
  resource: unknown,
): resource is TrustedTacticalPuzzleResource {
  return typeof resource === 'object'
    && resource !== null
    && trustedResources.has(resource as TrustedTacticalPuzzleResource)
}

/**
 * Validate a UI resource without allowing a serialized object to claim it was
 * promoted. Puzzle-bearing resources must retain the nominal identity created
 * by the asynchronous verified loader below.
 */
export function validateTacticalPuzzleResource(resource: unknown): TacticalPuzzleResource {
  if (isTrustedTacticalPuzzleResource(resource)) return resource
  return TacticalPuzzleResourceSchema.parse(resource)
}

export function validateTacticalPuzzleRecords(records: unknown): PuzzleRecord[] {
  return PuzzleRecordListV1Schema.parse(records)
}

export interface LoadTrustedTacticalPuzzleResourceOptions {
  dataSource: TrustedPuzzleOpeningDataSource
  familyId: string
  /** Exact manifest object returned by this data source. */
  verifiedManifest: OpeningFamilyManifestV1
  signal?: AbortSignal
  availability?:
    | { status: 'ready' }
    | { status: 'stale'; staleAt: string; reason: string }
    | { status: 'offline'; reason: string }
}

function promotedShardsForFamily(
  binding: TacticalPuzzlePromotionBindingV1,
  familyId: string,
) {
  return binding.shards.filter(({ familyIds }) => familyIds.includes(familyId))
}

function boundedReferences(refs: readonly ContentAddressedRefV1[]): void {
  if (refs.length > MAX_TACTICAL_RESOURCE_SHARDS) {
    throw new Error(`A family puzzle collection exceeds the ${MAX_TACTICAL_RESOURCE_SHARDS}-shard runtime limit`)
  }
  const compressedBytes = refs.reduce((sum, ref) => sum + ref.compressedBytes, 0)
  const uncompressedBytes = refs.reduce((sum, ref) => sum + ref.uncompressedBytes, 0)
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes > MAX_TACTICAL_RESOURCE_COMPRESSED_BYTES) {
    throw new Error('A family puzzle collection exceeds its compressed-byte runtime limit')
  }
  if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_TACTICAL_RESOURCE_UNCOMPRESSED_BYTES) {
    throw new Error('A family puzzle collection exceeds its uncompressed-byte runtime limit')
  }
}

/**
 * Load one family's exact promoted shards through the checksum-verifying
 * FamilyOpeningDataSource. Trusted metadata is derived only after internal ID,
 * release, owner, source, record count, and audited-shard membership agree.
 */
export async function loadTrustedTacticalPuzzleResource(
  options: LoadTrustedTacticalPuzzleResourceOptions,
): Promise<TacticalPuzzleResource> {
  const familyId = FamilyIdSchema.parse(options.familyId)
  const binding = TacticalPuzzlePromotionBindingV1Schema.parse(
    options.dataSource.loadPuzzlePromotionBinding(),
  )
  const verifiedManifest = await options.dataSource.loadFamilyManifest(familyId, options.signal)
  if (verifiedManifest !== options.verifiedManifest) {
    throw new Error('Tactical puzzle loading requires the exact verified family manifest instance')
  }
  if (verifiedManifest.releaseId !== binding.releaseId || verifiedManifest.id !== familyId) {
    throw new Error('Tactical puzzle manifest and promotion binding use different release ownership')
  }
  const refs = verifiedManifest.puzzleShardRefs
  if (refs.length === 0) {
    return { status: 'empty', reason: 'This opening family has no promoted tactical puzzles.' }
  }
  boundedReferences(refs)

  const promoted = promotedShardsForFamily(binding, familyId)
  if (promoted.length !== refs.length) {
    throw new Error('Family manifest and puzzle promotion contain different shard inventories')
  }
  const promotedById = new Map(promoted.map((entry) => [entry.shardId, entry]))
  const puzzles: PuzzleRecord[] = []
  const puzzleIds = new Set<string>()
  for (const ref of refs) {
    const membership = promotedById.get(ref.id)
    if (!membership || membership.shardSha256 !== ref.sha256) {
      throw new Error(`Puzzle shard ${ref.id} is absent from the authenticated promotion binding`)
    }
    const shard = await options.dataSource.loadPuzzleShard(ref, options.signal)
    if (shard.id !== ref.id || shard.releaseId !== binding.releaseId) {
      throw new Error(`Puzzle shard ${ref.id} has inconsistent internal identity`)
    }
    const expectedFamilies = [...membership.familyIds].sort()
    const actualFamilies = [...shard.familyIds].sort()
    if (!sameStrings(actualFamilies, expectedFamilies) || !actualFamilies.includes(familyId)) {
      throw new Error(`Puzzle shard ${ref.id} has inconsistent family ownership`)
    }
    if (shard.puzzles.length !== membership.puzzleCount) {
      throw new Error(`Puzzle shard ${ref.id} record count differs from its promotion binding`)
    }
    for (const puzzle of shard.puzzles) {
      if (puzzle.source.sha256 !== binding.sourceSha256) {
        throw new Error(`Puzzle ${puzzle.puzzleId} uses another approved-source digest`)
      }
      if (Date.parse(puzzle.source.retrievedAt) > Date.parse(binding.promotedAt)) {
        throw new Error(`Puzzle ${puzzle.puzzleId} was retrieved after its promotion completed`)
      }
      if (puzzleIds.has(puzzle.puzzleId)) {
        throw new Error(`Duplicate promoted puzzle ID ${puzzle.puzzleId}`)
      }
      puzzleIds.add(puzzle.puzzleId)
      puzzles.push(puzzle)
    }
  }
  if (puzzles.length === 0) throw new Error('A promoted puzzle collection cannot be empty')
  if (puzzles.length > MAX_TACTICAL_RESOURCE_PUZZLES) {
    throw new Error(`A family puzzle collection exceeds the ${MAX_TACTICAL_RESOURCE_PUZZLES}-record runtime limit`)
  }
  const expectedCount = promoted.reduce((sum, entry) => sum + entry.puzzleCount, 0)
  if (puzzles.length !== expectedCount) {
    throw new Error('Presented puzzle count differs from its promoted shard membership')
  }

  const shardIds = Object.freeze(refs.map(({ id }) => id))
  const release: TrustedTacticalPuzzleRelease = {
    schemaVersion: 1,
    releaseId: binding.releaseId,
    familyId,
    status: 'pass',
    gate: 'lichess-puzzle-promotion',
    familyPromotionIndexSha256: binding.familyPromotionIndexSha256,
    promotionReceiptSha256: binding.promotionReceiptSha256,
    proofInventorySha256: binding.proofInventorySha256,
    sourceSha256: binding.sourceSha256,
    evidenceBindingSha256: binding.evidenceBindingSha256,
    engineCampaignSha256: binding.engineCampaignSha256,
    promotedAt: binding.promotedAt,
    shardIds,
    presentedPuzzleCount: puzzles.length,
    collectionIdentity: `${binding.familyPromotionIndexSha256}:${familyId}:${shardIds.join(',')}`,
  }
  const availability = options.availability ?? { status: 'ready' as const }
  if (availability.status === 'stale') {
    const parsed = z.object({
      staleAt: z.string().datetime({ offset: true }),
      reason: ResourceMessageSchema,
    }).parse(availability)
    if (Date.parse(parsed.staleAt) < Date.parse(binding.promotedAt)) {
      throw new Error('A puzzle release cannot become stale before its promotion')
    }
    return trustedResource({
      status: 'stale', puzzles, staleAt: parsed.staleAt, reason: parsed.reason, release,
    })
  }
  if (availability.status === 'offline') {
    const reason = ResourceMessageSchema.parse(availability.reason)
    return trustedResource({ status: 'offline', puzzles, reason, release })
  }
  return trustedResource({ status: 'ready', puzzles, release })
}

/**
 * Test/review-only nominal constructor. Production application modules must
 * never import it; real release trust comes only from the async loader above.
 */
export function createTestOnlyTrustedTacticalPuzzleResource(options: {
  puzzles: readonly PuzzleRecord[]
  collectionIdentity: string
  releaseId?: string
  familyId?: string
  status?: 'ready' | 'stale' | 'offline'
  staleAt?: string
  reason?: string
}): TrustedTacticalPuzzleResource {
  const puzzles = PuzzleRecordListV1Schema.min(1).max(MAX_TACTICAL_RESOURCE_PUZZLES).parse(options.puzzles)
  const releaseId = options.releaseId ?? 'synthetic-puzzle-review-v1'
  if (!/^(?:synthetic|test)[a-z0-9._-]{2,159}$/u.test(releaseId)) {
    throw new Error('Test-only puzzle resources require an explicitly synthetic release ID')
  }
  const sourceSha256 = puzzles[0]!.source.sha256
  if (puzzles.some((puzzle) => puzzle.source.sha256 !== sourceSha256)) {
    throw new Error('Test-only puzzles must use one source digest')
  }
  const collectionIdentity = z.string().min(1).max(512).parse(options.collectionIdentity)
  const release: TrustedTacticalPuzzleRelease = {
    schemaVersion: 1,
    releaseId,
    familyId: options.familyId ?? 'synthetic-family',
    status: 'pass',
    gate: 'lichess-puzzle-promotion',
    familyPromotionIndexSha256: 'b'.repeat(64),
    promotionReceiptSha256: 'c'.repeat(64),
    proofInventorySha256: 'd'.repeat(64),
    sourceSha256,
    evidenceBindingSha256: 'e'.repeat(64),
    engineCampaignSha256: 'f'.repeat(64),
    promotedAt: '2026-07-28T12:00:00.000Z',
    shardIds: Object.freeze(['blob_aaaaaaaaaaaaaaaa']),
    presentedPuzzleCount: puzzles.length,
    collectionIdentity: `test-only:${collectionIdentity}`,
  }
  if (options.status === 'stale') {
    const staleAt = z.string().datetime({ offset: true }).parse(options.staleAt)
    return trustedResource({
      status: 'stale',
      puzzles,
      staleAt,
      reason: ResourceMessageSchema.parse(options.reason),
      release,
    })
  }
  if (options.status === 'offline') {
    return trustedResource({
      status: 'offline',
      puzzles,
      reason: ResourceMessageSchema.parse(options.reason),
      release,
    })
  }
  return trustedResource({ status: 'ready', puzzles, release })
}

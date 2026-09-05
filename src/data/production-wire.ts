import { z } from 'zod'
import {
  ContentAddressedRefV1Schema,
  FamilyReleaseIdSchema,
  TacticalPuzzlePromotionBindingV1Schema,
} from '../domain/opening-family.ts'
import { WireAppManifestSchema } from './wire.ts'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
export const MAX_PRODUCTION_SNAPSHOT_BASE64_BYTES = 8 * 1024 * 1024

function sameContentReference(
  left: z.infer<typeof ContentAddressedRefV1Schema>,
  right: z.infer<typeof ContentAddressedRefV1Schema>,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.id === right.id
    && left.releaseId === right.releaseId
    && left.path === right.path
    && left.sha256 === right.sha256
    && left.compressedBytes === right.compressedBytes
    && left.uncompressedBytes === right.uncompressedBytes
    && left.contentType === right.contentType
    && left.contentEncoding === right.contentEncoding
}

export const ProductionWireAppManifestV3Schema = z.object({
  v: z.literal(3),
  schema: z.literal('linerecall-app-wire-v3'),
  releaseId: FamilyReleaseIdSchema,
  g: z.string().datetime({ offset: true }),
  selectionPolicy: z.object({
    practiceBranches: z.literal('all-eligible-audited'),
    maximumPracticeBranches: z.null(),
    terminal: z.literal('evidence-defined-through-ply-100'),
  }).strict(),
  familyPromotionIndexSha256: Sha256Schema,
  puzzlePromotion: TacticalPuzzlePromotionBindingV1Schema,
  browseManifestSha256: Sha256Schema,
  browse: WireAppManifestSchema,
  familyCatalogRef: ContentAddressedRefV1Schema,
  familyResources: z.record(
    z.string().regex(/^blob_[a-f0-9]{16}$/u),
    ContentAddressedRefV1Schema,
  ),
  totals: z.object({
    families: z.number().int().positive().max(3_790),
    packs: z.number().int().positive().max(100_000),
    graphs: z.number().int().positive().max(100_000),
    puzzleShards: z.number().int().positive().max(1_000),
    familyResources: z.number().int().positive().max(250_000),
    compressedBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    estimatedBase64Bytes: z.number().int().positive().max(MAX_PRODUCTION_SNAPSHOT_BASE64_BYTES),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (
    manifest.puzzlePromotion.releaseId !== manifest.releaseId
    || manifest.puzzlePromotion.familyPromotionIndexSha256 !== manifest.familyPromotionIndexSha256
  ) {
    context.addIssue({
      code: 'custom',
      path: ['puzzlePromotion'],
      message: 'Puzzle promotion must belong to the exact promoted app release index',
    })
  }
  const entries = Object.entries(manifest.familyResources)
  if (manifest.puzzlePromotion.shards.length !== manifest.totals.puzzleShards) {
    context.addIssue({
      code: 'custom',
      path: ['totals', 'puzzleShards'],
      message: 'Puzzle shard total does not match the promoted membership statement',
    })
  }
  for (const [index, shard] of manifest.puzzlePromotion.shards.entries()) {
    const reference = manifest.familyResources[shard.shardId]
    if (!reference || reference.sha256 !== shard.shardSha256) {
      context.addIssue({
        code: 'custom',
        path: ['puzzlePromotion', 'shards', index],
        message: 'Promoted puzzle shard is absent from the exact runtime resource inventory',
      })
    }
  }
  if (entries.length !== manifest.totals.familyResources) {
    context.addIssue({
      code: 'custom',
      path: ['totals', 'familyResources'],
      message: 'Family resource total does not match the content-addressed inventory',
    })
  }
  const paths = new Set<string>()
  for (const [id, reference] of entries) {
    if (id !== reference.id) {
      context.addIssue({
        code: 'custom',
        path: ['familyResources', id],
        message: 'Family resource key must equal its content-addressed ID',
      })
    }
    if (reference.releaseId !== manifest.releaseId) {
      context.addIssue({
        code: 'custom',
        path: ['familyResources', id, 'releaseId'],
        message: 'Every family resource must belong to the app release',
      })
    }
    if (paths.has(reference.path)) {
      context.addIssue({
        code: 'custom',
        path: ['familyResources', id, 'path'],
        message: 'Family resource paths must be unique',
      })
    }
    paths.add(reference.path)
  }
  const catalog = manifest.familyResources[manifest.familyCatalogRef.id]
  if (!catalog || !sameContentReference(catalog, manifest.familyCatalogRef)) {
    context.addIssue({
      code: 'custom',
      path: ['familyCatalogRef'],
      message: 'The trusted family catalog must appear exactly once in the resource inventory',
    })
  }
  const familyCompressedBytes = entries.reduce(
    (sum, [, reference]) => sum + reference.compressedBytes,
    0,
  )
  const compressedBytes = manifest.browse.totals.compressedBytes + familyCompressedBytes
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes !== manifest.totals.compressedBytes) {
    context.addIssue({
      code: 'custom',
      path: ['totals', 'compressedBytes'],
      message: 'Production app compressed-byte total does not reconcile',
    })
  }
  const familyBase64Bytes = entries.reduce(
    (sum, [, reference]) => sum + Math.ceil(reference.compressedBytes / 3) * 4,
    0,
  )
  const estimatedBase64Bytes = manifest.browse.totals.estimatedBase64Bytes + familyBase64Bytes
  if (!Number.isSafeInteger(estimatedBase64Bytes) || estimatedBase64Bytes !== manifest.totals.estimatedBase64Bytes) {
    context.addIssue({
      code: 'custom',
      path: ['totals', 'estimatedBase64Bytes'],
      message: 'Production app base64-byte estimate does not reconcile',
    })
  }
})

export type ProductionWireAppManifestV3 = z.infer<typeof ProductionWireAppManifestV3Schema>

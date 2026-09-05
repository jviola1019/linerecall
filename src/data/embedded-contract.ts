import { z } from 'zod'
import {
  ContentAddressedRefV1Schema,
  FamilyReleaseIdSchema,
  TacticalPuzzlePromotionBindingV1Schema,
} from '../domain/opening-family.ts'
import { MAX_PRODUCTION_SNAPSHOT_BASE64_BYTES } from './production-wire.ts'

export const MAX_EMBEDDED_COMPRESSED_BLOB_BYTES = 2 * 1024 * 1024
export const MAX_EMBEDDED_UNCOMPRESSED_BLOB_BYTES = 8 * 1024 * 1024
const MAX_BASE64_CHARACTERS = Math.ceil(MAX_EMBEDDED_COMPRESSED_BLOB_BYTES / 3) * 4

export const EmbeddedBlobReceiptSchema = z.object({
  base64: z.string().min(1).max(MAX_BASE64_CHARACTERS).regex(/^[A-Za-z0-9+/]*={0,2}$/u),
  compressedBytes: z.number().int().positive().max(MAX_EMBEDDED_COMPRESSED_BLOB_BYTES),
  uncompressedBytes: z.number().int().positive().max(MAX_EMBEDDED_UNCOMPRESSED_BLOB_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

export const EmbeddedSnapshotPayloadSchema = z.object({
  version: z.literal(2),
  generatedAt: z.string().datetime({ offset: true }),
  schema: z.literal('linerecall-app-wire-v2'),
  blobs: z.object({
    search: EmbeddedBlobReceiptSchema,
    audit: EmbeddedBlobReceiptSchema,
  }).strict(),
  shards: z.record(z.string().regex(/^s_[a-f0-9]{16}$/u), EmbeddedBlobReceiptSchema),
  partitions: z.record(z.string().regex(/^[A-E][0-9]{2}$/u), EmbeddedBlobReceiptSchema),
}).strict().superRefine((payload, context) => {
  if (Object.keys(payload.partitions).length !== 500) {
    context.addIssue({
      code: 'custom',
      path: ['partitions'],
      message: 'The embedded snapshot must contain all 500 ECO partitions',
    })
  }
  if (Object.keys(payload.shards).length === 0) {
    context.addIssue({ code: 'custom', path: ['shards'], message: 'The embedded snapshot has no evidence shards' })
  }
})

export interface EmbeddedBlobReceipt {
  base64: string
  compressedBytes: number
  uncompressedBytes: number
  sha256: string
}

export interface EmbeddedSnapshotPayload {
  version: 2
  generatedAt: string
  schema: 'linerecall-app-wire-v2'
  blobs: {
    search: EmbeddedBlobReceipt
    audit: EmbeddedBlobReceipt
  }
  shards: Record<string, EmbeddedBlobReceipt>
  partitions: Record<string, EmbeddedBlobReceipt>
}

export const MAX_EMBEDDED_FAMILY_COMPRESSED_BLOB_BYTES = 10 * 1024 * 1024
// Hosted resources may use the wider public-reference bound, but an embedded
// artifact decompresses on the browser main thread. Keep each independently
// loadable family resource small enough to reject pathological gzip expansion;
// builders must split a larger graph or puzzle corpus into additional shards.
export const MAX_EMBEDDED_FAMILY_UNCOMPRESSED_BLOB_BYTES = 32 * 1024 * 1024
const MAX_FAMILY_BASE64_CHARACTERS = Math.ceil(MAX_EMBEDDED_FAMILY_COMPRESSED_BLOB_BYTES / 3) * 4

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

export const EmbeddedFamilyBlobReceiptSchema = z.object({
  base64: z.string().min(1).max(MAX_FAMILY_BASE64_CHARACTERS).regex(/^[A-Za-z0-9+/]*={0,2}$/u),
  compressedBytes: z.number().int().positive().max(MAX_EMBEDDED_FAMILY_COMPRESSED_BLOB_BYTES),
  uncompressedBytes: z.number().int().positive().max(MAX_EMBEDDED_FAMILY_UNCOMPRESSED_BLOB_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

export const EmbeddedFamilyResourceV3Schema = z.object({
  reference: ContentAddressedRefV1Schema,
  blob: EmbeddedFamilyBlobReceiptSchema,
}).strict().superRefine((resource, context) => {
  if (
    resource.reference.sha256 !== resource.blob.sha256
    || resource.reference.compressedBytes !== resource.blob.compressedBytes
    || resource.reference.uncompressedBytes !== resource.blob.uncompressedBytes
  ) {
    context.addIssue({
      code: 'custom',
      path: ['blob'],
      message: 'Embedded family bytes must match their content-addressed reference',
    })
  }
})

export const EmbeddedProductionSnapshotPayloadV3Schema = z.object({
  version: z.literal(3),
  schema: z.literal('linerecall-app-wire-v3'),
  releaseId: FamilyReleaseIdSchema,
  generatedAt: z.string().datetime({ offset: true }),
  selectionPolicy: z.object({
    practiceBranches: z.literal('all-eligible-audited'),
    maximumPracticeBranches: z.null(),
    terminal: z.literal('evidence-defined-through-ply-100'),
  }).strict(),
  appManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  familyPromotionIndexSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  puzzlePromotion: TacticalPuzzlePromotionBindingV1Schema,
  base: EmbeddedSnapshotPayloadSchema,
  familyCatalogRef: ContentAddressedRefV1Schema,
  familyResources: z.record(
    z.string().regex(/^blob_[a-f0-9]{16}$/u),
    EmbeddedFamilyResourceV3Schema,
  ),
}).strict().superRefine((payload, context) => {
  if (
    payload.puzzlePromotion.releaseId !== payload.releaseId
    || payload.puzzlePromotion.familyPromotionIndexSha256 !== payload.familyPromotionIndexSha256
  ) {
    context.addIssue({
      code: 'custom',
      path: ['puzzlePromotion'],
      message: 'Embedded puzzle promotion does not match its authenticated release index',
    })
  }
  const paths = new Set<string>()
  for (const [index, shard] of payload.puzzlePromotion.shards.entries()) {
    const resource = payload.familyResources[shard.shardId]
    if (!resource || resource.reference.sha256 !== shard.shardSha256) {
      context.addIssue({
        code: 'custom',
        path: ['puzzlePromotion', 'shards', index],
        message: 'Embedded puzzle shard differs from its authenticated promotion membership',
      })
    }
  }
  for (const [id, resource] of Object.entries(payload.familyResources)) {
    if (id !== resource.reference.id) {
      context.addIssue({
        code: 'custom',
        path: ['familyResources', id],
        message: 'Embedded family resource key must equal its content ID',
      })
    }
    if (resource.reference.releaseId !== payload.releaseId) {
      context.addIssue({
        code: 'custom',
        path: ['familyResources', id, 'reference', 'releaseId'],
        message: 'Embedded family resource belongs to another release',
      })
    }
    if (paths.has(resource.reference.path)) {
      context.addIssue({
        code: 'custom',
        path: ['familyResources', id, 'reference', 'path'],
        message: 'Embedded family resource paths must be unique',
      })
    }
    paths.add(resource.reference.path)
  }
  const catalog = payload.familyResources[payload.familyCatalogRef.id]
  if (!catalog || !sameContentReference(catalog.reference, payload.familyCatalogRef)) {
    context.addIssue({
      code: 'custom',
      path: ['familyCatalogRef'],
      message: 'The trusted family catalog is absent from the embedded resource inventory',
    })
  }
  const base64Bytes = [
    payload.base.blobs.search,
    payload.base.blobs.audit,
    ...Object.values(payload.base.shards),
    ...Object.values(payload.base.partitions),
    ...Object.values(payload.familyResources).map(({ blob }) => blob),
  ].reduce((sum, blob) => sum + blob.base64.length, 0)
  if (base64Bytes > MAX_PRODUCTION_SNAPSHOT_BASE64_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['familyResources'],
      message: 'The production embedded data exceeds its bounded single-file budget',
    })
  }
})

export type EmbeddedFamilyBlobReceipt = z.infer<typeof EmbeddedFamilyBlobReceiptSchema>
export type EmbeddedProductionSnapshotPayloadV3 = z.infer<typeof EmbeddedProductionSnapshotPayloadV3Schema>

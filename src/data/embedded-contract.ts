import { z } from 'zod'

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

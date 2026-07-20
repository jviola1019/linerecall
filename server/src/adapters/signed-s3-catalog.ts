import { createHash, verify } from 'node:crypto'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { CatalogService } from '../ports.js'

const SignedEnvelopeSchema = z.object({
  schema: z.literal('linerecall-signed-manifest-v1'),
  keyId: z.string().min(1).max(128),
  payloadBase64: z.string().min(1).max(3_000_000),
  signatureBase64: z.string().min(1).max(256),
}).strict()

const ManifestSchema = z.object({
  schema: z.literal('linerecall-catalog-manifest-v1'),
  releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  releaseStatus: z.literal('approved'),
  puzzlePartitions: z.array(z.object({
    packId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    key: z.string().regex(/^public\/puzzles\/[A-Za-z0-9/_-]+\.json$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(10_000).default([]),
}).passthrough()

interface CachedManifest { etag: string; value: z.infer<typeof ManifestSchema>; loadedAt: number }

export class SignedS3CatalogService implements CatalogService {
  #cached: CachedManifest | null = null
  readonly #puzzles = new Map<string, { expiresAt: number; value: unknown[] }>()

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly manifestKey: string,
    private readonly publicKeyPem: string,
  ) {
    if (!/^public\/manifests\/[A-Za-z0-9/_-]+\.json$/.test(manifestKey)) throw new Error('Invalid manifest object key')
  }

  async getManifest(ifNoneMatch?: string): Promise<{ etag: string; manifest: unknown } | null> {
    const current = await this.#manifest()
    return ifNoneMatch === current.etag ? null : { etag: current.etag, manifest: current.value }
  }

  async listPuzzles(query: { packId?: string; cursor?: string; limit: number }): Promise<{ items: unknown[]; nextCursor: string | null }> {
    if (!query.packId) return { items: [], nextCursor: null }
    const manifest = await this.#manifest()
    const descriptor = manifest.value.puzzlePartitions.find((item) => item.packId === query.packId)
    if (!descriptor) return { items: [], nextCursor: null }
    const puzzles = await this.#partition(descriptor)
    const start = query.cursor ? Number.parseInt(query.cursor, 10) : 0
    if (!Number.isSafeInteger(start) || start < 0) throw new ApiError(422, 'invalid_cursor', 'Puzzle cursor is invalid')
    const items = puzzles.slice(start, start + query.limit)
    const next = start + items.length
    return { items, nextCursor: next < puzzles.length ? String(next) : null }
  }

  async #manifest(): Promise<CachedManifest> {
    const now = Date.now()
    if (this.#cached && now - this.#cached.loadedAt < 60_000) return this.#cached
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.manifestKey }))
    if (!result.Body || (result.ContentLength ?? 0) > 2_100_000) throw new ApiError(503, 'catalog_unavailable', 'The signed catalog manifest is unavailable')
    const bytes = await result.Body.transformToByteArray()
    if (bytes.byteLength > 2_100_000) throw new ApiError(503, 'catalog_unavailable', 'The catalog manifest exceeds its limit')
    const envelope = SignedEnvelopeSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
    const payload = Buffer.from(envelope.payloadBase64, 'base64')
    const signature = Buffer.from(envelope.signatureBase64, 'base64')
    if (!verify(null, payload, this.publicKeyPem, signature)) throw new ApiError(503, 'catalog_signature_invalid', 'The catalog signature could not be verified')
    const value = ManifestSchema.parse(JSON.parse(payload.toString('utf8')))
    const digest = createHash('sha256').update(payload).digest('hex')
    this.#cached = { etag: `"${digest}"`, value, loadedAt: now }
    return this.#cached
  }

  async #partition(descriptor: { key: string; sha256: string }): Promise<unknown[]> {
    const cached = this.#puzzles.get(descriptor.sha256)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: descriptor.key }))
    if (!result.Body || (result.ContentLength ?? 0) > 10_000_000) throw new ApiError(503, 'puzzle_partition_unavailable', 'Puzzle data is unavailable')
    const bytes = await result.Body.transformToByteArray()
    if (bytes.byteLength > 10_000_000 || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) {
      throw new ApiError(503, 'puzzle_partition_corrupt', 'Puzzle data failed its integrity check')
    }
    const value = z.array(z.unknown()).max(50_000).parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
    this.#puzzles.set(descriptor.sha256, { expiresAt: Date.now() + 300_000, value })
    return value
  }
}

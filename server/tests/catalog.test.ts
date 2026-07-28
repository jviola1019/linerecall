import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, it } from 'node:test'
import type { S3Client } from '@aws-sdk/client-s3'
import { SignedS3CatalogService } from '../src/adapters/signed-s3-catalog.js'
import { ApiError } from '../src/errors.js'
import { tacticalPuzzle } from './helpers.js'

function body(bytes: Uint8Array) {
  return { transformToByteArray: async () => bytes }
}

describe('signed catalog adapter', () => {
  it('verifies the Ed25519 envelope and puzzle digest', async () => {
    const keys = generateKeyPairSync('ed25519')
    const records = [tacticalPuzzle('Puzzle001'), tacticalPuzzle('Puzzle002')]
    const puzzles = Buffer.from(JSON.stringify(records))
    const puzzleDigest = createHash('sha256').update(puzzles).digest('hex')
    const manifest = Buffer.from(JSON.stringify({
      schema: 'linerecall-catalog-manifest-v1', releaseId: 'release-1', releaseStatus: 'approved',
      puzzlePartitions: [{ packId: 'pack-e4', key: 'public/puzzles/pack-e4.json', sha256: puzzleDigest }],
    }))
    const envelope = Buffer.from(JSON.stringify({
      schema: 'linerecall-signed-manifest-v1', keyId: 'release-key-1',
      payloadBase64: manifest.toString('base64'), signatureBase64: sign(null, manifest, keys.privateKey).toString('base64'),
    }))
    const client = {
      send: async (command: { input: { Key?: string } }) => command.input.Key?.includes('manifests')
        ? { Body: body(envelope), ContentLength: envelope.byteLength }
        : { Body: body(puzzles), ContentLength: puzzles.byteLength },
    } as unknown as S3Client
    const service = new SignedS3CatalogService(
      client, 'example-catalog-bucket', 'public/manifests/current.json',
      keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    )
    const first = await service.getManifest()
    assert.equal((first?.manifest as { releaseId: string }).releaseId, 'release-1')
    assert.equal(await service.getManifest(first?.etag), null)
    assert.deepEqual(await service.listPuzzles({ limit: 20 }), { items: [], nextCursor: null })
    assert.deepEqual(await service.listPuzzles({ packId: 'missing', limit: 20 }), { items: [], nextCursor: null })
    const page = await service.listPuzzles({ packId: 'pack-e4', limit: 1 })
    assert.deepEqual(page, { items: [records[0]], nextCursor: '1' })
    assert.deepEqual((await service.listPuzzles({ packId: 'pack-e4', cursor: page.nextCursor!, limit: 20 })).items, [records[1]])
    await assert.rejects(() => service.listPuzzles({ packId: 'pack-e4', cursor: 'not-a-number', limit: 20 }), (error: unknown) => error instanceof ApiError && error.code === 'invalid_cursor')
  })

  it('rejects malformed and duplicate records even when the partition digest is valid', async () => {
    const keys = generateKeyPairSync('ed25519')
    for (const records of [
      [{ id: 'not-a-puzzle' }],
      [tacticalPuzzle('Puzzle001'), tacticalPuzzle('Puzzle001')],
    ]) {
      const puzzles = Buffer.from(JSON.stringify(records))
      const puzzleDigest = createHash('sha256').update(puzzles).digest('hex')
      const manifest = Buffer.from(JSON.stringify({
        schema: 'linerecall-catalog-manifest-v1',
        releaseId: 'release-1',
        releaseStatus: 'approved',
        puzzlePartitions: [{ packId: 'pack-e4', key: 'public/puzzles/pack-e4.json', sha256: puzzleDigest }],
      }))
      const envelope = Buffer.from(JSON.stringify({
        schema: 'linerecall-signed-manifest-v1',
        keyId: 'release-key-1',
        payloadBase64: manifest.toString('base64'),
        signatureBase64: sign(null, manifest, keys.privateKey).toString('base64'),
      }))
      const client = {
        send: async (command: { input: { Key?: string } }) => command.input.Key?.includes('manifests')
          ? { Body: body(envelope), ContentLength: envelope.byteLength }
          : { Body: body(puzzles), ContentLength: puzzles.byteLength },
      } as unknown as S3Client
      const service = new SignedS3CatalogService(
        client,
        'example-catalog-bucket',
        'public/manifests/current.json',
        keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      )
      await assert.rejects(
        () => service.listPuzzles({ packId: 'pack-e4', limit: 20 }),
        (error: unknown) => error instanceof ApiError && error.code === 'puzzle_partition_corrupt',
      )
    }
  })

  it('fails closed on a bad signature', async () => {
    const keys = generateKeyPairSync('ed25519')
    const payload = Buffer.from(JSON.stringify({ schema: 'linerecall-catalog-manifest-v1', releaseId: 'release-1', releaseStatus: 'approved' }))
    const envelope = Buffer.from(JSON.stringify({
      schema: 'linerecall-signed-manifest-v1', keyId: 'key', payloadBase64: payload.toString('base64'),
      signatureBase64: Buffer.alloc(64).toString('base64'),
    }))
    const client = { send: async () => ({ Body: body(envelope), ContentLength: envelope.byteLength }) } as unknown as S3Client
    const service = new SignedS3CatalogService(client, 'example-catalog-bucket', 'public/manifests/current.json', keys.publicKey.export({ type: 'spki', format: 'pem' }).toString())
    await assert.rejects(() => service.getManifest(), (error: unknown) => error instanceof ApiError && error.code === 'catalog_signature_invalid')
  })

  it('rejects invalid keys, missing bodies, oversized manifests, and corrupt partitions', async () => {
    const keys = generateKeyPairSync('ed25519')
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    assert.throws(() => new SignedS3CatalogService({} as S3Client, 'bucket', '../manifest.json', publicKey), /Invalid manifest/)

    const missing = new SignedS3CatalogService({ send: async () => ({}) } as unknown as S3Client, 'example-bucket', 'public/manifests/current.json', publicKey)
    await assert.rejects(() => missing.getManifest(), (error: unknown) => error instanceof ApiError && error.code === 'catalog_unavailable')
    const oversized = new SignedS3CatalogService({ send: async () => ({ Body: body(new Uint8Array()), ContentLength: 3_000_000 }) } as unknown as S3Client, 'example-bucket', 'public/manifests/current.json', publicKey)
    await assert.rejects(() => oversized.getManifest(), (error: unknown) => error instanceof ApiError && error.code === 'catalog_unavailable')
    const deceptiveLength = new SignedS3CatalogService({
      send: async () => ({ Body: body(new Uint8Array(2_100_001)), ContentLength: 1 }),
    } as unknown as S3Client, 'example-bucket', 'public/manifests/current.json', publicKey)
    await assert.rejects(
      () => deceptiveLength.getManifest(),
      (error: unknown) => error instanceof ApiError && error.code === 'catalog_unavailable',
    )

    const manifest = Buffer.from(JSON.stringify({
      schema: 'linerecall-catalog-manifest-v1', releaseId: 'release-1', releaseStatus: 'approved',
      puzzlePartitions: [{ packId: 'pack-e4', key: 'public/puzzles/pack-e4.json', sha256: '0'.repeat(64) }],
    }))
    const envelope = Buffer.from(JSON.stringify({
      schema: 'linerecall-signed-manifest-v1', keyId: 'key', payloadBase64: manifest.toString('base64'),
      signatureBase64: sign(null, manifest, keys.privateKey).toString('base64'),
    }))
    const corrupt = Buffer.from('[]')
    const client = { send: async (command: { input: { Key?: string } }) => command.input.Key?.includes('manifests')
      ? { Body: body(envelope), ContentLength: envelope.byteLength }
      : { Body: body(corrupt), ContentLength: corrupt.byteLength } } as unknown as S3Client
    const service = new SignedS3CatalogService(client, 'example-bucket', 'public/manifests/current.json', publicKey)
    await assert.rejects(() => service.listPuzzles({ packId: 'pack-e4', limit: 1 }), (error: unknown) => error instanceof ApiError && error.code === 'puzzle_partition_corrupt')

    const missingPartitionClient = {
      send: async (command: { input: { Key?: string } }) => command.input.Key?.includes('manifests')
        ? { Body: body(envelope), ContentLength: envelope.byteLength }
        : {},
    } as unknown as S3Client
    const missingPartition = new SignedS3CatalogService(
      missingPartitionClient, 'example-bucket', 'public/manifests/current.json', publicKey,
    )
    await assert.rejects(
      () => missingPartition.listPuzzles({ packId: 'pack-e4', limit: 1 }),
      (error: unknown) => error instanceof ApiError && error.code === 'puzzle_partition_unavailable',
    )
  })
})

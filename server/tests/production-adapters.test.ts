import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SubmitJobCommand, type BatchClient } from '@aws-sdk/client-batch'
import {
  DeleteObjectCommand, DeleteObjectsCommand, ListObjectVersionsCommand, PutObjectCommand, type S3Client,
} from '@aws-sdk/client-s3'
import type { Redis } from 'ioredis'
import { AwsBatchComputeExecutor, LocalNoopComputeExecutor } from '../src/adapters/aws-batch-compute.js'
import { RedisRateLimiter } from '../src/adapters/redis-rate-limiter.js'
import { S3ObjectStore } from '../src/adapters/s3-object-store.js'

describe('production infrastructure adapters', () => {
  it('submits a bounded AWS Batch workload with retry and timeout policy', async () => {
    const commands: SubmitJobCommand[] = []
    const client = {
      send: async (command: SubmitJobCommand) => {
        commands.push(command)
        return { jobId: 'provider-job-1' }
      },
    } as unknown as BatchClient
    const executor = new AwsBatchComputeExecutor(client, 'line-recall-jobs', {
      'pgn-import': 'import-definition:7',
      stockfish: 'stockfish-definition:18',
      scid: 'scid-definition:1',
      'data-refresh': 'refresh-definition:4',
    })

    const providerJobId = await executor.submit({
      jobId: '018f2f40-7b1d-7a4e-8b3a-0123456789ab',
      workload: 'stockfish',
      objectKey: 'private/imports/user/job/input.pgn',
    })

    assert.equal(providerJobId, 'provider-job-1')
    assert.equal(commands.length, 1)
    assert.ok(commands[0] instanceof SubmitJobCommand)
    assert.equal(commands[0]!.input.jobQueue, 'line-recall-jobs')
    assert.equal(commands[0]!.input.jobDefinition, 'stockfish-definition:18')
    assert.deepEqual(commands[0]!.input.parameters, {
      jobId: '018f2f40-7b1d-7a4e-8b3a-0123456789ab',
      objectKey: 'private/imports/user/job/input.pgn',
    })
    assert.equal(commands[0]!.input.retryStrategy?.attempts, 3)
    assert.equal(commands[0]!.input.timeout?.attemptDurationSeconds, 3_600)
    assert.equal(commands[0]!.input.propagateTags, true)
  })

  it('fails closed on malformed or unacknowledged compute jobs', async () => {
    const client = { send: async () => ({}) } as unknown as BatchClient
    const executor = new AwsBatchComputeExecutor(client, 'queue', {
      'pgn-import': 'import', stockfish: 'stockfish', scid: 'scid', 'data-refresh': 'refresh',
    })
    await assert.rejects(
      () => executor.submit({ jobId: '../unsafe', workload: 'pgn-import', objectKey: 'private/input' }),
      /Invalid compute job ID/,
    )
    await assert.rejects(
      () => executor.submit({
        jobId: '018f2f40-7b1d-7a4e-8b3a-0123456789ab', workload: 'pgn-import', objectKey: 'private/input',
      }),
      /did not return a job identifier/,
    )
    assert.equal(await new LocalNoopComputeExecutor().submit(), 'local-noop-unsubmitted')
  })

  it('uses one atomic Redis operation and never exposes the raw rate-limit subject', async () => {
    const calls: unknown[][] = []
    const redis = {
      call: async (...args: unknown[]) => {
        calls.push(args)
        return [1, 2_500]
      },
    } as unknown as Redis
    const limiter = new RedisRateLimiter(redis, 'test:rate')
    const now = new Date('2026-07-14T12:00:00.000Z')
    const decision = await limiter.consume('sync:user-private-id', 60, 60_000, now)

    assert.deepEqual(decision, {
      allowed: true,
      limit: 60,
      remaining: 59,
      resetAt: new Date('2026-07-14T12:00:02.500Z'),
    })
    assert.equal(calls[0]?.[0], 'EVAL')
    assert.equal(calls[0]?.[2], '1')
    assert.match(String(calls[0]?.[3]), /^test:rate:[a-f0-9]{64}$/u)
    assert.equal(String(calls[0]?.[3]).includes('user-private-id'), false)
    assert.equal(calls[0]?.[4], '60000')
  })

  it('rejects malformed Redis replies and reports exhausted windows', async () => {
    const exhausted = new RedisRateLimiter({ call: async () => [3, 1_000] } as unknown as Redis)
    assert.deepEqual(await exhausted.consume('subject', 2, 1_000, new Date(0)), {
      allowed: false, limit: 2, remaining: 0, resetAt: new Date(1_000),
    })
    for (const reply of [null, [1], ['not-a-count', 100], [1, -1]]) {
      const limiter = new RedisRateLimiter({ call: async () => reply } as unknown as Redis)
      await assert.rejects(() => limiter.consume('subject', 2, 1_000, new Date(0)), /Redis rate-limit response/)
    }
  })

  it('writes immutable, checksummed, KMS-encrypted private objects and can delete them', async () => {
    const commands: Array<PutObjectCommand | DeleteObjectCommand | DeleteObjectsCommand | ListObjectVersionsCommand> = []
    let listCalls = 0
    const client = {
      send: async (command: PutObjectCommand | DeleteObjectCommand | DeleteObjectsCommand | ListObjectVersionsCommand) => {
        commands.push(command)
        if (command instanceof ListObjectVersionsCommand) {
          listCalls += 1
          return listCalls === 1
            ? {
                Versions: [{ Key: 'private/imports/user_1/job_1/input', VersionId: 'version-1' }],
                DeleteMarkers: [{ Key: 'private/imports/user_1/job_1/input', VersionId: 'marker-1' }],
              }
            : { Versions: [], DeleteMarkers: [] }
        }
        return {}
      },
    } as unknown as S3Client
    const store = new S3ObjectStore(client, 'linerecall-private-data', 'arn:aws:kms:region:account:key/key-id')
    const body = new Uint8Array([1, 2, 3])
    const digest = 'a'.repeat(64)

    await store.putPrivateImmutable({
      key: 'private/imports/user_1/job_1/input', body, contentType: 'application/x-chess-pgn', sha256Hex: digest,
    })
    await store.deletePrivate('private/imports/user_1/job_1/input')

    assert.ok(commands[0] instanceof PutObjectCommand)
    const put = (commands[0] as PutObjectCommand).input
    assert.equal(put.Bucket, 'linerecall-private-data')
    assert.equal(put.IfNoneMatch, '*')
    assert.equal(put.ServerSideEncryption, 'aws:kms')
    assert.equal(put.BucketKeyEnabled, true)
    assert.equal(put.ChecksumSHA256, Buffer.from(digest, 'hex').toString('base64'))
    assert.deepEqual(put.Metadata, { sha256: digest })
    assert.ok(commands[1] instanceof ListObjectVersionsCommand)
    assert.ok(commands[2] instanceof DeleteObjectsCommand)
    assert.deepEqual((commands[2] as DeleteObjectsCommand).input.Delete?.Objects, [
      { Key: 'private/imports/user_1/job_1/input', VersionId: 'version-1' },
      { Key: 'private/imports/user_1/job_1/input', VersionId: 'marker-1' },
    ])
    assert.ok(commands[3] instanceof ListObjectVersionsCommand)
    assert.equal(commands.some((command) => command instanceof DeleteObjectCommand), false)
  })

  it('uses an idempotent ordinary delete when a private key has no listed versions', async () => {
    const commands: unknown[] = []
    const client = { send: async (command: unknown) => {
      commands.push(command)
      return command instanceof ListObjectVersionsCommand ? { Versions: [], DeleteMarkers: [] } : {}
    } } as unknown as S3Client
    await new S3ObjectStore(client, 'linerecall-private-data', 'key').deletePrivate('private/imports/missing')
    assert.ok(commands[0] instanceof ListObjectVersionsCommand)
    assert.ok(commands[1] instanceof DeleteObjectCommand)
  })

  it('rejects unsafe object-store buckets, keys, and digests', async () => {
    const client = { send: async () => ({}) } as unknown as S3Client
    assert.throws(() => new S3ObjectStore(client, '../bucket', 'key'), /bucket name/)
    const store = new S3ObjectStore(client, 'valid-private-bucket', 'key')
    await assert.rejects(
      () => store.putPrivateImmutable({ key: '../public', body: new Uint8Array(), contentType: 'text/plain', sha256Hex: 'a'.repeat(64) }),
      /private object key/,
    )
    await assert.rejects(
      () => store.putPrivateImmutable({ key: 'private/valid', body: new Uint8Array(), contentType: 'text/plain', sha256Hex: 'invalid' }),
      /SHA-256/,
    )
    await assert.rejects(() => store.deletePrivate('private//escape'), /private object key/)
  })

  it('fails closed on malformed, repeated, excessive, or incomplete S3 version deletion', async () => {
    const key = 'private/imports/user/job/input'

    const paginatedResponses: unknown[] = [
      {
        Versions: [
          { Key: key, VersionId: 'v1' },
          { Key: `${key}-other`, VersionId: 'wrong-key' },
          { Key: key },
        ],
        IsTruncated: true,
        NextKeyMarker: key,
        NextVersionIdMarker: 'v1',
      },
      { DeleteMarkers: [{ Key: key, VersionId: 'd1' }], IsTruncated: false },
      {},
      { Versions: [], DeleteMarkers: [], IsTruncated: false },
    ]
    const paginatedClient = {
      send: async () => paginatedResponses.shift() ?? {},
    } as unknown as S3Client
    await new S3ObjectStore(paginatedClient, 'linerecall-private-data', 'key').deletePrivate(key)

    const noCursor = { send: async () => ({ IsTruncated: true }) } as unknown as S3Client
    await assert.rejects(
      () => new S3ObjectStore(noCursor, 'linerecall-private-data', 'key').deletePrivate(key),
      /pagination cursor/,
    )

    const repeatedCursor = { send: async () => ({
      IsTruncated: true, NextKeyMarker: key, NextVersionIdMarker: 'same',
    }) } as unknown as S3Client
    await assert.rejects(
      () => new S3ObjectStore(repeatedCursor, 'linerecall-private-data', 'key').deletePrivate(key),
      /Repeated object-version pagination cursor/,
    )

    const deletionErrorResponses: unknown[] = [
      { Versions: [{ Key: key, VersionId: 'v1' }] },
      { Errors: [{ Key: key, VersionId: 'v1', Code: 'AccessDenied' }] },
    ]
    const deletionError = { send: async () => deletionErrorResponses.shift() ?? {} } as unknown as S3Client
    await assert.rejects(
      () => new S3ObjectStore(deletionError, 'linerecall-private-data', 'key').deletePrivate(key),
      /not fully acknowledged/,
    )

    const remainingResponses: unknown[] = [
      { Versions: [{ Key: key, VersionId: 'v1' }] },
      {},
      { Versions: [{ Key: key, VersionId: 'v2' }] },
    ]
    const remaining = { send: async () => remainingResponses.shift() ?? {} } as unknown as S3Client
    await assert.rejects(
      () => new S3ObjectStore(remaining, 'linerecall-private-data', 'key').deletePrivate(key),
      /versions remain/,
    )

    const excessive = { send: async () => ({
      Versions: Array.from({ length: 10_001 }, (_, index) => ({ Key: key, VersionId: `v${index}` })),
    }) } as unknown as S3Client
    await assert.rejects(
      () => new S3ObjectStore(excessive, 'linerecall-private-data', 'key').deletePrivate(key),
      /too many versions/,
    )
  })
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import { EmbeddedOpeningDataSource, SnapshotDataError } from '../../src/data/embedded-opening-data-source.ts'
import { supportsOpeningFamilies } from '../../src/data/opening-data-source.ts'
import embeddedSnapshot from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import type { EmbeddedSnapshotPayload } from '../../src/data/embedded-contract.ts'

const EMBEDDED_SNAPSHOT = embeddedSnapshot as EmbeddedSnapshotPayload

function receiptWithJson(
  receipt: EmbeddedSnapshotPayload['blobs']['audit'],
  mutate: (value: Record<string, unknown>) => void,
): EmbeddedSnapshotPayload['blobs']['audit'] {
  const value = JSON.parse(gunzipSync(Buffer.from(receipt.base64, 'base64')).toString('utf8')) as Record<string, unknown>
  mutate(value)
  const uncompressed = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  const compressed = gzipSync(uncompressed, { level: 9 })
  return {
    base64: compressed.toString('base64'),
    compressedBytes: compressed.byteLength,
    uncompressedBytes: uncompressed.byteLength,
    sha256: createHash('sha256').update(compressed).digest('hex'),
  }
}

test('embedded snapshot verifies, validates, hydrates, and caches audited data', async () => {
  const source = new EmbeddedOpeningDataSource(EMBEDDED_SNAPSHOT)
  const [first, second] = await Promise.all([source.initialize(), source.initialize()])
  assert.strictEqual(first, second)
  assert.equal(first.search.l.length, 3_790)
  assert.ok(first.search.q.length > 0)
  assert.equal(first.catalog.length, 500)
  assert.equal(first.searchEntries.length, 3_790)
  assert.ok(first.variantSummaries.every((summary) => summary.cardCount > 0))
  const [audit, cachedAudit] = await Promise.all([source.loadAudit(), source.loadAudit()])
  assert.strictEqual(audit, cachedAudit)
  assert.equal(first.variantSummaries.length, audit.audit.drillableVariants)
  assert.equal(audit.corpus.recordsSeen, 1_146_297)
  assert.equal(audit.corpus.accepted, 800_176)

  const [partition, cached] = await Promise.all([
    source.loadPartition('C20'),
    source.loadPartition('C20'),
  ])
  assert.strictEqual(partition, cached)
  assert.equal(partition.eco, 'C20')
  assert.ok(partition.lines.length > 0)
  assert.ok(partition.verifiedLines.every((line) => line.eco === 'C20'))
  assert.equal(supportsOpeningFamilies(source), false)
  await assert.rejects(source.loadFamilyCatalog(), (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'missing' && /family catalog/u.test(error.message))
  await assert.rejects(source.loadFamilyManifest('Caro Kann'), (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'missing' && /identifier is invalid/u.test(error.message))
})

test('embedded data source fails accessibly for cancellation, invalid ECO, and corruption', async () => {
  const source = new EmbeddedOpeningDataSource()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(source.initialize(controller.signal), (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'aborted')
  await assert.rejects(source.loadPartition('Z99'), (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'missing')

  const corrupt = new EmbeddedOpeningDataSource({
    ...EMBEDDED_SNAPSHOT,
    blobs: {
      ...EMBEDDED_SNAPSHOT.blobs,
      search: { ...EMBEDDED_SNAPSHOT.blobs.search, sha256: '0'.repeat(64) },
    },
  })
  await assert.rejects(corrupt.initialize(), (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'corrupt')

  const decompressionOverrun = new EmbeddedOpeningDataSource({
    ...EMBEDDED_SNAPSHOT,
    blobs: {
      ...EMBEDDED_SNAPSHOT.blobs,
      search: { ...EMBEDDED_SNAPSHOT.blobs.search, uncompressedBytes: 1 },
    },
  })
  await assert.rejects(decompressionOverrun.initialize(), (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'corrupt')

  const unexpectedField = structuredClone(EMBEDDED_SNAPSHOT) as EmbeddedSnapshotPayload & { hostile?: string }
  unexpectedField.hostile = '<script>alert(1)</script>'
  await assert.rejects(new EmbeddedOpeningDataSource(unexpectedField).initialize(), (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'corrupt')

  const mismatchedAudit = structuredClone(EMBEDDED_SNAPSHOT)
  mismatchedAudit.blobs.audit = receiptWithJson(mismatchedAudit.blobs.audit, (value) => {
    const catalog = value.catalog as Array<{ drillableVariantCount: number }>
    catalog[0]!.drillableVariantCount += 1
  })
  const lazyAudit = new EmbeddedOpeningDataSource(mismatchedAudit)
  assert.equal((await lazyAudit.initialize()).search.l.length, 3_790)
  await assert.rejects(lazyAudit.loadAudit(), (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'corrupt' && /audit totals/u.test(error.message))
})

test('partition abort and corrupt retries keep validated shared wire data reusable', async () => {
  const source = new EmbeddedOpeningDataSource(EMBEDDED_SNAPSHOT)
  const controller = new AbortController()
  const cancelled = source.loadPartition('C20', controller.signal)
  controller.abort()
  await assert.rejects(cancelled, (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'aborted')
  assert.equal((await source.loadPartition('C20')).eco, 'C20')

  const c20 = JSON.parse(gunzipSync(Buffer.from(
    EMBEDDED_SNAPSHOT.partitions.C20!.base64,
    'base64',
  )).toString('utf8')) as { s: string[] }
  const corruptPayload = structuredClone(EMBEDDED_SNAPSHOT)
  const corruptShardId = c20.s[0]!
  corruptPayload.shards[corruptShardId]!.sha256 = '0'.repeat(64)
  const corruptSource = new EmbeddedOpeningDataSource(corruptPayload)
  assert.equal((await corruptSource.initialize()).search.l.length, 3_790)
  let firstMessage = ''
  await assert.rejects(corruptSource.loadPartition('C20'), (error: unknown) => {
    firstMessage = error instanceof Error ? error.message : ''
    return error instanceof SnapshotDataError && error.code === 'corrupt'
  })
  await assert.rejects(corruptSource.loadPartition('C20'), (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'corrupt' &&
    error.message === firstMessage && !/already (?:read|consumed)/u.test(error.message))
})

test('selected partitions fail closed on missing and extra evidence shard references', async () => {
  const c20 = JSON.parse(gunzipSync(Buffer.from(
    EMBEDDED_SNAPSHOT.partitions.C20!.base64,
    'base64',
  )).toString('utf8')) as { s: string[] }
  const missingPayload = structuredClone(EMBEDDED_SNAPSHOT)
  delete missingPayload.shards[c20.s[0]!]
  const missingSource = new EmbeddedOpeningDataSource(missingPayload)
  assert.equal((await missingSource.initialize()).search.l.length, 3_790)
  await assert.rejects(missingSource.loadPartition('C20'), (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'missing' && /Evidence shard/u.test(error.message))

  const extraPayload = structuredClone(EMBEDDED_SNAPSHOT)
  const extraShardId = Object.keys(extraPayload.shards).find((id) => !c20.s.includes(id))!
  extraPayload.shards[extraShardId] = receiptWithJson(extraPayload.shards[extraShardId]!, (value) => {
    const consumers = value.c as string[]
    consumers.push('C20')
    consumers.sort((left, right) => left.localeCompare(right, 'en'))
  })
  extraPayload.partitions.C20 = receiptWithJson(extraPayload.partitions.C20!, (value) => {
    const shardIds = value.s as string[]
    shardIds.push(extraShardId)
    shardIds.sort((left, right) => left.localeCompare(right, 'en'))
  })
  const extraSource = new EmbeddedOpeningDataSource(extraPayload)
  await assert.rejects(extraSource.loadPartition('C20'), (error: unknown) =>
    error instanceof SnapshotDataError && error.code === 'corrupt' &&
    error.cause instanceof Error &&
    /(?:exactly cover|Duplicate position EPD|Duplicate engine FEN)/u.test(error.cause.message))
})

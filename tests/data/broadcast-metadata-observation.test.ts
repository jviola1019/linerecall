import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  observePendingBroadcastMetadata,
  type BroadcastHeadTransport,
} from '../../scripts/data/observe-broadcast-metadata.ts'

const observedAt = '2026-08-06T14:15:16.000Z'
const sourceSnapshotSha256 = 'c'.repeat(64)

function nextMonth(month: string): string {
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const number = Number(monthText)
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`
}

function manifestWithHashes(hashes?: readonly string[]): Buffer {
  const archives: Array<Record<string, unknown>> = []
  let month = '2020-01'
  for (let index = 0; index < 78; index += 1) {
    const filename = `lichess_db_broadcast_${month}.pgn.zst`
    archives.push({
      month,
      filename,
      url: `https://database.lichess.org/broadcast/${filename}`,
      sha256: hashes?.[index] ?? index.toString(16).padStart(64, '0'),
    })
    month = nextMonth(month)
  }
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-07-11T04:31:17.000Z',
    startMonth: '2020-01',
    cutoffMonth: '2026-06',
    source: {
      listUrl: 'https://database.lichess.org/broadcast/list.txt',
      checksumsUrl: 'https://database.lichess.org/broadcast/sha256sums.txt',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
    approval: {
      status: 'approved',
      approvedOn: '2026-07-11',
      scope: 'Fixture observation scope.',
      basis: 'Fixture observation basis.',
      reviewRequiredWhen: 'Fixture identity changes.',
    },
    archives,
  }))
}

function successfulTransport(options: {
  networkDate: string
  lengths?: readonly number[]
  onActive?: (active: number) => void
}): BroadcastHeadTransport {
  let active = 0
  let call = 0
  return async ({ url }) => {
    const index = call
    call += 1
    active += 1
    options.onActive?.(active)
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
    active -= 1
    return {
      statusCode: 200,
      headers: {
        'content-length': String(options.lengths?.[index] ?? 1_000_000 + index),
        etag: `\"broadcast-${index}\"`,
        'last-modified': 'Thu, 06 Aug 2026 12:00:00 GMT',
        date: options.networkDate,
        'x-requested-url': url,
      },
      bodyBytes: 0,
    }
  }
}

test('HEAD observations are serialized, pending-only, and ignore the network Date header', async () => {
  const manifestBytes = manifestWithHashes()
  let maximumActive = 0
  const first = await observePendingBroadcastMetadata({
    manifestBytes,
    observedAt,
    sourceSnapshotSha256,
    transport: successfulTransport({
      networkDate: 'Thu, 06 Aug 2026 14:15:00 GMT',
      onActive: (active) => { maximumActive = Math.max(maximumActive, active) },
    }),
  })
  const second = await observePendingBroadcastMetadata({
    manifestBytes,
    observedAt,
    sourceSnapshotSha256,
    transport: successfulTransport({ networkDate: 'Fri, 07 Aug 2026 01:02:03 GMT' }),
  })
  assert.equal(maximumActive, 1)
  assert.deepEqual(first, second)
  assert.equal(first.reviewStatus, 'pending')
  assert.equal(first.releaseEligible, false)
  assert.equal(first.archiveCount, 78)
  assert.ok(first.archives.every(({ observation, localVerification }) =>
    observation.requestedUrl.startsWith('https://database.lichess.org/broadcast/')
    && observation.retrievedAt === observedAt
    && localVerification.status === 'not-requested'))
  assert.equal(JSON.stringify(first).includes('06 Aug 2026 14:15:00'), false)
})

test('redirects outside the exact approved HTTPS host boundary fail closed', async () => {
  let calls = 0
  await assert.rejects(() => observePendingBroadcastMetadata({
    manifestBytes: manifestWithHashes(),
    observedAt,
    sourceSnapshotSha256,
    transport: async () => {
      calls += 1
      return {
        statusCode: 302,
        headers: { location: 'https://attacker.invalid/archive.pgn.zst' },
        bodyBytes: 0,
      }
    },
  }), /approved HTTPS host boundary/iu)
  assert.equal(calls, 1)
})

test('unexpected bodies, oversized archives, and oversized headers are rejected before another request', async () => {
  for (const response of [
    {
      statusCode: 200,
      headers: { 'content-length': '100', etag: '"a"', 'last-modified': 'Thu, 06 Aug 2026 12:00:00 GMT' },
      bodyBytes: 1,
    },
    {
      statusCode: 200,
      headers: { 'content-length': String(9 * 1024 * 1024 * 1024), etag: '"a"', 'last-modified': 'Thu, 06 Aug 2026 12:00:00 GMT' },
      bodyBytes: 0,
    },
    {
      statusCode: 200,
      headers: { 'content-length': '100', etag: 'x'.repeat(17 * 1024), 'last-modified': 'Thu, 06 Aug 2026 12:00:00 GMT' },
      bodyBytes: 0,
    },
  ]) {
    let calls = 0
    await assert.rejects(() => observePendingBroadcastMetadata({
      manifestBytes: manifestWithHashes(),
      observedAt,
      sourceSnapshotSha256,
      transport: async () => {
        calls += 1
        return response
      },
    }))
    assert.equal(calls, 1)
  }
})

test('local cached archives supply observed lengths and verify approved SHA-256 without changing the manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-broadcast-cache-'))
  const contents = Array.from({ length: 78 }, (_, index) => Buffer.from(`fixture-broadcast-${index}\n`, 'utf8'))
  const hashes = contents.map((bytes) => createHash('sha256').update(bytes).digest('hex'))
  const manifestBytes = manifestWithHashes(hashes)
  const originalManifest = Buffer.from(manifestBytes)
  let month = '2020-01'
  try {
    for (const bytes of contents) {
      await writeFile(join(directory, `lichess_db_broadcast_${month}.pgn.zst`), bytes)
      month = nextMonth(month)
    }
    const inventory = await observePendingBroadcastMetadata({
      manifestBytes,
      observedAt,
      sourceSnapshotSha256,
      localArchiveDirectory: directory,
      transport: successfulTransport({ networkDate: 'Thu, 06 Aug 2026 14:15:00 GMT', lengths: contents.map(({ byteLength }) => byteLength) }),
    })
    assert.ok(inventory.archives.every(({ localVerification }, index) =>
      localVerification.status === 'verified'
      && localVerification.sha256 === hashes[index]
      && localVerification.bytes === contents[index]?.byteLength))
    assert.deepEqual(manifestBytes, originalManifest)

    await writeFile(join(directory, 'lichess_db_broadcast_2020-01.pgn.zst'), 'tampered')
    await assert.rejects(() => observePendingBroadcastMetadata({
      manifestBytes,
      observedAt,
      sourceSnapshotSha256,
      localArchiveDirectory: directory,
      transport: successfulTransport({ networkDate: 'Thu, 06 Aug 2026 14:15:00 GMT', lengths: contents.map(({ byteLength }) => byteLength) }),
    }), /SHA-256 verification/iu)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('manifest URLs remain authoritative and an unapproved manifest fails before transport', async () => {
  const value = JSON.parse(manifestWithHashes().toString('utf8')) as Record<string, any>
  value.archives[0].url = 'https://example.com/not-approved.pgn.zst'
  let calls = 0
  await assert.rejects(() => observePendingBroadcastMetadata({
    manifestBytes: Buffer.from(JSON.stringify(value)),
    observedAt,
    sourceSnapshotSha256,
    transport: async () => {
      calls += 1
      throw new Error('transport must not run')
    },
  }), /not an approved Lichess broadcast URL/iu)
  assert.equal(calls, 0)
})

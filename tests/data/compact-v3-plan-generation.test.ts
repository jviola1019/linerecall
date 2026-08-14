import assert from 'node:assert/strict'
import { access, readFile, mkdtemp, readFile as readOutput, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  generatePendingCompactV3PlanBundle,
  writePendingCompactV3PlanBundle,
} from '../../scripts/data/generate-compact-v3-plans.ts'

const generatedAt = '2026-08-06T12:34:56.000Z'
const sourceSnapshotSha256 = 'b'.repeat(64)

const limits = {
  completeBaselineMaxPly: 30,
  adaptiveEvidenceMaxPly: 100,
  adaptiveCandidateMinimumSample: 100,
  archiveConcurrency: 1,
  minimumFreeReserveBytes: 10 * 1024 * 1024 * 1024,
  countMinWidth: 16_384,
  countMinDepth: 4,
  maximumCandidates: 1_000_000,
} as const

const bounds = {
  candidateSketchMaxBytes: 16 * 1024 * 1024,
  candidateIndexMaxBytes: 4 * 1024 * 1024 * 1024,
  baselineShardMaxBytes: 4 * 1024 * 1024 * 1024,
  adaptiveShardMaxBytes: 4 * 1024 * 1024 * 1024,
  exactWorkMaxBytes: 8 * 1024 * 1024 * 1024,
  checkpointMaxBytes: 32 * 1024 * 1024,
  atomicPromotionMaxBytes: 8 * 1024 * 1024 * 1024,
  inputStagingMaxBytes: 0,
  retainedCorpusMaxBytes: 64 * 1024 * 1024 * 1024,
} as const

function nextMonth(month: string): string {
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const number = Number(monthText)
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`
}

function completeBroadcastManifest(includeRequiredMetadata = true): Buffer {
  const archives: Array<Record<string, unknown>> = []
  let month = '2020-01'
  for (let index = 0; index < 78; index += 1) {
    const filename = `lichess_db_broadcast_${month}.pgn.zst`
    archives.push({
      month,
      filename,
      url: `https://database.lichess.org/broadcast/${filename}`,
      sha256: index.toString(16).padStart(64, '0'),
      ...(includeRequiredMetadata ? {
        bytes: 1_000_000 + index,
        etagObserved: `\"broadcast-${index}\"`,
        lastModifiedObserved: 'Thu, 06 Aug 2026 12:00:00 GMT',
      } : {}),
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
      scope: 'Fixture approval scope.',
      basis: 'Fixture approval basis.',
      reviewRequiredWhen: 'Fixture identity changes.',
    },
    archives,
  }))
}

test('approved Q2 manifest deterministically produces three pending, non-release plans', async () => {
  const manifestBytes = await readFile('data/manifests/lichess-standard-q2-2026.source.json')
  const options = {
    manifestBytes,
    sourceId: 'lichess-standard-rated-q2-2026' as const,
    generatedAt,
    sourceSnapshotSha256,
    limits,
    bounds,
  }
  const first = generatePendingCompactV3PlanBundle(options)
  const second = generatePendingCompactV3PlanBundle(options)
  assert.deepEqual(first, second)
  assert.equal(first.review.reviewStatus, 'pending')
  assert.equal(first.review.releaseEligible, false)
  assert.equal(first.review.archiveCount, 3)
  assert.deepEqual(first.plans.map(({ archive }) => archive.month), ['2026-04', '2026-05', '2026-06'])
  for (const plan of first.plans) {
    assert.equal(plan.benchmark.status, 'pending')
    assert.equal(plan.benchmark.receiptSha256, null)
    assert.equal(plan.archive.retrievedAt, generatedAt)
    assert.equal(plan.archive.sourceManifestSha256, first.review.sourceManifestSha256)
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { archives: Array<Record<string, unknown>> }
  assert.deepEqual(first.plans.map(({ archive }) => ({
    url: archive.url,
    sha256: archive.sha256,
    bytes: archive.compressedBytes,
    etag: archive.etagObserved,
    modified: archive.lastModifiedObserved,
  })), manifest.archives.map((archive) => ({
    url: archive.url,
    sha256: archive.sha256,
    bytes: archive.bytes,
    etag: archive.etagObserved,
    modified: archive.lastModifiedObserved,
  })))
})

test('complete approved broadcast metadata produces all 78 canonical pending plans', () => {
  const bundle = generatePendingCompactV3PlanBundle({
    manifestBytes: completeBroadcastManifest(),
    sourceId: 'lichess-broadcasts',
    generatedAt,
    sourceSnapshotSha256,
    limits,
    bounds,
  })
  assert.equal(bundle.plans.length, 78)
  assert.equal(bundle.plans[0]?.archive.archiveId, 'broadcast-2020-01')
  assert.equal(bundle.plans.at(-1)?.archive.archiveId, 'broadcast-2026-06')
  assert.ok(bundle.plans.every(({ benchmark }) => benchmark.status === 'pending'))
  assert.ok(bundle.plans.every(({ archive }) => archive.compressedBytes > 0 && archive.etagObserved.length > 0))
})

test('broadcast generation rejects the currently missing byte and response metadata instead of inventing it', () => {
  assert.throws(() => generatePendingCompactV3PlanBundle({
    manifestBytes: completeBroadcastManifest(false),
    sourceId: 'lichess-broadcasts',
    generatedAt,
    sourceSnapshotSha256,
    limits,
    bounds,
  }), /lacks required plan metadata/iu)
})

test('manifest approval and explicit deterministic inputs fail closed', async () => {
  const manifest = JSON.parse(await readFile('data/manifests/lichess-standard-q2-2026.source.json', 'utf8')) as Record<string, any>
  manifest.approval.status = 'pending'
  manifest.approval.approvedOn = null
  assert.throws(() => generatePendingCompactV3PlanBundle({
    manifestBytes: Buffer.from(JSON.stringify(manifest)),
    sourceId: 'lichess-standard-rated-q2-2026',
    generatedAt,
    sourceSnapshotSha256,
    limits,
    bounds,
  }))
  const approved = await readFile('data/manifests/lichess-standard-q2-2026.source.json')
  assert.throws(() => generatePendingCompactV3PlanBundle({
    manifestBytes: approved,
    sourceId: 'lichess-standard-rated-q2-2026',
    generatedAt: new Date().toString(),
    sourceSnapshotSha256,
    limits,
    bounds,
  }))
  assert.throws(() => generatePendingCompactV3PlanBundle({
    manifestBytes: approved,
    sourceId: 'lichess-standard-rated-q2-2026',
    generatedAt,
    sourceSnapshotSha256: 'not-a-digest',
    limits,
    bounds,
  }))
})

test('writer verifies receipts, creates a new review directory, and refuses overwrite', async () => {
  const manifestBytes = await readFile('data/manifests/lichess-standard-q2-2026.source.json')
  const bundle = generatePendingCompactV3PlanBundle({
    manifestBytes,
    sourceId: 'lichess-standard-rated-q2-2026',
    generatedAt,
    sourceSnapshotSha256,
    limits,
    bounds,
  })
  const parent = await mkdtemp(join(tmpdir(), 'linerecall-v3-plans-'))
  const output = join(parent, 'pending-plans')
  try {
    await writePendingCompactV3PlanBundle(output, bundle)
    const review = JSON.parse(await readOutput(join(output, 'pending-plan-review.json'), 'utf8')) as Record<string, unknown>
    assert.equal(review.reviewStatus, 'pending')
    assert.equal(review.releaseEligible, false)
    await assert.rejects(() => writePendingCompactV3PlanBundle(output, bundle), /EEXIST/iu)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('writer leaves no partial destination when late plan validation fails', async () => {
  const manifestBytes = await readFile('data/manifests/lichess-standard-q2-2026.source.json')
  const bundle = generatePendingCompactV3PlanBundle({
    manifestBytes,
    sourceId: 'lichess-standard-rated-q2-2026',
    generatedAt,
    sourceSnapshotSha256,
    limits,
    bounds,
  })
  const corrupted = structuredClone(bundle)
  corrupted.plans.at(-1)!.archive.etagObserved = 'changed-after-review'
  const parent = await mkdtemp(join(tmpdir(), 'linerecall-v3-plans-atomic-'))
  const output = join(parent, 'pending-plans')
  try {
    await assert.rejects(
      writePendingCompactV3PlanBundle(output, corrupted),
      /differs from its pending-review receipt/iu,
    )
    await assert.rejects(access(output), /ENOENT/iu)
    await writePendingCompactV3PlanBundle(output, bundle)
    const review = JSON.parse(await readOutput(join(output, 'pending-plan-review.json'), 'utf8')) as Record<string, unknown>
    assert.equal(review.archiveCount, 3)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

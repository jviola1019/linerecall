import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { generatePendingCompactV3PlanBundle } from '../../scripts/data/generate-compact-v3-plans.ts'
import {
  promoteCompactV3BenchmarkPlans,
  writeApprovedCompactV3PlanBundle,
} from '../../scripts/data/promote-compact-v3-benchmark-plans.ts'
import { createFixtureBenchmarkApproval } from '../fixtures/compact-benchmark-approval.ts'

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

function bytes(value: unknown, pretty = false): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`, 'utf8')
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fixture() {
  const manifestBytes = await readFile('data/manifests/lichess-standard-q2-2026.source.json')
  const pending = generatePendingCompactV3PlanBundle({
    manifestBytes,
    sourceId: 'lichess-standard-rated-q2-2026',
    generatedAt: '2026-08-06T12:34:56.000Z',
    sourceSnapshotSha256,
    limits,
    bounds,
  })
  const reviewBytes = bytes(pending.review, true)
  const planBytes = new Map(pending.plans.map((plan) => [`${plan.archive.archiveId}.json`, bytes(plan, true)]))
  const fixtureApproval = createFixtureBenchmarkApproval({
    limits,
    bounds,
    sourceSnapshotSha256,
    acceptedGames: 800_176,
    observations: 10_000,
    peakResidentBytes: 1024,
    peakAdditionalStorageBytes: 2048,
  })
  const bootstrap = (JSON.parse(fixtureApproval.bytes.toString('utf8')) as { bootstrap: unknown }).bootstrap
  const bootstrapBytes = bytes(bootstrap)
  const decisionBytes = bytes({
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-benchmark-review-decision',
    decision: 'approved',
    approvedAt: '2026-07-16T12:10:00.000Z',
    approvedBy: 'fixture-reviewer',
    reviewNote: 'Fixture reviewer approved this exact complete replay.',
    bootstrapReceiptSha256: sha256(bootstrapBytes),
    sourceSnapshotSha256,
  })
  return { reviewBytes, planBytes, bootstrapBytes, decisionBytes }
}

test('explicit review decision promotes a pending plan bundle without making it release eligible', async () => {
  const input = await fixture()
  const bundle = promoteCompactV3BenchmarkPlans({
    pendingReviewBytes: input.reviewBytes,
    pendingPlanBytes: input.planBytes,
    bootstrapReceiptBytes: input.bootstrapBytes,
    decisionBytes: input.decisionBytes,
  })
  assert.equal(bundle.review.benchmarkApprovalStatus, 'approved')
  assert.equal(bundle.review.releaseEligible, false)
  assert.equal(bundle.plans.length, 3)
  assert.ok(bundle.plans.every(({ benchmark }) => benchmark.status === 'approved'))
  assert.equal(bundle.review.benchmarkApprovalReceiptSha256, sha256(bundle.approvalBytes))

  const parent = await mkdtemp(join(tmpdir(), 'linerecall-approved-plans-'))
  const output = join(parent, 'plans')
  try {
    await writeApprovedCompactV3PlanBundle(output, bundle)
    assert.equal(JSON.parse(await readFile(join(output, 'approved-plan-review.json'), 'utf8')).releaseEligible, false)
    await assert.rejects(() => writeApprovedCompactV3PlanBundle(output, bundle), /EEXIST|EPERM|already exists/iu)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('plan promotion rejects a decision for another bootstrap and an unreviewed extra plan', async () => {
  const input = await fixture()
  const wrongDecision = JSON.parse(input.decisionBytes.toString('utf8')) as Record<string, unknown>
  wrongDecision.bootstrapReceiptSha256 = 'd'.repeat(64)
  assert.throws(() => promoteCompactV3BenchmarkPlans({
    pendingReviewBytes: input.reviewBytes,
    pendingPlanBytes: input.planBytes,
    bootstrapReceiptBytes: input.bootstrapBytes,
    decisionBytes: bytes(wrongDecision),
  }), /does not bind/iu)
  const extra = new Map(input.planBytes)
  extra.set('unreviewed.json', bytes({ unsafe: true }))
  assert.throws(() => promoteCompactV3BenchmarkPlans({
    pendingReviewBytes: input.reviewBytes,
    pendingPlanBytes: extra,
    bootstrapReceiptBytes: input.bootstrapBytes,
    decisionBytes: input.decisionBytes,
  }), /unreviewed extra/iu)

  const prettyBootstrap = bytes(JSON.parse(input.bootstrapBytes.toString('utf8')), true)
  const prettyDecision = JSON.parse(input.decisionBytes.toString('utf8')) as Record<string, unknown>
  prettyDecision.bootstrapReceiptSha256 = sha256(prettyBootstrap)
  assert.throws(() => promoteCompactV3BenchmarkPlans({
    pendingReviewBytes: input.reviewBytes,
    pendingPlanBytes: input.planBytes,
    bootstrapReceiptBytes: prettyBootstrap,
    decisionBytes: bytes(prettyDecision),
  }), /not the canonical immutable JSON/iu)
})

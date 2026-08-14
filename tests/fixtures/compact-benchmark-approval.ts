import { createHash } from 'node:crypto'
import {
  CompactBenchmarkApprovalReceiptSchema,
  CompactBenchmarkBootstrapReceiptSchema,
  CompactBenchmarkProofSchema,
  type CompactBenchmarkProof,
  type CompactPipelineLimits,
  type CompactPreflightPlan,
  type CompactStorageBounds,
} from '../../scripts/data/compact-v3-contracts.ts'

interface FixtureMetrics {
  acceptedGames: number
  observations: number
  peakResidentBytes: number
  peakAdditionalStorageBytes: number
  measuredAt?: string
}

interface FixtureOptions extends FixtureMetrics {
  limits: CompactPipelineLimits
  bounds: CompactStorageBounds
  sourceSnapshotSha256: string
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function build(options: FixtureOptions): { proof: CompactBenchmarkProof; bytes: Buffer } {
  const measuredAt = options.measuredAt ?? '2026-07-16T12:05:00.000Z'
  const rejected = 1_146_297 - options.acceptedGames
  if (rejected < 0) throw new Error('Fixture accepted games exceed the complete broadcast total')
  const bootstrap = CompactBenchmarkBootstrapReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-benchmark-bootstrap',
    executionPurpose: 'benchmark-bootstrap',
    provisional: true,
    approvalStatus: 'unapproved',
    releaseEligible: false,
    method: 'complete-broadcast-replay-with-enforced-hard-caps',
    runId: 'fixture-broadcast-v3-20260716',
    sourceManifestSha256: 'd'.repeat(64),
    sourceSnapshotSha256: options.sourceSnapshotSha256,
    startedAt: '2026-07-16T10:00:00.000Z',
    completedAt: measuredAt,
    corpus: {
      sourceId: 'lichess-broadcasts', archiveCount: 78, publishedGames: 1_146_297,
      candidatePasses: 78, exactPasses: 78,
    },
    accounting: {
      recordsSeen: 1_146_297,
      accepted: options.acceptedGames,
      deduplicated: 0,
      rejected: { fixture_rejected: rejected },
      observations: options.observations,
    },
    resources: {
      sampleIntervalMs: 250,
      samples: 1,
      peakResidentBytes: options.peakResidentBytes,
      peakAdditionalStorageBytes: options.peakAdditionalStorageBytes,
      retainedStateBytes: 1,
      wallClockMilliseconds: 1,
      peakBytesPerAcceptedGame: options.peakAdditionalStorageBytes / options.acceptedGames,
      retainedBytesPerAcceptedGame: 1 / options.acceptedGames,
    },
    enforcedLimits: options.limits,
    enforcedBounds: options.bounds,
    pipelineReceiptSha256s: Array.from(
      { length: 156 },
      (_, index) => index.toString(16).padStart(64, '0'),
    ),
    note: 'Fixture-only complete replay; it is never production release evidence.',
  })
  const bootstrapBytes = Buffer.from(`${JSON.stringify(bootstrap)}\n`, 'utf8')
  const approval = CompactBenchmarkApprovalReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-benchmark-approval',
    approvalStatus: 'approved',
    releaseEligible: false,
    approvedAt: '2026-07-16T12:10:00.000Z',
    approvedBy: 'fixture-reviewer',
    reviewNote: 'Fixture-only approval for fail-closed tests.',
    bootstrapReceiptSha256: sha256(bootstrapBytes),
    bootstrap,
  })
  const bytes = Buffer.from(`${JSON.stringify(approval)}\n`, 'utf8')
  const proof = CompactBenchmarkProofSchema.parse({
    status: 'approved',
    method: bootstrap.method,
    receiptSha256: sha256(bytes),
    measuredAt: bootstrap.completedAt,
    acceptedGames: bootstrap.accounting.accepted,
    observations: bootstrap.accounting.observations,
    peakResidentBytes: bootstrap.resources.peakResidentBytes,
    peakAdditionalStorageBytes: bootstrap.resources.peakAdditionalStorageBytes,
    note: 'Fixture projection of the immutable approved benchmark receipt.',
  })
  return { proof, bytes }
}

export function createFixtureBenchmarkApproval(options: FixtureOptions): {
  proof: CompactBenchmarkProof
  bytes: Buffer
} {
  return build(options)
}

export function fixtureBenchmarkApprovalBytesForPlan(
  plan: CompactPreflightPlan,
  sourceSnapshotSha256: string,
): Buffer {
  if (plan.benchmark.status !== 'approved') throw new Error('Fixture plan is not approved')
  const value = build({
    limits: plan.limits,
    bounds: plan.bounds,
    sourceSnapshotSha256,
    acceptedGames: plan.benchmark.acceptedGames,
    observations: plan.benchmark.observations,
    peakResidentBytes: plan.benchmark.peakResidentBytes,
    peakAdditionalStorageBytes: plan.benchmark.peakAdditionalStorageBytes,
    ...(plan.benchmark.measuredAt === null ? {} : { measuredAt: plan.benchmark.measuredAt }),
  })
  if (value.proof.receiptSha256 !== plan.benchmark.receiptSha256) {
    throw new Error('Fixture plan benchmark projection is not reproducible')
  }
  return value.bytes
}

import { createHash } from 'node:crypto'
import {
  CompactBenchmarkApprovalReceiptSchema,
  CompactPreflightPlanSchema,
  type CompactBenchmarkApprovalReceipt,
  type CompactPreflightPlan,
} from './compact-v3-contracts.ts'

const MAXIMUM_APPROVAL_BYTES = 4 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u

function jsonReceiptBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function compactBenchmarkApprovalRelativePath(receiptSha256: string): string {
  if (!SHA256.test(receiptSha256)) throw new Error('Benchmark approval SHA-256 is invalid')
  return `benchmark-approvals/sha256/${receiptSha256}.json`
}

/**
 * Validate the exact immutable approval bytes against both the plan and the
 * source snapshot that will execute it. This must run before an evidence input
 * stream is created.
 */
export function validateCompactBenchmarkApproval(
  planValue: CompactPreflightPlan,
  approvalBytes: Uint8Array | undefined,
  expectedSourceSnapshotSha256?: string,
): CompactBenchmarkApprovalReceipt {
  const plan = CompactPreflightPlanSchema.parse(planValue)
  if (plan.benchmark.status !== 'approved' || plan.benchmark.receiptSha256 === null) {
    throw new Error('Evidence ingestion requires an approved benchmark proof')
  }
  if (!approvalBytes || approvalBytes.byteLength < 1 || approvalBytes.byteLength > MAXIMUM_APPROVAL_BYTES) {
    throw new Error('Approved benchmark receipt bytes are absent or outside the bounded input limit')
  }
  if (digest(approvalBytes) !== plan.benchmark.receiptSha256) {
    throw new Error('Approved benchmark receipt SHA-256 differs from the plan')
  }
  let value: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(approvalBytes)
    if (text.includes('\0')) throw new Error('NUL')
    value = JSON.parse(text) as unknown
  } catch {
    throw new Error('Approved benchmark receipt is not bounded UTF-8 JSON')
  }
  const approval = CompactBenchmarkApprovalReceiptSchema.parse(value)
  const bootstrapDigest = digest(jsonReceiptBytes(approval.bootstrap))
  if (bootstrapDigest !== approval.bootstrapReceiptSha256) {
    throw new Error('Approved benchmark wrapper does not bind its bootstrap receipt')
  }
  const bootstrap = approval.bootstrap
  if (
    !sameJson(bootstrap.enforcedLimits, plan.limits) ||
    !sameJson(bootstrap.enforcedBounds, plan.bounds)
  ) {
    throw new Error('Approved benchmark was measured with different enforced limits or storage bounds')
  }
  if (
    plan.benchmark.method !== bootstrap.method ||
    plan.benchmark.measuredAt !== bootstrap.completedAt ||
    plan.benchmark.acceptedGames !== bootstrap.accounting.accepted ||
    plan.benchmark.observations !== bootstrap.accounting.observations ||
    plan.benchmark.peakResidentBytes !== bootstrap.resources.peakResidentBytes ||
    plan.benchmark.peakAdditionalStorageBytes !== bootstrap.resources.peakAdditionalStorageBytes
  ) {
    throw new Error('Approved benchmark projection in the plan differs from the immutable replay receipt')
  }
  if (
    expectedSourceSnapshotSha256 !== undefined &&
    bootstrap.sourceSnapshotSha256 !== expectedSourceSnapshotSha256
  ) {
    throw new Error('Approved benchmark belongs to another source snapshot')
  }
  if (new Set(bootstrap.pipelineReceiptSha256s).size !== bootstrap.pipelineReceiptSha256s.length) {
    throw new Error('Approved benchmark repeats a pipeline receipt')
  }
  return approval
}

#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  CompactBenchmarkApprovalReceiptSchema,
  CompactBenchmarkBootstrapReceiptSchema,
  CompactPreflightPlanSchema,
  type CompactBenchmarkApprovalReceipt,
  type CompactPreflightPlan,
} from './compact-v3-contracts.ts'
import {
  CompactV3PendingPlanReviewSchema,
  type CompactV3PendingPlanReview,
} from './generate-compact-v3-plans.ts'
import { validateCompactBenchmarkApproval } from './compact-v3-benchmark-approval.ts'
import { syncCompactParentDirectory } from './compact-v3-orchestrator.ts'
import { createSourceSnapshot } from '../release/lib/source-snapshot.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const MAXIMUM_PLAN_BYTES = 1024 * 1024
const MAXIMUM_RECEIPT_BYTES = 4 * 1024 * 1024

export const CompactV3BenchmarkReviewDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v3-benchmark-review-decision'),
  decision: z.literal('approved'),
  approvedAt: z.string().datetime({ offset: true }),
  approvedBy: z.string().min(1).max(256),
  reviewNote: z.string().min(1).max(2048),
  bootstrapReceiptSha256: z.string().regex(SHA256),
  sourceSnapshotSha256: z.string().regex(SHA256),
}).strict()

export type CompactV3BenchmarkReviewDecision = z.infer<typeof CompactV3BenchmarkReviewDecisionSchema>

const ApprovedPlanFileSchema = z.object({
  archiveId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u),
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
  path: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}\.json$/u),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(SHA256),
}).strict()

export const CompactV3ApprovedPlanReviewSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v3-approved-benchmark-plan-review'),
  benchmarkApprovalStatus: z.literal('approved'),
  releaseEligible: z.literal(false),
  approvedAt: z.string().datetime({ offset: true }),
  approvedBy: z.string().min(1).max(256),
  sourceSnapshotSha256: z.string().regex(SHA256),
  sourceId: z.enum(['lichess-broadcasts', 'lichess-standard-rated-q2-2026']),
  sourceManifestSha256: z.string().regex(SHA256),
  pendingPlanReviewSha256: z.string().regex(SHA256),
  bootstrapReceiptSha256: z.string().regex(SHA256),
  benchmarkApprovalReceiptSha256: z.string().regex(SHA256),
  archiveCount: z.number().int().positive(),
  plans: z.array(ApprovedPlanFileSchema).min(1),
  note: z.literal('Benchmark approval only. Plans and resulting corpus evidence remain release-ineligible until every downstream data and release gate passes.'),
}).strict().superRefine((review, context) => {
  if (review.archiveCount !== review.plans.length) {
    context.addIssue({ code: 'custom', path: ['archiveCount'], message: 'Archive count must equal the approved plan inventory' })
  }
  if (new Set(review.plans.map(({ archiveId }) => archiveId)).size !== review.plans.length) {
    context.addIssue({ code: 'custom', path: ['plans'], message: 'Approved plan archive IDs must be unique' })
  }
})

export type CompactV3ApprovedPlanReview = z.infer<typeof CompactV3ApprovedPlanReviewSchema>

export interface PromoteCompactV3BenchmarkPlansOptions {
  pendingReviewBytes: Uint8Array
  pendingPlanBytes: ReadonlyMap<string, Uint8Array>
  bootstrapReceiptBytes: Uint8Array
  decisionBytes: Uint8Array
}

export interface ApprovedCompactV3PlanBundle {
  review: CompactV3ApprovedPlanReview
  plans: CompactPreflightPlan[]
  approval: CompactBenchmarkApprovalReceipt
  approvalBytes: Buffer
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalPrettyBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function canonicalReceiptBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

function decodeJson(bytes: Uint8Array, maximumBytes: number, label: string): unknown {
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} is outside the bounded input limit`)
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('NUL')
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${label} is not bounded UTF-8 JSON`)
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function promoteCompactV3BenchmarkPlans(
  options: PromoteCompactV3BenchmarkPlansOptions,
): ApprovedCompactV3PlanBundle {
  const pendingReview = CompactV3PendingPlanReviewSchema.parse(
    decodeJson(options.pendingReviewBytes, MAXIMUM_RECEIPT_BYTES, 'Pending plan review'),
  )
  const bootstrap = CompactBenchmarkBootstrapReceiptSchema.parse(
    decodeJson(options.bootstrapReceiptBytes, MAXIMUM_RECEIPT_BYTES, 'Benchmark bootstrap receipt'),
  )
  const canonicalBootstrapBytes = canonicalReceiptBytes(bootstrap)
  if (!Buffer.from(options.bootstrapReceiptBytes).equals(canonicalBootstrapBytes)) {
    throw new Error('Benchmark bootstrap receipt is not the canonical immutable JSON emitted by the benchmark')
  }
  const decision = CompactV3BenchmarkReviewDecisionSchema.parse(
    decodeJson(options.decisionBytes, MAXIMUM_RECEIPT_BYTES, 'Benchmark review decision'),
  )
  const bootstrapReceiptSha256 = digest(options.bootstrapReceiptBytes)
  if (
    decision.bootstrapReceiptSha256 !== bootstrapReceiptSha256 ||
    decision.sourceSnapshotSha256 !== bootstrap.sourceSnapshotSha256 ||
    decision.sourceSnapshotSha256 !== pendingReview.sourceSnapshotSha256
  ) {
    throw new Error('Benchmark review decision does not bind the exact bootstrap and source snapshot')
  }

  const plans = pendingReview.plans.map((entry) => {
    const bytes = options.pendingPlanBytes.get(entry.path)
    if (!bytes || bytes.byteLength !== entry.bytes || digest(bytes) !== entry.sha256) {
      throw new Error(`Pending plan ${entry.path} differs from its review inventory`)
    }
    const plan = CompactPreflightPlanSchema.parse(
      decodeJson(bytes, MAXIMUM_PLAN_BYTES, `Pending plan ${entry.path}`),
    )
    if (
      plan.archive.archiveId !== entry.archiveId ||
      plan.archive.month !== entry.month ||
      plan.archive.sourceId !== pendingReview.sourceId ||
      plan.archive.sourceManifestSha256 !== pendingReview.sourceManifestSha256 ||
      plan.benchmark.status !== 'pending'
    ) {
      throw new Error(`Pending plan ${entry.path} does not match its review or pending benchmark state`)
    }
    return plan
  })
  if (options.pendingPlanBytes.size !== plans.length) {
    throw new Error('Pending plan input contains unreviewed extra files')
  }
  const first = plans[0]
  if (!first) throw new Error('Pending plan inventory is empty')
  for (const plan of plans) {
    if (!sameJson(plan.limits, first.limits) || !sameJson(plan.bounds, first.bounds)) {
      throw new Error('Pending plans do not share one limits and bounds configuration')
    }
  }
  if (
    !sameJson(bootstrap.enforcedLimits, first.limits) ||
    !sameJson(bootstrap.enforcedBounds, first.bounds)
  ) {
    throw new Error('Benchmark bootstrap used different enforced limits or storage bounds')
  }

  const approval = CompactBenchmarkApprovalReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-benchmark-approval',
    approvalStatus: 'approved',
    releaseEligible: false,
    approvedAt: decision.approvedAt,
    approvedBy: decision.approvedBy,
    reviewNote: decision.reviewNote,
    bootstrapReceiptSha256,
    bootstrap,
  })
  const approvalBytes = canonicalReceiptBytes(approval)
  const approvalSha256 = digest(approvalBytes)
  const proof: CompactPreflightPlan['benchmark'] = {
    status: 'approved',
    method: bootstrap.method,
    receiptSha256: approvalSha256,
    measuredAt: bootstrap.completedAt,
    acceptedGames: bootstrap.accounting.accepted,
    observations: bootstrap.accounting.observations,
    peakResidentBytes: bootstrap.resources.peakResidentBytes,
    peakAdditionalStorageBytes: bootstrap.resources.peakAdditionalStorageBytes,
    note: 'Approved immutable complete-broadcast benchmark receipt. This approval does not make a plan or corpus release-eligible.',
  }
  const approvedPlans = plans.map((plan) => CompactPreflightPlanSchema.parse({ ...plan, benchmark: proof }))
  for (const plan of approvedPlans) {
    validateCompactBenchmarkApproval(plan, approvalBytes, decision.sourceSnapshotSha256)
  }
  const planFiles = approvedPlans.map((plan) => {
    const path = `${plan.archive.archiveId}.json`
    const bytes = canonicalPrettyBytes(plan)
    return {
      archiveId: plan.archive.archiveId,
      month: plan.archive.month,
      path,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    }
  })
  const review = CompactV3ApprovedPlanReviewSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-approved-benchmark-plan-review',
    benchmarkApprovalStatus: 'approved',
    releaseEligible: false,
    approvedAt: decision.approvedAt,
    approvedBy: decision.approvedBy,
    sourceSnapshotSha256: decision.sourceSnapshotSha256,
    sourceId: pendingReview.sourceId,
    sourceManifestSha256: pendingReview.sourceManifestSha256,
    pendingPlanReviewSha256: digest(options.pendingReviewBytes),
    bootstrapReceiptSha256,
    benchmarkApprovalReceiptSha256: approvalSha256,
    archiveCount: approvedPlans.length,
    plans: planFiles,
    note: 'Benchmark approval only. Plans and resulting corpus evidence remain release-ineligible until every downstream data and release gate passes.',
  })
  return { review, plans: approvedPlans, approval, approvalBytes }
}

export async function writeApprovedCompactV3PlanBundle(
  outputDirectoryValue: string,
  bundle: ApprovedCompactV3PlanBundle,
): Promise<void> {
  const outputDirectory = resolve(outputDirectoryValue)
  const parentDirectory = dirname(outputDirectory)
  const stagingDirectory = join(parentDirectory, `.${basename(outputDirectory)}.working-${randomUUID()}`)
  await mkdir(parentDirectory, { recursive: true })
  await mkdir(stagingDirectory, { recursive: false, mode: 0o700 })
  try {
    for (const [index, plan] of bundle.plans.entries()) {
      const receipt = bundle.review.plans[index]
      if (!receipt) throw new Error('Approved plan review is missing a plan receipt')
      const bytes = canonicalPrettyBytes(plan)
      if (bytes.byteLength !== receipt.bytes || digest(bytes) !== receipt.sha256) {
        throw new Error(`Approved plan ${receipt.path} differs from its review receipt`)
      }
      const handle = await open(join(stagingDirectory, receipt.path), 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    const approvalDirectory = join(stagingDirectory, 'benchmark-approvals', 'sha256')
    await mkdir(approvalDirectory, { recursive: true, mode: 0o700 })
    const approvalPath = join(approvalDirectory, `${bundle.review.benchmarkApprovalReceiptSha256}.json`)
    const approvalHandle = await open(approvalPath, 'wx', 0o600)
    try {
      await approvalHandle.writeFile(bundle.approvalBytes)
      await approvalHandle.sync()
    } finally {
      await approvalHandle.close()
    }
    const reviewBytes = canonicalPrettyBytes(bundle.review)
    const reviewHandle = await open(join(stagingDirectory, 'approved-plan-review.json'), 'wx', 0o600)
    try {
      await reviewHandle.writeFile(reviewBytes)
      await reviewHandle.sync()
    } finally {
      await reviewHandle.close()
    }
    await rename(stagingDirectory, outputDirectory)
    await syncCompactParentDirectory(outputDirectory)
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true })
    throw error
  }
}

interface CliArguments {
  pendingPlansDirectory: string
  bootstrapReceiptPath: string
  decisionPath: string
  outputDirectory: string
  sourceSnapshotSha256: string
}

function cliArguments(argv: readonly string[]): CliArguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid option near ${name ?? '<end>'}`)
    const key = name.slice(2)
    if (values.has(key)) throw new Error(`Duplicate option ${name}`)
    values.set(key, value)
  }
  const required = ['pending-plans-dir', 'bootstrap-receipt', 'decision', 'output-dir', 'source-snapshot-sha256'] as const
  for (const key of required) if (!values.get(key)) throw new Error(`Missing --${key}`)
  if (values.size !== required.length) throw new Error('Unknown compact-v3 benchmark plan-promotion option')
  return {
    pendingPlansDirectory: resolve(values.get('pending-plans-dir')!),
    bootstrapReceiptPath: resolve(values.get('bootstrap-receipt')!),
    decisionPath: resolve(values.get('decision')!),
    outputDirectory: resolve(values.get('output-dir')!),
    sourceSnapshotSha256: values.get('source-snapshot-sha256')!,
  }
}

async function readBounded(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) {
      throw new Error(`${label} is outside the bounded input limit`)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (after.size !== before.size || bytes.byteLength !== before.size) {
      throw new Error(`${label} changed while being read`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function main(): Promise<void> {
  const args = cliArguments(process.argv.slice(2))
  if (!SHA256.test(args.sourceSnapshotSha256)) throw new Error('--source-snapshot-sha256 must be a lowercase SHA-256')
  const currentSnapshot = await createSourceSnapshot()
  if (currentSnapshot.treeSha256 !== args.sourceSnapshotSha256) {
    throw new Error(`Source snapshot is stale; current tree SHA-256 is ${currentSnapshot.treeSha256}`)
  }
  const pendingReviewBytes = await readBounded(
    join(args.pendingPlansDirectory, 'pending-plan-review.json'),
    MAXIMUM_RECEIPT_BYTES,
    'Pending plan review',
  )
  const pendingReview = CompactV3PendingPlanReviewSchema.parse(
    decodeJson(pendingReviewBytes, MAXIMUM_RECEIPT_BYTES, 'Pending plan review'),
  )
  const pendingPlanBytes = new Map<string, Uint8Array>()
  for (const plan of pendingReview.plans) {
    pendingPlanBytes.set(plan.path, await readBounded(join(args.pendingPlansDirectory, plan.path), MAXIMUM_PLAN_BYTES, `Pending plan ${plan.path}`))
  }
  const bundle = promoteCompactV3BenchmarkPlans({
    pendingReviewBytes,
    pendingPlanBytes,
    bootstrapReceiptBytes: await readBounded(args.bootstrapReceiptPath, MAXIMUM_RECEIPT_BYTES, 'Benchmark bootstrap receipt'),
    decisionBytes: await readBounded(args.decisionPath, MAXIMUM_RECEIPT_BYTES, 'Benchmark review decision'),
  })
  if (bundle.review.sourceSnapshotSha256 !== args.sourceSnapshotSha256) {
    throw new Error('Approved plan bundle belongs to another source snapshot')
  }
  await writeApprovedCompactV3PlanBundle(args.outputDirectory, bundle)
  process.stdout.write(`${JSON.stringify({
    result: 'benchmark-approved-plans-written',
    sourceId: bundle.review.sourceId,
    archiveCount: bundle.review.archiveCount,
    outputDirectory: args.outputDirectory,
    approvalReceiptSha256: bundle.review.benchmarkApprovalReceiptSha256,
    releaseEligible: false,
  }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Compact v3 benchmark plan promotion failed: ${(error as Error).message}\n`)
    process.exitCode = 1
  })
}

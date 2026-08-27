#!/usr/bin/env node
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  CompactV31PlanReviewSchema,
  CompactV31PlanSchema,
  type CompactV31PreflightAssessment,
} from './compact-v31-contracts.ts'
import { createHash } from 'node:crypto'
import { assessCompactV31WorkDirectory } from './preflight-compact-v31.ts'
import { readBoundedRegularFile } from './compact-v3-orchestrator.ts'
import { runCompactV31BenchmarkOnce } from './compact-v31-executor.ts'
import { createSourceSnapshot } from '../release/lib/source-snapshot.ts'

const MAXIMUM_PLAN_BYTES = 2 * 1024 * 1024

export const CompactV31ExecutionStatusSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-execution-status'),
  operational: z.literal(true),
  benchmarkComplete: z.literal(false),
  releaseEligible: z.literal(false),
  reasonCode: z.enum(['resource-preflight-blocked', 'explicit-inputs-required']),
  sourceInputOpened: z.literal(false),
  preflight: z.unknown(),
  detail: z.string().min(1).max(2048),
}).strict()

export type CompactV31ExecutionStatus = z.infer<typeof CompactV31ExecutionStatusSchema>

/** Report readiness without accepting or opening a corpus source. */
export function compactV31ExecutionStatus(preflight: CompactV31PreflightAssessment): CompactV31ExecutionStatus {
  return CompactV31ExecutionStatusSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-execution-status',
    operational: true,
    benchmarkComplete: false,
    releaseEligible: false,
    reasonCode: preflight.safeToStart ? 'explicit-inputs-required' : 'resource-preflight-blocked',
    sourceInputOpened: false,
    preflight,
    detail: preflight.safeToStart
      ? 'The fixture-tested executor is available. A benchmark begins only with all 78 explicit local source paths, 78 authenticated plans, a dedicated empty or same-run resumable work directory, and a run ID. No source input was opened by this readiness check.'
      : `Resource preflight blocked (${preflight.reasonCode}). No source input was opened.`,
  })
}

interface Arguments {
  plansDirectory: string
  archivesDirectory: string
  workDirectory: string
  runId: string
}

function argumentsFor(argv: readonly string[]): Arguments {
  const options = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid option near ${name ?? '<end>'}`)
    if (options.has(name)) throw new Error(`Duplicate option ${name}`)
    options.set(name, value)
  }
  const plansDirectory = options.get('--plans-dir')
  const archivesDirectory = options.get('--archives-dir')
  const workDirectory = options.get('--work-dir')
  const runId = options.get('--run-id')
  if (!plansDirectory || !archivesDirectory || !workDirectory || !runId || options.size !== 4) {
    throw new Error('Usage: run-compact-v31-benchmark --plans-dir <78-plan-directory> --archives-dir <78-local-archive-directory> --work-dir <empty-or-same-run-directory> --run-id <unique-run-id>')
  }
  return { plansDirectory: resolve(plansDirectory), archivesDirectory: resolve(archivesDirectory), workDirectory: resolve(workDirectory), runId }
}

async function readPlans(directory: string) {
  const entries = (await readdir(directory)).sort()
  const names = entries.filter((name) => /^broadcast-\d{4}-(?:0[1-9]|1[0-2])\.json$/u.test(name))
  if (names.length !== 78 || entries.length !== 79 || !entries.includes('plan-review.json')) {
    throw new Error('Plan directory must contain only 78 canonical plan files and plan-review.json')
  }
  const reviewBytes = await readBoundedRegularFile(join(directory, 'plan-review.json'), MAXIMUM_PLAN_BYTES, 'Compact-v3.1 plan review', 1)
  const review = CompactV31PlanReviewSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reviewBytes)) as unknown)
  if (!reviewBytes.equals(Buffer.from(`${JSON.stringify(review, null, 2)}\n`, 'utf8'))) throw new Error('Plan review is not canonical JSON')
  const reviewSha256 = createHash('sha256').update(reviewBytes).digest('hex')
  const plans = []
  for (const [index, name] of names.entries()) {
    const bytes = await readBoundedRegularFile(join(directory, name), MAXIMUM_PLAN_BYTES, `Compact-v3.1 plan ${name}`, 1)
    const plan = CompactV31PlanSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
    if (!bytes.equals(Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, 'utf8'))) throw new Error(`Plan is not canonical JSON: ${name}`)
    const listed = review.plans[index]
    const observedSha256 = createHash('sha256').update(bytes).digest('hex')
    if (!listed || listed.path !== name || listed.bytes !== bytes.byteLength || listed.sha256 !== observedSha256 || listed.archiveOrdinal !== index) {
      throw new Error(`Plan review does not authenticate ${name}`)
    }
    plans.push(plan)
  }
  if (plans.some((plan, index) => plan.archiveOrdinal !== index || `${plan.archive.archiveId}.json` !== names[index])) {
    throw new Error('Plan directory is not in canonical 2020-01 through 2026-06 order')
  }
  if (
    review.configurationSha256 !== plans[0]!.configurationSha256 ||
    review.sourceSnapshotSha256 !== plans[0]!.sourceSnapshotSha256 ||
    review.benchmarkAuthorizationSha256 !== plans[0]!.benchmarkAuthorizationSha256
  ) throw new Error('Plan review binding differs from its plan bundle')
  return { plans, review, reviewSha256 }
}

async function main(): Promise<void> {
  const args = argumentsFor(process.argv.slice(2))
  const { plans, review, reviewSha256 } = await readPlans(args.plansDirectory)
  const current = await createSourceSnapshot(resolve('.'))
  if (current.treeSha256 !== plans[0]!.sourceSnapshotSha256) {
    throw new Error(`Source snapshot is stale; current tree SHA-256 is ${current.treeSha256}`)
  }
  const preflight = await assessCompactV31WorkDirectory(plans[0], args.workDirectory)
  if (!preflight.safeToStart) {
    process.stdout.write(`${JSON.stringify(compactV31ExecutionStatus(preflight), null, 2)}\n`)
    process.exitCode = 2
    return
  }
  const sourcePaths = plans.map((plan) => join(args.archivesDirectory, plan.archive.filename))
  const result = await runCompactV31BenchmarkOnce({
    plans,
    planReview: review,
    planReviewSha256: reviewSha256,
    sourcePaths,
    workDirectory: args.workDirectory,
    runId: args.runId,
  })
  process.stdout.write(`${JSON.stringify({
    result: 'compact-v31-provisional-benchmark-run-complete',
    runId: result.run.receipt.runId,
    receiptSha256: result.run.receiptSha256,
    receiptPath: result.run.path,
    releaseEligible: false,
    benchmarkPromotionAuthorized: false,
  }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Compact-v3.1 benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

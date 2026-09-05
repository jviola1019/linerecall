#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  mkdir,
  open,
  readdir,
  statfs,
} from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMPACT_ADAPTER_STATE_SCHEMA_VERSION,
  CompactBenchmarkBootstrapReceiptSchema,
  CompactPreflightPlanSchema,
  type CompactBenchmarkBootstrapReceipt,
  type CompactPassReceipt,
  type CompactPreflightPlan,
} from './compact-v3-contracts.ts'
import {
  runCompactV3ArchiveAdapter,
  runCompactV3RemoteArchiveAdapter,
} from './compact-v3-adapter.ts'
import {
  approvedArchiveIndex,
  approvedCompactCorpusFromBytes,
  type ApprovedCompactCorpus,
} from './compact-v3-manifest.ts'
import { assessCompactV3Storage } from './compact-v3-foundation.ts'
import {
  compactRetainedStateBytes,
  ensureSecureCompactWorkDirectory,
  readBoundedRegularFile,
  syncCompactParentDirectory,
  withValidatedRegularFile,
} from './compact-v3-orchestrator.ts'
import { createSourceSnapshot } from '../release/lib/source-snapshot.ts'

const SAMPLE_INTERVAL_MS = 250
const SHA256 = /^[a-f0-9]{64}$/u
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,63}$/u

interface Arguments {
  runId: string
  plansDirectory: string
  manifestPath: string
  input?: 'local-file' | 'approved-https'
  archivesDirectory?: string
  workDirectory: string
  sourceSnapshotSha256: string
}

function argumentsFor(argv: readonly string[]): Arguments {
  const options = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid option near ${name ?? '<end>'}`)
    }
    const key = name.slice(2)
    if (options.has(key)) throw new Error(`Duplicate option ${name}`)
    options.set(key, value)
  }
  const required = ['run-id', 'plans-dir', 'manifest', 'work-dir', 'source-snapshot-sha256'] as const
  for (const name of required) if (!options.get(name)) throw new Error(`Missing --${name}`)
  const archivesDirectory = options.get('archives-dir')
  const requestedInput = options.get('input')
  if ((archivesDirectory ? 1 : 0) + (requestedInput ? 1 : 0) !== 1) {
    throw new Error('Choose --archives-dir <local-directory> or --input approved-https')
  }
  if (requestedInput !== undefined && requestedInput !== 'approved-https') {
    throw new Error('--input supports only approved-https')
  }
  const allowed = new Set<string>([...required, archivesDirectory ? 'archives-dir' : 'input'])
  if ([...options.keys()].some((name) => !allowed.has(name))) {
    throw new Error('Unknown compact-v3 benchmark option')
  }
  const runId = options.get('run-id')!
  const sourceSnapshotSha256 = options.get('source-snapshot-sha256')!
  if (!RUN_ID.test(runId)) throw new Error('--run-id must be 8-64 lowercase letters, digits, or hyphens')
  if (!SHA256.test(sourceSnapshotSha256)) throw new Error('--source-snapshot-sha256 must be a lowercase SHA-256')
  return {
    runId,
    plansDirectory: resolve(options.get('plans-dir')!),
    manifestPath: resolve(options.get('manifest')!),
    input: archivesDirectory ? 'local-file' : 'approved-https',
    ...(archivesDirectory ? { archivesDirectory: resolve(archivesDirectory) } : {}),
    workDirectory: resolve(options.get('work-dir')!),
    sourceSnapshotSha256,
  }
}

function isInside(path: string, parent: string): boolean {
  const child = relative(parent, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

async function availableBytesAt(path: string): Promise<number> {
  const filesystem = await statfs(path, { bigint: true })
  const value = filesystem.bavail * filesystem.bsize
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Available storage exceeds the safe integer range')
  return Number(value)
}

function safeAdd(total: number, value: number, field: string): number {
  const next = total + value
  if (!Number.isSafeInteger(next) || next < 0) throw new Error(`${field} exceeds the safe integer range`)
  return next
}

function addRejected(target: Record<string, number>, source: Record<string, number>): void {
  for (const [reason, count] of Object.entries(source)) {
    target[reason] = safeAdd(target[reason] ?? 0, count, `Rejected ${reason}`)
  }
}

function planConfiguration(plan: CompactPreflightPlan): string {
  return JSON.stringify({
    schemaVersion: plan.schemaVersion,
    storageModel: plan.storageModel,
    limits: plan.limits,
    bounds: plan.bounds,
    benchmark: plan.benchmark,
  })
}

async function loadPlans(
  directory: string,
  corpus: ApprovedCompactCorpus,
): Promise<CompactPreflightPlan[]> {
  const plans: CompactPreflightPlan[] = []
  let configuration: string | null = null
  for (const [index, archive] of corpus.archives.entries()) {
    const archiveId = `broadcast-${archive.month}`
    const path = join(directory, `${archiveId}.json`)
    const bytes = await readBoundedRegularFile(path, 1024 * 1024, `Benchmark plan ${basename(path)}`, 1)
    const plan = CompactPreflightPlanSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
    )
    if (approvedArchiveIndex(corpus, plan.archive) !== index) {
      throw new Error(`Benchmark plan ${archiveId} is not in canonical corpus order`)
    }
    if (plan.benchmark.status !== 'pending') {
      throw new Error('Benchmark bootstrap requires pending proof in every plan')
    }
    const current = planConfiguration(plan)
    configuration ??= current
    if (current !== configuration) throw new Error('Every benchmark plan must use identical limits, bounds, and proof state')
    plans.push(plan)
  }
  return plans
}

async function assertCleanDedicatedWorkDirectory(args: Arguments): Promise<void> {
  if (isInside(args.workDirectory, resolve('data/generated/v2')) || isInside(args.workDirectory, resolve('data/raw'))) {
    throw new Error('Benchmark work must not be placed in the historical v2 or raw-input trees')
  }
  if (
    (args.archivesDirectory && isInside(args.archivesDirectory, args.workDirectory)) ||
    isInside(args.manifestPath, args.workDirectory)
  ) {
    throw new Error('Benchmark work must be isolated from source archives and manifests')
  }
  if ((await readdir(args.workDirectory)).length !== 0) {
    throw new Error('Benchmark work directory must be empty; partial runs are never represented as complete measurements')
  }
}

interface ResourceSample {
  initialAvailableBytes: number
  minimumAvailableBytes: number
  peakResidentBytes: number
  samples: number
}

async function sampleResources(workDirectory: string, sample: ResourceSample): Promise<void> {
  sample.minimumAvailableBytes = Math.min(sample.minimumAvailableBytes, await availableBytesAt(workDirectory))
  sample.peakResidentBytes = Math.max(sample.peakResidentBytes, process.memoryUsage().rss)
  sample.samples += 1
}

async function monitorResources(
  workDirectory: string,
  sample: ResourceSample,
  stopped: () => boolean,
): Promise<void> {
  while (!stopped()) {
    await sampleResources(workDirectory, sample)
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, SAMPLE_INTERVAL_MS))
  }
  await sampleResources(workDirectory, sample)
}

async function writeReceipt(
  workDirectory: string,
  receiptValue: CompactBenchmarkBootstrapReceipt,
): Promise<{ path: string; sha256: string }> {
  const receipt = CompactBenchmarkBootstrapReceiptSchema.parse(receiptValue)
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const relativePath = `benchmark-receipts/sha256/${sha256}.json`
  const path = join(workDirectory, ...relativePath.split('/'))
  await mkdir(join(workDirectory, 'benchmark-receipts', 'sha256'), { recursive: true })
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncCompactParentDirectory(path)
  return { path: relativePath, sha256 }
}

function observationsIn(receipt: CompactPassReceipt): number {
  if (receipt.pass !== 'exact') throw new Error('Observation totals require an exact-pass receipt')
  return [
    receipt.completeBaselineObservationsRetained,
    receipt.adaptiveCandidateObservationsRetained,
    receipt.adaptiveNoncandidateObservationsRejected,
  ].reduce((sum, value) => safeAdd(sum, value, 'Benchmark observations'), 0)
}

export async function runBenchmarkBootstrap(args: Arguments): Promise<{
  receipt: CompactBenchmarkBootstrapReceipt
  receiptPath: string
  receiptSha256: string
}> {
  const boundary = await ensureSecureCompactWorkDirectory(args.workDirectory, { createV3: false })
  args = { ...args, workDirectory: boundary.workDirectory }
  await assertCleanDedicatedWorkDirectory(args)
  const manifestBytes = await readBoundedRegularFile(args.manifestPath, 4 * 1024 * 1024, '--manifest', 1)
  const corpus = approvedCompactCorpusFromBytes(manifestBytes, 'lichess-broadcasts')
  if (corpus.archives.length !== 78 || corpus.publishedGameTotal !== 1_146_297) {
    throw new Error('Benchmark bootstrap requires the complete approved 78-archive broadcast corpus')
  }
  const plans = await loadPlans(args.plansDirectory, corpus)
  const sourceSnapshot = await createSourceSnapshot()
  if (sourceSnapshot.treeSha256 !== args.sourceSnapshotSha256) {
    throw new Error(`Source snapshot is stale; current tree SHA-256 is ${sourceSnapshot.treeSha256}`)
  }
  const input = args.input ?? 'local-file'
  if (input === 'local-file') {
    if (!args.archivesDirectory) throw new Error('Local benchmark input requires --archives-dir')
    for (const plan of plans) {
      const archivePath = join(args.archivesDirectory, plan.archive.filename)
      await withValidatedRegularFile(
        archivePath,
        {
          label: `Local archive ${plan.archive.filename}`,
          maximumBytes: plan.archive.compressedBytes,
          minimumBytes: plan.archive.compressedBytes,
          exactBytes: plan.archive.compressedBytes,
        },
        async () => undefined,
      )
    }
  }

  const initialAvailableBytes = await availableBytesAt(args.workDirectory)
  const initialAssessment = assessCompactV3Storage(plans[0]!, initialAvailableBytes, {
    executionPurpose: 'benchmark-bootstrap',
    retainedBytesAlreadyPresent: 0,
  })
  if (!initialAssessment.safeToStart) {
    throw new Error(`Benchmark bootstrap preflight blocked: ${initialAssessment.reasonCode}`)
  }

  const startedAt = new Date()
  const startedMilliseconds = Date.now()
  const sample: ResourceSample = {
    initialAvailableBytes,
    minimumAvailableBytes: initialAvailableBytes,
    peakResidentBytes: process.memoryUsage().rss,
    samples: 0,
  }
  let stopped = false
  const monitor = monitorResources(args.workDirectory, sample, () => stopped)
  const pipelineReceiptSha256s: string[] = []
  let candidatePasses = 0
  let exactPasses = 0
  let recordsSeen = 0
  let accepted = 0
  let deduplicated = 0
  let observations = 0
  const rejected: Record<string, number> = {}
  const toolchain = {
    node: process.version,
    chessJs: '1.4.0',
    zstd: 'node:zlib:createZstdDecompress',
    sourceSnapshotSha256: args.sourceSnapshotSha256,
    adapterStateSchemaVersion: COMPACT_ADAPTER_STATE_SCHEMA_VERSION,
  }
  const runPass = async (pass: 'candidate' | 'exact', plan: CompactPreflightPlan) => {
    const common = {
      pass,
      plan,
      corpus,
      workDirectory: args.workDirectory,
      toolchain,
      executionPurpose: 'benchmark-bootstrap' as const,
    }
    if (input === 'approved-https') return runCompactV3RemoteArchiveAdapter(common)
    return runCompactV3ArchiveAdapter({
      ...common,
      archivePath: join(args.archivesDirectory!, plan.archive.filename),
    })
  }
  try {
    for (const plan of plans) {
      const result = await runPass('candidate', plan)
      if (result.status !== 'promoted' || result.receipt.executionPurpose !== 'benchmark-bootstrap') {
        throw new Error('A clean benchmark run produced a non-provisional or pre-existing candidate receipt')
      }
      candidatePasses += 1
      pipelineReceiptSha256s.push(result.receiptSha256)
    }
    for (const plan of plans) {
      const result = await runPass('exact', plan)
      if (result.status !== 'promoted' || result.receipt.executionPurpose !== 'benchmark-bootstrap') {
        throw new Error('A clean benchmark run produced a non-provisional or pre-existing exact receipt')
      }
      exactPasses += 1
      pipelineReceiptSha256s.push(result.receiptSha256)
      recordsSeen = safeAdd(recordsSeen, result.receipt.recordsSeen, 'Benchmark records')
      accepted = safeAdd(accepted, result.receipt.accepted, 'Benchmark accepted games')
      deduplicated = safeAdd(deduplicated, result.receipt.deduplicated, 'Benchmark deduplicated games')
      addRejected(rejected, result.receipt.rejected)
      observations = safeAdd(observations, observationsIn(result.receipt), 'Benchmark observations')
    }
  } finally {
    stopped = true
    await monitor
  }
  const completedAt = new Date()
  const retainedStateBytes = await compactRetainedStateBytes(args.workDirectory)
  const peakAdditionalStorageBytes = Math.max(0, sample.initialAvailableBytes - sample.minimumAvailableBytes)
  const wallClockMilliseconds = Math.max(1, Date.now() - startedMilliseconds)
  const receipt = CompactBenchmarkBootstrapReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-benchmark-bootstrap',
    executionPurpose: 'benchmark-bootstrap',
    provisional: true,
    approvalStatus: 'unapproved',
    releaseEligible: false,
    method: 'complete-broadcast-replay-with-enforced-hard-caps',
    runId: args.runId,
    sourceManifestSha256: corpus.sourceManifestSha256,
    sourceSnapshotSha256: args.sourceSnapshotSha256,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    corpus: {
      sourceId: 'lichess-broadcasts',
      archiveCount: corpus.archives.length,
      publishedGames: corpus.publishedGameTotal,
      candidatePasses,
      exactPasses,
    },
    accounting: { recordsSeen, accepted, deduplicated, rejected, observations },
    resources: {
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      samples: sample.samples,
      peakResidentBytes: sample.peakResidentBytes,
      peakAdditionalStorageBytes,
      retainedStateBytes,
      wallClockMilliseconds,
      peakBytesPerAcceptedGame: peakAdditionalStorageBytes / accepted,
      retainedBytesPerAcceptedGame: retainedStateBytes / accepted,
    },
    enforcedLimits: plans[0]!.limits,
    enforcedBounds: plans[0]!.bounds,
    pipelineReceiptSha256s,
    note: 'Provisional benchmark measurement only. It cannot enter release evidence until a reviewer approves this exact receipt SHA-256 in a separate plan update and the corpus replay is repeated in evidence-candidate mode.',
  })
  const written = await writeReceipt(args.workDirectory, receipt)
  return { receipt, receiptPath: written.path, receiptSha256: written.sha256 }
}

async function main(): Promise<void> {
  const result = await runBenchmarkBootstrap(argumentsFor(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify({
    result: 'provisional-benchmark-complete',
    receiptPath: result.receiptPath,
    receiptSha256: result.receiptSha256,
    resources: result.receipt.resources,
    accounting: result.receipt.accounting,
    approvalStatus: 'unapproved',
    releaseEligible: false,
  }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Compact v3 benchmark bootstrap failed: ${(error as Error).message}\n`)
    process.exitCode = 1
  })
}

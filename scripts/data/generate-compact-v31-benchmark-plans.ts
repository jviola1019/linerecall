#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertBroadcastManifest,
  type BroadcastManifestV1,
} from './broadcast-contracts.ts'
import { PendingBroadcastMetadataInventorySchema } from './observe-broadcast-metadata.ts'
import {
  CompactV31BenchmarkAuthorizationReceiptSchema,
  CompactV31PlanReviewSchema,
  CompactV31PlanSchema,
  CompactV31ResourceLimitsSchema,
  compactV31ConfigurationSha256,
  type CompactV31Plan,
  type CompactV31PlanReview,
  type CompactV31ResourceLimits,
} from './compact-v31-contracts.ts'
import { readBoundedRegularFile, syncCompactParentDirectory } from './compact-v3-orchestrator.ts'
import { createIngestionSourceSnapshot } from './ingestion-source-snapshot.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const MAXIMUM_CONTROL_BYTES = 8 * 1024 * 1024

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function decodeJson(bytes: Uint8Array, label: string): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('NUL')
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${label} is not bounded UTF-8 JSON`)
  }
}

export interface CompactV31BenchmarkPlanBundle {
  review: CompactV31PlanReview
  plans: CompactV31Plan[]
}

export function generateCompactV31BenchmarkPlanBundle(options: {
  proposalBytes: Uint8Array
  observationBytes: Uint8Array
  authorizationBytes: Uint8Array
  pipelineSourceSnapshotSha256: string
  generatedAt: string
  limits: CompactV31ResourceLimits
}): CompactV31BenchmarkPlanBundle {
  if (!SHA256.test(options.pipelineSourceSnapshotSha256)) throw new Error('Pipeline source snapshot must be a lowercase SHA-256')
  const proposalValue = decodeJson(options.proposalBytes, 'Broadcast proposal')
  assertBroadcastManifest(proposalValue)
  const proposal = proposalValue as BroadcastManifestV1
  const observation = PendingBroadcastMetadataInventorySchema.parse(decodeJson(options.observationBytes, 'Broadcast observation'))
  const authorization = CompactV31BenchmarkAuthorizationReceiptSchema.parse(decodeJson(options.authorizationBytes, 'Benchmark authorization'))
  const proposalSha256 = sha256(options.proposalBytes)
  const observationSha256 = sha256(options.observationBytes)
  const authorizationSha256 = sha256(options.authorizationBytes)
  if (
    authorization.proposalSha256 !== proposalSha256 ||
    authorization.observationSha256 !== observationSha256 ||
    authorization.sourceSnapshotSha256 !== observation.sourceSnapshotSha256
  ) {
    throw new Error('Benchmark authorization does not bind the exact proposal, observation, and observation-time source snapshot')
  }
  if (
    proposal.approval.status !== 'pending' ||
    proposal.startMonth !== '2020-01' ||
    proposal.cutoffMonth !== authorization.cutoffMonth ||
    proposal.archives.length !== authorization.archiveCount ||
    proposal.metadataObservation?.receiptSha256 !== observationSha256 ||
    proposal.metadataObservation.sourceSnapshotSha256 !== authorization.sourceSnapshotSha256 ||
    proposal.metadataObservation.localArchivesVerified !== true ||
    observation.archiveCount !== authorization.archiveCount
  ) {
    throw new Error('Authorized benchmark requires the exact pending 78-archive metadata proposal and verified observation')
  }
  const observedByMonth = new Map(observation.archives.map((archive) => [archive.month, archive]))
  const compressedBytes = proposal.archives.reduce((sum, archive) => sum + (archive.bytes ?? 0), 0)
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes !== authorization.compressedBytes) {
    throw new Error('Authorized broadcast compressed-byte total does not reconcile')
  }
  for (const archive of proposal.archives) {
    const observed = observedByMonth.get(archive.month)
    if (
      archive.bytes === undefined || archive.etagObserved === undefined || archive.lastModifiedObserved === undefined ||
      !observed || observed.filename !== archive.filename || observed.approvedUrl !== archive.url ||
      observed.approvedSha256 !== archive.sha256 || observed.localVerification.status !== 'verified' ||
      observed.localVerification.bytes !== archive.bytes || observed.observation.contentLength !== archive.bytes ||
      observed.observation.etagObserved !== archive.etagObserved ||
      observed.observation.lastModifiedObserved !== archive.lastModifiedObserved
    ) {
      throw new Error(`Authorized proposal and observation differ for ${archive.month}`)
    }
  }
  const limits = CompactV31ResourceLimitsSchema.parse(options.limits)
  const partitioning = {
    algorithm: 'sha256-prefix' as const,
    prefixBits: 12,
    keyOrder: 'unsigned-byte-lexicographic' as const,
    duplicatePolicy: 'merge-identical-key-counters' as const,
  }
  const replay = {
    completeBaselineMaxPly: 30 as const,
    adaptiveEvidenceMaxPly: 100 as const,
    adaptiveCandidateMinimumSample: 100 as const,
    compressedInputReplay: 'from-byte-zero' as const,
    sourceExpansion: 'stream-only' as const,
  }
  const configurationSha256 = compactV31ConfigurationSha256({
    sourceSnapshotSha256: options.pipelineSourceSnapshotSha256,
    benchmarkAuthorizationSha256: authorizationSha256,
    limits,
    partitioning,
    replay,
  })
  const plans = proposal.archives.map((archive, archiveOrdinal) => CompactV31PlanSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-archive-plan',
    storageModel: 'log-structured-external-merge-v3.1',
    pipelineVersion: '3.1.0',
    sourceSnapshotSha256: options.pipelineSourceSnapshotSha256,
    configurationSha256,
    benchmarkAuthorizationSha256: authorizationSha256,
    executionPurpose: 'benchmark-bootstrap',
    releaseEligible: false,
    archive: {
      archiveId: `broadcast-${archive.month}`,
      sourceId: 'lichess-broadcasts',
      sourceManifestSha256: proposalSha256,
      licenseSpdxId: 'CC-BY-SA-4.0',
      cutoff: '2026-06-30',
      month: archive.month,
      filename: archive.filename,
      url: archive.url,
      compressedBytes: archive.bytes,
      sha256: archive.sha256,
      retrievedAt: proposal.metadataObservation!.observedAt,
      etagObserved: archive.etagObserved,
      lastModifiedObserved: archive.lastModifiedObserved,
    },
    archiveOrdinal,
    corpusArchiveCount: 78,
    limits,
    partitioning,
    replay,
  }))
  const planFiles = plans.map((plan) => {
    const bytes = canonicalBytes(plan)
    return {
      archiveId: plan.archive.archiveId,
      archiveOrdinal: plan.archiveOrdinal,
      path: `${plan.archive.archiveId}.json`,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    }
  })
  const review = CompactV31PlanReviewSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-benchmark-plan-review',
    reviewStatus: 'pending-benchmark',
    releaseEligible: false,
    generatedAt: options.generatedAt,
    sourceSnapshotSha256: options.pipelineSourceSnapshotSha256,
    proposalSha256,
    observationSha256,
    benchmarkAuthorizationSha256: authorizationSha256,
    configurationSha256,
    archiveCount: 78,
    publishedGames: 1_146_297,
    plans: planFiles,
    note: 'Authorized provisional benchmark plans only. The two complete broadcast runs, byte-identical repeatability binding, separate result review, full Q2 ingestion, engine/Scid work, and release gates remain incomplete.',
  })
  return { review, plans }
}

export async function writeCompactV31BenchmarkPlanBundle(
  outputDirectoryValue: string,
  bundleValue: CompactV31BenchmarkPlanBundle,
): Promise<void> {
  const review = CompactV31PlanReviewSchema.parse(bundleValue.review)
  const plans = bundleValue.plans.map((plan) => CompactV31PlanSchema.parse(plan))
  if (plans.length !== review.plans.length) throw new Error('Compact-v3.1 plan bundle does not match its review')
  const outputDirectory = resolve(outputDirectoryValue)
  const staging = join(dirname(outputDirectory), `.${basename(outputDirectory)}.working-${randomUUID()}`)
  await mkdir(dirname(outputDirectory), { recursive: true })
  await mkdir(staging, { mode: 0o700 })
  try {
    for (const [index, plan] of plans.entries()) {
      const entry = review.plans[index]!
      const bytes = canonicalBytes(plan)
      if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Plan ${entry.archiveId} differs from its review`)
      const handle = await open(join(staging, entry.path), 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    }
    const reviewHandle = await open(join(staging, 'plan-review.json'), 'wx', 0o600)
    try { await reviewHandle.writeFile(canonicalBytes(review)); await reviewHandle.sync() } finally { await reviewHandle.close() }
    await rename(staging, outputDirectory)
    await syncCompactParentDirectory(outputDirectory)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

interface CompactV31PlanArguments {
  proposal: string
  observation: string
  authorization: string
  limits: string
  'output-dir': string
  'source-snapshot-sha256': string
  'generated-at': string
}

function argumentsFor(argv: readonly string[]): CompactV31PlanArguments {
  const options = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid option near ${name ?? '<end>'}`)
    if (options.has(name)) throw new Error(`Duplicate option ${name}`)
    options.set(name, value)
  }
  const required = ['--proposal', '--observation', '--authorization', '--limits', '--output-dir', '--source-snapshot-sha256', '--generated-at'] as const
  for (const name of required) if (!options.get(name)) throw new Error(`Missing ${name}`)
  if (options.size !== required.length) throw new Error('Unknown compact-v3.1 plan option')
  return {
    proposal: options.get('--proposal')!,
    observation: options.get('--observation')!,
    authorization: options.get('--authorization')!,
    limits: options.get('--limits')!,
    'output-dir': options.get('--output-dir')!,
    'source-snapshot-sha256': options.get('--source-snapshot-sha256')!,
    'generated-at': options.get('--generated-at')!,
  }
}

async function main(): Promise<void> {
  const args = argumentsFor(process.argv.slice(2))
  const current = await createIngestionSourceSnapshot()
  if (current.treeSha256 !== args['source-snapshot-sha256']) throw new Error(`Ingestion source snapshot is stale; current pipeline SHA-256 is ${current.treeSha256}`)
  const bundle = generateCompactV31BenchmarkPlanBundle({
    proposalBytes: await readBoundedRegularFile(resolve(args.proposal), MAXIMUM_CONTROL_BYTES, 'Broadcast proposal', 1),
    observationBytes: await readBoundedRegularFile(resolve(args.observation), MAXIMUM_CONTROL_BYTES, 'Broadcast observation', 1),
    authorizationBytes: await readBoundedRegularFile(resolve(args.authorization), MAXIMUM_CONTROL_BYTES, 'Benchmark authorization', 1),
    pipelineSourceSnapshotSha256: args['source-snapshot-sha256'],
    generatedAt: args['generated-at'],
    limits: CompactV31ResourceLimitsSchema.parse(decodeJson(
      await readBoundedRegularFile(resolve(args.limits), MAXIMUM_CONTROL_BYTES, 'Compact-v3.1 limits', 1),
      'Compact-v3.1 limits',
    )),
  })
  await writeCompactV31BenchmarkPlanBundle(resolve(args['output-dir']), bundle)
  process.stdout.write(`${JSON.stringify({
    result: 'compact-v31-benchmark-plans-written',
    outputDirectory: resolve(args['output-dir']),
    archiveCount: bundle.review.archiveCount,
    configurationSha256: bundle.review.configurationSha256,
    releaseEligible: false,
  }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Compact-v3.1 plan generation failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

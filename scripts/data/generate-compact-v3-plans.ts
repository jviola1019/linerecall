#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  CompactPipelineLimitsSchema,
  CompactPreflightPlanSchema,
  CompactStorageBoundsSchema,
  type CompactPipelineLimits,
  type CompactPreflightPlan,
  type CompactStorageBounds,
} from './compact-v3-contracts.ts'
import {
  approvedCompactCorpusFromBytes,
  type ApprovedCompactCorpus,
} from './compact-v3-manifest.ts'
import { createSourceSnapshot } from '../release/lib/source-snapshot.ts'
import { syncCompactParentDirectory } from './compact-v3-orchestrator.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const ISO_TIMESTAMP = z.string().datetime({ offset: true })
const SOURCE_IDS = ['lichess-broadcasts', 'lichess-standard-rated-q2-2026'] as const

const GeneratorConfigurationSchema = z.object({
  limits: CompactPipelineLimitsSchema,
  bounds: CompactStorageBoundsSchema,
}).strict()

const RequiredManifestArchiveMetadataSchema = z.object({
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
  filename: z.string().min(1).max(255),
  url: z.string().url().startsWith('https://'),
  sha256: z.string().regex(SHA256),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  etagObserved: z.string().min(1).max(512),
  lastModifiedObserved: z.string().min(1).max(512),
}).passthrough()

const ManifestWithRequiredArchiveMetadataSchema = z.object({
  archives: z.array(RequiredManifestArchiveMetadataSchema).min(1),
}).passthrough()

const PendingPlanFileSchema = z.object({
  archiveId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u),
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
  path: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}\.json$/u),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(SHA256),
}).strict()

export const CompactV3PendingPlanReviewSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v3-pending-plan-review'),
  reviewStatus: z.literal('pending'),
  releaseEligible: z.literal(false),
  generatedAt: ISO_TIMESTAMP,
  sourceSnapshotSha256: z.string().regex(SHA256),
  sourceId: z.enum(SOURCE_IDS),
  sourceManifestSha256: z.string().regex(SHA256),
  archiveCount: z.number().int().positive(),
  planConfigurationSha256: z.string().regex(SHA256),
  plans: z.array(PendingPlanFileSchema).min(1),
  note: z.literal('Pending benchmark plans only. A separate reviewed benchmark receipt is required before evidence ingestion.'),
}).strict().superRefine((review, context) => {
  if (review.archiveCount !== review.plans.length) {
    context.addIssue({ code: 'custom', path: ['archiveCount'], message: 'Archive count must equal the plan inventory' })
  }
  if (new Set(review.plans.map(({ archiveId }) => archiveId)).size !== review.plans.length) {
    context.addIssue({ code: 'custom', path: ['plans'], message: 'Plan archive IDs must be unique' })
  }
  if (new Set(review.plans.map(({ path }) => path)).size !== review.plans.length) {
    context.addIssue({ code: 'custom', path: ['plans'], message: 'Plan paths must be unique' })
  }
})

export type CompactV3PendingPlanReview = z.infer<typeof CompactV3PendingPlanReviewSchema>

export interface PendingCompactV3PlanBundle {
  review: CompactV3PendingPlanReview
  plans: CompactPreflightPlan[]
}

export interface GeneratePendingCompactV3PlansOptions {
  manifestBytes: Uint8Array
  sourceId: (typeof SOURCE_IDS)[number]
  generatedAt: string
  sourceSnapshotSha256: string
  limits: CompactPipelineLimits
  bounds: CompactStorageBounds
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function archiveId(sourceId: GeneratePendingCompactV3PlansOptions['sourceId'], month: string): string {
  return sourceId === 'lichess-broadcasts' ? `broadcast-${month}` : `standard-${month}`
}

function requiredArchiveMetadata(
  manifestBytes: Uint8Array,
  corpus: ApprovedCompactCorpus,
): Array<z.infer<typeof RequiredManifestArchiveMetadataSchema>> {
  let manifestValue: unknown
  try {
    manifestValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as unknown
  } catch {
    throw new Error('Approved source manifest is not valid UTF-8 JSON')
  }
  const manifest = ManifestWithRequiredArchiveMetadataSchema.safeParse(manifestValue)
  if (!manifest.success) {
    const missing = manifest.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; ')
    throw new Error(`Approved source manifest lacks required plan metadata: ${missing}`)
  }
  if (manifest.data.archives.length !== corpus.archives.length) {
    throw new Error('Approved manifest metadata count differs from the approved corpus')
  }
  return corpus.archives.map((approved, index) => {
    const metadata = manifest.data.archives[index]
    if (!metadata || (
      metadata.month !== approved.month
      || metadata.filename !== approved.filename
      || metadata.url !== approved.url
      || metadata.sha256 !== approved.sha256
      || (approved.compressedBytes !== null && metadata.bytes !== approved.compressedBytes)
      || (approved.etagObserved !== null && metadata.etagObserved !== approved.etagObserved)
      || (approved.lastModifiedObserved !== null && metadata.lastModifiedObserved !== approved.lastModifiedObserved)
    )) {
      throw new Error(`Archive metadata for ${approved.month} differs from the approved manifest identity`)
    }
    return metadata
  })
}

function pendingBenchmarkProof(): CompactPreflightPlan['benchmark'] {
  return {
    status: 'pending',
    method: 'complete-broadcast-replay-with-enforced-hard-caps',
    receiptSha256: null,
    measuredAt: null,
    acceptedGames: 0,
    observations: 0,
    peakResidentBytes: 0,
    peakAdditionalStorageBytes: 0,
    note: 'Pending complete-broadcast benchmark. This plan cannot authorize evidence ingestion or release promotion.',
  }
}

export function generatePendingCompactV3PlanBundle(
  optionsValue: GeneratePendingCompactV3PlansOptions,
): PendingCompactV3PlanBundle {
  const generatedAt = ISO_TIMESTAMP.parse(optionsValue.generatedAt)
  if (!SHA256.test(optionsValue.sourceSnapshotSha256)) {
    throw new Error('Source snapshot must be a lowercase SHA-256 digest')
  }
  const configuration = GeneratorConfigurationSchema.parse({
    limits: optionsValue.limits,
    bounds: optionsValue.bounds,
  })
  const corpus = approvedCompactCorpusFromBytes(optionsValue.manifestBytes, optionsValue.sourceId)
  const metadata = requiredArchiveMetadata(optionsValue.manifestBytes, corpus)
  const benchmark = pendingBenchmarkProof()
  const plans = metadata.map((archive) => CompactPreflightPlanSchema.parse({
    schemaVersion: 3,
    storageModel: 'bounded-two-pass-content-addressed-v3',
    archive: {
      archiveId: archiveId(optionsValue.sourceId, archive.month),
      sourceId: optionsValue.sourceId,
      sourceManifestSha256: corpus.sourceManifestSha256,
      licenseSpdxId: corpus.licenseSpdxId,
      cutoff: corpus.cutoff,
      month: archive.month,
      filename: archive.filename,
      url: archive.url,
      compressedBytes: archive.bytes,
      sha256: archive.sha256,
      retrievedAt: generatedAt,
      etagObserved: archive.etagObserved,
      lastModifiedObserved: archive.lastModifiedObserved,
    },
    limits: configuration.limits,
    bounds: configuration.bounds,
    benchmark,
  }))
  const configurationBytes = canonicalBytes({
    schemaVersion: 3,
    storageModel: 'bounded-two-pass-content-addressed-v3',
    limits: configuration.limits,
    bounds: configuration.bounds,
    benchmark,
  })
  const planFiles = plans.map((plan) => {
    const bytes = canonicalBytes(plan)
    return {
      archiveId: plan.archive.archiveId,
      month: plan.archive.month,
      path: `${plan.archive.archiveId}.json`,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    }
  })
  const review = CompactV3PendingPlanReviewSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-pending-plan-review',
    reviewStatus: 'pending',
    releaseEligible: false,
    generatedAt,
    sourceSnapshotSha256: optionsValue.sourceSnapshotSha256,
    sourceId: optionsValue.sourceId,
    sourceManifestSha256: corpus.sourceManifestSha256,
    archiveCount: plans.length,
    planConfigurationSha256: sha256(configurationBytes),
    plans: planFiles,
    note: 'Pending benchmark plans only. A separate reviewed benchmark receipt is required before evidence ingestion.',
  })
  return { review, plans }
}

export async function writePendingCompactV3PlanBundle(
  outputDirectoryValue: string,
  bundleValue: PendingCompactV3PlanBundle,
): Promise<void> {
  const outputDirectory = resolve(outputDirectoryValue)
  const parentDirectory = dirname(outputDirectory)
  const stagingDirectory = join(
    parentDirectory,
    `.${basename(outputDirectory)}.staging-${randomUUID()}`,
  )
  const review = CompactV3PendingPlanReviewSchema.parse(bundleValue.review)
  if (bundleValue.plans.length !== review.plans.length) {
    throw new Error('Plan documents do not match the reviewed plan inventory')
  }
  await mkdir(parentDirectory, { recursive: true })
  try {
    await stat(outputDirectory)
    throw new Error(`EEXIST: pending plan output already exists: ${outputDirectory}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EEXIST: pending plan output already exists:')) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(stagingDirectory, { recursive: false, mode: 0o700 })
  try {
    const writeSynced = async (path: string, bytes: Uint8Array): Promise<void> => {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    for (const [index, receipt] of review.plans.entries()) {
      const plan = CompactPreflightPlanSchema.parse(bundleValue.plans[index])
      const bytes = canonicalBytes(plan)
      if (
        plan.archive.archiveId !== receipt.archiveId
        || plan.archive.month !== receipt.month
        || bytes.byteLength !== receipt.bytes
        || sha256(bytes) !== receipt.sha256
      ) {
        throw new Error(`Plan ${receipt.archiveId} differs from its pending-review receipt`)
      }
      await writeSynced(join(stagingDirectory, receipt.path), bytes)
    }
    const reviewPath = join(stagingDirectory, 'pending-plan-review.json')
    await writeSynced(reviewPath, canonicalBytes(review))
    await syncCompactParentDirectory(reviewPath)
    await rename(stagingDirectory, outputDirectory)
    await syncCompactParentDirectory(outputDirectory)
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true })
    throw error
  }
}

interface CliArguments {
  manifestPath: string
  sourceId: GeneratePendingCompactV3PlansOptions['sourceId']
  configurationPath: string
  outputDirectory: string
  generatedAt: string
  sourceSnapshotSha256: string
}

function cliArguments(argv: readonly string[]): CliArguments {
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
  const required = ['manifest', 'source-id', 'configuration', 'output-dir', 'generated-at', 'source-snapshot-sha256']
  for (const key of required) if (!options.get(key)) throw new Error(`Missing --${key}`)
  if (options.size !== required.length) throw new Error('Unknown compact-v3 plan-generation option')
  const sourceId = options.get('source-id')
  if (sourceId !== 'lichess-broadcasts' && sourceId !== 'lichess-standard-rated-q2-2026') {
    throw new Error('--source-id is not supported')
  }
  return {
    manifestPath: resolve(options.get('manifest')!),
    sourceId,
    configurationPath: resolve(options.get('configuration')!),
    outputDirectory: resolve(options.get('output-dir')!),
    generatedAt: options.get('generated-at')!,
    sourceSnapshotSha256: options.get('source-snapshot-sha256')!,
  }
}

async function main(): Promise<void> {
  const args = cliArguments(process.argv.slice(2))
  const currentSnapshot = await createSourceSnapshot()
  if (currentSnapshot.treeSha256 !== args.sourceSnapshotSha256) {
    throw new Error(`Source snapshot is stale; current tree SHA-256 is ${currentSnapshot.treeSha256}`)
  }
  const manifestBytes = await readFile(args.manifestPath)
  const configuration = GeneratorConfigurationSchema.parse(JSON.parse(await readFile(args.configurationPath, 'utf8')) as unknown)
  const bundle = generatePendingCompactV3PlanBundle({
    manifestBytes,
    sourceId: args.sourceId,
    generatedAt: args.generatedAt,
    sourceSnapshotSha256: args.sourceSnapshotSha256,
    limits: configuration.limits,
    bounds: configuration.bounds,
  })
  await writePendingCompactV3PlanBundle(args.outputDirectory, bundle)
  process.stdout.write(`${JSON.stringify({
    result: 'pending-review-plans-generated',
    sourceId: bundle.review.sourceId,
    sourceManifestSha256: bundle.review.sourceManifestSha256,
    archiveCount: bundle.review.archiveCount,
    outputDirectory: args.outputDirectory,
    reviewFile: basename(join(args.outputDirectory, 'pending-plan-review.json')),
    reviewStatus: bundle.review.reviewStatus,
    releaseEligible: bundle.review.releaseEligible,
  }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Compact v3 plan generation failed: ${(error as Error).message}\n`)
    process.exitCode = 1
  })
}

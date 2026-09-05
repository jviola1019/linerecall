import { createHash } from 'node:crypto'
import {
  CompactV31FileReceiptSchema,
  CompactV31RepeatabilityBindingSchema,
  type CompactV31ResourceObservation,
} from './compact-v31-contracts.ts'
import {
  CompactV31ProductionArchiveReceiptSchema,
  CompactV31ProductionAuthorizationSchema,
  CompactV31ProductionCorpusReceiptSchema,
  CompactV31ProductionPlanReviewSchema,
  CompactV31ProductionPlanSchema,
  assessCompactV31ProductionResources,
  compactV31ProductionConfigurationSha256,
  type CompactV31ProductionArchiveReceipt,
  type CompactV31ProductionAuthorization,
  type CompactV31ProductionCorpusReceipt,
  type CompactV31ProductionPlan,
  type CompactV31ProductionPlanReview,
} from './compact-v31-production-contracts.ts'
import type { z } from 'zod'

type FileReceipt = z.infer<typeof CompactV31FileReceiptSchema>
type PassName = 'candidate' | 'exact'

const EXPECTED_RECORDS = {
  'lichess-broadcasts': 1_146_297,
  'lichess-standard-rated-q2-2026': 267_333_507,
} as const

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface CompactV31ProductionBundle {
  authorization: CompactV31ProductionAuthorization
  authorizationReceipt: FileReceipt
  authorizationSha256: string
  repeatabilityBinding: z.infer<typeof CompactV31RepeatabilityBindingSchema>
  repeatabilityBindingSha256: string
  review: CompactV31ProductionPlanReview
  reviewReceipt: FileReceipt
  reviewSha256: string
  plans: CompactV31ProductionPlan[]
}

/**
 * Authenticate the entire production plan bundle before any source is opened.
 * Provisional benchmark authorization or receipts can never satisfy this gate.
 */
export function validateCompactV31ProductionBundle(input: {
  authorization: unknown
  authorizationReceipt: unknown
  authorizationSha256: string
  repeatabilityBinding: unknown
  repeatabilityBindingSha256: string
  review: unknown
  reviewReceipt: unknown
  reviewSha256: string
  plans: readonly unknown[]
}): CompactV31ProductionBundle {
  const authorization = CompactV31ProductionAuthorizationSchema.parse(input.authorization)
  if (authorization.decision !== 'approved') throw new Error('Compact-v3.1 production authorization is not approved')
  if (sha256(canonicalBytes(authorization)) !== input.authorizationSha256) {
    throw new Error('Production authorization digest does not match its canonical bytes')
  }
  const authorizationReceipt = CompactV31FileReceiptSchema.parse(input.authorizationReceipt)
  if (
    authorizationReceipt.sha256 !== input.authorizationSha256 ||
    authorizationReceipt.bytes !== canonicalBytes(authorization).byteLength
  ) throw new Error('Production authorization file receipt does not bind its canonical bytes')
  const repeatabilityBinding = CompactV31RepeatabilityBindingSchema.parse(input.repeatabilityBinding)
  if (sha256(canonicalBytes(repeatabilityBinding)) !== input.repeatabilityBindingSha256) {
    throw new Error('Benchmark repeatability digest does not match its canonical bytes')
  }
  if (
    authorization.benchmarkRepeatabilityBinding.sha256 !== input.repeatabilityBindingSha256 ||
    repeatabilityBinding.benchmarkAuthorizationSha256 !== authorization.benchmarkAuthorizationSha256 ||
    repeatabilityBinding.result !== 'byte-identical'
  ) throw new Error('Production authorization is not bound to the exact repeatability proof')

  const review = CompactV31ProductionPlanReviewSchema.parse(input.review)
  if (sha256(canonicalBytes(review)) !== input.reviewSha256) {
    throw new Error('Production plan-review digest does not match its canonical bytes')
  }
  const reviewReceipt = CompactV31FileReceiptSchema.parse(input.reviewReceipt)
  if (reviewReceipt.sha256 !== input.reviewSha256 || reviewReceipt.bytes !== canonicalBytes(review).byteLength) {
    throw new Error('Production plan-review file receipt does not bind its canonical bytes')
  }
  const plans = input.plans.map((plan) => CompactV31ProductionPlanSchema.parse(plan))
  if (plans.length !== review.archiveCount) throw new Error('Production plan bundle is incomplete')
  const expectedManifest = review.corpus === 'lichess-broadcasts'
    ? authorization.sourceManifests.broadcasts
    : authorization.sourceManifests.standardQ2_2026
  const expectedConfigurationSha256 = compactV31ProductionConfigurationSha256({
    sourceSnapshotSha256: repeatabilityBinding.sourceSnapshotSha256,
    productionAuthorizationSha256: input.authorizationSha256,
    benchmarkRepeatabilityBindingSha256: input.repeatabilityBindingSha256,
    corpus: review.corpus,
    limits: authorization.limits,
  })
  if (
    review.sourceSnapshotSha256 !== repeatabilityBinding.sourceSnapshotSha256 ||
    review.configurationSha256 !== expectedConfigurationSha256
  ) throw new Error('Production review source snapshot or configuration differs from its repeatability proof')
  for (const [ordinal, plan] of plans.entries()) {
    const listed = review.plans[ordinal]
    const bytes = canonicalBytes(plan)
    if (
      plan.corpus !== review.corpus || plan.archiveOrdinal !== ordinal ||
      plan.sourceSnapshotSha256 !== review.sourceSnapshotSha256 ||
      plan.configurationSha256 !== review.configurationSha256 ||
      plan.productionAuthorizationSha256 !== input.authorizationSha256 ||
      plan.benchmarkRepeatabilityBindingSha256 !== input.repeatabilityBindingSha256 ||
      plan.archive.sourceManifestSha256 !== expectedManifest.sha256 ||
      JSON.stringify(plan.limits) !== JSON.stringify(authorization.limits) ||
      !listed || listed.archiveId !== plan.archive.archiveId || listed.archiveOrdinal !== ordinal ||
      listed.path !== `${plan.archive.archiveId}.json` || listed.bytes !== bytes.byteLength ||
      listed.sha256 !== sha256(bytes)
    ) throw new Error(`Production plan ${ordinal} is not authenticated by its review and authorization`)
  }
  if (
    review.productionAuthorizationSha256 !== input.authorizationSha256 ||
    review.benchmarkRepeatabilityBindingSha256 !== input.repeatabilityBindingSha256
  ) throw new Error('Production plan review is not bound to its authorization and benchmark proof')
  return {
    authorization,
    authorizationReceipt,
    authorizationSha256: input.authorizationSha256,
    repeatabilityBinding,
    repeatabilityBindingSha256: input.repeatabilityBindingSha256,
    review,
    reviewReceipt,
    reviewSha256: input.reviewSha256,
    plans,
  }
}

export interface CompactV31ProductionPassArtifact {
  pass: PassName
  planSha256: string
  deltaReceipt: FileReceipt
  compressedInput: {
    bytes: number
    sha256: string
    verified: true
  }
  accounting: {
    recordsSeen: number
    accepted: number
    deduplicated: number
    rejected: Record<string, number>
  }
  resources: CompactV31ProductionArchiveReceipt['resources']
  completedAt: string
}

/**
 * The cohort orchestrator owns ordering, two-pass equivalence, totals, and
 * immutable-receipt assembly. A concrete archive adapter owns only streamed
 * PGN parsing and partition I/O; tests can replace it without weakening these
 * invariants.
 */
export interface CompactV31ProductionArchiveAdapter {
  observeResources(plan: CompactV31ProductionPlan): Promise<CompactV31ResourceObservation>
  executeArchive(input: {
    plan: CompactV31ProductionPlan
    pass: PassName
    candidateMergeReceipt?: FileReceipt
  }): Promise<CompactV31ProductionPassArtifact>
  merge(input: {
    plan: CompactV31ProductionPlan
    pass: PassName
    deltas: readonly CompactV31ProductionPassArtifact[]
  }): Promise<FileReceipt>
  persistArchiveReceipt(receipt: CompactV31ProductionArchiveReceipt): Promise<FileReceipt>
  sourceEdgeInventory(input: {
    plan: CompactV31ProductionPlan
    exactMergeReceipt: FileReceipt
    releaseId: string
  }): Promise<FileReceipt>
}

export async function runCompactV31ProductionCohort(options: {
  bundle: CompactV31ProductionBundle
  adapter: CompactV31ProductionArchiveAdapter
  releaseId: string
  now?: () => Date
}): Promise<{
  receipt: CompactV31ProductionCorpusReceipt
  archiveReceipts: CompactV31ProductionArchiveReceipt[]
}> {
  const { bundle, adapter } = options
  if (!/^[a-z0-9][a-z0-9._-]{2,159}$/u.test(options.releaseId)) {
    throw new Error('Production cohort release ID is invalid')
  }
  const plans = bundle.plans
  if (plans.length < 1) throw new Error('Production cohort has no plans')
  const first = plans[0]!
  const candidates: CompactV31ProductionPassArtifact[] = []
  const resourceAssessments: boolean[] = []
  for (const plan of plans) {
    // Resource availability is volatile. Sampling every archive before the
    // cohort starts leaves later plans with a stale preflight, so measure at
    // the last safe boundary before this adapter is allowed to open input.
    const observation = await adapter.observeResources(plan)
    const assessment = assessCompactV31ProductionResources(plan.limits, observation)
    resourceAssessments.push(assessment.safeToStart)
    if (!assessment.safeToStart) {
      throw new Error(`Candidate production preflight blocked before ${plan.archive.archiveId}: ${assessment.reasonCode}`)
    }
    const artifact = await adapter.executeArchive({ plan, pass: 'candidate' })
    if (artifact.pass !== 'candidate' || artifact.planSha256 !== sha256(canonicalBytes(plan))) {
      throw new Error(`Candidate adapter returned an unauthenticated artifact for ${plan.archive.archiveId}`)
    }
    candidates.push(artifact)
  }
  const candidateMergeReceipt = await adapter.merge({ plan: first, pass: 'candidate', deltas: candidates })

  const exacts: CompactV31ProductionPassArtifact[] = []
  for (const [ordinal, plan] of plans.entries()) {
    const observation = await adapter.observeResources(plan)
    const assessment = assessCompactV31ProductionResources(plan.limits, observation)
    resourceAssessments.push(assessment.safeToStart)
    if (!assessment.safeToStart) {
      throw new Error(`Exact production preflight blocked before ${plan.archive.archiveId}: ${assessment.reasonCode}`)
    }
    const artifact = await adapter.executeArchive({ plan, pass: 'exact', candidateMergeReceipt })
    if (
      artifact.pass !== 'exact' || artifact.planSha256 !== sha256(canonicalBytes(plan)) ||
      artifact.accounting.recordsSeen !== candidates[ordinal]!.accounting.recordsSeen ||
      candidates[ordinal]!.accounting.accepted !== artifact.accounting.accepted + artifact.accounting.deduplicated ||
      candidates[ordinal]!.accounting.deduplicated !== 0 ||
      JSON.stringify(candidates[ordinal]!.accounting.rejected) !== JSON.stringify(artifact.accounting.rejected)
    ) throw new Error(`Candidate and exact accounting differ for ${plan.archive.archiveId}`)
    exacts.push(artifact)
  }
  const exactMergeReceipt = await adapter.merge({ plan: first, pass: 'exact', deltas: exacts })

  const archiveReceipts: CompactV31ProductionArchiveReceipt[] = []
  const archiveReceiptFiles: FileReceipt[] = []
  for (const [ordinal, plan] of plans.entries()) {
    const candidate = candidates[ordinal]!
    const exact = exacts[ordinal]!
    if (
      exact.compressedInput.bytes !== plan.archive.compressedBytes ||
      exact.compressedInput.sha256 !== plan.archive.sha256 ||
      candidate.compressedInput.bytes !== exact.compressedInput.bytes ||
      candidate.compressedInput.sha256 !== exact.compressedInput.sha256
    ) throw new Error(`Verified source identity differs for ${plan.archive.archiveId}`)
    const receipt = CompactV31ProductionArchiveReceiptSchema.parse({
      schemaVersion: 1,
      kind: 'linerecall-compact-v31-production-archive',
      storageModel: plan.storageModel,
      pipelineVersion: plan.pipelineVersion,
      executionPurpose: plan.executionPurpose,
      releaseEligible: false,
      corpus: plan.corpus,
      productionAuthorizationSha256: bundle.authorizationSha256,
      sourceManifestSha256: plan.archive.sourceManifestSha256,
      archiveOrdinal: ordinal,
      archiveId: plan.archive.archiveId,
      planSha256: exact.planSha256,
      candidateDeltaReceipt: candidate.deltaReceipt,
      exactDeltaReceipt: exact.deltaReceipt,
      compressedInput: exact.compressedInput,
      accounting: exact.accounting,
      resources: exact.resources,
      completedAt: exact.completedAt,
    })
    archiveReceipts.push(receipt)
    archiveReceiptFiles.push(await adapter.persistArchiveReceipt(receipt))
  }
  const totals = exacts.reduce((sum, artifact) => ({
    recordsSeen: sum.recordsSeen + artifact.accounting.recordsSeen,
    accepted: sum.accepted + artifact.accounting.accepted,
    deduplicated: sum.deduplicated + artifact.accounting.deduplicated,
    rejected: sum.rejected + Object.values(artifact.accounting.rejected).reduce((value, count) => value + count, 0),
  }), { recordsSeen: 0, accepted: 0, deduplicated: 0, rejected: 0 })
  if (Object.values(totals).some((value) => !Number.isSafeInteger(value))) {
    throw new Error('Production accounting exceeds the safe integer range')
  }
  if (totals.recordsSeen !== EXPECTED_RECORDS[first.corpus]) {
    throw new Error(`Production ${first.corpus} recordsSeen does not reproduce its approved published total`)
  }
  const sourceEdgeInventory = await adapter.sourceEdgeInventory({ plan: first, exactMergeReceipt, releaseId: options.releaseId })
  const receipt = CompactV31ProductionCorpusReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-production-corpus',
    storageModel: first.storageModel,
    pipelineVersion: first.pipelineVersion,
    executionPurpose: first.executionPurpose,
    releaseEligible: false,
    releaseId: options.releaseId,
    corpus: first.corpus,
    productionAuthorization: bundle.authorizationReceipt,
    sourceManifest: first.corpus === 'lichess-broadcasts'
      ? bundle.authorization.sourceManifests.broadcasts
      : bundle.authorization.sourceManifests.standardQ2_2026,
    benchmarkRepeatabilityBinding: bundle.authorization.benchmarkRepeatabilityBinding,
    planReview: bundle.reviewReceipt,
    archiveReceipts: archiveReceiptFiles,
    candidateMergeReceipt,
    exactMergeReceipt,
    sourceArchiveCount: plans.length,
    recordsSeen: totals.recordsSeen,
    accepted: totals.accepted,
    deduplicated: totals.deduplicated,
    rejected: totals.rejected,
    allArchiveDigestsVerified: true,
    exactSecondPassComplete: true,
    accountingReconciles: totals.recordsSeen === totals.accepted + totals.deduplicated + totals.rejected,
    sourceEdgeInventory,
    resourceLimitsRespected: resourceAssessments.length === plans.length * 2
      && resourceAssessments.every(Boolean),
    completedAt: (options.now ?? (() => new Date()))().toISOString(),
  })
  return { receipt, archiveReceipts }
}

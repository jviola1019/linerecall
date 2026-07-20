import { z } from 'zod'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const SafeReleaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u)

const CompleteCorpusSchema = z.object({
  manifestSha256: Sha256Schema,
  archiveCount: z.number().int().positive(),
  archivesComplete: z.literal(true),
  digestsVerified: z.literal(true),
  recordsSeen: z.number().int().positive(),
  accepted: z.number().int().positive(),
  rejected: z.number().int().nonnegative(),
  deduplicated: z.number().int().nonnegative(),
  accountingReconciles: z.literal(true),
}).strict()

export const ProductionDataReadinessSchema = z.object({
  schemaVersion: z.literal(3),
  status: z.literal('pass'),
  releaseId: SafeReleaseIdSchema,
  auditedAt: z.string().datetime({ offset: true }),
  storageModel: z.literal('bounded-two-pass-content-addressed-v3'),
  appSnapshotManifestSha256: Sha256Schema,
  corpora: z.object({
    broadcasts: CompleteCorpusSchema.extend({
      archiveCount: z.literal(78),
      recordsSeen: z.literal(1_146_297),
    }).strict(),
    standardQ2_2026: CompleteCorpusSchema.extend({
      archiveCount: z.literal(3),
      publishedRecords: z.literal(267_333_507),
      publishedCompressedBytes: z.literal(87_256_474_116),
    }).strict(),
  }).strict(),
  graph: z.object({
    schemaVersion: z.literal(3),
    baselineMaximumPly: z.literal(30),
    adaptiveMaximumPly: z.literal(100),
    exactSecondPassComplete: z.literal(true),
    reconciliationComplete: z.literal(true),
    allEligiblePracticeBranchesRetained: z.literal(true),
    maximumPracticeBranches: z.null(),
    hiddenEligiblePracticeBranches: z.literal(0),
    terminalPolicy: z.literal('evidence-defined-through-ply-100'),
    coreMinimumLearnerDecisions: z.literal(10),
    provenanceMissing: z.literal(0),
    illegalEdges: z.literal(0),
    quarantinedEdgesInDrills: z.literal(0),
    unresolvedDataDiscrepancies: z.literal(0),
  }).strict(),
  engine: z.object({
    name: z.literal('Stockfish 18'),
    threads: z.literal(1),
    hashMb: z.literal(128),
    multiPv: z.literal(5),
    nodes: z.literal(250_000),
    learnerNodesChecked: z.number().int().positive(),
    engineSha256: Sha256Schema,
    nnueSha256: z.array(Sha256Schema).min(1),
  }).strict(),
  scid: z.object({
    sampledLines: z.number().int().min(1).max(250),
    conflictingBaseEcoInDrills: z.literal(0),
    oracleContentShipped: z.literal(false),
  }).strict(),
  puzzles: z.object({
    sourceDigestApproved: z.literal(true),
    sourceSha256: Sha256Schema,
    accepted: z.number().int().positive(),
    learnerNodesEngineChecked: z.literal(true),
    masterySeparatedFromRecall: z.literal(true),
  }).strict(),
  caroKann: z.object({
    ecoRange: z.literal('B10-B19'),
    familyGraphCount: z.literal(1),
    drillablePaths: z.number().int().min(8),
    namedFamilies: z.array(z.enum(['Advance', 'Exchange', 'Panov', 'Classical', 'Two Knights'])).length(5),
    mislabeledCorePaths: z.literal(0),
  }).strict(),
}).strict().superRefine((value, context) => {
  for (const [name, corpus] of Object.entries(value.corpora)) {
    if (corpus.accepted + corpus.rejected + corpus.deduplicated !== corpus.recordsSeen) {
      context.addIssue({
        code: 'custom',
        path: ['corpora', name],
        message: 'Accepted, rejected, and deduplicated totals must reconcile to recordsSeen.',
      })
    }
  }
  if (value.corpora.standardQ2_2026.recordsSeen !== value.corpora.standardQ2_2026.publishedRecords) {
    context.addIssue({
      code: 'custom',
      path: ['corpora', 'standardQ2_2026', 'recordsSeen'],
      message: 'The complete standard-quarter run must reproduce the publisher record total.',
    })
  }
  if (new Set(value.caroKann.namedFamilies).size !== 5) {
    context.addIssue({
      code: 'custom',
      path: ['caroKann', 'namedFamilies'],
      message: 'All five required Caro-Kann families must be represented exactly once.',
    })
  }
})

export const ProductionAppSnapshotManifestSchema = z.object({
  v: z.literal(3),
  schema: z.literal('linerecall-app-wire-v3'),
  releaseId: SafeReleaseIdSchema,
  selectionPolicy: z.object({
    practiceBranches: z.literal('all-eligible-audited'),
    maximumPracticeBranches: z.null(),
    terminal: z.literal('evidence-defined-through-ply-100'),
  }).strict(),
}).passthrough()

export type ProductionDataReadiness = z.infer<typeof ProductionDataReadinessSchema>

export function evaluateProductionDataReadiness(
  readinessValue: unknown,
  appManifestValue: unknown,
  appManifestSha256: string,
): Array<Record<string, unknown>> {
  const findings: Array<Record<string, unknown>> = []
  const readiness = ProductionDataReadinessSchema.safeParse(readinessValue)
  const appManifest = ProductionAppSnapshotManifestSchema.safeParse(appManifestValue)
  if (!readiness.success) {
    findings.push({
      rule: 'production-data-readiness-invalid',
      issues: readiness.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
    })
  }
  if (!appManifest.success) {
    findings.push({
      rule: 'legacy-or-invalid-app-snapshot',
      summary: 'Production requires app-wire-v3 with all eligible audited branches and no hard practice-branch cap.',
      issues: appManifest.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
    })
  }
  if (readiness.success && readiness.data.appSnapshotManifestSha256 !== appManifestSha256) {
    findings.push({
      rule: 'app-snapshot-readiness-digest-mismatch',
      expected: readiness.data.appSnapshotManifestSha256,
      actual: appManifestSha256,
    })
  }
  if (readiness.success && appManifest.success && readiness.data.releaseId !== appManifest.data.releaseId) {
    findings.push({
      rule: 'app-snapshot-release-id-mismatch',
      readinessReleaseId: readiness.data.releaseId,
      appSnapshotReleaseId: appManifest.data.releaseId,
    })
  }
  return findings
}

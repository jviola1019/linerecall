import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  isExecutedDirectly,
  sha256File,
  workspaceRoot,
} from '../security/lib/files.ts'
import {
  GateConfigSchema,
  readEvidence,
  resolveWorkspaceEvidencePath,
  type GateResult,
} from './lib/evidence-integrity.ts'
import {
  ReleaseBindingsSchema,
  canonicalJson,
  loadVerifiedReleaseBindings,
} from './lib/release-bindings.ts'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const ReleaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u)
const WorkspacePathSchema = z.string().min(1).refine(
  (path) => !/^[A-Za-z]:/u.test(path)
    && !/^[\\/]/u.test(path)
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path),
)
const FileReceiptSchema = z.object({
  path: WorkspacePathSchema,
  bytes: z.number().int().positive().max(10 * 1024 * 1024),
  sha256: Sha256Schema,
}).strict()
const EvidenceReferenceSchema = z.object({
  path: WorkspacePathSchema,
  sha256: Sha256Schema,
  sourcePath: WorkspacePathSchema.optional(),
}).strict()
const GateResultSchema = z.object({
  id: z.string().min(1),
  status: z.literal('pass'),
  summary: z.string().min(1),
  durationMs: z.number().int().nonnegative().optional(),
  evidencePath: WorkspacePathSchema.optional(),
  evidenceRecord: z.object({ path: WorkspacePathSchema, sha256: Sha256Schema }).strict().optional(),
  evidenceReceipts: z.array(EvidenceReferenceSchema).optional(),
  sourceSnapshot: z.object({
    path: WorkspacePathSchema,
    sha256: Sha256Schema,
    treeSha256: Sha256Schema,
  }).strict().optional(),
  logTail: z.string().optional(),
}).strict()
const PassingReportSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.string().datetime({ offset: true }),
  status: z.literal('pass'),
  shippable: z.literal(true),
  candidate: FileReceiptSchema.extend({ path: z.literal('build/candidate/linerecall.html') }).strict(),
  artifact: FileReceiptSchema.extend({ path: z.literal('dist/linerecall.html') }).strict(),
  automated: z.array(GateResultSchema).min(1),
  evidence: z.array(GateResultSchema.extend({
    evidencePath: WorkspacePathSchema,
    evidenceRecord: z.object({ path: WorkspacePathSchema, sha256: Sha256Schema }).strict(),
    evidenceReceipts: z.array(EvidenceReferenceSchema),
  }).strict()).min(1),
  bindings: ReleaseBindingsSchema,
  blockers: z.array(z.never()).max(0),
  limitations: z.array(z.string().min(1)),
}).strict()
const MarkerBindingSchema = z.object({
  gateConfigSha256: Sha256Schema,
  sourceSnapshotSha256: Sha256Schema,
  sourceTreeSha256: Sha256Schema,
  productionReadinessSha256: Sha256Schema,
  appSnapshotManifestSha256: Sha256Schema,
  automatedGateStatusSha256: Sha256Schema,
  preSigningEvidenceBundleSha256: Sha256Schema,
  evidenceBundleSha256: Sha256Schema,
  signingAttestationSha256: Sha256Schema,
  signingPayloadSha256: Sha256Schema,
  signingKeyId: z.string().min(1),
}).strict()
const MarkerSchema = z.object({
  schemaVersion: z.literal(3),
  shippable: z.literal(true),
  releaseId: ReleaseIdSchema,
  auditedAt: z.string().datetime({ offset: true }),
  artifact: FileReceiptSchema.extend({ path: z.literal('dist/linerecall.html') }).strict(),
  report: z.literal('audit/generated/release-gate.json'),
  reportSha256: Sha256Schema,
  bindings: MarkerBindingSchema,
}).strict()

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}.`)
  return value
}

function assertExactIds(actual: readonly { id: string }[], expected: readonly { id: string }[], label: string): void {
  const actualIds = actual.map(({ id }) => id)
  const expectedIds = expected.map(({ id }) => id)
  if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
    throw new Error(`${label} gate IDs or order do not match the exact configured set.`)
  }
}

function markerBindings(report: z.infer<typeof PassingReportSchema>): z.infer<typeof MarkerBindingSchema> {
  return {
    gateConfigSha256: report.bindings.gateConfig.sha256,
    sourceSnapshotSha256: report.bindings.sourceSnapshot.sha256,
    sourceTreeSha256: report.bindings.sourceSnapshot.treeSha256,
    productionReadinessSha256: report.bindings.productionReadiness.sha256,
    appSnapshotManifestSha256: report.bindings.appSnapshotManifest.sha256,
    automatedGateStatusSha256: report.bindings.automatedGateStatusSha256,
    preSigningEvidenceBundleSha256: report.bindings.preSigningEvidenceBundleSha256,
    evidenceBundleSha256: report.bindings.evidenceBundleSha256,
    signingAttestationSha256: report.bindings.signingAttestation.sha256,
    signingPayloadSha256: report.bindings.signingAttestation.payloadSha256,
    signingKeyId: report.bindings.signingAttestation.keyId,
  }
}

export async function verifyPagesRelease(options: {
  root: string
  releaseId: string
  sha256: string
  configPath?: string
  sourceRoots?: readonly string[]
}): Promise<{ releaseId: string; sha256: string }> {
  const expectedReleaseId = ReleaseIdSchema.parse(options.releaseId)
  const expectedSha256 = Sha256Schema.parse(options.sha256)
  const configPath = options.configPath ?? 'config/release-gates.json'
  const configAbsolute = resolveWorkspaceEvidencePath(options.root, configPath)
  const config = GateConfigSchema.parse(JSON.parse(await readFile(configAbsolute, 'utf8')) as unknown)
  if (
    config.candidate !== 'build/candidate/linerecall.html'
    || config.artifact !== 'dist/linerecall.html'
    || config.marker !== 'dist/SHIPPABLE.json'
    || config.report !== 'audit/generated/release-gate.json'
  ) throw new Error('Release configuration does not use the controlled production paths.')

  const artifactPath = resolve(options.root, config.artifact)
  const candidatePath = resolve(options.root, config.candidate)
  const markerPath = resolve(options.root, config.marker)
  const reportPath = resolve(options.root, config.report)
  const marker = MarkerSchema.parse(JSON.parse(await readFile(markerPath, 'utf8')) as unknown)
  const report = PassingReportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')) as unknown)
  assertExactIds(report.automated, config.automated, 'Automated')
  assertExactIds(report.evidence, config.evidence, 'Evidence')

  const [artifactStat, candidateStat] = await Promise.all([stat(artifactPath), stat(candidatePath)])
  if (!artifactStat.isFile() || !candidateStat.isFile()) throw new Error('Candidate and artifact must be regular files.')
  const [artifactSha256, candidateSha256, reportSha256, configSha256] = await Promise.all([
    sha256File(artifactPath),
    sha256File(candidatePath),
    sha256File(reportPath),
    sha256File(configAbsolute),
  ])
  if (artifactSha256 !== candidateSha256 || artifactStat.size !== candidateStat.size) {
    throw new Error('The promoted artifact bytes do not equal the audited candidate bytes.')
  }
  const actualCandidate = { path: config.candidate, bytes: candidateStat.size, sha256: candidateSha256 }
  const actualArtifact = { path: config.artifact, bytes: artifactStat.size, sha256: artifactSha256 }
  if (canonicalJson(report.candidate) !== canonicalJson(actualCandidate)) throw new Error('Report candidate receipt is stale.')
  if (canonicalJson(report.artifact) !== canonicalJson(actualArtifact)) throw new Error('Report artifact receipt is stale.')
  if (report.bindings.gateConfig.path !== configPath || report.bindings.gateConfig.sha256 !== configSha256) {
    throw new Error('Release report does not bind the exact gate configuration.')
  }
  if (canonicalJson(report.limitations) !== canonicalJson(config.limitations)) {
    throw new Error('Release report limitations do not match the exact gate configuration.')
  }

  const freshEvidence: GateResult[] = []
  for (const [index, requirement] of config.evidence.entries()) {
    const reported = report.evidence[index]!
    if (reported.evidencePath !== requirement.path || reported.evidenceRecord.path !== requirement.path) {
      throw new Error(`Evidence result path does not match configuration: ${requirement.id}`)
    }
    const fresh = await readEvidence(
      requirement.id,
      requirement.path,
      candidateSha256,
      options.root,
      requirement.sourceSnapshot,
      options.sourceRoots,
      requirement.template,
    )
    if (fresh.status !== 'pass') throw new Error(`Evidence no longer passes: ${requirement.id}: ${fresh.summary}`)
    for (const key of ['evidenceRecord', 'evidenceReceipts', 'sourceSnapshot'] as const) {
      if (canonicalJson(reported[key] ?? null) !== canonicalJson(fresh[key] ?? null)) {
        throw new Error(`Evidence binding changed after the report was written: ${requirement.id} ${key}`)
      }
    }
    freshEvidence.push(fresh)
  }

  const automatedResults: GateResult[] = report.automated.map(({ id, status, summary }) => ({
    id,
    status,
    summary,
  }))

  const freshBindings = await loadVerifiedReleaseBindings({
    root: options.root,
    configPath,
    config,
    automated: automatedResults,
    evidence: freshEvidence,
    candidate: { bytes: candidateStat.size, sha256: candidateSha256 },
    ...(options.sourceRoots === undefined ? {} : { sourceRoots: options.sourceRoots }),
  })
  if (canonicalJson(report.bindings) !== canonicalJson(freshBindings)) {
    throw new Error('Release input bindings changed after the report was written.')
  }
  if (canonicalJson(marker.bindings) !== canonicalJson(markerBindings(report))) {
    throw new Error('SHIPPABLE.json does not bind the exact release report inputs.')
  }
  if (marker.releaseId !== expectedReleaseId || marker.releaseId !== report.bindings.releaseId) {
    throw new Error('The requested release ID does not match the signed release inputs.')
  }
  if (marker.auditedAt !== report.generatedAt) throw new Error('The marker timestamp does not match the audited report.')
  if (canonicalJson(marker.artifact) !== canonicalJson(actualArtifact)) throw new Error('The marker artifact receipt is stale.')
  if (marker.reportSha256 !== reportSha256) throw new Error('The release report digest does not match SHIPPABLE.json.')
  if (expectedSha256 !== artifactSha256) throw new Error('The operator-provided artifact digest does not match the file.')

  return { releaseId: marker.releaseId, sha256: artifactSha256 }
}

if (isExecutedDirectly(import.meta.url)) {
  const receipt = await verifyPagesRelease({
    root: workspaceRoot,
    releaseId: argument('--release-id'),
    sha256: argument('--sha256'),
  })
  process.stdout.write(`Release review bundle verified: ${receipt.releaseId} ${receipt.sha256}\n`)
}

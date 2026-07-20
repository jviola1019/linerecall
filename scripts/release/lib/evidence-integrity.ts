import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import {
  fileExists,
  sha256File,
  workspaceRoot,
} from '../../security/lib/files.ts'
import { validateSourceSnapshot } from './source-snapshot.ts'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const WorkspacePathSchema = z.string().min(1).refine(
  (path) => !/^[A-Za-z]:/u.test(path)
    && !/^[\\/]/u.test(path)
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path),
  'Path must be workspace-relative and may not contain parent traversal',
)

export const EvidenceReferenceSchema = z.object({
  path: WorkspacePathSchema,
  sha256: Sha256Schema,
  sourcePath: WorkspacePathSchema.optional(),
}).strict()

const EvidenceBaseSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  summary: z.string().min(1),
  limitations: z.array(z.string().min(1)),
  sourceSnapshotSha256: Sha256Schema.nullable().optional(),
  coverageGaps: z.array(z.string().min(1)).optional(),
  requiredReview: z.array(z.string().min(1)).optional(),
  requiredEnvironments: z.array(z.string().min(1)).optional(),
  requiredChecks: z.array(z.string().min(1)).optional(),
})

const CompletedEvidenceFields = {
  completedAt: z.string().datetime({ offset: true }),
  reviewer: z.string().trim().min(1),
  artifactSha256: Sha256Schema,
  evidence: z.array(EvidenceReferenceSchema).min(1),
}

export const EvidenceRecordSchema = z.discriminatedUnion('status', [
  EvidenceBaseSchema.extend({
    status: z.literal('pass'),
    ...CompletedEvidenceFields,
  }).strict(),
  EvidenceBaseSchema.extend({
    status: z.literal('fail'),
    ...CompletedEvidenceFields,
  }).strict(),
  EvidenceBaseSchema.extend({
    status: z.literal('not_run'),
    completedAt: z.null(),
    reviewer: z.null(),
    artifactSha256: z.null(),
    evidence: z.array(EvidenceReferenceSchema).max(0),
  }).strict(),
]).superRefine((value, context) => {
  const paths = new Set<string>()
  for (const [index, reference] of value.evidence.entries()) {
    if (paths.has(reference.path)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate evidence reference path: ${reference.path}`,
        path: ['evidence', index, 'path'],
      })
    }
    paths.add(reference.path)
  }
})

const AutomatedGateSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
}).strict()

const EvidenceRequirementSchema = z.object({
  id: z.string().min(1),
  path: WorkspacePathSchema,
  template: WorkspacePathSchema,
  sourceSnapshot: WorkspacePathSchema.optional(),
}).strict()

const ReleaseBindingsSchema = z.object({
  sourceSnapshot: WorkspacePathSchema,
  productionReadiness: WorkspacePathSchema,
  appSnapshotManifest: WorkspacePathSchema,
}).strict()

const SigningConfigSchema = z.object({
  evidenceId: z.string().min(1),
  trustedKeys: WorkspacePathSchema,
  attestationSourcePath: WorkspacePathSchema,
}).strict()

export const GateConfigSchema = z.object({
  schemaVersion: z.literal(1),
  candidate: WorkspacePathSchema,
  artifact: WorkspacePathSchema,
  marker: WorkspacePathSchema,
  report: WorkspacePathSchema,
  automated: z.array(AutomatedGateSchema).min(1),
  evidence: z.array(EvidenceRequirementSchema).min(1),
  releaseBindings: ReleaseBindingsSchema,
  signing: SigningConfigSchema,
  limitations: z.array(z.string().min(1)),
}).strict().superRefine((value, context) => {
  const ids = new Map<string, string>()
  const evidencePaths = new Map<string, number>()
  const templatePaths = new Map<string, number>()
  for (const [group, entries] of [
    ['automated', value.automated],
    ['evidence', value.evidence],
  ] as const) {
    for (const [index, entry] of entries.entries()) {
      const prior = ids.get(entry.id)
      if (prior !== undefined) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate release gate ID ${entry.id} (already declared in ${prior})`,
          path: [group, index, 'id'],
        })
      } else {
        ids.set(entry.id, group)
      }
    }
  }
  for (const [index, entry] of value.evidence.entries()) {
    const priorEvidence = evidencePaths.get(entry.path)
    if (priorEvidence !== undefined) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate evidence destination ${entry.path} (already declared at index ${priorEvidence})`,
        path: ['evidence', index, 'path'],
      })
    } else {
      evidencePaths.set(entry.path, index)
    }
    const priorTemplate = templatePaths.get(entry.template)
    if (priorTemplate !== undefined) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate evidence template ${entry.template} (already declared at index ${priorTemplate})`,
        path: ['evidence', index, 'template'],
      })
    } else {
      templatePaths.set(entry.template, index)
    }
    if (entry.path === entry.template) {
      context.addIssue({
        code: 'custom',
        message: 'Evidence destination and immutable template must be different paths',
        path: ['evidence', index],
      })
    }
  }
  if (!value.evidence.some((entry) => entry.id === value.signing.evidenceId)) {
    context.addIssue({
      code: 'custom',
      message: `Signing evidence ID ${value.signing.evidenceId} is not declared in evidence requirements`,
      path: ['signing', 'evidenceId'],
    })
  }
})

export type GateConfig = z.infer<typeof GateConfigSchema>

export interface GateResult {
  id: string
  status: 'pass' | 'fail' | 'not_run'
  summary: string
  durationMs?: number
  evidencePath?: string
  evidenceRecord?: { path: string; sha256: string }
  evidenceReceipts?: Array<z.infer<typeof EvidenceReferenceSchema>>
  sourceSnapshot?: { path: string; sha256: string; treeSha256: string }
  logTail?: string
}

export function defaultReleasePaths(root = workspaceRoot) {
  return {
    artifact: resolve(root, 'dist/linerecall.html'),
    marker: resolve(root, 'dist/SHIPPABLE.json'),
    report: resolve(root, 'audit/generated/release-gate.json'),
  }
}

export async function clearDefaultReleaseOutputs(root = workspaceRoot): Promise<void> {
  const paths = defaultReleasePaths(root)
  await Promise.all(Object.values(paths).map((path) => rm(path, { force: true })))
}

export async function readGateConfigAfterCleanup(
  configPath: string,
  root = workspaceRoot,
): Promise<GateConfig> {
  await clearDefaultReleaseOutputs(root)
  return GateConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')) as unknown)
}

export function resolveWorkspaceEvidencePath(root: string, path: string): string {
  const absolute = resolve(root, path)
  const workspacePath = relative(root, absolute)
  if (
    absolute === root
    || workspacePath.startsWith('..')
    || isAbsolute(workspacePath)
  ) throw new Error(`Evidence reference escapes the workspace (${path})`)
  return absolute
}

export async function contentAddressEvidenceFile(
  sourcePath: string,
  root = workspaceRoot,
  write = false,
): Promise<z.infer<typeof EvidenceReferenceSchema>> {
  const source = resolveWorkspaceEvidencePath(root, sourcePath)
  if (!(await fileExists(source))) throw new Error(`Evidence reference is missing (${sourcePath})`)
  const sha256 = await sha256File(source)
  const archivedPath = `audit/evidence/receipts/${sha256}/${basename(source)}`
  const archived = resolveWorkspaceEvidencePath(root, archivedPath)
  if (write && archived !== source) {
    await mkdir(dirname(archived), { recursive: true })
    try {
      await copyFile(source, archived, constants.COPYFILE_EXCL)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    if (await sha256File(archived) !== sha256) {
      throw new Error(`Content-addressed evidence archive is corrupt (${archivedPath})`)
    }
  }
  return { path: archivedPath, sha256, sourcePath }
}

export async function readEvidence(
  id: string,
  path: string,
  candidateSha256: string | null,
  root = workspaceRoot,
  sourceSnapshotPath?: string,
  sourceRoots?: readonly string[],
): Promise<GateResult> {
  let absolute: string
  try {
    absolute = resolveWorkspaceEvidencePath(root, path)
  } catch (error) {
    return {
      id,
      status: 'fail',
      summary: error instanceof Error ? error.message : String(error),
      evidencePath: path,
    }
  }
  if (!(await fileExists(absolute))) {
    return { id, status: 'fail', summary: 'Required evidence file is missing', evidencePath: path }
  }
  try {
    const value = EvidenceRecordSchema.parse(JSON.parse(await readFile(absolute, 'utf8')) as unknown)
    const evidenceRecord = { path, sha256: await sha256File(absolute) }
    if (value.id !== id) {
      return { id, status: 'fail', summary: `Evidence ID mismatch (${value.id})`, evidencePath: path, evidenceRecord }
    }
    if (value.status !== 'not_run' && value.artifactSha256 !== candidateSha256) {
      return {
        id,
        status: 'fail',
        summary: `${value.status === 'pass' ? 'Pass' : 'Fail'} evidence was recorded for different candidate bytes`,
        evidencePath: path,
        evidenceRecord,
        evidenceReceipts: value.evidence,
      }
    }
    let sourceBinding: GateResult['sourceSnapshot']
    if (sourceSnapshotPath !== undefined) {
      const sourceSnapshot = resolveWorkspaceEvidencePath(root, sourceSnapshotPath)
      if (!(await fileExists(sourceSnapshot))) {
        return {
          id,
          status: 'fail',
          summary: `Required source snapshot is missing (${sourceSnapshotPath})`,
          evidencePath: path,
          evidenceRecord,
          evidenceReceipts: value.evidence,
        }
      }
      let currentSourceSha256: string
      let sourceSnapshotFileSha256: string
      try {
        const validated = await validateSourceSnapshot(sourceSnapshot, root, sourceRoots)
        currentSourceSha256 = validated.treeSha256
        sourceSnapshotFileSha256 = await sha256File(sourceSnapshot)
      } catch (error) {
        return {
          id,
          status: 'fail',
          summary: `Source snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`,
          evidencePath: path,
          evidenceRecord,
          evidenceReceipts: value.evidence,
        }
      }
      if (value.status !== 'not_run' && value.sourceSnapshotSha256 !== currentSourceSha256) {
        return {
          id,
          status: 'fail',
          summary: `${value.status === 'pass' ? 'Pass' : 'Fail'} evidence was recorded for different connected source bytes`,
          evidencePath: path,
          evidenceRecord,
          evidenceReceipts: value.evidence,
          sourceSnapshot: {
            path: sourceSnapshotPath,
            sha256: sourceSnapshotFileSha256,
            treeSha256: currentSourceSha256,
          },
        }
      }
      sourceBinding = {
        path: sourceSnapshotPath,
        sha256: sourceSnapshotFileSha256,
        treeSha256: currentSourceSha256,
      }
    }
    for (const reference of value.evidence) {
      const evidenceArtifact = resolveWorkspaceEvidencePath(root, reference.path)
      if (!(await fileExists(evidenceArtifact))) {
        return {
          id,
          status: 'fail',
          summary: `Evidence reference is missing (${reference.path})`,
          evidencePath: path,
          evidenceRecord,
          evidenceReceipts: value.evidence,
          ...(sourceBinding === undefined ? {} : { sourceSnapshot: sourceBinding }),
        }
      }
      const actualSha256 = await sha256File(evidenceArtifact)
      if (actualSha256 !== reference.sha256) {
        return {
          id,
          status: 'fail',
          summary: `Evidence reference digest mismatch (${reference.path})`,
          evidencePath: path,
          evidenceRecord,
          evidenceReceipts: value.evidence,
          ...(sourceBinding === undefined ? {} : { sourceSnapshot: sourceBinding }),
        }
      }
    }
    return {
      id,
      status: value.status,
      summary: value.summary,
      evidencePath: path,
      evidenceRecord,
      evidenceReceipts: value.evidence,
      ...(sourceBinding === undefined ? {} : { sourceSnapshot: sourceBinding }),
    }
  } catch (error) {
    return {
      id,
      status: 'fail',
      summary: `Evidence is invalid: ${error instanceof Error ? error.message : String(error)}`,
      evidencePath: path,
    }
  }
}

import { realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parse } from '@babel/parser'
import { readRegularFileBound } from '../security/lib/files.ts'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const MAX_INGESTION_FILE_BYTES = 64 * 1024 * 1024
const MAX_INGESTION_FILES = 4_096
const MAX_INGESTION_TOTAL_BYTES = 128 * 1024 * 1024
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'])
const SnapshotPathSchema = z.string().min(1).refine((value) =>
  !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:/u.test(value) && !/(?:^|\/)(?:\.\.(?:\/|$))/u.test(value),
  'Ingestion snapshot paths must be normalized workspace-relative paths',
)

/** Bump when the reviewed executable closure or its traversal policy changes. */
export const INGESTION_SOURCE_SELECTION_VERSION = 'compact-v31-ingestion-v1' as const

/**
 * Versioned entrypoints for the complete compact-v3.1 ingestion/evidence
 * pipeline. Relative imports are followed transitively, so parser,
 * aggregation, runtime-schema, and safety changes cannot be omitted by
 * editing this list's consumers. Approval/evidence/output files and UI/docs
 * are intentionally not roots; those bytes remain separately receipt-bound.
 */
export const INGESTION_SOURCE_ENTRYPOINTS = [
  'scripts/data/generate-compact-v31-benchmark-plans.ts',
  'scripts/data/run-compact-v31-benchmark.ts',
  'scripts/data/compact-v31-executor.ts',
  'scripts/data/compact-v31-production-executor.ts',
  'scripts/data/compact-v31-production-chain-audit.ts',
  'scripts/data/compact-v31-family-handoff.ts',
  'scripts/data/compact-v31-family-eligibility.ts',
  'scripts/data/compact-v31-production-contracts.ts',
  'scripts/data/compact-v31-contracts.ts',
  'scripts/data/preflight-compact-v31.ts',
  'scripts/data/compact-v3-orchestrator.ts',
  'scripts/data/broadcast-pgn.ts',
  'scripts/data/broadcast-contracts.ts',
  'scripts/data/evidence-contracts.ts',
  'scripts/data/evidence-graph.ts',
  'scripts/data/observe-broadcast-metadata.ts',
  'scripts/data/compact-v3-contracts.ts',
  'scripts/data/compact-v3-foundation.ts',
  'scripts/release/lib/immutable-json-receipt.ts',
  'package.json',
  'package-lock.json',
  '.npmrc',
  'tsconfig.json',
] as const

const SnapshotFileSchema = z.object({ path: SnapshotPathSchema, bytes: z.number().int().nonnegative(), sha256: Sha256Schema }).strict()
export const IngestionSourceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  selectionVersion: z.literal(INGESTION_SOURCE_SELECTION_VERSION),
  algorithm: z.literal('sha256'),
  entrypoints: z.array(SnapshotPathSchema).min(1),
  fileCount: z.number().int().positive(),
  totalBytes: z.number().int().positive(),
  treeSha256: Sha256Schema,
  files: z.array(SnapshotFileSchema).min(1),
}).strict().superRefine((value, context) => {
  if (value.fileCount !== value.files.length) context.addIssue({ code: 'custom', path: ['fileCount'], message: 'fileCount does not match files' })
  if (value.totalBytes !== value.files.reduce((total, file) => total + file.bytes, 0)) context.addIssue({ code: 'custom', path: ['totalBytes'], message: 'totalBytes does not match files' })
  const paths = value.files.map((file) => file.path)
  const sorted = [...paths].sort(compareOrdinal)
  if (paths.some((path, index) => path !== sorted[index])) context.addIssue({ code: 'custom', path: ['files'], message: 'Files are not in ordinal path order' })
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) context.addIssue({ code: 'custom', path: ['files'], message: 'Paths collide under case-insensitive filesystems' })
})

export type IngestionSourceSnapshot = z.infer<typeof IngestionSourceSnapshotSchema>

function compareOrdinal(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }
function normalize(root: string, path: string): string {
  const value = relative(root, path).replaceAll('\\', '/')
  SnapshotPathSchema.parse(value)
  return value
}
function treePayload(entrypoints: readonly string[], files: readonly z.infer<typeof SnapshotFileSchema>[]): string {
  return `${[
    `selection\0${INGESTION_SOURCE_SELECTION_VERSION}`,
    ...entrypoints.map((entrypoint) => `entrypoint\0${Buffer.byteLength(entrypoint, 'utf8')}\0${entrypoint}`),
    ...files.map((file) => `file\0${file.sha256}\0${file.bytes}\0${Buffer.byteLength(file.path, 'utf8')}\0${file.path}`),
  ].join('\n')}\n`
}
type SourceFile = { path: string; bytes: Buffer }
async function readSourceFile(root: string, requested: string): Promise<SourceFile> {
  const realRoot = await realpath(root)
  const candidate = resolve(requested)
  const rel = relative(realRoot, candidate)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Ingestion source path escapes workspace: ${requested}`)
  return { path: candidate, bytes: await readRegularFileBound(candidate, MAX_INGESTION_FILE_BYTES) }
}
async function resolveSourceFile(root: string, importer: string, specifier: string): Promise<SourceFile> {
  const base = resolve(root, importer, '..', specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`]
  for (const candidate of candidates) {
    try {
      return await readSourceFile(root, candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    }
  }
  throw new Error(`Ingestion source import cannot be resolved: ${importer} -> ${specifier}`)
}
function importedRelativeSpecifiers(source: string, importer: string): string[] {
  const specs = new Set<string>()
  const file = parse(source, { sourceType: 'module', plugins: ['typescript', 'importMeta'], sourceFilename: importer })
  type BabelNode = { type?: string; value?: unknown; source?: BabelNode; callee?: BabelNode; arguments?: BabelNode[]; expression?: BabelNode; specifiers?: BabelNode[]; meta?: BabelNode; property?: BabelNode; object?: BabelNode; name?: string; loc?: { start: { line: number } } }
  const addModule = (node: BabelNode, value: BabelNode | null | undefined): void => {
    if (value === undefined || value === null) return
    if (value.type !== 'StringLiteral' && value.type !== 'DirectiveLiteral' && value.type !== 'TemplateLiteral') {
      throw new Error(`Ingestion source has a non-literal module reference at ${importer}:${node.loc?.start.line ?? 1}`)
    }
    const text = value.type === 'TemplateLiteral' ? (value as BabelNode & { quasis?: Array<{ value?: { cooked?: string } }>; expressions?: BabelNode[] }).quasis?.[0]?.value?.cooked : value.value
    if (typeof text !== 'string' || (value.type === 'TemplateLiteral' && ((value as BabelNode & { expressions?: BabelNode[] }).expressions?.length ?? 0) > 0)) {
      throw new Error(`Ingestion source has a non-literal module reference at ${importer}:${node.loc?.start.line ?? 1}`)
    }
    if (text.startsWith('.')) specs.add(text)
    else if (!text.startsWith('node:') && !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._/-]*$/iu.test(text)) {
      throw new Error(`Ingestion source has an unsupported module reference at ${importer}:${node.loc?.start.line ?? 1}`)
    }
  }
  const isImportMetaUrl = (node: BabelNode | undefined): boolean =>
    node?.type === 'MemberExpression' && node.object?.type === 'MetaProperty' && node.object.meta?.name === 'import' && node.object.property?.name === 'meta' && node.property?.name === 'url'
  const visit = (node: BabelNode): void => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') addModule(node, node.source)
    else if (node.type === 'CallExpression' && node.callee?.type === 'Import') addModule(node, node.arguments?.[0])
    else if (node.type === 'ImportExpression') addModule(node, node.source ?? node.expression)
    else if (node.type === 'CallExpression' && (
      (node.callee?.type === 'Identifier' && node.callee.name === 'require')
      || (node.callee?.type === 'MemberExpression' && node.callee.object?.name === 'require' && node.callee.property?.name === 'resolve')
    )) addModule(node, node.arguments?.[0])
    else if (node.type === 'NewExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'URL' && node.arguments?.length === 2 && isImportMetaUrl(node.arguments[1])) {
      const target = node.arguments[0]
      if (target?.type !== 'StringLiteral' && target?.type !== 'TemplateLiteral') throw new Error(`Ingestion source has a non-literal worker/module URL at ${importer}`)
      addModule(node, target)
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'tokens' || key === 'comments' || key === 'start' || key === 'end') continue
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object') visit(child as BabelNode)
        }
      } else if (value && typeof value === 'object') {
        visit(value as BabelNode)
      }
    }
  }
  visit(file as unknown as BabelNode)
  return [...specs]
}

export async function createIngestionSourceSnapshot(root = process.cwd()): Promise<IngestionSourceSnapshot> {
  const workspaceRoot = await realpath(resolve(root))
  const entrypoints = [...INGESTION_SOURCE_ENTRYPOINTS]
  const initialFiles = await Promise.all(entrypoints.map((path) => readSourceFile(workspaceRoot, resolve(workspaceRoot, path))))
  const pending = initialFiles.filter(({ path }) => CODE_EXTENSIONS.has(extname(path)))
  const files = new Map<string, Buffer>(initialFiles.map(({ path, bytes }) => [path, bytes]))
  let totalBytes = initialFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0)
  while (pending.length > 0) {
    const importer = pending.pop()!
    const source = importer.bytes.toString('utf8')
    for (const specifier of importedRelativeSpecifiers(source, normalize(workspaceRoot, importer.path))) {
      const imported = await resolveSourceFile(workspaceRoot, normalize(workspaceRoot, importer.path), specifier)
      const existing = files.get(imported.path)
      if (existing && !existing.equals(imported.bytes)) throw new Error(`Ingestion source changed during traversal: ${imported.path}`)
      if (!existing) {
        totalBytes += imported.bytes.byteLength
        if (files.size >= MAX_INGESTION_FILES || totalBytes > MAX_INGESTION_TOTAL_BYTES) {
          throw new Error('Ingestion source dependency closure exceeds its hard cap')
        }
        files.set(imported.path, imported.bytes)
        if (CODE_EXTENSIONS.has(extname(imported.path))) pending.push(imported)
      }
    }
  }
  const records = [...files].map(([absolutePath, bytes]) => ({ path: normalize(workspaceRoot, absolutePath), bytes: bytes.byteLength, sha256: sha256(bytes) }))
  records.sort((left, right) => compareOrdinal(left.path, right.path))
  const manifest = {
    schemaVersion: 1 as const,
    selectionVersion: INGESTION_SOURCE_SELECTION_VERSION,
    algorithm: 'sha256' as const,
    entrypoints,
    fileCount: records.length,
    totalBytes: records.reduce((total, file) => total + file.bytes, 0),
    treeSha256: sha256(treePayload(entrypoints, records)),
    files: records,
  }
  return IngestionSourceSnapshotSchema.parse(manifest)
}

export async function validateIngestionSourceSnapshot(expectedSha256: string, root = process.cwd()): Promise<IngestionSourceSnapshot> {
  const current = await createIngestionSourceSnapshot(root)
  if (current.treeSha256 !== expectedSha256) throw new Error(`Ingestion source snapshot is stale; current pipeline SHA-256 is ${current.treeSha256}`)
  return current
}

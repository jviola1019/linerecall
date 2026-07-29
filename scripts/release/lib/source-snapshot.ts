import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import {
  collectFiles,
  sha256Bytes,
  sha256File,
  workspaceRoot,
} from '../../security/lib/files.ts'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const SnapshotPathSchema = z.string().min(1).refine(
  (path) => !path.includes('\\')
    && !/^[A-Za-z]:/u.test(path)
    && !path.startsWith('/')
    && !/(?:^|\/)\.\.(?:\/|$)/u.test(path),
  'Snapshot paths must be normalized workspace-relative paths',
)

export const CONNECTED_SOURCE_SELECTION_VERSION = 'connected-source-v3' as const

/**
 * This list is deliberately explicit. Adding a new build/deployment surface is
 * a reviewable change to the selection policy instead of a silently unhashed
 * directory. Generated output and dependency directories are never selected.
 */
export const CONNECTED_SOURCE_ROOTS = [
  '.github/workflows',
  'src',
  'scripts',
  'tests',
  'data/manifests',
  'docs',
  'licenses',
  'server/src',
  'server/migrations',
  'server/tests',
  'server/docs',
  'server/.env.example',
  'server/compose.yaml',
  'server/Dockerfile',
  'server/package.json',
  'server/package-lock.json',
  'server/README.md',
  'server/tsconfig.json',
  'server/tsconfig.build.json',
  'hosted/src',
  'hosted/tests',
  'hosted/index.html',
  'hosted/package.json',
  'hosted/package-lock.json',
  'hosted/tsconfig.json',
  'hosted/vite.config.ts',
  'infra',
  'audit/schemas',
  'audit/templates',
  'config',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  'LICENSE',
  'README.md',
  'linerecall.html',
  'open-linerecall.ps1',
  'package.json',
  'package-lock.json',
  'playwright.config.ts',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'SECURITY.md',
] as const

const SourceSnapshotFileSchema = z.object({
  path: SnapshotPathSchema,
  bytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
}).strict()

export const SourceSnapshotManifestSchema = z.object({
  schemaVersion: z.literal(1),
  selectionVersion: z.literal(CONNECTED_SOURCE_SELECTION_VERSION),
  algorithm: z.literal('sha256'),
  roots: z.array(SnapshotPathSchema).min(1),
  fileCount: z.number().int().positive(),
  totalBytes: z.number().int().positive(),
  treeSha256: Sha256Schema,
  files: z.array(SourceSnapshotFileSchema).min(1),
}).strict().superRefine((value, context) => {
  if (value.fileCount !== value.files.length) {
    context.addIssue({ code: 'custom', path: ['fileCount'], message: 'fileCount does not match files' })
  }
  const totalBytes = value.files.reduce((total, file) => total + file.bytes, 0)
  if (value.totalBytes !== totalBytes) {
    context.addIssue({ code: 'custom', path: ['totalBytes'], message: 'totalBytes does not match files' })
  }
  const paths = value.files.map((file) => file.path)
  const sortedPaths = [...paths].sort(compareOrdinal)
  if (paths.some((path, index) => path !== sortedPaths[index])) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Files are not in ordinal path order' })
  }
  const normalizedPaths = new Set(paths.map((path) => path.toLowerCase()))
  if (normalizedPaths.size !== paths.length) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Paths collide under case-insensitive filesystems' })
  }
})

export type SourceSnapshotManifest = z.infer<typeof SourceSnapshotManifestSchema>

const ignoredDirectories = new Set([
  '.cache',
  '.git',
  '.terraform',
  'coverage',
  'dist',
  'node_modules',
])

const forbiddenEvidencePaths = [
  /(?:^|\/)\.env(?:\.|$)/u,
  /(?:^|\/).*\.(?:key|pem|pfx|tfstate|tfvars)$/iu,
]

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeRelativePath(root: string, absolutePath: string): string {
  const path = relative(root, absolutePath)
  if (path === '' || path.startsWith('..') || isAbsolute(path)) {
    throw new Error(`Source snapshot path escapes its root: ${absolutePath}`)
  }
  return path.replaceAll('\\', '/')
}

function treePayload(
  roots: readonly string[],
  files: readonly z.infer<typeof SourceSnapshotFileSchema>[],
): string {
  const header = [
    `selection\0${CONNECTED_SOURCE_SELECTION_VERSION}`,
    ...roots.map((root) => `root\0${Buffer.byteLength(root, 'utf8')}\0${root}`),
  ]
  const entries = files.map(
    (file) => `file\0${file.sha256}\0${file.bytes}\0${Buffer.byteLength(file.path, 'utf8')}\0${file.path}`,
  )
  return `${[...header, ...entries].join('\n')}\n`
}

async function assertRootsExist(root: string, roots: readonly string[]): Promise<void> {
  for (const selectedRoot of roots) {
    const absolute = resolve(root, selectedRoot)
    const workspacePath = relative(root, absolute)
    if (absolute === root || workspacePath.startsWith('..') || isAbsolute(workspacePath)) {
      throw new Error(`Source snapshot root escapes the workspace: ${selectedRoot}`)
    }
    await stat(absolute).catch(() => {
      throw new Error(`Required source snapshot root is missing: ${selectedRoot}`)
    })
  }
}

export async function createSourceSnapshot(
  root = workspaceRoot,
  roots: readonly string[] = CONNECTED_SOURCE_ROOTS,
): Promise<SourceSnapshotManifest> {
  const normalizedRoots = roots.map((path) => path.replaceAll('\\', '/'))
  if (new Set(normalizedRoots.map((path) => path.toLowerCase())).size !== normalizedRoots.length) {
    throw new Error('Source snapshot roots must be unique under case-insensitive filesystems')
  }
  for (const selectedRoot of normalizedRoots) SnapshotPathSchema.parse(selectedRoot)
  await assertRootsExist(root, normalizedRoots)

  const absoluteFiles = await collectFiles(normalizedRoots.map((path) => resolve(root, path)), {
    ignoredDirectories,
  })
  const files = await Promise.all(absoluteFiles.map(async (absolutePath) => {
    const path = normalizeRelativePath(root, absolutePath)
    if (forbiddenEvidencePaths.some((pattern) => pattern.test(path)) && path !== 'server/.env.example') {
      throw new Error(`Secret-bearing file type is forbidden in source evidence: ${path}`)
    }
    const details = await stat(absolutePath)
    return { path, bytes: details.size, sha256: await sha256File(absolutePath) }
  }))
  files.sort((left, right) => compareOrdinal(left.path, right.path))
  if (files.length === 0) throw new Error('Source snapshot contains no files')

  const manifest = {
    schemaVersion: 1 as const,
    selectionVersion: CONNECTED_SOURCE_SELECTION_VERSION,
    algorithm: 'sha256' as const,
    roots: normalizedRoots,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    treeSha256: sha256Bytes(treePayload(normalizedRoots, files)),
    files,
  }
  return SourceSnapshotManifestSchema.parse(manifest)
}

export async function validateSourceSnapshot(
  manifestPath: string,
  root = workspaceRoot,
  roots: readonly string[] = CONNECTED_SOURCE_ROOTS,
): Promise<SourceSnapshotManifest> {
  const recorded = SourceSnapshotManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
  )
  const expected = await createSourceSnapshot(root, roots)
  if (JSON.stringify(recorded.roots) !== JSON.stringify(expected.roots)) {
    throw new Error('Source snapshot selection roots do not match the enforced policy')
  }
  if (recorded.treeSha256 !== expected.treeSha256) {
    throw new Error(`Source snapshot is stale: expected ${expected.treeSha256}, found ${recorded.treeSha256}`)
  }
  if (JSON.stringify(recorded.files) !== JSON.stringify(expected.files)) {
    throw new Error('Source snapshot file inventory does not match current source bytes')
  }
  return recorded
}

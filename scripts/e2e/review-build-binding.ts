import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { readHandleBoundRegularFile } from '../lib/handle-bound-file.ts'
import { createSourceSnapshot } from '../release/lib/source-snapshot.ts'
import { sha256Bytes, workspaceRoot } from '../security/lib/files.ts'

const Digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const ReviewBuildBindingSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.literal('synthetic-review-harness-v1'),
  dataMode: z.literal('synthetic-review'),
  sourceSha256: Digest,
  candidateSha256: Digest,
  entryPointSha256: Digest,
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: Digest }).strict()).min(1),
}).strict()

export type ReviewBuildBinding = z.infer<typeof ReviewBuildBindingSchema>
export const REVIEW_BUILD_BINDING_PATH = resolve(workspaceRoot, 'audit/generated/review-browser-build.json')

/** Bind every served harness file, including its separate scripts and styles. */
export async function captureReviewBuild(sourceSha256: string, directory = resolve(workspaceRoot, 'build/review-harness')): Promise<ReviewBuildBinding> {
  const files: ReviewBuildBinding['files'] = []
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(resolve(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error('Review build must not contain symbolic links')
      if (entry.isDirectory()) await visit(path)
      else {
        const bytes = await readHandleBoundRegularFile(resolve(directory, path), 'Review build file', 20 * 1024 * 1024)
        files.push({ path, bytes: bytes.byteLength, sha256: sha256Bytes(bytes) })
      }
      if (files.length > 1000) throw new Error('Review build file inventory exceeds its bound')
    }
  }
  await visit('')
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const entry = files.find(({ path }) => path === 'index.html')
  if (!entry) throw new Error('Review build is missing index.html')
  return ReviewBuildBindingSchema.parse({
    schemaVersion: 1,
    releaseId: 'synthetic-review-harness-v1',
    dataMode: 'synthetic-review',
    sourceSha256,
    candidateSha256: sha256Bytes(JSON.stringify(files)),
    entryPointSha256: entry.sha256,
    files,
  })
}

export async function verifyReviewBuild(binding: ReviewBuildBinding): Promise<void> {
  const currentSource = await createSourceSnapshot()
  if (currentSource.treeSha256 !== binding.sourceSha256) throw new Error('Source changed during the browser audit; rebuild and rerun it')
  const current = await captureReviewBuild(currentSource.treeSha256)
  if (current.candidateSha256 !== binding.candidateSha256) throw new Error('Served review files changed during the browser audit')
}

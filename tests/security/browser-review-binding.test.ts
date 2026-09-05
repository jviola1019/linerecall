import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { captureReviewBuild, ReviewBuildBindingSchema } from '../../scripts/e2e/review-build-binding.ts'

test('browser evidence binds every served asset and cannot be relabeled as production', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-browser-binding-'))
  try {
    await writeFile(join(root, 'index.html'), '<script src="app.js"></script>')
    await writeFile(join(root, 'app.js'), 'const version = 1')
    const first = await captureReviewBuild('1'.repeat(64), root)
    await writeFile(join(root, 'app.js'), 'const version = 2')
    const second = await captureReviewBuild('1'.repeat(64), root)
    assert.equal(first.entryPointSha256, second.entryPointSha256)
    assert.notEqual(first.candidateSha256, second.candidateSha256)
    assert.equal(first.files.length, 2)
    assert.equal(ReviewBuildBindingSchema.safeParse({ ...first, dataMode: 'production-data' }).success, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

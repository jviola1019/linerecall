import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readHandleBoundRegularFile } from '../../scripts/lib/handle-bound-file.ts'

test('handle-bound reader returns exact regular-file bytes and rejects directories and oversized input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-handle-bound-'))
  try {
    const file = join(directory, 'artifact.html')
    const nested = join(directory, 'not-a-file')
    const expected = Buffer.from('<!doctype html><title>LineRecall</title>', 'utf8')
    await writeFile(file, expected)
    await mkdir(nested)

    assert.deepEqual(await readHandleBoundRegularFile(file, 'Fixture'), expected)
    await assert.rejects(
      readHandleBoundRegularFile(file, 'Fixture', expected.byteLength - 1),
      /hard cap/iu,
    )
    await assert.rejects(readHandleBoundRegularFile(nested, 'Fixture'), /not a regular file/iu)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

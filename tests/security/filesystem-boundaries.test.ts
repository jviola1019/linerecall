import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectFiles, fileExists, readRegularFileBound, sha256File } from '../../scripts/security/lib/files.ts'
import { createSourceSnapshot } from '../../scripts/release/lib/source-snapshot.ts'

async function makeDirectoryLink(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

test('collectFiles retains nested regular files and omits nested links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-files-'))
  try {
    await mkdir(join(root, 'nested', 'deeper'), { recursive: true })
    const regular = join(root, 'nested', 'deeper', 'regular.txt')
    await writeFile(regular, 'inside\n', 'utf8')
    await makeDirectoryLink(join(root, 'nested'), join(root, 'linked-nested'))

    const files = await collectFiles([root])
    assert.deepEqual(files, [regular])
    assert.ok(files.every((path) => path === root || path.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('source snapshots reject nested links instead of silently omitting source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-files-snapshot-link-'))
  const outside = await mkdtemp(join(tmpdir(), 'linerecall-files-snapshot-outside-'))
  try {
    const source = join(root, 'source')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'regular.ts'), 'export const inside = true\n', 'utf8')
    await writeFile(join(outside, 'linked.ts'), 'export const outside = true\n', 'utf8')
    await symlink(outside, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(() => createSourceSnapshot(root, ['source']), /symbolic|linked|reparse/i)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('collectFiles rejects an explicitly selected directory junction or symlink root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-files-root-link-'))
  const outside = await mkdtemp(join(tmpdir(), 'linerecall-files-outside-'))
  try {
    await writeFile(join(outside, 'outside.txt'), 'must not be read\n', 'utf8')
    const linkedRoot = join(root, 'selected-root')
    await makeDirectoryLink(outside, linkedRoot)
    await assert.rejects(() => collectFiles([linkedRoot]), /symbolic|linked|reparse/i)
    assert.equal(await fileExists(join(linkedRoot, 'outside.txt')), false)
    await assert.rejects(() => createSourceSnapshot(root, ['selected-root']), /symbolic|linked|reparse/i)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('collectFiles rejects a linked ancestor of an explicitly selected root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-files-ancestor-'))
  const outside = await mkdtemp(join(tmpdir(), 'linerecall-files-ancestor-outside-'))
  try {
    await mkdir(join(outside, 'nested'), { recursive: true })
    await writeFile(join(outside, 'nested', 'outside.txt'), 'must not be read\n', 'utf8')
    const linkedAncestor = join(root, 'linked-parent')
    await makeDirectoryLink(outside, linkedAncestor)
    await assert.rejects(() => collectFiles([join(linkedAncestor, 'nested')]), /symbolic|linked|reparse/i)
    assert.equal(await fileExists(join(linkedAncestor, 'nested', 'outside.txt')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('fileExists does not treat a file symlink as a trusted file', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-files-file-link-'))
  try {
    const outside = join(root, 'outside.txt')
    const linked = join(root, 'linked.txt')
    await writeFile(outside, 'outside\n', 'utf8')
    try {
      await symlink(outside, linked, 'file')
    } catch (error) {
      // Some hardened POSIX environments disable symlink creation.  The
      // directory-link tests above still cover the no-outside-bytes boundary.
      if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') return
      throw error
    }
    assert.equal(await fileExists(linked), false)
    await assert.rejects(() => collectFiles([linked]), /symbolic|linked|reparse/i)
    await assert.rejects(() => readRegularFileBound(linked), /symbolic|linked|reparse/i)
    await assert.rejects(() => sha256File(linked), /symbolic|linked|reparse/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

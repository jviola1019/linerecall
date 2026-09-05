import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
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
    await assert.rejects(() => readRegularFileBound(join(linkedAncestor, 'nested', 'outside.txt')), /symbolic|linked|reparse/i)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('bound file reads enforce regular-file and byte limits on the opened handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-bound-read-'))
  try {
    const path = join(root, 'bytes.txt')
    await writeFile(path, 'sample')
    assert.equal((await readRegularFileBound(path, 6)).toString(), 'sample')
    await assert.rejects(() => readRegularFileBound(path, 5), /hard cap/)
    for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(() => readRegularFileBound(path, limit), /Maximum byte length/)
    }
    await assert.rejects(() => readRegularFileBound(root))
    await assert.rejects(() => readRegularFileBound(join(root, 'missing.txt')), { code: 'ENOENT' })
    await writeFile(path, '')
    assert.equal((await readRegularFileBound(path, 0)).byteLength, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Windows prohibits replacing this open file. Linux CI exercises the path race;
// the separate in-place mutation case below also runs on Windows.
test('bound file reads reject a same-size path replacement during a descriptor read', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-bound-replacement-'))
  try {
    const path = join(root, 'bytes.txt')
    const replacement = join(root, 'replacement.txt')
    await writeFile(path, Buffer.alloc(128 * 1024, 'a'))
    await writeFile(replacement, Buffer.alloc(128 * 1024, 'b'))
    const probe = await open(path, 'r')
    const prototype = Object.getPrototypeOf(probe)
    const originalRead = probe.read
    await probe.close()
    let replaced = false
    const hook = t.mock.method(prototype, 'read', async function (this: FileHandle, ...args: Parameters<FileHandle['read']>) {
      const result = await Reflect.apply(originalRead, this, args)
      if (!replaced) {
        replaced = true
        await rename(replacement, path)
      }
      return result
    })
    try {
      await assert.rejects(() => readRegularFileBound(path), /File (path )?changed while read/)
      assert.equal(replaced, true)
    } finally {
      hook.mock.restore()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bound file reads reject in-place mutation during a descriptor read', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-bound-mutation-'))
  try {
    const path = join(root, 'bytes.txt')
    await writeFile(path, Buffer.alloc(128 * 1024, 'a'))
    const probe = await open(path, 'r')
    const prototype = Object.getPrototypeOf(probe)
    const originalRead = probe.read
    await probe.close()
    let mutated = false
    const hook = t.mock.method(prototype, 'read', async function (this: FileHandle, ...args: Parameters<FileHandle['read']>) {
      const result = await Reflect.apply(originalRead, this, args)
      if (!mutated) {
        mutated = true
        await writeFile(path, Buffer.alloc(128 * 1024 + 1, 'b'))
      }
      return result
    })
    try {
      await assert.rejects(() => readRegularFileBound(path), /File changed while read/)
      assert.equal(mutated, true)
    } finally {
      hook.mock.restore()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bound file reads reject a FIFO without waiting for a writer', { skip: process.platform === 'win32', timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-bound-fifo-'))
  try {
    const path = join(root, 'pipe')
    execFileSync('mkfifo', [path])
    await assert.rejects(() => readRegularFileBound(path), /Not a regular file/)
  } finally {
    await rm(root, { recursive: true, force: true })
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

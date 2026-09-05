import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'

export const workspaceRoot = resolve(import.meta.dirname, '../../..')

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readRegularFileBound(path))
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await rm(temporary, { force: true })
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, path)
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    // `stat` follows links.  Presence checks are used to select release/SBOM
    // inputs, so a link must never turn an outside file into an accepted input.
    await rejectLinkedPath(path)
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

async function rejectLinkedPath(path: string): Promise<void> {
  let current = resolve(path)
  while (true) {
    const details = await lstat(current)
    if (details.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link path: ${path}`)
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/** Read a regular file while binding the bytes to its original path identity. */
export async function readRegularFileBound(
  path: string,
  maximumBytes: number = Number.MAX_SAFE_INTEGER,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error('Maximum byte length is invalid')
  }
  await rejectLinkedPath(path)
  const initial = await lstat(path)
  if (!initial.isFile()) throw new Error(`Not a regular file: ${path}`)
  const canonical = await realpath(path)
  const expectedPath = resolve(path)
  const samePath = process.platform === 'win32'
    ? canonical.toLowerCase() === expectedPath.toLowerCase()
    : canonical === expectedPath
  if (!samePath) throw new Error(`Refusing linked file path: ${path}`)
  const flags = process.platform === 'win32'
    ? 'r'
    : constants.O_RDONLY | constants.O_NOFOLLOW
  const handle = await open(path, flags)
  try {
    const before = await handle.stat()
    if (
      !before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino ||
      before.size !== initial.size || before.mtimeMs !== initial.mtimeMs || before.ctimeMs !== initial.ctimeMs
    ) throw new Error(`File identity changed before reading: ${path}`)
    if (before.size > maximumBytes) throw new Error(`File exceeds its ${maximumBytes}-byte hard cap: ${path}`)
    const chunks: Buffer[] = []
    const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, maximumBytes + 1)))
    let totalBytes = 0
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength)
      if (bytesRead === 0) break
      if (totalBytes > maximumBytes - bytesRead) {
        throw new Error(`File exceeds its ${maximumBytes}-byte hard cap: ${path}`)
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
      totalBytes += bytesRead
    }
    const bytes = Buffer.concat(chunks, totalBytes)
    const after = await handle.stat()
    if (
      !after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== after.size
    ) throw new Error(`File changed while read: ${path}`)
    await rejectLinkedPath(path)
    const afterPath = await lstat(path)
    if (
      afterPath.isSymbolicLink() || !afterPath.isFile() || afterPath.dev !== initial.dev ||
      afterPath.ino !== initial.ino || afterPath.size !== initial.size ||
      afterPath.mtimeMs !== initial.mtimeMs || afterPath.ctimeMs !== initial.ctimeMs
    ) throw new Error(`File path changed while read: ${path}`)
    const afterCanonical = await realpath(path)
    const sameAfterPath = process.platform === 'win32'
      ? afterCanonical.toLowerCase() === canonical.toLowerCase()
      : afterCanonical === canonical
    if (!sameAfterPath) throw new Error(`File path changed while read: ${path}`)
    return bytes
  } finally {
    await handle.close()
  }
}

export async function collectFiles(
  roots: readonly string[],
  options: {
    extensions?: ReadonlySet<string>
    ignoredDirectories?: ReadonlySet<string>
    maxBytes?: number
    rejectSymbolicLinks?: boolean
  } = {},
): Promise<string[]> {
  const files: string[] = []
  const ignored = options.ignoredDirectories ?? new Set(['.git', 'node_modules', '.cache', 'coverage'])

  async function visit(path: string): Promise<void> {
    let details
    try {
      details = await lstat(path)
    } catch {
      return
    }
    if (details.isSymbolicLink()) {
      if (options.rejectSymbolicLinks) throw new Error(`Refusing symbolic-link path: ${path}`)
      return
    }
    if (details.isFile()) {
      if (options.maxBytes !== undefined && details.size > options.maxBytes) return
      if (options.extensions !== undefined && !options.extensions.has(extname(path).toLowerCase())) return
      files.push(path)
      return
    }
    if (!details.isDirectory()) return
    const children = await readdir(path, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      if (child.isDirectory() && ignored.has(child.name)) continue
      if (child.isSymbolicLink()) {
        if (options.rejectSymbolicLinks) throw new Error(`Refusing symbolic-link path: ${join(path, child.name)}`)
        continue
      }
      await visit(join(path, child.name))
    }
  }

  for (const root of roots) {
    const absoluteRoot = resolve(workspaceRoot, root)
    let rootDetails
    try {
      rootDetails = await lstat(absoluteRoot)
    } catch {
      // Some scans intentionally include optional output directories.  The
      // source-snapshot caller separately asserts all of its required roots.
      continue
    }
    if (rootDetails.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link root: ${absoluteRoot}`)
    }
    await rejectLinkedPath(absoluteRoot)
    await visit(absoluteRoot)
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right))
}

export function workspaceRelative(path: string): string {
  return relative(workspaceRoot, path).replaceAll('\\', '/')
}

export function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing option ${name}`)
  return resolve(workspaceRoot, value)
}

export function isExecutedDirectly(metaUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return resolve(entry) === resolve(new URL(metaUrl).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1)))
}

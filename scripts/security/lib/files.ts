import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'

export const workspaceRoot = resolve(import.meta.dirname, '../../..')

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path))
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
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function collectFiles(
  roots: readonly string[],
  options: {
    extensions?: ReadonlySet<string>
    ignoredDirectories?: ReadonlySet<string>
    maxBytes?: number
  } = {},
): Promise<string[]> {
  const files: string[] = []
  const ignored = options.ignoredDirectories ?? new Set(['.git', 'node_modules', '.cache', 'coverage'])

  async function visit(path: string): Promise<void> {
    let details
    try {
      details = await stat(path)
    } catch {
      return
    }
    if (details.isSymbolicLink()) return
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
      if (child.isSymbolicLink()) continue
      await visit(join(path, child.name))
    }
  }

  for (const root of roots) await visit(resolve(workspaceRoot, root))
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

#!/usr/bin/env node
import { freemem } from 'node:os'
import { lstat, readdir, realpath, statfs } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CompactV31PlanSchema,
  assessCompactV31Resources,
  type CompactV31PreflightAssessment,
} from './compact-v31-contracts.ts'
import {
  ensureSecureCompactWorkDirectory,
  readBoundedRegularFile,
} from './compact-v3-orchestrator.ts'

const MAXIMUM_PLAN_BYTES = 2 * 1024 * 1024
const MAXIMUM_RETAINED_ENTRIES = 200_000

function argumentsFor(argv: readonly string[]): { planPath: string; workDirectory: string } {
  const options = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid option near ${name ?? '<end>'}`)
    if (options.has(name)) throw new Error(`Duplicate option ${name}`)
    options.set(name, value)
  }
  const planPath = options.get('--plan')
  const workDirectory = options.get('--work-dir')
  if (!planPath || !workDirectory || options.size !== 2) {
    throw new Error('Usage: preflight-compact-v31 --plan <benchmark-plan.json> --work-dir <existing-directory>')
  }
  return { planPath: resolve(planPath), workDirectory: resolve(workDirectory) }
}

async function retainedDeltaBytes(workDirectory: string): Promise<number> {
  const root = join(workDirectory, 'v31', 'deltas')
  let requestedRootEntry
  try {
    requestedRootEntry = await lstat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (!requestedRootEntry.isDirectory() || requestedRootEntry.isSymbolicLink()) {
    throw new Error('Compact-v3.1 delta root must be a non-symbolic-link directory')
  }
  const rootReal = await realpath(root)
  const relativeRoot = relative(workDirectory, rootReal)
  if (relativeRoot === '..' || relativeRoot.startsWith(`..${sep}`) || isAbsolute(relativeRoot)) {
    throw new Error('Compact-v3.1 delta root escapes its approved work directory')
  }
  const rootEntry = await lstat(rootReal)
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error('Compact-v3.1 delta root must be a non-symbolic-link directory')
  const pending = [rootReal]
  let entries = 0
  let bytes = 0
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1
      if (entries > MAXIMUM_RETAINED_ENTRIES) throw new Error('Compact-v3.1 retained delta inventory exceeds its entry cap')
      const path = join(directory, entry.name)
      const details = await lstat(path)
      if (details.isSymbolicLink()) throw new Error('Compact-v3.1 retained deltas may not contain symbolic links')
      if (details.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!details.isFile()) throw new Error('Compact-v3.1 retained delta inventory contains a non-file entry')
      bytes += details.size
      if (!Number.isSafeInteger(bytes)) throw new Error('Compact-v3.1 retained delta bytes exceed the safe integer range')
    }
  }
  return bytes
}

export async function assessCompactV31WorkDirectory(
  planInput: unknown,
  workDirectoryValue: string,
  overrides: Partial<{
    availableStorageBytes: number
    retainedDeltaBytes: number
    availableMemoryBytes: number
    workerResidentBytes: number
  }> = {},
): Promise<CompactV31PreflightAssessment> {
  const plan = CompactV31PlanSchema.parse(planInput)
  const boundary = await ensureSecureCompactWorkDirectory(workDirectoryValue, { createV3: false })
  const filesystem = overrides.availableStorageBytes === undefined
    ? await statfs(boundary.workDirectory, { bigint: true })
    : null
  const availableStorageBigInt = filesystem === null ? null : filesystem.bavail * filesystem.bsize
  if (availableStorageBigInt !== null && availableStorageBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Available storage exceeds the safe integer range')
  }
  return assessCompactV31Resources(plan, {
    availableStorageBytes: overrides.availableStorageBytes ?? Number(availableStorageBigInt),
    retainedDeltaBytes: overrides.retainedDeltaBytes ?? await retainedDeltaBytes(boundary.workDirectory),
    availableMemoryBytes: overrides.availableMemoryBytes ?? freemem(),
    workerResidentBytes: overrides.workerResidentBytes ?? process.memoryUsage().rss,
  })
}

async function main(): Promise<void> {
  const args = argumentsFor(process.argv.slice(2))
  const bytes = await readBoundedRegularFile(args.planPath, MAXIMUM_PLAN_BYTES, 'Compact-v3.1 plan', 1)
  const plan = CompactV31PlanSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
  const assessment = await assessCompactV31WorkDirectory(plan, args.workDirectory)
  process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`)
  process.exitCode = assessment.safeToStart ? 0 : 2
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Compact-v3.1 preflight failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

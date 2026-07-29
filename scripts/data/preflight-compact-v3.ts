#!/usr/bin/env node
import { readFile, statfs } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  CompactPreflightPlanSchema,
  type CompactPreflightPlan,
} from './compact-v3-contracts.ts'
import {
  assessCompactV3Storage,
  compactPreflightExitCode,
  type CompactStorageAssessment,
} from './compact-v3-foundation.ts'
import { compactRetainedStateBytes } from './compact-v3-orchestrator.ts'

function argumentsFor(argv: readonly string[]): { planPath: string; workDirectory: string } {
  const options = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid option near ${name ?? '<end>'}`)
    }
    if (options.has(name.slice(2))) throw new Error(`Duplicate option ${name}`)
    options.set(name.slice(2), value)
  }
  const planPath = options.get('plan')
  const workDirectory = options.get('work-dir')
  if (!planPath || !workDirectory || options.size !== 2) {
    throw new Error('Usage: preflight-compact-v3 --plan <approved-plan.json> --work-dir <existing-directory>')
  }
  return { planPath: resolve(planPath), workDirectory: resolve(workDirectory) }
}

export async function assessCompactV3WorkDirectory(
  planValue: CompactPreflightPlan,
  workDirectoryValue: string,
  availableBytesOverride?: number,
): Promise<CompactStorageAssessment> {
  const plan = CompactPreflightPlanSchema.parse(planValue)
  const workDirectory = resolve(workDirectoryValue)
  let availableBytes = availableBytesOverride
  if (availableBytes === undefined) {
    const filesystem = await statfs(workDirectory, { bigint: true })
    const available = filesystem.bavail * filesystem.bsize
    if (available > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Available storage exceeds the safe integer range')
    }
    availableBytes = Number(available)
  }
  const retainedBytesAlreadyPresent = await compactRetainedStateBytes(workDirectory)
  return assessCompactV3Storage(plan, availableBytes, { retainedBytesAlreadyPresent })
}

async function main(): Promise<void> {
  const args = argumentsFor(process.argv.slice(2))
  const plan = CompactPreflightPlanSchema.parse(JSON.parse(await readFile(args.planPath, 'utf8')) as unknown)
  const assessment = await assessCompactV3WorkDirectory(plan, args.workDirectory)
  process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`)
  process.exitCode = compactPreflightExitCode(assessment)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Compact v3 preflight failed: ${(error as Error).message}\n`)
    process.exitCode = 1
  })
}

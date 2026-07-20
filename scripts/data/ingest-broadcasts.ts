#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  BROADCAST_CUTOFF_MONTH,
  BROADCAST_START_MONTH,
  assertBroadcastManifest,
  assertBroadcastManifestApproved,
  assertBroadcastTargetIndex,
  type BroadcastArchive,
  type BroadcastManifestV1,
  type BroadcastTargetIndexV1,
} from './broadcast-contracts.ts'
import { aggregateBroadcastArchivesParallel } from './broadcast-parallel.ts'
import {
  buildBroadcastManifest,
  downloadManifestArchives,
} from './broadcast-manifest.ts'

const DEFAULT_MANIFEST = 'data/manifests/broadcasts.source.json'
const DEFAULT_ARCHIVE_DIRECTORY = '.cache/linerecall/broadcasts'
const DEFAULT_OUTPUT = 'data/generated/broadcast-backtest.json'

interface CliArguments {
  command: string | undefined
  options: Map<string, string>
}

function parseArguments(argv: string[]): CliArguments {
  const [command, ...rest] = argv
  const options = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token?.startsWith('--')) throw new Error(`Unexpected argument: ${token ?? ''}`)
    const name = token.slice(2)
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Option --${name} requires a value`)
    if (options.has(name)) throw new Error(`Option --${name} was provided more than once`)
    options.set(name, value)
    index += 1
  }
  return { command, options }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`Could not read JSON from ${path}: ${(error as Error).message}`)
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8' })
}

function selectMonths(
  manifest: BroadcastManifestV1,
  commaSeparatedMonths: string | undefined,
): BroadcastArchive[] | undefined {
  if (!commaSeparatedMonths) return undefined
  const requested = commaSeparatedMonths.split(',').map((month) => month.trim())
  if (requested.some((month) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) {
    throw new Error('--months must be a comma-separated list of YYYY-MM values')
  }
  const byMonth = new Map(manifest.archives.map((archive) => [archive.month, archive]))
  return [...new Set(requested)].sort().map((month) => {
    const archive = byMonth.get(month)
    if (!archive) throw new Error(`Month ${month} is not in the approved manifest`)
    return archive
  })
}

function help(): void {
  process.stdout.write(`LineRecall broadcast backtest pipeline

Commands (all paths are relative to the current working directory):
  manifest  Fetch the official list and SHA-256 file, then write a pinned manifest.
    --output <path>        Default: ${DEFAULT_MANIFEST}
    --start <YYYY-MM>      Default: ${BROADCAST_START_MONTH}
    --cutoff <YYYY-MM>     Default: ${BROADCAST_CUTOFF_MONTH}

  download  Download and SHA-256 verify every archive in an approved manifest.
    --manifest <path>      Default: ${DEFAULT_MANIFEST}
    --archive-dir <path>   Default: ${DEFAULT_ARCHIVE_DIRECTORY}

  aggregate Verify all files again, stream native Node Zstandard, and backtest targets.
    --manifest <path>      Default: ${DEFAULT_MANIFEST}
    --targets <path>       Required BroadcastTargetIndexV1 JSON
    --archive-dir <path>   Default: ${DEFAULT_ARCHIVE_DIRECTORY}
    --output <path>        Default: ${DEFAULT_OUTPUT}
    --months <YYYY-MM,...> Optional partial/dev run; output is marked incomplete.
    --workers <1-32>       Default: up to 12, leaving one logical CPU free.

No command downloads data implicitly. A full corpus run is intentionally explicit.
`)
}

async function main(): Promise<void> {
  const { command, options } = parseArguments(process.argv.slice(2))
  if (!command || command === 'help' || command === '--help') {
    help()
    return
  }
  if (command === 'manifest') {
    const output = resolve(options.get('output') ?? DEFAULT_MANIFEST)
    const manifest = await buildBroadcastManifest({
      startMonth: options.get('start') ?? BROADCAST_START_MONTH,
      cutoffMonth: options.get('cutoff') ?? BROADCAST_CUTOFF_MONTH,
    })
    await writeJson(output, manifest)
    process.stdout.write(`Wrote ${manifest.archives.length} checksummed archives to ${output}\n`)
    return
  }

  const manifestPath = resolve(options.get('manifest') ?? DEFAULT_MANIFEST)
  const manifestValue = await readJson(manifestPath)
  assertBroadcastManifestApproved(manifestValue)
  const manifest = manifestValue
  const archiveDirectory = resolve(options.get('archive-dir') ?? DEFAULT_ARCHIVE_DIRECTORY)

  if (command === 'download') {
    await downloadManifestArchives(manifest, archiveDirectory, {
      onArchive: (archive, downloaded) => {
        process.stdout.write(`${downloaded ? 'downloaded' : 'verified'} ${archive.filename}\n`)
      },
    })
    return
  }
  if (command === 'aggregate') {
    const targetsPathValue = options.get('targets')
    if (!targetsPathValue) throw new Error('aggregate requires --targets <path>')
    const targetsValue = await readJson(resolve(targetsPathValue))
    assertBroadcastTargetIndex(targetsValue)
    const targetIndex: BroadcastTargetIndexV1 = targetsValue
    const selectedArchives = selectMonths(manifest, options.get('months'))
    const output = resolve(options.get('output') ?? DEFAULT_OUTPUT)
    const workersText = options.get('workers')
    const workers = workersText === undefined ? undefined : Number(workersText)
    const backtest = await aggregateBroadcastArchivesParallel({
      manifest,
      targetIndex,
      archiveDirectory,
      ...(selectedArchives ? { selectedArchives } : {}),
      ...(workers === undefined ? {} : { concurrency: workers }),
      onArchive: (archive) => process.stdout.write(`processing ${archive.filename}\n`),
    })
    await writeJson(output, backtest)
    process.stdout.write(
      `Wrote ${backtest.totals.accepted} accepted, ${backtest.totals.deduplicated} deduplicated, ` +
        `${Object.values(backtest.totals.rejected).reduce((sum, count) => sum + count, 0)} rejected games to ${output}\n`,
    )
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

main().catch((error: unknown) => {
  process.stderr.write(`Broadcast pipeline failed: ${(error as Error).message}\n`)
  process.exitCode = 1
})

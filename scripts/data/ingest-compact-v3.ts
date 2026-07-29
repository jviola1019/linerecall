#!/usr/bin/env node
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { CompactPreflightPlanSchema } from './compact-v3-contracts.ts'
import {
  runCompactV3ArchiveAdapter,
  runCompactV3RemoteArchiveAdapter,
} from './compact-v3-adapter.ts'
import { approvedCompactCorpusFromBytes } from './compact-v3-manifest.ts'
import {
  ensureSecureCompactWorkDirectory,
  readBoundedRegularFile,
} from './compact-v3-orchestrator.ts'
import { createSourceSnapshot } from '../release/lib/source-snapshot.ts'

interface Arguments {
  pass: 'candidate' | 'exact'
  planPath: string
  manifestPath: string
  input: 'local-file' | 'approved-https'
  archivePath?: string
  workDirectory: string
  sourceSnapshotSha256: string
}

function argumentsFor(argv: readonly string[]): Arguments {
  const pass = argv[0]
  if (pass !== 'candidate' && pass !== 'exact') {
    throw new Error('First argument must be candidate or exact')
  }
  const options = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid option near ${name ?? '<end>'}`)
    }
    const key = name.slice(2)
    if (options.has(key)) throw new Error(`Duplicate option ${name}`)
    options.set(key, value)
  }
  const required = ['plan', 'manifest', 'work-dir', 'source-snapshot-sha256'] as const
  for (const name of required) if (!options.get(name)) throw new Error(`Missing --${name}`)
  const archive = options.get('archive')
  const requestedInput = options.get('input')
  if ((archive ? 1 : 0) + (requestedInput ? 1 : 0) !== 1) {
    throw new Error('Choose exactly one input: --archive <local-file> or --input approved-https')
  }
  if (requestedInput !== undefined && requestedInput !== 'approved-https') {
    throw new Error('--input supports only approved-https')
  }
  const allowed = new Set([...required, archive ? 'archive' : 'input'])
  if ([...options.keys()].some((name) => !allowed.has(name))) throw new Error('Unknown compact-v3 option')
  const sourceSnapshotSha256 = options.get('source-snapshot-sha256')!
  if (!/^[a-f0-9]{64}$/u.test(sourceSnapshotSha256)) {
    throw new Error('--source-snapshot-sha256 must be a lowercase SHA-256 digest')
  }
  return {
    pass,
    planPath: resolve(options.get('plan')!),
    manifestPath: resolve(options.get('manifest')!),
    input: archive ? 'local-file' : 'approved-https',
    ...(archive ? { archivePath: resolve(archive) } : {}),
    workDirectory: resolve(options.get('work-dir')!),
    sourceSnapshotSha256,
  }
}

function isInside(path: string, parent: string): boolean {
  const child = relative(parent, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

async function main(): Promise<void> {
  const argsValue = argumentsFor(process.argv.slice(2))
  const boundary = await ensureSecureCompactWorkDirectory(argsValue.workDirectory, { createV3: false })
  const args: Arguments = { ...argsValue, workDirectory: boundary.workDirectory }
  const historicalV2 = resolve('data/generated/v2')
  if (isInside(args.workDirectory, historicalV2)) {
    throw new Error('Schema-v3 work directory must not be the historical data/generated/v2 tree')
  }
  const planBytes = await readBoundedRegularFile(args.planPath, 1024 * 1024, '--plan', 1)
  const plan = CompactPreflightPlanSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(planBytes)) as unknown,
  )
  if (args.input === 'local-file' && basename(args.archivePath!) !== plan.archive.filename) {
    throw new Error(`--archive must name the approved local file ${plan.archive.filename}`)
  }
  const manifestBytes = await readBoundedRegularFile(args.manifestPath, 4 * 1024 * 1024, '--manifest', 1)
  const corpus = approvedCompactCorpusFromBytes(manifestBytes, plan.archive.sourceId)
  const sourceSnapshot = await createSourceSnapshot()
  if (sourceSnapshot.treeSha256 !== args.sourceSnapshotSha256) {
    throw new Error(
      `--source-snapshot-sha256 is stale or incorrect: current source is ${sourceSnapshot.treeSha256}`,
    )
  }
  const common = {
    pass: args.pass,
    plan,
    corpus,
    workDirectory: args.workDirectory,
    toolchain: {
      node: process.version,
      chessJs: '1.4.0',
      zstd: 'node:zlib:createZstdDecompress',
      sourceSnapshotSha256: args.sourceSnapshotSha256,
    },
    executionPurpose: 'evidence-candidate' as const,
  }
  const result = args.input === 'local-file'
    ? await runCompactV3ArchiveAdapter({ ...common, archivePath: args.archivePath! })
    : await runCompactV3RemoteArchiveAdapter(common)
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    pass: result.receipt.pass,
    archiveId: result.receipt.archive.archiveId,
    archiveIndex: result.archiveIndex,
    corpusArchiveCount: result.corpusArchiveCount,
    receiptSha256: result.receiptSha256,
    output: result.receipt.output,
    accounting: {
      recordsSeen: result.receipt.recordsSeen,
      accepted: result.receipt.accepted,
      deduplicated: result.receipt.deduplicated,
      rejected: result.receipt.rejected,
    },
    releaseEligible: false,
    executionPurpose: result.receipt.executionPurpose,
    input: args.input,
    acquisition: result.receipt.compressedInput.acquisition ?? null,
  }, null, 2)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`Compact v3 archive pass failed: ${(error as Error).message}\n`)
  process.exitCode = 1
})

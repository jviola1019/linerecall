#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CompactArchiveCheckpointSchema,
  CompactPreflightPlanSchema,
  type CompactArchiveCheckpoint,
  type CompactPreflightPlan,
} from './compact-v3-contracts.ts'
import {
  approvedCompactCorpusFromBytes,
  type ApprovedCompactCorpus,
} from './compact-v3-manifest.ts'
import { auditCompactV3Foundation } from './audit-data-foundation.ts'
import {
  compactAdapterConfigurationSha256,
} from './compact-v3-adapter.ts'
import { readVerifiedCompactCheckpoint } from './compact-v3-orchestrator.ts'
import {
  CompactExactFamilyGraphHandoffV1Schema,
  type CompactExactFamilyGraphHandoffV1,
} from './family-graph-v3-contracts.ts'
import {
  ImmutableJsonReceiptV1Schema,
  safeOutputPath,
  writeImmutableJsonCandidate,
  type ImmutableJsonReceiptV1,
} from '../release/lib/immutable-json-receipt.ts'
import { openVerifiedCompactExactFamilyGraphHandoff } from './family-graph-v3-builder.ts'

const MAX_CONTROL_FILE_BYTES = 4 * 1024 * 1024

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function relativeReceiptPath(root: string, path: string): string {
  const rel = relative(root, path)
  if (!isWithin(root, path)) throw new Error('Handoff evidence file escapes the approved receipt root')
  return ImmutableJsonReceiptV1Schema.shape.path.parse(rel.replaceAll('\\', '/'))
}

async function digestExactFile(path: string, maximumBytes: number): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(path, 'r')
  try {
    const details = await handle.stat()
    if (!details.isFile() || details.size <= 0 || details.size > maximumBytes) {
      throw new Error(`Handoff control file must be 1-${maximumBytes} bytes`)
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, details.size))
    let offset = 0
    while (offset < details.size) {
      const length = Math.min(buffer.byteLength, details.size - offset)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead === 0) throw new Error('Handoff control file changed while it was hashed')
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    if ((await handle.stat()).size !== details.size) throw new Error('Handoff control file size changed while it was hashed')
    return { bytes: details.size, sha256: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}

async function identityReceipt(root: string, path: string): Promise<ImmutableJsonReceiptV1> {
  const real = await realpath(path)
  const { bytes, sha256 } = await digestExactFile(real, MAX_CONTROL_FILE_BYTES)
  return ImmutableJsonReceiptV1Schema.parse({
    path: relativeReceiptPath(root, real),
    sha256,
    bytes,
    uncompressedBytes: bytes,
    encoding: 'identity',
  })
}

async function readPlan(path: string): Promise<CompactPreflightPlan> {
  const details = await stat(path)
  if (!details.isFile() || details.size <= 0 || details.size > MAX_CONTROL_FILE_BYTES) {
    throw new Error('Compact plan is missing or exceeds the control-file bound')
  }
  return CompactPreflightPlanSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
}

async function corpusHandoff(options: {
  root: string
  workDirectory: string
  plansDirectory: string
  sourceManifestPath: string
  corpus: ApprovedCompactCorpus
}): Promise<CompactExactFamilyGraphHandoffV1['corpora'][number]> {
  const checkpoints: CompactArchiveCheckpoint[] = []
  const checkpointReceipts: ImmutableJsonReceiptV1[] = []
  const plans: CompactPreflightPlan[] = []
  for (const archive of options.corpus.archives) {
    const archiveId = options.corpus.sourceId === 'lichess-broadcasts'
      ? `broadcast-${archive.month}`
      : `standard-${archive.month}`
    const plan = await readPlan(join(options.plansDirectory, `${archiveId}.json`))
    const checkpoint = await readVerifiedCompactCheckpoint(options.workDirectory, plan)
    if (!checkpoint?.exactReceipt || checkpoint.exactReceipt.pass !== 'exact') {
      throw new Error(`Exact compact checkpoint is incomplete: ${archiveId}`)
    }
    plans.push(plan)
    checkpoints.push(CompactArchiveCheckpointSchema.parse(checkpoint))
    checkpointReceipts.push(await identityReceipt(
      options.root,
      join(options.workDirectory, 'v3', archiveId, 'checkpoint.json'),
    ))
  }
  const finalCheckpoint = checkpoints.at(-1)
  const finalPlan = plans.at(-1)
  const exact = finalCheckpoint?.exactReceipt
  if (!finalCheckpoint || !finalPlan || !exact || exact.pass !== 'exact') {
    throw new Error(`Exact ${options.corpus.sourceId} handoff has no terminal state`)
  }
  return {
    sourceId: options.corpus.sourceId,
    sourceManifest: await identityReceipt(options.root, options.sourceManifestPath),
    configurationSha256: compactAdapterConfigurationSha256(
      finalPlan,
      exact.toolchain.sourceSnapshotSha256,
      'evidence-candidate',
    ),
    checkpoints: checkpointReceipts,
    finalExactState: exact.output,
  }
}

export async function buildCompactV3FamilyHandoff(options: {
  root: string
  workDirectory: string
  plansDirectory: string
  broadcastManifestPath: string
  q2ManifestPath: string
  outputPath: string
  releaseId: string
}): Promise<{ handoff: CompactExactFamilyGraphHandoffV1; receipt: ImmutableJsonReceiptV1 }> {
  const root = await realpath(options.root)
  const workDirectory = await realpath(options.workDirectory)
  const plansDirectory = await realpath(options.plansDirectory)
  const broadcastManifestPath = await realpath(options.broadcastManifestPath)
  const q2ManifestPath = await realpath(options.q2ManifestPath)
  for (const path of [workDirectory, plansDirectory, broadcastManifestPath, q2ManifestPath]) {
    if (!isWithin(root, path)) throw new Error('Compact handoff inputs must remain inside the approved project root')
  }
  const output = safeOutputPath(root, options.outputPath)
  if (!isWithin(root, dirname(output))) throw new Error('Compact handoff output escapes the approved project root')

  const [broadcastBytes, q2Bytes] = await Promise.all([
    readFile(broadcastManifestPath),
    readFile(q2ManifestPath),
  ])
  if (broadcastBytes.byteLength > MAX_CONTROL_FILE_BYTES || q2Bytes.byteLength > MAX_CONTROL_FILE_BYTES) {
    throw new Error('Approved source manifest exceeds the control-file bound')
  }
  const corpora = [
    approvedCompactCorpusFromBytes(broadcastBytes, 'lichess-broadcasts'),
    approvedCompactCorpusFromBytes(q2Bytes, 'lichess-standard-rated-q2-2026'),
  ]
  const foundation = await auditCompactV3Foundation({ workDirectory, plansDirectory, corpora })
  if (!foundation.complete) {
    throw new Error(`Compact-v3 foundation is incomplete: ${foundation.missing.slice(0, 8).join(', ')}`)
  }
  const handoff = CompactExactFamilyGraphHandoffV1Schema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-exact-family-graph-handoff',
    releaseId: options.releaseId,
    storageModel: 'bounded-two-pass-content-addressed-v3',
    corpora: await Promise.all([
      corpusHandoff({ root, workDirectory, plansDirectory, sourceManifestPath: broadcastManifestPath, corpus: corpora[0]! }),
      corpusHandoff({ root, workDirectory, plansDirectory, sourceManifestPath: q2ManifestPath, corpus: corpora[1]! }),
    ]),
  })

  const candidate = await writeImmutableJsonCandidate({ root, outputPath: options.outputPath, value: handoff })
  try {
    const candidateReceipt = ImmutableJsonReceiptV1Schema.parse({
      path: candidate.candidateRelativePath,
      sha256: candidate.sha256,
      bytes: candidate.bytes,
      uncompressedBytes: candidate.bytes,
      encoding: 'identity',
    })
    const verified = await openVerifiedCompactExactFamilyGraphHandoff({
      receiptRoot: root,
      artifactRoot: workDirectory,
      handoffReceipt: candidateReceipt,
    })
    await verified.closeAndVerify()
    await candidate.promote()
    return {
      handoff,
      receipt: ImmutableJsonReceiptV1Schema.parse({
        ...candidateReceipt,
        path: relativeReceiptPath(root, output),
      }),
    }
  } catch (error) {
    await candidate.discard()
    throw error
  }
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}

async function main(): Promise<void> {
  const root = resolve(option('--root', '.'))
  const result = await buildCompactV3FamilyHandoff({
    root,
    workDirectory: resolve(root, option('--work-dir', 'data/generated/v3/corpus')),
    plansDirectory: resolve(root, option('--plans-dir', 'data/generated/v3/plans')),
    broadcastManifestPath: resolve(root, option('--broadcast-manifest', 'data/manifests/broadcasts.source.json')),
    q2ManifestPath: resolve(root, option('--q2-manifest', 'data/manifests/lichess-standard-q2-2026.source.json')),
    outputPath: option('--output', 'data/generated/v3/handoff/compact-exact-family-graph-handoff.json'),
    releaseId: option('--release-id', 'release-id-required'),
  })
  process.stdout.write(`${JSON.stringify({ result: 'compact-family-handoff-created', receipt: result.receipt }, null, 2)}\n`)
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invoked === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`Compact family handoff failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

#!/usr/bin/env node
import { createWriteStream } from 'node:fs'
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { createZstdPgnStream } from './broadcast-pgn.ts'
import { sha256File } from './broadcast-manifest.ts'
import {
  LichessPuzzleManifestSchema,
  PuzzleIntegrityReceiptSchema,
  type LichessPuzzleManifest,
  type PuzzleIntegrityReceipt,
} from './evidence-contracts.ts'
import {
  isPuzzleHeader,
  createPuzzleSourceBinding,
  parsePuzzleSourceFields,
  puzzleCandidateFromRow,
  type PuzzleFilterReason,
} from './puzzle-contracts.ts'
import { streamPuzzleCsvRecords } from './puzzle-csv-stream.ts'
import {
  PuzzleV3CandidateEnvelopeV1Schema,
  PuzzleV3CandidateManifestV1Schema,
} from './puzzle-v3-contracts.ts'
import { loadPuzzleV3Prerequisites } from './puzzle-v3-prerequisites.ts'

const DEFAULT_MANIFEST = 'data/manifests/lichess-puzzles.source.json'
const DEFAULT_SOURCE = '.cache/puzzles/lichess_db_puzzle.csv.zst'
const DEFAULT_RECEIPT = 'data/manifests/lichess-puzzles.integrity.json'
const DEFAULT_BROADCAST_MANIFEST = 'data/manifests/broadcasts.source.json'
const DEFAULT_STANDARD_MANIFEST = 'data/manifests/lichess-standard-q2-2026.source.json'
const DEFAULT_STOCKFISH_MANIFEST = 'data/manifests/stockfish-18.source.json'
const DEFAULT_V3_WORK = 'data/generated/v3/corpus'
const DEFAULT_V3_PLANS = 'data/generated/v3/plans'
const DEFAULT_ASSOCIATION_MANIFEST = 'data/generated/v3/puzzle-family-association.json'
const DEFAULT_ENGINE_CAMPAIGN = 'data/generated/v3/puzzle-engine-campaign.json'
const DEFAULT_OUTPUT = 'data/generated/v3/puzzles'

interface Arguments {
  command: string | undefined
  options: Map<string, string>
}

function parseArguments(argv: string[]): Arguments {
  const [command, ...tokens] = argv
  const options = new Map<string, string>()
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index]
    const value = tokens[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid option near ${name ?? '<end>'}`)
    }
    if (options.has(name.slice(2))) throw new Error(`Duplicate option ${name}`)
    options.set(name.slice(2), value)
  }
  return { command, options }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function loadManifest(path: string): Promise<LichessPuzzleManifest> {
  return LichessPuzzleManifestSchema.parse(await readJson(path))
}

async function inspectIntegrity(args: Arguments): Promise<void> {
  const manifest = await loadManifest(resolve(args.options.get('manifest') ?? DEFAULT_MANIFEST))
  const sourcePath = resolve(args.options.get('source') ?? DEFAULT_SOURCE)
  const outputPath = resolve(args.options.get('output') ?? DEFAULT_RECEIPT)
  const details = await stat(sourcePath)
  if (!details.isFile() || details.size !== manifest.artifact.bytes) {
    throw new Error(`Puzzle source must contain exactly ${manifest.artifact.bytes} bytes`)
  }
  const receipt = PuzzleIntegrityReceiptSchema.parse({
    schemaVersion: 1,
    sourceId: manifest.source.id,
    sourceUrl: manifest.source.artifactUrl,
    bytes: details.size,
    sha256: await sha256File(sourcePath),
    computedAt: new Date().toISOString(),
    observedEtag: manifest.artifact.etagObserved,
    observedLastModified: manifest.artifact.lastModifiedObserved,
    approval: { status: 'pending', approvedOn: null, approvedBy: null },
  })
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(
    `Wrote pending puzzle integrity receipt ${outputPath}. Review and approve it explicitly before ingestion.\n`,
  )
}

async function verifyApprovedReceipt(
  manifest: LichessPuzzleManifest,
  sourcePath: string,
  receiptPath: string,
): Promise<PuzzleIntegrityReceipt> {
  const receipt = PuzzleIntegrityReceiptSchema.parse(await readJson(receiptPath))
  createPuzzleSourceBinding(manifest, receipt)
  const details = await stat(sourcePath)
  if (!details.isFile() || details.size !== receipt.bytes) throw new Error('Puzzle archive byte length changed')
  const digest = await sha256File(sourcePath)
  if (digest !== receipt.sha256) throw new Error(`Puzzle SHA-256 changed: ${digest}`)
  return receipt
}

interface PuzzleTotals {
  rowsSeen: number
  candidates: number
  duplicates: number
  rejected: Partial<Record<
    PuzzleFilterReason | 'record_too_long' | 'field_too_long' | 'too_many_fields' | 'unlinked_association',
    number
  >>
  association: Record<'exact-position' | 'opening-family' | 'unlinked', number>
}

function increment(
  values: PuzzleTotals['rejected'],
  reason: keyof PuzzleTotals['rejected'],
): void {
  values[reason] = (values[reason] ?? 0) + 1
}

async function ingest(args: Arguments): Promise<void> {
  const releaseId = args.options.get('release-id')
  if (!releaseId) throw new Error('Production puzzle ingestion requires --release-id')
  const manifest = await loadManifest(resolve(args.options.get('manifest') ?? DEFAULT_MANIFEST))
  const sourcePath = resolve(args.options.get('source') ?? DEFAULT_SOURCE)
  const receiptPath = resolve(args.options.get('receipt') ?? DEFAULT_RECEIPT)
  const receipt = PuzzleIntegrityReceiptSchema.parse(await readJson(receiptPath))
  const sourceBinding = createPuzzleSourceBinding(manifest, receipt)
  // Validate all compact-v3, family, and engine inputs before hashing or
  // streaming the 302 MB puzzle export. Missing current evidence therefore
  // blocks quickly and cannot fall back to the historical schema-v2 graph.
  const prerequisites = await loadPuzzleV3Prerequisites({
    root: resolve('.'),
    releaseId,
    workDirectory: resolve(args.options.get('v3-work-dir') ?? DEFAULT_V3_WORK),
    plansDirectory: resolve(args.options.get('v3-plans-dir') ?? DEFAULT_V3_PLANS),
    broadcastManifestPath: resolve(args.options.get('broadcast-manifest') ?? DEFAULT_BROADCAST_MANIFEST),
    standardManifestPath: resolve(args.options.get('standard-manifest') ?? DEFAULT_STANDARD_MANIFEST),
    stockfishManifestPath: resolve(args.options.get('stockfish-manifest') ?? DEFAULT_STOCKFISH_MANIFEST),
    associationManifestPath: resolve(args.options.get('family-association') ?? DEFAULT_ASSOCIATION_MANIFEST),
    engineCampaignPath: resolve(args.options.get('engine-campaign') ?? DEFAULT_ENGINE_CAMPAIGN),
    puzzleSource: sourceBinding,
  })
  const outputDirectory = resolve(args.options.get('output') ?? DEFAULT_OUTPUT)
  const outputPath = join(outputDirectory, 'candidates.ndjson.gz')
  const temporaryOutputPath = join(outputDirectory, '.candidates.ndjson.gz.partial')
  const temporaryDedupePath = join(outputDirectory, '.puzzle-dedupe.sqlite')
  let dedupe: DatabaseSync | null = null
  let gzip: ReturnType<typeof createGzip> | null = null
  let output: ReturnType<typeof createWriteStream> | null = null
  let promotedOutput = false
  let manifestWritten = false
  try {
    await verifyApprovedReceipt(manifest, sourcePath, receiptPath)
    await mkdir(outputDirectory, { recursive: true })
    dedupe = new DatabaseSync(temporaryDedupePath)
    dedupe.exec('CREATE TABLE puzzle_ids(id TEXT PRIMARY KEY) STRICT; PRAGMA synchronous = OFF;')
    const insertPuzzleId = dedupe.prepare('INSERT OR IGNORE INTO puzzle_ids(id) VALUES (?)')
    const totals: PuzzleTotals = {
      rowsSeen: 0,
      candidates: 0,
      duplicates: 0,
      rejected: {},
      association: { 'exact-position': 0, 'opening-family': 0, unlinked: 0 },
    }
    gzip = createGzip({ level: 9 })
    output = createWriteStream(temporaryOutputPath, { flags: 'wx' })
    gzip.pipe(output)
    let firstRecord = true
    for await (const record of streamPuzzleCsvRecords(createZstdPgnStream(sourcePath))) {
      if (firstRecord) {
        firstRecord = false
        if (!record.accepted || !isPuzzleHeader(record.fields.join(','))) {
          throw new Error('Puzzle CSV header does not match the approved schema')
        }
        continue
      }
      totals.rowsSeen += 1
      if (!record.accepted) {
        increment(totals.rejected, record.reason)
        continue
      }
      const parsed = parsePuzzleSourceFields(record.fields)
      if (!parsed.accepted) {
        increment(totals.rejected, parsed.reason)
        continue
      }
      if (insertPuzzleId.run(parsed.row.puzzleId).changes === 0) {
        totals.duplicates += 1
        continue
      }
      const candidate = puzzleCandidateFromRow(parsed.row, prerequisites.association)
      totals.association[candidate.association.confidence] += 1
      const familyIds = [...prerequisites.association.familyIdsForAssociation(candidate.association)]
      if (candidate.association.confidence === 'unlinked') {
        increment(totals.rejected, 'unlinked_association')
        continue
      }
      if (familyIds.length === 0) {
        throw new Error(`Linked puzzle ${candidate.puzzleId} has no canonical family ownership`)
      }
      const envelope = PuzzleV3CandidateEnvelopeV1Schema.parse({
        schemaVersion: 1,
        releaseId,
        evidenceBindingSha256: prerequisites.evidenceBindingSha256,
        familyIds,
        candidate,
      })
      totals.candidates += 1
      if (!gzip.write(`${JSON.stringify(envelope)}\n`)) await once(gzip, 'drain')
    }
    if (totals.rowsSeen !== manifest.source.publishedPuzzleTotal) {
      throw new Error(
        `Puzzle row total ${totals.rowsSeen} does not match published total ${manifest.source.publishedPuzzleTotal}`,
      )
    }
    gzip.end()
    await finished(output)
    const outputDetails = await stat(temporaryOutputPath)
    const outputSha256 = await sha256File(temporaryOutputPath)
    const result = PuzzleV3CandidateManifestV1Schema.parse({
      schemaVersion: 1,
      releaseId,
      generatedAt: new Date().toISOString(),
      releaseEligible: false,
      evidence: prerequisites.evidence,
      evidenceBindingSha256: prerequisites.evidenceBindingSha256,
      selection: manifest.selection,
      totals,
      candidates: {
        path: 'candidates.ndjson.gz',
        bytes: outputDetails.size,
        sha256: outputSha256,
        contentEncoding: 'gzip',
        recordSchema: 'PuzzleV3CandidateEnvelopeV1',
      },
      blockedGates: [
        'stockfish-proof-per-learner-node',
        'promoted-tactical-shards',
      ],
    })
    // link() is an atomic create-if-absent operation. Unlike rename(), it can
    // never replace a prior immutable candidate shard.
    await link(temporaryOutputPath, outputPath)
    promotedOutput = true
    await unlink(temporaryOutputPath)
    await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    manifestWritten = true
    process.stdout.write(`Wrote ${totals.candidates} engine-pending puzzle candidates to ${outputDirectory}\n`)
  } finally {
    if (gzip && !gzip.destroyed) gzip.destroy()
    if (output && !output.destroyed) output.destroy()
    prerequisites.association.close()
    dedupe?.close()
    await unlink(temporaryDedupePath).catch(() => undefined)
    await unlink(temporaryOutputPath).catch(() => undefined)
    if (promotedOutput && !manifestWritten) await unlink(outputPath).catch(() => undefined)
  }
}

function help(): void {
  process.stdout.write(`LineRecall puzzle data pipeline

Commands:
  integrity  Compute a pending local SHA-256 receipt. This never self-approves.
  ingest     Require complete compact-v3 exact states, family associations, an approved digest, and a verified
             Stockfish campaign; then emit release-bound, engine-pending candidates. --release-id is required.

No command downloads the puzzle archive, runs Stockfish, or fetches source-game PGNs. Historical schema-v2
graph_metadata/archive_runs data is never accepted by the production ingest command.
`)
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  if (!args.command || args.command === 'help') return help()
  if (args.command === 'integrity') return inspectIntegrity(args)
  if (args.command === 'ingest') return ingest(args)
  throw new Error(`Unknown command: ${args.command}`)
}

main().catch((error: unknown) => {
  process.stderr.write(`Puzzle pipeline failed: ${(error as Error).message}\n`)
  process.exitCode = 1
})

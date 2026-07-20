#!/usr/bin/env node
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
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
  type PuzzleAssociationIndex,
  type PuzzleFilterReason,
} from './puzzle-contracts.ts'
import { streamPuzzleCsvRecords } from './puzzle-csv-stream.ts'
import { TaxonomySearchIndexSchema } from '../../src/data/taxonomy-schema.ts'
import { assertBroadcastManifestApproved, type BroadcastManifestV1 } from './broadcast-contracts.ts'
import { LichessStandardManifestSchema, REPERTOIRE_MAX_PLY, type LichessStandardManifest } from './evidence-contracts.ts'
import { assertPuzzleGraphPrerequisite, type PuzzleGraphArchiveIdentity } from './puzzle-contracts.ts'

const DEFAULT_MANIFEST = 'data/manifests/lichess-puzzles.source.json'
const DEFAULT_SOURCE = '.cache/puzzles/lichess_db_puzzle.csv.zst'
const DEFAULT_RECEIPT = 'data/manifests/lichess-puzzles.integrity.json'
const DEFAULT_GRAPH = 'data/generated/v3/evidence-graph.sqlite'
const DEFAULT_BROADCAST_MANIFEST = 'data/manifests/broadcasts.source.json'
const DEFAULT_STANDARD_MANIFEST = 'data/manifests/lichess-standard-q2-2026.source.json'
const DEFAULT_TAXONOMY = 'data/generated/taxonomy/search-index.json'
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

function tagForTaxonomyName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
}

async function taxonomyTags(path: string): Promise<Map<string, string[]>> {
  const search = TaxonomySearchIndexSchema.parse(await readJson(path))
  const tags = new Map<string, string[]>()
  for (const line of search.entries) {
    const tag = tagForTaxonomyName(line.name)
    const ids = tags.get(tag) ?? []
    ids.push(line.id)
    tags.set(tag, ids)
  }
  for (const ids of tags.values()) ids.sort()
  return tags
}

async function requireCompleteGraph(graphPath: string, args: Arguments): Promise<{ sha256: string; archives: number }> {
  const broadcastValue = await readJson(resolve(args.options.get('broadcast-manifest') ?? DEFAULT_BROADCAST_MANIFEST))
  assertBroadcastManifestApproved(broadcastValue)
  const broadcast: BroadcastManifestV1 = broadcastValue
  const standard: LichessStandardManifest = LichessStandardManifestSchema.parse(
    await readJson(resolve(args.options.get('standard-manifest') ?? DEFAULT_STANDARD_MANIFEST)),
  )
  const expected: PuzzleGraphArchiveIdentity[] = [
    ...broadcast.archives.map((archive) => ({
      archiveId: `broadcast-${archive.month}`,
      sourceId: 'lichess-broadcasts' as const,
      month: archive.month,
      sha256: archive.sha256,
    })),
    ...standard.archives.map((archive) => ({
      archiveId: `standard-${archive.month}`,
      sourceId: 'lichess-standard-rated-q2-2026' as const,
      month: archive.month,
      sha256: archive.sha256,
    })),
  ]
  const database = new DatabaseSync(graphPath, { readOnly: true })
  try {
    const metadata = new Map((database.prepare('SELECT key,value FROM graph_metadata').all() as unknown as Array<{ key: string; value: string }>)
      .map(({ key, value }) => [key, value]))
    const completed = database.prepare(`
      SELECT archive_id AS archiveId, source_id AS sourceId, month, sha256
      FROM archive_runs WHERE status='complete' ORDER BY archive_id
    `).all() as unknown as PuzzleGraphArchiveIdentity[]
    assertPuzzleGraphPrerequisite({
      schemaVersion: metadata.get('schemaVersion'),
      completeBaselineMaximumPly: metadata.get('completeBaselineMaxPly'),
      adaptiveMaximumPly: metadata.get('adaptiveEvidenceMaxPly'),
      completed,
      expected,
    })
  } finally {
    database.close()
  }
  return { sha256: await sha256File(graphPath), archives: expected.length }
}

interface PuzzleTotals {
  rowsSeen: number
  candidates: number
  duplicates: number
  rejected: Partial<Record<PuzzleFilterReason | 'record_too_long' | 'field_too_long' | 'too_many_fields', number>>
  association: Record<'exact-position' | 'opening-family' | 'unlinked', number>
}

function increment(
  values: PuzzleTotals['rejected'],
  reason: keyof PuzzleTotals['rejected'],
): void {
  values[reason] = (values[reason] ?? 0) + 1
}

async function ingest(args: Arguments): Promise<void> {
  const manifest = await loadManifest(resolve(args.options.get('manifest') ?? DEFAULT_MANIFEST))
  const sourcePath = resolve(args.options.get('source') ?? DEFAULT_SOURCE)
  const receipt = await verifyApprovedReceipt(
    manifest,
    sourcePath,
    resolve(args.options.get('receipt') ?? DEFAULT_RECEIPT),
  )
  const sourceBinding = createPuzzleSourceBinding(manifest, receipt)
  const graphPath = resolve(args.options.get('graph') ?? DEFAULT_GRAPH)
  const graphIdentity = await requireCompleteGraph(graphPath, args)
  const tagMap = await taxonomyTags(resolve(args.options.get('taxonomy') ?? DEFAULT_TAXONOMY))
  const outputDirectory = resolve(args.options.get('output') ?? DEFAULT_OUTPUT)
  await mkdir(outputDirectory, { recursive: true })
  const outputPath = join(outputDirectory, 'candidates.ndjson.gz')
  const temporaryOutputPath = join(outputDirectory, '.candidates.ndjson.gz.partial')
  const temporaryDedupePath = join(outputDirectory, '.puzzle-dedupe.sqlite')
  const graph = new DatabaseSync(graphPath, { readOnly: true })
  const dedupe = new DatabaseSync(temporaryDedupePath)
  dedupe.exec('CREATE TABLE puzzle_ids(id TEXT PRIMARY KEY) STRICT; PRAGMA synchronous = OFF;')
  const exactPosition = graph.prepare('SELECT 1 AS found FROM position_outcomes WHERE epd = ? LIMIT 1')
  const insertPuzzleId = dedupe.prepare('INSERT OR IGNORE INTO puzzle_ids(id) VALUES (?)')
  const associationIndex: PuzzleAssociationIndex = {
    hasExactPosition: (epd) => exactPosition.get(epd) !== undefined,
    taxonomyLineIdsForTag: (tag) => tagMap.get(tag) ?? [],
  }
  const totals: PuzzleTotals = {
    rowsSeen: 0,
    candidates: 0,
    duplicates: 0,
    rejected: {},
    association: { 'exact-position': 0, 'opening-family': 0, unlinked: 0 },
  }
  const gzip = createGzip({ level: 9 })
  const output = createWriteStream(temporaryOutputPath, { flags: 'wx' })
  gzip.pipe(output)
  try {
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
      const candidate = puzzleCandidateFromRow(parsed.row, associationIndex)
      totals.candidates += 1
      totals.association[candidate.association.confidence] += 1
      if (!gzip.write(`${JSON.stringify(candidate)}\n`)) await once(gzip, 'drain')
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
    const result = {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      releaseEligible: false,
      source: sourceBinding,
      graph: {
        schemaVersion: 3,
        completeBaselineMaximumPly: REPERTOIRE_MAX_PLY,
        adaptiveMaximumPly: 100,
        completedArchives: graphIdentity.archives,
        sha256: graphIdentity.sha256,
      },
      selection: manifest.selection,
      totals,
      candidates: {
        path: 'candidates.ndjson.gz',
        bytes: outputDetails.size,
        sha256: outputSha256,
      },
      blockedGates: [
        'Every retained learner node still requires Stockfish 18 sanity verification.',
        'Only engine-verified candidates may be promoted into a release subset.',
      ],
    }
    await rename(temporaryOutputPath, outputPath)
    await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    process.stdout.write(`Wrote ${totals.candidates} engine-pending puzzle candidates to ${outputDirectory}\n`)
  } finally {
    if (!gzip.destroyed) gzip.destroy()
    graph.close()
    dedupe.close()
    await unlink(temporaryDedupePath).catch(() => undefined)
    await unlink(temporaryOutputPath).catch(() => undefined)
  }
}

function help(): void {
  process.stdout.write(`LineRecall puzzle data pipeline

Commands:
  integrity  Compute a pending local SHA-256 receipt. This never self-approves.
  ingest     Require an approved receipt, stream/filter/dedupe the archive, and emit engine-pending candidates.

No command downloads the puzzle archive or fetches source-game PGNs.
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

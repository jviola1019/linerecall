#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { dirname, join, relative, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { Worker } from 'node:worker_threads'
import { createGzip } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import {
  assertBroadcastManifestApproved,
  type BroadcastArchive,
  type BroadcastManifestV1,
} from './broadcast-contracts.ts'
import { readZstdPgnRecords } from './broadcast-pgn.ts'
import { sha256File, verifyArchive } from './broadcast-manifest.ts'
import {
  EVIDENCE_SCHEMA_VERSION,
  GraphExportManifestSchema,
  LichessStandardManifestSchema,
  REPERTOIRE_MAX_PLY,
  type LichessStandardManifest,
} from './evidence-contracts.ts'
import {
  EvidenceGraphStore,
  GRAPH_PGN_LIMITS,
  ingestGraphRecords,
  parseBroadcastGraphPgn,
  parseLichessStandardGraphPgn,
  type GraphArchiveIdentity,
} from './evidence-graph.ts'
import type {
  EvidenceArchiveWorkerInput,
  EvidenceArchiveWorkerResult,
} from './evidence-graph-archive-worker.ts'
import {
  constrainedEvidenceWorkerCount,
  inspectStandardMonolithicStorage,
} from './evidence-ingest-safety.ts'

const DEFAULT_DATABASE = 'data/generated/v2/evidence-graph.sqlite'
const DEFAULT_BROADCAST_MANIFEST = 'data/manifests/broadcasts.source.json'
const DEFAULT_BROADCAST_ARCHIVES = '.cache/broadcast/archives'
const DEFAULT_STANDARD_MANIFEST = 'data/manifests/lichess-standard-q2-2026.source.json'
const DEFAULT_EXPORT_DIRECTORY = 'data/generated/v2/export'

interface Arguments {
  command: string | undefined
  options: Map<string, string>
}

function parseArguments(argv: string[]): Arguments {
  const [command, ...rest] = argv
  const options = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]
    const value = rest[index + 1]
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

function selectedMonths(value: string | undefined): Set<string> | null {
  if (!value) return null
  const months = value.split(',').map((month) => month.trim())
  if (months.some((month) => !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month))) {
    throw new Error('--months must be a comma-separated YYYY-MM list')
  }
  return new Set(months)
}

async function prepareDatabase(path: string): Promise<EvidenceGraphStore> {
  await mkdir(dirname(path), { recursive: true })
  return new EvidenceGraphStore(path)
}

interface EvidenceArchiveJob {
  archivePath: string
  identity: GraphArchiveIdentity
  parser: EvidenceArchiveWorkerInput['parser']
  label: string
}

function workerCount(args: Arguments): number {
  return constrainedEvidenceWorkerCount(args.options.get('workers'))
}

function runEvidenceWorker(input: EvidenceArchiveWorkerInput): Promise<EvidenceArchiveWorkerResult> {
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(new URL('./evidence-graph-archive-worker.ts', import.meta.url), {
      workerData: input,
    })
    let settled = false
    worker.once('message', (result: EvidenceArchiveWorkerResult) => {
      settled = true
      resolveWorker(result)
    })
    worker.once('error', (error) => {
      settled = true
      rejectWorker(error)
    })
    worker.once('exit', (code) => {
      if (!settled) rejectWorker(new Error(`Evidence worker exited with code ${code}`))
    })
  })
}

async function removeShard(path: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) await rm(`${path}${suffix}`, { force: true })
}

async function ingestJobs(
  store: EvidenceGraphStore,
  jobs: readonly EvidenceArchiveJob[],
  concurrency: number,
): Promise<void> {
  const shardDirectory = resolve('.cache/evidence-graph-shards')
  await mkdir(shardDirectory, { recursive: true })
  const pending = jobs.filter((job) => {
    if (!store.hasCompletedArchive(job.identity)) return true
    process.stdout.write(`verified existing ${job.label}\n`)
    return false
  })
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (cursor < pending.length) {
      const index = cursor
      cursor += 1
      const job = pending[index]
      if (!job) return
      const shardPath = join(shardDirectory, `${job.identity.archiveId}.sqlite`)
      const result = await runEvidenceWorker({
        archivePath: job.archivePath,
        identity: job.identity,
        parser: job.parser,
        shardPath,
      })
      let merged = false
      try {
        merged = store.mergeCompletedShard(job.identity, shardPath)
      } finally {
        await removeShard(shardPath)
      }
      if (!merged) {
        process.stdout.write(`${job.label}: cross-archive duplicate detected; replaying against global keys\n`)
        const fallback = await ingestGraphRecords({
          store,
          identity: job.identity,
          records: readZstdPgnRecords(job.archivePath, GRAPH_PGN_LIMITS),
          parse: job.parser === 'broadcast' ? parseBroadcastGraphPgn : parseLichessStandardGraphPgn,
        })
        result.totals = {
          recordsSeen: fallback.recordsSeen,
          accepted: fallback.accepted,
          deduplicated: fallback.deduplicated,
          rejected: fallback.rejected,
        }
      }
      process.stdout.write(
        `aggregated ${job.label}: ${result.totals.accepted} accepted, ` +
        `${result.totals.deduplicated} deduplicated, ` +
        `${Object.values(result.totals.rejected).reduce((sum, count) => sum + (count ?? 0), 0)} rejected\n`,
      )
    }
  })
  await Promise.all(runners)
}

async function ingestBroadcasts(args: Arguments): Promise<void> {
  const manifestPath = resolve(args.options.get('manifest') ?? DEFAULT_BROADCAST_MANIFEST)
  const archiveDirectory = resolve(args.options.get('archive-dir') ?? DEFAULT_BROADCAST_ARCHIVES)
  const databasePath = resolve(args.options.get('db') ?? DEFAULT_DATABASE)
  const manifestValue = await readJson(manifestPath)
  assertBroadcastManifestApproved(manifestValue)
  const manifest: BroadcastManifestV1 = manifestValue
  const months = selectedMonths(args.options.get('months'))
  const selected = months
    ? manifest.archives.filter((archive) => months.has(archive.month))
    : manifest.archives
  if (months && selected.length !== months.size) throw new Error('One or more selected months are not approved')
  const jobs: EvidenceArchiveJob[] = []
  for (const archive of selected) {
    const path = join(archiveDirectory, archive.filename)
    await verifyArchive(path, archive.sha256)
    jobs.push({
      archivePath: path,
      identity: {
        archiveId: `broadcast-${archive.month}`,
        sourceId: 'lichess-broadcasts',
        month: archive.month,
        sha256: archive.sha256,
      },
      parser: 'broadcast',
      label: archive.filename,
    })
  }
  const store = await prepareDatabase(databasePath)
  try {
    await ingestJobs(store, jobs, workerCount(args))
  } finally {
    store.close()
  }
}

async function standardStorageAssessment(args: Arguments): ReturnType<typeof inspectStandardMonolithicStorage> {
  const manifestPath = resolve(args.options.get('manifest') ?? DEFAULT_STANDARD_MANIFEST)
  const databasePath = resolve(args.options.get('db') ?? DEFAULT_DATABASE)
  const manifest = LichessStandardManifestSchema.parse(await readJson(manifestPath))
  const months = selectedMonths(args.options.get('months'))
  const selected = months
    ? manifest.archives.filter((archive) => months.has(archive.month))
    : manifest.archives
  if (months && selected.length !== months.size) throw new Error('One or more selected months are not approved')
  return inspectStandardMonolithicStorage({
    archives: selected,
    databasePath,
    shardDirectory: resolve('.cache/evidence-graph-shards'),
  })
}

async function ingestStandard(args: Arguments): Promise<void> {
  workerCount(args)
  const storage = await standardStorageAssessment(args)
  process.stderr.write(`${JSON.stringify(storage, null, 2)}\n`)
  throw new Error(storage.detail)
}

async function preflightStandard(args: Arguments): Promise<void> {
  const storage = await standardStorageAssessment(args)
  process.stdout.write(`${JSON.stringify(storage, null, 2)}\n`)
  process.exitCode = 2
}

interface ArchiveSummaryRow {
  archive_id: string
  source_id: string
  status: string
  records_seen: number
  accepted: number
  deduplicated: number
  rejected_json: string
}

function archiveSummaries(database: DatabaseSync): Array<{
  id: string
  complete: boolean
  archivesExpected: number
  archivesCompleted: number
  recordsSeen: number
  accepted: number
  deduplicated: number
  rejected: Record<string, number>
}> {
  const rows = database.prepare(`
    SELECT archive_id, source_id, status, records_seen, accepted, deduplicated, rejected_json
    FROM archive_runs WHERE status = 'complete' ORDER BY source_id, archive_id
  `).all() as unknown as ArchiveSummaryRow[]
  const expected = new Map<string, number>([
    ['lichess-broadcasts', 78],
    ['lichess-standard-rated-q2-2026', 3],
  ])
  const groups = new Map<string, ReturnType<typeof archiveSummaries>[number]>()
  for (const sourceId of expected.keys()) {
    groups.set(sourceId, {
      id: sourceId,
      complete: false,
      archivesExpected: expected.get(sourceId)!,
      archivesCompleted: 0,
      recordsSeen: 0,
      accepted: 0,
      deduplicated: 0,
      rejected: {},
    })
  }
  for (const row of rows) {
    const group = groups.get(row.source_id)
    if (!group) throw new Error(`Unexpected evidence source ${row.source_id}`)
    if (row.status === 'complete') group.archivesCompleted += 1
    group.recordsSeen += row.records_seen
    group.accepted += row.accepted
    group.deduplicated += row.deduplicated
    const rejected = JSON.parse(row.rejected_json) as Record<string, number>
    for (const [reason, count] of Object.entries(rejected)) {
      group.rejected[reason] = (group.rejected[reason] ?? 0) + count
    }
  }
  for (const group of groups.values()) {
    group.complete = group.archivesCompleted === group.archivesExpected
  }
  return [...groups.values()]
}

async function writeRowsGzip(
  database: DatabaseSync,
  sql: string,
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  const gzip = createGzip({ level: 9 })
  const output = createWriteStream(path, { flags: 'wx' })
  gzip.pipe(output)
  for (const row of database.prepare(sql).iterate()) {
    if (!gzip.write(`${JSON.stringify(row)}\n`)) await once(gzip, 'drain')
  }
  gzip.end()
  await finished(output)
  const details = await stat(path)
  return { bytes: details.size, sha256: await sha256File(path) }
}

async function exportGraph(args: Arguments): Promise<void> {
  const databasePath = resolve(args.options.get('db') ?? DEFAULT_DATABASE)
  const outputDirectory = resolve(args.options.get('output') ?? DEFAULT_EXPORT_DIRECTORY)
  await mkdir(outputDirectory, { recursive: true })
  const database = new DatabaseSync(databasePath, { readOnly: false })
  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const positionsPath = join(outputDirectory, 'positions.ndjson.gz')
    const edgesPath = join(outputDirectory, 'edges.ndjson.gz')
    const positions = await writeRowsGzip(database, `
      SELECT cohort_id AS cohortId, month, time_control AS timeControl,
        rating_band AS ratingBand, nullif(rating_detail, '') AS ratingDetail,
        epd, min(min_ply) AS minPly, sum(n) AS n,
        sum(white_wins) AS whiteWins, sum(draws) AS draws, sum(black_wins) AS blackWins
      FROM position_outcomes
      INNER JOIN archive_runs USING (archive_id)
      WHERE archive_runs.status = 'complete'
      GROUP BY cohort_id, month, time_control, rating_band, rating_detail, epd
      ORDER BY epd, cohort_id, month, time_control, rating_band, rating_detail
    `, positionsPath)
    const edges = await writeRowsGzip(database, `
      SELECT cohort_id AS cohortId, month, time_control AS timeControl,
        rating_band AS ratingBand, nullif(rating_detail, '') AS ratingDetail,
        from_epd AS fromEpd, uci, san, to_epd AS toEpd, min(min_ply) AS minPly,
        sum(n) AS n, sum(white_wins) AS whiteWins, sum(draws) AS draws,
        sum(black_wins) AS blackWins
      FROM edge_outcomes
      INNER JOIN archive_runs USING (archive_id)
      WHERE archive_runs.status = 'complete'
      GROUP BY cohort_id, month, time_control, rating_band, rating_detail, from_epd, uci, san, to_epd
      ORDER BY from_epd, uci, to_epd, cohort_id, month, time_control, rating_band, rating_detail
    `, edgesPath)
    const sources = archiveSummaries(database)
    const blockedGates = [
      ...sources.filter((source) => !source.complete).map((source) => `${source.id}: incomplete corpus`),
      'repertoire-engine-v2: no complete Stockfish verification for graph learner nodes',
      'repertoire-scid-v2: no completed stratified graph cross-check',
      'puzzles: no approved local integrity receipt or engine-verified subset',
    ]
    const manifest = GraphExportManifestSchema.parse({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      releaseEligible: false,
      maximumPly: REPERTOIRE_MAX_PLY,
      databaseSha256: await sha256File(databasePath),
      sources,
      files: {
        positions: { path: relative(outputDirectory, positionsPath).replaceAll('\\', '/'), ...positions },
        edges: { path: relative(outputDirectory, edgesPath).replaceAll('\\', '/'), ...edges },
      },
      blockedGates,
    })
    const manifestPath = join(outputDirectory, 'manifest.json')
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    )
    process.stdout.write(`Wrote incomplete, fail-closed graph export to ${manifestPath}\n`)
  } finally {
    database.close()
  }
}

function printStatus(args: Arguments): void {
  const databasePath = resolve(args.options.get('db') ?? DEFAULT_DATABASE)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const archivesOnly = args.options.get('archives-only') === 'true'
    process.stdout.write(`${JSON.stringify({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      maximumPly: REPERTOIRE_MAX_PLY,
      sources: archiveSummaries(database),
      positions: archivesOnly ? null : (database.prepare(`
        SELECT count(*) AS count FROM position_outcomes
        INNER JOIN archive_runs USING (archive_id) WHERE archive_runs.status = 'complete'
      `).get() as { count: number }).count,
      edges: archivesOnly ? null : (database.prepare(`
        SELECT count(*) AS count FROM edge_outcomes
        INNER JOIN archive_runs USING (archive_id) WHERE archive_runs.status = 'complete'
      `).get() as { count: number }).count,
    }, null, 2)}\n`)
  } finally {
    database.close()
  }
}

function cleanupIncomplete(args: Arguments): void {
  const databasePath = resolve(args.options.get('db') ?? DEFAULT_DATABASE)
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;')
    const incomplete = database.prepare(
      "SELECT archive_id AS archiveId FROM archive_runs WHERE status = 'processing' ORDER BY archive_id",
    ).all() as unknown as Array<{ archiveId: string }>
    database.prepare("DELETE FROM archive_runs WHERE status = 'processing'").run()
    database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);')
    process.stdout.write(`Removed ${incomplete.length} incomplete archive contribution(s): ${incomplete.map((row) => row.archiveId).join(', ') || 'none'}\n`)
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.close()
  }
}

function help(): void {
  process.stdout.write(`LineRecall evidence graph pipeline (schema v${EVIDENCE_SCHEMA_VERSION})

Commands:
  broadcast  Verify and stream locally cached broadcast archives through ply 30.
  standard   Run the fail-closed storage preflight; ingestion remains disabled.
  preflight-standard  Print the exact Standard storage assessment and exit 2.
  status     Print exact completed archive and graph-row totals.
  cleanup    Remove only interrupted archive contributions; completed evidence is preserved.
  export     Emit deterministic gzip NDJSON shards and a fail-closed manifest.

Common options:
  --db <path>           Default: ${DEFAULT_DATABASE}
  --manifest <path>     Source-specific approved manifest.
  --archive-dir <path>  Local, already-downloaded archives; no command downloads implicitly.
  --months <list>       Optional comma-separated YYYY-MM development subset.
  --workers 1           Archive parser concurrency is fixed at one.
  --output <path>       Export directory; default ${DEFAULT_EXPORT_DIRECTORY}.
  --archives-only true  With status, skip expensive graph-row counts.
`)
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  if (!args.command || args.command === 'help') return help()
  if (args.command === 'broadcast') return ingestBroadcasts(args)
  if (args.command === 'standard') return ingestStandard(args)
  if (args.command === 'preflight-standard') return preflightStandard(args)
  if (args.command === 'status') return printStatus(args)
  if (args.command === 'cleanup') return cleanupIncomplete(args)
  if (args.command === 'export') return exportGraph(args)
  throw new Error(`Unknown command: ${args.command}`)
}

main().catch((error: unknown) => {
  process.stderr.write(`Evidence graph pipeline failed: ${(error as Error).message}\n`)
  process.exitCode = 1
})

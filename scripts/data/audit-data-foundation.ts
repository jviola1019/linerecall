#!/usr/bin/env node
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TaxonomySourceManifestSchema } from '../../src/data/taxonomy-schema.ts'
import {
  assertBroadcastManifestApproved,
  type BroadcastManifestV1,
} from './broadcast-contracts.ts'
import { sha256File, verifyArchive } from './broadcast-manifest.ts'
import {
  LichessPuzzleManifestSchema,
  LichessStandardManifestSchema,
  PuzzleIntegrityReceiptSchema,
} from './evidence-contracts.ts'
import { ScidManifestSchema, StockfishManifestSchema } from '../verification/lib/manifest.ts'
import { validateGraphFoundation, type ArchiveRunEvidence, type ExpectedArchiveIdentity } from './foundation-validation.ts'

type GateStatus = 'pass' | 'blocked' | 'fail'

interface Gate {
  status: GateStatus
  detail: string
}

const option = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return resolve(value)
}

const hasFlag = (name: string): boolean => process.argv.includes(name)

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function gate(status: GateStatus, detail: string): Gate {
  return { status, detail }
}

async function main(): Promise<void> {
  const outputPath = option('--output', 'data/generated/v2/foundation-audit.json')
  const broadcastDirectory = option('--broadcast-dir', '.cache/broadcast/archives')
  const standardDirectory = option('--standard-dir', '.cache/standard-q2-2026')
  const puzzlePath = option('--puzzle', '.cache/puzzles/lichess_db_puzzle.csv.zst')
  const puzzleReceiptPath = option('--puzzle-receipt', 'data/manifests/lichess-puzzles.integrity.json')
  const graphPath = option('--graph', 'data/generated/v2/evidence-graph.sqlite')
  const verifyLocalSha = hasFlag('--verify-local-sha')
  const requireComplete = hasFlag('--require-complete')

  const [taxonomy, broadcastValue, stockfish, scid, standard, puzzle] = await Promise.all([
    TaxonomySourceManifestSchema.parse(await json(resolve('data/manifests/taxonomy.source.json'))),
    json(resolve('data/manifests/broadcasts.source.json')),
    StockfishManifestSchema.parse(await json(resolve('data/manifests/stockfish-18.source.json'))),
    ScidManifestSchema.parse(await json(resolve('data/manifests/scid.source.json'))),
    LichessStandardManifestSchema.parse(await json(resolve('data/manifests/lichess-standard-q2-2026.source.json'))),
    LichessPuzzleManifestSchema.parse(await json(resolve('data/manifests/lichess-puzzles.source.json'))),
  ])
  assertBroadcastManifestApproved(broadcastValue)
  const broadcast: BroadcastManifestV1 = broadcastValue

  const gates: Record<string, Gate> = {
    taxonomyManifest: gate(
      taxonomy.approval.status === 'approved' ? 'pass' : 'fail',
      `${taxonomy.format.expectedRows} rows / ${taxonomy.format.expectedEcoCodes} ECO codes at ${taxonomy.source.commit}`,
    ),
    broadcastManifest: gate('pass', `${broadcast.archives.length} approved CC BY-SA 4.0 archives through ${broadcast.cutoffMonth}`),
    standardManifest: gate('pass', `${standard.archives.length} approved CC0 archives / ${standard.source.publishedGameTotal} published games`),
    puzzleManifest: gate('pass', `CC0 source identity pinned at ${puzzle.source.asOf}; publisher SHA-256 unavailable`),
    stockfishManifest: gate(
      stockfish.approval.status === 'approved' ? 'pass' : 'fail',
      `Stockfish ${stockfish.version}, ${stockfish.analysisConfiguration.nodes} nodes, MultiPV ${stockfish.analysisConfiguration.multiPv}`,
    ),
    scidManifest: gate(scid.approval.status === 'approved' ? 'pass' : 'fail', `Scid audit oracle ${scid.repositoryCommit}`),
  }

  let cachedBroadcasts = 0
  for (const archive of broadcast.archives) {
    const path = join(broadcastDirectory, archive.filename)
    if (!(await exists(path))) continue
    if (verifyLocalSha) await verifyArchive(path, archive.sha256)
    cachedBroadcasts += 1
  }
  gates.broadcastCache = cachedBroadcasts === broadcast.archives.length
    ? gate('pass', `${cachedBroadcasts}/78 archives present${verifyLocalSha ? ' and SHA-256 verified' : '; run with --verify-local-sha to rehash bytes'}`)
    : gate('blocked', `${cachedBroadcasts}/78 approved archives present`)

  let cachedStandard = 0
  for (const archive of standard.archives) {
    const path = join(standardDirectory, archive.filename)
    if (!(await exists(path))) continue
    const details = await stat(path)
    if (details.size !== archive.bytes) throw new Error(`${archive.filename} has an unexpected byte length`)
    if (verifyLocalSha) await verifyArchive(path, archive.sha256)
    cachedStandard += 1
  }
  gates.standardCache = cachedStandard === standard.archives.length
    ? gate('pass', `${cachedStandard}/3 archives present${verifyLocalSha ? ' and SHA-256 verified' : ''}`)
    : gate('blocked', `${cachedStandard}/3 archives present; the 87.2 GB corpus was not downloaded by this audit`)

  const puzzlePresent = await exists(puzzlePath)
  gates.puzzleCache = puzzlePresent
    ? gate('pass', `Puzzle archive present at ${puzzlePath}`)
    : gate('blocked', 'Puzzle archive is not cached; no download was attempted')
  if (await exists(puzzleReceiptPath)) {
    const receipt = PuzzleIntegrityReceiptSchema.parse(await json(puzzleReceiptPath))
    gates.puzzleIntegrity = receipt.approval.status === 'approved'
      ? gate('pass', `Approved local digest ${receipt.sha256}`)
      : gate('blocked', `Local digest receipt status is ${receipt.approval.status}`)
  } else {
    gates.puzzleIntegrity = gate('blocked', 'No locally computed and explicitly approved puzzle SHA-256 receipt exists')
  }

  if (await exists(graphPath)) {
    const database = new DatabaseSync(graphPath, { readOnly: true })
    try {
      const metadata = new Map((database.prepare('SELECT key,value FROM graph_metadata').all() as unknown as Array<{ key: string; value: string }>)
        .map(({ key, value }) => [key, value]))
      const expected: ExpectedArchiveIdentity[] = [
        ...broadcast.archives.map((archive) => ({
          archiveId: `broadcast-${archive.month}`, sourceId: 'lichess-broadcasts' as const,
          month: archive.month, sha256: archive.sha256,
        })),
        ...standard.archives.map((archive) => ({
          archiveId: `standard-${archive.month}`, sourceId: 'lichess-standard-rated-q2-2026' as const,
          month: archive.month, sha256: archive.sha256,
        })),
      ]
      const runs = database.prepare(`
        SELECT archive_id AS archiveId, source_id AS sourceId, month, sha256, status,
               records_seen AS recordsSeen, accepted, deduplicated, rejected_json AS rejectedJson,
               completed_at AS completedAt
        FROM archive_runs ORDER BY archive_id
      `).all() as unknown as ArchiveRunEvidence[]
      const validated = validateGraphFoundation({
        schemaVersion: metadata.get('schemaVersion'), maximumPly: metadata.get('maximumPly'), expected, runs,
      })
      if (validated.complete) {
        const invalidPositions = database.prepare(`
          SELECT count(*) AS count FROM position_outcomes
          WHERE n <= 0 OR n != white_wins + draws + black_wins OR min_ply < 0 OR min_ply > 30
        `).get() as { count: number }
        const invalidEdges = database.prepare(`
          SELECT count(*) AS count FROM edge_outcomes
          WHERE n <= 0 OR n != white_wins + draws + black_wins OR min_ply < 1 OR min_ply > 30
        `).get() as { count: number }
        const content = database.prepare(`
          SELECT (SELECT count(*) FROM games) AS games,
                 (SELECT count(*) FROM position_outcomes) AS positions,
                 (SELECT count(*) FROM edge_outcomes) AS edges
        `).get() as { games: number; positions: number; edges: number }
        if (invalidPositions.count !== 0 || invalidEdges.count !== 0 || content.games === 0 || content.positions === 0 || content.edges === 0) {
          throw new Error('Evidence graph content or W/D/L arithmetic is invalid')
        }
        const standardGroup = validated.groups.find(({ sourceId }) => sourceId === 'lichess-standard-rated-q2-2026')!
        if (standardGroup.recordsSeen !== standard.source.publishedGameTotal) {
          throw new Error('Standard graph record total does not match the approved published total')
        }
        const digest = await sha256File(graphPath)
        gates.deepEvidenceGraph = gate('pass', `Manifest-bound ply-30 graph ${digest}; ${content.games} games, ${content.positions} position rows, ${content.edges} edge rows`)
      } else {
        const bySource = new Map(validated.groups.map((group) => [group.sourceId, group]))
        gates.deepEvidenceGraph = gate('blocked', `Completed graph archives: broadcast ${bySource.get('lichess-broadcasts')?.completed ?? 0}/78; standard ${bySource.get('lichess-standard-rated-q2-2026')?.completed ?? 0}/3`)
      }
    } finally {
      database.close()
    }
  } else {
    gates.deepEvidenceGraph = gate('blocked', 'No schema-v2 ply-30 evidence graph database exists yet')
  }

  gates.repertoireEngineV2 = await exists(resolve('data/generated/v2/repertoire-engine-analysis.json'))
    ? gate('fail', 'Unvalidated schema-v2 engine output is present; file existence cannot satisfy this gate')
    : gate('blocked', 'Existing Stockfish evidence covers the prior taxonomy-line model, not new graph learner nodes')
  gates.repertoireScidV2 = await exists(resolve('data/generated/v2/repertoire-scid-crosscheck.json'))
    ? gate('fail', 'Unvalidated schema-v2 Scid output is present; file existence cannot satisfy this gate')
    : gate('blocked', 'Existing Scid evidence covers the prior taxonomy-line sample, not new repertoire packs')
  gates.puzzleEngineV1 = await exists(resolve('data/generated/v2/puzzles/verified-manifest.json'))
    ? gate('fail', 'Unvalidated puzzle verification output is present; file existence cannot satisfy this gate')
    : gate('blocked', 'No Stockfish-verified opening-puzzle subset exists')

  const statuses = Object.values(gates).map(({ status }) => status)
  const result = statuses.includes('fail') ? 'fail' : statuses.includes('blocked') ? 'blocked' : 'pass'
  const report = {
    schemaVersion: 1,
    auditedAt: new Date().toISOString(),
    result,
    releaseEligible: result === 'pass',
    claims: {
      existingBroadcastRecordsSeen: 1_146_297,
      existingBroadcastAccepted: 800_176,
      existingBroadcastEvidenceScope: 'prior 7,824-position taxonomy target run; not silently promoted to the ply-30 graph',
      standardAccepted: null,
      puzzleAccepted: null,
      explanation: 'Null totals mean the required local source corpus has not been processed; no values are estimated.',
    },
    gates,
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`Data foundation audit: ${result}. Report: ${outputPath}\n`)
  if (requireComplete && result !== 'pass') process.exitCode = 2
}

main().catch((error: unknown) => {
  process.stderr.write(`Data foundation audit failed: ${(error as Error).message}\n`)
  process.exitCode = 1
})

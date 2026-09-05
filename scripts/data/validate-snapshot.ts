import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { z } from 'zod'
import {
  DataManifestSchema,
  OpeningPartitionSchema,
  UciMoveSchema,
  type DataManifest,
  type OpeningPartition,
} from '../../src/domain/opening-data.ts'
import { normalizedEpd } from './broadcast-pgn.ts'

const SearchIndexSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  entries: z.array(z.object({
    sourceLineId: z.string().regex(/^tax_[a-f0-9]{24}$/u),
    eco: z.string().regex(/^[A-E][0-9]{2}$/u),
    name: z.string().min(1).max(256),
    pgn: z.string().min(1).max(4_096),
    uci: z.array(UciMoveSchema).min(1).max(200),
    terminalEpd: z.string().refine((value) => value.split(/\s+/u).length === 4),
    terminalSampleSize: z.number().int().nonnegative(),
    backtestEligible: z.boolean(),
    verifiedVariantIds: z.array(z.string().min(1)).max(2),
  }).strict()).length(3_790),
}).strict()

const SampleReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  lines: z.array(z.object({
    sourceLineId: z.string().regex(/^tax_[a-f0-9]{24}$/u),
    eco: z.string().regex(/^[A-E][0-9]{2}$/u),
    name: z.string().min(1),
    terminalSampleSize: z.number().int().nonnegative(),
    drillThresholdMet: z.boolean(),
    bands: z.record(z.string(), z.number().int().nonnegative()),
  }).strict()).length(3_790),
}).strict()

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing option ${name}`)
  return resolve(value)
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function moveParts(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

function replay(moves: string[], stopBeforePly = moves.length): Chess {
  const chess = new Chess()
  for (let ply = 0; ply < stopBeforePly; ply += 1) {
    const move = moves[ply]
    if (!move) throw new Error(`Missing move at ply ${ply}`)
    try {
      chess.move(moveParts(move))
    } catch (error) {
      throw new Error(`Illegal UCI move ${move} at ply ${ply}: ${(error as Error).message}`)
    }
  }
  return chess
}

function validateLineStats(line: OpeningPartition['lines'][number]): void {
  const whiteN = line.terminalWhiteStats.reduce((sum, stats) => sum + stats.n, 0)
  const blackN = line.terminalBlackStats.reduce((sum, stats) => sum + stats.n, 0)
  if (whiteN !== line.terminalSampleSize || blackN !== line.terminalSampleSize) {
    throw new Error(`Terminal band totals do not equal N for ${line.sourceLineId}`)
  }
  for (let index = 0; index < 5; index += 1) {
    const white = line.terminalWhiteStats[index]
    const black = line.terminalBlackStats[index]
    if (
      !white || !black ||
      white.band !== black.band ||
      white.n !== black.n ||
      white.whiteWins !== black.whiteWins ||
      white.draws !== black.draws ||
      white.blackWins !== black.blackWins
    ) throw new Error(`White/Black raw stats differ for ${line.sourceLineId}`)
  }
  if (line.backtestEligible !== (line.terminalSampleSize >= 500)) {
    throw new Error(`Backtest threshold flag is inconsistent for ${line.sourceLineId}`)
  }
  replay(line.uci)
}

function validateVerifiedLine(
  verified: OpeningPartition['verifiedLines'][number],
  source: OpeningPartition['lines'][number],
  manifest: DataManifest,
): void {
  if (
    verified.sourceLineId !== source.sourceLineId ||
    verified.eco !== source.eco ||
    verified.name !== source.name ||
    JSON.stringify(verified.uci) !== JSON.stringify(source.uci) ||
    verified.terminalSampleSize !== source.terminalSampleSize ||
    verified.provenanceRef !== source.provenanceRef
  ) throw new Error(`Verified variant ${verified.id} does not match its source line`)
  if (verified.insufficientBacktestSample || !verified.selectedForEngineVerification) {
    throw new Error(`Engine report contains an unverified variant ${verified.id}`)
  }
  if (verified.quarantined === verified.drillEligible) {
    throw new Error(`Quarantine/drill eligibility is inconsistent for ${verified.id}`)
  }
  if (verified.drillEligible && verified.terminalSampleSize < 500) {
    throw new Error(`Below-threshold variant entered drills: ${verified.id}`)
  }
  const expectedPlies = source.uci
    .map((_, ply) => ply)
    .filter((ply) => (verified.trainedSide === 'white') === (ply % 2 === 0))
  if (verified.nodes.length !== expectedPlies.length) {
    throw new Error(`Variant ${verified.id} is missing decision nodes`)
  }
  for (const [index, node] of verified.nodes.entries()) {
    const expectedPly = expectedPlies[index]
    if (expectedPly === undefined || node.ply !== expectedPly || source.uci[node.ply] !== node.expectedMoveUci) {
      throw new Error(`Node ${node.id} is not the expected taxonomy decision`)
    }
    const chess = replay(source.uci, node.ply)
    if (normalizedEpd(chess) !== node.epd || normalizedEpd(new Chess(node.fen)) !== node.epd) {
      throw new Error(`Node ${node.id} FEN/EPD does not match its line path`)
    }
    const expectedTurn = verified.trainedSide === 'white' ? 'w' : 'b'
    if (chess.turn() !== expectedTurn || new Chess(node.fen).turn() !== expectedTurn) {
      throw new Error(`Node ${node.id} is not the trained side's turn`)
    }
    if (!node.equivalentPositionLineIds.includes(source.sourceLineId)) {
      throw new Error(`Node ${node.id} lacks its own line in transposition metadata`)
    }
    const expectedMoves = node.moves.filter((move) => move.expected)
    if (expectedMoves.length !== 1 || expectedMoves[0]?.uci !== node.expectedMoveUci) {
      throw new Error(`Node ${node.id} does not have exactly one expected move`)
    }
    if (node.engine.engineRef !== manifest.engine.id) {
      throw new Error(`Node ${node.id} references the wrong engine`)
    }
    for (const move of node.moves) {
      const moveChess = new Chess(node.fen)
      try {
        const applied = moveChess.move(moveParts(move.uci))
        if (!applied || applied.san !== move.san) throw new Error('SAN mismatch')
      } catch (error) {
        throw new Error(`Illegal move evidence ${node.id}/${move.uci}: ${(error as Error).message}`)
      }
      const sampleTotal = move.bands.reduce((sum, stats) => sum + stats.n, 0)
      if (sampleTotal !== move.sampleSize) {
        throw new Error(`Move band totals do not equal N for ${node.id}/${move.uci}`)
      }
      if (
        move.classification === 'playable' &&
        (move.sampleSize < 100 || move.centipawnLoss === null || move.centipawnLoss > 50)
      ) throw new Error(`Playable classification violates policy at ${node.id}/${move.uci}`)
      if (move.classification === 'inaccuracy' && (move.centipawnLoss === null || move.centipawnLoss < 51 || move.centipawnLoss > 99)) {
        throw new Error(`Inaccuracy classification violates policy at ${node.id}/${move.uci}`)
      }
      if (move.classification === 'mistake' && move.centipawnLoss !== null && move.centipawnLoss < 100 && move.score?.kind !== 'mate') {
        throw new Error(`Mistake classification violates policy at ${node.id}/${move.uci}`)
      }
    }
    const next = verified.nodes[index + 1]
    if (node.nextNodeId !== (next?.id ?? null)) {
      throw new Error(`Broken next-node link at ${node.id}`)
    }
  }
}

export async function validateSnapshot(options: {
  directory: string
  reportPath: string
}): Promise<Record<string, unknown>> {
  const manifestPath = join(options.directory, 'manifest.json')
  const manifestBytes = await readFile(manifestPath)
  const manifest = DataManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')) as unknown)
  if (!manifest.releaseEligible) throw new Error('Data manifest is not release eligible')
  const provenance = new Map(manifest.provenance.map((entry) => [entry.id, entry]))
  if (provenance.size !== 3_790) throw new Error('Provenance IDs are not unique')

  const sourceIds = new Set<string>()
  const verifiedIds = new Set<string>()
  const sourceById = new Map<string, OpeningPartition['lines'][number]>()
  let drillableVariants = 0
  let quarantinedVariants = 0
  let compressedBytes = 0
  let uncompressedBytes = 0
  for (const entry of manifest.catalog) {
    const compressed = await readFile(join(options.directory, 'partitions', `${entry.eco}.json.gz`))
    if (compressed.byteLength !== entry.compressedBytes || sha256(compressed) !== entry.sha256) {
      throw new Error(`Partition ${entry.eco} compressed integrity mismatch`)
    }
    const uncompressed = gunzipSync(compressed)
    if (uncompressed.byteLength !== entry.uncompressedBytes) {
      throw new Error(`Partition ${entry.eco} uncompressed size mismatch`)
    }
    const partition = OpeningPartitionSchema.parse(JSON.parse(uncompressed.toString('utf8')) as unknown)
    if (partition.eco !== entry.eco || partition.lines.length !== entry.lineCount) {
      throw new Error(`Partition/catalog mismatch for ${entry.eco}`)
    }
    for (const line of partition.lines) {
      if (sourceIds.has(line.sourceLineId)) throw new Error(`Duplicate source line ${line.sourceLineId}`)
      sourceIds.add(line.sourceLineId)
      sourceById.set(line.sourceLineId, line)
      if (!provenance.has(line.provenanceRef)) throw new Error(`Missing provenance ${line.provenanceRef}`)
      validateLineStats(line)
    }
    for (const verified of partition.verifiedLines) {
      if (verifiedIds.has(verified.id)) throw new Error(`Duplicate verified variant ${verified.id}`)
      verifiedIds.add(verified.id)
      const source = partition.lines.find((line) => line.sourceLineId === verified.sourceLineId)
      if (!source || !source.verifiedVariantIds.includes(verified.id)) {
        throw new Error(`Variant ${verified.id} is not linked from its source`)
      }
      validateVerifiedLine(verified, source, manifest)
      if (verified.drillEligible) drillableVariants += 1
      if (verified.quarantined) quarantinedVariants += 1
    }
    if (partition.verifiedLines.filter((line) => line.drillEligible).length !== entry.drillableVariantCount) {
      throw new Error(`Catalog drillable count mismatch for ${entry.eco}`)
    }
    compressedBytes += compressed.byteLength
    uncompressedBytes += uncompressed.byteLength
  }
  if (sourceIds.size !== 3_790 || verifiedIds.size !== manifest.audit.verifiedVariants) {
    throw new Error('Snapshot line totals do not match manifest')
  }
  if (
    drillableVariants !== manifest.audit.drillableVariants ||
    quarantinedVariants !== manifest.audit.quarantinedVariants
  ) throw new Error('Snapshot quarantine totals do not match manifest')

  const searchCompressed = await readFile(join(options.directory, 'search-index.json.gz'))
  if (
    searchCompressed.byteLength !== manifest.searchIndex.compressedBytes ||
    sha256(searchCompressed) !== manifest.searchIndex.sha256
  ) throw new Error('Search index compressed integrity mismatch')
  const searchUncompressed = gunzipSync(searchCompressed)
  if (searchUncompressed.byteLength !== manifest.searchIndex.uncompressedBytes) {
    throw new Error('Search index uncompressed size mismatch')
  }
  const search = SearchIndexSchema.parse(JSON.parse(searchUncompressed.toString('utf8')) as unknown)
  for (const entry of search.entries) {
    const source = sourceById.get(entry.sourceLineId)
    if (!source || source.eco !== entry.eco || source.name !== entry.name) {
      throw new Error(`Search entry ${entry.sourceLineId} does not match its partition`)
    }
  }

  const sampleReport = SampleReportSchema.parse(await readJson(join(options.directory, 'sample-sizes.json')))
  const sampleIds = new Set<string>()
  for (const sample of sampleReport.lines) {
    if (sampleIds.has(sample.sourceLineId)) throw new Error(`Duplicate sample report line ${sample.sourceLineId}`)
    sampleIds.add(sample.sourceLineId)
    const source = sourceById.get(sample.sourceLineId)
    const bandTotal = Object.values(sample.bands).reduce((sum, n) => sum + n, 0)
    if (
      !source ||
      source.terminalSampleSize !== sample.terminalSampleSize ||
      sample.drillThresholdMet !== (sample.terminalSampleSize >= 500) ||
      bandTotal !== sample.terminalSampleSize
    ) throw new Error(`Sample-size report mismatch for ${sample.sourceLineId}`)
  }

  const report = {
    schemaVersion: 1,
    validatedAt: new Date().toISOString(),
    manifestSha256: sha256(manifestBytes),
    result: 'pass',
    totals: {
      ecoPartitions: manifest.catalog.length,
      browsableLines: sourceIds.size,
      verifiedVariants: verifiedIds.size,
      drillableVariants,
      quarantinedVariants,
      compressedPartitionBytes: compressedBytes,
      uncompressedPartitionBytes: uncompressedBytes,
      searchIndexEntries: search.entries.length,
      provenanceRecords: provenance.size,
      sampleSizeRecords: sampleIds.size,
    },
    gates: {
      schemas: 'pass',
      compressedChecksums: 'pass',
      legalMoves: 'pass',
      wdlArithmetic: 'pass',
      graphLinks: 'pass',
      quarantineExclusion: 'pass',
      provenanceCompleteness: 'pass',
      searchIndexConsistency: 'pass',
    },
  }
  await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

const directory = option('--directory', 'data/generated/release')
const reportPath = option('--report', join(directory, 'validation-report.json'))
const report = await validateSnapshot({ directory, reportPath })
process.stdout.write(`Snapshot validation passed: ${JSON.stringify(report.totals)}\n`)

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { z } from 'zod'
import {
  BandStatsSchema,
  DataManifestSchema,
  EngineScoreSchema,
  EngineVariationSchema,
  OpeningPartitionSchema,
  VerifiedLineSchema,
  type BandStats,
  type OpeningCatalogEntry,
  type OpeningPartition,
  type Provenance,
  type VerifiedLine,
} from '../../src/domain/opening-data.ts'
import {
  TaxonomyCatalogSchema,
  TaxonomyPartitionSchema,
  TaxonomySourceManifestSchema,
  type NormalizedTaxonomyLine,
} from '../../src/data/taxonomy-schema.ts'
import {
  RATING_BANDS,
  BROADCAST_PUBLISHED_GAME_TOTAL,
  type BandedRawOutcomes,
  type BroadcastBacktestV1,
  type PositionBacktest,
  type RawOutcomeCounts,
  type TerminalLineBacktest,
} from './broadcast-contracts.ts'
import { normalizedEpd } from './broadcast-pgn.ts'
import { ScidManifestSchema, StockfishManifestSchema } from '../verification/lib/manifest.ts'

const EngineMoveSchema = z.object({
  moveUci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u),
  sampleSize: z.number().int().nonnegative(),
  acceptedBookTransposition: z.boolean(),
  classification: z.enum(['book', 'playable', 'inaccuracy', 'mistake', 'unverified_deviation']),
  centipawnLoss: z.number().int().nonnegative().nullable(),
  score: EngineScoreSchema.nullable(),
  principalVariationUci: z.array(z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u)),
  independentlyEngineAnalyzed: z.boolean(),
}).strict()

const EngineNodeSchema = z.object({
  id: z.string().min(1),
  fen: z.string().min(1),
  expectedMoveUci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u),
  bestMoveUci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u),
  bestScore: EngineScoreSchema,
  topVariations: z.array(EngineVariationSchema).min(1).max(5),
  moves: z.array(EngineMoveSchema).min(1),
  expectedMoveCentipawnLoss: z.number().int().nonnegative(),
  quarantined: z.boolean(),
  quarantineReasons: z.array(z.string().min(1)),
}).strict()

const EngineLineSchema = z.object({
  id: z.string().min(1),
  sourceLineId: z.string().regex(/^tax_[a-f0-9]{24}$/u),
  eco: z.string().regex(/^[A-E][0-9]{2}$/u),
  name: z.string().min(1),
  trainedSide: z.enum(['white', 'black']),
  terminalSampleSize: z.number().int().nonnegative(),
  quarantined: z.boolean(),
  quarantineReasons: z.array(z.string().min(1)),
  nodes: z.array(EngineNodeSchema).min(1),
}).strict()

const EngineReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  configuration: z.object({
    threads: z.literal(1),
    hashMb: z.literal(128),
    multiPv: z.literal(5),
    nodes: z.literal(250_000),
    maximumLinesPerEco: z.literal(3),
    minimumTerminalSampleSize: z.literal(500),
    independentlyAnalyzedAlternativeMinimumSampleSize: z.literal(100),
    playableMaximumCentipawnLoss: z.literal(50),
    inaccuracyMaximumCentipawnLoss: z.literal(99),
    quarantineCentipawnLoss: z.literal(100),
    releaseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  }).strict(),
  engine: z.object({
    name: z.string().min(1),
    author: z.string().nullable(),
    executableFileName: z.string().min(1),
    binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    nnue: z.array(z.object({
      role: z.enum(['big', 'small']),
      defaultFileName: z.string().nullable(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }).strict()).length(2),
    license: z.object({ spdx: z.literal('GPL-3.0-only') }).passthrough(),
  }).strict(),
  summary: z.object({
    selectedLineCount: z.number().int().nonnegative(),
    analyzedDecisionNodeCount: z.number().int().nonnegative(),
    quarantinedLineCount: z.number().int().nonnegative(),
    engineSearchRequests: z.number().int().nonnegative(),
    uniqueEngineSearchCount: z.number().int().nonnegative(),
    reusedEngineSearchCount: z.number().int().nonnegative(),
  }).strict(),
  lines: z.array(EngineLineSchema),
}).passthrough()

const ScidResultSchema = z.object({
  lineId: z.string().regex(/^tax_[a-f0-9]{24}$/u),
  taxonomyEco: z.string().regex(/^[A-E][0-9]{2}$/u),
  taxonomyName: z.string().min(1),
  status: z.enum(['match', 'naming_difference', 'missing_oracle_entry', 'base_eco_mismatch', 'ambiguous_oracle_base']),
  quarantined: z.boolean(),
  deepestMatchedPly: z.number().int().positive().nullable(),
  oracleBaseEcos: z.array(z.string()),
  oracleCodes: z.array(z.string()),
  oracleNames: z.array(z.string()),
}).strict()

const ScidReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  oracle: z.object({
    repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    license: z.object({ spdx: z.literal('GPL-2.0-only') }).passthrough(),
    parsedEntryCount: z.number().int().positive(),
    rejectedEntryCount: z.literal(0),
  }).strict(),
  sampling: z.object({
    maximum: z.number().int().min(1).max(250),
    selected: z.number().int().nonnegative().max(250),
  }).passthrough(),
  summary: z.object({ quarantinedLineCount: z.number().int().nonnegative() }).passthrough(),
  results: z.array(ScidResultSchema).max(250),
}).passthrough()

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing required argument ${name}`)
  return value
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function contentId(prefix: 'engine' | 'scid' | 'prov', value: unknown): string {
  return `${prefix}_${sha256(JSON.stringify(value)).slice(0, 16)}`
}

function totalOf(bands: BandedRawOutcomes): number {
  return RATING_BANDS.reduce((sum, band) => sum + bands[band].n, 0)
}

function percentage(value: number, n: number): number | null {
  return n === 0 ? null : Math.round((value / n) * 10_000) / 100
}

function bandStats(raw: RawOutcomeCounts, side: 'white' | 'black', band: (typeof RATING_BANDS)[number]): BandStats {
  const wins = side === 'white' ? raw.whiteWins : raw.blackWins
  const losses = side === 'white' ? raw.blackWins : raw.whiteWins
  return BandStatsSchema.parse({
    band,
    ...raw,
    wins,
    losses,
    winRate: percentage(wins, raw.n),
    drawRate: percentage(raw.draws, raw.n),
    lossRate: percentage(losses, raw.n),
    lowSample: raw.n > 0 && raw.n < 100,
  })
}

function bandArray(bands: BandedRawOutcomes, side: 'white' | 'black'): BandStats[] {
  return RATING_BANDS.map((band) => bandStats(bands[band], side, band))
}

function terminalBandArray(terminal: TerminalLineBacktest, side: 'white' | 'black'): BandStats[] {
  return RATING_BANDS.map((band) => bandStats(terminal.bands[band].raw, side, band))
}

function moveParts(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

function sanFor(fen: string, uci: string): string {
  const move = new Chess(fen).move(moveParts(uci))
  if (!move) throw new Error(`Illegal analyzed move ${uci} at ${fen}`)
  return move.san
}

async function loadTaxonomy(directory: string): Promise<{
  catalog: z.infer<typeof TaxonomyCatalogSchema>
  lines: NormalizedTaxonomyLine[]
}> {
  const catalog = TaxonomyCatalogSchema.parse(await readJson(join(directory, 'catalog.json')))
  const files = (await readdir(join(directory, 'partitions')))
    .filter((file) => /^[A-E]\d{2}\.json$/u.test(file))
    .sort()
  if (files.length !== 500) throw new Error(`Expected 500 taxonomy partitions, found ${files.length}`)
  const lines: NormalizedTaxonomyLine[] = []
  for (const file of files) {
    lines.push(...TaxonomyPartitionSchema.parse(await readJson(join(directory, 'partitions', file))).lines)
  }
  if (lines.length !== 3_790) throw new Error(`Expected 3,790 taxonomy lines, found ${lines.length}`)
  return { catalog, lines }
}

function assertBacktest(value: unknown): asserts value is BroadcastBacktestV1 {
  if (typeof value !== 'object' || value === null) throw new Error('Backtest is not an object')
  const candidate = value as Partial<BroadcastBacktestV1>
  if (
    candidate.schemaVersion !== 1 ||
    candidate.completeCorpus !== true ||
    candidate.corpus?.everyArchiveSha256Verified !== true ||
    candidate.corpus.archives.length !== 78 ||
    !Array.isArray(candidate.positions) ||
    !Array.isArray(candidate.terminalLines)
  ) {
    throw new Error('Release snapshot requires the complete checksum-verified corpus backtest')
  }
  const rejected = Object.values(candidate.totals?.rejected ?? {}).reduce((sum, count) => sum + (count ?? 0), 0)
  if ((candidate.totals?.accepted ?? -1) + (candidate.totals?.deduplicated ?? -1) + rejected !== candidate.totals?.recordsSeen) {
    throw new Error('Backtest accepted/deduplicated/rejected totals do not reconcile')
  }
  if (candidate.totals?.recordsSeen !== BROADCAST_PUBLISHED_GAME_TOTAL) {
    throw new Error(
      `Backtest saw ${candidate.totals?.recordsSeen ?? 'unknown'} records; official corpus publishes ${BROADCAST_PUBLISHED_GAME_TOTAL}`,
    )
  }
}

function scidQuarantineReason(result: z.infer<typeof ScidResultSchema>): string {
  return `Scid cross-check ${result.status}; oracle base ECO values: ${result.oracleBaseEcos.join(', ') || 'none'}`
}

export async function buildReleaseSnapshot(options: {
  taxonomyDirectory: string
  taxonomyManifestPath: string
  backtestPath: string
  engineReportPath: string
  scidReportPath: string
  stockfishManifestPath: string
  scidManifestPath: string
  outputDirectory: string
  generatedAt: string
}): Promise<{ manifestPath: string; drillableVariants: number; verifiedVariants: number }> {
  const [taxonomy, taxonomyManifest, rawBacktest, engineReport, scidReport, stockfishManifest, scidManifest] = await Promise.all([
    loadTaxonomy(options.taxonomyDirectory),
    readJson(options.taxonomyManifestPath).then((value) => TaxonomySourceManifestSchema.parse(value)),
    readJson(options.backtestPath),
    readJson(options.engineReportPath).then((value) => EngineReportSchema.parse(value)),
    readJson(options.scidReportPath).then((value) => ScidReportSchema.parse(value)),
    readJson(options.stockfishManifestPath).then((value) => StockfishManifestSchema.parse(value)),
    readJson(options.scidManifestPath).then((value) => ScidManifestSchema.parse(value)),
  ])
  assertBacktest(rawBacktest)
  const backtest = rawBacktest
  if (
    taxonomy.catalog.taxonomyCommit !== taxonomyManifest.source.commit ||
    backtest.taxonomyCommit !== taxonomyManifest.source.commit
  ) throw new Error('Taxonomy commits do not match across inputs')
  if (
    engineReport.configuration.releaseCommit !== stockfishManifest.releaseCommit ||
    scidReport.oracle.repositoryCommit !== scidManifest.repositoryCommit ||
    scidReport.oracle.sha256 !== scidManifest.sha256
  ) throw new Error('Engine or Scid report does not match its approved manifest')
  if (engineReport.summary.selectedLineCount !== engineReport.lines.length) {
    throw new Error('Engine selected line total does not match report lines')
  }
  if (scidReport.sampling.selected !== scidReport.results.length) {
    throw new Error('Scid selected total does not match result lines')
  }

  const positions = new Map(backtest.positions.map((position) => [position.epd, position]))
  const terminals = new Map(backtest.terminalLines.map((terminal) => [terminal.lineId, terminal]))
  const taxonomyLines = new Map(taxonomy.lines.map((line) => [line.id, line]))
  if (positions.size !== backtest.positions.length || terminals.size !== 3_790 || taxonomyLines.size !== 3_790) {
    throw new Error('Backtest or taxonomy contains missing or duplicate records')
  }
  const scidResults = new Map(scidReport.results.map((result) => [result.lineId, result]))
  if (scidResults.size !== scidReport.results.length) throw new Error('Duplicate Scid cross-check result')
  const engineLinesBySource = new Map<string, Array<z.infer<typeof EngineLineSchema>>>()
  for (const engineLine of engineReport.lines) {
    const source = taxonomyLines.get(engineLine.sourceLineId)
    if (!source || source.eco !== engineLine.eco || source.name !== engineLine.name) {
      throw new Error(`Engine line ${engineLine.id} does not match taxonomy`)
    }
    const variants = engineLinesBySource.get(source.id) ?? []
    if (variants.some((variant) => variant.trainedSide === engineLine.trainedSide)) {
      throw new Error(`Duplicate ${engineLine.trainedSide} engine variant for ${source.id}`)
    }
    variants.push(engineLine)
    engineLinesBySource.set(source.id, variants)
  }

  const engineId = contentId('engine', {
    configuration: engineReport.configuration,
    engine: engineReport.engine,
  })
  const scidId = contentId('scid', { oracle: scidReport.oracle, sampling: scidReport.sampling })
  const provenanceByLine = new Map<string, Provenance>()
  for (const line of taxonomy.lines) {
    const value = {
      taxonomy: {
        repositoryUrl: taxonomyManifest.source.repositoryUrl,
        commit: taxonomyManifest.source.commit,
        license: 'CC0-1.0' as const,
        sourceFile: line.provenance.sourceFile,
        sourceRow: line.provenance.sourceRow,
        sourceSha256: line.provenance.sourceSha256,
        pulledAt: line.provenance.pulledAt,
      },
      corpusRef: 'corpus_lichess_broadcast_2020_01_2026_06' as const,
      engineRef: engineLinesBySource.has(line.id) ? engineId : null,
      crosscheckRef: scidResults.has(line.id) ? scidId : null,
    }
    provenanceByLine.set(line.id, { id: contentId('prov', value), ...value })
  }

  const verifiedBySource = new Map<string, VerifiedLine[]>()
  const allVerified: VerifiedLine[] = []
  for (const engineLine of engineReport.lines) {
    const source = taxonomyLines.get(engineLine.sourceLineId)!
    const terminal = terminals.get(source.id)
    if (!terminal || terminal.totalSampleSize !== engineLine.terminalSampleSize || terminal.totalSampleSize < 500) {
      throw new Error(`Engine line ${engineLine.id} has inconsistent terminal sample size`)
    }
    const decisionPlies = source.uci
      .map((_, ply) => ply)
      .filter((ply) => (engineLine.trainedSide === 'white') === (ply % 2 === 0))
    if (decisionPlies.length !== engineLine.nodes.length) {
      throw new Error(`Engine node count does not cover every ${engineLine.trainedSide} decision in ${source.id}`)
    }
    const provenance = provenanceByLine.get(source.id)!
    const nodes = engineLine.nodes.map((node, index) => {
      const ply = decisionPlies[index]!
      const sourcePosition = source.positions[ply]
      const expectedMoveUci = source.uci[ply]
      if (!sourcePosition || !expectedMoveUci) throw new Error(`Missing taxonomy node ${source.id}/${ply}`)
      const epd = normalizedEpd(new Chess(node.fen))
      if (epd !== sourcePosition.epd || node.expectedMoveUci !== expectedMoveUci) {
        throw new Error(`Engine node ${node.id} does not match taxonomy ply ${ply}`)
      }
      const position = positions.get(epd)
      if (!position) throw new Error(`Missing backtest position for ${node.id}`)
      const backtestMoves = new Map(position.moves.map((move) => [move.uci, move]))
      const moves = node.moves.map((move) => {
        const backtestMove = backtestMoves.get(move.moveUci)
        const emptyBands = Object.fromEntries(RATING_BANDS.map((band) => [band, { whiteWins: 0, draws: 0, blackWins: 0, n: 0 }])) as BandedRawOutcomes
        const bands = backtestMove?.bands ?? emptyBands
        const observedSample = totalOf(bands)
        if (move.sampleSize !== observedSample && move.sampleSize !== 0) {
          throw new Error(`Engine/game sample mismatch for ${node.id}/${move.moveUci}`)
        }
        return {
          uci: move.moveUci,
          san: sanFor(node.fen, move.moveUci),
          classification: move.classification,
          expected: move.moveUci === node.expectedMoveUci,
          acceptedBookTransposition: move.acceptedBookTransposition,
          sampleSize: observedSample,
          bands: bandArray(bands, engineLine.trainedSide),
          centipawnLoss: move.centipawnLoss,
          score: move.score,
          principalVariationUci: move.principalVariationUci,
          independentlyEngineAnalyzed: move.independentlyEngineAnalyzed,
        }
      })
      return {
        id: node.id,
        ply,
        epd,
        fen: node.fen,
        sideToMove: engineLine.trainedSide,
        expectedMoveUci: node.expectedMoveUci,
        nextNodeId: engineLine.nodes[index + 1]?.id ?? null,
        equivalentPositionLineIds: position.lineIds,
        moves,
        engine: {
          engineRef: engineId,
          bestMoveUci: node.bestMoveUci,
          bestScore: node.bestScore,
          expectedMoveCentipawnLoss: node.expectedMoveCentipawnLoss,
          topVariations: node.topVariations,
          analyzedAt: engineReport.generatedAt,
          quarantined: node.quarantined,
          quarantineReasons: node.quarantineReasons,
        },
        provenanceRef: provenance.id,
      }
    })
    const scid = scidResults.get(source.id)
    const quarantineReasons = [
      ...engineLine.quarantineReasons,
      ...(scid?.quarantined ? [scidQuarantineReason(scid)] : []),
    ]
    const quarantined = quarantineReasons.length > 0
    const verified = VerifiedLineSchema.parse({
      id: engineLine.id,
      sourceLineId: source.id,
      eco: source.eco,
      name: source.name,
      pgn: source.pgn,
      uci: source.uci,
      trainedSide: engineLine.trainedSide,
      terminalSampleSize: terminal.totalSampleSize,
      terminalStats: terminalBandArray(terminal, engineLine.trainedSide),
      drillEligible: !quarantined,
      insufficientBacktestSample: false,
      selectedForEngineVerification: true,
      quarantined,
      quarantineReasons,
      crosscheckStatus: scid?.status ?? 'not_sampled',
      nodes,
      provenanceRef: provenance.id,
    })
    allVerified.push(verified)
    const variants = verifiedBySource.get(source.id) ?? []
    variants.push(verified)
    verifiedBySource.set(source.id, variants)
  }

  await mkdir(join(options.outputDirectory, 'partitions'), { recursive: true })
  const sourceCatalog = new Map(taxonomy.catalog.entries.map((entry) => [entry.eco, entry]))
  const outputCatalog: OpeningCatalogEntry[] = []
  const sampleSizes: Array<Record<string, unknown>> = []
  for (const eco of sourceCatalog.keys()) {
    const lines = taxonomy.lines.filter((line) => line.eco === eco)
    const browsable = lines.map((line) => {
      const terminal = terminals.get(line.id)!
      const provenance = provenanceByLine.get(line.id)!
      const variants = (verifiedBySource.get(line.id) ?? []).sort((left, right) => left.trainedSide.localeCompare(right.trainedSide, 'en'))
      sampleSizes.push({
        sourceLineId: line.id,
        eco: line.eco,
        name: line.name,
        terminalSampleSize: terminal.totalSampleSize,
        drillThresholdMet: terminal.drillEligible,
        bands: Object.fromEntries(RATING_BANDS.map((band) => [band, terminal.bands[band].raw.n])),
      })
      return {
        sourceLineId: line.id,
        eco: line.eco,
        name: line.name,
        pgn: line.pgn,
        uci: line.uci,
        terminalSampleSize: terminal.totalSampleSize,
        terminalWhiteStats: terminalBandArray(terminal, 'white'),
        terminalBlackStats: terminalBandArray(terminal, 'black'),
        backtestEligible: terminal.drillEligible,
        verifiedVariantIds: variants.map((variant) => variant.id),
        provenanceRef: provenance.id,
      }
    })
    const verifiedLines = lines.flatMap((line) => verifiedBySource.get(line.id) ?? [])
    const partition: OpeningPartition = OpeningPartitionSchema.parse({
      schemaVersion: 1,
      eco,
      generatedAt: options.generatedAt,
      lines: browsable,
      verifiedLines,
    })
    const uncompressed = Buffer.from(`${JSON.stringify(partition)}\n`, 'utf8')
    const compressed = gzipSync(uncompressed, { level: 9 })
    await writeFile(join(options.outputDirectory, 'partitions', `${eco}.json.gz`), compressed)
    const sourceEntry = sourceCatalog.get(eco)!
    outputCatalog.push({
      eco: sourceEntry.eco,
      volume: sourceEntry.volume,
      lineCount: sourceEntry.lineCount,
      names: sourceEntry.names,
      drillableVariantCount: verifiedLines.filter((line) => line.drillEligible).length,
      partitionId: `eco_${eco}`,
      compressedBytes: compressed.byteLength,
      uncompressedBytes: uncompressed.byteLength,
      sha256: sha256(compressed),
    })
  }

  const search = {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    entries: taxonomy.lines.map((line) => ({
      sourceLineId: line.id,
      eco: line.eco,
      name: line.name,
      pgn: line.pgn,
      uci: line.uci,
      terminalEpd: line.epd,
      terminalSampleSize: terminals.get(line.id)!.totalSampleSize,
      backtestEligible: terminals.get(line.id)!.drillEligible,
      verifiedVariantIds: (verifiedBySource.get(line.id) ?? []).map((variant) => variant.id),
    })),
  }
  const searchUncompressed = Buffer.from(`${JSON.stringify(search)}\n`, 'utf8')
  const searchCompressed = gzipSync(searchUncompressed, { level: 9 })
  await writeFile(join(options.outputDirectory, 'search-index.json.gz'), searchCompressed)

  const nonMatches = scidReport.results.filter((result) => result.status !== 'match').length
  const manifest = DataManifestSchema.parse({
    schemaVersion: 1,
    product: 'LineRecall',
    generatedAt: options.generatedAt,
    releaseEligible: true,
    taxonomy: {
      repositoryUrl: taxonomyManifest.source.repositoryUrl,
      commit: taxonomyManifest.source.commit,
      license: 'CC0-1.0',
      totalLines: 3_790,
      ecoCodeCount: 500,
    },
    corpus: {
      license: 'CC BY-SA 4.0',
      licenseUrl: backtest.corpus.licenseUrl,
      startMonth: backtest.corpus.startMonth,
      cutoffMonth: backtest.corpus.cutoffMonth,
      pulledAt: backtest.generatedAt,
      archives: backtest.corpus.archives.map((archive) => ({
        month: archive.month,
        url: archive.url,
        sha256: archive.sha256,
      })),
      recordsSeen: backtest.totals.recordsSeen,
      accepted: backtest.totals.accepted,
      deduplicated: backtest.totals.deduplicated,
      rejected: backtest.totals.rejected,
      filtering: backtest.filtering,
      derivedDataNotice: 'Modified, aggregated opening statistics derived from the official Lichess broadcast database; distributed under CC BY-SA 4.0 with source links and change disclosure.',
    },
    engine: {
      id: engineId,
      name: engineReport.engine.name,
      releaseCommit: engineReport.configuration.releaseCommit,
      binarySha256: engineReport.engine.binarySha256,
      nnue: engineReport.engine.nnue.map(({ role, sha256: digest }) => ({ role, sha256: digest })),
      threads: 1,
      hashMb: 128,
      multiPv: 5,
      nodes: 250_000,
      analyzedAt: engineReport.generatedAt,
      license: 'GPL-3.0-only',
      shipped: false,
    },
    crosscheck: {
      id: scidId,
      repositoryCommit: scidReport.oracle.repositoryCommit,
      sha256: scidReport.oracle.sha256,
      license: 'GPL-2.0-only',
      sampled: scidReport.results.length,
      discrepancies: nonMatches,
      discrepancyIndex: scidReport.results
        .filter((result) => result.status !== 'match')
        .map((result) => ({
          lineId: result.lineId,
          taxonomyEco: result.taxonomyEco,
          taxonomyName: result.taxonomyName,
          status: result.status,
          quarantined: result.quarantined,
        })),
      oracleContentShipped: false,
    },
    audit: {
      browsableLines: 3_790,
      verifiedVariants: allVerified.length,
      drillableVariants: allVerified.filter((line) => line.drillEligible).length,
      quarantinedVariants: allVerified.filter((line) => line.quarantined).length,
      partitions: 500,
    },
    searchIndex: {
      compressedBytes: searchCompressed.byteLength,
      uncompressedBytes: searchUncompressed.byteLength,
      sha256: sha256(searchCompressed),
    },
    catalog: outputCatalog,
    provenance: taxonomy.lines.map((line) => provenanceByLine.get(line.id)!),
  })
  const manifestPath = join(options.outputDirectory, 'manifest.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8')
  await writeFile(
    join(options.outputDirectory, 'sample-sizes.json'),
    `${JSON.stringify({ schemaVersion: 1, generatedAt: options.generatedAt, lines: sampleSizes })}\n`,
    'utf8',
  )
  return {
    manifestPath,
    drillableVariants: manifest.audit.drillableVariants,
    verifiedVariants: manifest.audit.verifiedVariants,
  }
}

const generatedAt = argument('--generated-at', new Date().toISOString())
if (Number.isNaN(Date.parse(generatedAt))) throw new Error('--generated-at must be an ISO timestamp')
const result = await buildReleaseSnapshot({
  taxonomyDirectory: resolve(argument('--taxonomy', 'data/generated/taxonomy')),
  taxonomyManifestPath: resolve(argument('--taxonomy-manifest', 'data/manifests/taxonomy.source.json')),
  backtestPath: resolve(argument('--backtest', 'data/generated/broadcast-backtest.json')),
  engineReportPath: resolve(argument('--engine-report', 'data/generated/engine-analysis.json')),
  scidReportPath: resolve(argument('--scid-report', 'data/generated/scid-crosscheck.json')),
  stockfishManifestPath: resolve(argument('--stockfish-manifest', 'data/manifests/stockfish-18.source.json')),
  scidManifestPath: resolve(argument('--scid-manifest', 'data/manifests/scid.source.json')),
  outputDirectory: resolve(argument('--output', 'data/generated/release')),
  generatedAt: new Date(generatedAt).toISOString(),
})
process.stdout.write(
  `Built ${result.verifiedVariants} verified variants (${result.drillableVariants} drillable) at ${result.manifestPath}.\n`,
)

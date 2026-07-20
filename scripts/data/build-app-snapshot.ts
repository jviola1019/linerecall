import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { z } from 'zod'
import { DataManifestSchema } from '../../src/domain/opening-data.ts'
import {
  WireAppManifestSchema,
  WireEvidenceShardSchema,
  WireEvidenceSnapshotSchema,
  WirePartitionSchema,
  WireSearchSnapshotSchema,
  type WireAppManifest,
  type WireBlobReceipt,
  type WireEvidenceSnapshot,
  type WireEvidenceShard,
  type WirePartition,
  type WireSearchSnapshot,
} from '../../src/data/wire.ts'
import { TaxonomyPartitionSchema, type NormalizedTaxonomyLine } from '../../src/data/taxonomy-schema.ts'
import { RATING_BANDS, type BroadcastBacktestV1, type RawOutcomeCounts } from './broadcast-contracts.ts'

const EngineReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  engine: z.object({ name: z.string(), binarySha256: z.string().regex(/^[a-f0-9]{64}$/u) }).passthrough(),
  configuration: z.object({ nodes: z.literal(250_000) }).passthrough(),
  lines: z.array(z.object({
    id: z.string(), sourceLineId: z.string(), trainedSide: z.enum(['white', 'black']),
    quarantineReasons: z.array(z.string()), quarantined: z.boolean(),
    nodes: z.array(z.object({
      id: z.string(), fen: z.string(), expectedMoveUci: z.string(), bestMoveUci: z.string(),
      bestScore: z.object({ kind: z.enum(['centipawn', 'mate']), value: z.number().int() }).strict(),
      topVariations: z.array(z.object({
        multipv: z.number().int(), depth: z.number().int().nullable(), selectiveDepth: z.number().int().nullable(),
        nodes: z.number().int().nullable(), score: z.object({ kind: z.enum(['centipawn', 'mate']), value: z.number().int() }).strict(),
        bound: z.enum(['exact', 'lower', 'upper']), movesUci: z.array(z.string()),
      }).strict()),
      moves: z.array(z.object({
        moveUci: z.string(), score: z.object({ kind: z.enum(['centipawn', 'mate']), value: z.number().int() }).strict().nullable(),
        principalVariationUci: z.array(z.string()),
        sampleSize: z.number().int().nonnegative(),
        acceptedBookTransposition: z.boolean(),
        classification: z.enum(['book', 'playable', 'inaccuracy', 'mistake', 'unverified_deviation']),
        centipawnLoss: z.number().int().nonnegative().nullable(),
        independentlyEngineAnalyzed: z.boolean(),
      }).passthrough()),
      expectedMoveCentipawnLoss: z.number().int().nonnegative(),
      quarantined: z.boolean(),
      quarantineReasons: z.array(z.string()),
    }).passthrough()),
  }).passthrough()),
}).passthrough()

const ScidReportSchema = z.object({
  schemaVersion: z.literal(1),
  results: z.array(z.object({
    lineId: z.string(), status: z.enum(['match', 'naming_difference', 'missing_oracle_entry', 'base_eco_mismatch', 'ambiguous_oracle_base']),
    quarantined: z.boolean(), oracleBaseEcos: z.array(z.string()),
  }).passthrough()),
}).passthrough()

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing option ${name}`)
  return resolve(value)
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function counts(rawBands: Record<string, RawOutcomeCounts>): number[] {
  return RATING_BANDS.flatMap((band) => {
    const raw = rawBands[band]
    if (!raw || raw.whiteWins + raw.draws + raw.blackWins !== raw.n) throw new Error(`Invalid raw counts for ${band}`)
    return [raw.whiteWins, raw.draws, raw.blackWins]
  })
}

function score(scoreValue: { kind: 'centipawn' | 'mate'; value: number }): [0 | 1, number] {
  return [scoreValue.kind === 'centipawn' ? 0 : 1, scoreValue.value]
}

async function loadTaxonomy(directory: string): Promise<NormalizedTaxonomyLine[]> {
  const files = (await readdir(join(directory, 'partitions')))
    .filter((file) => /^[A-E]\d{2}\.json$/u.test(file))
    .sort()
  if (files.length !== 500) throw new Error(`Expected 500 taxonomy partitions, found ${files.length}`)
  const lines: NormalizedTaxonomyLine[] = []
  for (const file of files) {
    lines.push(...TaxonomyPartitionSchema.parse(await readJson(join(directory, 'partitions', file))).lines)
  }
  if (lines.length !== 3_790) throw new Error(`Expected 3,790 taxonomy lines, found ${lines.length}`)
  return lines
}

async function writeGzip(
  outputDirectory: string,
  relativePath: string,
  value: unknown,
): Promise<WireBlobReceipt> {
  const path = join(outputDirectory, ...relativePath.split('/'))
  const uncompressed = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  const compressed = gzipSync(uncompressed, { level: 9 })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, compressed)
  return {
    path: relativePath,
    compressedBytes: compressed.byteLength,
    uncompressedBytes: uncompressed.byteLength,
    sha256: sha256(compressed),
  }
}

function crosscheckReason(result: z.infer<typeof ScidReportSchema>['results'][number]): string {
  return `Scid cross-check ${result.status}; oracle base ECO values: ${result.oracleBaseEcos.join(', ') || 'none'}`
}

export async function buildAppSnapshot(options: {
  taxonomyDirectory: string
  backtestPath: string
  engineReportPath: string
  scidReportPath: string
  auditManifestPath: string
  outputDirectory: string
}): Promise<WireAppManifest> {
  const [lines, rawBacktest, engineReport, scidReport, auditManifest] = await Promise.all([
    loadTaxonomy(options.taxonomyDirectory),
    readJson(options.backtestPath),
    readJson(options.engineReportPath).then((value) => EngineReportSchema.parse(value)),
    readJson(options.scidReportPath).then((value) => ScidReportSchema.parse(value)),
    readJson(options.auditManifestPath).then((value) => DataManifestSchema.parse(value)),
  ])
  const backtest = rawBacktest as BroadcastBacktestV1
  if (backtest.positions?.length !== 7_824 || backtest.terminalLines?.length !== 3_790) {
    throw new Error('Compact snapshot requires the complete validated backtest')
  }
  if (
    engineReport.generatedAt !== auditManifest.engine.analyzedAt ||
    engineReport.engine.name !== auditManifest.engine.name ||
    engineReport.engine.binarySha256 !== auditManifest.engine.binarySha256 ||
    engineReport.configuration.nodes !== auditManifest.engine.nodes ||
    engineReport.lines.length !== auditManifest.audit.verifiedVariants ||
    scidReport.results.length !== auditManifest.crosscheck.sampled
  ) throw new Error('Compact snapshot inputs do not match the audited release manifest')
  const lineIndex = new Map(lines.map((line, index) => [line.id, index]))
  const positionIndex = new Map(backtest.positions.map((position, index) => [position.epd, index]))
  const terminalByLine = new Map(backtest.terminalLines.map((terminal) => [terminal.lineId, terminal]))
  if (
    lineIndex.size !== lines.length ||
    positionIndex.size !== backtest.positions.length ||
    terminalByLine.size !== backtest.terminalLines.length
  ) throw new Error('Compact snapshot inputs contain duplicate line or position identities')
  const provenanceBySource = new Map(
    auditManifest.provenance.map((provenance) => [
      `${provenance.taxonomy.sourceFile}:${provenance.taxonomy.sourceRow}`,
      provenance.id,
    ]),
  )
  const searchLines: WireSearchSnapshot['l'] = lines.map((line) => {
    const terminal = terminalByLine.get(line.id)
    const provenanceRef = provenanceBySource.get(`${line.provenance.sourceFile}:${line.provenance.sourceRow}`)
    if (!terminal || !positionIndex.has(line.epd) || !provenanceRef) throw new Error(`Missing compact line evidence for ${line.id}`)
    return [line.id, line.eco, line.name, line.pgn, line.uci.join(' '), line.epd, terminal.totalSampleSize, provenanceRef]
  })
  const catalog: WireSearchSnapshot['c'] = []
  for (let start = 0; start < lines.length;) {
    const eco = lines[start]!.eco
    let end = start + 1
    while (end < lines.length && lines[end]!.eco === eco) end += 1
    catalog.push([eco, start, end - start])
    start = end
  }
  const bookMoves = new Map<string, Map<string, Set<number>>>()
  for (const [index, line] of lines.entries()) {
    for (let ply = 0; ply < line.uci.length; ply += 1) {
      const epd = line.positions[ply]?.epd
      const move = line.uci[ply]
      if (!epd || !move) throw new Error(`Incomplete taxonomy path ${line.id}/${ply}`)
      const atPosition = bookMoves.get(epd) ?? new Map<string, Set<number>>()
      const lineIndexes = atPosition.get(move) ?? new Set<number>()
      lineIndexes.add(index)
      atPosition.set(move, lineIndexes)
      bookMoves.set(epd, atPosition)
    }
  }
  const wirePositions: WireEvidenceSnapshot['p'] = backtest.positions.map((position) => [
    position.epd,
    position.lineIds.map((id) => {
      const index = lineIndex.get(id)
      if (index === undefined) throw new Error(`Unknown position line ${id}`)
      return index
    }),
    counts(position.bands),
    position.moves.map((move) => [move.uci, counts(move.bands)]),
    [...(bookMoves.get(position.epd) ?? new Map()).entries()]
      .map(([uci, indexes]) => [uci, [...indexes].sort((a, b) => a - b)] as [string, number[]])
      .sort((left, right) => left[0].localeCompare(right[0], 'en')),
  ])

  type EnginePosition = WireEvidenceSnapshot['e'][number]
  const engineByFen = new Map<string, {
    bestMove: string
    bestScore: [0 | 1, number]
    variations: EnginePosition[3]
    moves: Map<string, EnginePosition[4][number]>
  }>()
  for (const line of engineReport.lines) {
    for (const node of line.nodes) {
      const variations: EnginePosition[3] = node.topVariations.map((variation) => [
        variation.multipv,
        variation.depth,
        variation.selectiveDepth,
        variation.nodes,
        score(variation.score),
        variation.bound === 'exact' ? 0 : variation.bound === 'lower' ? 1 : 2,
        variation.movesUci.join(' '),
      ])
      let entry = engineByFen.get(node.fen)
      if (!entry) {
        entry = { bestMove: node.bestMoveUci, bestScore: score(node.bestScore), variations, moves: new Map() }
        engineByFen.set(node.fen, entry)
      } else if (
        entry.bestMove !== node.bestMoveUci ||
        JSON.stringify(entry.bestScore) !== JSON.stringify(score(node.bestScore)) ||
        JSON.stringify(entry.variations) !== JSON.stringify(variations)
      ) throw new Error(`Conflicting cached engine root analysis for ${node.fen}`)
      for (const move of node.moves) {
        const candidate: EnginePosition[4][number] = [
          move.moveUci,
          move.score ? score(move.score) : null,
          move.principalVariationUci.join(' '),
        ]
        const prior = entry.moves.get(move.moveUci)
        if (!prior || (prior[1] === null && candidate[1] !== null)) entry.moves.set(move.moveUci, candidate)
        else if (
          prior[1] !== null && candidate[1] !== null &&
          (JSON.stringify(prior[1]) !== JSON.stringify(candidate[1]) || prior[2] !== candidate[2])
        ) throw new Error(`Conflicting cached engine move analysis for ${node.fen}/${move.moveUci}`)
      }
    }
  }
  const sortedEngineEntries = [...engineByFen.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))
  const engineIndex = new Map(sortedEngineEntries.map(([fen], index) => [fen, index]))
  const wireEngine: WireEvidenceSnapshot['e'] = sortedEngineEntries.map(([fen, entry]) => [
    fen,
    entry.bestMove,
    entry.bestScore,
    entry.variations,
    [...entry.moves.values()].sort((left, right) => left[0].localeCompare(right[0], 'en')),
  ])
  const evidence = WireEvidenceSnapshotSchema.parse({ v: 1, g: auditManifest.generatedAt, p: wirePositions, e: wireEngine })
  const graph = wirePositions
    .filter((position) => position[4].length > 0)
    .map((position) => [position[0], position[4]] as WireSearchSnapshot['q'][number])

  const scidByLine = new Map(scidReport.results.map((result) => [result.lineId, result]))
  if (scidByLine.size !== scidReport.results.length) throw new Error('Compact snapshot has duplicate Scid results')
  const crossCodes = new Map([
    ['match', 0], ['naming_difference', 1], ['missing_oracle_entry', 2],
    ['base_eco_mismatch', 3], ['ambiguous_oracle_base', 4],
  ])
  const variantsByEco = new Map<string, WirePartition['x']>()
  const variantSummaries: WireSearchSnapshot['x'] = []
  const variantIds = new Set<string>()
  for (const line of engineReport.lines) {
    if (variantIds.has(line.id)) throw new Error(`Duplicate engine variant ${line.id}`)
    variantIds.add(line.id)
    if (line.quarantined !== (line.quarantineReasons.length > 0)) {
      throw new Error(`Engine variant ${line.id} has inconsistent quarantine state`)
    }
    const sourceIndex = lineIndex.get(line.sourceLineId)
    if (sourceIndex === undefined) throw new Error(`Unknown engine source line ${line.sourceLineId}`)
    const source = lines[sourceIndex]
    if (!source) throw new Error(`Unknown engine source line ${line.sourceLineId}`)
    const scid = scidByLine.get(source.id)
    const quarantineReasons = [
      ...line.quarantineReasons,
      ...(scid?.quarantined ? [crosscheckReason(scid)] : []),
    ]
    const nodes: WirePartition['x'][number][6] = line.nodes.map((node) => {
      const plyMatch = /:ply-(\d+)$/u.exec(node.id)
      const ply = Number(plyMatch?.[1])
      const enginePositionIndex = engineIndex.get(node.fen)
      const epd = source.positions[ply]?.epd
      const backtestPositionIndex = epd === undefined ? undefined : positionIndex.get(epd)
      if (!Number.isSafeInteger(ply) || enginePositionIndex === undefined || backtestPositionIndex === undefined) {
        throw new Error(`Could not index compact node ${node.id}`)
      }
      if (
        node.id !== `${line.id}:ply-${ply}` ||
        source.uci[ply] !== node.expectedMoveUci ||
        ((ply % 2 === 0) !== (line.trainedSide === 'white')) ||
        node.quarantined !== (node.quarantineReasons.length > 0)
      ) throw new Error(`Compact node ${node.id} does not match its audited source decision`)
      const expected = node.moves.filter((move) => move.moveUci === node.expectedMoveUci)
      if (expected.length !== 1 || expected[0]!.centipawnLoss !== node.expectedMoveCentipawnLoss) {
        throw new Error(`Compact node ${node.id} has inconsistent expected-move evidence`)
      }
      const moveIds = new Set<string>()
      const moves = node.moves.map((move): WirePartition['x'][number][6][number][5][number] => {
        if (moveIds.has(move.moveUci)) throw new Error(`Compact node ${node.id} has duplicate move ${move.moveUci}`)
        moveIds.add(move.moveUci)
        if (move.independentlyEngineAnalyzed !== (move.score !== null)) {
          throw new Error(`Compact node ${node.id}/${move.moveUci} has inconsistent engine evidence`)
        }
        const classification = {
          book: 0,
          playable: 1,
          inaccuracy: 2,
          mistake: 3,
          unverified_deviation: 4,
        } as const
        const flags = (move.acceptedBookTransposition ? 1 : 0) + (move.independentlyEngineAnalyzed ? 2 : 0)
        return [move.moveUci, flags, classification[move.classification], move.centipawnLoss]
      })
      return [node.id, ply, enginePositionIndex, backtestPositionIndex, node.quarantineReasons, moves]
    })
    const crossCode = scid ? crossCodes.get(scid.status) : 5
    if (crossCode === undefined) throw new Error(`Unknown Scid status for ${source.id}`)
    const variant: WirePartition['x'][number] = [
      line.id,
      sourceIndex,
      line.trainedSide === 'white' ? 0 : 1,
      quarantineReasons.length === 0 ? 1 : 0,
      quarantineReasons,
      crossCode,
      nodes,
    ]
    const variants = variantsByEco.get(source.eco) ?? []
    variants.push(variant)
    variantsByEco.set(source.eco, variants)
    if (variant[3] === 1) {
      variantSummaries.push([line.id, sourceIndex, variant[2], nodes.length])
    }
  }
  variantSummaries.sort((left, right) => left[0].localeCompare(right[0], 'en'))
  if (variantSummaries.length !== auditManifest.audit.drillableVariants) {
    throw new Error('Compact variant summaries do not match the audited drillable total')
  }
  const search = WireSearchSnapshotSchema.parse({
    v: 2,
    g: auditManifest.generatedAt,
    l: searchLines,
    c: catalog,
    x: variantSummaries,
    q: graph,
  })

  await mkdir(join(options.outputDirectory, 'partitions'), { recursive: true })
  // Version 2 deliberately has no global evidence blob. Remove a stale v1
  // output so generated snapshots cannot be mistaken for eager-load data.
  await rm(join(options.outputDirectory, 'evidence.json.gz'), { force: true })
  const searchReceipt = await writeGzip(options.outputDirectory, 'search.json.gz', search)
  const auditReceipt = await writeGzip(options.outputDirectory, 'audit.json.gz', auditManifest)
  const provenanceById = new Map(auditManifest.provenance.map((entry) => [entry.id, entry]))
  interface PartitionDraft {
    eco: string
    globalLineIndexes: number[]
    variants: WirePartition['x']
    positionIndexes: number[]
    engineIndexes: number[]
  }
  const drafts: PartitionDraft[] = []
  const positionConsumers = new Map<number, Set<string>>()
  const engineConsumers = new Map<number, Set<string>>()
  const addConsumer = (map: Map<number, Set<string>>, index: number, eco: string): void => {
    const consumers = map.get(index) ?? new Set<string>()
    consumers.add(eco)
    map.set(index, consumers)
  }
  for (const [eco, start, count] of catalog) {
    const globalLineIndexes = Array.from({ length: count }, (_, index) => start + index)
    const variants = (variantsByEco.get(eco) ?? []).sort((left, right) => left[0].localeCompare(right[0], 'en'))
    const positions = new Set<number>()
    const engines = new Set<number>()
    for (const lineIndexValue of globalLineIndexes) {
      const terminalEpd = searchLines[lineIndexValue]?.[5]
      const terminalPositionIndex = terminalEpd === undefined ? undefined : positionIndex.get(terminalEpd)
      if (terminalPositionIndex === undefined) throw new Error(`Missing terminal position for compact partition ${eco}`)
      positions.add(terminalPositionIndex)
    }
    for (const variant of variants) {
      for (const node of variant[6]) {
        engines.add(node[2])
        positions.add(node[3])
      }
    }
    const positionIndexes = [...positions].sort((left, right) => left - right)
    const engineIndexes = [...engines].sort((left, right) => left - right)
    for (const index of positionIndexes) addConsumer(positionConsumers, index, eco)
    for (const index of engineIndexes) addConsumer(engineConsumers, index, eco)
    drafts.push({ eco, globalLineIndexes, variants, positionIndexes, engineIndexes })
  }

  interface ShardDraft {
    id: string
    consumers: string[]
    positions: number[]
    engines: number[]
  }
  const shardByConsumerKey = new Map<string, ShardDraft>()
  const shardIdByConsumerKey = new Map<string, string>()
  const shardForConsumers = (consumers: ReadonlySet<string>): ShardDraft => {
    const ordered = [...consumers].sort((left, right) => left.localeCompare(right, 'en'))
    const key = ordered.join(',')
    const existing = shardByConsumerKey.get(key)
    if (existing) return existing
    const id = `s_${sha256(Buffer.from(key, 'utf8')).slice(0, 16)}`
    if ([...shardByConsumerKey.values()].some((shard) => shard.id === id)) {
      throw new Error(`Evidence shard ID collision for consumer set ${key}`)
    }
    const created = { id, consumers: ordered, positions: [], engines: [] }
    shardByConsumerKey.set(key, created)
    shardIdByConsumerKey.set(key, id)
    return created
  }
  for (const [index, consumers] of positionConsumers) shardForConsumers(consumers).positions.push(index)
  for (const [index, consumers] of engineConsumers) shardForConsumers(consumers).engines.push(index)

  await rm(join(options.outputDirectory, 'shards'), { recursive: true, force: true })
  await mkdir(join(options.outputDirectory, 'shards'), { recursive: true })
  const shardReceipts: Record<string, WireBlobReceipt> = {}
  for (const shard of [...shardByConsumerKey.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
    shard.positions.sort((left, right) => left - right)
    shard.engines.sort((left, right) => left - right)
    const value: WireEvidenceShard = WireEvidenceShardSchema.parse({
      v: 2,
      g: auditManifest.generatedAt,
      s: shard.id,
      c: shard.consumers,
      p: shard.positions.map((index) => [index, evidence.p[index]]),
      a: shard.engines.map((index) => [index, evidence.e[index]]),
    })
    shardReceipts[shard.id] = await writeGzip(
      options.outputDirectory,
      `shards/${shard.id}.json.gz`,
      value,
    )
  }

  const positionShard = new Map<number, string>()
  const engineShard = new Map<number, string>()
  for (const [index, consumers] of positionConsumers) {
    positionShard.set(index, shardIdByConsumerKey.get([...consumers].sort((a, b) => a.localeCompare(b, 'en')).join(','))!)
  }
  for (const [index, consumers] of engineConsumers) {
    engineShard.set(index, shardIdByConsumerKey.get([...consumers].sort((a, b) => a.localeCompare(b, 'en')).join(','))!)
  }

  const partitionReceipts: Record<string, WireBlobReceipt> = {}
  const selectedEvidenceLoads: Array<{ eco: string; shards: number; compressedBytes: number; uncompressedBytes: number }> = []
  for (const draft of drafts) {
    const partitionLines: WirePartition['l'] = draft.globalLineIndexes.map((globalIndex) => {
      const terminalEpd = searchLines[globalIndex]?.[5]
      const globalTerminalIndex = terminalEpd === undefined ? undefined : positionIndex.get(terminalEpd)
      if (globalTerminalIndex === undefined) throw new Error(`Missing terminal position for compact line ${globalIndex}`)
      return [globalIndex, globalTerminalIndex]
    })
    const provenanceIds = draft.globalLineIndexes.map((globalIndex) => searchLines[globalIndex]?.[7])
    const provenance = provenanceIds.map((id) => {
      const entry = id === undefined ? undefined : provenanceById.get(id)
      if (!entry) throw new Error(`Missing provenance for compact partition ${draft.eco}`)
      return entry
    })
    const shardIds = [...new Set([
      ...draft.positionIndexes.map((index) => positionShard.get(index)),
      ...draft.engineIndexes.map((index) => engineShard.get(index)),
    ])].map((id) => {
      if (!id) throw new Error(`Missing evidence shard for compact partition ${draft.eco}`)
      return id
    }).sort((left, right) => left.localeCompare(right, 'en'))
    const selectedReceipts = shardIds.map((id) => shardReceipts[id]!)
    selectedEvidenceLoads.push({
      eco: draft.eco,
      shards: shardIds.length,
      compressedBytes: selectedReceipts.reduce((sum, receipt) => sum + receipt.compressedBytes, 0),
      uncompressedBytes: selectedReceipts.reduce((sum, receipt) => sum + receipt.uncompressedBytes, 0),
    })
    const partition = WirePartitionSchema.parse({
      v: 2,
      g: auditManifest.generatedAt,
      e: draft.eco,
      l: partitionLines,
      s: shardIds,
      m: auditManifest.engine,
      r: provenance,
      x: draft.variants,
    })
    partitionReceipts[draft.eco] = await writeGzip(
      options.outputDirectory,
      `partitions/${draft.eco}.json.gz`,
      partition,
    )
  }
  const receipts = [searchReceipt, auditReceipt, ...Object.values(shardReceipts), ...Object.values(partitionReceipts)]
  const totalCompressedBytes = receipts.reduce((sum, receipt) => sum + receipt.compressedBytes, 0)
  const maximumSelected = selectedEvidenceLoads.reduce((maximum, candidate) =>
    candidate.compressedBytes > maximum.compressedBytes ? candidate : maximum)
  const manifest = WireAppManifestSchema.parse({
    v: 2,
    g: auditManifest.generatedAt,
    schema: 'linerecall-app-wire-v2',
    blobs: { search: searchReceipt, audit: auditReceipt },
    shards: shardReceipts,
    partitions: partitionReceipts,
    totals: {
      lines: lines.length,
      positions: wirePositions.length,
      enginePositions: wireEngine.length,
      variants: engineReport.lines.length,
      shards: Object.keys(shardReceipts).length,
      maxSelectedEcoShards: Math.max(...selectedEvidenceLoads.map((entry) => entry.shards)),
      maxSelectedEcoCompressedBytes: maximumSelected.compressedBytes,
      maxSelectedEcoUncompressedBytes: Math.max(...selectedEvidenceLoads.map((entry) => entry.uncompressedBytes)),
      partitions: Object.keys(partitionReceipts).length,
      compressedBytes: totalCompressedBytes,
      estimatedBase64Bytes: receipts.reduce(
        (sum, receipt) => sum + Math.ceil(receipt.compressedBytes / 3) * 4,
        0,
      ),
    },
  })
  await writeFile(join(options.outputDirectory, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8')
  return manifest
}

const manifest = await buildAppSnapshot({
  taxonomyDirectory: option('--taxonomy', 'data/generated/taxonomy'),
  backtestPath: option('--backtest', 'data/generated/broadcast-backtest.json'),
  engineReportPath: option('--engine-report', 'data/generated/engine-analysis.json'),
  scidReportPath: option('--scid-report', 'data/generated/scid-crosscheck.json'),
  auditManifestPath: option('--audit-manifest', 'data/generated/release/manifest.json'),
  outputDirectory: option('--output', 'data/generated/app-snapshot'),
})
process.stdout.write(`Compact app snapshot built: ${JSON.stringify(manifest.totals)}\n`)

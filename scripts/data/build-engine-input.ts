import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Chess } from 'chess.js'
import { EngineAnalysisInputSchema, type CandidateMoveInput } from '../../src/data/verification/contracts.ts'
import { TaxonomyPartitionSchema, type NormalizedTaxonomyLine } from '../../src/data/taxonomy-schema.ts'
import {
  RATING_BANDS,
  type BroadcastBacktestV1,
  type PositionBacktest,
  type TerminalLineBacktest,
} from './broadcast-contracts.ts'

function requiredArgument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing required argument ${name}`)
  return resolve(value)
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function totalSample(bands: PositionBacktest['bands']): number {
  return RATING_BANDS.reduce((sum, band) => sum + bands[band].n, 0)
}

function fenFor(epd: string, ply: number): string {
  const fen = `${epd} 0 ${Math.floor(ply / 2) + 1}`
  // Normalize and reject malformed position data before it reaches the engine.
  return new Chess(fen).fen()
}

async function loadTaxonomyLines(directory: string): Promise<NormalizedTaxonomyLine[]> {
  const partitionsDirectory = join(directory, 'partitions')
  const files = (await readdir(partitionsDirectory)).filter((name) => /^[A-E]\d{2}\.json$/u.test(name)).sort()
  if (files.length !== 500) throw new Error(`Expected 500 taxonomy partitions, found ${files.length}`)
  const lines: NormalizedTaxonomyLine[] = []
  for (const file of files) {
    const partition = TaxonomyPartitionSchema.parse(await readJson(join(partitionsDirectory, file)))
    lines.push(...partition.lines)
  }
  if (lines.length !== 3_790) throw new Error(`Expected 3,790 taxonomy lines, found ${lines.length}`)
  return lines
}

function assertBacktest(value: unknown): asserts value is BroadcastBacktestV1 {
  if (typeof value !== 'object' || value === null) throw new Error('Backtest must be an object')
  const backtest = value as Partial<BroadcastBacktestV1>
  if (backtest.schemaVersion !== 1 || backtest.completeCorpus !== true) {
    throw new Error('Engine input requires a complete schema-v1 corpus backtest')
  }
  if (backtest.corpus?.everyArchiveSha256Verified !== true || backtest.corpus.archives.length !== 78) {
    throw new Error('Engine input requires all 78 checksum-verified archives')
  }
  if (!Array.isArray(backtest.positions) || !Array.isArray(backtest.terminalLines)) {
    throw new Error('Backtest positions or terminal lines are missing')
  }
}

export async function buildEngineInput(options: {
  taxonomyDirectory: string
  backtestPath: string
  outputPath: string
}): Promise<{ lineVariants: number; sourceLines: number }> {
  const [lines, untrustedBacktest] = await Promise.all([
    loadTaxonomyLines(options.taxonomyDirectory),
    readJson(options.backtestPath),
  ])
  assertBacktest(untrustedBacktest)
  const backtest = untrustedBacktest
  const taxonomyCommit = lines[0]?.provenance.sourceCommit
  if (!taxonomyCommit || backtest.taxonomyCommit !== taxonomyCommit) {
    throw new Error('Taxonomy and backtest commits do not match')
  }
  const positions = new Map(backtest.positions.map((position) => [position.epd, position]))
  const terminals = new Map(backtest.terminalLines.map((terminal) => [terminal.lineId, terminal]))
  if (terminals.size !== lines.length) throw new Error('Every taxonomy line must have exactly one terminal backtest')

  const expectedMovesAtPosition = new Map<string, Set<string>>()
  for (const line of lines) {
    for (let ply = 0; ply < line.uci.length; ply += 1) {
      const epd = line.positions[ply]?.epd
      const move = line.uci[ply]
      if (!epd || !move) throw new Error(`Incomplete taxonomy path for ${line.id}`)
      const expected = expectedMovesAtPosition.get(epd) ?? new Set<string>()
      expected.add(move)
      expectedMovesAtPosition.set(epd, expected)
    }
  }

  const outputLines: Array<{
    id: string
    sourceLineId: string
    eco: string
    name: string
    trainedSide: 'white' | 'black'
    terminalSampleSize: number
    drillEligible: boolean
    preexistingQuarantineReasons: string[]
    decisionNodes: Array<{
      id: string
      fen: string
      expectedMoveUci: string
      candidateMoves: CandidateMoveInput[]
    }>
  }> = []
  let eligibleSourceLines = 0
  for (const line of lines) {
    const terminal = terminals.get(line.id) as TerminalLineBacktest | undefined
    if (!terminal) throw new Error(`Missing terminal backtest for ${line.id}`)
    const terminalSampleSize = terminal.totalSampleSize
    if (terminalSampleSize >= 500 && terminal.drillEligible) eligibleSourceLines += 1
    for (const trainedSide of ['white', 'black'] as const) {
      const decisionNodes = []
      for (let ply = 0; ply < line.uci.length; ply += 1) {
        const isWhiteTurn = ply % 2 === 0
        if ((trainedSide === 'white') !== isWhiteTurn) continue
        const positionPath = line.positions[ply]
        const expectedMoveUci = line.uci[ply]
        if (!positionPath || !expectedMoveUci) throw new Error(`Incomplete decision node for ${line.id}`)
        const backtestPosition = positions.get(positionPath.epd)
        if (!backtestPosition) throw new Error(`Missing position backtest for ${line.id} ply ${ply}`)
        const knownBookMoves = expectedMovesAtPosition.get(positionPath.epd) ?? new Set<string>()
        const candidates = backtestPosition.moves.map((move): CandidateMoveInput => ({
          moveUci: move.uci,
          sampleSize: totalSample(move.bands),
          acceptedBookTransposition: move.uci !== expectedMoveUci && knownBookMoves.has(move.uci),
        }))
        if (!candidates.some((candidate) => candidate.moveUci === expectedMoveUci)) {
          candidates.push({ moveUci: expectedMoveUci, sampleSize: 0, acceptedBookTransposition: false })
        }
        candidates.sort((left, right) => right.sampleSize - left.sampleSize || left.moveUci.localeCompare(right.moveUci))
        const retained = candidates.slice(0, 128)
        if (!retained.some((candidate) => candidate.moveUci === expectedMoveUci)) {
          retained[retained.length - 1] = candidates.find((candidate) => candidate.moveUci === expectedMoveUci)!
        }
        decisionNodes.push({
          id: `${line.id}:${trainedSide}:ply-${ply}`,
          fen: fenFor(positionPath.epd, ply),
          expectedMoveUci,
          candidateMoves: retained,
        })
      }
      if (decisionNodes.length === 0) continue
      outputLines.push({
        id: `${line.id}:${trainedSide}`,
        sourceLineId: line.id,
        eco: line.eco,
        name: line.name,
        trainedSide,
        terminalSampleSize,
        drillEligible: terminal.drillEligible,
        preexistingQuarantineReasons: [],
        decisionNodes,
      })
    }
  }
  const output = EngineAnalysisInputSchema.parse({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    lines: outputLines,
  })
  await mkdir(dirname(options.outputPath), { recursive: true })
  await writeFile(options.outputPath, `${JSON.stringify(output)}\n`, 'utf8')
  return { lineVariants: outputLines.length, sourceLines: eligibleSourceLines }
}

const result = await buildEngineInput({
  taxonomyDirectory: requiredArgument('--taxonomy', 'data/generated/taxonomy'),
  backtestPath: requiredArgument('--backtest', 'data/generated/broadcast-backtest.json'),
  outputPath: requiredArgument('--output', 'data/generated/engine-input.json'),
})
process.stdout.write(`Prepared ${result.lineVariants} side-specific variants; ${result.sourceLines} source lines meet N>=500.\n`)

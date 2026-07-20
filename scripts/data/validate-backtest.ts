import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import {
  BROADCAST_PUBLISHED_GAME_TOTAL,
  RATING_BANDS,
  assertBroadcastManifestApproved,
  assertBroadcastTargetIndex,
  type BroadcastBacktestV1,
  type RawOutcomeCounts,
} from './broadcast-contracts.ts'
import { normalizedEpd } from './broadcast-pgn.ts'

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing option ${name}`)
  return resolve(value)
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

function assertBacktest(value: unknown): asserts value is BroadcastBacktestV1 {
  if (typeof value !== 'object' || value === null) throw new Error('Backtest must be an object')
  const candidate = value as Partial<BroadcastBacktestV1>
  if (
    candidate.schemaVersion !== 1 ||
    candidate.completeCorpus !== true ||
    candidate.releaseEligible !== false ||
    candidate.corpus?.everyArchiveSha256Verified !== true ||
    !Array.isArray(candidate.positions) ||
    !Array.isArray(candidate.terminalLines)
  ) throw new Error('Backtest does not represent the complete pre-release corpus stage')
}

function assertRaw(raw: RawOutcomeCounts, label: string): void {
  if (
    !Number.isSafeInteger(raw.n) || raw.n < 0 ||
    !Number.isSafeInteger(raw.whiteWins) || raw.whiteWins < 0 ||
    !Number.isSafeInteger(raw.draws) || raw.draws < 0 ||
    !Number.isSafeInteger(raw.blackWins) || raw.blackWins < 0 ||
    raw.whiteWins + raw.draws + raw.blackWins !== raw.n
  ) throw new Error(`${label} has inconsistent W/D/L counts`)
}

function percentage(value: number, n: number): number | null {
  return n === 0 ? null : Math.round((value / n) * 10_000) / 100
}

function moveParts(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

export async function validateBacktest(options: {
  backtestPath: string
  manifestPath: string
  targetsPath: string
  reportPath: string
}): Promise<Record<string, unknown>> {
  const [backtestBytes, backtestValue, manifestValue, targetsValue] = await Promise.all([
    readFile(options.backtestPath),
    readJson(options.backtestPath),
    readJson(options.manifestPath),
    readJson(options.targetsPath),
  ])
  assertBacktest(backtestValue)
  assertBroadcastManifestApproved(manifestValue)
  assertBroadcastTargetIndex(targetsValue)
  const backtest = backtestValue
  const manifest = manifestValue
  const targets = targetsValue
  if (backtest.taxonomyCommit !== targets.taxonomyCommit) throw new Error('Taxonomy commit mismatch')
  if (
    backtest.corpus.archives.length !== manifest.archives.length ||
    backtest.corpus.archives.some((archive, index) => {
      const approved = manifest.archives[index]
      return !approved || archive.month !== approved.month || archive.url !== approved.url || archive.sha256 !== approved.sha256
    })
  ) throw new Error('Backtest archives do not exactly match the approved manifest')
  const rejectedTotal = Object.values(backtest.totals.rejected).reduce((sum, count) => sum + count, 0)
  if (
    backtest.totals.recordsSeen !== BROADCAST_PUBLISHED_GAME_TOTAL ||
    backtest.totals.accepted + backtest.totals.deduplicated + rejectedTotal !== backtest.totals.recordsSeen
  ) throw new Error('Corpus totals do not reconcile to the official published total')

  const targetByEpd = new Map(targets.targets.map((target) => [target.epd, target]))
  const positionByEpd = new Map(backtest.positions.map((position) => [position.epd, position]))
  if (targetByEpd.size !== targets.targets.length || positionByEpd.size !== targetByEpd.size) {
    throw new Error('Position output does not cover each unique target exactly once')
  }
  for (const [epd, target] of targetByEpd) {
    const position = positionByEpd.get(epd)
    if (!position || JSON.stringify(position.lineIds) !== JSON.stringify([...new Set(target.lineIds)].sort())) {
      throw new Error(`Position target metadata mismatch at ${epd}`)
    }
    const chess = new Chess(`${epd} 0 1`)
    if (normalizedEpd(chess) !== epd) throw new Error(`Position is not legally normalized: ${epd}`)
    for (const band of RATING_BANDS) assertRaw(position.bands[band], `position ${epd}/${band}`)
    const moves = new Set<string>()
    for (const move of position.moves) {
      if (moves.has(move.uci)) throw new Error(`Duplicate outgoing move ${move.uci} at ${epd}`)
      moves.add(move.uci)
      const applied = new Chess(`${epd} 0 1`).move(moveParts(move.uci))
      if (!applied || applied.san !== move.san) throw new Error(`Illegal or inconsistent move ${move.uci} at ${epd}`)
      for (const band of RATING_BANDS) {
        assertRaw(move.bands[band], `move ${epd}/${move.uci}/${band}`)
        const parent = position.bands[band]
        const child = move.bands[band]
        if (
          child.n > parent.n || child.whiteWins > parent.whiteWins ||
          child.draws > parent.draws || child.blackWins > parent.blackWins
        ) throw new Error(`Move counts exceed position counts at ${epd}/${move.uci}/${band}`)
      }
    }
  }

  const terminals = new Map<string, (typeof backtest.terminalLines)[number]>()
  for (const terminal of backtest.terminalLines) {
    if (terminals.has(terminal.lineId)) throw new Error(`Duplicate terminal line ${terminal.lineId}`)
    terminals.set(terminal.lineId, terminal)
    const target = targetByEpd.get(terminal.epd)
    const position = positionByEpd.get(terminal.epd)
    if (!target?.terminalLineIds?.includes(terminal.lineId) || !position) {
      throw new Error(`Terminal line ${terminal.lineId} is not mapped to its target position`)
    }
    let total = 0
    for (const band of RATING_BANDS) {
      const raw = terminal.bands[band].raw
      assertRaw(raw, `terminal ${terminal.lineId}/${band}`)
      if (JSON.stringify(raw) !== JSON.stringify(position.bands[band])) {
        throw new Error(`Terminal raw counts differ from position ${terminal.lineId}/${band}`)
      }
      for (const side of ['whitePerspective', 'blackPerspective'] as const) {
        const perspective = terminal.bands[band][side]
        const wins = side === 'whitePerspective' ? raw.whiteWins : raw.blackWins
        const losses = side === 'whitePerspective' ? raw.blackWins : raw.whiteWins
        if (
          perspective.n !== raw.n || perspective.wins !== wins || perspective.losses !== losses ||
          perspective.winRate !== percentage(wins, raw.n) ||
          perspective.drawRate !== percentage(raw.draws, raw.n) ||
          perspective.lossRate !== percentage(losses, raw.n)
        ) throw new Error(`Perspective rates are inconsistent for ${terminal.lineId}/${band}/${side}`)
      }
      total += raw.n
    }
    if (terminal.totalSampleSize !== total || terminal.drillEligible !== (total >= 500)) {
      throw new Error(`Terminal sample threshold is inconsistent for ${terminal.lineId}`)
    }
  }
  const expectedTerminalIds = new Set(targets.targets.flatMap((target) => target.terminalLineIds ?? []))
  if (terminals.size !== 3_790 || expectedTerminalIds.size !== terminals.size) {
    throw new Error('Terminal output does not cover all 3,790 taxonomy lines')
  }

  const report = {
    schemaVersion: 1,
    validatedAt: new Date().toISOString(),
    result: 'pass',
    backtestSha256: createHash('sha256').update(backtestBytes).digest('hex'),
    totals: {
      recordsSeen: backtest.totals.recordsSeen,
      accepted: backtest.totals.accepted,
      deduplicated: backtest.totals.deduplicated,
      rejected: backtest.totals.rejected,
      targetPositions: positionByEpd.size,
      terminalLines: terminals.size,
      thresholdEligibleLines: backtest.terminalLines.filter((line) => line.drillEligible).length,
    },
    gates: {
      manifestAndChecksums: 'pass',
      officialRecordTotal: 'pass',
      outcomeArithmetic: 'pass',
      legalMovesAndSan: 'pass',
      normalizedPositions: 'pass',
      transpositionTargets: 'pass',
      terminalThresholds: 'pass',
    },
  }
  await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

const report = await validateBacktest({
  backtestPath: option('--backtest', 'data/generated/broadcast-backtest.json'),
  manifestPath: option('--manifest', 'data/manifests/broadcasts.source.json'),
  targetsPath: option('--targets', 'data/generated/taxonomy/broadcast-targets.v1.json'),
  reportPath: option('--report', 'data/generated/backtest-validation.json'),
})
process.stdout.write(`Backtest validation passed: ${JSON.stringify(report.totals)}\n`)

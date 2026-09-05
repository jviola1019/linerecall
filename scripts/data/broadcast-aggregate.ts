import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { Chess } from 'chess.js'
import {
  BROADCAST_SCHEMA_VERSION,
  RATING_BANDS,
  addResult,
  assertBroadcastManifest,
  assertBroadcastManifestApproved,
  assertBroadcastTargetIndex,
  emptyRawOutcomes,
  perspectiveStats,
  type BandedRawOutcomes,
  type BroadcastArchive,
  type BroadcastBacktestV1,
  type BroadcastManifestV1,
  type BroadcastTargetIndexV1,
  type IngestionTotals,
  type OutgoingMoveBacktest,
  type PositionBacktest,
  type RejectionReason,
  type TerminalLineBacktest,
} from './broadcast-contracts.ts'
import { verifyArchive } from './broadcast-manifest.ts'
import {
  DEFAULT_PGN_LIMITS,
  normalizedEpd,
  parseBroadcastPgn,
  readZstdPgnRecords,
  splitPgnStream,
  uciForMove,
  type PgnLimits,
  type PgnRecord,
} from './broadcast-pgn.ts'
import type { Readable } from 'node:stream'

export interface MutableMove {
  uci: string
  san: string
  bands: BandedRawOutcomes
}

export interface MutablePosition {
  epd: string
  lineIds: string[]
  terminalLineIds: string[]
  bands: BandedRawOutcomes
  moves: Map<string, MutableMove>
}

export interface AggregateOptions {
  limits?: PgnLimits
  now?: Date
}

export function targetMapFor(index: BroadcastTargetIndexV1): Map<string, MutablePosition> {
  assertBroadcastTargetIndex(index)
  const map = new Map<string, MutablePosition>()
  for (const target of index.targets) {
    let normalized: string
    try {
      normalized = normalizedEpd(new Chess(`${target.epd} 0 1`))
    } catch (error) {
      throw new Error(`Invalid target EPD ${target.epd}: ${(error as Error).message}`)
    }
    if (normalized !== target.epd) {
      throw new Error(`Target EPD is not legally normalized: ${target.epd} (expected ${normalized})`)
    }
    map.set(target.epd, {
      epd: target.epd,
      lineIds: [...new Set(target.lineIds)].sort(),
      terminalLineIds: [...new Set(target.terminalLineIds ?? [])].sort(),
      bands: emptyRawOutcomes(),
      moves: new Map(),
    })
  }
  return map
}

export function incrementRejected(totals: IngestionTotals, reason: RejectionReason): void {
  totals.rejected[reason] = (totals.rejected[reason] ?? 0) + 1
}

function addGameToTargets(
  game: Extract<ReturnType<typeof parseBroadcastPgn>, { accepted: true }>['game'],
  targets: Map<string, MutablePosition>,
  maxPly: number,
): void {
  const chess = new Chess()
  const seenPositions = new Set<string>()
  const finalPly = Math.min(game.moves.length, maxPly)
  for (let ply = 0; ply <= finalPly; ply += 1) {
    const epd = normalizedEpd(chess)
    const target = targets.get(epd)
    const firstVisit = target !== undefined && !seenPositions.has(epd)
    if (target && firstVisit) {
      seenPositions.add(epd)
      addResult(target.bands[game.ratingBand], game.result)
      const sourceMove = game.moves[ply]
      if (sourceMove && ply < maxPly) {
        const uci = uciForMove(sourceMove)
        let move = target.moves.get(uci)
        if (!move) {
          const preview = new Chess(chess.fen()).move({
            from: sourceMove.from,
            to: sourceMove.to,
            ...(sourceMove.promotion ? { promotion: sourceMove.promotion } : {}),
          })
          if (!preview) throw new Error(`Could not derive SAN for ${uci}`)
          move = { uci, san: preview.san, bands: emptyRawOutcomes() }
          target.moves.set(uci, move)
        }
        addResult(move.bands[game.ratingBand], game.result)
      }
    }
    if (ply === finalPly) break
    const sourceMove = game.moves[ply]
    if (!sourceMove) break
    const applied = chess.move({
      from: sourceMove.from,
      to: sourceMove.to,
      ...(sourceMove.promotion ? { promotion: sourceMove.promotion } : {}),
    })
    if (!applied) {
      // The PGN was already checked by chess.js; reaching this path signals a
      // programming/library inconsistency, not an input rejection.
      throw new Error(`Could not replay previously validated move ${uciForMove(sourceMove)}`)
    }
  }
}

export function finalizePositions(targets: Map<string, MutablePosition>): PositionBacktest[] {
  return [...targets.values()]
    .map((position): PositionBacktest => ({
      epd: position.epd,
      lineIds: position.lineIds,
      provenanceRef: 'corpus',
      bands: position.bands,
      moves: [...position.moves.values()]
        .map((move): OutgoingMoveBacktest => ({
          uci: move.uci,
          san: move.san,
          bands: move.bands,
        }))
        .sort((left, right) => {
          const leftN = RATING_BANDS.reduce((sum, band) => sum + left.bands[band].n, 0)
          const rightN = RATING_BANDS.reduce((sum, band) => sum + right.bands[band].n, 0)
          return rightN - leftN || left.uci.localeCompare(right.uci)
        }),
    }))
    .sort((left, right) => left.epd.localeCompare(right.epd))
}

export function finalizeTerminalLines(targets: Map<string, MutablePosition>): TerminalLineBacktest[] {
  const lines: TerminalLineBacktest[] = []
  for (const position of targets.values()) {
    for (const lineId of position.terminalLineIds) {
      const totalSampleSize = RATING_BANDS.reduce(
        (sum, band) => sum + position.bands[band].n,
        0,
      )
      lines.push({
        lineId,
        epd: position.epd,
        totalSampleSize,
        drillEligible: totalSampleSize >= 500,
        provenanceRef: 'corpus',
        bands: Object.fromEntries(
          RATING_BANDS.map((band) => {
            const raw = position.bands[band]
            return [
              band,
              {
                raw: { ...raw },
                whitePerspective: perspectiveStats(raw, 'white'),
                blackPerspective: perspectiveStats(raw, 'black'),
              },
            ]
          }),
        ) as TerminalLineBacktest['bands'],
      })
    }
  }
  return lines.sort((left, right) => left.lineId.localeCompare(right.lineId))
}

async function consumeRecords(
  records: AsyncIterable<PgnRecord>,
  targets: Map<string, MutablePosition>,
  targetIndex: BroadcastTargetIndexV1,
  totals: IngestionTotals,
  deduplicationKeys: Set<string>,
  limits: PgnLimits,
): Promise<void> {
  for await (const record of records) {
    totals.recordsSeen += 1
    if (record.rejection || record.pgn === null) {
      incrementRejected(totals, record.rejection ?? 'record_too_large')
      continue
    }
    const parsed = parseBroadcastPgn(record.pgn, limits)
    if (!parsed.accepted) {
      incrementRejected(totals, parsed.reason)
      continue
    }
    if (deduplicationKeys.has(parsed.game.deduplicationKey)) {
      totals.deduplicated += 1
      continue
    }
    deduplicationKeys.add(parsed.game.deduplicationKey)
    totals.accepted += 1
    addGameToTargets(parsed.game, targets, targetIndex.maxPly)
  }
}

export async function aggregatePlainPgnStreams(
  streams: readonly Readable[],
  targetIndex: BroadcastTargetIndexV1,
  options: AggregateOptions = {},
): Promise<{
  totals: IngestionTotals
  positions: PositionBacktest[]
  terminalLines: TerminalLineBacktest[]
}> {
  const limits = options.limits ?? DEFAULT_PGN_LIMITS
  const targets = targetMapFor(targetIndex)
  const totals: IngestionTotals = {
    recordsSeen: 0,
    accepted: 0,
    deduplicated: 0,
    rejected: {},
  }
  const deduplicationKeys = new Set<string>()
  for (const stream of streams) {
    await consumeRecords(
      splitPgnStream(stream, limits),
      targets,
      targetIndex,
      totals,
      deduplicationKeys,
      limits,
    )
  }
  return {
    totals,
    positions: finalizePositions(targets),
    terminalLines: finalizeTerminalLines(targets),
  }
}

export async function aggregateBroadcastArchives(options: {
  manifest: BroadcastManifestV1
  targetIndex: BroadcastTargetIndexV1
  archiveDirectory: string
  selectedArchives?: BroadcastArchive[]
  limits?: PgnLimits
  now?: Date
  onArchive?: (archive: BroadcastArchive) => void
}): Promise<BroadcastBacktestV1> {
  assertBroadcastManifestApproved(options.manifest)
  assertBroadcastTargetIndex(options.targetIndex)
  const selected = options.selectedArchives ?? options.manifest.archives
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index - 1]!.month >= selected[index]!.month) {
      throw new Error('Selected archives must be unique and in canonical ascending month order')
    }
  }
  const approvedByFilename = new Map(
    options.manifest.archives.map((archive) => [archive.filename, archive]),
  )
  for (const archive of selected) {
    const approved = approvedByFilename.get(archive.filename)
    if (!approved || approved.sha256 !== archive.sha256 || approved.url !== archive.url) {
      throw new Error(`Selected archive is not in the approved manifest: ${archive.filename}`)
    }
  }

  // Verify every selected compressed file before accepting a single result.
  for (const archive of selected) {
    await verifyArchive(join(options.archiveDirectory, archive.filename), archive.sha256)
  }

  const limits = options.limits ?? DEFAULT_PGN_LIMITS
  const targets = targetMapFor(options.targetIndex)
  const totals: IngestionTotals = {
    recordsSeen: 0,
    accepted: 0,
    deduplicated: 0,
    rejected: {},
  }
  const deduplicationKeys = new Set<string>()
  for (const archive of selected) {
    options.onArchive?.(archive)
    await consumeRecords(
      readZstdPgnRecords(join(options.archiveDirectory, archive.filename), limits),
      targets,
      options.targetIndex,
      totals,
      deduplicationKeys,
      limits,
    )
  }
  const completeCorpus =
    selected.length === options.manifest.archives.length &&
    selected.every((archive, index) => archive.filename === options.manifest.archives[index]?.filename)

  return {
    schemaVersion: BROADCAST_SCHEMA_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    completeCorpus,
    // Engine and independent-source gates occur downstream. This stage alone
    // must never label an artifact release-ready.
    releaseEligible: false,
    taxonomyCommit: options.targetIndex.taxonomyCommit,
    corpus: {
      ...options.manifest.source,
      startMonth: selected[0]?.month ?? options.manifest.startMonth,
      cutoffMonth: selected.at(-1)?.month ?? options.manifest.cutoffMonth,
      archives: selected,
      everyArchiveSha256Verified: true,
    },
    filtering: {
      variant: 'Standard (required explicitly)',
      result: '1-0, 0-1, or 1/2-1/2',
      ratings: 'positive integer WhiteElo and BlackElo, each <= 4000',
      startPosition: 'standard initial chess position',
      deduplication: 'normalized GameURL, otherwise deterministic SHA-256 game hash',
      ratingBandBasis: 'arithmetic mean of WhiteElo and BlackElo',
      minimumDrillTerminalSample: 500,
    },
    totals,
    positions: finalizePositions(targets),
    terminalLines: finalizeTerminalLines(targets),
  }
}

/** Convenience helper for fixture callers that already have plain PGN files. */
export function plainPgnFile(path: string): Readable {
  return createReadStream(path)
}

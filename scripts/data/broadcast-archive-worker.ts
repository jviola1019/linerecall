import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { Chess } from 'chess.js'
import {
  addResult,
  type GameResult,
  type IngestionTotals,
  type RatingBand,
} from './broadcast-contracts.ts'
import {
  DEFAULT_PGN_LIMITS,
  normalizedEpd,
  parseBroadcastPgn,
  readZstdPgnRecords,
  uciForMove,
  type PgnLimits,
} from './broadcast-pgn.ts'

export interface WorkerHit {
  targetIndex: number
  uci?: string
  san?: string
}

export interface WorkerAcceptedGame {
  deduplicationKey: string
  result: GameResult
  ratingBand: RatingBand
  hits: WorkerHit[]
}

export interface ArchiveWorkerResult {
  archiveIndex: number
  recordsSeen: number
  rejected: IngestionTotals['rejected']
  games: WorkerAcceptedGame[]
}

export interface ArchiveWorkerInput {
  archiveIndex: number
  archivePath: string
  targetEpds: string[]
  maxPly: number
  limits?: PgnLimits
}

function incrementRejected(
  rejected: IngestionTotals['rejected'],
  reason: keyof IngestionTotals['rejected'],
): void {
  rejected[reason] = (rejected[reason] ?? 0) + 1
}

function hitsForGame(
  game: Extract<ReturnType<typeof parseBroadcastPgn>, { accepted: true }>['game'],
  targetIndexes: ReadonlyMap<string, number>,
  maxPly: number,
): WorkerHit[] {
  const chess = new Chess()
  const hits: WorkerHit[] = []
  const seenPositions = new Set<number>()
  const finalPly = Math.min(game.moves.length, maxPly)
  for (let ply = 0; ply <= finalPly; ply += 1) {
    const targetIndex = targetIndexes.get(normalizedEpd(chess))
    const sourceMove = game.moves[ply]
    let applied: ReturnType<Chess['move']> | null = null
    if (sourceMove && ply < maxPly) {
      applied = chess.move({
        from: sourceMove.from,
        to: sourceMove.to,
        ...(sourceMove.promotion ? { promotion: sourceMove.promotion } : {}),
      })
      if (!applied) throw new Error(`Could not replay previously validated move ${uciForMove(sourceMove)}`)
    }
    if (targetIndex !== undefined && !seenPositions.has(targetIndex)) {
      seenPositions.add(targetIndex)
      hits.push(
        applied === null
          ? { targetIndex }
          : { targetIndex, uci: uciForMove(sourceMove!), san: applied.san },
      )
    }
    if (!sourceMove || ply === finalPly) break
  }
  return hits
}

export async function processArchive(input: ArchiveWorkerInput): Promise<ArchiveWorkerResult> {
  if (!Number.isSafeInteger(input.archiveIndex) || input.archiveIndex < 0) {
    throw new Error('Worker archive index is invalid')
  }
  if (!Number.isSafeInteger(input.maxPly) || input.maxPly < 1 || input.maxPly > 200) {
    throw new Error('Worker maxPly is invalid')
  }
  const targetIndexes = new Map<string, number>()
  for (const [index, epd] of input.targetEpds.entries()) {
    if (targetIndexes.has(epd)) throw new Error(`Duplicate worker target EPD ${epd}`)
    targetIndexes.set(epd, index)
  }
  const rejected: IngestionTotals['rejected'] = {}
  const games: WorkerAcceptedGame[] = []
  let recordsSeen = 0
  const limits = input.limits ?? DEFAULT_PGN_LIMITS
  for await (const record of readZstdPgnRecords(input.archivePath, limits)) {
    recordsSeen += 1
    if (record.rejection || record.pgn === null) {
      incrementRejected(rejected, record.rejection ?? 'record_too_large')
      continue
    }
    const parsed = parseBroadcastPgn(record.pgn, limits)
    if (!parsed.accepted) {
      incrementRejected(rejected, parsed.reason)
      continue
    }
    games.push({
      deduplicationKey: parsed.game.deduplicationKey,
      result: parsed.game.result,
      ratingBand: parsed.game.ratingBand,
      hits: hitsForGame(parsed.game, targetIndexes, input.maxPly),
    })
  }
  return { archiveIndex: input.archiveIndex, recordsSeen, rejected, games }
}

if (!isMainThread) {
  if (!parentPort) throw new Error('Broadcast archive worker has no parent port')
  const port = parentPort
  processArchive(workerData as ArchiveWorkerInput).then(
    (result) => port.postMessage(result),
    (error: unknown) => {
      throw error
    },
  )
}

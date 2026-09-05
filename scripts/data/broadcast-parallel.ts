import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  BROADCAST_SCHEMA_VERSION,
  addResult,
  assertBroadcastManifestApproved,
  assertBroadcastTargetIndex,
  emptyRawOutcomes,
  type BroadcastArchive,
  type BroadcastBacktestV1,
  type BroadcastManifestV1,
  type BroadcastTargetIndexV1,
  type IngestionTotals,
} from './broadcast-contracts.ts'
import {
  finalizePositions,
  finalizeTerminalLines,
  targetMapFor,
  type MutableMove,
} from './broadcast-aggregate.ts'
import type {
  ArchiveWorkerInput,
  ArchiveWorkerResult,
  WorkerAcceptedGame,
} from './broadcast-archive-worker.ts'
import { DEFAULT_PGN_LIMITS, type PgnLimits } from './broadcast-pgn.ts'
import { verifyArchive } from './broadcast-manifest.ts'

export interface ParallelAggregateOptions {
  manifest: BroadcastManifestV1
  targetIndex: BroadcastTargetIndexV1
  archiveDirectory: string
  selectedArchives?: BroadcastArchive[]
  limits?: PgnLimits
  now?: Date
  concurrency?: number
  onArchive?: (archive: BroadcastArchive) => void
}

function addWorkerGame(
  game: WorkerAcceptedGame,
  targets: ReturnType<typeof targetMapFor>,
  targetEpds: readonly string[],
): void {
  for (const hit of game.hits) {
    const epd = targetEpds[hit.targetIndex]
    const target = epd === undefined ? undefined : targets.get(epd)
    if (!target) throw new Error(`Worker returned unknown target index ${hit.targetIndex}`)
    addResult(target.bands[game.ratingBand], game.result)
    if ((hit.uci === undefined) !== (hit.san === undefined)) {
      throw new Error('Worker returned incomplete outgoing-move metadata')
    }
    if (hit.uci !== undefined && hit.san !== undefined) {
      let move: MutableMove | undefined = target.moves.get(hit.uci)
      if (!move) {
        move = { uci: hit.uci, san: hit.san, bands: emptyRawOutcomes() }
        target.moves.set(hit.uci, move)
      } else if (move.san !== hit.san) {
        throw new Error(`Inconsistent SAN for ${hit.uci} at ${target.epd}`)
      }
      addResult(move.bands[game.ratingBand], game.result)
    }
  }
}

function runArchiveWorker(input: ArchiveWorkerInput): Promise<ArchiveWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./broadcast-archive-worker.ts', import.meta.url), {
      workerData: input,
    })
    let settled = false
    worker.once('message', (message: ArchiveWorkerResult) => {
      settled = true
      resolve(message)
    })
    worker.once('error', (error) => {
      settled = true
      reject(error)
    })
    worker.once('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`Archive worker exited with code ${code}`))
      else if (!settled) reject(new Error('Archive worker exited without a result'))
    })
  })
}

function canonicalSelectedArchives(options: ParallelAggregateOptions): BroadcastArchive[] {
  const selected = options.selectedArchives ?? options.manifest.archives
  const approved = new Map(options.manifest.archives.map((archive) => [archive.filename, archive]))
  for (const [index, archive] of selected.entries()) {
    const source = approved.get(archive.filename)
    if (!source || source.sha256 !== archive.sha256 || source.url !== archive.url) {
      throw new Error(`Selected archive is not in the approved manifest: ${archive.filename}`)
    }
    if (index > 0 && selected[index - 1]!.month >= archive.month) {
      throw new Error('Selected archives must be unique and in canonical ascending month order')
    }
  }
  return selected
}

export async function aggregateBroadcastArchivesParallel(
  options: ParallelAggregateOptions,
): Promise<BroadcastBacktestV1> {
  assertBroadcastManifestApproved(options.manifest)
  assertBroadcastTargetIndex(options.targetIndex)
  const selected = canonicalSelectedArchives(options)
  for (const archive of selected) {
    await verifyArchive(join(options.archiveDirectory, archive.filename), archive.sha256)
  }

  const concurrency = options.concurrency ?? Math.max(1, Math.min(12, availableParallelism() - 1))
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Parallel aggregation concurrency must be an integer from 1 through 32')
  }
  const targets = targetMapFor(options.targetIndex)
  const targetEpds = options.targetIndex.targets.map((target) => target.epd)
  const totals: IngestionTotals = { recordsSeen: 0, accepted: 0, deduplicated: 0, rejected: {} }
  const deduplicationKeys = new Set<string>()
  const limits = options.limits ?? DEFAULT_PGN_LIMITS

  const mergeResult = (result: ArchiveWorkerResult, expectedIndex: number): void => {
      if (result.archiveIndex !== expectedIndex) {
        throw new Error(`Expected archive result ${expectedIndex}, received ${result.archiveIndex}`)
      }
      totals.recordsSeen += result.recordsSeen
      for (const reason of Object.keys(result.rejected) as Array<keyof typeof result.rejected>) {
        totals.rejected[reason] = (totals.rejected[reason] ?? 0) + (result.rejected[reason] ?? 0)
      }
      for (const game of result.games) {
        if (deduplicationKeys.has(game.deduplicationKey)) {
          totals.deduplicated += 1
          continue
        }
        deduplicationKeys.add(game.deduplicationKey)
        totals.accepted += 1
        addWorkerGame(game, targets, targetEpds)
      }
  }

  await new Promise<void>((resolve, reject) => {
    const completed = new Map<number, ArchiveWorkerResult>()
    const maximumWindow = concurrency * 2
    let nextToLaunch = 0
    let nextToMerge = 0
    let active = 0
    let failed = false

    const drain = (): void => {
      try {
        while (completed.has(nextToMerge)) {
          const result = completed.get(nextToMerge)
          if (!result) throw new Error(`Missing completed result ${nextToMerge}`)
          completed.delete(nextToMerge)
          mergeResult(result, nextToMerge)
          nextToMerge += 1
        }
      } catch (error) {
        failed = true
        reject(error)
      }
    }

    const launch = (): void => {
      if (failed) return
      drain()
      if (failed) return
      if (nextToMerge === selected.length && active === 0) {
        resolve()
        return
      }
      while (
        active < concurrency &&
        nextToLaunch < selected.length &&
        nextToLaunch - nextToMerge < maximumWindow
      ) {
        const archiveIndex = nextToLaunch
        const archive = selected[archiveIndex]
        if (!archive) {
          failed = true
          reject(new Error(`Missing selected archive ${archiveIndex}`))
          return
        }
        nextToLaunch += 1
        active += 1
        options.onArchive?.(archive)
        void runArchiveWorker({
          archiveIndex,
          archivePath: join(options.archiveDirectory, archive.filename),
          targetEpds,
          maxPly: options.targetIndex.maxPly,
          limits,
        }).then(
          (result) => {
            active -= 1
            completed.set(archiveIndex, result)
            launch()
          },
          (error: unknown) => {
            if (failed) return
            failed = true
            reject(error)
          },
        )
      }
    }
    launch()
  })

  const completeCorpus =
    selected.length === options.manifest.archives.length &&
    selected.every((archive, index) => archive.filename === options.manifest.archives[index]?.filename)
  return {
    schemaVersion: BROADCAST_SCHEMA_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    completeCorpus,
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

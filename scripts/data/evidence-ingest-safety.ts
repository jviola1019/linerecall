import { stat, statfs } from 'node:fs/promises'
import { dirname, parse, resolve } from 'node:path'

export const MONOLITHIC_EVIDENCE_STORAGE_MODEL = 'per-archive-shard-plus-monolithic-merge-v1' as const
export const MINIMUM_FREE_RESERVE_BYTES = 10 * 1024 * 1024 * 1024

export interface StandardArchiveBudgetInput {
  month: string
  bytes: number
  games: number
}

export interface StandardStorageAssessment {
  storageModel: typeof MONOLITHIC_EVIDENCE_STORAGE_MODEL
  safeToStart: false
  reasonCode: 'unbounded-monolithic-output'
  selectedArchives: number
  compressedInputBytes: number
  publishedGames: number
  currentGraphBytes: number
  graphFilesystemAvailableBytes: number
  shardFilesystemAvailableBytes: number
  minimumFreeReserveBytes: number
  peakAdditionalBytesUpperBound: null
  detail: string
}

export function constrainedEvidenceWorkerCount(value: string | undefined): 1 {
  if (value !== undefined && Number(value) !== 1) {
    throw new Error('--workers is fixed at 1 until bounded shard storage is implemented and audited')
  }
  return 1
}

function safeNonnegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a nonnegative safe integer`)
}

function safeSum(values: readonly number[], field: string): number {
  return values.reduce((sum, value) => {
    safeNonnegativeInteger(value, field)
    const next = sum + value
    if (!Number.isSafeInteger(next)) throw new Error(`${field} total exceeds the safe integer range`)
    return next
  }, 0)
}

async function fileBytes(path: string): Promise<number> {
  try {
    const details = await stat(path)
    if (!details.isFile()) throw new Error(`${path} is not a file`)
    return details.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

async function filesystemAvailableBytes(path: string): Promise<number> {
  const details = await statfs(path, { bigint: true })
  const available = details.bavail * details.bsize
  if (available > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Available filesystem capacity exceeds the safe integer range')
  return Number(available)
}

/**
 * The current graph builder materializes a complete SQLite shard for each
 * archive and then copies it into a growing monolithic database. No measured
 * or analytically proven upper bound exists for the Standard corpus's shard,
 * index, WAL, merge, and final-database growth. A capacity check cannot safely
 * convert compressed input bytes into required output bytes, so this preflight
 * fails closed instead of accepting an invented multiplier.
 */
export function assessStandardMonolithicStorage(input: {
  archives: readonly StandardArchiveBudgetInput[]
  currentGraphBytes: number
  graphFilesystemAvailableBytes: number
  shardFilesystemAvailableBytes: number
  minimumFreeReserveBytes?: number
}): StandardStorageAssessment {
  if (input.archives.length === 0) throw new Error('At least one approved Standard archive must be selected')
  for (const archive of input.archives) {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(archive.month)) throw new Error('Standard archive month is invalid')
  }
  safeNonnegativeInteger(input.currentGraphBytes, 'currentGraphBytes')
  safeNonnegativeInteger(input.graphFilesystemAvailableBytes, 'graphFilesystemAvailableBytes')
  safeNonnegativeInteger(input.shardFilesystemAvailableBytes, 'shardFilesystemAvailableBytes')
  const minimumFreeReserveBytes = input.minimumFreeReserveBytes ?? MINIMUM_FREE_RESERVE_BYTES
  safeNonnegativeInteger(minimumFreeReserveBytes, 'minimumFreeReserveBytes')
  const compressedInputBytes = safeSum(input.archives.map(({ bytes }) => bytes), 'archive bytes')
  const publishedGames = safeSum(input.archives.map(({ games }) => games), 'archive games')
  return {
    storageModel: MONOLITHIC_EVIDENCE_STORAGE_MODEL,
    safeToStart: false,
    reasonCode: 'unbounded-monolithic-output',
    selectedArchives: input.archives.length,
    compressedInputBytes,
    publishedGames,
    currentGraphBytes: input.currentGraphBytes,
    graphFilesystemAvailableBytes: input.graphFilesystemAvailableBytes,
    shardFilesystemAvailableBytes: input.shardFilesystemAvailableBytes,
    minimumFreeReserveBytes,
    peakAdditionalBytesUpperBound: null,
    detail: 'Standard ingestion is disabled: the current per-archive shard plus monolithic merge design has no audited peak-storage upper bound. Implement and validate a bounded compact pipeline before processing this corpus.',
  }
}

export async function inspectStandardMonolithicStorage(input: {
  archives: readonly StandardArchiveBudgetInput[]
  databasePath: string
  shardDirectory: string
}): Promise<StandardStorageAssessment> {
  const databasePath = resolve(input.databasePath)
  const shardDirectory = resolve(input.shardDirectory)
  const graphDirectory = dirname(databasePath)
  const sameFilesystemRoot = parse(graphDirectory).root.toLowerCase() === parse(shardDirectory).root.toLowerCase()
  const [currentGraphBytes, graphAvailable, shardAvailable] = await Promise.all([
    fileBytes(databasePath),
    filesystemAvailableBytes(graphDirectory),
    sameFilesystemRoot ? filesystemAvailableBytes(graphDirectory) : filesystemAvailableBytes(shardDirectory),
  ])
  return assessStandardMonolithicStorage({
    archives: input.archives,
    currentGraphBytes,
    graphFilesystemAvailableBytes: graphAvailable,
    shardFilesystemAvailableBytes: shardAvailable,
  })
}

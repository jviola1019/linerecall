import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { rm } from 'node:fs/promises'
import { readZstdPgnRecords } from './broadcast-pgn.ts'
import {
  EvidenceGraphStore,
  GRAPH_PGN_LIMITS,
  ingestGraphRecords,
  parseBroadcastGraphPgn,
  parseLichessStandardGraphPgn,
  type GraphArchiveIdentity,
  type GraphIngestionTotals,
} from './evidence-graph.ts'

export interface EvidenceArchiveWorkerInput {
  archivePath: string
  identity: GraphArchiveIdentity
  parser: 'broadcast' | 'standard'
  shardPath: string
}

export interface EvidenceArchiveWorkerResult {
  identity: GraphArchiveIdentity
  archivePath: string
  shardPath: string
  totals: GraphIngestionTotals
}

export async function processEvidenceArchive(
  input: EvidenceArchiveWorkerInput,
): Promise<EvidenceArchiveWorkerResult> {
  for (const suffix of ['', '-wal', '-shm']) await rm(`${input.shardPath}${suffix}`, { force: true })
  const store = new EvidenceGraphStore(input.shardPath)
  try {
    const result = await ingestGraphRecords({
      store,
      identity: input.identity,
      records: readZstdPgnRecords(input.archivePath, GRAPH_PGN_LIMITS),
      parse: input.parser === 'broadcast' ? parseBroadcastGraphPgn : parseLichessStandardGraphPgn,
    })
    return {
      identity: input.identity,
      archivePath: input.archivePath,
      shardPath: input.shardPath,
      totals: {
        recordsSeen: result.recordsSeen,
        accepted: result.accepted,
        deduplicated: result.deduplicated,
        rejected: result.rejected,
      },
    }
  } finally {
    store.close()
  }
}

if (!isMainThread) {
  if (!parentPort) throw new Error('Evidence archive worker has no parent port')
  const port = parentPort
  processEvidenceArchive(workerData as EvidenceArchiveWorkerInput).then(
    (result) => port.postMessage(result),
    (error: unknown) => {
      throw error
    },
  )
}

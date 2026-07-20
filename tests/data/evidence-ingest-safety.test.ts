import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessStandardMonolithicStorage,
  constrainedEvidenceWorkerCount,
  MINIMUM_FREE_RESERVE_BYTES,
  MONOLITHIC_EVIDENCE_STORAGE_MODEL,
} from '../../scripts/data/evidence-ingest-safety.ts'

const quarter = [
  { month: '2026-04', bytes: 29_325_351_334, games: 89_962_564 },
  { month: '2026-05', bytes: 29_689_176_290, games: 90_887_615 },
  { month: '2026-06', bytes: 28_241_946_492, games: 86_483_328 },
]

test('Standard storage preflight reports exact approved inputs and fails closed', () => {
  const result = assessStandardMonolithicStorage({
    archives: quarter,
    currentGraphBytes: 18_733_826_048,
    graphFilesystemAvailableBytes: 66_000_000_000,
    shardFilesystemAvailableBytes: 66_000_000_000,
  })
  assert.equal(result.storageModel, MONOLITHIC_EVIDENCE_STORAGE_MODEL)
  assert.equal(result.compressedInputBytes, 87_256_474_116)
  assert.equal(result.publishedGames, 267_333_507)
  assert.equal(result.minimumFreeReserveBytes, MINIMUM_FREE_RESERVE_BYTES)
  assert.equal(result.peakAdditionalBytesUpperBound, null)
  assert.equal(result.safeToStart, false)
  assert.equal(result.reasonCode, 'unbounded-monolithic-output')
})

test('Standard storage preflight cannot be cleared by selecting one month or claiming abundant free space', () => {
  const result = assessStandardMonolithicStorage({
    archives: [quarter[0]!],
    currentGraphBytes: 0,
    graphFilesystemAvailableBytes: Number.MAX_SAFE_INTEGER,
    shardFilesystemAvailableBytes: Number.MAX_SAFE_INTEGER,
  })
  assert.equal(result.safeToStart, false)
  assert.equal(result.selectedArchives, 1)
})

test('Standard storage preflight rejects invalid or unsafe numeric evidence', () => {
  assert.throws(() => assessStandardMonolithicStorage({
    archives: [], currentGraphBytes: 0, graphFilesystemAvailableBytes: 1, shardFilesystemAvailableBytes: 1,
  }), /At least one/u)
  assert.throws(() => assessStandardMonolithicStorage({
    archives: [{ ...quarter[0]!, bytes: -1 }], currentGraphBytes: 0,
    graphFilesystemAvailableBytes: 1, shardFilesystemAvailableBytes: 1,
  }), /nonnegative/u)
})

test('evidence archive concurrency is fixed at one', () => {
  assert.equal(constrainedEvidenceWorkerCount(undefined), 1)
  assert.equal(constrainedEvidenceWorkerCount('1'), 1)
  assert.throws(() => constrainedEvidenceWorkerCount('2'), /fixed at 1/u)
  assert.throws(() => constrainedEvidenceWorkerCount('0'), /fixed at 1/u)
  assert.throws(() => constrainedEvidenceWorkerCount('not-a-number'), /fixed at 1/u)
})

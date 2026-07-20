import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CompactBenchmarkBootstrapReceiptSchema,
  type CompactBenchmarkBootstrapReceipt,
} from '../../scripts/data/compact-v3-contracts.ts'

const bounds = {
  candidateSketchMaxBytes: 1_000,
  candidateIndexMaxBytes: 2_000,
  baselineShardMaxBytes: 3_000,
  adaptiveShardMaxBytes: 4_000,
  exactWorkMaxBytes: 5_000,
  checkpointMaxBytes: 6_000,
  atomicPromotionMaxBytes: 7_000,
  inputStagingMaxBytes: 0,
  retainedCorpusMaxBytes: 8_000,
}

function receipt(): CompactBenchmarkBootstrapReceipt {
  return CompactBenchmarkBootstrapReceiptSchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-benchmark-bootstrap',
    executionPurpose: 'benchmark-bootstrap',
    provisional: true,
    approvalStatus: 'unapproved',
    releaseEligible: false,
    method: 'complete-broadcast-replay-with-enforced-hard-caps',
    runId: 'broadcast-v3-20260719',
    sourceManifestSha256: 'a'.repeat(64),
    sourceSnapshotSha256: 'b'.repeat(64),
    startedAt: '2026-07-19T12:00:00.000Z',
    completedAt: '2026-07-19T18:00:00.000Z',
    corpus: {
      sourceId: 'lichess-broadcasts',
      archiveCount: 78,
      publishedGames: 1_146_297,
      candidatePasses: 78,
      exactPasses: 78,
    },
    accounting: {
      recordsSeen: 1_146_297,
      accepted: 800_176,
      deduplicated: 0,
      rejected: { filtered_or_invalid: 346_121 },
      observations: 40_000_000,
    },
    resources: {
      sampleIntervalMs: 250,
      samples: 1_000,
      peakResidentBytes: 1_000_000_000,
      peakAdditionalStorageBytes: 9_000_000_000,
      retainedStateBytes: 8_000_000_000,
      wallClockMilliseconds: 21_600_000,
      peakBytesPerAcceptedGame: 11_247.526,
      retainedBytesPerAcceptedGame: 9_997.8,
    },
    enforcedBounds: bounds,
    pipelineReceiptSha256s: Array.from({ length: 156 }, (_, index) =>
      index.toString(16).padStart(64, '0')),
    note: 'Fixture-only provisional bootstrap receipt; never release evidence.',
  })
}

test('bootstrap receipt is structurally unable to claim approval or release eligibility', () => {
  const valid = receipt()
  assert.equal(valid.provisional, true)
  assert.equal(valid.approvalStatus, 'unapproved')
  assert.equal(valid.releaseEligible, false)
  assert.equal(valid.pipelineReceiptSha256s.length, 156)
  assert.throws(() => CompactBenchmarkBootstrapReceiptSchema.parse({
    ...valid,
    provisional: false,
    approvalStatus: 'approved',
    releaseEligible: true,
  }))
})
test('bootstrap receipt rejects incomplete passes and unreconciled corpus accounting', () => {
  const valid = receipt()
  assert.throws(() => CompactBenchmarkBootstrapReceiptSchema.parse({
    ...valid,
    pipelineReceiptSha256s: valid.pipelineReceiptSha256s.slice(1),
  }))
  assert.throws(() => CompactBenchmarkBootstrapReceiptSchema.parse({
    ...valid,
    accounting: { ...valid.accounting, accepted: valid.accounting.accepted - 1 },
  }), /accounting/iu)
})

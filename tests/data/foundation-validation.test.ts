import assert from 'node:assert/strict'
import test from 'node:test'
import { validateGraphFoundation, type ArchiveRunEvidence } from '../../scripts/data/foundation-validation.ts'

const expected = [
  { archiveId: 'broadcast-2026-06', sourceId: 'lichess-broadcasts' as const, month: '2026-06', sha256: 'a'.repeat(64) },
  { archiveId: 'standard-2026-06', sourceId: 'lichess-standard-rated-q2-2026' as const, month: '2026-06', sha256: 'b'.repeat(64) },
]
const complete = (index: number): ArchiveRunEvidence => ({
  ...expected[index]!, status: 'complete', recordsSeen: 10, accepted: 7, deduplicated: 1,
  rejectedJson: '{"invalid_result":2}', completedAt: '2026-07-15T12:00:00.000Z',
})

test('semantic graph foundation binds exact archives and reconciles totals', () => {
  const result = validateGraphFoundation({ schemaVersion: '2', maximumPly: '30', expected, runs: [complete(0), complete(1)] })
  assert.equal(result.complete, true)
  assert.deepEqual(result.missing, [])
  assert.equal(result.groups.find(({ sourceId }) => sourceId === 'lichess-standard-rated-q2-2026')?.accepted, 7)
})

test('semantic graph foundation cannot be cleared by fabricated counts or files', () => {
  assert.throws(() => validateGraphFoundation({
    schemaVersion: '2', maximumPly: '30', expected,
    runs: [{ ...complete(0), archiveId: 'broadcast-fabricated' }, complete(1)],
  }), /unapproved archive/u)
  assert.throws(() => validateGraphFoundation({
    schemaVersion: '2', maximumPly: '30', expected,
    runs: [{ ...complete(0), accepted: 8 }, complete(1)],
  }), /accounting is inconsistent/u)
  const incomplete = validateGraphFoundation({ schemaVersion: '2', maximumPly: '30', expected, runs: [complete(0)] })
  assert.equal(incomplete.complete, false)
  assert.deepEqual(incomplete.missing, ['standard-2026-06'])
})

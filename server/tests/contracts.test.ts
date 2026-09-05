import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ImportRepertoireSchema,
  PuzzleAttemptSyncRequestSchema,
  RepertoireRevisionSchema,
  SyncRequestV1Schema,
  validateImportPgnBounds,
} from '../src/contracts.js'
import { DEVICE_ID, reviewEvent } from './helpers.js'

describe('PGN envelope bounds', () => {
  it('accepts a bounded PGN and comments', () => {
    assert.doesNotThrow(() => validateImportPgnBounds('[Result "1-0"]\n\n1. e4 {main} e5 (1... c5) 2. Nf3 1-0'))
  })
  it('rejects controls, unmatched structures, and overlong lines', () => {
    assert.throws(() => validateImportPgnBounds('e4\0e5'), /control/)
    assert.throws(() => validateImportPgnBounds('e4 )'), /unmatched/)
    assert.throws(() => validateImportPgnBounds('e4 {unterminated'), /unterminated comment/)
    assert.throws(() => validateImportPgnBounds('('.repeat(4) + 'e4'), /unterminated variation/)
    assert.throws(() => validateImportPgnBounds('x'.repeat(8_193)), /line exceeds/)
    assert.throws(() => validateImportPgnBounds(`1. e4 {${'x'.repeat(4_097)}}`), /comment exceeds/)
    assert.throws(() => validateImportPgnBounds(`1. ${Array.from({ length: 20_001 }, () => 'e4').join('\n')}\n1-0`), /20,000 plies/)
    assert.throws(() => validateImportPgnBounds(`1. ${'x'.repeat(257)}`), /token exceeds/)
    assert.throws(() => validateImportPgnBounds('1. e4 \ud800 e5'), /malformed Unicode/)
    assert.throws(() => validateImportPgnBounds(`${'[Event "bounded"]\n'.repeat(513)}1. e4`), /too many headers/)
    assert.throws(() => validateImportPgnBounds(`1. e4 ;${'x'.repeat(4_097)}\n1-0`), /comment exceeds/)
    assert.throws(() => validateImportPgnBounds(`${'()\n'.repeat(5_001)}1. e4`), /5,000 variations/)
  })
  it('binds every review and puzzle attempt to the request device', () => {
    const otherDevice = '0198a5c0-1000-7000-8000-000000000099'
    const sync = SyncRequestV1Schema.safeParse({
      deviceId: DEVICE_ID,
      cursor: null,
      events: [reviewEvent({ deviceId: otherDevice })],
    })
    assert.equal(sync.success, false)
    if (!sync.success) assert.deepEqual(sync.error.issues[0]?.path, ['events', 0, 'deviceId'])

    const puzzles = PuzzleAttemptSyncRequestSchema.safeParse({
      deviceId: DEVICE_ID,
      attempts: [{
        attemptId: '0198a5c0-1000-7000-8000-000000000010',
        deviceId: otherDevice,
        puzzleId: 'puzzle-1',
        outcome: 'abandoned',
        incorrectAttempts: 2,
        usedHint: true,
        elapsedMs: 5_000,
        occurredAt: '2026-07-14T11:55:00.000Z',
        snapshotVersion: 'release-2026q2',
      }],
    })
    assert.equal(puzzles.success, false)
    if (!puzzles.success) assert.deepEqual(puzzles.error.issues[0]?.path, ['attempts', 0, 'deviceId'])
  })
  it('requires explicit bounded tactical outcome evidence', () => {
    const base = {
      attemptId: '0198a5c0-1000-7000-8000-000000000010',
      deviceId: DEVICE_ID,
      puzzleId: 'puzzle-1',
      outcome: 'abandoned',
      incorrectAttempts: 3,
      usedHint: true,
      elapsedMs: 86_400_000,
      occurredAt: '2026-07-14T11:55:00.000Z',
      snapshotVersion: 'release-2026q2',
    }
    assert.equal(PuzzleAttemptSyncRequestSchema.safeParse({
      deviceId: DEVICE_ID, attempts: [base],
    }).success, true)
    assert.equal(PuzzleAttemptSyncRequestSchema.safeParse({
      deviceId: DEVICE_ID, attempts: [{ ...base, elapsedMs: 86_400_001 }],
    }).success, false)
    const { outcome: _outcome, ...legacyShape } = base
    assert.equal(PuzzleAttemptSyncRequestSchema.safeParse({
      deviceId: DEVICE_ID, attempts: [{ ...legacyShape, solved: true }],
    }).success, false)
  })
  it('rejects hostile names and annotation labels before storage', () => {
    assert.equal(ImportRepertoireSchema.safeParse({ name: 'bad\0name', pgn: '1. e4', side: 'white' }).success, false)
    assert.equal(RepertoireRevisionSchema.safeParse({
      name: 'Safe', side: 'white', rootNodeId: 'root', nodeIds: ['node'],
      annotations: [{ from: 'e2', to: 'e4', kind: 'arrow', style: 'hint', label: '<script>\u0007' }],
    }).success, false)
  })
})

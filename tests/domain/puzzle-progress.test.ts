import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PuzzleProgressEntryV1Schema,
  PuzzleProgressV1Schema,
  applyPuzzleAttemptEvent,
  createEmptyPuzzleProgress,
  puzzleMasteryPercent,
} from '../../src/domain/puzzle-progress.ts'

test('puzzle attempts are idempotent and stored outside opening recall cards', () => {
  const empty = createEmptyPuzzleProgress(new Date('2026-07-16T12:00:00.000Z'))
  assert.equal('cards' in empty, false)
  const event = {
    eventId: '00000000-0000-4000-8000-000000000001',
    puzzleId: 'Puzzle1',
    occurredAt: '2026-07-16T12:05:00.000Z',
    outcome: 'solved' as const,
    incorrectAttempts: 0,
    usedHint: false,
  }
  const once = applyPuzzleAttemptEvent(empty, event)
  const twice = applyPuzzleAttemptEvent(once, event)
  assert.deepEqual(twice, once)
  assert.equal(once.puzzles.Puzzle1?.cleanSolves, 1)
  assert.equal(puzzleMasteryPercent(once.puzzles.Puzzle1!), 33)
})

test('hinted, failed, and clean attempts maintain separately auditable totals', () => {
  let progress = createEmptyPuzzleProgress(new Date('2026-07-16T12:00:00.000Z'))
  progress = applyPuzzleAttemptEvent(progress, {
    eventId: '00000000-0000-4000-8000-000000000002',
    puzzleId: 'Puzzle1',
    occurredAt: '2026-07-16T12:05:00.000Z',
    outcome: 'solved',
    incorrectAttempts: 1,
    usedHint: true,
  })
  progress = applyPuzzleAttemptEvent(progress, {
    eventId: '00000000-0000-4000-8000-000000000003',
    puzzleId: 'Puzzle1',
    occurredAt: '2026-07-16T12:10:00.000Z',
    outcome: 'abandoned',
    incorrectAttempts: 2,
    usedHint: false,
  })
  assert.deepEqual(progress.puzzles.Puzzle1, {
    puzzleId: 'Puzzle1',
    attempts: 2,
    solves: 1,
    cleanSolves: 0,
    hintsUsed: 1,
    incorrectMoves: 3,
    lastAttemptAt: '2026-07-16T12:10:00.000Z',
  })
  assert.equal(puzzleMasteryPercent(progress.puzzles.Puzzle1!), 0)
})

test('progress validation rejects inconsistent totals, keys, duplicates, and invalid clocks', () => {
  assert.equal(PuzzleProgressEntryV1Schema.safeParse({
    puzzleId: 'Puzzle1', attempts: 1, solves: 2, cleanSolves: 0,
    hintsUsed: 0, incorrectMoves: 0, lastAttemptAt: null,
  }).success, false)
  assert.equal(PuzzleProgressEntryV1Schema.safeParse({
    puzzleId: 'Puzzle1', attempts: 1, solves: 1, cleanSolves: 2,
    hintsUsed: 0, incorrectMoves: 0, lastAttemptAt: null,
  }).success, false)
  assert.equal(PuzzleProgressEntryV1Schema.safeParse({
    puzzleId: 'Puzzle1', attempts: 1, solves: 1, cleanSolves: 1,
    hintsUsed: 2, incorrectMoves: 0, lastAttemptAt: null,
  }).success, false)
  const empty = createEmptyPuzzleProgress(new Date('2026-07-16T12:00:00.000Z'))
  assert.equal(PuzzleProgressV1Schema.safeParse({
    ...empty,
    puzzles: { Puzzle1: { puzzleId: 'Puzzle2', attempts: 0, solves: 0, cleanSolves: 0, hintsUsed: 0, incorrectMoves: 0, lastAttemptAt: null } },
  }).success, false)
  assert.equal(PuzzleProgressV1Schema.safeParse({
    ...empty,
    appliedEventIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'],
  }).success, false)
  assert.throws(() => createEmptyPuzzleProgress(new Date(Number.NaN)), /time is invalid/u)
})

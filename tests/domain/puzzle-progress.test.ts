import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PuzzleProgressEntryV1Schema,
  PuzzleProgressV1Schema,
  applyPuzzleAttemptEvent,
  createEmptyPuzzleProgress,
  puzzleMasteryPercent,
} from '../../src/domain/puzzle-progress.ts'
import {
  MemoryPuzzleProgressRepository,
  persistPuzzleAttempt,
} from '../../src/infrastructure/puzzle-progress-repository.ts'

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
    elapsedMs: 3_000,
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
    elapsedMs: 5_000,
  })
  progress = applyPuzzleAttemptEvent(progress, {
    eventId: '00000000-0000-4000-8000-000000000003',
    puzzleId: 'Puzzle1',
    occurredAt: '2026-07-16T12:10:00.000Z',
    outcome: 'abandoned',
    incorrectAttempts: 2,
    usedHint: false,
    elapsedMs: 2_000,
  })
  assert.deepEqual(progress.puzzles.Puzzle1, {
    puzzleId: 'Puzzle1',
    attempts: 2,
    solves: 1,
    abandoned: 1,
    cleanSolves: 0,
    hintsUsed: 1,
    incorrectMoves: 3,
    totalElapsedMs: 7_000,
    lastElapsedMs: 2_000,
    lastAttemptAt: '2026-07-16T12:10:00.000Z',
  })
  assert.equal(puzzleMasteryPercent(progress.puzzles.Puzzle1!), 0)
})

test('progress validation rejects inconsistent totals, keys, duplicates, and invalid clocks', () => {
  assert.equal(PuzzleProgressEntryV1Schema.safeParse({
    puzzleId: 'Puzzle1', attempts: 1, solves: 2, cleanSolves: 0,
    abandoned: 0, hintsUsed: 0, incorrectMoves: 0, totalElapsedMs: 0,
    lastElapsedMs: 0, lastAttemptAt: '2026-07-16T12:00:00.000Z',
  }).success, false)
  assert.equal(PuzzleProgressEntryV1Schema.safeParse({
    puzzleId: 'Puzzle1', attempts: 1, solves: 1, cleanSolves: 2,
    abandoned: 0, hintsUsed: 0, incorrectMoves: 0, totalElapsedMs: 0,
    lastElapsedMs: 0, lastAttemptAt: '2026-07-16T12:00:00.000Z',
  }).success, false)
  assert.equal(PuzzleProgressEntryV1Schema.safeParse({
    puzzleId: 'Puzzle1', attempts: 1, solves: 1, cleanSolves: 1,
    abandoned: 0, hintsUsed: 2, incorrectMoves: 0, totalElapsedMs: 0,
    lastElapsedMs: 0, lastAttemptAt: '2026-07-16T12:00:00.000Z',
  }).success, false)
  const empty = createEmptyPuzzleProgress(new Date('2026-07-16T12:00:00.000Z'))
  assert.equal(PuzzleProgressV1Schema.safeParse({
    ...empty,
    puzzles: {
      Puzzle1: {
        puzzleId: 'Puzzle2',
        attempts: 0,
        solves: 0,
        abandoned: 0,
        cleanSolves: 0,
        hintsUsed: 0,
        incorrectMoves: 0,
        totalElapsedMs: 0,
        lastElapsedMs: null,
        lastAttemptAt: null,
      },
    },
  }).success, false)
  assert.equal(PuzzleProgressV1Schema.safeParse({
    ...empty,
    appliedEventIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'],
  }).success, false)
  assert.throws(() => createEmptyPuzzleProgress(new Date(Number.NaN)), /time is invalid/u)
})

test('progress validation rejects every invalid last-attempt clock combination', () => {
  const base = {
    puzzleId: 'Puzzle1',
    solves: 0,
    abandoned: 0,
    cleanSolves: 0,
    hintsUsed: 0,
    incorrectMoves: 0,
    totalElapsedMs: 0,
  }
  assert.equal(PuzzleProgressEntryV1Schema.safeParse({
    ...base,
    attempts: 0,
    lastElapsedMs: null,
    lastAttemptAt: '2026-07-16T12:00:00.000Z',
  }).success, false)
  assert.equal(PuzzleProgressEntryV1Schema.safeParse({
    ...base,
    attempts: 1,
    abandoned: 1,
    lastElapsedMs: null,
    lastAttemptAt: null,
  }).success, false)
  assert.equal(PuzzleProgressEntryV1Schema.safeParse({
    ...base,
    attempts: 0,
    lastElapsedMs: 0,
    lastAttemptAt: null,
  }).success, false)
})

test('missing elapsed time records zero and mastery remains capped after extra clean solves', () => {
  let progress = createEmptyPuzzleProgress(new Date('2026-07-16T12:00:00.000Z'))
  for (let index = 0; index < 4; index += 1) {
    progress = applyPuzzleAttemptEvent(progress, {
      eventId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      puzzleId: 'Puzzle1',
      occurredAt: `2026-07-16T12:${String(index + 1).padStart(2, '0')}:00.000Z`,
      outcome: 'solved',
      incorrectAttempts: 0,
      usedHint: false,
    })
  }
  assert.equal(progress.puzzles.Puzzle1?.totalElapsedMs, 0)
  assert.equal(progress.puzzles.Puzzle1?.lastElapsedMs, 0)
  assert.equal(puzzleMasteryPercent(progress.puzzles.Puzzle1!), 100)
})

test('memory repository validates, isolates, persists, and clears puzzle progress', async () => {
  const repository = new MemoryPuzzleProgressRepository()
  const event = {
    eventId: '00000000-0000-4000-8000-000000000004',
    puzzleId: 'Puzzle1',
    occurredAt: '2026-07-16T12:15:00.000Z',
    outcome: 'abandoned' as const,
    incorrectAttempts: 2,
    usedHint: true,
    elapsedMs: 8_000,
  }
  const saved = await persistPuzzleAttempt(repository, event)
  assert.equal(saved.puzzles.Puzzle1?.abandoned, 1)
  assert.equal(saved.puzzles.Puzzle1?.hintsUsed, 1)
  assert.equal(saved.puzzles.Puzzle1?.incorrectMoves, 2)
  assert.equal(saved.puzzles.Puzzle1?.totalElapsedMs, 8_000)

  const loaded = await repository.load()
  loaded!.puzzles.Puzzle1!.attempts = 999
  assert.equal((await repository.load())?.puzzles.Puzzle1?.attempts, 1)

  const replayed = await persistPuzzleAttempt(repository, event)
  assert.equal(replayed.puzzles.Puzzle1?.attempts, 1)
  await repository.clear()
  assert.equal(await repository.load(), null)
  assert.throws(() => new MemoryPuzzleProgressRepository({ version: 1 } as never))
})

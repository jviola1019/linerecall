import assert from 'node:assert/strict'
import { Blob as NodeBlob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { DecompressionStream as NodeDecompressionStream } from 'node:stream/web'
import test from 'node:test'
import embeddedSnapshot from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import type { EmbeddedSnapshotPayload } from '../../src/data/embedded-contract.ts'
import { EmbeddedOpeningDataSource } from '../../src/data/embedded-opening-data-source.ts'
import {
  OpeningPuzzleSchema,
  createPuzzleAttemptContext,
  gradePuzzleMove,
  markPuzzleHintUsed,
  openingPuzzlesFromVerifiedLine,
} from '../../src/domain/opening-puzzles.ts'
import type { VerifiedLine } from '../../src/domain/opening-data.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true })
Object.defineProperty(globalThis, 'DecompressionStream', { value: NodeDecompressionStream, configurable: true })

let linePromise: Promise<VerifiedLine> | null = null

function auditedLine(): Promise<VerifiedLine> {
  linePromise ??= (async () => {
    const source = new EmbeddedOpeningDataSource(embeddedSnapshot as EmbeddedSnapshotPayload)
    const partition = await source.loadPartition('C20')
    const line = partition.verifiedLines
      .filter((candidate) => candidate.drillEligible && !candidate.quarantined)
      .sort((left, right) => right.nodes.length - left.nodes.length)[0]
    if (!line) throw new Error('The audited C20 fixture has no drill-eligible line')
    return line
  })()
  return linePromise
}

test('puzzles are derived only from validated learner nodes in the audited snapshot', async () => {
  const line = await auditedLine()
  const puzzles = openingPuzzlesFromVerifiedLine(line)
  assert.equal(puzzles.length, line.nodes.length)
  assert.ok(puzzles.length > 0)
  assert.ok(puzzles.every((puzzle) => puzzle.sourceLineId === line.sourceLineId))
  assert.ok(puzzles.every((puzzle) => puzzle.trainedSide === line.trainedSide))
  assert.ok(puzzles.every((puzzle) => puzzle.engineVariations.length >= 1))
  assert.ok(puzzles.every((puzzle) => OpeningPuzzleSchema.safeParse(puzzle).success))
})

test('correct opening recall is graded automatically from attempt context', async () => {
  const puzzle = openingPuzzlesFromVerifiedLine(await auditedLine())[0]!
  const firstTry = gradePuzzleMove(puzzle, puzzle.expectedMoveUci, createPuzzleAttemptContext())
  assert.equal(firstTry.verdict, 'solved')
  assert.equal(firstTry.autoGrade, 'good')

  const hinted = gradePuzzleMove(puzzle, puzzle.expectedMoveUci, markPuzzleHintUsed(createPuzzleAttemptContext()))
  assert.equal(hinted.verdict, 'solved')
  assert.equal(hinted.autoGrade, 'hard')

  const from = puzzle.expectedMoveUci.slice(0, 2)
  const retry = gradePuzzleMove(puzzle, `${from}${from}`, createPuzzleAttemptContext())
  assert.equal(retry.verdict, 'illegal')
  const recovered = gradePuzzleMove(puzzle, puzzle.expectedMoveUci, retry.nextContext)
  assert.equal(recovered.verdict, 'solved')
  assert.equal(recovered.autoGrade, 'again')
})

test('malformed and illegal moves fail without changing the puzzle position', async () => {
  const puzzle = openingPuzzlesFromVerifiedLine(await auditedLine())[0]!
  const malformed = gradePuzzleMove(puzzle, '<script>', createPuzzleAttemptContext())
  assert.equal(malformed.verdict, 'illegal')
  assert.equal(malformed.evidence, null)
  assert.match(malformed.message, /not valid UCI/u)

  const illegal = gradePuzzleMove(puzzle, `${puzzle.expectedMoveUci.slice(0, 2)}${puzzle.expectedMoveUci.slice(0, 2)}`, createPuzzleAttemptContext())
  assert.equal(illegal.verdict, 'illegal')
  assert.match(illegal.message, /not legal/u)
})

test('quarantined or ineligible source lines cannot enter a puzzle session', async () => {
  const line = await auditedLine()
  assert.throws(() => openingPuzzlesFromVerifiedLine({ ...line, quarantined: true }), /non-quarantined/u)
  assert.throws(() => openingPuzzlesFromVerifiedLine({ ...line, drillEligible: false }), /drill-eligible/u)
})

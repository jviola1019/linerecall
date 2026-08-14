import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  associatePuzzle,
  assertPuzzleGraphPrerequisite,
  createPuzzleSourceBinding,
  isPuzzleHeader,
  parsePuzzleCsvLine,
  parsePuzzleSourceLine,
  puzzleCandidateFromRow,
  PUZZLE_ENGINE_SETTINGS_SHA256,
  PUZZLE_COLUMNS,
  replayPuzzleSolution,
  VerifiedPuzzleRecordSchema,
} from '../../scripts/data/puzzle-contracts.ts'
import { streamPuzzleCsvRecords } from '../../scripts/data/puzzle-csv-stream.ts'
import {
  LichessPuzzleManifestSchema,
  PuzzleIntegrityReceiptSchema,
} from '../../scripts/data/evidence-contracts.ts'

const expectedGraph = [
  { archiveId: 'broadcast-2026-06', sourceId: 'lichess-broadcasts' as const, month: '2026-06', sha256: 'a'.repeat(64) },
  { archiveId: 'standard-2026-06', sourceId: 'lichess-standard-rated-q2-2026' as const, month: '2026-06', sha256: 'b'.repeat(64) },
]

test('legacy puzzle review fixture still requires its exact complete graph identity', () => {
  assert.doesNotThrow(() => assertPuzzleGraphPrerequisite({
    schemaVersion: '3', completeBaselineMaximumPly: '30', adaptiveMaximumPly: '100', completed: expectedGraph, expected: expectedGraph,
  }))
  assert.throws(() => assertPuzzleGraphPrerequisite({
    schemaVersion: '3', completeBaselineMaximumPly: '30', adaptiveMaximumPly: '100', completed: expectedGraph.slice(0, 1), expected: expectedGraph,
  }), /missing 1 approved archives/u)
  assert.throws(() => assertPuzzleGraphPrerequisite({
    schemaVersion: '3', completeBaselineMaximumPly: '30', adaptiveMaximumPly: '100', completed: [{ ...expectedGraph[0]!, sha256: 'c'.repeat(64) }, expectedGraph[1]!], expected: expectedGraph,
  }), /identity changed/u)
  assert.throws(() => assertPuzzleGraphPrerequisite({
    schemaVersion: '2', completeBaselineMaximumPly: '30', adaptiveMaximumPly: '100', completed: expectedGraph, expected: expectedGraph,
  }), /schema 3/u)
  assert.throws(() => assertPuzzleGraphPrerequisite({
    schemaVersion: '3', completeBaselineMaximumPly: '30', adaptiveMaximumPly: '30', completed: expectedGraph, expected: expectedGraph,
  }), /ply 100/u)
})

const validLine = [
  'Ab12C',
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  'e7e5 g1f3',
  '1200',
  '80',
  '90',
  '500',
  'opening short',
  'https://lichess.org/Ab12Cd34/black#2',
  'Kings_Pawn_Game',
].join(',')

test('bounded puzzle CSV parser supports RFC quotes and rejects malformed quote tails', () => {
  assert.deepEqual(parsePuzzleCsvLine('one,"two, too","three""x"'), ['one', 'two, too', 'three"x'])
  assert.equal(parsePuzzleCsvLine('one,"two"x,three'), null)
  assert.equal(isPuzzleHeader(PUZZLE_COLUMNS.join(',')), true)
})

async function* chunks(...values: Array<string | Uint8Array>): AsyncGenerator<string | Uint8Array> {
  for (const value of values) yield value
}

test('streaming RFC CSV parser handles chunked escapes and quoted newlines within hard bounds', async () => {
  const records = []
  for await (const record of streamPuzzleCsvRecords(chunks('a,"b', '\r\nc","d"', '"x"\r\n1,2,3'))) records.push(record)
  assert.deepEqual(records, [
    { accepted: true, recordNumber: 1, fields: ['a', 'b\r\nc', 'd"x'], bytes: 16 },
    { accepted: true, recordNumber: 2, fields: ['1', '2', '3'], bytes: 5 },
  ])

  const limited = []
  for await (const record of streamPuzzleCsvRecords(chunks('123456789\n'), { maximumRecordBytes: 8 })) limited.push(record)
  assert.equal(limited[0]?.accepted, false)
  if (!limited[0]?.accepted) assert.equal(limited[0]?.reason, 'record_too_long')

  const invalid = chunks(new Uint8Array([0xff, 0x0a]))
  await assert.rejects(async () => {
    for await (const _record of streamPuzzleCsvRecords(invalid)) { /* consume */ }
  }, /malformed UTF-8/u)
})

test('puzzle filtering validates legality, metrics, tags, and learner decision count', () => {
  const parsed = parsePuzzleSourceLine(validLine)
  assert.equal(parsed.accepted, true)
  assert.deepEqual(
    parsePuzzleSourceLine(validLine.replace(',500,', ',99,')),
    { accepted: false, reason: 'low_plays' },
  )
  assert.deepEqual(
    parsePuzzleSourceLine(validLine.replace('e7e5 g1f3', 'e7e4 g1f3')),
    { accepted: false, reason: 'invalid_moves' },
  )
  assert.deepEqual(
    parsePuzzleSourceLine(validLine.replace('Kings_Pawn_Game', '')),
    { accepted: false, reason: 'missing_opening_tags' },
  )
})

test('puzzle association prefers exact EPD, otherwise only a unique most-specific tag', () => {
  const parsed = parsePuzzleSourceLine(validLine)
  assert.equal(parsed.accepted, true)
  if (!parsed.accepted) return
  const noExact = {
    hasExactPosition: () => false,
    taxonomyLineIdsForTag: (tag: string) => tag === 'Kings_Pawn_Game' ? ['tax_0123456789abcdef01234567'] : [],
  }
  const candidate = puzzleCandidateFromRow(parsed.row, noExact)
  assert.equal(candidate.engineStatus, 'pending')
  assert.equal(candidate.releaseEligible, false)
  assert.equal(candidate.learnerDecisions, 1)
  assert.equal(candidate.association.confidence, 'opening-family')
  assert.equal(candidate.association.taxonomyLineId, 'tax_0123456789abcdef01234567')
  assert.equal(
    associatePuzzle(candidate.presentationEpd, candidate.openingTags, {
      ...noExact,
      hasExactPosition: () => true,
    }).confidence,
    'exact-position',
  )
  assert.equal(associatePuzzle(candidate.presentationEpd, ['Specific_Family_Tag', 'General'], {
    hasExactPosition: () => false,
    taxonomyLineIdsForTag: (tag) => tag === 'Specific_Family_Tag'
      ? ['tax_0123456789abcdef01234567', 'tax_1123456789abcdef01234567']
      : ['tax_0123456789abcdef01234567'],
  }).confidence, 'unlinked')
})

test('legal replay exposes setup, learner nodes, forced replies, and mate flags', () => {
  const replay = replayPuzzleSolution(
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    ['e7e5', 'g1f3', 'b8c6', 'f1b5'],
  )
  assert.equal(replay.learnerNodes.length, 2)
  assert.equal(replay.learnerNodes[0]?.expectedMoveUci, 'g1f3')
  assert.equal(replay.learnerNodes[0]?.forcedReplyUci, 'b8c6')
  assert.equal(replay.learnerNodes[1]?.expectedMoveUci, 'f1b5')
  assert.equal(replay.learnerNodes[1]?.forcedReplyUci, null)
})

test('approved digest receipt is bound to source identity and selection policy', async () => {
  const manifest = LichessPuzzleManifestSchema.parse(JSON.parse(await readFile('data/manifests/lichess-puzzles.source.json', 'utf8')))
  const receipt = PuzzleIntegrityReceiptSchema.parse(JSON.parse(await readFile('data/manifests/lichess-puzzles.integrity.json', 'utf8')))
  const binding = createPuzzleSourceBinding(manifest, receipt)
  assert.equal(binding.sha256, receipt.sha256)
  assert.equal(binding.bytes, manifest.artifact.bytes)
  assert.match(binding.selectionSha256, /^[a-f0-9]{64}$/u)
  assert.throws(() => createPuzzleSourceBinding(manifest, { ...receipt, observedEtag: 'changed' }), /does not match/u)
})

test('release eligibility requires a passing exact Stockfish proof for every linked learner node', () => {
  const parsed = parsePuzzleSourceLine(validLine)
  assert.equal(parsed.accepted, true)
  if (!parsed.accepted) return
  const candidate = puzzleCandidateFromRow(parsed.row, {
    hasExactPosition: () => true,
    taxonomyLineIdsForTag: () => [],
  })
  const pendingFields = (({ engineStatus: _engineStatus, releaseEligible: _releaseEligible, ...rest }) => rest)(candidate)
  const node = candidate.learnerNodes[0]!
  const proof = {
    learnerIndex: node.learnerIndex,
    positionEpd: node.epd,
    expectedMoveUci: node.expectedMoveUci,
    engineBestMoveUci: node.expectedMoveUci,
    centipawnLoss: 0,
    mateConsistent: true,
    status: 'pass' as const,
    engine: 'Stockfish 18' as const,
    engineSha256: '1'.repeat(64),
    nnueSha256: '2'.repeat(64),
    settingsSha256: PUZZLE_ENGINE_SETTINGS_SHA256,
    settings: { threads: 1 as const, hashMb: 128 as const, multiPv: 5 as const, nodes: 250_000 as const },
    principalVariationUci: [node.expectedMoveUci],
    analyzedAt: '2026-07-16T12:00:00.000Z',
  }
  assert.equal(VerifiedPuzzleRecordSchema.safeParse({
    ...pendingFields,
    engineStatus: 'verified',
    engineChecks: [proof],
    releaseEligible: true,
  }).success, true)
  assert.equal(VerifiedPuzzleRecordSchema.safeParse({
    ...pendingFields,
    engineStatus: 'verified',
    engineChecks: [],
    releaseEligible: true,
  }).success, false)
  const failedProof = { ...proof, centipawnLoss: 100, status: 'fail' as const }
  assert.equal(VerifiedPuzzleRecordSchema.safeParse({
    ...pendingFields,
    engineStatus: 'quarantined',
    engineChecks: [failedProof],
    releaseEligible: false,
  }).success, true)
  assert.equal(VerifiedPuzzleRecordSchema.safeParse({
    ...pendingFields,
    engineStatus: 'verified',
    engineChecks: [failedProof],
    releaseEligible: false,
  }).success, false)
})

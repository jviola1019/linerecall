import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeSearchQuery,
  parseMoveSequence,
  parsePgnForSearch,
  searchOpenings,
  type OpeningSearchEntry,
} from '../../src/domain/input-validation.ts'

test('search input is normalized and hostile controls are rejected', () => {
  assert.equal(normalizeSearchQuery('  Sicilian   Defense  '), 'Sicilian Defense')
  assert.equal(normalizeSearchQuery('Ｓｉｃｉｌｉａｎ'), 'Sicilian')
  assert.throws(() => normalizeSearchQuery('x\0y'), /NUL/u)
  assert.throws(() => normalizeSearchQuery(`x${String.fromCharCode(0xd800)}`), /malformed Unicode/u)
  assert.throws(() => normalizeSearchQuery(`x${String.fromCharCode(0xdc00)}`), /malformed Unicode/u)
  assert.throws(() => normalizeSearchQuery('<script>\u0007</script>'), /control/u)
  assert.throws(() => normalizeSearchQuery('x'.repeat(129)), /128/u)
})

test('SAN and UCI move sequences normalize through chess.js', () => {
  assert.deepEqual(parseMoveSequence('1. e4 e5 2. Nf3').uci, ['e2e4', 'e7e5', 'g1f3'])
  assert.deepEqual(parseMoveSequence('e2e4 e7e5 g1f3').san, ['e4', 'e5', 'Nf3'])
  assert.deepEqual(parseMoveSequence('1... e4 e5 2.Nf3 1-0').uci, ['e2e4', 'e7e5', 'g1f3'])
  assert.equal(parseMoveSequence('a2a4 h7h5 a4a5 h5h4 a5a6 h4h3 a6b7 h3g2 b7a8q').san.at(-1), 'bxa8=Q')
  assert.throws(() => parseMoveSequence('e4 e9'), /Move 2/u)
  assert.throws(() => parseMoveSequence(Array.from({ length: 65 }, () => 'e4').join(' ')), /64/u)
  assert.throws(() => parseMoveSequence('x'.repeat(513)), /512/u)
  assert.throws(() => parseMoveSequence('e4\u0007'), /control/u)
  assert.throws(() => parseMoveSequence('  1-0 *  '), /at least one/u)
  assert.throws(() => parseMoveSequence('x'.repeat(129)), /token 1 is too long/u)
})

test('bounded PGN search accepts comments and rejects malformed or non-standard input', () => {
  const parsed = parsePgnForSearch('[Variant "Standard"]\n\n1. e4 {a} {b} e5 2. Nf3 *')
  assert.deepEqual(parsed.uci, ['e2e4', 'e7e5', 'g1f3'])
  assert.throws(() => parsePgnForSearch('[Variant "Atomic"]\n\n1. e4 *'), /Standard/u)
  assert.throws(() => parsePgnForSearch('[Variant "Standard"]\n\n1. e4 { open *'), /comment/u)
  assert.throws(() => parsePgnForSearch('x'.repeat(32 * 1024 + 1)), /32 KB/u)
  assert.deepEqual(parsePgnForSearch('1. e4 ; ignore this\ne5 *').uci, ['e2e4', 'e7e5'])
})

test('PGN parsing enforces every structural and chess bound', () => {
  assert.throws(() => parsePgnForSearch('1. e4\u0007 *'), /control/u)
  assert.throws(() => parsePgnForSearch(`1. e4 ${String.fromCharCode(0xd800)} *`), /malformed Unicode/u)
  assert.throws(() => parsePgnForSearch('x'.repeat(4_097)), /lines are limited/u)
  const headers = Array.from({ length: 65 }, (_, index) => `[H${index} "value"]`).join('\n')
  assert.throws(() => parsePgnForSearch(`${headers}\n\n1. e4 *`), /64 headers/u)
  assert.throws(() => parsePgnForSearch(`[Event "${'x'.repeat(129)}"]\n\n1. e4 *`), /tokens are limited/u)
  assert.throws(() => parsePgnForSearch('[Event "test"]\n1. e4 *'), /comment|malformed/u)
  assert.throws(() => parsePgnForSearch('1. e4 } e5 *'), /comment/u)
  assert.throws(() => parsePgnForSearch('1. e4 e5 2. Qh5 Nc6 3. Qh9 *'), /malformed/u)
  assert.throws(() => parsePgnForSearch('[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]\n\n1. Ka2 *'), /standard initial/u)
  assert.throws(() => parsePgnForSearch('[FEN "invalid"]\n\n1. e4 *'), /standard initial|malformed/u)
  assert.deepEqual(parsePgnForSearch('[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]\n\n1. e4 *').uci, ['e2e4'])
  assert.throws(() => parsePgnForSearch('[Event "empty"]\n\n*'), /does not contain/u)
  const longGame = Array.from({ length: 50 }, () => 'Nf3 Nf6 Ng1 Ng8').join(' ')
  assert.throws(() => parsePgnForSearch(`${longGame} Nf3 *`), /200 plies/u)
})

test('opening search finds text, move prefixes, and transpositions deterministically', () => {
  const entries: OpeningSearchEntry[] = [
    {
      sourceLineId: 'a', eco: 'C20', name: 'King Pawn Game', pgn: '1. e4 e5',
      uci: ['e2e4', 'e7e5'], terminalEpd: parseMoveSequence('e4 e5').epds.at(-1)!,
      terminalSampleSize: 1000, backtestEligible: true, verifiedVariantIds: [],
    },
    {
      sourceLineId: 'b', eco: 'A04', name: 'Reti Opening', pgn: '1. Nf3 d5 2. g3',
      uci: ['g1f3', 'd7d5', 'g2g3'], terminalEpd: parseMoveSequence('g3 d5 Nf3').epds.at(-1)!,
      terminalSampleSize: 500, backtestEligible: true, verifiedVariantIds: [],
    },
  ]
  assert.equal(searchOpenings(entries, 'king pawn')[0]?.sourceLineId, 'a')
  assert.equal(searchOpenings(entries, '', parseMoveSequence('e4 e5 Nf3'))[0]?.matchKind, 'move_prefix')
  assert.equal(searchOpenings(entries, '', parseMoveSequence('g3 d5 Nf3'))[0]?.matchKind, 'transposition')
  assert.deepEqual(searchOpenings(entries, ''), [])
  assert.deepEqual(searchOpenings(entries, '', parseMoveSequence('d4 d5')), [])
  assert.throws(() => searchOpenings(entries, 'king', undefined, 0), /limit is invalid/u)
  assert.throws(() => searchOpenings(entries, 'king', undefined, 501), /limit is invalid/u)
  assert.throws(() => searchOpenings(entries, 'king', undefined, 1.5), /limit is invalid/u)
})

test('text search is accent-insensitive, term-complete, sample-ranked, and ECO-exact', () => {
  const terminal = parseMoveSequence('e4').epds.at(-1)!
  const entries: OpeningSearchEntry[] = [
    { sourceLineId: 'low', eco: 'C20', name: 'Réti idea', pgn: '1. e4', uci: ['e2e4'], terminalEpd: terminal, terminalSampleSize: 10, backtestEligible: false, verifiedVariantIds: [] },
    { sourceLineId: 'high', eco: 'B00', name: 'Reti idea', pgn: '1. e4', uci: ['e2e4'], terminalEpd: terminal, terminalSampleSize: 100, backtestEligible: false, verifiedVariantIds: [] },
    { sourceLineId: 'eco', eco: 'A00', name: 'Uncommon', pgn: '1. e4', uci: ['e2e4'], terminalEpd: terminal, terminalSampleSize: 1, backtestEligible: false, verifiedVariantIds: [] },
  ]
  assert.deepEqual(searchOpenings(entries, 'reti idea').map((entry) => entry.sourceLineId), ['high', 'low'])
  assert.equal(searchOpenings(entries, 'A00')[0]?.sourceLineId, 'eco')
  assert.deepEqual(searchOpenings(entries, 'reti missing'), [])
})

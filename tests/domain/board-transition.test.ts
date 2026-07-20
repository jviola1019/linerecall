import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess } from 'chess.js'
import {
  applyVisualMove,
  findVisualMoveSequence,
  squareVisualCoordinates,
  visualPiecesFromFen,
} from '../../src/domain/board-transition.ts'

function pieceAt(fen: string, square: string): string | null {
  const piece = new Chess(fen).get(square as never)
  return piece ? `${piece.color}${piece.type}` : null
}

test('keeps a stable visual identity while applying a normal move and capture', () => {
  const initial = new Chess().fen()
  const pieces = visualPiecesFromFen(initial)
  const pawnId = pieces.find((piece) => piece.square === 'e2')?.id
  const afterE4 = applyVisualMove(initial, pieces, 'e2e4')
  assert.equal(afterE4.pieces.find((piece) => piece.square === 'e4')?.id, pawnId)
  assert.deepEqual(afterE4.capturedPieceIds, [])

  const captureStart = new Chess('8/8/8/3p4/4P3/8/8/4K2k w - - 0 1').fen()
  const capturePieces = visualPiecesFromFen(captureStart)
  const capturedId = capturePieces.find((piece) => piece.square === 'd5')?.id
  const capture = applyVisualMove(captureStart, capturePieces, 'e4d5')
  assert.deepEqual(capture.capturedPieceIds, [capturedId])
  assert.equal(pieceAt(capture.fen, 'd5'), 'wp')
})

test('moves both stable pieces during castling', () => {
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'
  const pieces = visualPiecesFromFen(fen)
  const kingId = pieces.find((piece) => piece.square === 'e1')?.id
  const rookId = pieces.find((piece) => piece.square === 'h1')?.id
  const result = applyVisualMove(fen, pieces, 'e1g1')
  assert.equal(result.pieces.find((piece) => piece.square === 'g1')?.id, kingId)
  assert.equal(result.pieces.find((piece) => piece.square === 'f1')?.id, rookId)

  const blackPieces = visualPiecesFromFen(fen)
  const blackKingId = blackPieces.find((piece) => piece.square === 'e8')?.id
  const blackRookId = blackPieces.find((piece) => piece.square === 'a8')?.id
  const blackCastle = applyVisualMove(fen.replace(' w ', ' b '), blackPieces, 'e8c8')
  assert.equal(blackCastle.pieces.find((piece) => piece.square === 'c8')?.id, blackKingId)
  assert.equal(blackCastle.pieces.find((piece) => piece.square === 'd8')?.id, blackRookId)
})

test('removes the en-passant pawn from its actual square', () => {
  const fen = '8/8/8/3pP3/8/8/8/4K2k w - d6 0 2'
  const pieces = visualPiecesFromFen(fen)
  const capturedId = pieces.find((piece) => piece.square === 'd5')?.id
  const result = applyVisualMove(fen, pieces, 'e5d6')
  assert.deepEqual(result.capturedPieceIds, [capturedId])
  assert.equal(result.pieces.some((piece) => piece.square === 'd5'), false)
  assert.equal(pieceAt(result.fen, 'd6'), 'wp')
})

test('records promotion so the UI can glide the pawn before crossfading', () => {
  const fen = '8/P7/8/8/8/8/7p/4K2k w - - 0 1'
  const pieces = visualPiecesFromFen(fen)
  const pawnId = pieces.find((piece) => piece.square === 'a7')?.id
  const result = applyVisualMove(fen, pieces, 'a7a8q')
  assert.deepEqual(result.promotion, { pieceId: pawnId, fromType: 'p', toType: 'q' })
  assert.equal(result.pieces.find((piece) => piece.square === 'a8')?.id, pawnId)
  assert.equal(result.pieces.find((piece) => piece.square === 'a8')?.type, 'q')
})

test('recognizes one- and two-ply transitions but resets unrelated positions', () => {
  const start = new Chess()
  const initial = start.fen()
  start.move('e4')
  const onePly = start.fen()
  start.move('c5')
  const twoPly = start.fen()
  assert.deepEqual(findVisualMoveSequence(initial, onePly, 'e2e4'), ['e2e4'])
  assert.deepEqual(findVisualMoveSequence(initial, twoPly, 'e2e4'), ['e2e4', 'c7c5'])
  assert.deepEqual(findVisualMoveSequence(initial, initial), [])
  assert.deepEqual(findVisualMoveSequence(initial, onePly), ['e2e4'])
  assert.deepEqual(findVisualMoveSequence(initial, onePly, 'a2a3'), ['e2e4'])
  assert.equal(findVisualMoveSequence(initial, '8/8/8/8/8/8/8/4K2k w - - 0 1'), null)
  assert.throws(() => findVisualMoveSequence(initial, 'not-a-fen'), /four fields/u)
})

test('fails closed for malformed input and visual-state corruption', () => {
  const initial = new Chess().fen()
  const pieces = visualPiecesFromFen(initial)
  assert.throws(() => applyVisualMove(initial, pieces, 'e2-e4'), /Invalid UCI/u)
  assert.throws(() => applyVisualMove(initial, pieces.filter((piece) => piece.square !== 'e2'), 'e2e4'), /No visual piece/u)
  assert.throws(() => applyVisualMove(initial, pieces, 'e2e5'), /Invalid move/u)

  const castleFen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'
  const withoutRook = visualPiecesFromFen(castleFen).filter((piece) => piece.square !== 'a1')
  assert.throws(() => applyVisualMove(castleFen, withoutRook, 'e1c1'), /missing its visual rook/u)

  const extraPiece = [...pieces, { ...pieces[0]!, id: 'unexpected-duplicate' }]
  assert.throws(() => applyVisualMove(initial, extraPiece, 'e2e4'), /did not reconcile/u)
})

test('maps squares correctly for each board orientation', () => {
  assert.deepEqual(squareVisualCoordinates('a8', 'white'), { column: 0, row: 0 })
  assert.deepEqual(squareVisualCoordinates('h1', 'white'), { column: 7, row: 7 })
  assert.deepEqual(squareVisualCoordinates('a8', 'black'), { column: 7, row: 7 })
  assert.deepEqual(squareVisualCoordinates('h1', 'black'), { column: 0, row: 0 })
})

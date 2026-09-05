import assert from 'node:assert/strict'
import test from 'node:test'
import { Chess } from 'chess.js'
import {
  algebraicSquare,
  applyLegalMove,
  boardSquares,
  legalMoveOptions,
  legalTargetSquares,
  moveBoardFocus,
  squareAccessibleName,
  squareAccessibleNameForPiece,
  squareFromPointer,
} from '../../src/domain/board.ts'

test('board order and arrow navigation follow visual orientation', () => {
  assert.equal(boardSquares('white')[0], 'a8')
  assert.equal(boardSquares('black')[0], 'h1')
  assert.equal(moveBoardFocus('e4', 'ArrowUp', 'white'), 'e5')
  assert.equal(moveBoardFocus('e4', 'ArrowUp', 'black'), 'e3')
  assert.equal(moveBoardFocus('a8', 'ArrowUp', 'white'), 'a8')
  assert.equal(moveBoardFocus('e4', 'ArrowDown', 'white'), 'e3')
  assert.equal(moveBoardFocus('e4', 'ArrowLeft', 'white'), 'd4')
  assert.equal(moveBoardFocus('e4', 'ArrowRight', 'white'), 'f4')
  assert.equal(moveBoardFocus('h1', 'ArrowDown', 'white'), 'h1')
  assert.throws(() => moveBoardFocus('z9' as never, 'ArrowUp', 'white'), /not on the board/u)
})

test('legal targets and accessible names come from chess.js', () => {
  const fen = new Chess().fen()
  assert.deepEqual(legalTargetSquares(fen, 'e2'), ['e3', 'e4'])
  assert.equal(squareAccessibleName(fen, 'g1'), 'g1, White knight')
  assert.equal(squareAccessibleName(fen, 'a7'), 'a7, Black pawn')
  assert.equal(squareAccessibleName(fen, 'e4'), 'e4, empty')
  assert.equal(squareAccessibleNameForPiece('g1', { color: 'w', type: 'n' }), 'g1, White knight')
  assert.equal(squareAccessibleNameForPiece('e4', undefined), 'e4, empty')
  assert.equal(applyLegalMove(fen, 'e2e4').san, 'e4')
  assert.throws(() => applyLegalMove(fen, 'e2e5'), /not legal/u)
  assert.throws(() => applyLegalMove(fen, 'not-a-move'), /UCI notation/u)
})

test('castling, en passant, and promotion appear in the equivalent move picker', () => {
  const castle = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1')
  assert.ok(legalMoveOptions(castle.fen(), 'e1').some((move) => move.san === 'O-O'))

  const enPassant = new Chess()
  enPassant.move('e4'); enPassant.move('a6'); enPassant.move('e5'); enPassant.move('d5')
  assert.ok(legalMoveOptions(enPassant.fen(), 'e5').some((move) => move.to === 'd6'))

  const promotion = new Chess('8/P7/8/8/8/8/7p/4K2k w - - 0 1')
  const promotions = legalMoveOptions(promotion.fen(), 'a7').filter((move) => move.to === 'a8')
  assert.deepEqual(promotions.map((move) => move.promotion).sort(), ['b', 'n', 'q', 'r'])
  assert.ok(promotions.every((move) => move.label.includes('promote to')))
  assert.equal(applyLegalMove(promotion.fen(), 'a7a8q').san, 'a8=Q+')
})

test('pointer coordinates map to the same squares as keyboard order', () => {
  const bounds = { left: 10, top: 20, width: 320, height: 320 }
  assert.equal(squareFromPointer(30, 40, bounds, 'white'), 'a8')
  assert.equal(squareFromPointer(30, 40, bounds, 'black'), 'h1')
  assert.equal(squareFromPointer(500, 500, bounds, 'white'), null)
  assert.equal(squareFromPointer(9, 20, bounds, 'white'), null)
  assert.equal(squareFromPointer(10, 340, bounds, 'white'), null)
  assert.equal(squareFromPointer(10, 20, { ...bounds, width: 0 }, 'white'), null)
  assert.equal(squareFromPointer(10, 20, { ...bounds, height: -1 }, 'white'), null)
})

test('algebraic square conversion rejects every off-board coordinate', () => {
  assert.equal(algebraicSquare(0, 1), 'a1')
  assert.equal(algebraicSquare(7, 8), 'h8')
  assert.equal(algebraicSquare(-1, 1), null)
  assert.equal(algebraicSquare(8, 1), null)
  assert.equal(algebraicSquare(0, 0), null)
  assert.equal(algebraicSquare(0, 9), null)
})

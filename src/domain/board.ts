import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js'

export type BoardOrientation = 'white' | 'black'
export type BoardArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

export interface LegalMoveOption {
  uci: string
  san: string
  from: Square
  to: Square
  promotion: PieceSymbol | null
  label: string
}

const FILES = 'abcdefgh'
const PIECES: Readonly<Record<PieceSymbol, string>> = Object.freeze({
  p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
})

function squareAt(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 1 || rank > 8) return null
  return `${FILES[file]}${rank}` as Square
}

function coordinates(square: Square): { file: number; rank: number } {
  const file = FILES.indexOf(square[0] ?? '')
  const rank = Number(square[1])
  if (file < 0 || rank < 1 || rank > 8) throw new Error(`Invalid board square ${square}`)
  return { file, rank }
}

export function boardSquares(orientation: BoardOrientation): Square[] {
  const ranks = orientation === 'white' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8]
  const files = orientation === 'white' ? [...FILES] : [...FILES].reverse()
  return ranks.flatMap((rank) => files.map((file) => `${file}${rank}` as Square))
}

export function moveBoardFocus(
  square: Square,
  key: BoardArrowKey,
  orientation: BoardOrientation,
): Square {
  const squares = boardSquares(orientation)
  const index = squares.indexOf(square)
  if (index < 0) throw new Error(`Square ${square} is not on the board`)
  const row = Math.floor(index / 8)
  const column = index % 8
  const nextRow = key === 'ArrowUp' ? row - 1 : key === 'ArrowDown' ? row + 1 : row
  const nextColumn = key === 'ArrowLeft' ? column - 1 : key === 'ArrowRight' ? column + 1 : column
  if (nextRow < 0 || nextRow > 7 || nextColumn < 0 || nextColumn > 7) return square
  return squares[nextRow * 8 + nextColumn] ?? square
}

function colorName(color: Color): string {
  return color === 'w' ? 'White' : 'Black'
}

export function squareAccessibleName(fen: string, square: Square): string {
  const chess = new Chess(fen)
  return squareAccessibleNameForPiece(square, chess.get(square))
}

/**
 * Format a square from an already-validated board position. Board rendering
 * calls this for all 64 cells, so accepting the piece avoids reparsing the
 * same FEN 64 times while preserving the public single-square helper above.
 */
export function squareAccessibleNameForPiece(
  square: Square,
  piece: { color: Color; type: PieceSymbol } | undefined,
): string {
  return piece ? `${square}, ${colorName(piece.color)} ${PIECES[piece.type]}` : `${square}, empty`
}

function promotionName(piece: PieceSymbol | undefined): string {
  return piece ? `, promote to ${PIECES[piece]}` : ''
}

function optionFor(move: ReturnType<Chess['moves']>[number] & { from: Square; to: Square; san: string; promotion?: PieceSymbol }): LegalMoveOption {
  const promotion = move.promotion ?? null
  return {
    uci: `${move.from}${move.to}${move.promotion ?? ''}`,
    san: move.san,
    from: move.from,
    to: move.to,
    promotion,
    label: `${move.san}: ${move.from} to ${move.to}${promotionName(move.promotion)}`,
  }
}

export function legalMoveOptions(fen: string, from?: Square): LegalMoveOption[] {
  const chess = new Chess(fen)
  const moves = chess.moves({ verbose: true, ...(from ? { square: from } : {}) })
  return moves.map((move) => optionFor(move)).sort((left, right) =>
    left.from.localeCompare(right.from, 'en') || left.to.localeCompare(right.to, 'en') ||
    (left.promotion ?? '').localeCompare(right.promotion ?? '', 'en')
  )
}

export function legalTargetSquares(fen: string, from: Square): Square[] {
  return [...new Set(legalMoveOptions(fen, from).map((move) => move.to))]
    .sort((left, right) => left.localeCompare(right, 'en'))
}

export function applyLegalMove(fen: string, uci: string): { fen: string; san: string; uci: string } {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(uci)) throw new Error('Move must use UCI notation')
  const from = uci.slice(0, 2) as Square
  const to = uci.slice(2, 4) as Square
  const promotion = uci[4] as PieceSymbol | undefined
  const chess = new Chess(fen)
  try {
    const move = chess.move({ from, to, ...(promotion ? { promotion } : {}) })
    if (!move) throw new Error('move returned null')
    return { fen: chess.fen(), san: move.san, uci: `${move.from}${move.to}${move.promotion ?? ''}` }
  } catch {
    throw new Error(`Move ${uci} is not legal in this position`)
  }
}

export function squareFromPointer(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  orientation: BoardOrientation,
): Square | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null
  const column = Math.floor(((clientX - bounds.left) / bounds.width) * 8)
  const row = Math.floor(((clientY - bounds.top) / bounds.height) * 8)
  if (column < 0 || column > 7 || row < 0 || row > 7) return null
  return boardSquares(orientation)[row * 8 + column] ?? null
}

export function algebraicSquare(file: number, rank: number): Square | null {
  return squareAt(file, rank)
}

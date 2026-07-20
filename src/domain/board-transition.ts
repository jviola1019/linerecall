import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js'

export interface VisualPiece {
  id: string
  color: Color
  type: PieceSymbol
  square: Square
}

export interface VisualPromotion {
  pieceId: string
  fromType: PieceSymbol
  toType: PieceSymbol
}

export interface AppliedVisualMove {
  fen: string
  uci: string
  pieces: VisualPiece[]
  capturedPieceIds: string[]
  promotion: VisualPromotion | null
}

function fenPositionKey(fen: string): string {
  const fields = fen.trim().split(/\s+/u)
  if (fields.length < 4) throw new Error('A FEN position requires at least four fields')
  return fields.slice(0, 4).join(' ')
}

function uciParts(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(uci)) throw new Error(`Invalid UCI move: ${uci}`)
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

function moveUci(move: ReturnType<Chess['move']>): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`
}

export function visualPiecesFromFen(fen: string): VisualPiece[] {
  const chess = new Chess(fen)
  const pieces: VisualPiece[] = []
  for (const rank of '12345678') {
    for (const file of 'abcdefgh') {
      const square = `${file}${rank}` as Square
      const piece = chess.get(square)
      if (!piece) continue
      pieces.push({
        id: `${piece.color}${piece.type}-${square}`,
        color: piece.color,
        type: piece.type,
        square,
      })
    }
  }
  return pieces
}

export function applyVisualMove(
  beforeFen: string,
  pieces: readonly VisualPiece[],
  uci: string,
): AppliedVisualMove {
  const chess = new Chess(beforeFen)
  const requested = uciParts(uci)
  const movingPiece = pieces.find((piece) => piece.square === requested.from)
  if (!movingPiece) throw new Error(`No visual piece exists on ${requested.from}`)

  const move = chess.move(requested)
  const normalizedUci = moveUci(move)
  // UCI parsing and chess.js legality jointly guarantee this invariant. Keep
  // it explicit so a future chess library change fails closed.
  /* c8 ignore next 1 -- unreachable unless chess.js returns a move different from the requested legal UCI */
  if (normalizedUci !== uci) throw new Error(`Move normalization mismatch: expected ${uci}, received ${normalizedUci}`)

  const capturedSquare = move.flags.includes('e')
    ? `${move.to[0]}${move.from[1]}` as Square
    : move.captured
      ? move.to
      : null
  const capturedPieceIds = capturedSquare === null
    ? []
    : pieces.filter((piece) => piece.square === capturedSquare && piece.id !== movingPiece.id).map((piece) => piece.id)

  const rookMove = move.flags.includes('k')
    ? {
        from: `${move.color === 'w' ? 'h1' : 'h8'}` as Square,
        to: `${move.color === 'w' ? 'f1' : 'f8'}` as Square,
      }
    : move.flags.includes('q')
      ? {
          from: `${move.color === 'w' ? 'a1' : 'a8'}` as Square,
          to: `${move.color === 'w' ? 'd1' : 'd8'}` as Square,
        }
      : null
  const rookPiece = rookMove ? pieces.find((piece) => piece.square === rookMove.from && piece.type === 'r' && piece.color === move.color) : null
  if (rookMove && !rookPiece) throw new Error('Castling position is missing its visual rook')

  const piecesAfter = pieces
    .filter((piece) => !capturedPieceIds.includes(piece.id))
    .map((piece): VisualPiece => {
      if (piece.id === movingPiece.id) {
        return { ...piece, square: move.to, type: move.promotion ?? piece.type }
      }
      if (rookMove && rookPiece && piece.id === rookPiece.id) return { ...piece, square: rookMove.to }
      return piece
    })
  const promotion = move.promotion
    ? { pieceId: movingPiece.id, fromType: movingPiece.type, toType: move.promotion }
    : null

  const expectedPieces = visualPiecesFromFen(chess.fen())
  const expectedPosition = expectedPieces
    .map((piece) => `${piece.color}${piece.type}${piece.square}`)
    .sort()
    .join('|')
  const actualPosition = piecesAfter
    .map((piece) => `${piece.color}${piece.type}${piece.square}`)
    .sort()
    .join('|')
  if (actualPosition !== expectedPosition) throw new Error('Visual move did not reconcile with the legal chess position')

  return {
    fen: chess.fen(),
    uci,
    pieces: piecesAfter,
    capturedPieceIds,
    promotion,
  }
}

function orderedLegalMoves(chess: Chess, preferredUci?: string | null): string[] {
  const moves = chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ''}`)
  if (!preferredUci || !moves.includes(preferredUci)) return moves
  return [preferredUci, ...moves.filter((move) => move !== preferredUci)]
}

/**
 * Find a short legal sequence that explains a React FEN update. Training can
 * advance by the learner move plus one automatic opponent reply, so two plies
 * are intentionally supported. Unrelated position changes return null and are
 * rendered as a non-animated reset.
 */
export function findVisualMoveSequence(
  beforeFen: string,
  afterFen: string,
  preferredFirstUci?: string | null,
): string[] | null {
  if (fenPositionKey(beforeFen) === fenPositionKey(afterFen)) return []
  const target = fenPositionKey(afterFen)
  const position = new Chess(beforeFen)
  for (const firstUci of orderedLegalMoves(position, preferredFirstUci)) {
    position.move(uciParts(firstUci))
    if (fenPositionKey(position.fen()) === target) return [firstUci]
    for (const secondUci of orderedLegalMoves(position)) {
      position.move(uciParts(secondUci))
      if (fenPositionKey(position.fen()) === target) return [firstUci, secondUci]
      position.undo()
    }
    position.undo()
  }
  return null
}

export function squareVisualCoordinates(
  square: Square,
  orientation: 'white' | 'black',
): { column: number; row: number } {
  const file = square.charCodeAt(0) - 97
  const rank = Number(square[1]) - 1
  return orientation === 'white'
    ? { column: file, row: 7 - rank }
    : { column: 7 - file, row: rank }
}

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import {
  boardSquares,
  legalMoveOptions,
  legalTargetSquares,
  moveBoardFocus,
  squareAccessibleName,
  squareAccessibleNameForPiece,
  squareFromPointer,
  type BoardArrowKey,
  type BoardOrientation,
  type LegalMoveOption,
} from '../../domain/board.ts'
import {
  applyVisualMove,
  findVisualMoveSequence,
  visualPiecesFromFen,
  type VisualPiece,
  type VisualPromotion,
} from '../../domain/board-transition.ts'
import type { MoveEvidence } from '../../domain/opening-data.ts'
import blackBishop from '../../assets/chessnut/bB.svg'
import blackKing from '../../assets/chessnut/bK.svg'
import blackKnight from '../../assets/chessnut/bN.svg'
import blackPawn from '../../assets/chessnut/bP.svg'
import blackQueen from '../../assets/chessnut/bQ.svg'
import blackRook from '../../assets/chessnut/bR.svg'
import whiteBishop from '../../assets/chessnut/wB.svg'
import whiteKing from '../../assets/chessnut/wK.svg'
import whiteKnight from '../../assets/chessnut/wN.svg'
import whitePawn from '../../assets/chessnut/wP.svg'
import whiteQueen from '../../assets/chessnut/wQ.svg'
import whiteRook from '../../assets/chessnut/wR.svg'

const PIECE_IMAGES = Object.freeze({
  wp: whitePawn,
  wn: whiteKnight,
  wb: whiteBishop,
  wr: whiteRook,
  wq: whiteQueen,
  wk: whiteKing,
  bp: blackPawn,
  bn: blackKnight,
  bb: blackBishop,
  br: blackRook,
  bq: blackQueen,
  bk: blackKing,
})

const PROMOTION_NAMES: Readonly<Record<PieceSymbol, string>> = Object.freeze({
  q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn', k: 'King',
})

export type BoardMoveStatus = MoveEvidence['classification'] | 'illegal'

export interface ChessBoardProps {
  fen: string
  orientation: BoardOrientation
  disabled?: boolean
  reducedMotion?: boolean
  hintUci?: string | null
  lastMove?: { uci: string; status: BoardMoveStatus } | null
  boardOverlay?: ReactNode
  onMove: (uci: string) => void
  onAnnouncement?: (message: string) => void
}

interface DragState {
  from: Square
  startX: number
  startY: number
}

interface RenderVisualPiece extends VisualPiece {
  exiting?: boolean
}

interface PromotionVisual extends VisualPromotion {
  phase: 'travel' | 'crossfade'
}

const MOVE_TRANSITION_MS = 170
const PROMOTION_CROSSFADE_MS = 90

function optionUci(from: Square, to: Square, promotion?: PieceSymbol): string {
  return `${from}${to}${promotion ?? ''}`
}

function isArrowKey(key: string): key is BoardArrowKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
}

function squareCenter(square: Square, orientation: BoardOrientation): { x: number; y: number } {
  const file = square.charCodeAt(0) - 97
  const rank = Number(square[1]) - 1
  const column = orientation === 'white' ? file : 7 - file
  const row = orientation === 'white' ? 7 - rank : rank
  return { x: (column + 0.5) * 12.5, y: (row + 0.5) * 12.5 }
}

function safeGuideMove(uci: string | null | undefined): { from: Square; to: Square } | null {
  if (!uci || !/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(uci)) return null
  return { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
}

export function ChessBoard({
  fen,
  orientation,
  disabled = false,
  reducedMotion = false,
  hintUci = null,
  lastMove = null,
  boardOverlay = null,
  onMove,
  onAnnouncement,
}: ChessBoardProps): React.JSX.Element {
  const instructionsId = useId()
  const guideDescriptionId = useId()
  const pickerId = useId()
  const chess = useMemo(() => new Chess(fen), [fen])
  const squares = useMemo(() => boardSquares(orientation), [orientation])
  const allMoves = useMemo(() => legalMoveOptions(fen), [fen])
  const [focusedSquare, setFocusedSquare] = useState<Square>('e2')
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const [hoveredSquare, setHoveredSquare] = useState<Square | null>(null)
  const [pickerMove, setPickerMove] = useState(allMoves[0]?.uci ?? '')
  const [promotionOptions, setPromotionOptions] = useState<LegalMoveOption[]>([])
  const [localAnnouncement, setLocalAnnouncement] = useState('')
  const squareRefs = useRef(new Map<Square, HTMLButtonElement>())
  const boardRegionRef = useRef<HTMLElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const suppressClickRef = useRef(false)
  const suppressClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const promotionButtonRef = useRef<HTMLButtonElement>(null)
  const promotionDialogRef = useRef<HTMLDivElement>(null)
  const promotionReturnFocusRef = useRef<HTMLElement | null>(null)
  const visualStateRef = useRef({ fen, pieces: visualPiecesFromFen(fen) })
  const animationGenerationRef = useRef(0)
  const previousOrientationRef = useRef(orientation)
  const [renderPieces, setRenderPieces] = useState<RenderVisualPiece[]>(() => visualStateRef.current.pieces)
  const [promotionVisual, setPromotionVisual] = useState<PromotionVisual | null>(null)
  const [suppressSpatialMotion, setSuppressSpatialMotion] = useState(false)
  const [systemReducedMotion, setSystemReducedMotion] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  )
  const motionDisabled = reducedMotion || systemReducedMotion

  const announce = (message: string): void => {
    if (onAnnouncement) onAnnouncement(message)
    else setLocalAnnouncement(message)
  }

  useEffect(() => {
    setSelectedSquare(null)
    setPromotionOptions([])
    setPickerMove(allMoves[0]?.uci ?? '')
    if (!disabled) {
      setFocusedSquare((current) => {
        const movableSources = new Set(allMoves.map((move) => move.from))
        if (movableSources.has(current)) return current
        const preferred = chess.turn() === 'w'
          ? ['e2', 'd2', 'g1', 'b1'] as const
          : ['e7', 'd7', 'g8', 'b8'] as const
        return preferred.find((square) => movableSources.has(square))
          ?? allMoves[0]?.from
          ?? squares[0]
          ?? 'a1'
      })
    }
  }, [allMoves, chess, disabled, fen, squares])

  useEffect(() => () => {
    if (suppressClickTimerRef.current !== null) clearTimeout(suppressClickTimerRef.current)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setSystemReducedMotion(query.matches)
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])

  useLayoutEffect(() => {
    if (previousOrientationRef.current === orientation) return
    previousOrientationRef.current = orientation
    setSuppressSpatialMotion(true)
    const frame = requestAnimationFrame(() => setSuppressSpatialMotion(false))
    return () => cancelAnimationFrame(frame)
  }, [orientation])

  useEffect(() => {
    const generation = ++animationGenerationRef.current
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const frames = new Set<number>()
    const clearPending = (): void => {
      for (const timer of timers) clearTimeout(timer)
      for (const frame of frames) cancelAnimationFrame(frame)
      timers.clear()
      frames.clear()
    }
    const commitReset = (): void => {
      const pieces = visualPiecesFromFen(fen)
      visualStateRef.current = { fen, pieces }
      setPromotionVisual(null)
      setSuppressSpatialMotion(true)
      setRenderPieces(pieces)
      const frame = requestAnimationFrame(() => {
        frames.delete(frame)
        if (animationGenerationRef.current === generation) setSuppressSpatialMotion(false)
      })
      frames.add(frame)
    }

    const current = visualStateRef.current
    let sequence: string[] | null
    try {
      sequence = findVisualMoveSequence(current.fen, fen, lastMove?.uci)
    } catch {
      sequence = null
    }
    if (sequence === null) {
      commitReset()
      return clearPending
    }
    if (sequence.length === 0) return clearPending
    if (motionDisabled) {
      // Reduced motion changes presentation, not identity. Replay the same
      // validated legal moves synchronously so pieces, captures, castling, and
      // promotions retain their stable IDs without exposing a transition.
      try {
        let next = current
        for (const uci of sequence) {
          const applied = applyVisualMove(next.fen, next.pieces, uci)
          next = { fen: applied.fen, pieces: applied.pieces }
        }
        visualStateRef.current = { fen, pieces: next.pieces }
        setPromotionVisual(null)
        setSuppressSpatialMotion(true)
        setRenderPieces(next.pieces)
        const frame = requestAnimationFrame(() => {
          frames.delete(frame)
          if (animationGenerationRef.current === generation) setSuppressSpatialMotion(false)
        })
        frames.add(frame)
      } catch {
        commitReset()
      }
      return clearPending
    }

    const runMove = (index: number): void => {
      if (animationGenerationRef.current !== generation) return
      const uci = sequence?.[index]
      if (!uci) return
      const before = visualStateRef.current
      let applied
      try {
        applied = applyVisualMove(before.fen, before.pieces, uci)
      } catch {
        commitReset()
        return
      }
      const captured = before.pieces
        .filter((piece) => applied.capturedPieceIds.includes(piece.id))
        .map((piece): RenderVisualPiece => ({ ...piece, exiting: true }))
      visualStateRef.current = { fen: applied.fen, pieces: applied.pieces }
      setPromotionVisual(applied.promotion ? { ...applied.promotion, phase: 'travel' } : null)
      const frame = requestAnimationFrame(() => {
        frames.delete(frame)
        if (animationGenerationRef.current !== generation) return
        setRenderPieces([...applied.pieces, ...captured])
        const movementTimer = setTimeout(() => {
          timers.delete(movementTimer)
          if (animationGenerationRef.current !== generation) return
          setRenderPieces(applied.pieces)
          const continueSequence = (): void => {
            if (index + 1 < (sequence?.length ?? 0)) runMove(index + 1)
          }
          if (!applied.promotion) {
            continueSequence()
            return
          }
          setPromotionVisual({ ...applied.promotion, phase: 'crossfade' })
          const promotionTimer = setTimeout(() => {
            timers.delete(promotionTimer)
            if (animationGenerationRef.current !== generation) return
            setPromotionVisual(null)
            continueSequence()
          }, PROMOTION_CROSSFADE_MS)
          timers.add(promotionTimer)
        }, MOVE_TRANSITION_MS)
        timers.add(movementTimer)
      })
      frames.add(frame)
    }
    runMove(0)
    return clearPending
  }, [fen, lastMove?.uci, motionDisabled])

  useEffect(() => {
    if (!squares.includes(focusedSquare)) setFocusedSquare(squares[0] ?? 'a1')
  }, [focusedSquare, squares])

  useEffect(() => {
    if (promotionOptions.length > 0) promotionButtonRef.current?.focus()
  }, [promotionOptions])

  useLayoutEffect(() => {
    if (promotionOptions.length === 0) return
    const backdrop = promotionDialogRef.current?.parentElement ?? null
    const background = [...document.body.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({
        element,
        wasInert: element.hasAttribute('inert'),
        priorAriaHidden: element.getAttribute('aria-hidden'),
      }))
    for (const { element } of background) {
      element.setAttribute('inert', '')
      element.setAttribute('aria-hidden', 'true')
    }
    return () => {
      for (const { element, wasInert, priorAriaHidden } of background) {
        if (!wasInert) element.removeAttribute('inert')
        if (priorAriaHidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', priorAriaHidden)
      }
    }
  }, [promotionOptions.length])

  const selectSquare = (square: Square): void => {
    if (disabled) return
    const piece = chess.get(square)
    const options = legalMoveOptions(fen, square)
    if (!piece || piece.color !== chess.turn() || options.length === 0) {
      announce(`${squareAccessibleName(fen, square)} has no legal moves.`)
      return
    }
    setSelectedSquare(square)
    const targets = legalTargetSquares(fen, square)
    announce(`${squareAccessibleName(fen, square)} selected. Legal targets: ${targets.join(', ')}.`)
  }

  const attemptDestination = (from: Square, to: Square): boolean => {
    const options = allMoves.filter((move) => move.from === from && move.to === to)
    if (options.length === 0) {
      announce(`${to} is not a legal target from ${from}.`)
      return false
    }
    if (options.length > 1) {
      promotionReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      setPromotionOptions(options)
      announce(`Choose a promotion piece for ${from} to ${to}.`)
      return true
    }
    const option = options[0]
    if (!option) return false
    setSelectedSquare(null)
    announce(`Playing ${option.label}.`)
    onMove(option.uci)
    return true
  }

  const activateSquare = (square: Square): void => {
    if (disabled) return
    if (selectedSquare === null) {
      selectSquare(square)
      return
    }
    if (selectedSquare === square) {
      setSelectedSquare(null)
      announce(`${square} deselected.`)
      return
    }
    if (attemptDestination(selectedSquare, square)) return
    const replacement = chess.get(square)
    if (replacement?.color === chess.turn()) selectSquare(square)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, square: Square): void => {
    if (isArrowKey(event.key)) {
      event.preventDefault()
      const next = moveBoardFocus(square, event.key, orientation)
      setFocusedSquare(next)
      squareRefs.current.get(next)?.focus()
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? squares[0] : squares.at(-1)
      if (next) {
        setFocusedSquare(next)
        squareRefs.current.get(next)?.focus()
      }
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activateSquare(square)
    }
  }

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>, square: Square): void => {
    if (disabled || event.button !== 0) return
    const piece = chess.get(square)
    if (!piece || piece.color !== chess.turn() || legalMoveOptions(fen, square).length === 0) return
    dragRef.current = { from: square, startX: event.clientX, startY: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || !boardRef.current || disabled) return
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5
    if (!moved) return
    const target = squareFromPointer(
      event.clientX,
      event.clientY,
      boardRef.current.getBoundingClientRect(),
      orientation,
    )
    suppressClickRef.current = true
    if (suppressClickTimerRef.current !== null) clearTimeout(suppressClickTimerRef.current)
    suppressClickTimerRef.current = setTimeout(() => {
      suppressClickRef.current = false
      suppressClickTimerRef.current = null
    }, 0)
    if (target === null || !attemptDestination(drag.from, target)) {
      setSelectedSquare(null)
      announce('The dragged piece was not moved to a legal target.')
    }
  }

  const handlePointerCancel = (): void => {
    dragRef.current = null
    suppressClickRef.current = false
    if (suppressClickTimerRef.current !== null) {
      clearTimeout(suppressClickTimerRef.current)
      suppressClickTimerRef.current = null
    }
  }

  const choosePromotion = (option: LegalMoveOption): void => {
    setPromotionOptions([])
    setSelectedSquare(null)
    promotionReturnFocusRef.current = null
    announce(`Playing ${option.label}.`)
    onMove(option.uci)
    queueMicrotask(() => boardRegionRef.current?.focus())
  }

  const closePromotion = (): void => {
    setPromotionOptions([])
    queueMicrotask(() => {
      const returnTarget = promotionReturnFocusRef.current
      promotionReturnFocusRef.current = null
      if (returnTarget?.isConnected) returnTarget.focus()
      else squareRefs.current.get(focusedSquare)?.focus()
    })
  }

  const statusFromSquare = lastMove?.uci.slice(0, 2)
  const statusToSquare = lastMove?.uci.slice(2, 4)
  const hintFrom = hintUci?.slice(0, 2)
  const hintTo = hintUci?.slice(2, 4)
  const lastMoveGuide = safeGuideMove(lastMove?.uci)
  const hintGuide = safeGuideMove(hintUci)
  const candidateGuideTarget = hoveredSquare ?? focusedSquare
  const selectionGuide = selectedSquare !== null
    && allMoves.some((move) => move.from === selectedSquare && move.to === candidateGuideTarget)
      ? { from: selectedSquare, to: candidateGuideTarget }
      : null
  const legalSelectionGuides = selectedSquare === null ? [] : [...new Map(
    allMoves
      .filter((move) => move.from === selectedSquare)
      .map((move) => [move.to, { from: selectedSquare, to: move.to }]),
  ).values()]

  const guideLine = (
    move: { from: Square; to: Square },
    className: string,
    marker = true,
  ): React.JSX.Element => {
    const from = squareCenter(move.from, orientation)
    const to = squareCenter(move.to, orientation)
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const ux = distance === 0 ? 0 : (to.x - from.x) / distance
    const uy = distance === 0 ? 0 : (to.y - from.y) / distance
    const startTrim = Math.min(3.2, distance * 0.14)
    const endTrim = Math.min(marker ? 4.4 : 3.2, distance * 0.18)
    const x1 = from.x + ux * startTrim
    const y1 = from.y + uy * startTrim
    const x2 = to.x - ux * endTrim
    const y2 = to.y - uy * endTrim
    const arrowLength = 3.2
    const arrowWidth = 1.8
    const arrowBaseX = x2 - ux * arrowLength
    const arrowBaseY = y2 - uy * arrowLength
    const arrowPath = `M ${x2} ${y2} L ${arrowBaseX - uy * arrowWidth} ${arrowBaseY + ux * arrowWidth} L ${arrowBaseX + uy * arrowWidth} ${arrowBaseY - ux * arrowWidth} Z`
    const bracketRadius = 4.25
    const bracketArm = 1.8
    const destinationPath = [
      `M ${to.x - bracketRadius + bracketArm} ${to.y - bracketRadius} H ${to.x - bracketRadius} V ${to.y - bracketRadius + bracketArm}`,
      `M ${to.x + bracketRadius - bracketArm} ${to.y - bracketRadius} H ${to.x + bracketRadius} V ${to.y - bracketRadius + bracketArm}`,
      `M ${to.x - bracketRadius} ${to.y + bracketRadius - bracketArm} V ${to.y + bracketRadius} H ${to.x - bracketRadius + bracketArm}`,
      `M ${to.x + bracketRadius} ${to.y + bracketRadius - bracketArm} V ${to.y + bracketRadius} H ${to.x + bracketRadius - bracketArm}`,
    ].join(' ')
    return (
      <g className={`movement-guide-route ${className}`} data-guide-role={className.replace(/^guide-/u, '')}>
        <circle className={`movement-guide-source ${className}`} cx={from.x} cy={from.y} r="2.7" />
        <line className={`movement-guide-line ${className}`} x1={x1} y1={y1} x2={marker ? arrowBaseX : x2} y2={marker ? arrowBaseY : y2} />
        {marker ? <path className={`movement-guide-arrowhead ${className}`} d={arrowPath} /> : null}
        <path className={`movement-guide-destination ${className}`} d={destinationPath} />
      </g>
    )
  }

  const guideDescriptions = [
    lastMoveGuide && lastMove
      ? `${moveStatusPresentation(lastMove.status).label} route from ${lastMoveGuide.from} to ${lastMoveGuide.to}.`
      : null,
    hintGuide ? `Hint route from ${hintGuide.from} to ${hintGuide.to}.` : null,
    selectionGuide ? `Selected route from ${selectionGuide.from} to ${selectionGuide.to}.` : null,
    selectedSquare !== null && legalSelectionGuides.length > 0
      ? `${legalSelectionGuides.length} legal destination${legalSelectionGuides.length === 1 ? '' : 's'} from ${selectedSquare}: ${legalSelectionGuides.map(({ to }) => to).join(', ')}.`
      : null,
  ].filter((description): description is string => description !== null)

  return (
    <section ref={boardRegionRef} className="board-region" aria-label="Chess move input" tabIndex={-1}>
      <p id={instructionsId} className="sr-only">
        Chessboard. Use arrow keys to move between squares. Press Enter or Space to select a piece and its destination.
        Dragging and click-click input are also available. The legal move picker after the board is an equivalent non-spatial control.
      </p>
      <p id={guideDescriptionId} className="sr-only">{guideDescriptions.join(' ')}</p>
      <div className="chessboard-overlay-frame">
        <div
          ref={boardRef}
          className="chessboard"
          role="grid"
          aria-label={`Chessboard, ${orientation} orientation`}
          aria-describedby={`${instructionsId} ${guideDescriptionId}`}
          aria-rowcount={8}
          aria-colcount={8}
        >
          {Array.from({ length: 8 }, (_, rowIndex) => {
            const rowSquares = squares.slice(rowIndex * 8, rowIndex * 8 + 8)
            return (
              <div role="row" className="board-row" key={rowIndex}>
                {rowSquares.map((square, columnIndex) => {
                  const selected = selectedSquare === square
                  const legalTarget = selectedSquare !== null && allMoves.some((move) => move.from === selectedSquare && move.to === square)
                  const squareStatus = statusToSquare === square ? lastMove?.status : undefined
                  const squareStatusLabel = squareStatus ? moveStatusPresentation(squareStatus).label : null
                  const statusEndpoint = square === statusFromSquare
                    ? 'source'
                    : square === statusToSquare
                      ? 'destination'
                      : null
                  const hintEndpoint = square === hintFrom
                    ? 'source'
                    : square === hintTo
                      ? 'destination'
                      : null
                  const hint = hintEndpoint !== null
                  const piece = chess.get(square)
                  const draggable = !disabled
                    && piece?.color === chess.turn()
                    && allMoves.some((move) => move.from === square)
                  return (
                    <button
                      ref={(node) => {
                        if (node) squareRefs.current.set(square, node)
                        else squareRefs.current.delete(square)
                      }}
                      key={square}
                      type="button"
                      role="gridcell"
                      className={`board-square ${(rowIndex + columnIndex) % 2 === 0 ? 'light-square' : 'dark-square'}`}
                      data-selected={selected || undefined}
                      data-legal-target={legalTarget || undefined}
                      data-occupied={piece ? 'true' : undefined}
                      data-hint={hint || undefined}
                      data-move-status={squareStatus}
                      data-draggable={draggable || undefined}
                      aria-label={`${squareAccessibleNameForPiece(square, piece)}${selected ? ', selected' : ''}${legalTarget ? ', legal target' : ''}${squareStatusLabel ? `, ${squareStatusLabel} ${statusEndpoint}` : statusEndpoint && lastMove ? `, ${moveStatusPresentation(lastMove.status).label} ${statusEndpoint}` : ''}${hintEndpoint ? `, hint ${hintEndpoint}` : ''}`}
                      aria-selected={selected}
                      tabIndex={focusedSquare === square ? 0 : -1}
                      disabled={disabled}
                      onFocus={() => setFocusedSquare(square)}
                      onPointerEnter={() => setHoveredSquare(square)}
                      onPointerLeave={() => setHoveredSquare((current) => current === square ? null : current)}
                      onKeyDown={(event) => handleKeyDown(event, square)}
                      onClick={() => {
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false
                          if (suppressClickTimerRef.current !== null) {
                            clearTimeout(suppressClickTimerRef.current)
                            suppressClickTimerRef.current = null
                          }
                          return
                        }
                        activateSquare(square)
                      }}
                      onPointerDown={(event) => handlePointerDown(event, square)}
                      onPointerUp={handlePointerUp}
                      onPointerCancel={handlePointerCancel}
                    >
                      {columnIndex === 0 ? <span className="rank-label" aria-hidden="true">{square[1]}</span> : null}
                      {rowIndex === 7 ? <span className="file-label" aria-hidden="true">{square[0]}</span> : null}
                      {legalTarget ? <span className="legal-dot" aria-hidden="true" /> : null}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
        <div
          className={`visual-piece-layer${suppressSpatialMotion ? ' visual-piece-layer-static' : ''}`}
          aria-hidden="true"
          data-motion={motionDisabled ? 'reduced' : 'animated'}
          data-orientation={orientation}
        >
          {renderPieces.map((piece) => {
            const activePromotion = promotionVisual?.pieceId === piece.id ? promotionVisual : null
            const imageKey = `${piece.color}${piece.type}` as keyof typeof PIECE_IMAGES
            return (
              <span
                className={`visual-piece${piece.exiting ? ' visual-piece-exiting' : ''}${activePromotion ? ` visual-piece-promoting visual-piece-promoting-${activePromotion.phase}` : ''}`}
                data-piece-id={piece.id}
                data-piece-type={`${piece.color}${piece.type}`}
                data-square={piece.square}
                data-transition-state={piece.exiting ? 'captured' : activePromotion?.phase ?? 'settled'}
                key={piece.id}
              >
                {activePromotion ? (
                  <>
                    <img
                      className="piece piece-promotion-from"
                      src={PIECE_IMAGES[`${piece.color}${activePromotion.fromType}` as keyof typeof PIECE_IMAGES]}
                      alt=""
                      draggable={false}
                    />
                    <img
                      className="piece piece-promotion-to"
                      src={PIECE_IMAGES[`${piece.color}${activePromotion.toType}` as keyof typeof PIECE_IMAGES]}
                      alt=""
                      draggable={false}
                    />
                  </>
                ) : (
                  <img className="piece" src={PIECE_IMAGES[imageKey]} alt="" draggable={false} />
                )}
              </span>
            )
          })}
        </div>
        {(lastMoveGuide || hintGuide || selectionGuide || legalSelectionGuides.length > 0) ? (
          <svg className="movement-guide-layer" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
            {lastMoveGuide ? guideLine(lastMoveGuide, `guide-${lastMove?.status ?? 'unverified_deviation'}`) : null}
            {hintGuide ? guideLine(hintGuide, 'guide-hint') : null}
            {legalSelectionGuides.map((move) => <g key={move.to}>{guideLine(move, 'guide-option', false)}</g>)}
            {selectionGuide ? guideLine(selectionGuide, 'guide-selection') : null}
          </svg>
        ) : null}
        {boardOverlay}
      </div>

      <div className="move-picker" role="group" aria-labelledby={pickerId}>
        <label id={pickerId} htmlFor={`${pickerId}-select`}>Legal move picker</label>
        <div className="inline-controls">
          <select
            id={`${pickerId}-select`}
            value={pickerMove}
            disabled={disabled || allMoves.length === 0}
            onChange={(event) => setPickerMove(event.currentTarget.value)}
          >
            {allMoves.map((move) => <option key={move.uci} value={move.uci}>{move.label}</option>)}
          </select>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || pickerMove === ''}
            onClick={() => onMove(pickerMove)}
          >
            Play move
          </button>
        </div>
      </div>

      {!onAnnouncement ? (
        <p className="sr-only" aria-live="polite" aria-atomic="true">{localAnnouncement}</p>
      ) : null}

      {promotionOptions.length > 0 ? createPortal((
        <div className="dialog-backdrop" role="presentation">
          <div
            ref={promotionDialogRef}
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${pickerId}-promotion-title`}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closePromotion()
                return
              }
              if (event.key === 'Tab') {
                const controls = [...(promotionDialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
                const first = controls[0]
                const last = controls.at(-1)
                if (!first || !last) return
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault()
                  last.focus()
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault()
                  first.focus()
                }
              }
            }}
          >
            <h2 id={`${pickerId}-promotion-title`}>Choose promotion piece</h2>
            <div className="promotion-options">
              {promotionOptions.map((option, index) => (
                <button
                  ref={index === 0 ? promotionButtonRef : undefined}
                  type="button"
                  key={option.uci}
                  onClick={() => choosePromotion(option)}
                >
                  {PROMOTION_NAMES[option.promotion ?? 'q']}
                </button>
              ))}
            </div>
            <button type="button" className="text-button" onClick={closePromotion}>Cancel</button>
          </div>
        </div>
      ), document.body) : null}
    </section>
  )
}

export function moveStatusPresentation(status: BoardMoveStatus): { icon: string; label: string } {
  switch (status) {
    case 'book': return { icon: '✓', label: 'Book move' }
    case 'playable': return { icon: '≈', label: 'Playable alternative' }
    case 'inaccuracy': return { icon: '!', label: 'Inaccuracy' }
    case 'mistake': return { icon: '×', label: 'Mistake' }
    case 'unverified_deviation': return { icon: '?', label: 'Unverified deviation' }
    case 'illegal': return { icon: '⊘', label: 'Illegal move' }
  }
}

export function uciForSquareMove(from: Square, to: Square, promotion?: PieceSymbol): string {
  return optionUci(from, to, promotion)
}

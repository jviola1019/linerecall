import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import type { Square } from 'chess.js'
import {
  boardSquares,
  moveBoardFocus,
  squareFromPointer,
  type BoardArrowKey,
  type BoardOrientation,
} from '../../domain/board.ts'
import {
  BoardAnnotationListSchema,
  BoardAnnotationToneSchema,
  BoardSquareSchema,
  MAX_BOARD_ANNOTATIONS,
  annotationDescription,
  annotationKey,
  boardAnnotationPoint,
  removeBoardAnnotation,
  toggleBoardAnnotation,
  type BoardAnnotation,
  type BoardAnnotationTone,
} from '../../domain/board-annotations.ts'

interface AnnotationSharedProps {
  annotations: readonly BoardAnnotation[]
  systemAnnotations?: readonly BoardAnnotation[]
  orientation: BoardOrientation
  onChange: (annotations: BoardAnnotation[]) => void
  onAnnouncement?: (message: string) => void
}

export interface BoardAnnotationOverlayProps extends AnnotationSharedProps {
  editing: boolean
  tone: BoardAnnotationTone
  onExitEditing?: () => void
}

function isArrowKey(key: string): key is BoardArrowKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
}

function visualLine(
  annotation: Extract<BoardAnnotation, { kind: 'arrow' }>,
  orientation: BoardOrientation,
): { x1: number; y1: number; x2: number; y2: number } {
  const from = boardAnnotationPoint(annotation.from as Square, orientation)
  const to = boardAnnotationPoint(annotation.to as Square, orientation)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  const startInset = 2.2
  const endInset = 4.8
  return {
    x1: from.x + (dx / length) * startInset,
    y1: from.y + (dy / length) * startInset,
    x2: to.x - (dx / length) * endInset,
    y2: to.y - (dy / length) * endInset,
  }
}

function AnnotationSvg({
  annotations,
  orientation,
  cursorSquare,
  startSquare,
}: {
  annotations: readonly BoardAnnotation[]
  orientation: BoardOrientation
  cursorSquare: Square | null
  startSquare: Square | null
}): React.JSX.Element {
  const markerPrefix = useId().replaceAll(':', '')
  return (
    <svg className="board-annotation-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        {(['study', 'alternative', 'warning'] as const).map((tone) => (
          <marker
            id={`${markerPrefix}-${tone}`}
            key={tone}
            markerWidth="5"
            markerHeight="5"
            refX="4.2"
            refY="2.5"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path className={`annotation-marker annotation-${tone}`} d="M 0 0 L 5 2.5 L 0 5 z" />
          </marker>
        ))}
      </defs>
      {annotations.map((annotation, index) => {
        if (annotation.kind === 'circle') {
          const point = boardAnnotationPoint(annotation.square as Square, orientation)
          return (
            <circle
              key={`${annotationKey(annotation)}:${index}`}
              className={`annotation-shape annotation-${annotation.tone}`}
              cx={point.x}
              cy={point.y}
              r="4.8"
            />
          )
        }
        const line = visualLine(annotation, orientation)
        return (
          <line
            key={`${annotationKey(annotation)}:${index}`}
            className={`annotation-shape annotation-${annotation.tone}`}
            {...line}
            markerEnd={`url(#${markerPrefix}-${annotation.tone})`}
          />
        )
      })}
      {startSquare ? (() => {
        const point = boardAnnotationPoint(startSquare, orientation)
        return <circle className="annotation-start-square" cx={point.x} cy={point.y} r="5.6" />
      })() : null}
      {cursorSquare ? (() => {
        const point = boardAnnotationPoint(cursorSquare, orientation)
        return <rect className="annotation-cursor-square" x={point.x - 5.7} y={point.y - 5.7} width="11.4" height="11.4" />
      })() : null}
    </svg>
  )
}

function changeMessage(annotation: BoardAnnotation, change: 'added' | 'removed' | 'retagged'): string {
  const description = annotationDescription(annotation)
  if (change === 'removed') return `${description} removed.`
  if (change === 'retagged') return `${description} updated.`
  return `${description} added.`
}

export function BoardAnnotationOverlay({
  annotations: annotationsInput,
  systemAnnotations: systemAnnotationsInput = [],
  orientation,
  editing,
  tone,
  onChange,
  onAnnouncement,
  onExitEditing,
}: BoardAnnotationOverlayProps): React.JSX.Element {
  const instructionsId = useId()
  const annotations = BoardAnnotationListSchema.parse(annotationsInput)
  const systemAnnotations = BoardAnnotationListSchema.parse(systemAnnotationsInput)
  const [cursorSquare, setCursorSquare] = useState<Square>('e4')
  const [startSquare, setStartSquare] = useState<Square | null>(null)
  const [localAnnouncement, setLocalAnnouncement] = useState('')
  const pointerStartRef = useRef<Square | null>(null)

  const announce = (message: string): void => {
    if (onAnnouncement) onAnnouncement(message)
    else setLocalAnnouncement(message)
  }

  useEffect(() => {
    if (!editing) {
      setStartSquare(null)
      pointerStartRef.current = null
    }
  }, [editing])

  const apply = (annotation: BoardAnnotation): void => {
    try {
      const result = toggleBoardAnnotation(annotations, annotation)
      onChange(result.annotations)
      announce(changeMessage(annotation, result.change))
    } catch (error) {
      announce(error instanceof Error ? error.message : 'The annotation could not be added.')
    }
  }

  const squareAtEvent = (event: Pick<PointerEvent<HTMLDivElement>, 'clientX' | 'clientY' | 'currentTarget'>): Square | null =>
    squareFromPointer(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      orientation,
    )

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!editing || event.button !== 0) return
    const square = squareAtEvent(event)
    if (!square) return
    pointerStartRef.current = square
    setCursorSquare(square)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const from = pointerStartRef.current
    pointerStartRef.current = null
    if (!editing || !from) return
    const to = squareAtEvent(event)
    if (!to) {
      announce('Annotation cancelled outside the board.')
      return
    }
    setCursorSquare(to)
    apply(from === to
      ? { kind: 'circle', square: from, tone }
      : { kind: 'arrow', from, to, tone })
  }

  const completeKeyboardAnnotation = (): void => {
    if (startSquare === null) {
      setStartSquare(cursorSquare)
      announce(`${cursorSquare} selected as the annotation start. Move to another square and press Enter or Space; press the same square twice for a circle.`)
      return
    }
    apply(startSquare === cursorSquare
      ? { kind: 'circle', square: cursorSquare, tone }
      : { kind: 'arrow', from: startSquare, to: cursorSquare, tone })
    setStartSquare(null)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isArrowKey(event.key)) {
      event.preventDefault()
      const next = moveBoardFocus(cursorSquare, event.key, orientation)
      setCursorSquare(next)
      announce(`Annotation cursor ${next}.`)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const squares = boardSquares(orientation)
      const next = event.key === 'Home' ? squares[0] : squares.at(-1)
      if (next) {
        setCursorSquare(next)
        announce(`Annotation cursor ${next}.`)
      }
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      completeKeyboardAnnotation()
      return
    }
    if (event.key.toLowerCase() === 'c') {
      event.preventDefault()
      apply({ kind: 'circle', square: cursorSquare, tone })
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      const last = annotations.at(-1)
      if (!last) {
        announce('There are no annotations to remove.')
        return
      }
      onChange(annotations.slice(0, -1))
      announce(`${annotationDescription(last)} removed.`)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (startSquare) {
        setStartSquare(null)
        announce('Annotation start cancelled.')
      } else {
        onExitEditing?.()
        announce('Annotation mode closed.')
      }
    }
  }

  return (
    <div
      className="board-annotation-layer"
      data-editing={editing || undefined}
      role={editing ? 'group' : undefined}
      aria-label={editing ? 'Board annotation canvas' : undefined}
      aria-describedby={editing ? instructionsId : undefined}
      aria-hidden={editing ? undefined : true}
      tabIndex={editing ? 0 : undefined}
      onKeyDown={editing ? handleKeyDown : undefined}
      onPointerDown={editing ? handlePointerDown : undefined}
      onPointerUp={editing ? handlePointerUp : undefined}
      onPointerCancel={() => { pointerStartRef.current = null }}
    >
      <span id={instructionsId} className="sr-only">
        Annotation mode. Use arrow keys to choose a square. Press Enter or Space on a start and destination square to draw an arrow.
        Press the same square twice, or press C, to toggle a circle. Delete removes the most recent annotation. Escape cancels or exits.
      </span>
      <AnnotationSvg
        annotations={[...systemAnnotations, ...annotations]}
        orientation={orientation}
        cursorSquare={editing ? cursorSquare : null}
        startSquare={editing ? startSquare : null}
      />
      {!onAnnouncement ? <span className="sr-only" aria-live="polite" aria-atomic="true">{localAnnouncement}</span> : null}
    </div>
  )
}

export interface BoardAnnotationPanelProps extends AnnotationSharedProps {
  editing?: boolean
  tone: BoardAnnotationTone
  onToneChange: (tone: BoardAnnotationTone) => void
}

export function BoardAnnotationPanel({
  annotations: annotationsInput,
  systemAnnotations: systemAnnotationsInput = [],
  orientation,
  editing = true,
  tone,
  onToneChange,
  onChange,
  onAnnouncement,
}: BoardAnnotationPanelProps): React.JSX.Element {
  const panelId = useId()
  const annotations = BoardAnnotationListSchema.parse(annotationsInput)
  const systemAnnotations = BoardAnnotationListSchema.parse(systemAnnotationsInput)
  const squares = boardSquares(orientation)
  const [from, setFrom] = useState<Square>('e2')
  const [to, setTo] = useState<Square>('e4')
  const [localAnnouncement, setLocalAnnouncement] = useState('')

  const announce = (message: string): void => {
    if (onAnnouncement) onAnnouncement(message)
    else setLocalAnnouncement(message)
  }

  const apply = (annotation: BoardAnnotation): void => {
    try {
      const result = toggleBoardAnnotation(annotations, annotation)
      onChange(result.annotations)
      announce(changeMessage(annotation, result.change))
    } catch (error) {
      announce(error instanceof Error ? error.message : 'The annotation could not be added.')
    }
  }

  return (
    <section className="annotation-panel" aria-labelledby={`${panelId}-title`}>
      <div className="annotation-panel-heading">
        <div>
          <h3 id={`${panelId}-title`}>Board annotations</h3>
          <p>{annotations.length} of {MAX_BOARD_ANNOTATIONS} personal annotations.</p>
        </div>
        <button
          type="button"
          className="text-button"
          disabled={annotations.length === 0}
          onClick={() => {
            onChange([])
            announce('All personal board annotations cleared.')
          }}
        >
          Clear all
        </button>
      </div>

      {editing ? <div className="annotation-form" role="group" aria-label="Non-spatial annotation controls">
        <label htmlFor={`${panelId}-tone`}>Annotation style</label>
        <select
          id={`${panelId}-tone`}
          value={tone}
          onChange={(event) => onToneChange(BoardAnnotationToneSchema.parse(event.currentTarget.value))}
        >
          <option value="study">Study — solid</option>
          <option value="alternative">Alternative — dashed</option>
          <option value="warning">Warning — dotted</option>
        </select>
        <label htmlFor={`${panelId}-from`}>From square</label>
        <select
          id={`${panelId}-from`}
          value={from}
          onChange={(event) => setFrom(BoardSquareSchema.parse(event.currentTarget.value) as Square)}
        >
          {squares.map((square) => <option value={square} key={square}>{square}</option>)}
        </select>
        <label htmlFor={`${panelId}-to`}>To square</label>
        <select
          id={`${panelId}-to`}
          value={to}
          onChange={(event) => setTo(BoardSquareSchema.parse(event.currentTarget.value) as Square)}
        >
          {squares.map((square) => <option value={square} key={square}>{square}</option>)}
        </select>
        <div className="annotation-actions">
          <button type="button" onClick={() => apply({ kind: 'arrow', from, to, tone })}>Toggle arrow</button>
          <button type="button" className="secondary-button" onClick={() => apply({ kind: 'circle', square: from, tone })}>Toggle circle</button>
        </div>
      </div> : null}

      <div className="annotation-text-alternative">
        <h4>Text description</h4>
        {systemAnnotations.map((annotation) => (
          <p key={`system-${annotationKey(annotation)}`}><strong>Study aid:</strong> {annotationDescription(annotation)}.</p>
        ))}
        {annotations.length === 0 ? <p>No personal arrows or circles.</p> : (
          <ol>
            {annotations.map((annotation) => (
              <li key={annotationKey(annotation)}>
                <span>{annotationDescription(annotation)}</span>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Remove ${annotationDescription(annotation)}`}
                  onClick={() => {
                    onChange(removeBoardAnnotation(annotations, annotation))
                    announce(`${annotationDescription(annotation)} removed.`)
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      {!onAnnouncement ? <p className="sr-only" aria-live="polite" aria-atomic="true">{localAnnouncement}</p> : null}
    </section>
  )
}

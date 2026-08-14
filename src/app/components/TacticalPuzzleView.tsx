import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoardOrientation } from '../../domain/board.ts'
import {
  beginTacticalPuzzle,
  playTacticalPuzzleForcedReply,
  playTacticalPuzzleLearnerMove,
  useTacticalPuzzleHint,
  type PuzzleRecord,
  type TacticalPuzzleState,
} from '../../domain/tactical-puzzles.ts'
import {
  MAX_PUZZLE_ATTEMPT_ELAPSED_MS,
  type PuzzleAttemptEventV1,
} from '../../domain/puzzle-progress.ts'
import {
  TacticalPuzzleResourceSchema,
  type TacticalPuzzleResource,
} from '../../data/tactical-puzzle-resource.ts'
import { ChessBoard } from './ChessBoard.tsx'
import { EmptyState, ErrorState, LoadingState } from './ResourceState.tsx'
import './training-puzzle.css'

const NORMAL_PUZZLE_TRANSITION_MS = 190
const PROMOTION_PUZZLE_TRANSITION_MS = 360

function puzzleTransitionDelay(moveUci: string | null): number {
  return moveUci?.length === 5 ? PROMOTION_PUZZLE_TRANSITION_MS : NORMAL_PUZZLE_TRANSITION_MS
}

export interface TacticalPuzzleViewProps {
  resource: TacticalPuzzleResource
  orientation: BoardOrientation
  reducedMotion?: boolean
  onSetOrientation?: (orientation: BoardOrientation) => void
  onAttempt?: (event: PuzzleAttemptEventV1) => void | Promise<void>
  onRetry?: () => void
  onAnnouncement?: (message: string) => void
}

function attemptId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new Error('Puzzle attempt timestamp is outside the UUIDv7 range')
  }
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let timestamp = BigInt(now)
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn)
    timestamp >>= 8n
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The tactical puzzle could not be continued.'
}

function TacticalPuzzleSession({
  puzzles,
  orientation,
  reducedMotion = false,
  onSetOrientation,
  onAttempt,
  onAnnouncement,
  resourceNotice,
}: {
  puzzles: PuzzleRecord[]
  orientation: BoardOrientation
  reducedMotion?: boolean
  onSetOrientation?: (orientation: BoardOrientation) => void
  onAttempt?: (event: PuzzleAttemptEventV1) => void | Promise<void>
  onAnnouncement?: (message: string) => void
  resourceNotice?: string
}): React.JSX.Element {
  const [puzzleIndex, setPuzzleIndex] = useState(0)
  const puzzle = puzzles[puzzleIndex]!
  const [state, setState] = useState<TacticalPuzzleState>(() => beginTacticalPuzzle(puzzle))
  const [feedback, setFeedback] = useState('Find the strongest continuation.')
  const [lastMoveUci, setLastMoveUci] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pendingSave, setPendingSave] = useState<{ key: string; event: PuzzleAttemptEventV1 } | null>(null)
  const [saving, setSaving] = useState(false)
  const [transitionLocked, setTransitionLocked] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const startedAtRef = useRef(Date.now())
  const evidenceRef = useRef<HTMLElement>(null)
  const recordedRef = useRef(new Set<string>())
  const attemptsRef = useRef(new Map<string, PuzzleAttemptEventV1>())
  const inFlightSavesRef = useRef(new Map<string, Promise<boolean>>())

  const announce = (message: string): void => {
    setAnnouncement(message)
    onAnnouncement?.(message)
  }

  const expectedMove = puzzle.learnerNodes[state.learnerIndex]?.expectedMoveUci ?? null
  const progressValue = state.completed
    ? puzzle.learnerNodes.length
    : Math.min(state.learnerIndex, puzzle.learnerNodes.length)
  const phaseLabel = state.completed
    ? 'Solved'
    : state.phase === 'forced-reply'
      ? 'Opponent reply'
      : 'Your move'
  const feedbackTone = state.completed
    ? 'solved'
    : state.incorrectAttempts > 0
      ? 'retry'
      : state.phase === 'forced-reply'
        ? 'reply'
        : state.usedHint
          ? 'hint'
          : 'ready'

  const openEvidence = (): void => {
    const evidence = evidenceRef.current
    if (!evidence) return
    evidence.focus({ preventScroll: true })
    evidence.scrollIntoView?.({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'start',
    })
    announce('Puzzle evidence opened.')
  }

  const persistAttempt = (key: string, event: PuzzleAttemptEventV1): Promise<boolean> => {
    if (recordedRef.current.has(key)) return Promise.resolve(true)
    const existing = inFlightSavesRef.current.get(key)
    if (existing) return existing
    const pending = (async (): Promise<boolean> => {
      setSaving(true)
      setSaveError(null)
      try {
        if (!onAttempt) throw new Error('Puzzle progress storage is not configured')
        await onAttempt(event)
        recordedRef.current.add(key)
        setPendingSave((current) => current?.key === key ? null : current)
        announce('Puzzle progress saved.')
        return true
      } catch (error) {
        setPendingSave({ key, event })
        setSaveError(`Puzzle progress could not be saved: ${errorMessage(error)}`)
        announce('Puzzle progress was not saved. Retry is available.')
        return false
      } finally {
        setSaving(false)
        inFlightSavesRef.current.delete(key)
      }
    })()
    inFlightSavesRef.current.set(key, pending)
    return pending
  }

  const recordAttempt = (
    outcome: 'solved' | 'abandoned',
    completedState: TacticalPuzzleState,
  ): Promise<boolean> => {
    const key = `${puzzle.puzzleId}:${startedAtRef.current}:${outcome}`
    let event = attemptsRef.current.get(key)
    if (!event) {
      const now = Date.now()
      event = {
        eventId: attemptId(now),
        puzzleId: puzzle.puzzleId,
        occurredAt: new Date(now).toISOString(),
        outcome,
        incorrectAttempts: completedState.incorrectAttempts,
        usedHint: completedState.usedHint,
        elapsedMs: Math.min(
          MAX_PUZZLE_ATTEMPT_ELAPSED_MS,
          Math.max(0, now - startedAtRef.current),
        ),
      }
      attemptsRef.current.set(key, event)
    }
    return persistAttempt(key, event)
  }

  const selectPuzzle = (index: number): void => {
    const nextIndex = (index + puzzles.length) % puzzles.length
    const next = puzzles[nextIndex]!
    setPuzzleIndex(nextIndex)
    setState(beginTacticalPuzzle(next))
    setFeedback('Find the strongest continuation.')
    setLastMoveUci(null)
    setSaveError(null)
    setPendingSave(null)
    startedAtRef.current = Date.now()
    announce(`Puzzle ${nextIndex + 1} of ${puzzles.length} ready.`)
  }

  useEffect(() => {
    if (state.phase !== 'forced-reply') return
    const timeout = setTimeout(() => {
      try {
        const result = playTacticalPuzzleForcedReply(puzzle, state)
        setState(result.state)
        setLastMoveUci(result.transition.moveUci)
        setTransitionLocked(true)
        if (result.verdict === 'solved') {
          setFeedback('Solved. The learner move and forced reply were verified separately.')
          void recordAttempt('solved', result.state)
          announce('Puzzle solved.')
        } else {
          setFeedback('Opponent reply is moving.')
          announce('Opponent reply is moving. Input remains paused.')
        }
      } catch (error) {
        setSaveError(errorMessage(error))
        announce('The audited opponent reply could not be applied.')
      }
    }, reducedMotion ? 0 : puzzleTransitionDelay(lastMoveUci))
    return () => clearTimeout(timeout)
  }, [lastMoveUci, puzzle, reducedMotion, state])

  useEffect(() => {
    if (!transitionLocked) return
    if (reducedMotion) {
      setTransitionLocked(false)
      if (state.phase === 'learner' && lastMoveUci !== null) {
        setFeedback('Opponent reply complete. Continue the tactic.')
        announce('Opponent reply played. Your move.')
      }
      return
    }
    const timeout = setTimeout(() => {
      setTransitionLocked(false)
      if (state.phase === 'learner' && lastMoveUci !== null) {
        setFeedback('Opponent reply complete. Continue the tactic.')
        announce('Opponent reply played. Your move.')
      }
    }, puzzleTransitionDelay(lastMoveUci))
    return () => clearTimeout(timeout)
  }, [lastMoveUci, reducedMotion, state.phase, transitionLocked])

  const handleMove = (moveUci: string): void => {
    try {
      const result = playTacticalPuzzleLearnerMove(puzzle, state, moveUci)
      setState(result.state)
      if (result.verdict === 'illegal') {
        setFeedback('That move is not legal in this position.')
        announce('Illegal move. The position was kept.')
        return
      }
      if (result.verdict === 'retry') {
        setFeedback('That move does not solve the audited tactic. Try again.')
        announce('Try another legal move.')
        return
      }
      setLastMoveUci(result.transition?.moveUci ?? null)
      if (result.verdict === 'solved') {
        setFeedback(result.acceptedAlternateMate
          ? 'Solved with another legal mating move.'
          : 'Solved. The full audited line is complete.')
        void recordAttempt('solved', result.state)
        announce('Puzzle solved.')
      } else {
        setFeedback('Correct. The forced reply is playing now.')
        announce('Correct move. Applying the forced reply.')
      }
    } catch (error) {
      setSaveError(errorMessage(error))
      announce('The move could not be checked.')
    }
  }

  return (
    <section className="tactical-puzzle-session" aria-labelledby="tactical-puzzle-title">
      <header className="tactical-puzzle-header">
        <div>
          <p className="eyebrow">Opening-linked tactic</p>
          <h1 id="tactical-puzzle-title">Puzzles</h1>
          <p>Puzzle {puzzleIndex + 1} of {puzzles.length} · {puzzle.learnerNodes.length} learner decision{puzzle.learnerNodes.length === 1 ? '' : 's'}</p>
        </div>
        <div className="inline-controls">
          {onSetOrientation ? (
            <button type="button" className="secondary-button" onClick={() => onSetOrientation(orientation === 'white' ? 'black' : 'white')}>
              Flip board
            </button>
          ) : null}
          <button
            type="button"
            className="secondary-button"
            disabled={state.completed || saving}
            onClick={() => {
              void recordAttempt('abandoned', state).then((saved) => {
                if (saved) selectPuzzle(puzzleIndex + 1)
              })
            }}
          >
            {saving && !state.completed ? 'Saving…' : 'Skip puzzle'}
          </button>
        </div>
      </header>
      {resourceNotice ? <p className="resource-notice" role="status">{resourceNotice}</p> : null}
      <div className="puzzle-status-strip" data-tone={feedbackTone} role="status" aria-label={`Puzzle status: ${phaseLabel}`}>
        <span className="puzzle-status-mark" aria-hidden="true">{state.completed ? '✓' : state.phase === 'forced-reply' ? '→' : '·'}</span>
        <strong>{phaseLabel}</strong>
        <span>{state.incorrectAttempts} incorrect {state.incorrectAttempts === 1 ? 'try' : 'tries'}</span>
        <span>{state.usedHint ? 'Hint used' : 'No hint'}</span>
      </div>
      <progress
        className="puzzle-progress-track"
        max={puzzle.learnerNodes.length}
        value={progressValue}
        aria-label={`${progressValue} of ${puzzle.learnerNodes.length} learner decisions completed`}
      />
      <div className="tactical-puzzle-workspace">
        <div className="tactical-board-column">
          <ChessBoard
            fen={state.fen}
            orientation={orientation}
            disabled={state.phase !== 'learner' || transitionLocked || saving}
            reducedMotion={reducedMotion}
            hintUci={state.usedHint ? expectedMove : null}
            lastMove={lastMoveUci ? { uci: lastMoveUci, status: 'book' } : null}
            boardControls={(
              <div className="tactical-thumb-dock" role="group" aria-label="Puzzle actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={state.phase !== 'learner' || transitionLocked || state.usedHint || expectedMove === null}
                  onClick={() => {
                    setState(useTacticalPuzzleHint(state))
                    setFeedback('The expected route is marked on the board.')
                    announce('Hint route shown.')
                  }}
                >
                  Hint
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  aria-controls="puzzle-evidence"
                  onClick={openEvidence}
                >
                  Why
                </button>
                {state.completed ? (
                  <button
                    type="button"
                    className="primary-action"
                    disabled={saving || pendingSave !== null}
                    onClick={() => selectPuzzle(puzzleIndex + 1)}
                  >
                    {saving ? 'Saving…' : 'Next puzzle'}
                  </button>
                ) : null}
              </div>
            )}
            onMove={handleMove}
            onAnnouncement={announce}
          />
        </div>
        <aside
          ref={evidenceRef}
          id="puzzle-evidence"
          className="tactical-evidence"
          aria-labelledby="puzzle-evidence-title"
          tabIndex={-1}
        >
          <p className="eyebrow">Evidence</p>
          <h2 id="puzzle-evidence-title">{state.completed ? 'Solution complete' : 'Your move'}</h2>
          <div className="puzzle-feedback-panel" data-tone={feedbackTone} role="status">
            <span aria-hidden="true">{state.completed ? '✓' : state.incorrectAttempts > 0 ? '!' : state.phase === 'forced-reply' ? '→' : '·'}</span>
            <p>{feedback}</p>
          </div>
          {saveError ? <p role="alert" className="error-warning">{saveError}</p> : null}
          {pendingSave ? (
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              onClick={() => { void persistAttempt(pendingSave.key, pendingSave.event) }}
            >
              {saving ? 'Saving…' : 'Retry save'}
            </button>
          ) : null}
          <dl className="puzzle-evidence-facts">
            <div><dt>Rating</dt><dd>{puzzle.rating}</dd></div>
            <div><dt>Attempts</dt><dd>{puzzle.attempts.toLocaleString('en-US')}</dd></div>
            <div><dt>Popularity</dt><dd>{puzzle.popularity}</dd></div>
            <div><dt>Match</dt><dd>{puzzle.association.confidence === 'exact-position' ? 'Exact position' : 'Opening family'}</dd></div>
            <div><dt>Engine</dt><dd>{puzzle.engine.name}, verified</dd></div>
            <div><dt>Source</dt><dd>Lichess puzzle database · CC0</dd></div>
          </dl>
          <p><strong>Themes:</strong> {puzzle.themes.join(', ')}</p>
          <details className="puzzle-audit-criteria">
            <summary>Why this puzzle appears here</summary>
            <p>
              Released puzzles must replay legally, carry an opening association, have at least 100 attempts,
              popularity of at least 80, rating deviation no greater than 100, and a passing engine check at each learner move.
            </p>
            <p>
              This item is linked by {puzzle.association.confidence === 'exact-position'
                ? 'an exact normalized position match.'
                : 'a unique opening-family match, not an exact repertoire position.'}
            </p>
          </details>
        </aside>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
    </section>
  )
}

export function TacticalPuzzleView(props: TacticalPuzzleViewProps): React.JSX.Element {
  const resource = useMemo<TacticalPuzzleResource>(() => {
    const parsed = TacticalPuzzleResourceSchema.safeParse(props.resource)
    return parsed.success
      ? parsed.data
      : {
          status: 'corrupt',
          reason: 'The tactical puzzle resource failed runtime validation and was not loaded.',
        }
  }, [props.resource])
  const shell = (content: React.JSX.Element): React.JSX.Element => (
    <section className="tactical-puzzle-route" aria-labelledby="tactical-route-title">
      <header className="section-intro">
        <p className="eyebrow">Tactical study</p>
        <h1 id="tactical-route-title">Puzzles</h1>
        <p>Opening-linked tactics use a separate evidence and mastery track from repertoire recall.</p>
      </header>
      {content}
    </section>
  )

  if (resource.status === 'disabled') {
    return shell(<EmptyState title="Tactical puzzles are not released yet" detail={resource.reason} />)
  }
  if (resource.status === 'loading') {
    return shell(<LoadingState label="Loading the audited tactical puzzle shard…" />)
  }
  if (resource.status === 'empty') {
    return shell(<EmptyState title="No matching tactical puzzles" detail={resource.reason} />)
  }
  if (resource.status === 'rate-limited') {
    return shell(<ErrorState title="Puzzle service is rate-limited" detail={`${resource.reason} Retry after ${resource.retryAfterSeconds} seconds.`} onRetry={props.onRetry ?? (() => undefined)} />)
  }
  if (resource.status === 'corrupt') {
    return shell(<ErrorState title="Puzzle shard rejected" detail={resource.reason} onRetry={props.onRetry ?? (() => undefined)} />)
  }
  if (resource.status === 'error') {
    return shell(<ErrorState title="Puzzles unavailable" detail={resource.reason} onRetry={props.onRetry ?? (() => undefined)} />)
  }
  if (resource.status === 'offline' && resource.puzzles.length === 0) {
    return shell(<EmptyState title="Puzzles unavailable offline" detail={resource.reason} />)
  }

  const resourceNotice = resource.status === 'stale'
    ? `Using the last verified puzzle shard. ${resource.reason}`
    : resource.status === 'offline'
      ? `Offline mode. ${resource.reason}`
      : undefined
  return (
    <TacticalPuzzleSession
      puzzles={resource.puzzles}
      orientation={props.orientation}
      {...(props.reducedMotion !== undefined ? { reducedMotion: props.reducedMotion } : {})}
      {...(props.onSetOrientation ? { onSetOrientation: props.onSetOrientation } : {})}
      {...(props.onAttempt ? { onAttempt: props.onAttempt } : {})}
      {...(props.onAnnouncement ? { onAnnouncement: props.onAnnouncement } : {})}
      {...(resourceNotice ? { resourceNotice } : {})}
    />
  )
}

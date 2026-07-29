import { useMemo, useState } from 'react'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { ChessBoard } from '../../src/app/components/ChessBoard.tsx'
import type { BoardOrientation } from '../../src/domain/board.ts'

type ScenarioId = 'normal' | 'capture' | 'castling' | 'en-passant' | 'promotion' | 'queued'

interface MotionScenario {
  id: ScenarioId
  label: string
  initialFen: string
  moves: readonly string[]
}

const SCENARIOS: readonly MotionScenario[] = Object.freeze([
  { id: 'normal', label: 'Normal move', initialFen: new Chess().fen(), moves: ['e2e4'] },
  {
    id: 'capture',
    label: 'Capture',
    initialFen: '8/8/8/3p4/4P3/8/8/4K2k w - - 0 1',
    moves: ['e4d5'],
  },
  {
    id: 'castling',
    label: 'Castling',
    initialFen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    moves: ['e1g1'],
  },
  {
    id: 'en-passant',
    label: 'En passant',
    initialFen: '8/8/8/3pP3/8/8/8/4K2k w - d6 0 2',
    moves: ['e5d6'],
  },
  {
    id: 'promotion',
    label: 'Promotion',
    initialFen: '8/P7/8/8/8/8/7p/4K2k w - - 0 1',
    moves: ['a7a8q'],
  },
  {
    id: 'queued',
    label: 'Queued learner and opponent moves',
    initialFen: new Chess().fen(),
    moves: ['e2e4', 'c7c5'],
  },
])

function applyUci(chess: Chess, uci: string): void {
  const promotion = uci[4] as PieceSymbol | undefined
  chess.move({
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    ...(promotion ? { promotion } : {}),
  })
}

/**
 * Test-only legal-position driver for browser motion auditing. These positions
 * are not opening evidence or tactical records and are excluded from every
 * normal application build.
 */
export function BoardMotionReview(): React.JSX.Element {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('normal')
  const scenario = useMemo(
    () => SCENARIOS.find(({ id }) => id === scenarioId) ?? SCENARIOS[0]!,
    [scenarioId],
  )
  const [fen, setFen] = useState(scenario.initialFen)
  const [lastMove, setLastMove] = useState<string | null>(null)
  const [orientation, setOrientation] = useState<BoardOrientation>('white')
  const [submittedMoves, setSubmittedMoves] = useState<string[]>([])
  const [announcement, setAnnouncement] = useState('Board transition fixture ready.')

  const reset = (nextScenario = scenario): void => {
    setFen(nextScenario.initialFen)
    setLastMove(null)
    setSubmittedMoves([])
    setAnnouncement(`${nextScenario.label} position reset without animation.`)
  }

  const chooseScenario = (id: ScenarioId): void => {
    const next = SCENARIOS.find((candidate) => candidate.id === id)
    if (!next) return
    setScenarioId(next.id)
    reset(next)
  }

  const runScenario = (): void => {
    const chess = new Chess(scenario.initialFen)
    for (const uci of scenario.moves) applyUci(chess, uci)
    setLastMove(scenario.moves[0] ?? null)
    setFen(chess.fen())
    setSubmittedMoves([...scenario.moves])
    setAnnouncement(`${scenario.label} transition requested.`)
  }

  const runRapidResetThenMove = (): void => {
    const normal = SCENARIOS[0]!
    setScenarioId(normal.id)
    setFen(normal.initialFen)
    setLastMove(null)
    setSubmittedMoves([])
    setAnnouncement('Rapid reset requested.')
    requestAnimationFrame(() => {
      const chess = new Chess(normal.initialFen)
      applyUci(chess, normal.moves[0]!)
      setLastMove(normal.moves[0]!)
      setFen(chess.fen())
      setSubmittedMoves([normal.moves[0]!])
      setAnnouncement('Rapid reset followed by a legal move.')
    })
  }

  const handleMove = (uci: string): void => {
    const chess = new Chess(fen)
    applyUci(chess, uci)
    setLastMove(uci)
    setFen(chess.fen())
    setSubmittedMoves((current) => [...current, uci])
    setAnnouncement(`${uci} submitted through the real board input.`)
  }

  return (
    <main className="board-motion-review" data-review-surface="board-motion">
      <header>
        <p className="eyebrow">Test-only interaction surface</p>
        <h1>Board transition review</h1>
        <p>Legal positions for motion verification only. They are not opening or tactical evidence.</p>
      </header>
      <div className="board-motion-review-controls" role="group" aria-label="Board transition scenario">
        <label>
          Scenario
          <select
            value={scenarioId}
            onChange={(event) => chooseScenario(event.currentTarget.value as ScenarioId)}
          >
            {SCENARIOS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <button type="button" className="primary-action" onClick={runScenario}>Run transition</button>
        <button type="button" className="secondary-button" onClick={runRapidResetThenMove}>
          Run rapid reset and move
        </button>
        <button type="button" className="secondary-button" onClick={() => reset()}>Reset position</button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            setOrientation((current) => current === 'white' ? 'black' : 'white')
            setAnnouncement('Board orientation changed without moving the position.')
          }}
        >
          Flip board
        </button>
      </div>
      <ChessBoard
        fen={fen}
        orientation={orientation}
        lastMove={lastMove ? { uci: lastMove, status: 'book' } : null}
        onMove={handleMove}
        onAnnouncement={setAnnouncement}
      />
      <dl className="board-motion-review-status">
        <div><dt>Scenario</dt><dd>{scenario.label}</dd></div>
        <div><dt>Submitted moves</dt><dd>{submittedMoves.length > 0 ? submittedMoves.join(', ') : 'None'}</dd></div>
      </dl>
      <p role="status" aria-live="polite">{announcement}</p>
    </main>
  )
}

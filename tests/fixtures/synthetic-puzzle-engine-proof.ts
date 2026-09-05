import { Chess } from 'chess.js'
import {
  PUZZLE_ENGINE_SETTINGS_SHA256,
  PuzzleEngineProofSchema,
} from '../../scripts/data/puzzle-contracts.ts'

function uci(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`
}

/** Complete, observation-derived puzzle proof for synthetic tests only. */
export function createSyntheticPuzzleEngineProof(options: {
  learnerIndex: number
  positionEpd: string
  expectedMoveUci: string
  engineSha256: string
  nnueSha256: string
  analyzedAt: string
  centipawnLoss?: number
}) {
  const chess = new Chess(`${options.positionEpd} 0 1`)
  const legalMoves = chess.moves({ verbose: true }).map(uci)
  if (!legalMoves.includes(options.expectedMoveUci)) throw new Error('Synthetic expected puzzle move is illegal')
  const loss = options.centipawnLoss ?? 0
  const alternative = legalMoves.find((move) => move !== options.expectedMoveUci)
  const bestMove = loss === 0 ? options.expectedMoveUci : alternative
  if (!bestMove) throw new Error('Synthetic failed puzzle proof requires a legal alternative move')
  const selected = [bestMove, options.expectedMoveUci, ...legalMoves]
    .filter((move, index, values) => values.indexOf(move) === index)
    .slice(0, Math.min(5, legalMoves.length))
  const scored = selected.map((move, index) => ({
    move,
    score: move === options.expectedMoveUci ? 40 - loss : 40 - index * 10,
  })).sort((left, right) => right.score - left.score || left.move.localeCompare(right.move, 'en'))
  const rootVariations = scored.map(({ move, score }, index) => ({
    multipv: index + 1,
    depth: 20,
    selectiveDepth: 30,
    nodes: 250_000,
    score: { kind: 'centipawn' as const, value: score },
    bound: 'exact' as const,
    movesUci: [move],
  }))
  const expected = rootVariations.find(({ movesUci }) => movesUci[0] === options.expectedMoveUci)!
  return PuzzleEngineProofSchema.parse({
    learnerIndex: options.learnerIndex,
    positionEpd: options.positionEpd,
    expectedMoveUci: options.expectedMoveUci,
    engineBestMoveUci: rootVariations[0]!.movesUci[0]!,
    centipawnLoss: loss,
    mateConsistent: true,
    status: loss <= 50 ? 'pass' : 'fail',
    engine: 'Stockfish 18',
    engineSha256: options.engineSha256,
    nnueSha256: options.nnueSha256,
    settingsSha256: PUZZLE_ENGINE_SETTINGS_SHA256,
    settings: { threads: 1, hashMb: 128, multiPv: 5, nodes: 250_000 },
    rootVariations,
    expectedMoveObservation: { searchMode: 'root-multipv', variation: expected },
    principalVariationUci: rootVariations[0]!.movesUci,
    analyzedAt: options.analyzedAt,
  })
}

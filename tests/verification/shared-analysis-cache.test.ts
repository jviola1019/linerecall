import assert from 'node:assert/strict'
import test from 'node:test'
import type { StockfishAnalysisAdapter } from '../../scripts/verification/lib/stockfish-analysis.ts'
import {
  createSharedAnalysisCache,
  SharedAnalysisCacheAdapter,
} from '../../scripts/verification/lib/shared-analysis-cache.ts'

function delegate(calls: string[]): StockfishAnalysisAdapter {
  return {
    resetForPosition: async () => { calls.push('reset') },
    setMultiPv: (value) => calls.push(`multipv:${value}`),
    analyze: async (options) => {
      calls.push(`analyze:${options.searchMoveUci ?? 'root'}`)
      return {
        bestMoveUci: options.searchMoveUci ?? 'e2e4',
        variations: [{
          multipv: 1, depth: 10, selectiveDepth: 12, nodes: 250000,
          score: { kind: 'centipawn', value: 10 }, bound: 'exact',
          movesUci: [options.searchMoveUci ?? 'e2e4'],
        }],
      }
    },
  }
}

const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

test('shared cache coalesces identical searches across engine adapters', async () => {
  const callsA: string[] = []
  const callsB: string[] = []
  const shared = createSharedAnalysisCache()
  const first = new SharedAnalysisCacheAdapter(delegate(callsA), shared)
  const second = new SharedAnalysisCacheAdapter(delegate(callsB), shared)
  const [left, right] = await Promise.all([
    first.analyze({ fen, nodes: 250000 }),
    second.analyze({ fen, nodes: 250000 }),
  ])
  assert.deepEqual(left, right)
  assert.equal(callsA.filter((call) => call.startsWith('analyze')).length + callsB.filter((call) => call.startsWith('analyze')).length, 1)
  assert.deepEqual({ requests: shared.requests, misses: shared.misses }, { requests: 2, misses: 1 })
})

test('MultiPV and forced-root moves are separate cache identities', async () => {
  const calls: string[] = []
  const shared = createSharedAnalysisCache()
  const adapter = new SharedAnalysisCacheAdapter(delegate(calls), shared)
  await adapter.analyze({ fen, nodes: 250000 })
  adapter.setMultiPv(1)
  await adapter.analyze({ fen, nodes: 250000 })
  await adapter.analyze({ fen, nodes: 250000, searchMoveUci: 'd2d4' })
  assert.equal(shared.misses, 3)
})

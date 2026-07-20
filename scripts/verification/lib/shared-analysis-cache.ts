import type { StockfishAnalysisAdapter } from './stockfish-analysis.ts'
import type { UciAnalysis } from './uci-engine.ts'

export interface SharedAnalysisCacheState {
  entries: Map<string, Promise<UciAnalysis>>
  requests: number
  misses: number
}

export function createSharedAnalysisCache(): SharedAnalysisCacheState {
  return { entries: new Map(), requests: 0, misses: 0 }
}

export class SharedAnalysisCacheAdapter implements StockfishAnalysisAdapter {
  readonly #delegate: StockfishAnalysisAdapter
  readonly #shared: SharedAnalysisCacheState
  #multiPv: 1 | 5 = 5

  constructor(delegate: StockfishAnalysisAdapter, shared: SharedAnalysisCacheState) {
    this.#delegate = delegate
    this.#shared = shared
  }

  setMultiPv(value: 1 | 5): void {
    this.#multiPv = value
    this.#delegate.setMultiPv(value)
  }

  analyze(options: {
    fen: string
    nodes: 250000
    searchMoveUci?: string
    timeoutMs?: number
  }): Promise<UciAnalysis> {
    this.#shared.requests += 1
    const key = JSON.stringify([
      this.#multiPv,
      options.nodes,
      options.fen,
      options.searchMoveUci ?? null,
    ])
    const existing = this.#shared.entries.get(key)
    if (existing) return existing
    this.#shared.misses += 1
    const pending = this.#delegate.analyze(options)
    this.#shared.entries.set(key, pending)
    void pending.catch(() => {
      if (this.#shared.entries.get(key) === pending) this.#shared.entries.delete(key)
    })
    return pending
  }
}

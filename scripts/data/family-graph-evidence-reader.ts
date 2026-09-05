/**
 * Provider-neutral read boundary for family graph construction.
 *
 * The graph builder needs the complete exact-state view, rather than the
 * compact-v3.1 eligible-edge projection.  Implementations must return the
 * source and target EPD/SAN identity and every raw outcome row so the builder
 * can recompute reach and move aggregates for one declared cohort at a time.
 * Implementations are read-only and must verify their immutable source before
 * exposing rows.
 */

export type FamilyGraphLearnerSide = 'white' | 'black'

export interface FamilyGraphPositionRecord {
  epd: string
  positionId: number
  fingerprint: Uint8Array
}

export interface FamilyGraphEdgeRecord {
  edgeId: number
  fingerprint: Uint8Array
  fromPositionId: number
  toPositionId: number
  fromEpd: string
  toEpd: string
  uci: string
  san: string
}

export interface FamilyGraphOutcomeRecord {
  cohortId: string
  month: string
  timeControl: string
  ratingBand: string
  ratingDetail: string
  minPly: number
  n: number
  whiteWins: number
  draws: number
  blackWins: number
}

/** Complete read capabilities required by `family-graph-v3-builder.ts`. */
export interface FamilyGraphEvidenceReader {
  readonly sourceId: 'lichess-broadcasts' | 'lichess-standard-rated-q2-2026'
  readPosition(epd: string): FamilyGraphPositionRecord | null
  readOutgoingEdges(positionId: number): readonly FamilyGraphEdgeRecord[]
  readPositionOutcomes(positionId: number): readonly FamilyGraphOutcomeRecord[]
  readEdgeOutcomes(edgeId: number): readonly FamilyGraphOutcomeRecord[]
  closeAndVerify(): Promise<void>
}

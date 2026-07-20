/**
 * Isolated contracts for the Lichess broadcast backtest pipeline.
 *
 * These deliberately do not import application-domain types. The taxonomy
 * stage only needs to emit BroadcastTargetIndexV1 JSON; an application adapter
 * can translate the audited output after both data stages have completed.
 */

export const BROADCAST_SCHEMA_VERSION = 1 as const
export const BROADCAST_START_MONTH = '2020-01'
export const BROADCAST_CUTOFF_MONTH = '2026-06'
export const BROADCAST_PUBLISHED_GAME_TOTAL = 1_146_297
export const BROADCAST_LIST_URL = 'https://database.lichess.org/broadcast/list.txt'
export const BROADCAST_CHECKSUMS_URL =
  'https://database.lichess.org/broadcast/sha256sums.txt'
export const BROADCAST_LICENSE = 'CC BY-SA 4.0'
export const BROADCAST_LICENSE_URL =
  'https://creativecommons.org/licenses/by-sa/4.0/'

export const RATING_BANDS = [
  '<1800',
  '1800-1999',
  '2000-2199',
  '2200-2399',
  '2400+',
] as const

export type RatingBand = (typeof RATING_BANDS)[number]
export type GameResult = '1-0' | '0-1' | '1/2-1/2'

export interface BroadcastArchive {
  month: string
  filename: string
  url: string
  sha256: string
}

export interface BroadcastManifestV1 {
  schemaVersion: typeof BROADCAST_SCHEMA_VERSION
  generatedAt: string
  startMonth: string
  cutoffMonth: string
  source: {
    listUrl: typeof BROADCAST_LIST_URL
    checksumsUrl: typeof BROADCAST_CHECKSUMS_URL
    license: typeof BROADCAST_LICENSE
    licenseUrl: typeof BROADCAST_LICENSE_URL
  }
  approval: {
    status: 'pending' | 'approved' | 'rejected'
    approvedOn: string | null
    scope: string
    basis: string
    reviewRequiredWhen: string
  }
  archives: BroadcastArchive[]
}

export interface BroadcastTargetV1 {
  /** Normalized four-field EPD. */
  epd: string
  lineIds: string[]
  /** Lines whose terminal sample is this position. */
  terminalLineIds?: string[]
}

export interface BroadcastTargetIndexV1 {
  schemaVersion: typeof BROADCAST_SCHEMA_VERSION
  taxonomyCommit: string
  /** Stop replaying once this many half-moves have been processed. */
  maxPly: number
  targets: BroadcastTargetV1[]
}

export interface RawOutcomeCounts {
  whiteWins: number
  draws: number
  blackWins: number
  n: number
}

export type BandedRawOutcomes = Record<RatingBand, RawOutcomeCounts>

export interface PerspectiveOutcomeStats extends RawOutcomeCounts {
  wins: number
  losses: number
  winRate: number | null
  drawRate: number | null
  lossRate: number | null
}

export interface OutgoingMoveBacktest {
  uci: string
  san: string
  bands: BandedRawOutcomes
}

export interface PositionBacktest {
  epd: string
  lineIds: string[]
  provenanceRef: 'corpus'
  bands: BandedRawOutcomes
  moves: OutgoingMoveBacktest[]
}

export interface TerminalLineBacktest {
  lineId: string
  epd: string
  totalSampleSize: number
  drillEligible: boolean
  provenanceRef: 'corpus'
  bands: Record<
    RatingBand,
    {
      raw: RawOutcomeCounts
      whitePerspective: PerspectiveOutcomeStats
      blackPerspective: PerspectiveOutcomeStats
    }
  >
}

export type RejectionReason =
  | 'record_too_large'
  | 'line_too_long'
  | 'too_many_headers'
  | 'too_many_plies'
  | 'malformed_pgn'
  | 'missing_variant'
  | 'non_standard_variant'
  | 'invalid_result'
  | 'invalid_white_elo'
  | 'invalid_black_elo'
  | 'non_initial_position'

export interface IngestionTotals {
  recordsSeen: number
  accepted: number
  deduplicated: number
  rejected: Partial<Record<RejectionReason, number>>
}

export interface BroadcastBacktestV1 {
  schemaVersion: typeof BROADCAST_SCHEMA_VERSION
  generatedAt: string
  completeCorpus: boolean
  releaseEligible: boolean
  taxonomyCommit: string
  /** Terminal lines and positions use provenanceRef="corpus". */
  corpus: BroadcastManifestV1['source'] & {
    startMonth: string
    cutoffMonth: string
    archives: BroadcastArchive[]
    everyArchiveSha256Verified: true
  }
  filtering: {
    variant: 'Standard (required explicitly)'
    result: '1-0, 0-1, or 1/2-1/2'
    ratings: 'positive integer WhiteElo and BlackElo, each <= 4000'
    startPosition: 'standard initial chess position'
    deduplication: 'normalized GameURL, otherwise deterministic SHA-256 game hash'
    ratingBandBasis: 'arithmetic mean of WhiteElo and BlackElo'
    minimumDrillTerminalSample: 500
  }
  totals: IngestionTotals
  positions: PositionBacktest[]
  terminalLines: TerminalLineBacktest[]
}

export function ratingBandFor(whiteElo: number, blackElo: number): RatingBand {
  const mean = (whiteElo + blackElo) / 2
  if (mean < 1800) return '<1800'
  if (mean < 2000) return '1800-1999'
  if (mean < 2200) return '2000-2199'
  if (mean < 2400) return '2200-2399'
  return '2400+'
}

export function emptyRawOutcomes(): BandedRawOutcomes {
  return Object.fromEntries(
    RATING_BANDS.map((band) => [
      band,
      { whiteWins: 0, draws: 0, blackWins: 0, n: 0 },
    ]),
  ) as unknown as BandedRawOutcomes
}

export function addResult(counts: RawOutcomeCounts, result: GameResult): void {
  counts.n += 1
  if (result === '1-0') counts.whiteWins += 1
  else if (result === '0-1') counts.blackWins += 1
  else counts.draws += 1
}

function percentage(value: number, n: number): number | null {
  return n === 0 ? null : Math.round((value / n) * 10_000) / 100
}

export function perspectiveStats(
  raw: RawOutcomeCounts,
  side: 'white' | 'black',
): PerspectiveOutcomeStats {
  const wins = side === 'white' ? raw.whiteWins : raw.blackWins
  const losses = side === 'white' ? raw.blackWins : raw.whiteWins
  return {
    ...raw,
    wins,
    losses,
    winRate: percentage(wins, raw.n),
    drawRate: percentage(raw.draws, raw.n),
    lossRate: percentage(losses, raw.n),
  }
}

export function isMonth(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`${label} must be an array of non-empty strings`)
  }
}

export function assertBroadcastManifest(
  value: unknown,
): asserts value is BroadcastManifestV1 {
  assertObject(value, 'broadcast manifest')
  if (value.schemaVersion !== BROADCAST_SCHEMA_VERSION) {
    throw new Error('Unsupported broadcast manifest schemaVersion')
  }
  if (!isMonth(value.startMonth) || !isMonth(value.cutoffMonth)) {
    throw new Error('Broadcast manifest months are invalid')
  }
  assertObject(value.source, 'broadcast manifest source')
  if (
    value.source.listUrl !== BROADCAST_LIST_URL ||
    value.source.checksumsUrl !== BROADCAST_CHECKSUMS_URL ||
    value.source.license !== BROADCAST_LICENSE ||
    value.source.licenseUrl !== BROADCAST_LICENSE_URL
  ) {
    throw new Error('Broadcast manifest provenance or license does not match the approved source')
  }
  assertObject(value.approval, 'broadcast manifest approval')
  if (
    value.approval.status !== 'pending' &&
    value.approval.status !== 'approved' &&
    value.approval.status !== 'rejected'
  ) {
    throw new Error('Broadcast manifest approval status is invalid')
  }
  if (
    (value.approval.approvedOn !== null &&
      (typeof value.approval.approvedOn !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value.approval.approvedOn))) ||
    typeof value.approval.scope !== 'string' ||
    typeof value.approval.basis !== 'string' ||
    typeof value.approval.reviewRequiredWhen !== 'string' ||
    value.approval.scope.length === 0 ||
    value.approval.basis.length === 0 ||
    value.approval.reviewRequiredWhen.length === 0
  ) {
    throw new Error('Broadcast manifest approval metadata is invalid')
  }
  if (!Array.isArray(value.archives) || value.archives.length === 0) {
    throw new Error('Broadcast manifest must contain at least one archive')
  }
  const months = new Set<string>()
  for (const [index, archiveValue] of value.archives.entries()) {
    assertObject(archiveValue, `archive ${index}`)
    if (
      !isMonth(archiveValue.month) ||
      typeof archiveValue.filename !== 'string' ||
      typeof archiveValue.url !== 'string' ||
      typeof archiveValue.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(archiveValue.sha256)
    ) {
      throw new Error(`Archive ${index} is invalid`)
    }
    const expectedFilename = `lichess_db_broadcast_${archiveValue.month}.pgn.zst`
    const expectedUrl = `https://database.lichess.org/broadcast/${expectedFilename}`
    if (archiveValue.filename !== expectedFilename || archiveValue.url !== expectedUrl) {
      throw new Error(`Archive ${index} is not an approved Lichess broadcast URL`)
    }
    if (months.has(archiveValue.month)) throw new Error(`Duplicate archive month: ${archiveValue.month}`)
    months.add(archiveValue.month)
    if (index > 0 && value.archives[index - 1]?.month >= archiveValue.month) {
      throw new Error('Broadcast archives must be in canonical ascending month order')
    }
  }
  let expectedMonth = value.startMonth
  let expectedCount = 0
  while (expectedMonth <= value.cutoffMonth) {
    if (!months.has(expectedMonth)) throw new Error(`Broadcast manifest is missing month ${expectedMonth}`)
    expectedCount += 1
    const [yearText, monthText] = expectedMonth.split('-')
    const year = Number(yearText)
    const month = Number(monthText)
    expectedMonth = month === 12
      ? `${year + 1}-01`
      : `${year}-${String(month + 1).padStart(2, '0')}`
  }
  if (value.archives.length !== expectedCount) {
    throw new Error('Broadcast manifest contains archives outside its declared month range')
  }
}

export function assertBroadcastManifestApproved(
  value: unknown,
): asserts value is BroadcastManifestV1 {
  assertBroadcastManifest(value)
  if (value.approval.status !== 'approved' || value.approval.approvedOn === null) {
    throw new Error(`Broadcast ingestion is not approved (status: ${value.approval.status})`)
  }
  if (
    value.startMonth !== BROADCAST_START_MONTH ||
    value.cutoffMonth !== BROADCAST_CUTOFF_MONTH ||
    value.archives.length !== 78
  ) {
    throw new Error('Broadcast approval applies only to the complete 2020-01 through 2026-06 corpus')
  }
}

export function assertBroadcastTargetIndex(
  value: unknown,
): asserts value is BroadcastTargetIndexV1 {
  assertObject(value, 'broadcast target index')
  if (value.schemaVersion !== BROADCAST_SCHEMA_VERSION) {
    throw new Error('Unsupported broadcast target schemaVersion')
  }
  if (typeof value.taxonomyCommit !== 'string' || !/^[a-f0-9]{7,64}$/i.test(value.taxonomyCommit)) {
    throw new Error('taxonomyCommit must be a Git commit hash')
  }
  if (!Number.isInteger(value.maxPly) || (value.maxPly as number) < 1 || (value.maxPly as number) > 200) {
    throw new Error('maxPly must be an integer from 1 through 200')
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    throw new Error('Target index must contain at least one position')
  }
  const epds = new Set<string>()
  const terminalLines = new Set<string>()
  const allLines = new Set<string>()
  for (const [index, targetValue] of value.targets.entries()) {
    assertObject(targetValue, `target ${index}`)
    if (typeof targetValue.epd !== 'string' || targetValue.epd.trim().split(/\s+/).length !== 4) {
      throw new Error(`Target ${index} must have a four-field EPD`)
    }
    if (epds.has(targetValue.epd)) throw new Error(`Duplicate target EPD: ${targetValue.epd}`)
    epds.add(targetValue.epd)
    assertStringArray(targetValue.lineIds, `target ${index}.lineIds`)
    for (const lineId of targetValue.lineIds) allLines.add(lineId)
    if (targetValue.terminalLineIds !== undefined) {
      assertStringArray(targetValue.terminalLineIds, `target ${index}.terminalLineIds`)
      for (const lineId of targetValue.terminalLineIds) {
        if (!targetValue.lineIds.includes(lineId)) {
          throw new Error(`Terminal line ${lineId} is not present in target lineIds`)
        }
        if (terminalLines.has(lineId)) {
          throw new Error(`Terminal line ${lineId} is assigned to multiple EPDs`)
        }
        terminalLines.add(lineId)
      }
    }
  }
  for (const lineId of allLines) {
    if (!terminalLines.has(lineId)) throw new Error(`Line ${lineId} has no terminal target position`)
  }
}

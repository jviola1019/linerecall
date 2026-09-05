import { createHash } from 'node:crypto'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { z } from 'zod'
import { normalizedEpd } from './broadcast-pgn.ts'
import {
  EpdSchema,
  UciMoveSchema,
  type LichessPuzzleManifest,
  type PuzzleIntegrityReceipt,
} from './evidence-contracts.ts'

export const PUZZLE_SCHEMA_VERSION = 3 as const
export const PUZZLE_COLUMNS = [
  'PuzzleId',
  'FEN',
  'Moves',
  'Rating',
  'RatingDeviation',
  'Popularity',
  'NbPlays',
  'Themes',
  'GameUrl',
  'OpeningTags',
] as const

export type PuzzleFilterReason =
  | 'malformed_csv'
  | 'invalid_id'
  | 'invalid_fen'
  | 'invalid_moves'
  | 'invalid_metrics'
  | 'missing_opening_tags'
  | 'outside_decision_count'
  | 'low_plays'
  | 'low_popularity'
  | 'high_rating_deviation'
  | 'invalid_game_url'

export interface PuzzleSourceRow {
  puzzleId: string
  fen: string
  moves: string[]
  rating: number
  ratingDeviation: number
  popularity: number
  plays: number
  themes: string[]
  gameUrl: string
  openingTags: string[]
}

export interface PuzzleAssociationIndex {
  hasExactPosition(epd: string): boolean
  taxonomyLineIdsForTag(tag: string): readonly string[]
}

export interface PuzzleGraphArchiveIdentity {
  archiveId: string
  sourceId: 'lichess-broadcasts' | 'lichess-standard-rated-q2-2026'
  month: string
  sha256: string
}

/**
 * Historical review-fixture validator only. It describes the retired
 * graph_metadata/archive_runs evidence shape and is retained for regression
 * tests; production puzzle ingestion must use loadPuzzleV3Prerequisites.
 */
export function assertPuzzleGraphPrerequisite(input: {
  schemaVersion: string | undefined
  completeBaselineMaximumPly: string | undefined
  adaptiveMaximumPly: string | undefined
  completed: readonly PuzzleGraphArchiveIdentity[]
  expected: readonly PuzzleGraphArchiveIdentity[]
}): void {
  if (input.schemaVersion !== '3') throw new Error('Puzzle association requires compact evidence graph schema 3')
  if (input.completeBaselineMaximumPly !== '30') {
    throw new Error('Puzzle association requires complete baseline evidence through ply 30')
  }
  if (input.adaptiveMaximumPly !== '100') {
    throw new Error('Puzzle association requires adaptive book evidence through ply 100')
  }
  const expected = new Map(input.expected.map((archive) => [archive.archiveId, archive]))
  if (expected.size !== input.expected.length) throw new Error('Puzzle graph prerequisite contains duplicate expected archives')
  const seen = new Set<string>()
  for (const archive of input.completed) {
    if (seen.has(archive.archiveId)) throw new Error(`Evidence graph repeats archive ${archive.archiveId}`)
    seen.add(archive.archiveId)
    const approved = expected.get(archive.archiveId)
    if (!approved) throw new Error(`Evidence graph contains unapproved archive ${archive.archiveId}`)
    if (
      archive.sourceId !== approved.sourceId || archive.month !== approved.month ||
      archive.sha256 !== approved.sha256
    ) throw new Error(`Evidence graph archive identity changed for ${archive.archiveId}`)
  }
  const missing = [...expected.keys()].filter((archiveId) => !seen.has(archiveId))
  if (missing.length > 0) throw new Error(`Evidence graph is incomplete; missing ${missing.length} approved archives`)
}

export const PuzzleSourceBindingSchema = z.object({
  schemaVersion: z.literal(PUZZLE_SCHEMA_VERSION),
  sourceId: z.literal('lichess-puzzle-database'),
  sourceUrl: z.literal('https://database.lichess.org/lichess_db_puzzle.csv.zst'),
  sourceAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  publishedPuzzleTotal: z.number().int().positive(),
  licenseSpdxId: z.literal('CC0-1.0'),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  observedEtag: z.string().min(1).max(512),
  observedLastModified: z.string().min(1).max(512),
  digestComputedAt: z.string().datetime({ offset: true }),
  approvedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  approvedBy: z.string().min(1).max(256),
  selectionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

export type PuzzleSourceBinding = z.infer<typeof PuzzleSourceBindingSchema>

/** Bind the separately approved local digest to the exact source manifest. */
export function createPuzzleSourceBinding(
  manifestInput: LichessPuzzleManifest,
  receiptInput: PuzzleIntegrityReceipt,
): PuzzleSourceBinding {
  const manifest = manifestInput
  const receipt = receiptInput
  if (manifest.approval.status !== 'approved') throw new Error('Puzzle source manifest is not approved')
  if (receipt.approval.status !== 'approved' || !receipt.approval.approvedOn || !receipt.approval.approvedBy) {
    throw new Error(`Puzzle integrity receipt is not approved (status: ${receipt.approval.status})`)
  }
  if (
    receipt.sourceId !== manifest.source.id ||
    receipt.sourceUrl !== manifest.source.artifactUrl ||
    receipt.bytes !== manifest.artifact.bytes ||
    receipt.observedEtag !== manifest.artifact.etagObserved ||
    receipt.observedLastModified !== manifest.artifact.lastModifiedObserved
  ) throw new Error('Puzzle integrity receipt does not match the approved source identity')
  if (Date.parse(`${receipt.approval.approvedOn}T23:59:59.999Z`) < Date.parse(receipt.computedAt)) {
    throw new Error('Puzzle digest approval predates its computation')
  }
  const selectionSha256 = createHash('sha256')
    .update(JSON.stringify(manifest.selection))
    .digest('hex')
  return PuzzleSourceBindingSchema.parse({
    schemaVersion: PUZZLE_SCHEMA_VERSION,
    sourceId: receipt.sourceId,
    sourceUrl: receipt.sourceUrl,
    sourceAsOf: manifest.source.asOf,
    publishedPuzzleTotal: manifest.source.publishedPuzzleTotal,
    licenseSpdxId: manifest.license.spdxId,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    observedEtag: receipt.observedEtag,
    observedLastModified: receipt.observedLastModified,
    digestComputedAt: receipt.computedAt,
    approvedOn: receipt.approval.approvedOn,
    approvedBy: receipt.approval.approvedBy,
    selectionSha256,
  })
}

export const PuzzleAssociationSchema = z.object({
  confidence: z.enum(['exact-position', 'opening-family', 'unlinked']),
  positionEpd: EpdSchema,
  taxonomyLineId: z.string().regex(/^tax_[a-f0-9]{24}$/u).nullable(),
  openingTag: z.string().max(128).nullable(),
}).strict()

export const PuzzleLearnerNodeSchema = z.object({
  learnerIndex: z.number().int().min(0).max(4),
  solutionMoveIndex: z.number().int().min(1).max(9),
  fen: z.string().min(1).max(128),
  epd: EpdSchema,
  expectedMoveUci: UciMoveSchema,
  expectedMoveSan: z.string().min(1).max(32),
  forcedReplyUci: UciMoveSchema.nullable(),
  mateInOne: z.boolean(),
}).strict()

export type PuzzleLearnerNode = z.infer<typeof PuzzleLearnerNodeSchema>

export interface PuzzleSolutionReplay {
  presentationFen: string
  presentationEpd: string
  learnerNodes: PuzzleLearnerNode[]
  finalFen: string
}

export const PUZZLE_ENGINE_SETTINGS = Object.freeze({
  threads: 1 as const,
  hashMb: 128 as const,
  multiPv: 5 as const,
  nodes: 250_000 as const,
})

export const PUZZLE_ENGINE_SETTINGS_SHA256 = createHash('sha256')
  .update(JSON.stringify(PUZZLE_ENGINE_SETTINGS))
  .digest('hex')

const PuzzleCandidateBaseSchema = z.object({
  schemaVersion: z.literal(PUZZLE_SCHEMA_VERSION),
  puzzleId: z.string().regex(/^[A-Za-z0-9]{5,16}$/u),
  initialFen: z.string().min(1).max(128),
  presentationFen: z.string().min(1).max(128),
  presentationEpd: EpdSchema,
  movesUci: z.array(UciMoveSchema).min(2).max(11),
  learnerDecisions: z.number().int().min(1).max(5),
  learnerNodes: z.array(PuzzleLearnerNodeSchema).min(1).max(5),
  rating: z.number().int().min(0).max(5000),
  ratingDeviation: z.number().int().min(0).max(100),
  popularity: z.number().int().min(80).max(100),
  plays: z.number().int().min(100),
  themes: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)).min(1).max(64),
  sourceGameUrl: z.string().url().startsWith('https://lichess.org/'),
  openingTags: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u)).min(1).max(64),
  association: PuzzleAssociationSchema,
  engineStatus: z.literal('pending'),
  releaseEligible: z.literal(false),
}).strict()

function validateCandidateReplay(
  candidate: z.infer<typeof PuzzleCandidateBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (candidate.learnerNodes.length !== candidate.learnerDecisions) {
    context.addIssue({ code: 'custom', path: ['learnerNodes'], message: 'Every learner decision requires one replay node' })
  }
  try {
    const replay = replayPuzzleSolution(candidate.initialFen, candidate.movesUci)
    if (replay.presentationFen !== candidate.presentationFen || replay.presentationEpd !== candidate.presentationEpd) {
      context.addIssue({ code: 'custom', path: ['presentationFen'], message: 'Stored presentation position does not match legal setup replay' })
    }
    for (const [index, node] of candidate.learnerNodes.entries()) {
      if (JSON.stringify(node) !== JSON.stringify(replay.learnerNodes[index])) {
        context.addIssue({ code: 'custom', path: ['learnerNodes', index], message: 'Learner node does not match legal solution replay' })
      }
    }
  } catch {
    context.addIssue({ code: 'custom', path: ['movesUci'], message: 'Puzzle solution cannot be replayed legally' })
  }
}

export const PuzzleCandidateSchema = PuzzleCandidateBaseSchema.superRefine(validateCandidateReplay)

const PuzzleEngineScoreSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('centipawn'), value: z.number().int().min(-100_000).max(100_000) }).strict(),
  z.object({ kind: z.literal('mate'), value: z.number().int().min(-1_000).max(1_000).refine((value) => value !== 0) }).strict(),
])

export const PuzzleEngineSearchObservationSchema = z.object({
  multipv: z.number().int().min(1).max(5),
  depth: z.number().int().nonnegative().nullable(),
  selectiveDepth: z.number().int().nonnegative().nullable(),
  nodes: z.number().int().min(PUZZLE_ENGINE_SETTINGS.nodes),
  score: PuzzleEngineScoreSchema,
  bound: z.literal('exact'),
  movesUci: z.array(UciMoveSchema).min(1).max(100),
}).strict()

const PuzzleExpectedMoveObservationSchema = z.object({
  searchMode: z.enum(['root-multipv', 'forced-search']),
  variation: PuzzleEngineSearchObservationSchema,
}).strict()

function scoreOrderingValue(score: z.infer<typeof PuzzleEngineScoreSchema>): number {
  if (score.kind === 'centipawn') return score.value
  if (score.value > 0) return 1_000_000 - Math.min(score.value, 999) * 1_000
  return -1_000_000 + Math.min(Math.abs(score.value), 999) * 1_000
}

function derivePuzzleEngineComparison(
  best: z.infer<typeof PuzzleEngineScoreSchema>,
  candidate: z.infer<typeof PuzzleEngineScoreSchema>,
): { centipawnLoss: number | null; mateConsistent: boolean; status: 'pass' | 'fail' } {
  const candidateLosesByMate = candidate.kind === 'mate' && candidate.value < 0
  const mateConsistent = !candidateLosesByMate && (
    best.kind === 'centipawn'
      ? candidate.kind === 'centipawn' || (candidate.kind === 'mate' && candidate.value > 0)
      : best.value > 0 && candidate.kind === 'mate' && candidate.value > 0
  )
  const centipawnLoss = best.kind === 'centipawn' && candidate.kind === 'centipawn'
    ? Math.max(0, best.value - candidate.value)
    : best.kind === 'mate' && candidate.kind === 'mate' && best.value > 0 && candidate.value > 0
      ? 0
      : null
  return {
    centipawnLoss,
    mateConsistent,
    status: mateConsistent && (centipawnLoss === null || centipawnLoss <= 50) ? 'pass' : 'fail',
  }
}

function principalVariationIsLegal(epd: string, moves: readonly string[]): boolean {
  try {
    const chess = new Chess(`${epd} 0 1`)
    for (const uci of moves) chess.move(moveInput(uci))
    return true
  } catch {
    return false
  }
}

export const PuzzleEngineProofSchema = z.object({
  learnerIndex: z.number().int().min(0).max(4),
  positionEpd: EpdSchema,
  expectedMoveUci: UciMoveSchema,
  engineBestMoveUci: UciMoveSchema,
  centipawnLoss: z.number().int().nonnegative().nullable(),
  mateConsistent: z.boolean(),
  status: z.enum(['pass', 'fail']),
  engine: z.literal('Stockfish 18'),
  engineSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  nnueSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  settingsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  settings: z.object({
    threads: z.literal(1),
    hashMb: z.literal(128),
    multiPv: z.literal(5),
    nodes: z.literal(250_000),
  }).strict(),
  rootVariations: z.array(PuzzleEngineSearchObservationSchema).min(1).max(5),
  expectedMoveObservation: PuzzleExpectedMoveObservationSchema,
  principalVariationUci: z.array(UciMoveSchema).min(1).max(100),
  analyzedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((proof, context) => {
  let legalMoveCount: number | null = null
  try {
    legalMoveCount = new Chess(`${proof.positionEpd} 0 1`).moves().length
  } catch {
    context.addIssue({ code: 'custom', path: ['positionEpd'], message: 'Engine proof EPD is not a legal Standard chess position' })
  }
  if (legalMoveCount !== null && proof.rootVariations.length !== Math.min(5, legalMoveCount)) {
    context.addIssue({ code: 'custom', path: ['rootVariations'], message: 'Root observations must retain every required MultiPV line' })
  }
  if (proof.rootVariations.some(({ multipv }, index) => multipv !== index + 1)) {
    context.addIssue({ code: 'custom', path: ['rootVariations'], message: 'Root MultiPV observations must be contiguous and sorted from one' })
  }
  const rootMoves = proof.rootVariations.map(({ movesUci }) => movesUci[0])
  if (new Set(rootMoves).size !== rootMoves.length) {
    context.addIssue({ code: 'custom', path: ['rootVariations'], message: 'Root MultiPV observations must begin with distinct moves' })
  }
  for (const [index, variation] of proof.rootVariations.entries()) {
    if (!principalVariationIsLegal(proof.positionEpd, variation.movesUci)) {
      context.addIssue({ code: 'custom', path: ['rootVariations', index, 'movesUci'], message: 'Root engine PV does not replay legally from the learner position' })
    }
    const prior = proof.rootVariations[index - 1]
    if (prior && scoreOrderingValue(variation.score) > scoreOrderingValue(prior.score)) {
      context.addIssue({ code: 'custom', path: ['rootVariations', index, 'score'], message: 'Root MultiPV scores are not ordered best-first' })
    }
  }
  const best = proof.rootVariations[0]
  const expected = proof.expectedMoveObservation.variation
  if (!best) return
  if (best.movesUci[0] !== proof.engineBestMoveUci) {
    context.addIssue({ code: 'custom', path: ['engineBestMoveUci'], message: 'Engine best move must be derived from exact MultiPV 1' })
  }
  if (expected.movesUci[0] !== proof.expectedMoveUci || !principalVariationIsLegal(proof.positionEpd, expected.movesUci)) {
    context.addIssue({ code: 'custom', path: ['expectedMoveObservation'], message: 'Expected-move observation must begin with the expected move and replay legally' })
  }
  const matchingRoot = proof.rootVariations.find(({ movesUci }) => movesUci[0] === proof.expectedMoveUci)
  if (proof.expectedMoveObservation.searchMode === 'root-multipv') {
    if (!matchingRoot || JSON.stringify(matchingRoot) !== JSON.stringify(expected)) {
      context.addIssue({ code: 'custom', path: ['expectedMoveObservation'], message: 'Root expected-move evidence must be the exact matching MultiPV observation' })
    }
  } else if (matchingRoot || expected.multipv !== 1) {
    context.addIssue({ code: 'custom', path: ['expectedMoveObservation'], message: 'Forced expected-move evidence must be an independent MultiPV-1 search for a move absent from the root lines' })
  }
  if (scoreOrderingValue(expected.score) > scoreOrderingValue(best.score)) {
    context.addIssue({ code: 'custom', path: ['expectedMoveObservation', 'variation', 'score'], message: 'Expected-move evaluation cannot outrank the reported engine best move' })
  }
  const derived = derivePuzzleEngineComparison(best.score, expected.score)
  if (
    proof.centipawnLoss !== derived.centipawnLoss
    || proof.mateConsistent !== derived.mateConsistent
    || proof.status !== derived.status
  ) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Engine result fields must be the exact projection of recorded search observations' })
  }
  if (JSON.stringify(proof.principalVariationUci) !== JSON.stringify(best.movesUci)) {
    context.addIssue({ code: 'custom', path: ['principalVariationUci'], message: 'Engine PV must equal the exact MultiPV-1 observation' })
  }
  if (proof.settingsSha256 !== PUZZLE_ENGINE_SETTINGS_SHA256) {
    context.addIssue({ code: 'custom', path: ['settingsSha256'], message: 'Engine settings hash does not match the fixed puzzle policy' })
  }
})

export const VerifiedPuzzleRecordSchema = PuzzleCandidateBaseSchema.omit({
  engineStatus: true,
  releaseEligible: true,
}).extend({
  engineStatus: z.enum(['verified', 'quarantined']),
  engineChecks: z.array(PuzzleEngineProofSchema).min(1).max(5),
  releaseEligible: z.boolean(),
}).strict().superRefine((record, context) => {
  validateCandidateReplay({ ...record, engineStatus: 'pending', releaseEligible: false }, context)
  const allNodesProven = record.engineChecks.length === record.learnerNodes.length &&
    record.learnerNodes.every((node, index) => {
      const proof = record.engineChecks[index]
      return proof?.learnerIndex === node.learnerIndex && proof.positionEpd === node.epd &&
        proof.expectedMoveUci === node.expectedMoveUci && proof.status === 'pass'
    })
  if ((record.engineStatus === 'verified') !== allNodesProven) {
    context.addIssue({
      code: 'custom',
      path: ['engineStatus'],
      message: 'Verified status requires matching passing Stockfish proofs for every learner node',
    })
  }
  const eligible = allNodesProven && record.association.confidence !== 'unlinked'
  if (record.releaseEligible !== eligible) {
    context.addIssue({
      code: 'custom',
      path: ['releaseEligible'],
      message: 'Release requires a linked puzzle and a matching passing Stockfish proof for every learner node',
    })
  }
})

export type PuzzleCandidate = z.infer<typeof PuzzleCandidateSchema>
export type VerifiedPuzzleRecord = z.infer<typeof VerifiedPuzzleRecordSchema>

function integer(value: string, minimum: number, maximum: number): number | null {
  if (!/^-?\d{1,10}$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}

function moveInput(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
}

/** Parse one bounded RFC-4180 record. Embedded newlines are intentionally forbidden. */
export function parsePuzzleCsvLine(line: string): string[] | null {
  if (line.includes('\0') || line.includes('\r') || line.includes('\n')) return null
  const fields: string[] = []
  let field = ''
  let quoted = false
  let afterQuote = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
          afterQuote = true
        }
      } else {
        field += character
      }
      continue
    }
    if (afterQuote) {
      if (character !== ',') return null
      fields.push(field)
      field = ''
      afterQuote = false
      continue
    }
    if (character === ',' ) {
      fields.push(field)
      field = ''
    } else if (character === '"') {
      if (field.length !== 0) return null
      quoted = true
    } else {
      field += character
    }
  }
  if (quoted) return null
  fields.push(field)
  return fields
}

export function parsePuzzleSourceLine(
  line: string,
): { accepted: true; row: PuzzleSourceRow } | { accepted: false; reason: PuzzleFilterReason } {
  const fields = parsePuzzleCsvLine(line)
  if (!fields) return { accepted: false, reason: 'malformed_csv' }
  return parsePuzzleSourceFields(fields)
}

export function parsePuzzleSourceFields(
  fields: readonly string[],
): { accepted: true; row: PuzzleSourceRow } | { accepted: false; reason: PuzzleFilterReason } {
  if (fields.length !== PUZZLE_COLUMNS.length) return { accepted: false, reason: 'malformed_csv' }
  const [puzzleId, fen, moveText, ratingText, deviationText, popularityText, playsText, themeText, gameUrl, tagText] = fields
  if (!puzzleId || !/^[A-Za-z0-9]{5,16}$/u.test(puzzleId)) return { accepted: false, reason: 'invalid_id' }
  let chess: Chess
  try {
    chess = new Chess(fen)
  } catch {
    return { accepted: false, reason: 'invalid_fen' }
  }
  const moves = moveText?.split(/\s+/u).filter(Boolean) ?? []
  if (moves.length < 2 || moves.length > 11 || moves.some((move) => !/^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(move))) {
    return { accepted: false, reason: 'invalid_moves' }
  }
  try {
    replayPuzzleSolution(fen!, moves)
  } catch {
    return { accepted: false, reason: 'invalid_moves' }
  }
  const rating = integer(ratingText ?? '', 0, 5000)
  const ratingDeviation = integer(deviationText ?? '', 0, 5000)
  const popularity = integer(popularityText ?? '', -100, 100)
  const plays = integer(playsText ?? '', 0, 2_000_000_000)
  if (rating === null || ratingDeviation === null || popularity === null || plays === null) {
    return { accepted: false, reason: 'invalid_metrics' }
  }
  const learnerDecisions = Math.ceil((moves.length - 1) / 2)
  if (learnerDecisions < 1 || learnerDecisions > 5) return { accepted: false, reason: 'outside_decision_count' }
  if (plays < 100) return { accepted: false, reason: 'low_plays' }
  if (popularity < 80) return { accepted: false, reason: 'low_popularity' }
  if (ratingDeviation > 100) return { accepted: false, reason: 'high_rating_deviation' }
  const openingTags = tagText?.split(/\s+/u).filter(Boolean) ?? []
  if (openingTags.length === 0) return { accepted: false, reason: 'missing_opening_tags' }
  if (openingTags.length > 64 || openingTags.some((tag) => !/^[A-Za-z0-9_-]{1,128}$/u.test(tag))) {
    return { accepted: false, reason: 'missing_opening_tags' }
  }
  const themes = themeText?.split(/\s+/u).filter(Boolean) ?? []
  if (themes.length === 0 || themes.length > 64 || themes.some((theme) => !/^[A-Za-z0-9_-]{1,64}$/u.test(theme))) {
    return { accepted: false, reason: 'malformed_csv' }
  }
  try {
    const parsedUrl = new URL(gameUrl ?? '')
    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname.toLowerCase() !== 'lichess.org') {
      return { accepted: false, reason: 'invalid_game_url' }
    }
  } catch {
    return { accepted: false, reason: 'invalid_game_url' }
  }
  return {
    accepted: true,
    row: {
      puzzleId,
      fen: fen!,
      moves,
      rating,
      ratingDeviation,
      popularity,
      plays,
      themes,
      gameUrl: gameUrl!,
      openingTags,
    },
  }
}

/**
 * Replay the Lichess puzzle convention: move zero is the setup move, odd move
 * indexes are learner decisions, and the following even indexes are forced
 * opponent replies. No position is inferred or snapped from a stored FEN.
 */
export function replayPuzzleSolution(initialFen: string, movesUci: readonly string[]): PuzzleSolutionReplay {
  if (movesUci.length < 2 || movesUci.length > 11) throw new Error('Puzzle solution must contain 2 through 11 moves')
  const chess = new Chess(initialFen)
  const setup = chess.move(moveInput(UciMoveSchema.parse(movesUci[0])))
  if (!setup) throw new Error('Puzzle setup move is illegal')
  const presentationFen = chess.fen()
  const presentationEpd = normalizedEpd(chess)
  const learnerNodes: PuzzleLearnerNode[] = []
  for (let moveIndex = 1; moveIndex < movesUci.length; moveIndex += 2) {
    const expectedMoveUci = UciMoveSchema.parse(movesUci[moveIndex])
    const fen = chess.fen()
    const epd = normalizedEpd(chess)
    const expected = chess.move(moveInput(expectedMoveUci))
    if (!expected) throw new Error(`Learner move ${expectedMoveUci} is illegal`)
    const mateInOne = chess.isCheckmate()
    const replyInput = movesUci[moveIndex + 1]
    let forcedReplyUci: string | null = null
    if (replyInput !== undefined) {
      if (mateInOne) throw new Error('A checkmating learner move cannot have a forced reply')
      forcedReplyUci = UciMoveSchema.parse(replyInput)
      const reply = chess.move(moveInput(forcedReplyUci))
      if (!reply) throw new Error(`Forced reply ${forcedReplyUci} is illegal`)
    }
    learnerNodes.push(PuzzleLearnerNodeSchema.parse({
      learnerIndex: learnerNodes.length,
      solutionMoveIndex: moveIndex,
      fen,
      epd,
      expectedMoveUci,
      expectedMoveSan: expected.san,
      forcedReplyUci,
      mateInOne,
    }))
  }
  return { presentationFen, presentationEpd, learnerNodes, finalFen: chess.fen() }
}

export function associatePuzzle(
  presentationEpd: string,
  openingTags: readonly string[],
  index: PuzzleAssociationIndex,
): z.infer<typeof PuzzleAssociationSchema> {
  if (index.hasExactPosition(presentationEpd)) {
    return {
      confidence: 'exact-position',
      positionEpd: presentationEpd,
      taxonomyLineId: null,
      openingTag: null,
    }
  }
  const tags = [...new Set(openingTags)]
  const specificity = (tag: string): number => tag.split('_').filter(Boolean).length
  const maximumSpecificity = Math.max(...tags.map(specificity))
  const mostSpecific = tags
    .filter((tag) => specificity(tag) === maximumSpecificity)
    .sort((left, right) => right.length - left.length || left.localeCompare(right, 'en'))
  const matches = mostSpecific.map((tag) => ({
    tag,
    lineIds: [...new Set(index.taxonomyLineIdsForTag(tag))].sort(),
  }))
  const uniqueLineIds = [...new Set(matches.flatMap((match) => match.lineIds))]
  if (uniqueLineIds.length === 1) {
    const match = matches.find((candidate) => candidate.lineIds.includes(uniqueLineIds[0]!))
    if (match) {
      return {
        confidence: 'opening-family',
        positionEpd: presentationEpd,
        taxonomyLineId: uniqueLineIds[0]!,
        openingTag: match.tag,
      }
    }
  }
  return {
    confidence: 'unlinked',
    positionEpd: presentationEpd,
    taxonomyLineId: null,
    openingTag: mostSpecific[0] ?? null,
  }
}

export function puzzleCandidateFromRow(
  row: PuzzleSourceRow,
  associationIndex: PuzzleAssociationIndex,
): PuzzleCandidate {
  let replay: PuzzleSolutionReplay
  try {
    replay = replayPuzzleSolution(row.fen, row.moves)
  } catch {
    throw new Error(`Puzzle ${row.puzzleId} solution became illegal`)
  }
  return PuzzleCandidateSchema.parse({
    schemaVersion: PUZZLE_SCHEMA_VERSION,
    puzzleId: row.puzzleId,
    initialFen: row.fen,
    presentationFen: replay.presentationFen,
    presentationEpd: replay.presentationEpd,
    movesUci: row.moves,
    learnerDecisions: replay.learnerNodes.length,
    learnerNodes: replay.learnerNodes,
    rating: row.rating,
    ratingDeviation: row.ratingDeviation,
    popularity: row.popularity,
    plays: row.plays,
    themes: row.themes,
    sourceGameUrl: row.gameUrl,
    openingTags: row.openingTags,
    association: associatePuzzle(replay.presentationEpd, row.openingTags, associationIndex),
    engineStatus: 'pending',
    releaseEligible: false,
  })
}

export function isPuzzleHeader(line: string): boolean {
  const fields = parsePuzzleCsvLine(line)
  return fields !== null && fields.length === PUZZLE_COLUMNS.length &&
    fields.every((field, index) => field === PUZZLE_COLUMNS[index])
}

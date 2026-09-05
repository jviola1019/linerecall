import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { z } from 'zod'
import { EcoCodeSchema, EpdSchema, UciMoveSchema } from './opening-data.ts'
import { normalizedEpd } from './input-validation.ts'
import {
  MAX_APPROVED_EVIDENCE_GAMES,
  TRINOMIAL_PROFILE_LIKELIHOOD_95_METHOD,
  assertTrinomialScoreProfileLikelihoodInterval,
} from './statistics.ts'

export const REPERTOIRE_SCHEMA_VERSION = 1 as const
export const REPERTOIRE_MAX_PLY = 100 as const
export const CORE_MINIMUM_LEARNER_DECISIONS = 10 as const
export const CORE_MINIMUM_OPPONENT_BRANCHES = 2 as const
export const DEFAULT_PRIMARY_COVERAGE = 0.85 as const
// This is a corruption guard above the known legal-move maximum, not a branch
// selection limit. Every audited eligible move remains represented.
export const REPERTOIRE_MAX_POSITION_EDGES = 256 as const

const PackIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}$/u)
const PositionIdSchema = z.string().regex(/^pos_[a-f0-9]{16}$/u)
const EdgeIdSchema = z.string().regex(/^edge_[a-f0-9]{20}$/u)
const PathIdSchema = z.string().regex(/^path_[a-f0-9]{20}$/u)
const CohortIdSchema = z.string().regex(/^cohort_[a-z0-9-]{3,64}$/u)
const CardIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::pos_[a-f0-9]{16}$/u)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const ReceiptIdSchema = z.string().regex(/^receipt_[a-f0-9]{16}$/u)
const FamilyIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
const ReleaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,159}$/u)
const SAFE_RECEIPT_PATH = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)*\.json$/u

export const RepertoireProvenanceRefSchema = z.string()
  .min(3)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9._:-]{2,159}$/u)

export const EvidenceSourceSchema = z.enum(['broadcast', 'lichess-standard'])
export const EvidenceRatingSystemSchema = z.enum(['broadcast-rating', 'lichess-glicko2'])
export const EvidenceTimeControlSchema = z.enum(['blitz', 'rapid', 'classical'])
export const CanonicalEvidenceRatingBandSchema = z.enum([
  '<1800',
  '1800-1999',
  '2000-2199',
  '2200-2399',
  '2400+',
])
export const LichessBeginnerRatingBandSchema = z.enum(['<1200', '1200-1499', '1500-1799'])

const CANONICAL_RATING_BANDS = CanonicalEvidenceRatingBandSchema.options
const LICHESS_BEGINNER_BANDS = LichessBeginnerRatingBandSchema.options
const MAX_EVIDENCE_COUNT = MAX_APPROVED_EVIDENCE_GAMES

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

function ratesEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * Number.EPSILON * 8
}

const ScoreIntervalSchema = z.object({
  method: z.literal(TRINOMIAL_PROFILE_LIKELIHOOD_95_METHOD),
  confidenceLevel: z.literal(0.95),
  low: z.number().min(0).max(1),
  high: z.number().min(0).max(1),
}).strict().superRefine((interval, context) => {
  if (interval.low > interval.high) {
    context.addIssue({ code: 'custom', path: ['low'], message: 'Score interval lower bound cannot exceed its upper bound' })
  }
})

const EvidenceOutcomeShape = {
  reachN: z.number().int().nonnegative().max(MAX_EVIDENCE_COUNT),
  moveN: z.number().int().nonnegative().max(MAX_EVIDENCE_COUNT),
  whiteWins: z.number().int().nonnegative().max(MAX_EVIDENCE_COUNT),
  draws: z.number().int().nonnegative().max(MAX_EVIDENCE_COUNT),
  blackWins: z.number().int().nonnegative().max(MAX_EVIDENCE_COUNT),
  wins: z.number().int().nonnegative().max(MAX_EVIDENCE_COUNT),
  losses: z.number().int().nonnegative().max(MAX_EVIDENCE_COUNT),
  score: z.number().min(0).max(1).nullable(),
  conditionalUsage: z.number().min(0).max(1),
  scoreInterval: ScoreIntervalSchema.nullable(),
} as const

type EvidenceOutcome = z.infer<z.ZodObject<typeof EvidenceOutcomeShape>>

function validateEvidenceOutcome(
  outcome: EvidenceOutcome,
  trainedSide: 'white' | 'black',
  addIssue: (path: PropertyKey[], message: string) => void,
): void {
  if (outcome.moveN > outcome.reachN) {
    addIssue(['moveN'], 'Move N cannot exceed position reach N')
  }
  if (outcome.whiteWins + outcome.draws + outcome.blackWins !== outcome.moveN) {
    addIssue(['whiteWins'], 'Raw White/Draw/Black counts must sum to move N')
  }
  const expectedWins = trainedSide === 'white' ? outcome.whiteWins : outcome.blackWins
  const expectedLosses = trainedSide === 'white' ? outcome.blackWins : outcome.whiteWins
  if (outcome.wins !== expectedWins || outcome.losses !== expectedLosses) {
    addIssue(['wins'], 'Trained-side W/D/L must map exactly from raw White/Draw/Black counts')
  }
  const expectedUsage = outcome.reachN === 0 ? 0 : outcome.moveN / outcome.reachN
  if (!ratesEqual(outcome.conditionalUsage, expectedUsage)) {
    addIssue(['conditionalUsage'], 'Conditional usage must equal move N divided by reach N')
  }
  if (outcome.moveN === 0) {
    if (outcome.score !== null || outcome.scoreInterval !== null) {
      addIssue(['score'], 'Zero-game evidence must report null score and interval')
    }
    return
  }
  const expectedScore = (expectedWins + outcome.draws * 0.5) / outcome.moveN
  if (outcome.score === null || !ratesEqual(outcome.score, expectedScore)) {
    addIssue(['score'], 'Score must equal (wins + 0.5 * draws) / move N')
  }
  if (outcome.scoreInterval === null) {
    addIssue(['scoreInterval'], 'Score interval must equal the deterministic tagged 95% trinomial profile-likelihood interval')
  } else {
    try {
      assertTrinomialScoreProfileLikelihoodInterval(
        expectedWins,
        outcome.draws,
        expectedLosses,
        outcome.scoreInterval,
      )
    } catch {
      addIssue(['scoreInterval'], 'Score interval must equal the deterministic tagged 95% trinomial profile-likelihood interval')
    }
  }
}

function summedOutcome(records: readonly EvidenceOutcome[]): Omit<EvidenceOutcome, 'score' | 'conditionalUsage' | 'scoreInterval'> {
  return records.reduce((sum, record) => ({
    reachN: sum.reachN + record.reachN,
    moveN: sum.moveN + record.moveN,
    whiteWins: sum.whiteWins + record.whiteWins,
    draws: sum.draws + record.draws,
    blackWins: sum.blackWins + record.blackWins,
    wins: sum.wins + record.wins,
    losses: sum.losses + record.losses,
  }), { reachN: 0, moveN: 0, whiteWins: 0, draws: 0, blackWins: 0, wins: 0, losses: 0 })
}

function validateAggregateEquality(
  aggregate: EvidenceOutcome,
  children: readonly EvidenceOutcome[],
  path: PropertyKey[],
  addIssue: (path: PropertyKey[], message: string) => void,
): void {
  const total = summedOutcome(children)
  for (const key of ['reachN', 'moveN', 'whiteWins', 'draws', 'blackWins', 'wins', 'losses'] as const) {
    if (aggregate[key] !== total[key]) {
      addIssue([...path, key], `Aggregate ${key} must equal the sum of its rating bands`)
    }
  }
}

const CanonicalBandEvidenceSchema = z.object({
  band: CanonicalEvidenceRatingBandSchema,
  ...EvidenceOutcomeShape,
}).strict()

const BeginnerBandEvidenceSchema = z.object({
  band: LichessBeginnerRatingBandSchema,
  ...EvidenceOutcomeShape,
}).strict()

export const EvidenceCohortResultSchema = z.object({
  cohortId: CohortIdSchema,
  source: EvidenceSourceSchema,
  ratingSystem: EvidenceRatingSystemSchema,
  timeControl: EvidenceTimeControlSchema,
  cutoff: z.string().refine(isIsoDate, 'Cutoff must be a real ISO calendar date'),
  trainedSide: z.enum(['white', 'black']),
  aggregate: z.object(EvidenceOutcomeShape).strict(),
  canonicalBands: z.array(CanonicalBandEvidenceSchema).length(CANONICAL_RATING_BANDS.length),
  lichessBeginnerBands: z.array(BeginnerBandEvidenceSchema).max(LICHESS_BEGINNER_BANDS.length),
}).strict().superRefine((cohort, context) => {
  const expectedRatingSystem = cohort.source === 'broadcast' ? 'broadcast-rating' : 'lichess-glicko2'
  if (cohort.ratingSystem !== expectedRatingSystem) {
    context.addIssue({ code: 'custom', path: ['ratingSystem'], message: 'Rating system must match its evidence source' })
  }
  if (!unique(cohort.canonicalBands.map(({ band }) => band))
    || CANONICAL_RATING_BANDS.some((band) => !cohort.canonicalBands.some((value) => value.band === band))) {
    context.addIssue({ code: 'custom', path: ['canonicalBands'], message: 'Every canonical rating band must appear exactly once' })
  }
  const beginnerBands = cohort.lichessBeginnerBands
  if (cohort.source === 'broadcast' && beginnerBands.length !== 0) {
    context.addIssue({ code: 'custom', path: ['lichessBeginnerBands'], message: 'Broadcast cohorts cannot claim Lichess beginner-band details' })
  }
  if (cohort.source === 'lichess-standard' && (
    beginnerBands.length !== LICHESS_BEGINNER_BANDS.length
    || !unique(beginnerBands.map(({ band }) => band))
    || LICHESS_BEGINNER_BANDS.some((band) => !beginnerBands.some((value) => value.band === band))
  )) {
    context.addIssue({ code: 'custom', path: ['lichessBeginnerBands'], message: 'Lichess cohorts must preserve all three beginner-band details exactly once' })
  }

  const addIssue = (path: PropertyKey[], message: string): void => context.addIssue({ code: 'custom', path, message })
  validateEvidenceOutcome(cohort.aggregate, cohort.trainedSide, addIssue)
  for (const [index, band] of cohort.canonicalBands.entries()) {
    validateEvidenceOutcome(band, cohort.trainedSide, (path, message) =>
      addIssue(['canonicalBands', index, ...path], message))
  }
  for (const [index, band] of beginnerBands.entries()) {
    validateEvidenceOutcome(band, cohort.trainedSide, (path, message) =>
      addIssue(['lichessBeginnerBands', index, ...path], message))
  }
  validateAggregateEquality(cohort.aggregate, cohort.canonicalBands, ['aggregate'], addIssue)
  if (cohort.source === 'lichess-standard') {
    const under1800 = cohort.canonicalBands.find(({ band }) => band === '<1800')
    if (under1800) validateAggregateEquality(
      under1800,
      beginnerBands,
      ['canonicalBands', cohort.canonicalBands.indexOf(under1800)],
      addIssue,
    )
  }
})

const EngineEvaluationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('centipawn'),
    value: z.number().int().min(-100_000).max(100_000),
    unit: z.literal('centipawn'),
    perspective: z.literal('trained-side'),
  }).strict(),
  z.object({
    kind: z.literal('mate'),
    value: z.number().int().min(-1_000).max(1_000).refine((value) => value !== 0, 'Mate distance cannot be zero'),
    unit: z.literal('signed-plies-to-mate'),
    perspective: z.literal('trained-side'),
  }).strict(),
])

function engineEvaluationRank(evaluation: z.infer<typeof EngineEvaluationSchema>): number {
  if (evaluation.kind === 'centipawn') return evaluation.value
  if (evaluation.value === 0) return 0
  return evaluation.value > 0
    ? 1_000_000 - evaluation.value
    : -1_000_000 - evaluation.value
}

function derivedEngineComparison(
  best: z.infer<typeof EngineEvaluationSchema>,
  move: z.infer<typeof EngineEvaluationSchema>,
): { centipawnLoss: number | null; forcedMateAgainstLearner: boolean } {
  const forcedMateAgainstLearner = move.kind === 'mate' && move.value < 0
  if (best.kind === 'centipawn' && move.kind === 'centipawn') {
    return { centipawnLoss: Math.max(0, best.value - move.value), forcedMateAgainstLearner }
  }
  if (best.kind === 'mate' && move.kind === 'mate' && best.value > 0 && move.value > 0) {
    return { centipawnLoss: 0, forcedMateAgainstLearner }
  }
  return { centipawnLoss: null, forcedMateAgainstLearner }
}

export const RepertoireEngineCheckSchema = z.object({
  engineName: z.literal('Stockfish 18'),
  engineSha256: Sha256Schema,
  nnueSha256: z.array(Sha256Schema).min(1).max(8),
  settings: z.object({
    threads: z.literal(1),
    hashMb: z.literal(128),
    multiPv: z.literal(5),
    nodes: z.literal(250_000),
  }).strict(),
  analyzedAt: z.string().datetime({ offset: true }),
  analyzedMoveUci: UciMoveSchema,
  bestMoveUci: UciMoveSchema,
  bestEvaluation: EngineEvaluationSchema,
  moveEvaluation: EngineEvaluationSchema,
  centipawnLoss: z.number().int().nonnegative().nullable(),
  forcedMateAgainstLearner: z.boolean(),
  bestPrincipalVariationUci: z.array(UciMoveSchema).min(1).max(64),
  movePrincipalVariationUci: z.array(UciMoveSchema).min(1).max(64),
}).strict().superRefine((check, context) => {
  if (check.bestPrincipalVariationUci[0] !== check.bestMoveUci) {
    context.addIssue({ code: 'custom', path: ['bestPrincipalVariationUci'], message: 'Best PV must begin with the recorded best move' })
  }
  if (check.movePrincipalVariationUci[0] !== check.analyzedMoveUci) {
    context.addIssue({ code: 'custom', path: ['movePrincipalVariationUci'], message: 'Move PV must begin with the analyzed move' })
  }
  if (!unique(check.nnueSha256)) {
    context.addIssue({ code: 'custom', path: ['nnueSha256'], message: 'NNUE hashes must be unique' })
  }
  if (engineEvaluationRank(check.bestEvaluation) < engineEvaluationRank(check.moveEvaluation)) {
    context.addIssue({ code: 'custom', path: ['bestEvaluation'], message: 'Recorded best evaluation cannot be worse than the analyzed move from the trained-side perspective' })
  }
  const derived = derivedEngineComparison(check.bestEvaluation, check.moveEvaluation)
  if (check.centipawnLoss !== derived.centipawnLoss) {
    context.addIssue({ code: 'custom', path: ['centipawnLoss'], message: 'Centipawn loss must be derived from the trained-side best and move evaluations' })
  }
  if (check.forcedMateAgainstLearner !== derived.forcedMateAgainstLearner) {
    context.addIssue({ code: 'custom', path: ['forcedMateAgainstLearner'], message: 'Losing-mate status must be derived from the trained-side move evaluation' })
  }
})

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

export const BookTerminalStatusSchema = z.enum([
  'evidence_terminal',
  'depth_capped',
  'insufficient_sample',
  'quarantined',
])

export const RepertoireBranchEvidenceSchema = z.object({
  cohorts: z.array(EvidenceCohortResultSchema).min(1).max(64),
  selectionCohortId: CohortIdSchema,
  conditionalUsage: z.number().min(0).max(1),
  engine: z.object({
    status: z.enum(['verified', 'unverified', 'quarantined']),
    centipawnLoss: z.number().int().nonnegative().nullable(),
    forcedMateAgainstLearner: z.boolean(),
    quarantineReasons: z.array(z.string().min(1).max(500)).max(32),
    check: RepertoireEngineCheckSchema.nullable(),
  }).strict(),
}).strict().superRefine((evidence, context) => {
  if (!unique(evidence.cohorts.map(({ cohortId }) => cohortId))) {
    context.addIssue({ code: 'custom', path: ['cohorts'], message: 'Cohort IDs must be unique' })
  }
  const dimensions = evidence.cohorts.map(({ source, ratingSystem, timeControl, cutoff }) =>
    `${source}\0${ratingSystem}\0${timeControl}\0${cutoff}`)
  if (!unique(dimensions)) {
    context.addIssue({ code: 'custom', path: ['cohorts'], message: 'A source/rating/time-control/cutoff cohort dimension may appear only once' })
  }
  const selectedCohort = evidence.cohorts.find(({ cohortId }) => cohortId === evidence.selectionCohortId)
  if (!selectedCohort) {
    context.addIssue({ code: 'custom', path: ['selectionCohortId'], message: 'Selection cohort must identify exactly one preserved cohort' })
  } else if (!ratesEqual(evidence.conditionalUsage, selectedCohort.aggregate.conditionalUsage)) {
    context.addIssue({ code: 'custom', path: ['conditionalUsage'], message: 'Edge conditional usage must come from the declared selection cohort, not pooled cohorts' })
  }
  const { status, centipawnLoss, forcedMateAgainstLearner, quarantineReasons, check } = evidence.engine
  if (status === 'verified' && check === null) {
    context.addIssue({ code: 'custom', path: ['engine', 'check'], message: 'Verified evidence requires the exact Stockfish check' })
  }
  if (status === 'unverified' && (centipawnLoss !== null || check !== null)) {
    context.addIssue({ code: 'custom', path: ['engine', 'check'], message: 'Unverified evidence cannot claim an engine result' })
  }
  if (check !== null && centipawnLoss !== check.centipawnLoss) {
    context.addIssue({ code: 'custom', path: ['engine', 'centipawnLoss'], message: 'Engine summary loss must match its immutable check' })
  }
  if (check === null && centipawnLoss !== null) {
    context.addIssue({ code: 'custom', path: ['engine', 'centipawnLoss'], message: 'A centipawn-loss claim requires an exact engine check' })
  }
  if (check !== null && forcedMateAgainstLearner !== check.forcedMateAgainstLearner) {
    context.addIssue({ code: 'custom', path: ['engine', 'forcedMateAgainstLearner'], message: 'Engine summary mate state must match its immutable check' })
  }
  if (check === null && forcedMateAgainstLearner) {
    context.addIssue({ code: 'custom', path: ['engine', 'forcedMateAgainstLearner'], message: 'A forced-mate claim requires an exact engine check' })
  }
  if (status === 'quarantined' && quarantineReasons.length === 0) {
    context.addIssue({ code: 'custom', path: ['engine', 'quarantineReasons'], message: 'Quarantined evidence requires a reason' })
  }
  if (status !== 'quarantined' && quarantineReasons.length > 0) {
    context.addIssue({ code: 'custom', path: ['engine', 'quarantineReasons'], message: 'Only quarantined evidence may carry quarantine reasons' })
  }
  if ((forcedMateAgainstLearner || (centipawnLoss ?? 0) >= 100) && status !== 'quarantined') {
    context.addIssue({ code: 'custom', path: ['engine', 'status'], message: 'Losing-mate and 100cp-loss evidence must be quarantined' })
  }
})

export const FamilyGraphEvidenceReceiptV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: ReceiptIdSchema,
  kind: z.enum(['taxonomy', 'broadcast-corpus', 'lichess-standard-corpus', 'engine', 'scid']),
  path: z.string().min(1).max(512).regex(SAFE_RECEIPT_PATH),
  sha256: Sha256Schema,
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentType: z.literal('application/json'),
  sourceUrl: z.string().url().max(2_048).refine((value) => value.startsWith('https://'), 'Evidence receipt URLs must use HTTPS'),
  retrievedAt: z.string().datetime({ offset: true }),
  sourceRevision: z.string().min(1).max(160),
  license: z.enum(['CC0-1.0', 'CC-BY-SA-4.0', 'GPL-3.0-only', 'GPL-2.0-only']),
}).strict().superRefine((receipt, context) => {
  if (receipt.id !== `receipt_${receipt.sha256.slice(0, 16)}`) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'Receipt ID must equal the first 16 hexadecimal characters of its SHA-256' })
  }
  const expectedLicense = {
    taxonomy: 'CC0-1.0',
    'broadcast-corpus': 'CC-BY-SA-4.0',
    'lichess-standard-corpus': 'CC0-1.0',
    engine: 'GPL-3.0-only',
    scid: 'GPL-2.0-only',
  } as const
  if (receipt.license !== expectedLicense[receipt.kind]) {
    context.addIssue({ code: 'custom', path: ['license'], message: 'Evidence receipt license must match the pinned source kind' })
  }
})

export const FamilyGraphProvenanceBindingV1Schema = z.object({
  provenanceRef: RepertoireProvenanceRefSchema,
  taxonomyReceiptId: ReceiptIdSchema,
  corpusReceiptIds: z.array(ReceiptIdSchema).min(1).max(2),
  engineReceiptId: ReceiptIdSchema,
  scidReceiptId: ReceiptIdSchema,
}).strict().superRefine((binding, context) => {
  if (!unique(binding.corpusReceiptIds)) {
    context.addIssue({ code: 'custom', path: ['corpusReceiptIds'], message: 'Corpus receipt IDs must be unique' })
  }
})

export const FamilyGraphProvenanceDocumentV1Schema = z.object({
  schemaVersion: z.literal(1),
  releaseId: ReleaseIdSchema,
  familyId: FamilyIdSchema,
  receipts: z.array(FamilyGraphEvidenceReceiptV1Schema).min(4).max(256),
  bindings: z.array(FamilyGraphProvenanceBindingV1Schema).min(1).max(100_000),
}).strict().superRefine((document, context) => {
  if (!unique(document.receipts.map(({ id }) => id))) {
    context.addIssue({ code: 'custom', path: ['receipts'], message: 'Evidence receipt IDs must be unique' })
  }
  if (!unique(document.receipts.map(({ path }) => path))) {
    context.addIssue({ code: 'custom', path: ['receipts'], message: 'Evidence receipt paths must be unique' })
  }
  if (!unique(document.bindings.map(({ provenanceRef }) => provenanceRef))) {
    context.addIssue({ code: 'custom', path: ['bindings'], message: 'Each graph provenance reference must have one immutable binding' })
  }
  const receipts = new Map(document.receipts.map((receipt) => [receipt.id, receipt]))
  const usedReceiptIds = new Set<string>()
  for (const [index, binding] of document.bindings.entries()) {
    const taxonomy = receipts.get(binding.taxonomyReceiptId)
    const engine = receipts.get(binding.engineReceiptId)
    const scid = receipts.get(binding.scidReceiptId)
    if (taxonomy?.kind !== 'taxonomy') {
      context.addIssue({ code: 'custom', path: ['bindings', index, 'taxonomyReceiptId'], message: 'Binding taxonomy receipt must resolve to immutable taxonomy evidence' })
    }
    if (engine?.kind !== 'engine') {
      context.addIssue({ code: 'custom', path: ['bindings', index, 'engineReceiptId'], message: 'Binding engine receipt must resolve to immutable engine evidence' })
    }
    if (scid?.kind !== 'scid') {
      context.addIssue({ code: 'custom', path: ['bindings', index, 'scidReceiptId'], message: 'Binding Scid receipt must resolve to immutable Scid evidence' })
    }
    for (const [corpusIndex, receiptId] of binding.corpusReceiptIds.entries()) {
      const corpus = receipts.get(receiptId)
      if (corpus?.kind !== 'broadcast-corpus' && corpus?.kind !== 'lichess-standard-corpus') {
        context.addIssue({ code: 'custom', path: ['bindings', index, 'corpusReceiptIds', corpusIndex], message: 'Corpus binding must resolve to an approved immutable corpus receipt' })
      }
    }
    usedReceiptIds.add(binding.taxonomyReceiptId)
    usedReceiptIds.add(binding.engineReceiptId)
    usedReceiptIds.add(binding.scidReceiptId)
    for (const receiptId of binding.corpusReceiptIds) usedReceiptIds.add(receiptId)
  }
  for (const [index, receipt] of document.receipts.entries()) {
    if (!usedReceiptIds.has(receipt.id)) {
      context.addIssue({ code: 'custom', path: ['receipts', index], message: 'Unbound evidence receipts are prohibited' })
    }
  }
})

export const RepertoireNodeSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  id: PositionIdSchema,
  epd: EpdSchema,
  learnerTurn: z.boolean(),
  outgoingEdgeIds: z.array(EdgeIdSchema).max(REPERTOIRE_MAX_POSITION_EDGES),
  cardId: CardIdSchema.optional(),
  provenanceRef: RepertoireProvenanceRefSchema,
}).strict().superRefine((node, context) => {
  if (!unique(node.outgoingEdgeIds)) {
    context.addIssue({ code: 'custom', path: ['outgoingEdgeIds'], message: 'Outgoing edge IDs must be unique' })
  }
})

export const RepertoireEdgeSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  id: EdgeIdSchema,
  fromNodeId: PositionIdSchema,
  toNodeId: PositionIdSchema,
  uci: UciMoveSchema,
  san: z.string().min(1).max(32),
  role: z.enum(['book', 'playable', 'inaccuracy', 'exploratory']),
  eligibleForDrill: z.boolean(),
  acceptedBookTransposition: z.boolean(),
  evidence: RepertoireBranchEvidenceSchema,
  provenanceRef: RepertoireProvenanceRefSchema,
}).strict().superRefine((edge, context) => {
  const maximumCohortN = Math.max(...edge.evidence.cohorts.map(({ aggregate }) => aggregate.moveN))
  const engine = edge.evidence.engine
  const soundAndVerified = engine.status === 'verified'
    && engine.centipawnLoss !== null
    && engine.centipawnLoss <= 50
    && !engine.forcedMateAgainstLearner

  // Whether exact engine evidence is mandatory depends on whose turn the
  // source node represents. That relationship is deliberately enforced by
  // validateRepertoireGraphDocument, where the source node is available.
  // Edge-only parsing still forbids sampled/role corruption and any known
  // unsound engine result from entering a drill.
  if (edge.eligibleForDrill && (
    edge.role !== 'book' || maximumCohortN < 500 ||
    engine.status === 'quarantined' ||
    (engine.status === 'verified' && !soundAndVerified)
  )) {
    context.addIssue({
      code: 'custom',
      path: ['eligibleForDrill'],
      message: 'Drill edges must be sampled book moves and cannot carry a known unsound engine result',
    })
  }
  if (edge.role === 'book' && !edge.eligibleForDrill && engine.status !== 'quarantined') {
    context.addIssue({
      code: 'custom',
      path: ['role'],
      message: 'A non-drillable book edge must be explicitly quarantined',
    })
  }
  if (edge.role === 'playable' && (
    edge.eligibleForDrill
    || maximumCohortN < 100
    || !soundAndVerified
  )) {
    context.addIssue({
      code: 'custom',
      path: ['role'],
      message: 'Playable edges require N>=100 and verified loss of at most 50cp, and are not book drills',
    })
  }
  if (edge.role === 'inaccuracy' && (
    edge.eligibleForDrill
    || maximumCohortN < 500
    || engine.status !== 'verified'
    || engine.centipawnLoss === null
    || engine.centipawnLoss < 51
    || engine.centipawnLoss > 99
    || engine.forcedMateAgainstLearner
  )) {
    context.addIssue({
      code: 'custom',
      path: ['role'],
      message: 'Inaccuracy edges require N>=500 and an exact verified 51-99cp loss, and cannot be drilled',
    })
  }
  if (edge.role === 'exploratory' && (
    edge.eligibleForDrill
    || maximumCohortN < 100
    || maximumCohortN >= 500
  )) {
    context.addIssue({
      code: 'custom',
      path: ['role'],
      message: 'Exploratory edges require 100<=N<500 and cannot be drilled',
    })
  }
  if (edge.acceptedBookTransposition && !edge.eligibleForDrill) {
    context.addIssue({
      code: 'custom',
      path: ['acceptedBookTransposition'],
      message: 'Only an audited drill edge can be an accepted book transposition',
    })
  }
  if (engine.check !== null && engine.check.analyzedMoveUci !== edge.uci) {
    context.addIssue({ code: 'custom', path: ['evidence', 'engine', 'check', 'analyzedMoveUci'], message: 'Engine check must analyze this exact graph edge' })
  }
})

export const RepertoirePathSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  id: PathIdSchema,
  packId: PackIdSchema,
  nodeIds: z.array(PositionIdSchema).min(2).max(REPERTOIRE_MAX_PLY + 1),
  edgeIds: z.array(EdgeIdSchema).min(1).max(REPERTOIRE_MAX_PLY),
  learnerDecisionCount: z.number().int().nonnegative().max(50),
  terminalPly: z.number().int().min(1).max(REPERTOIRE_MAX_PLY),
  terminalStatus: BookTerminalStatusSchema,
  familyTags: z.array(z.string().min(1).max(80)).min(1).max(32),
  conditionalUsage: z.number().min(0).max(1),
  provenanceRef: RepertoireProvenanceRefSchema,
}).strict().superRefine((path, context) => {
  if (path.nodeIds.length !== path.edgeIds.length + 1) {
    context.addIssue({ code: 'custom', path: ['nodeIds'], message: 'A path must contain one more node than edge' })
  }
  if (!unique(path.nodeIds)) {
    context.addIssue({ code: 'custom', path: ['nodeIds'], message: 'A drill path cannot repeat a position' })
  }
  if (!unique(path.edgeIds)) {
    context.addIssue({ code: 'custom', path: ['edgeIds'], message: 'A drill path cannot repeat an edge' })
  }
  if (!unique(path.familyTags)) {
    context.addIssue({ code: 'custom', path: ['familyTags'], message: 'Family tags must be unique' })
  }
  if (path.terminalStatus === 'depth_capped' && path.terminalPly !== REPERTOIRE_MAX_PLY) {
    context.addIssue({ code: 'custom', path: ['terminalStatus'], message: 'A depth-capped path must end at ply 100' })
  }
})

export const RepertoirePackSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  id: PackIdSchema,
  side: z.enum(['white', 'black']),
  rootNodeId: PositionIdSchema,
  rootPly: z.number().int().nonnegative().max(REPERTOIRE_MAX_PLY - 1),
  tier: z.enum(['core', 'primer']),
  coreDepth: z.number().int().nonnegative().max(50),
  opponentBranchCountAfterRoot: z.number().int().nonnegative().max(REPERTOIRE_MAX_POSITION_EDGES),
  coverage: z.number().min(0).max(1),
  ecoCodes: z.array(EcoCodeSchema).min(1).max(500),
  nodeIds: z.array(PositionIdSchema).min(2).max(100_000),
  edgeIds: z.array(EdgeIdSchema).min(1).max(200_000),
  pathIds: z.array(PathIdSchema).min(1).max(100_000),
  provenanceRef: RepertoireProvenanceRefSchema,
}).strict().superRefine((pack, context) => {
  for (const [key, values] of [
    ['ecoCodes', pack.ecoCodes],
    ['nodeIds', pack.nodeIds],
    ['edgeIds', pack.edgeIds],
    ['pathIds', pack.pathIds],
  ] as const) {
    if (!unique(values)) context.addIssue({ code: 'custom', path: [key], message: `${key} must be unique` })
  }
})

export const RepertoireGraphDocumentSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  releaseId: ReleaseIdSchema,
  pack: RepertoirePackSchema,
  nodes: z.array(RepertoireNodeSchema).min(2).max(100_000),
  edges: z.array(RepertoireEdgeSchema).min(1).max(200_000),
  paths: z.array(RepertoirePathSchema).min(1).max(100_000),
}).strict()

/**
 * Exact output of the reconciled source-evidence eligibility pass. Promotion
 * compares it with the emitted graph because graph validation alone cannot
 * detect an eligible source edge omitted before graph construction.
 */
export const EligibleSourceEdgeInventoryV1Schema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().min(1).max(160),
  packId: PackIdSchema,
  sourceReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  eligibleEdgeIds: z.array(EdgeIdSchema).min(1).max(200_000),
}).strict().superRefine((inventory, context) => {
  if (!unique(inventory.eligibleEdgeIds)) {
    context.addIssue({
      code: 'custom',
      path: ['eligibleEdgeIds'],
      message: 'Eligible source-edge IDs must be unique',
    })
  }
})

export const CoverageCycleStateSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  packId: PackIdSchema,
  ordinal: z.number().int().nonnegative(),
  remainingPathIds: z.array(PathIdSchema).max(100_000),
}).strict().superRefine((state, context) => {
  if (!unique(state.remainingPathIds)) {
    context.addIssue({ code: 'custom', path: ['remainingPathIds'], message: 'Remaining paths must be unique' })
  }
})

export const SessionPathSelectionSchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  packId: PackIdSchema,
  dueCardIds: z.array(CardIdSchema).max(10_000),
  includedPathIds: z.array(PathIdSchema).min(1).max(1_000),
  warmupNodeIds: z.array(PositionIdSchema).max(100_000),
  coverageCycleId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::coverage:[0-9]+$/u),
}).strict().superRefine((selection, context) => {
  for (const [key, values] of [
    ['dueCardIds', selection.dueCardIds],
    ['includedPathIds', selection.includedPathIds],
    ['warmupNodeIds', selection.warmupNodeIds],
  ] as const) {
    if (!unique(values)) context.addIssue({ code: 'custom', path: [key], message: `${key} must be unique` })
  }
  if (selection.dueCardIds.some((cardId) => !cardId.startsWith(`${selection.packId}::`))) {
    context.addIssue({ code: 'custom', path: ['dueCardIds'], message: 'Due cards must belong to the selected pack' })
  }
})

export const TrainingValueSummarySchema = z.object({
  schemaVersion: z.literal(REPERTOIRE_SCHEMA_VERSION),
  soundnessTier: z.union([z.literal(1), z.literal(2)]),
  empiricalDepth: z.number().int().nonnegative().max(REPERTOIRE_MAX_PLY),
  coverage: z.number().min(0).max(1),
  usage: z.number().int().nonnegative(),
  scoreLowerBound: z.number().min(0).max(1),
}).strict()

export type BookTerminalStatus = z.infer<typeof BookTerminalStatusSchema>
export type EvidenceCohortResult = z.infer<typeof EvidenceCohortResultSchema>
export type RepertoireEngineCheck = z.infer<typeof RepertoireEngineCheckSchema>
export type RepertoireBranchEvidence = z.infer<typeof RepertoireBranchEvidenceSchema>
export type FamilyGraphEvidenceReceiptV1 = z.infer<typeof FamilyGraphEvidenceReceiptV1Schema>
export type FamilyGraphProvenanceBindingV1 = z.infer<typeof FamilyGraphProvenanceBindingV1Schema>
export type FamilyGraphProvenanceDocumentV1 = z.infer<typeof FamilyGraphProvenanceDocumentV1Schema>
export type RepertoireNode = z.infer<typeof RepertoireNodeSchema>
export type RepertoireEdge = z.infer<typeof RepertoireEdgeSchema>
export type RepertoirePath = z.infer<typeof RepertoirePathSchema>
export type RepertoirePack = z.infer<typeof RepertoirePackSchema>
export type RepertoireGraphDocument = z.infer<typeof RepertoireGraphDocumentSchema>
export type EligibleSourceEdgeInventoryV1 = z.infer<typeof EligibleSourceEdgeInventoryV1Schema>
export type CoverageCycleState = z.infer<typeof CoverageCycleStateSchema>
export type SessionPathSelection = z.infer<typeof SessionPathSelectionSchema>
export type TrainingValueSummary = z.infer<typeof TrainingValueSummarySchema>

const PRIMARY_RANKING_MAXIMUM_PLY = 30

/**
 * Produce the auditable value tuple used to order a practice path. This never
 * changes path eligibility: it only decides which already-eligible path is
 * offered first. Opponent moves contribute to path coverage, while soundness,
 * sample size, and score confidence are taken only from learner decisions.
 */
export function trainingValueSummaryForPath(
  graph: RepertoireGraphDocument,
  path: RepertoirePath,
): TrainingValueSummary {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]))
  const learnerEvidence = path.edgeIds.flatMap((edgeId, index) => {
    const edge = edgeById.get(edgeId)
    const source = nodeById.get(path.nodeIds[index] ?? '')
    if (!edge || !source?.learnerTurn) return []
    const cohort = edge.evidence.cohorts.find(({ cohortId }) =>
      cohortId === edge.evidence.selectionCohortId)
    if (!cohort) throw new Error(`Path ${path.id} has no selected evidence cohort for ${edge.id}`)
    return [{ edge, cohort }]
  })
  const soundnessTier = learnerEvidence.length > 0 && learnerEvidence.every(({ edge }) =>
    edge.evidence.engine.centipawnLoss !== null
      && edge.evidence.engine.centipawnLoss <= 20
      && !edge.evidence.engine.forcedMateAgainstLearner)
    ? 1
    : 2
  const usage = learnerEvidence.length === 0
    ? 0
    : Math.min(...learnerEvidence.map(({ cohort }) => cohort.aggregate.moveN))
  const scoreLowerBound = learnerEvidence.length === 0
    ? 0
    : Math.min(...learnerEvidence.map(({ cohort }) => cohort.aggregate.scoreInterval?.low ?? 0))
  return TrainingValueSummarySchema.parse({
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    soundnessTier,
    empiricalDepth: Math.max(
      0,
      Math.min(path.terminalPly, PRIMARY_RANKING_MAXIMUM_PLY) - graph.pack.rootPly,
    ),
    coverage: path.conditionalUsage,
    usage,
    scoreLowerBound,
  })
}

/**
 * Locked lexicographic recommendation order. Stable identities are the final
 * tie-break only; no branch is removed by this comparator.
 */
export function compareTrainingValueSummaries(
  left: TrainingValueSummary,
  right: TrainingValueSummary,
  leftStableIdentity: string,
  rightStableIdentity: string,
): number {
  const leftValue = TrainingValueSummarySchema.parse(left)
  const rightValue = TrainingValueSummarySchema.parse(right)
  const coverageAdjustedDepth =
    (rightValue.empiricalDepth * rightValue.coverage) - (leftValue.empiricalDepth * leftValue.coverage)
  return leftValue.soundnessTier - rightValue.soundnessTier
    || coverageAdjustedDepth
    || rightValue.empiricalDepth - leftValue.empiricalDepth
    || rightValue.coverage - leftValue.coverage
    || rightValue.usage - leftValue.usage
    || rightValue.scoreLowerBound - leftValue.scoreLowerBound
    || leftStableIdentity.localeCompare(rightStableIdentity, 'en')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function stableRepertoirePositionId(epd: string): Promise<string> {
  const canonical = normalizedEpd(new Chess(`${epd} 0 1`))
  if (canonical !== epd) throw new Error(`Noncanonical repertoire EPD: ${epd}`)
  return `pos_${(await sha256Hex(epd)).slice(0, 16)}`
}

export async function stableRepertoireEdgeId(fromEpd: string, uci: string, toEpd: string): Promise<string> {
  UciMoveSchema.parse(uci)
  return `edge_${(await sha256Hex(`${fromEpd}\0${uci}\0${toEpd}`)).slice(0, 20)}`
}

export async function stableRepertoirePathId(packId: string, edgeIds: readonly string[]): Promise<string> {
  PackIdSchema.parse(packId)
  z.array(EdgeIdSchema).min(1).max(REPERTOIRE_MAX_PLY).parse(edgeIds)
  return `path_${(await sha256Hex(`${packId}\0${edgeIds.join('\0')}`)).slice(0, 20)}`
}

export function stableRepertoireCardId(packId: string, positionId: string): string {
  return CardIdSchema.parse(`${PackIdSchema.parse(packId)}::${PositionIdSchema.parse(positionId)}`)
}

function moveParts(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

function legallyReplaysPrincipalVariation(epd: string, moves: readonly string[]): boolean {
  try {
    const chess = new Chess(`${epd} 0 1`)
    for (const uci of moves) chess.move(moveParts(uci))
    return true
  } catch {
    return false
  }
}

export function classifyBookTerminalStatus(options: {
  terminalPly: number
  hasEligibleContinuation: boolean
  hasExploratoryContinuation: boolean
  hasQuarantinedContinuation: boolean
}): BookTerminalStatus {
  if (!Number.isSafeInteger(options.terminalPly) || options.terminalPly < 1 || options.terminalPly > REPERTOIRE_MAX_PLY) {
    throw new Error('terminalPly must be an integer from 1 through 100')
  }
  if (options.terminalPly === REPERTOIRE_MAX_PLY && options.hasEligibleContinuation) return 'depth_capped'
  if (options.hasEligibleContinuation) {
    throw new Error('A path ended while an audited book continuation remained')
  }
  if (options.hasQuarantinedContinuation) return 'quarantined'
  if (options.hasExploratoryContinuation) return 'insufficient_sample'
  return 'evidence_terminal'
}

export function classifyRepertoireTier(
  learnerDecisions: number,
  opponentBranchesAfterRoot: number,
): RepertoirePack['tier'] {
  if (!Number.isSafeInteger(learnerDecisions) || learnerDecisions < 0 || learnerDecisions > 50) {
    throw new Error('learnerDecisions must be an integer from 0 through 50')
  }
  if (
    !Number.isSafeInteger(opponentBranchesAfterRoot)
    || opponentBranchesAfterRoot < 0
    || opponentBranchesAfterRoot > REPERTOIRE_MAX_POSITION_EDGES
  ) {
    throw new Error(`opponentBranchesAfterRoot must be an integer from 0 through ${REPERTOIRE_MAX_POSITION_EDGES}`)
  }
  return learnerDecisions >= CORE_MINIMUM_LEARNER_DECISIONS
    && opponentBranchesAfterRoot >= CORE_MINIMUM_OPPONENT_BRANCHES
    ? 'core'
    : 'primer'
}

function cycleExists(rootNodeId: string, nodes: ReadonlyMap<string, RepertoireNode>, edges: ReadonlyMap<string, RepertoireEdge>): boolean {
  const active = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (active.has(nodeId)) return true
    if (visited.has(nodeId)) return false
    active.add(nodeId)
    const node = nodes.get(nodeId)
    for (const edgeId of node?.outgoingEdgeIds ?? []) {
      const edge = edges.get(edgeId)
      if (edge?.eligibleForDrill && visit(edge.toNodeId)) return true
    }
    active.delete(nodeId)
    visited.add(nodeId)
    return false
  }
  return visit(rootNodeId)
}

/**
 * Parses the public wire contract, then performs checks that require chess
 * replay or relationships across records. No caller should train from a graph
 * that has not passed this function.
 */
export async function validateRepertoireGraphDocument(input: unknown): Promise<RepertoireGraphDocument> {
  const graph = RepertoireGraphDocumentSchema.parse(input)
  const issues: string[] = []
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]))
  const paths = new Map(graph.paths.map((path) => [path.id, path]))
  if (nodes.size !== graph.nodes.length) issues.push('Node IDs must be unique')
  if (edges.size !== graph.edges.length) issues.push('Edge IDs must be unique')
  if (paths.size !== graph.paths.length) issues.push('Path IDs must be unique')

  if (!nodes.has(graph.pack.rootNodeId)) issues.push('Pack root node is missing')
  if (graph.pack.nodeIds.length !== graph.nodes.length || graph.pack.nodeIds.some((id) => !nodes.has(id))) {
    issues.push('Pack node index must contain every graph node exactly once')
  }
  if (graph.pack.edgeIds.length !== graph.edges.length || graph.pack.edgeIds.some((id) => !edges.has(id))) {
    issues.push('Pack edge index must contain every graph edge exactly once')
  }
  if (graph.pack.pathIds.length !== graph.paths.length || graph.pack.pathIds.some((id) => !paths.has(id))) {
    issues.push('Pack path index must contain every graph path exactly once')
  }

  await Promise.all(graph.nodes.map(async (node) => {
    try {
      const expectedId = await stableRepertoirePositionId(node.epd)
      if (node.id !== expectedId) issues.push(`Node ${node.id} does not match its stable EPD identity`)
      const turn = node.epd.split(' ')[1]
      const learnerTurn = turn === (graph.pack.side === 'white' ? 'w' : 'b')
      if (node.learnerTurn !== learnerTurn) issues.push(`Node ${node.id} has an incorrect learner-turn flag`)
      if (node.cardId !== undefined && node.cardId !== stableRepertoireCardId(graph.pack.id, node.id)) {
        issues.push(`Node ${node.id} has an incorrect stable card identity`)
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error))
    }
  }))

  await Promise.all(graph.edges.map(async (edge) => {
    const from = nodes.get(edge.fromNodeId)
    const to = nodes.get(edge.toNodeId)
    if (!from || !to) {
      issues.push(`Edge ${edge.id} references a missing node`)
      return
    }
    if (!from.outgoingEdgeIds.includes(edge.id)) issues.push(`Edge ${edge.id} is missing from its source node`)
    for (const cohort of edge.evidence.cohorts) {
      if (cohort.trainedSide !== graph.pack.side) {
        issues.push(`Edge ${edge.id} cohort ${cohort.cohortId} is recorded for the wrong trained side`)
      }
    }
    if (edge.eligibleForDrill && from.learnerTurn) {
      const engine = edge.evidence.engine
      if (
        engine.status !== 'verified' || engine.check === null || engine.centipawnLoss === null ||
        engine.centipawnLoss > 50 || engine.forcedMateAgainstLearner
      ) {
        issues.push(`Learner edge ${edge.id} lacks its exact sound Stockfish verification`)
      }
    }
    try {
      const expectedId = await stableRepertoireEdgeId(from.epd, edge.uci, to.epd)
      if (edge.id !== expectedId) issues.push(`Edge ${edge.id} does not match its stable move identity`)
      const chess = new Chess(`${from.epd} 0 1`)
      const move = chess.move(moveParts(edge.uci))
      if (move.san !== edge.san) issues.push(`Edge ${edge.id} SAN does not match legal replay`)
      if (normalizedEpd(chess) !== to.epd) issues.push(`Edge ${edge.id} does not reach its declared exact EPD`)
      const engineCheck = edge.evidence.engine.check
      if (engineCheck !== null) {
        if (!legallyReplaysPrincipalVariation(from.epd, engineCheck.bestPrincipalVariationUci)) {
          issues.push(`Edge ${edge.id} best principal variation is illegal from its declared source EPD`)
        }
        if (!legallyReplaysPrincipalVariation(from.epd, engineCheck.movePrincipalVariationUci)) {
          issues.push(`Edge ${edge.id} move principal variation is illegal from its declared source EPD`)
        }
      }
    } catch {
      issues.push(`Edge ${edge.id} is illegal from its declared source EPD`)
    }
  }))

  for (const node of graph.nodes) {
    for (const edgeId of node.outgoingEdgeIds) {
      const edge = edges.get(edgeId)
      if (!edge) issues.push(`Node ${node.id} references missing edge ${edgeId}`)
      else if (edge.fromNodeId !== node.id) issues.push(`Node ${node.id} references an edge owned by another position`)
    }
  }

  for (const path of graph.paths) {
    if (path.packId !== graph.pack.id) issues.push(`Path ${path.id} belongs to another pack`)
    try {
      const expectedId = await stableRepertoirePathId(path.packId, path.edgeIds)
      if (path.id !== expectedId) issues.push(`Path ${path.id} does not match its stable edge identity`)
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error))
    }
    if (path.nodeIds[0] !== graph.pack.rootNodeId) issues.push(`Path ${path.id} does not begin at the pack root`)
    let learnerDecisions = 0
    for (const [index, edgeId] of path.edgeIds.entries()) {
      const edge = edges.get(edgeId)
      const fromNodeId = path.nodeIds[index]
      const toNodeId = path.nodeIds[index + 1]
      if (!edge || edge.fromNodeId !== fromNodeId || edge.toNodeId !== toNodeId) {
        issues.push(`Path ${path.id} is not a contiguous graph walk at edge ${index}`)
        continue
      }
      if (!edge.eligibleForDrill) issues.push(`Path ${path.id} contains non-drillable edge ${edge.id}`)
      if (nodes.get(fromNodeId)?.learnerTurn) learnerDecisions += 1
    }
    if (learnerDecisions !== path.learnerDecisionCount) issues.push(`Path ${path.id} has an incorrect learner-decision count`)
    if (graph.pack.rootPly + path.edgeIds.length !== path.terminalPly) issues.push(`Path ${path.id} has an incorrect terminal ply`)
    const terminal = nodes.get(path.nodeIds.at(-1) ?? '')
    if (!terminal) issues.push(`Path ${path.id} has a missing terminal node`)
    else {
      const outgoing = terminal.outgoingEdgeIds.flatMap((id) => {
        const edge = edges.get(id)
        return edge ? [edge] : []
      })
      try {
        const expected = classifyBookTerminalStatus({
          terminalPly: path.terminalPly,
          hasEligibleContinuation: outgoing.some((edge) => edge.eligibleForDrill),
          hasExploratoryContinuation: outgoing.some((edge) => edge.role === 'exploratory'),
          hasQuarantinedContinuation: outgoing.some((edge) =>
            edge.role === 'book' && edge.evidence.engine.status === 'quarantined',
          ),
        })
        if (expected !== path.terminalStatus) issues.push(`Path ${path.id} has terminal status ${path.terminalStatus}; expected ${expected}`)
      } catch (error) {
        issues.push(`Path ${path.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  if (cycleExists(graph.pack.rootNodeId, nodes, edges)) issues.push('The drillable repertoire graph contains a cycle')

  const coveredEligibleEdges = new Set(graph.paths.flatMap((path) => path.edgeIds))
  const depthCappedTerminalNodes = new Set(
    graph.paths
      .filter(({ terminalStatus }) => terminalStatus === 'depth_capped')
      .flatMap((path) => path.nodeIds.at(-1) ?? []),
  )
  const selectableSourceNodes = new Set(
    graph.paths.flatMap((path) =>
      path.nodeIds.filter((_, index) => graph.pack.rootPly + index < REPERTOIRE_MAX_PLY),
    ),
  )
  for (const edge of graph.edges) {
    // The first qualifying continuation beyond ply 100 is retained as evidence
    // for the depth-capped label, but cannot itself become a selectable drill.
    if (
      edge.eligibleForDrill
      && !coveredEligibleEdges.has(edge.id)
      && !(depthCappedTerminalNodes.has(edge.fromNodeId) && !selectableSourceNodes.has(edge.fromNodeId))
    ) {
      issues.push(`Eligible edge ${edge.id} is hidden from every selectable path`)
    }
  }

  const incoming = new Map<string, RepertoireEdge[]>()
  for (const edge of graph.edges) {
    if (!edge.eligibleForDrill) continue
    const values = incoming.get(edge.toNodeId) ?? []
    values.push(edge)
    incoming.set(edge.toNodeId, values)
  }
  for (const edge of graph.edges.filter(({ acceptedBookTransposition }) => acceptedBookTransposition)) {
    const target = nodes.get(edge.toNodeId)
    const hasAnotherIncomingRoute = (incoming.get(edge.toNodeId) ?? []).some(({ id }) => id !== edge.id)
    const hasKnownContinuation = (target?.outgoingEdgeIds ?? []).some((id) => edges.get(id)?.eligibleForDrill)
    if (!hasAnotherIncomingRoute || !hasKnownContinuation) {
      issues.push(`Accepted transposition ${edge.id} requires another exact route and a known audited continuation`)
    }
  }

  const reachable = new Set<string>()
  const visit = (nodeId: string): void => {
    if (reachable.has(nodeId)) return
    reachable.add(nodeId)
    for (const edgeId of nodes.get(nodeId)?.outgoingEdgeIds ?? []) {
      const edge = edges.get(edgeId)
      if (edge?.eligibleForDrill) visit(edge.toNodeId)
    }
  }
  visit(graph.pack.rootNodeId)
  for (const edge of graph.edges.filter(({ eligibleForDrill }) => eligibleForDrill)) {
    if (!reachable.has(edge.fromNodeId)) issues.push(`Eligible edge ${edge.id} is unreachable from the pack root`)
  }

  const coreDepth = Math.max(...graph.paths.map(({ learnerDecisionCount }) => learnerDecisionCount))
  let opponentBranchesAfterRoot = 0
  for (const node of graph.nodes) {
    if (node.id === graph.pack.rootNodeId || node.learnerTurn || !reachable.has(node.id)) continue
    opponentBranchesAfterRoot = Math.max(
      opponentBranchesAfterRoot,
      node.outgoingEdgeIds.filter((id) => edges.get(id)?.eligibleForDrill).length,
    )
  }
  const expectedTier = classifyRepertoireTier(coreDepth, opponentBranchesAfterRoot)
  if (graph.pack.coreDepth !== coreDepth) issues.push(`Pack core depth must be ${coreDepth}`)
  if (graph.pack.opponentBranchCountAfterRoot !== opponentBranchesAfterRoot) {
    issues.push(`Pack opponent branch count must be ${opponentBranchesAfterRoot}`)
  }
  if (graph.pack.tier !== expectedTier) issues.push(`Pack tier must be ${expectedTier}`)

  if (issues.length > 0) throw new Error(`Invalid repertoire graph:\n- ${issues.join('\n- ')}`)
  return graph
}

export function validateEligibleSourceEdgeInventory(
  graphInput: unknown,
  inventoryInput: unknown,
): EligibleSourceEdgeInventoryV1 {
  const graph = RepertoireGraphDocumentSchema.parse(graphInput)
  const inventory = EligibleSourceEdgeInventoryV1Schema.parse(inventoryInput)
  if (inventory.releaseId !== graph.releaseId) {
    throw new Error('Eligible source-edge inventory belongs to another release')
  }
  if (inventory.packId !== graph.pack.id) {
    throw new Error('Eligible source-edge inventory belongs to another pack')
  }

  const emitted = graph.edges
    .filter(({ eligibleForDrill }) => eligibleForDrill)
    .map(({ id }) => id)
    .sort()
  const source = [...inventory.eligibleEdgeIds].sort()
  if (emitted.length !== source.length || emitted.some((edgeId, index) => edgeId !== source[index])) {
    const emittedSet = new Set(emitted)
    const sourceSet = new Set(source)
    const omitted = source.filter((edgeId) => !emittedSet.has(edgeId))
    const invented = emitted.filter((edgeId) => !sourceSet.has(edgeId))
    throw new Error(
      `Eligible source-edge inventory mismatch: ${omitted.length} omitted and ${invented.length} invented edge(s)`,
    )
  }
  return inventory
}

function orderedCoverageCycle(graph: RepertoireGraphDocument, ordinal: number): RepertoirePath[] {
  const summaries = new Map(graph.paths.map((path) => [path.id, trainingValueSummaryForPath(graph, path)]))
  const ranked = [...graph.paths].sort((left, right) => compareTrainingValueSummaries(
    summaries.get(left.id)!,
    summaries.get(right.id)!,
    left.id,
    right.id,
  ))
  let primaryCount = 0
  let coverage = 0
  while (primaryCount < ranked.length && coverage < DEFAULT_PRIMARY_COVERAGE) {
    coverage = Math.min(1, coverage + (ranked[primaryCount]?.conditionalUsage ?? 0))
    primaryCount += 1
  }
  const primary = ranked.slice(0, primaryCount)
  const extended = ranked.slice(primaryCount)
  if (extended.length === 0) return primary
  const rotation = ordinal % extended.length
  return [...primary, ...extended.slice(rotation), ...extended.slice(0, rotation)]
}

export interface SelectSessionPathsOptions {
  graph: RepertoireGraphDocument
  dueCardIds: readonly string[]
  previousCycle: CoverageCycleState | null
  maximumPaths: number
}

export interface SessionPathSelectionResult {
  selection: SessionPathSelection
  nextCycle: CoverageCycleState
}

/**
 * Each cycle contains every selectable path exactly once. High-coverage and
 * due paths are ordered first, but removing selected paths from the persisted
 * cycle guarantees that an extended branch cannot starve.
 */
export function selectSessionPaths(options: SelectSessionPathsOptions): SessionPathSelectionResult {
  const graph = RepertoireGraphDocumentSchema.parse(options.graph)
  if (!Number.isSafeInteger(options.maximumPaths) || options.maximumPaths < 1 || options.maximumPaths > 1_000) {
    throw new Error('maximumPaths must be an integer from 1 through 1000')
  }
  const suppliedDue = [...new Set(options.dueCardIds)]
  for (const cardId of suppliedDue) CardIdSchema.parse(cardId)
  if (suppliedDue.some((cardId) => !cardId.startsWith(`${graph.pack.id}::`))) {
    throw new Error('Due cards must belong to the selected pack')
  }

  const prior = options.previousCycle === null ? null : CoverageCycleStateSchema.parse(options.previousCycle)
  if (prior && prior.packId !== graph.pack.id) throw new Error('Coverage-cycle state belongs to another pack')
  const pathById = new Map(graph.paths.map((path) => [path.id, path]))
  if (prior?.remainingPathIds.some((pathId) => !pathById.has(pathId))) {
    throw new Error('Coverage-cycle state references an unavailable path')
  }
  const ordinal = prior?.ordinal ?? 0
  const remaining = prior && prior.remainingPathIds.length > 0
    ? prior.remainingPathIds.map((id) => pathById.get(id)!)
    : orderedCoverageCycle(graph, ordinal)
  const dueNodeIds = new Set(suppliedDue.map((cardId) => cardId.slice(cardId.indexOf('::') + 2)))
  const duePaths = remaining.filter((path) => path.nodeIds.some((nodeId) => dueNodeIds.has(nodeId)))
  const nonDuePaths = remaining.filter((path) => !duePaths.includes(path))
  const included = [...duePaths, ...nonDuePaths].slice(0, options.maximumPaths)
  const includedIds = new Set(included.map(({ id }) => id))
  const remainingPathIds = remaining.filter(({ id }) => !includedIds.has(id)).map(({ id }) => id)

  const addressedNodeIds = new Set(included.flatMap(({ nodeIds }) => nodeIds).filter((id) => dueNodeIds.has(id)))
  const dueCardIds = suppliedDue.filter((cardId) => addressedNodeIds.has(cardId.slice(cardId.indexOf('::') + 2)))
  const warmupNodeIds: string[] = []
  const warmupSeen = new Set<string>()
  for (const path of included) {
    const dueIndexes = path.nodeIds.flatMap((nodeId, index) => dueNodeIds.has(nodeId) ? [index] : [])
    if (dueIndexes.length === 0) continue
    const lastWarmupIndex = Math.max(...dueIndexes)
    for (const nodeId of path.nodeIds.slice(0, lastWarmupIndex)) {
      if (!dueNodeIds.has(nodeId) && !warmupSeen.has(nodeId)) {
        warmupSeen.add(nodeId)
        warmupNodeIds.push(nodeId)
      }
    }
  }

  const cycleComplete = remainingPathIds.length === 0
  const selection = SessionPathSelectionSchema.parse({
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    packId: graph.pack.id,
    dueCardIds,
    includedPathIds: included.map(({ id }) => id),
    warmupNodeIds,
    coverageCycleId: `${graph.pack.id}::coverage:${ordinal}`,
  })
  const nextCycle = CoverageCycleStateSchema.parse({
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    packId: graph.pack.id,
    ordinal: cycleComplete ? ordinal + 1 : ordinal,
    remainingPathIds,
  })
  return { selection, nextCycle }
}

const REQUIRED_CARO_KANN_ECOS = Array.from({ length: 10 }, (_, index) => `B${10 + index}`)
const REQUIRED_CARO_KANN_FAMILIES = ['Advance', 'Exchange', 'Panov', 'Classical', 'Two Knights'] as const

export interface CaroKannRegressionSummary {
  pathCount: number
  corePathCount: number
  families: string[]
}

/** Release regression only; this checks structure and never supplies evidence. */
export function assertCaroKannFamilyRegression(graph: RepertoireGraphDocument): CaroKannRegressionSummary {
  const parsed = RepertoireGraphDocumentSchema.parse(graph)
  const issues: string[] = []
  if (parsed.pack.side !== 'black') issues.push('The Caro-Kann pack must train Black')
  for (const eco of REQUIRED_CARO_KANN_ECOS) {
    if (!parsed.pack.ecoCodes.includes(eco as z.infer<typeof EcoCodeSchema>)) issues.push(`The Caro-Kann pack is missing ${eco}`)
  }
  const drillablePaths = parsed.paths.filter(({ terminalStatus }) => terminalStatus !== 'quarantined')
  if (drillablePaths.length < 8) issues.push('The Caro-Kann pack requires at least eight drillable root-to-terminal paths')
  const families = [...new Set(drillablePaths.flatMap(({ familyTags }) => familyTags))].sort((a, b) => a.localeCompare(b, 'en'))
  for (const family of REQUIRED_CARO_KANN_FAMILIES) {
    if (!families.includes(family)) issues.push(`The Caro-Kann pack is missing the ${family} family`)
  }
  const corePathCount = drillablePaths.filter(({ learnerDecisionCount }) => learnerDecisionCount >= CORE_MINIMUM_LEARNER_DECISIONS).length
  if (parsed.pack.tier !== 'core' || corePathCount === 0) issues.push('The Caro-Kann pack must contain a validated Core path')
  if (issues.length > 0) throw new Error(`Caro-Kann regression failed:\n- ${issues.join('\n- ')}`)
  return { pathCount: drillablePaths.length, corePathCount, families }
}

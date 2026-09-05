import { createHash } from 'node:crypto'
import { z } from 'zod'

export const EVIDENCE_SCHEMA_VERSION = 2 as const
export const REPERTOIRE_MAX_PLY = 30 as const
export const MINIMUM_DRILL_SAMPLE = 500 as const
export const MINIMUM_EXPLORATORY_SAMPLE = 100 as const

export const CANONICAL_RATING_BANDS = [
  '<1800',
  '1800-1999',
  '2000-2199',
  '2200-2399',
  '2400+',
] as const

export const LICHESS_BEGINNER_DETAIL_BANDS = [
  '<1200',
  '1200-1499',
  '1500-1799',
] as const

export const TIME_CONTROL_CLASSES = [
  'blitz',
  'rapid',
  'classical',
  'unknown',
] as const

export type CanonicalRatingBand = (typeof CANONICAL_RATING_BANDS)[number]
export type LichessBeginnerDetailBand = (typeof LICHESS_BEGINNER_DETAIL_BANDS)[number]
export type TimeControlClass = (typeof TIME_CONTROL_CLASSES)[number]
export type EvidenceSource = 'broadcast' | 'lichess-standard'
export type RatingSystem = 'broadcast-rating' | 'lichess-glicko2'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
const IsoDateTimeSchema = z.string().datetime({ offset: true })
const HttpsUrlSchema = z.string().url().startsWith('https://')
const MonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u)
export const EpdSchema = z.string().refine(
  (value) => value.trim() === value && value.split(/\s+/u).length === 4,
  'EPD must contain exactly four fields',
)
export const UciMoveSchema = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u)

const PermissionsSchema = z.object({
  download: z.literal(true),
  transform: z.literal(true),
  redistribute: z.literal(true),
  attributionRequired: z.boolean(),
  shareAlikeRequired: z.boolean(),
}).strict()

const ApprovalSchema = z.object({
  status: z.literal('approved'),
  approvedOn: IsoDateSchema,
  scope: z.string().min(1),
  basis: z.string().min(1),
  reviewRequiredWhen: z.string().min(1),
}).strict()

const LicenseSchema = z.object({
  spdxId: z.literal('CC0-1.0'),
  name: z.string().min(1),
  termsUrl: HttpsUrlSchema,
  sourceStatementUrl: HttpsUrlSchema,
  permissions: PermissionsSchema,
}).strict()

export const StandardArchiveSchema = z.object({
  month: MonthSchema,
  filename: z.string().regex(/^lichess_db_standard_rated_\d{4}-(?:0[1-9]|1[0-2])\.pgn\.zst$/u),
  url: HttpsUrlSchema,
  bytes: z.number().int().positive(),
  games: z.number().int().positive(),
  sha256: Sha256Schema,
  etagObserved: z.string().min(1),
  lastModifiedObserved: z.string().min(1),
}).strict()

export const LichessStandardManifestSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    id: z.literal('lichess-standard-rated-q2-2026'),
    name: z.string().min(1),
    databaseUrl: HttpsUrlSchema,
    downloadListUrl: HttpsUrlSchema,
    checksumsUrl: HttpsUrlSchema,
    cutoff: IsoDateSchema,
    publishedGameTotal: z.number().int().positive(),
  }).strict(),
  license: LicenseSchema,
  approval: ApprovalSchema,
  filtering: z.object({
    variant: z.literal('Standard only'),
    rated: z.literal(true),
    finishedResults: z.tuple([z.literal('1-0'), z.literal('0-1'), z.literal('1/2-1/2')]),
    timeControlsIncluded: z.tuple([z.literal('blitz'), z.literal('rapid'), z.literal('classical')]),
    timeControlsExcluded: z.tuple([
      z.literal('ultraBullet'),
      z.literal('bullet'),
      z.literal('correspondence'),
      z.literal('unknown'),
    ]),
    botsExcluded: z.literal(true),
    numericRatingsRequired: z.literal(true),
    ratingSystemLabel: z.literal('Lichess rating (Glicko-2)'),
    deduplication: z.string().min(1),
    maximumPly: z.literal(REPERTOIRE_MAX_PLY),
  }).strict(),
  archives: z.array(StandardArchiveSchema).length(3),
  integrity: z.object({
    algorithm: z.literal('SHA-256'),
    publisherChecksumsRequired: z.literal(true),
    verifyByteLengthBeforeParse: z.literal(true),
    verifyDigestBeforeParse: z.literal(true),
    failClosed: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const expectedMonths = ['2026-04', '2026-05', '2026-06']
  if (manifest.archives.some((archive, index) => archive.month !== expectedMonths[index])) {
    context.addIssue({ code: 'custom', path: ['archives'], message: 'Archives must cover 2026 Q2 in order' })
  }
  const total = manifest.archives.reduce((sum, archive) => sum + archive.games, 0)
  if (total !== manifest.source.publishedGameTotal) {
    context.addIssue({ code: 'custom', path: ['source', 'publishedGameTotal'], message: 'Archive games do not reconcile' })
  }
  for (const [index, archive] of manifest.archives.entries()) {
    const expected = `https://database.lichess.org/standard/${archive.filename}`
    if (archive.url !== expected || !archive.filename.includes(archive.month)) {
      context.addIssue({ code: 'custom', path: ['archives', index, 'url'], message: 'Archive URL is not approved' })
    }
  }
})

export const LichessPuzzleManifestSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    id: z.literal('lichess-puzzle-database'),
    name: z.string().min(1),
    databaseUrl: HttpsUrlSchema,
    artifactUrl: z.literal('https://database.lichess.org/lichess_db_puzzle.csv.zst'),
    asOf: IsoDateSchema,
    publishedPuzzleTotal: z.number().int().positive(),
    format: z.object({
      mediaType: z.string().min(1),
      columns: z.tuple([
        z.literal('PuzzleId'),
        z.literal('FEN'),
        z.literal('Moves'),
        z.literal('Rating'),
        z.literal('RatingDeviation'),
        z.literal('Popularity'),
        z.literal('NbPlays'),
        z.literal('Themes'),
        z.literal('GameUrl'),
        z.literal('OpeningTags'),
      ]),
    }).strict(),
  }).strict(),
  license: LicenseSchema,
  approval: ApprovalSchema,
  artifact: z.object({
    bytes: z.number().int().positive(),
    etagObserved: z.string().min(1),
    lastModifiedObserved: z.string().min(1),
    sha256: Sha256Schema.nullable(),
    integrityStatus: z.enum(['pending-local-digest', 'approved-local-digest']),
    integrityReason: z.string().min(1),
  }).strict(),
  selection: z.object({
    openingTagsRequired: z.literal(true),
    minimumPlays: z.literal(100),
    minimumPopularity: z.literal(80),
    maximumRatingDeviation: z.literal(100),
    minimumLearnerDecisions: z.literal(1),
    maximumLearnerDecisions: z.literal(5),
    legalStandardChessRequired: z.literal(true),
    engineSanityCheckRequired: z.literal(true),
    sourceGameBulkFetchProhibited: z.literal(true),
  }).strict(),
  integrity: z.object({
    algorithm: z.literal('SHA-256'),
    localDigestApprovalRequired: z.literal(true),
    verifyByteLengthBeforeParse: z.literal(true),
    verifyDigestBeforeParse: z.literal(true),
    failClosed: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const approved = manifest.artifact.integrityStatus === 'approved-local-digest'
  if (approved !== (manifest.artifact.sha256 !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['artifact', 'sha256'],
      message: 'Approved puzzle integrity requires a digest; pending integrity forbids one',
    })
  }
})

export const PuzzleIntegrityReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  sourceId: z.literal('lichess-puzzle-database'),
  sourceUrl: z.literal('https://database.lichess.org/lichess_db_puzzle.csv.zst'),
  bytes: z.number().int().positive(),
  sha256: Sha256Schema,
  computedAt: IsoDateTimeSchema,
  observedEtag: z.string().min(1),
  observedLastModified: z.string().min(1),
  approval: z.object({
    status: z.enum(['pending', 'approved', 'rejected']),
    approvedOn: IsoDateSchema.nullable(),
    approvedBy: z.string().nullable(),
  }).strict(),
}).strict()

export const EvidenceCohortSchema = z.object({
  id: z.string().regex(/^cohort_[a-z0-9-]{3,64}$/u),
  source: z.enum(['broadcast', 'lichess-standard']),
  ratingSystem: z.enum(['broadcast-rating', 'lichess-glicko2']),
  timeControl: z.enum(['blitz', 'rapid', 'classical']),
  cutoff: IsoDateSchema,
}).strict()

export const RawOutcomesSchema = z.object({
  whiteWins: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  blackWins: z.number().int().nonnegative(),
  n: z.number().int().nonnegative(),
}).strict().refine(
  (counts) => counts.whiteWins + counts.draws + counts.blackWins === counts.n,
  'W/D/L counts must sum to N',
)

export const GraphExportManifestSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  generatedAt: IsoDateTimeSchema,
  releaseEligible: z.literal(false),
  maximumPly: z.literal(REPERTOIRE_MAX_PLY),
  databaseSha256: Sha256Schema,
  sources: z.array(z.object({
    id: z.string().min(1),
    complete: z.boolean(),
    archivesExpected: z.number().int().positive(),
    archivesCompleted: z.number().int().nonnegative(),
    recordsSeen: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    deduplicated: z.number().int().nonnegative(),
    rejected: z.record(z.string(), z.number().int().nonnegative()),
  }).strict()),
  files: z.object({
    positions: z.object({ path: z.string().min(1), bytes: z.number().int().positive(), sha256: Sha256Schema }).strict(),
    edges: z.object({ path: z.string().min(1), bytes: z.number().int().positive(), sha256: Sha256Schema }).strict(),
  }).strict(),
  blockedGates: z.array(z.string().min(1)).min(1),
}).strict()

export type LichessStandardManifest = z.infer<typeof LichessStandardManifestSchema>
export type LichessPuzzleManifest = z.infer<typeof LichessPuzzleManifestSchema>
export type PuzzleIntegrityReceipt = z.infer<typeof PuzzleIntegrityReceiptSchema>
export type EvidenceCohort = z.infer<typeof EvidenceCohortSchema>
export type RawOutcomes = z.infer<typeof RawOutcomesSchema>

export function canonicalRatingBandFor(whiteRating: number, blackRating: number): CanonicalRatingBand {
  const mean = (whiteRating + blackRating) / 2
  if (mean < 1800) return '<1800'
  if (mean < 2000) return '1800-1999'
  if (mean < 2200) return '2000-2199'
  if (mean < 2400) return '2200-2399'
  return '2400+'
}

export function lichessBeginnerDetailBandFor(
  whiteRating: number,
  blackRating: number,
): LichessBeginnerDetailBand | null {
  const mean = (whiteRating + blackRating) / 2
  if (mean < 1200) return '<1200'
  if (mean < 1500) return '1200-1499'
  if (mean < 1800) return '1500-1799'
  return null
}

export function stablePositionId(epd: string): string {
  return `pos_${createHash('sha256').update(epd).digest('hex').slice(0, 16)}`
}

export function stableCardId(packId: string, epd: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{2,95}$/u.test(packId)) throw new Error('Invalid pack ID')
  return `${packId}::${stablePositionId(epd)}`
}

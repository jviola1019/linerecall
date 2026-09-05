import { z } from 'zod'

export const RatingBandSchema = z.enum([
  '<1800',
  '1800-1999',
  '2000-2199',
  '2200-2399',
  '2400+',
])

export const UciMoveSchema = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u)
export const EcoCodeSchema = z.string().regex(/^[A-E][0-9]{2}$/u)
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
export const EpdSchema = z.string().refine(
  (value) => value.trim() === value && value.split(/\s+/u).length === 4,
  'Expected a normalized four-field EPD',
)

export const BandStatsSchema = z.object({
  band: RatingBandSchema,
  n: z.number().int().nonnegative(),
  whiteWins: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  blackWins: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  winRate: z.number().min(0).max(100).nullable(),
  drawRate: z.number().min(0).max(100).nullable(),
  lossRate: z.number().min(0).max(100).nullable(),
  lowSample: z.boolean(),
}).strict().superRefine((stats, context) => {
  if (stats.whiteWins + stats.draws + stats.blackWins !== stats.n) {
    context.addIssue({ code: 'custom', message: 'Raw W/D/L counts do not sum to N' })
  }
  if (stats.wins + stats.draws + stats.losses !== stats.n) {
    context.addIssue({ code: 'custom', message: 'Perspective W/D/L counts do not sum to N' })
  }
  const rates = [stats.winRate, stats.drawRate, stats.lossRate]
  if (stats.n === 0 && rates.some((rate) => rate !== null)) {
    context.addIssue({ code: 'custom', message: 'Zero-sample bands must use null rates' })
  }
  if (stats.n > 0 && rates.some((rate) => rate === null)) {
    context.addIssue({ code: 'custom', message: 'Non-empty bands require W/D/L rates' })
  }
  if (stats.n > 0) {
    const expected = (count: number): number => Math.round((count / stats.n) * 10_000) / 100
    if (
      stats.winRate !== expected(stats.wins) ||
      stats.drawRate !== expected(stats.draws) ||
      stats.lossRate !== expected(stats.losses)
    ) context.addIssue({ code: 'custom', message: 'W/D/L rates do not match their counts' })
  }
})

export const BandStatsArraySchema = z.array(BandStatsSchema).length(5).superRefine((bands, context) => {
  const expected = ['<1800', '1800-1999', '2000-2199', '2200-2399', '2400+'] as const
  for (const [index, band] of bands.entries()) {
    if (band.band !== expected[index]) {
      context.addIssue({ code: 'custom', message: 'Rating bands are not in canonical order', path: [index, 'band'] })
    }
  }
})

export const EngineScoreSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('centipawn'), value: z.number().int() }).strict(),
  z.object({ kind: z.literal('mate'), value: z.number().int() }).strict(),
])

export const EngineVariationSchema = z.object({
  multipv: z.number().int().min(1).max(5),
  depth: z.number().int().nonnegative().nullable(),
  selectiveDepth: z.number().int().nonnegative().nullable(),
  nodes: z.number().int().nonnegative().nullable(),
  score: EngineScoreSchema,
  bound: z.enum(['exact', 'lower', 'upper']),
  movesUci: z.array(UciMoveSchema).min(1).max(256),
}).strict()

export const EngineCheckSchema = z.object({
  engineRef: z.string().regex(/^engine_[a-f0-9]{16}$/u),
  bestMoveUci: UciMoveSchema,
  bestScore: EngineScoreSchema,
  expectedMoveCentipawnLoss: z.number().int().nonnegative(),
  topVariations: z.array(EngineVariationSchema).min(1).max(5),
  analyzedAt: z.string().datetime({ offset: true }),
  quarantined: z.boolean(),
  quarantineReasons: z.array(z.string().min(1).max(500)),
}).strict()

export const MoveEvidenceSchema = z.object({
  uci: UciMoveSchema,
  san: z.string().min(1).max(32),
  classification: z.enum([
    'book',
    'playable',
    'inaccuracy',
    'mistake',
    'unverified_deviation',
  ]),
  expected: z.boolean(),
  acceptedBookTransposition: z.boolean(),
  sampleSize: z.number().int().nonnegative(),
  bands: BandStatsArraySchema,
  centipawnLoss: z.number().int().nonnegative().nullable(),
  score: EngineScoreSchema.nullable(),
  principalVariationUci: z.array(UciMoveSchema).max(256),
  independentlyEngineAnalyzed: z.boolean(),
}).strict()

export const PositionNodeSchema = z.object({
  id: z.string().min(1).max(240),
  ply: z.number().int().nonnegative().max(200),
  epd: EpdSchema,
  fen: z.string().min(1).max(128),
  sideToMove: z.enum(['white', 'black']),
  expectedMoveUci: UciMoveSchema,
  nextNodeId: z.string().min(1).max(240).nullable(),
  equivalentPositionLineIds: z.array(z.string().min(1).max(200)).max(3_790),
  moves: z.array(MoveEvidenceSchema).min(1).max(128),
  engine: EngineCheckSchema,
  provenanceRef: z.string().regex(/^prov_[a-f0-9]{16}$/u),
}).strict()

export const CrosscheckStatusSchema = z.enum([
  'match',
  'naming_difference',
  'missing_oracle_entry',
  'base_eco_mismatch',
  'ambiguous_oracle_base',
  'not_sampled',
])

export const VerifiedLineSchema = z.object({
  id: z.string().min(1).max(220),
  sourceLineId: z.string().regex(/^tax_[a-f0-9]{24}$/u),
  eco: EcoCodeSchema,
  name: z.string().min(1).max(256),
  pgn: z.string().min(1).max(4_096),
  uci: z.array(UciMoveSchema).min(1).max(200),
  trainedSide: z.enum(['white', 'black']),
  terminalSampleSize: z.number().int().nonnegative(),
  terminalStats: BandStatsArraySchema,
  drillEligible: z.boolean(),
  insufficientBacktestSample: z.boolean(),
  selectedForEngineVerification: z.boolean(),
  quarantined: z.boolean(),
  quarantineReasons: z.array(z.string().min(1).max(500)),
  crosscheckStatus: CrosscheckStatusSchema,
  nodes: z.array(PositionNodeSchema).min(1).max(100),
  provenanceRef: z.string().regex(/^prov_[a-f0-9]{16}$/u),
}).strict()

export const BrowsableLineSchema = z.object({
  sourceLineId: z.string().regex(/^tax_[a-f0-9]{24}$/u),
  eco: EcoCodeSchema,
  name: z.string().min(1).max(256),
  pgn: z.string().min(1).max(4_096),
  uci: z.array(UciMoveSchema).min(1).max(200),
  terminalSampleSize: z.number().int().nonnegative(),
  terminalWhiteStats: BandStatsArraySchema,
  terminalBlackStats: BandStatsArraySchema,
  backtestEligible: z.boolean(),
  verifiedVariantIds: z.array(z.string().min(1).max(220)).max(2),
  provenanceRef: z.string().regex(/^prov_[a-f0-9]{16}$/u),
}).strict()

export const OpeningCatalogEntrySchema = z.object({
  eco: EcoCodeSchema,
  volume: z.enum(['A', 'B', 'C', 'D', 'E']),
  lineCount: z.number().int().positive(),
  names: z.array(z.string().min(1).max(256)).min(1),
  drillableVariantCount: z.number().int().nonnegative(),
  partitionId: z.string().regex(/^eco_[A-E][0-9]{2}$/u),
  compressedBytes: z.number().int().positive(),
  uncompressedBytes: z.number().int().positive(),
  sha256: Sha256Schema,
}).strict()

export const OpeningPartitionSchema = z.object({
  schemaVersion: z.literal(1),
  eco: EcoCodeSchema,
  generatedAt: z.string().datetime({ offset: true }),
  lines: z.array(BrowsableLineSchema).min(1),
  verifiedLines: z.array(VerifiedLineSchema),
}).strict()

export const ProvenanceSchema = z.object({
  id: z.string().regex(/^prov_[a-f0-9]{16}$/u),
  taxonomy: z.object({
    repositoryUrl: z.string().url(),
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    license: z.literal('CC0-1.0'),
    sourceFile: z.string().regex(/^[a-e]\.tsv$/u),
    sourceRow: z.number().int().min(2),
    sourceSha256: Sha256Schema,
    pulledAt: z.string().datetime({ offset: true }),
  }).strict(),
  corpusRef: z.literal('corpus_lichess_broadcast_2020_01_2026_06'),
  engineRef: z.string().regex(/^engine_[a-f0-9]{16}$/u).nullable(),
  crosscheckRef: z.string().regex(/^scid_[a-f0-9]{16}$/u).nullable(),
}).strict()

export const DataManifestSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal('LineRecall'),
  generatedAt: z.string().datetime({ offset: true }),
  releaseEligible: z.boolean(),
  taxonomy: z.object({
    repositoryUrl: z.string().url(),
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    license: z.literal('CC0-1.0'),
    totalLines: z.literal(3_790),
    ecoCodeCount: z.literal(500),
  }).strict(),
  corpus: z.object({
    license: z.literal('CC BY-SA 4.0'),
    licenseUrl: z.string().url(),
    startMonth: z.literal('2020-01'),
    cutoffMonth: z.literal('2026-06'),
    pulledAt: z.string().datetime({ offset: true }),
    archives: z.array(z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/u),
      url: z.string().url(),
      sha256: Sha256Schema,
    }).strict()).length(78),
    recordsSeen: z.number().int().positive(),
    accepted: z.number().int().nonnegative(),
    deduplicated: z.number().int().nonnegative(),
    rejected: z.record(z.string(), z.number().int().nonnegative()),
    filtering: z.record(z.string(), z.union([z.string(), z.number()])),
    derivedDataNotice: z.string().min(1),
  }).strict(),
  engine: z.object({
    id: z.string().regex(/^engine_[a-f0-9]{16}$/u),
    name: z.string().min(1),
    releaseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    binarySha256: Sha256Schema,
    nnue: z.array(z.object({ role: z.enum(['big', 'small']), sha256: Sha256Schema }).strict()).length(2),
    threads: z.literal(1),
    hashMb: z.literal(128),
    multiPv: z.literal(5),
    nodes: z.literal(250_000),
    analyzedAt: z.string().datetime({ offset: true }),
    license: z.literal('GPL-3.0-only'),
    shipped: z.literal(false),
  }).strict(),
  crosscheck: z.object({
    id: z.string().regex(/^scid_[a-f0-9]{16}$/u),
    repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    sha256: Sha256Schema,
    license: z.literal('GPL-2.0-only'),
    sampled: z.number().int().nonnegative().max(250),
    discrepancies: z.number().int().nonnegative(),
    discrepancyIndex: z.array(z.object({
      lineId: z.string().regex(/^tax_[a-f0-9]{24}$/u),
      taxonomyEco: EcoCodeSchema,
      taxonomyName: z.string().min(1).max(256),
      status: z.enum(['naming_difference', 'missing_oracle_entry', 'base_eco_mismatch', 'ambiguous_oracle_base']),
      quarantined: z.boolean(),
    }).strict()).max(250),
    oracleContentShipped: z.literal(false),
  }).strict().superRefine((crosscheck, context) => {
    if (crosscheck.discrepancyIndex.length !== crosscheck.discrepancies) {
      context.addIssue({ code: 'custom', message: 'Cross-check discrepancy index does not match discrepancy total' })
    }
    if (new Set(crosscheck.discrepancyIndex.map((entry) => entry.lineId)).size !== crosscheck.discrepancyIndex.length) {
      context.addIssue({ code: 'custom', message: 'Cross-check discrepancy index contains duplicate lines' })
    }
  }),
  audit: z.object({
    browsableLines: z.literal(3_790),
    verifiedVariants: z.number().int().nonnegative(),
    drillableVariants: z.number().int().nonnegative(),
    quarantinedVariants: z.number().int().nonnegative(),
    partitions: z.literal(500),
  }).strict(),
  searchIndex: z.object({
    compressedBytes: z.number().int().positive(),
    uncompressedBytes: z.number().int().positive(),
    sha256: Sha256Schema,
  }).strict(),
  catalog: z.array(OpeningCatalogEntrySchema).length(500),
  provenance: z.array(ProvenanceSchema).length(3_790),
}).strict()

export type BandStats = z.infer<typeof BandStatsSchema>
export type EngineCheck = z.infer<typeof EngineCheckSchema>
export type MoveEvidence = z.infer<typeof MoveEvidenceSchema>
export type PositionNode = z.infer<typeof PositionNodeSchema>
export type VerifiedLine = z.infer<typeof VerifiedLineSchema>
export type OpeningCatalogEntry = z.infer<typeof OpeningCatalogEntrySchema>
export type Provenance = z.infer<typeof ProvenanceSchema>
export type OpeningPartition = z.infer<typeof OpeningPartitionSchema>
export type DataManifest = z.infer<typeof DataManifestSchema>

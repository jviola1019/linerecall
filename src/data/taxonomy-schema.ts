import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const IsoDateTimeSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Invalid ISO timestamp");
const HttpsUrlSchema = z.string().url().startsWith("https://");

export const EcoVolumeSchema = z.enum(["A", "B", "C", "D", "E"]);
export const EcoCodeSchema = z.string().regex(/^[A-E][0-9]{2}$/u);
export const UciMoveSchema = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u);
export const EpdSchema = z.string().refine(
  (value) => value.trim() === value && value.split(/\s+/u).length === 4,
  "EPD must contain exactly four fields",
);

const IntegrityFileSchema = z.object({
  path: z.string().min(1),
  url: HttpsUrlSchema,
  bytes: z.number().int().positive(),
  sha256: Sha256Schema,
}).strict();

const TaxonomyFileSchema = IntegrityFileSchema.extend({
  volume: EcoVolumeSchema,
  rows: z.number().int().positive(),
}).strict();

export const TaxonomySourceManifestSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    id: z.literal("lichess-chess-openings"),
    name: z.string().min(1),
    repositoryUrl: HttpsUrlSchema,
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    commitUrl: HttpsUrlSchema,
  }).strict(),
  license: z.object({
    spdxId: z.literal("CC0-1.0"),
    name: z.string().min(1),
    termsUrl: HttpsUrlSchema,
    sourceFile: IntegrityFileSchema,
    permissions: z.object({
      download: z.boolean(),
      transform: z.boolean(),
      redistribute: z.boolean(),
      attributionRequired: z.boolean(),
      shareAlikeRequired: z.boolean(),
    }).strict(),
    notice: z.string().min(1),
  }).strict(),
  approval: z.object({
    status: z.enum(["approved", "pending", "rejected"]),
    approvedOn: IsoDateSchema,
    scope: z.string().min(1),
    basis: z.string().min(1),
    reviewRequiredWhen: z.string().min(1),
  }).strict(),
  format: z.object({
    mediaType: z.string().min(1),
    header: z.tuple([z.literal("eco"), z.literal("name"), z.literal("pgn")]),
    lineEnding: z.literal("LF"),
    expectedRows: z.number().int().positive(),
    expectedEcoCodes: z.number().int().positive(),
    ecoPattern: z.literal("^[A-E][0-9]{2}$"),
  }).strict(),
  files: z.array(TaxonomyFileSchema).length(5),
  integrity: z.object({
    algorithm: z.literal("SHA-256"),
    verifyBeforeParse: z.literal(true),
    failClosed: z.literal(true),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const volumes = manifest.files.map(({ volume }) => volume);
  if (new Set(volumes).size !== 5) {
    context.addIssue({ code: "custom", message: "Source files must cover ECO volumes A-E exactly once", path: ["files"] });
  }
  const rowTotal = manifest.files.reduce((sum, file) => sum + file.rows, 0);
  if (rowTotal !== manifest.format.expectedRows) {
    context.addIssue({ code: "custom", message: "Per-file rows do not equal expectedRows", path: ["format", "expectedRows"] });
  }
  for (const [index, file] of manifest.files.entries()) {
    if (file.path !== `${file.volume.toLowerCase()}.tsv`) {
      context.addIssue({ code: "custom", message: "File path must match its ECO volume", path: ["files", index, "path"] });
    }
    if (!file.url.includes(`/${manifest.source.commit}/`)) {
      context.addIssue({ code: "custom", message: "File URL is not pinned to the declared commit", path: ["files", index, "url"] });
    }
  }
});

export const TaxonomyProvenanceSchema = z.object({
  sourceId: z.literal("lichess-chess-openings"),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceFile: z.string().regex(/^[a-e]\.tsv$/u),
  sourceRow: z.number().int().min(2),
  sourceSha256: Sha256Schema,
  licenseSpdxId: z.literal("CC0-1.0"),
  pulledAt: IsoDateTimeSchema,
}).strict();

export const TaxonomyPositionSchema = z.object({
  ply: z.number().int().nonnegative(),
  epd: EpdSchema,
  sideToMove: z.enum(["white", "black"]),
  moveFromPrevious: UciMoveSchema.optional(),
}).strict();

export const NormalizedTaxonomyLineSchema = z.object({
  id: z.string().regex(/^tax_[a-f0-9]{24}$/u),
  eco: EcoCodeSchema,
  volume: EcoVolumeSchema,
  name: z.string().trim().min(1).max(256),
  pgn: z.string().trim().min(1).max(4096),
  uci: z.array(UciMoveSchema).min(1).max(200),
  epd: EpdSchema,
  plyCount: z.number().int().positive().max(200),
  positions: z.array(TaxonomyPositionSchema).min(2).max(201),
  provenance: TaxonomyProvenanceSchema,
}).strict();

export const TaxonomyPartitionSchema = z.object({
  schemaVersion: z.literal(1),
  eco: EcoCodeSchema,
  generatedAt: IsoDateTimeSchema,
  taxonomyCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  lines: z.array(NormalizedTaxonomyLineSchema).min(1),
}).strict();

export const TaxonomyCatalogEntrySchema = z.object({
  eco: EcoCodeSchema,
  volume: EcoVolumeSchema,
  lineCount: z.number().int().positive(),
  names: z.array(z.string().min(1)),
  partitionPath: z.string().regex(/^partitions\/[A-E][0-9]{2}\.json$/u),
  bytes: z.number().int().positive(),
  sha256: Sha256Schema,
}).strict();

export const TaxonomyCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: IsoDateTimeSchema,
  taxonomyCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceLicense: z.literal("CC0-1.0"),
  totalLines: z.number().int().positive(),
  ecoCodeCount: z.number().int().positive(),
  entries: z.array(TaxonomyCatalogEntrySchema),
}).strict();

export const TaxonomySearchIndexSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: IsoDateTimeSchema,
  taxonomyCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  entries: z.array(z.object({
    id: z.string().regex(/^tax_[a-f0-9]{24}$/u),
    eco: EcoCodeSchema,
    name: z.string().min(1),
    pgn: z.string().min(1),
    uci: z.array(UciMoveSchema).min(1),
    epd: EpdSchema,
  }).strict()),
}).strict();

export const BroadcastTargetIndexV1Schema = z.object({
  schemaVersion: z.literal(1),
  taxonomyCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  maxPly: z.number().int().positive(),
  targets: z.array(z.object({
    epd: EpdSchema,
    lineIds: z.array(z.string().regex(/^tax_[a-f0-9]{24}$/u)).min(1),
    terminalLineIds: z.array(z.string().regex(/^tax_[a-f0-9]{24}$/u)).min(1).optional(),
  }).strict()),
}).strict();

export type TaxonomySourceManifest = z.infer<typeof TaxonomySourceManifestSchema>;
export type NormalizedTaxonomyLine = z.infer<typeof NormalizedTaxonomyLineSchema>;
export type TaxonomyPartition = z.infer<typeof TaxonomyPartitionSchema>;
export type TaxonomyCatalog = z.infer<typeof TaxonomyCatalogSchema>;
export type TaxonomySearchIndex = z.infer<typeof TaxonomySearchIndexSchema>;
export type BroadcastTargetIndexV1 = z.infer<typeof BroadcastTargetIndexV1Schema>;

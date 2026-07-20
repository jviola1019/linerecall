import { z } from 'zod';

const HexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ApprovedSourceSchema = z
  .object({
    status: z.literal('approved'),
    approvedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    scope: z.string().min(1),
    basis: z.string().min(1),
    reviewRequiredWhen: z.string().min(1),
  })
  .strict();

export const StockfishManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.literal('Stockfish'),
    version: z.literal('18'),
    releaseTag: z.literal('sf_18'),
    releaseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    releasedAt: z.string().datetime({ offset: true }),
    sourceUrl: z.string().url(),
    releaseUrl: z.string().url(),
    approval: ApprovedSourceSchema,
    license: z
      .object({
        spdx: z.literal('GPL-3.0-only'),
        name: z.string().min(1),
        url: z.string().url(),
        distributionPolicy: z.string().min(1),
      })
      .strict(),
    analysisConfiguration: z
      .object({
        threads: z.literal(1),
        hashMb: z.literal(128),
        multiPv: z.literal(5),
        nodes: z.literal(250_000),
      })
      .strict(),
    artifacts: z.array(
      z
        .object({
          platform: z.enum(['win32', 'linux', 'darwin']),
          arch: z.enum(['x64', 'arm64']),
          fileName: z.string().regex(/^stockfish-[a-z0-9-]+\.(?:zip|tar)$/),
          url: z.string().url(),
          size: z.number().int().positive(),
          sha256: HexSha256Schema,
        })
        .strict(),
    ),
  })
  .strict();

export const ScidManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.literal('Scid ECO classification oracle'),
    repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/),
    filePath: z.literal('scid.eco'),
    url: z.string().url(),
    sourceUrl: z.string().url(),
    size: z.number().int().positive(),
    sha256: HexSha256Schema,
    approval: ApprovedSourceSchema,
    license: z
      .object({
        spdx: z.literal('GPL-2.0-only'),
        name: z.string().min(1),
        url: z.string().url(),
        distributionPolicy: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type StockfishManifest = z.infer<typeof StockfishManifestSchema>;
export type StockfishArtifact = StockfishManifest['artifacts'][number];
export type ScidManifest = z.infer<typeof ScidManifestSchema>;

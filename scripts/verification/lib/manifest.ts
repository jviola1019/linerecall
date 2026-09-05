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

export const ScidProvisionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    provisionedAt: z.string().datetime({ offset: true }),
    repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/),
    file: z.object({
      path: z.literal('scid.eco'),
      size: z.number().int().positive(),
      sha256: HexSha256Schema,
      reused: z.boolean(),
    }).strict(),
    license: ScidManifestSchema.shape.license,
  })
  .strict();

export const StockfishProvisionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    provisionedAt: z.string().datetime({ offset: true }),
    releaseTag: z.literal('sf_18'),
    releaseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    license: StockfishManifestSchema.shape.license,
    artifact: StockfishManifestSchema.shape.artifacts.element.extend({
      archiveSha256Verified: HexSha256Schema,
      archiveReused: z.boolean(),
    }).strict(),
    executable: z
      .object({
        path: z.string().min(1).max(1_024),
        fileName: z.string().regex(/^stockfish-[a-z0-9-]+(?:\.exe)?$/),
        sha256: HexSha256Schema,
      })
      .strict(),
  })
  .strict();

/**
 * Bind a provision receipt to one complete, pinned manifest artifact tuple.
 * Matching only a release commit is insufficient: it would allow a receipt
 * for an unapproved URL, byte length, or archive digest to enter a campaign.
 */
export function assertStockfishProvisionMatchesManifest(
  manifestValue: unknown,
  receiptValue: unknown,
): StockfishProvisionReceipt {
  const manifest = StockfishManifestSchema.parse(manifestValue);
  const receipt = StockfishProvisionReceiptSchema.parse(receiptValue);
  if (
    receipt.releaseTag !== manifest.releaseTag
    || receipt.releaseCommit !== manifest.releaseCommit
    || JSON.stringify(receipt.license) !== JSON.stringify(manifest.license)
  ) {
    throw new Error('Stockfish provision receipt belongs to a different pinned release or license');
  }
  const pinned = manifest.artifacts.find((artifact) =>
    artifact.platform === receipt.artifact.platform
    && artifact.arch === receipt.artifact.arch
    && artifact.fileName === receipt.artifact.fileName
    && artifact.url === receipt.artifact.url
    && artifact.size === receipt.artifact.size
    && artifact.sha256 === receipt.artifact.sha256,
  );
  if (pinned === undefined) {
    throw new Error('Stockfish provision receipt artifact tuple is not present in the pinned source manifest');
  }
  if (receipt.artifact.archiveSha256Verified !== pinned.sha256) {
    throw new Error('Stockfish provision receipt did not verify the pinned archive digest');
  }
  return receipt;
}

/** Bind a Scid provision receipt to the exact approved oracle bytes. */
export function assertScidProvisionMatchesManifest(
  manifestValue: unknown,
  receiptValue: unknown,
): ScidProvisionReceipt {
  const manifest = ScidManifestSchema.parse(manifestValue);
  const receipt = ScidProvisionReceiptSchema.parse(receiptValue);
  if (
    receipt.repositoryCommit !== manifest.repositoryCommit
    || receipt.file.path !== manifest.filePath
    || receipt.file.size !== manifest.size
    || receipt.file.sha256 !== manifest.sha256
    || JSON.stringify(receipt.license) !== JSON.stringify(manifest.license)
  ) {
    throw new Error('Scid provision receipt does not match the pinned oracle manifest');
  }
  return receipt;
}

export type StockfishManifest = z.infer<typeof StockfishManifestSchema>;
export type StockfishArtifact = StockfishManifest['artifacts'][number];
export type StockfishProvisionReceipt = z.infer<typeof StockfishProvisionReceiptSchema>;
export type ScidManifest = z.infer<typeof ScidManifestSchema>;
export type ScidProvisionReceipt = z.infer<typeof ScidProvisionReceiptSchema>;

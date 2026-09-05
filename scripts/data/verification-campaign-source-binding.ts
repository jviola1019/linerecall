import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import { FamilyReleaseIdSchema } from '../../src/domain/opening-family.ts'
import { readHandleBoundRegularFile } from '../lib/handle-bound-file.ts'
import {
  resolveReceiptRoot,
  resolveSafeReceiptPath,
} from '../release/lib/immutable-json-receipt.ts'
import {
  ScidManifestSchema,
  StockfishManifestSchema,
  assertScidProvisionMatchesManifest,
  assertStockfishProvisionMatchesManifest,
  type ScidManifest,
  type ScidProvisionReceipt,
  type StockfishManifest,
  type StockfishProvisionReceipt,
} from '../verification/lib/manifest.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9_./-]{0,510}$/u
const MAXIMUM_SOURCE_FILE_BYTES = 512 * 1024 * 1024
const MAXIMUM_CONTROL_FILE_BYTES = 4 * 1024 * 1024

const RawSourceFileV1Schema = z.object({
  path: z.string().min(1).max(512).regex(SAFE_RELATIVE_PATH),
  bytes: z.number().int().positive().max(MAXIMUM_SOURCE_FILE_BYTES),
  sha256: z.string().regex(SHA256),
}).strict()

export const VerificationCampaignSourceBindingV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-verification-campaign-source-binding'),
  releaseId: FamilyReleaseIdSchema,
  boundAt: z.string().datetime({ offset: true }),
  stockfish: z.object({
    sourceManifest: RawSourceFileV1Schema,
    provisionReceipt: RawSourceFileV1Schema,
    executable: RawSourceFileV1Schema,
    networks: z.array(z.object({
      role: z.enum(['big', 'small']),
      defaultFileName: z.string().regex(/^nn-[a-f0-9]{12}\.nnue$/u),
      file: RawSourceFileV1Schema,
    }).strict()).length(2),
  }).strict(),
  scid: z.object({
    sourceManifest: RawSourceFileV1Schema,
    provisionReceipt: RawSourceFileV1Schema,
    oracle: RawSourceFileV1Schema,
  }).strict(),
}).strict().superRefine((binding, context) => {
  const roles = binding.stockfish.networks.map(({ role }) => role)
  if (new Set(roles).size !== 2 || !roles.includes('big') || !roles.includes('small')) {
    context.addIssue({ code: 'custom', path: ['stockfish', 'networks'], message: 'Campaign binding requires one big and one small NNUE network' })
  }
  const paths = [
    binding.stockfish.sourceManifest.path,
    binding.stockfish.provisionReceipt.path,
    binding.stockfish.executable.path,
    ...binding.stockfish.networks.map(({ file }) => file.path),
    binding.scid.sourceManifest.path,
    binding.scid.provisionReceipt.path,
    binding.scid.oracle.path,
  ]
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: 'custom', message: 'Every campaign source byte path must be unique' })
  }
})

export type VerificationCampaignSourceBindingV1 = z.infer<typeof VerificationCampaignSourceBindingV1Schema>

export interface VerifiedCampaignSourcesV1 {
  binding: VerificationCampaignSourceBindingV1
  stockfishManifest: StockfishManifest
  stockfishProvision: StockfishProvisionReceipt
  stockfish: {
    sourceManifestSha256: string
    provisionReceiptSha256: string
    releaseCommit: string
    executableSha256: string
    nnueSha256: string[]
  }
  scidManifest: ScidManifest
  scidProvision: ScidProvisionReceipt
  scid: {
    sourceManifestSha256: string
    provisionReceiptSha256: string
    repositoryCommit: string
    oracleSha256: string
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readBoundSourceFile(
  rootReal: string,
  receipt: z.infer<typeof RawSourceFileV1Schema>,
  label: string,
  maximumBytes = MAXIMUM_SOURCE_FILE_BYTES,
): Promise<Buffer> {
  if (receipt.bytes > maximumBytes) throw new Error(`${label} exceeds its hard byte cap`)
  const path = await resolveSafeReceiptPath(rootReal, receipt.path)
  const bytes = await readHandleBoundRegularFile(path, label, maximumBytes)
  if (bytes.byteLength !== receipt.bytes) throw new Error(`${label} byte length differs from its immutable binding`)
  if (sha256(bytes) !== receipt.sha256) throw new Error(`${label} SHA-256 differs from its immutable binding`)
  return bytes
}

function decodeJson(bytes: Uint8Array, label: string): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.includes('\0')) throw new Error(`${label} contains a NUL character`)
  return JSON.parse(text) as unknown
}

/**
 * Reopen every build-time verification dependency from the audit root. This
 * deliberately does not trust campaign inventory digest fields: promotion
 * recomputes each digest from the pinned manifest, provision, executable,
 * exported NNUE, and Scid oracle bytes named by this immutable binding.
 */
export async function verifyVerificationCampaignSources(options: {
  root: string
  binding: unknown
}): Promise<VerifiedCampaignSourcesV1> {
  const binding = VerificationCampaignSourceBindingV1Schema.parse(options.binding)
  const rootReal = await resolveReceiptRoot(options.root)

  const stockfishManifestBytes = await readBoundSourceFile(
    rootReal,
    binding.stockfish.sourceManifest,
    'Pinned Stockfish source manifest',
    MAXIMUM_CONTROL_FILE_BYTES,
  )
  const stockfishManifest = StockfishManifestSchema.parse(
    decodeJson(stockfishManifestBytes, 'Pinned Stockfish source manifest'),
  )
  const provisionBytes = await readBoundSourceFile(
    rootReal,
    binding.stockfish.provisionReceipt,
    'Stockfish provision receipt',
    MAXIMUM_CONTROL_FILE_BYTES,
  )
  const stockfishProvision = assertStockfishProvisionMatchesManifest(
    stockfishManifest,
    decodeJson(provisionBytes, 'Stockfish provision receipt'),
  )
  const executableBytes = await readBoundSourceFile(
    rootReal,
    binding.stockfish.executable,
    'Stockfish executable',
  )
  if (
    binding.stockfish.executable.sha256 !== stockfishProvision.executable.sha256
    || basename(binding.stockfish.executable.path) !== stockfishProvision.executable.fileName
  ) throw new Error('Bound Stockfish executable differs from its pinned provision receipt')

  const networkHashes: string[] = []
  for (const network of binding.stockfish.networks) {
    const bytes = await readBoundSourceFile(rootReal, network.file, `Stockfish ${network.role} NNUE`)
    const digest = sha256(bytes)
    if (network.defaultFileName !== `nn-${digest.slice(0, 12)}.nnue`) {
      throw new Error(`Stockfish ${network.role} NNUE default filename does not match its bytes`)
    }
    networkHashes.push(digest)
  }

  const scidManifestBytes = await readBoundSourceFile(
    rootReal,
    binding.scid.sourceManifest,
    'Pinned Scid source manifest',
    MAXIMUM_CONTROL_FILE_BYTES,
  )
  const scidManifest = ScidManifestSchema.parse(decodeJson(scidManifestBytes, 'Pinned Scid source manifest'))
  const scidProvisionBytes = await readBoundSourceFile(
    rootReal,
    binding.scid.provisionReceipt,
    'Scid provision receipt',
    MAXIMUM_CONTROL_FILE_BYTES,
  )
  const scidProvision = assertScidProvisionMatchesManifest(
    scidManifest,
    decodeJson(scidProvisionBytes, 'Scid provision receipt'),
  )
  const oracleBytes = await readBoundSourceFile(rootReal, binding.scid.oracle, 'Pinned Scid oracle')
  if (
    binding.scid.oracle.sha256 !== scidManifest.sha256
    || binding.scid.oracle.bytes !== scidManifest.size
    || basename(binding.scid.oracle.path) !== scidManifest.filePath
  ) throw new Error('Bound Scid oracle differs from its pinned source manifest')

  return {
    binding,
    stockfishManifest,
    stockfishProvision,
    stockfish: {
      sourceManifestSha256: sha256(stockfishManifestBytes),
      provisionReceiptSha256: sha256(provisionBytes),
      releaseCommit: stockfishManifest.releaseCommit,
      executableSha256: sha256(executableBytes),
      nnueSha256: networkHashes.sort(),
    },
    scidManifest,
    scidProvision,
    scid: {
      sourceManifestSha256: sha256(scidManifestBytes),
      provisionReceiptSha256: sha256(scidProvisionBytes),
      repositoryCommit: scidManifest.repositoryCommit,
      oracleSha256: sha256(oracleBytes),
    },
  }
}

import { createPublicKey, verify } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import {
  sha256Bytes,
  sha256File,
} from '../../security/lib/files.ts'
import {
  ProductionAppSnapshotManifestSchema,
  ProductionDataReadinessSchema,
} from './production-data-readiness.ts'
import { validateSourceSnapshot } from './source-snapshot.ts'
import {
  resolveWorkspaceEvidencePath,
  type GateConfig,
  type GateResult,
} from './evidence-integrity.ts'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const ReleaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u)
const WorkspacePathSchema = z.string().min(1).refine(
  (path) => !/^[A-Za-z]:/u.test(path)
    && !/^[\\/]/u.test(path)
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path),
  'Path must be workspace-relative and may not contain parent traversal',
)

export const FileBindingSchema = z.object({
  path: WorkspacePathSchema,
  bytes: z.number().int().positive(),
  sha256: Sha256Schema,
}).strict()

export const SourceSnapshotBindingSchema = FileBindingSchema.extend({
  treeSha256: Sha256Schema,
}).strict()

export const ReleaseDataBindingSchema = FileBindingSchema.extend({
  releaseId: ReleaseIdSchema,
}).strict()

export const SigningAttestationBindingSchema = z.object({
  path: WorkspacePathSchema,
  sha256: Sha256Schema,
  payloadSha256: Sha256Schema,
  keyId: z.string().min(1),
}).strict()

export const ReleaseBindingsSchema = z.object({
  gateConfig: FileBindingSchema,
  sourceSnapshot: SourceSnapshotBindingSchema,
  productionReadiness: ReleaseDataBindingSchema,
  appSnapshotManifest: ReleaseDataBindingSchema,
  releaseId: ReleaseIdSchema,
  automatedGateStatusSha256: Sha256Schema,
  preSigningEvidenceBundleSha256: Sha256Schema,
  evidenceBundleSha256: Sha256Schema,
  signingAttestation: SigningAttestationBindingSchema,
}).strict()

export type ReleaseBindings = z.infer<typeof ReleaseBindingsSchema>

export const ReleaseAttestationPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: ReleaseIdSchema,
  candidate: z.object({
    bytes: z.number().int().positive().max(10 * 1024 * 1024),
    sha256: Sha256Schema,
  }).strict(),
  gateConfigSha256: Sha256Schema,
  sourceSnapshotSha256: Sha256Schema,
  sourceTreeSha256: Sha256Schema,
  productionReadinessSha256: Sha256Schema,
  appSnapshotManifestSha256: Sha256Schema,
  automatedGateStatusSha256: Sha256Schema,
  preSigningEvidenceBundleSha256: Sha256Schema,
}).strict()

export const ReleaseAttestationSchema = z.object({
  schemaVersion: z.literal(1),
  algorithm: z.literal('ed25519'),
  keyId: z.string().min(1),
  payload: ReleaseAttestationPayloadSchema,
  signatureBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u),
}).strict()

export const TrustedSigningKeysSchema = z.object({
  schemaVersion: z.literal(1),
  keys: z.array(z.object({
    keyId: z.string().min(1),
    algorithm: z.literal('ed25519'),
    publicKeySpkiBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u),
    status: z.literal('active'),
  }).strict()).max(16),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>()
  for (const [index, key] of value.keys.entries()) {
    if (ids.has(key.keyId)) {
      context.addIssue({ code: 'custom', path: ['keys', index, 'keyId'], message: 'Duplicate signing key ID' })
    }
    ids.add(key.keyId)
  }
})

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function evidenceDigestPayload(gates: readonly GateResult[]): unknown {
  return gates.map((gate) => ({
    id: gate.id,
    status: gate.status,
    evidenceRecord: gate.evidenceRecord ?? null,
    evidenceReceipts: gate.evidenceReceipts ?? [],
    sourceSnapshot: gate.sourceSnapshot ?? null,
  }))
}

export function evidenceBundleSha256(gates: readonly GateResult[]): string {
  return sha256Bytes(canonicalJson(evidenceDigestPayload(gates)))
}

export function automatedGateStatusSha256(gates: readonly GateResult[]): string {
  return sha256Bytes(canonicalJson(gates.map(({ id, status }) => ({ id, status }))))
}

async function fileBinding(root: string, path: string) {
  const absolute = resolveWorkspaceEvidencePath(root, path)
  const details = await stat(absolute)
  if (!details.isFile()) throw new Error(`Release binding is not a regular file: ${path}`)
  return { path, bytes: details.size, sha256: await sha256File(absolute) }
}

export async function loadUnsignedReleaseBindings(options: {
  root: string
  configPath: string
  config: GateConfig
  automated: readonly GateResult[]
  evidence: readonly GateResult[]
  candidate: { bytes: number; sha256: string }
  sourceRoots?: readonly string[]
}): Promise<{
  gateConfig: z.infer<typeof FileBindingSchema>
  sourceSnapshot: z.infer<typeof SourceSnapshotBindingSchema>
  productionReadiness: z.infer<typeof ReleaseDataBindingSchema>
  appSnapshotManifest: z.infer<typeof ReleaseDataBindingSchema>
  releaseId: string
  automatedGateStatusSha256: string
  preSigningEvidenceBundleSha256: string
  evidenceBundleSha256: string
  expectedAttestationPayload: z.infer<typeof ReleaseAttestationPayloadSchema>
}> {
  const gateConfig = await fileBinding(options.root, options.configPath)
  const sourceFile = await fileBinding(options.root, options.config.releaseBindings.sourceSnapshot)
  const sourceManifest = await validateSourceSnapshot(
    resolveWorkspaceEvidencePath(options.root, options.config.releaseBindings.sourceSnapshot),
    options.root,
    options.sourceRoots,
  )
  const productionReadinessFile = await fileBinding(options.root, options.config.releaseBindings.productionReadiness)
  const appSnapshotManifestFile = await fileBinding(options.root, options.config.releaseBindings.appSnapshotManifest)
  const productionReadiness = ProductionDataReadinessSchema.parse(JSON.parse(await readFile(
    resolveWorkspaceEvidencePath(options.root, options.config.releaseBindings.productionReadiness),
    'utf8',
  )) as unknown)
  const appSnapshotManifest = ProductionAppSnapshotManifestSchema.parse(JSON.parse(await readFile(
    resolveWorkspaceEvidencePath(options.root, options.config.releaseBindings.appSnapshotManifest),
    'utf8',
  )) as unknown)
  if (productionReadiness.releaseId !== appSnapshotManifest.releaseId) {
    throw new Error('Production readiness and app snapshot release IDs differ')
  }
  if (productionReadiness.appSnapshotManifestSha256 !== appSnapshotManifestFile.sha256) {
    throw new Error('Production readiness does not bind the current app snapshot manifest')
  }
  const preSigningGates = options.evidence.filter((gate) => gate.id !== options.config.signing.evidenceId)
  const automatedDigest = automatedGateStatusSha256(options.automated)
  const preSigningDigest = evidenceBundleSha256(preSigningGates)
  const fullEvidenceDigest = evidenceBundleSha256(options.evidence)
  const sourceSnapshot = { ...sourceFile, treeSha256: sourceManifest.treeSha256 }
  const readinessBinding = { ...productionReadinessFile, releaseId: productionReadiness.releaseId }
  const appBinding = { ...appSnapshotManifestFile, releaseId: appSnapshotManifest.releaseId }
  const expectedAttestationPayload = ReleaseAttestationPayloadSchema.parse({
    schemaVersion: 1,
    releaseId: productionReadiness.releaseId,
    candidate: options.candidate,
    gateConfigSha256: gateConfig.sha256,
    sourceSnapshotSha256: sourceSnapshot.sha256,
    sourceTreeSha256: sourceSnapshot.treeSha256,
    productionReadinessSha256: readinessBinding.sha256,
    appSnapshotManifestSha256: appBinding.sha256,
    automatedGateStatusSha256: automatedDigest,
    preSigningEvidenceBundleSha256: preSigningDigest,
  })
  return {
    gateConfig,
    sourceSnapshot,
    productionReadiness: readinessBinding,
    appSnapshotManifest: appBinding,
    releaseId: productionReadiness.releaseId,
    automatedGateStatusSha256: automatedDigest,
    preSigningEvidenceBundleSha256: preSigningDigest,
    evidenceBundleSha256: fullEvidenceDigest,
    expectedAttestationPayload,
  }
}

export async function verifyReleaseAttestation(options: {
  root: string
  config: GateConfig
  signingGate: GateResult
  expectedPayload: z.infer<typeof ReleaseAttestationPayloadSchema>
}): Promise<z.infer<typeof SigningAttestationBindingSchema>> {
  if (options.signingGate.status !== 'pass') throw new Error('Release-signing evidence is not pass')
  const matches = (options.signingGate.evidenceReceipts ?? []).filter(
    (receipt) => receipt.sourcePath === options.config.signing.attestationSourcePath,
  )
  if (matches.length !== 1) {
    throw new Error('Release-signing evidence must contain exactly one receipt for the configured attestation source')
  }
  const receipt = matches[0]!
  const attestationPath = resolveWorkspaceEvidencePath(options.root, receipt.path)
  if (await sha256File(attestationPath) !== receipt.sha256) throw new Error('Release attestation receipt digest mismatch')
  const attestation = ReleaseAttestationSchema.parse(JSON.parse(await readFile(attestationPath, 'utf8')) as unknown)
  if (canonicalJson(attestation.payload) !== canonicalJson(options.expectedPayload)) {
    throw new Error('Signed release attestation does not bind the current immutable release inputs')
  }
  const trustedKeys = TrustedSigningKeysSchema.parse(JSON.parse(await readFile(
    resolveWorkspaceEvidencePath(options.root, options.config.signing.trustedKeys),
    'utf8',
  )) as unknown)
  const trustedKey = trustedKeys.keys.find((key) => key.keyId === attestation.keyId)
  if (!trustedKey) throw new Error(`Release attestation key is not trusted: ${attestation.keyId}`)
  const publicKey = createPublicKey({
    key: Buffer.from(trustedKey.publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki',
  })
  const payloadBytes = Buffer.from(canonicalJson(attestation.payload), 'utf8')
  if (!verify(null, payloadBytes, publicKey, Buffer.from(attestation.signatureBase64, 'base64'))) {
    throw new Error('Release attestation signature is invalid')
  }
  return SigningAttestationBindingSchema.parse({
    path: receipt.path,
    sha256: receipt.sha256,
    payloadSha256: sha256Bytes(payloadBytes),
    keyId: attestation.keyId,
  })
}

export async function loadVerifiedReleaseBindings(options: Parameters<typeof loadUnsignedReleaseBindings>[0]): Promise<ReleaseBindings> {
  const unsigned = await loadUnsignedReleaseBindings(options)
  const signingGate = options.evidence.find((gate) => gate.id === options.config.signing.evidenceId)
  if (!signingGate) throw new Error('Configured release-signing evidence result is missing')
  const signingAttestation = await verifyReleaseAttestation({
    root: options.root,
    config: options.config,
    signingGate,
    expectedPayload: unsigned.expectedAttestationPayload,
  })
  return ReleaseBindingsSchema.parse({
    gateConfig: unsigned.gateConfig,
    sourceSnapshot: unsigned.sourceSnapshot,
    productionReadiness: unsigned.productionReadiness,
    appSnapshotManifest: unsigned.appSnapshotManifest,
    releaseId: unsigned.releaseId,
    automatedGateStatusSha256: unsigned.automatedGateStatusSha256,
    preSigningEvidenceBundleSha256: unsigned.preSigningEvidenceBundleSha256,
    evidenceBundleSha256: unsigned.evidenceBundleSha256,
    signingAttestation,
  })
}

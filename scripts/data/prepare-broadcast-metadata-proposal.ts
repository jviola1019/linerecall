#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertBroadcastManifest,
  assertBroadcastManifestApproved,
  type BroadcastManifestV1,
} from './broadcast-contracts.ts'
import { PendingBroadcastMetadataInventorySchema } from './observe-broadcast-metadata.ts'
import { createSourceSnapshot } from '../release/lib/source-snapshot.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const MAXIMUM_MANIFEST_BYTES = 2 * 1024 * 1024
const MAXIMUM_OBSERVATION_BYTES = 8 * 1024 * 1024

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function decodeJson(bytes: Uint8Array, label: string): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('NUL')
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${label} is not bounded UTF-8 JSON`)
  }
}

export interface PrepareBroadcastMetadataProposalOptions {
  sourceManifestBytes: Uint8Array
  observationBytes: Uint8Array
  sourceSnapshotSha256: string
}

/**
 * Create a deterministic, pending-only manifest proposal. This function never
 * mutates the approved source manifest and cannot create an approval decision.
 */
export function prepareBroadcastMetadataProposal(
  options: PrepareBroadcastMetadataProposalOptions,
): BroadcastManifestV1 {
  if (!SHA256.test(options.sourceSnapshotSha256)) {
    throw new Error('Source snapshot must be a lowercase SHA-256 digest')
  }
  if (
    options.sourceManifestBytes.byteLength < 1 ||
    options.sourceManifestBytes.byteLength > MAXIMUM_MANIFEST_BYTES
  ) {
    throw new Error('Broadcast source manifest is outside the bounded input limit')
  }
  if (
    options.observationBytes.byteLength < 1 ||
    options.observationBytes.byteLength > MAXIMUM_OBSERVATION_BYTES
  ) {
    throw new Error('Broadcast metadata observation is outside the bounded input limit')
  }

  const sourceValue = decodeJson(options.sourceManifestBytes, 'Broadcast source manifest')
  assertBroadcastManifestApproved(sourceValue)
  if (
    sourceValue.metadataObservation !== undefined ||
    sourceValue.archives.some((archive) =>
      archive.bytes !== undefined ||
      archive.etagObserved !== undefined ||
      archive.lastModifiedObserved !== undefined)
  ) {
    throw new Error('Broadcast source manifest already contains transport metadata; a new review cycle is required')
  }

  const observation = PendingBroadcastMetadataInventorySchema.parse(
    decodeJson(options.observationBytes, 'Broadcast metadata observation'),
  )
  const sourceManifestSha256 = sha256(options.sourceManifestBytes)
  if (observation.sourceManifestSha256 !== sourceManifestSha256) {
    throw new Error('Broadcast metadata observation belongs to different source manifest bytes')
  }
  if (
    observation.sourceSnapshotSha256 !== options.sourceSnapshotSha256 ||
    observation.archives.some(({ localVerification }) => localVerification.status !== 'verified')
  ) {
    throw new Error('Broadcast metadata proposal requires the matching source snapshot and all 78 locally verified archives')
  }

  const observationByMonth = new Map(observation.archives.map((archive) => [archive.month, archive]))
  const proposal: BroadcastManifestV1 = {
    ...sourceValue,
    approval: {
      status: 'pending',
      approvedOn: null,
      scope: 'Pending review. This proposal does not authorize compact-v3 ingestion, benchmark promotion, or release use.',
      basis: `Pending manual review of broadcast transport metadata observation SHA-256 ${sha256(options.observationBytes)}.`,
      reviewRequiredWhen: 'Before first compact-v3 use and whenever an archive URL, checksum, byte length, response identity, source snapshot, license, filter, or cutoff changes.',
    },
    metadataObservation: {
      schemaVersion: 1,
      kind: 'linerecall-broadcast-metadata-observation-ref',
      receiptSha256: sha256(options.observationBytes),
      sourceManifestSha256,
      sourceSnapshotSha256: options.sourceSnapshotSha256,
      observedAt: observation.observedAt,
      archiveCount: observation.archiveCount,
      localArchivesVerified: true,
    },
    archives: sourceValue.archives.map((archive) => {
      const observed = observationByMonth.get(archive.month)
      if (!observed) throw new Error(`Broadcast metadata observation is missing ${archive.month}`)
      if (
        observed.filename !== archive.filename ||
        observed.approvedUrl !== archive.url ||
        observed.approvedSha256 !== archive.sha256 ||
        observed.localVerification.status !== 'verified'
      ) {
        throw new Error(`Broadcast metadata observation differs from the approved identity for ${archive.month}`)
      }
      return {
        ...archive,
        bytes: observed.observation.contentLength,
        etagObserved: observed.observation.etagObserved,
        lastModifiedObserved: observed.observation.lastModifiedObserved,
      }
    }),
  }
  assertBroadcastManifest(proposal)
  return proposal
}

interface CliArguments {
  manifestPath: string
  observationPath: string
  outputPath: string
  sourceSnapshotSha256: string
}

function cliArguments(argv: readonly string[]): CliArguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid option near ${name ?? '<end>'}`)
    }
    const key = name.slice(2)
    if (values.has(key)) throw new Error(`Duplicate option ${name}`)
    values.set(key, value)
  }
  const required = ['manifest', 'observation', 'output', 'source-snapshot-sha256'] as const
  for (const key of required) if (!values.get(key)) throw new Error(`Missing --${key}`)
  if (values.size !== required.length) throw new Error('Unknown broadcast metadata proposal option')
  return {
    manifestPath: resolve(values.get('manifest')!),
    observationPath: resolve(values.get('observation')!),
    outputPath: resolve(values.get('output')!),
    sourceSnapshotSha256: values.get('source-snapshot-sha256')!,
  }
}

async function readBounded(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) {
      throw new Error(`${label} is outside the bounded input limit`)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (after.size !== before.size || bytes.byteLength !== before.size) {
      throw new Error(`${label} changed while being read`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function main(): Promise<void> {
  const args = cliArguments(process.argv.slice(2))
  const currentSnapshot = await createSourceSnapshot()
  if (currentSnapshot.treeSha256 !== args.sourceSnapshotSha256) {
    throw new Error(`Source snapshot is stale; current tree SHA-256 is ${currentSnapshot.treeSha256}`)
  }
  const proposal = prepareBroadcastMetadataProposal({
    sourceManifestBytes: await readBounded(args.manifestPath, MAXIMUM_MANIFEST_BYTES, 'Broadcast source manifest'),
    observationBytes: await readBounded(args.observationPath, MAXIMUM_OBSERVATION_BYTES, 'Broadcast metadata observation'),
    sourceSnapshotSha256: args.sourceSnapshotSha256,
  })
  const bytes = canonicalBytes(proposal)
  const output = await open(args.outputPath, 'wx', 0o600)
  try {
    await output.writeFile(bytes)
    await output.sync()
  } finally {
    await output.close()
  }
  process.stdout.write(`${JSON.stringify({
    result: 'pending-broadcast-manifest-proposal',
    output: args.outputPath,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    archiveCount: proposal.archives.length,
    approvalStatus: proposal.approval.status,
    releaseEligible: false,
  }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Broadcast metadata proposal failed: ${(error as Error).message}\n`)
    process.exitCode = 1
  })
}

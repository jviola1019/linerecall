import { isDeepStrictEqual } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { EmbeddedProductionSnapshotPayloadV3Schema } from '../../src/data/embedded-contract.ts'
import { ProductionWireAppManifestV3Schema } from '../../src/data/production-wire.ts'
import { WireAppManifestSchema } from '../../src/data/wire.ts'
import { readHandleBoundRegularFile } from '../lib/handle-bound-file.ts'
import {
  attribute,
  elementsNamed,
  parseHtmlSource,
  rawTextContent,
} from '../security/lib/html-source.ts'
import { isExecutedDirectly, option, sha256Bytes } from '../security/lib/files.ts'
import { finishReport, makeReport, type CheckResult } from '../security/lib/report.ts'
import {
  ProductionDataReadinessSchema,
  evaluateProductionDataReadiness,
} from './lib/production-data-readiness.ts'

const MAX_CANDIDATE_BYTES = 10 * 1024 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_READINESS_BYTES = 2 * 1024 * 1024
const MAX_BROWSE_MANIFEST_BYTES = 2 * 1024 * 1024

function strictJson(bytes: Uint8Array, label: string): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.includes('\0')) throw new Error(`${label} contains a NUL character`)
  return JSON.parse(text) as unknown
}

function sameKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left).sort((a, b) => a.localeCompare(b, 'en'))
  const rightKeys = Object.keys(right).sort((a, b) => a.localeCompare(b, 'en'))
  return isDeepStrictEqual(leftKeys, rightKeys)
}

function verifyEmbeddedBlob(
  label: string,
  blob: { base64: string; compressedBytes: number; uncompressedBytes: number; sha256: string },
  receipt: { compressedBytes: number; uncompressedBytes: number; sha256: string },
  findings: Array<Record<string, unknown>>,
): void {
  const stored = Buffer.from(blob.base64, 'base64')
  if (stored.toString('base64') !== blob.base64) {
    findings.push({ rule: 'embedded-blob-base64-noncanonical', label })
  }
  const actualSha256 = sha256Bytes(stored)
  if (
    stored.byteLength !== blob.compressedBytes
    || blob.compressedBytes !== receipt.compressedBytes
    || blob.uncompressedBytes !== receipt.uncompressedBytes
    || blob.sha256 !== receipt.sha256
    || actualSha256 !== receipt.sha256
  ) {
    findings.push({
      rule: 'embedded-blob-receipt-mismatch',
      label,
      actualBytes: stored.byteLength,
      embeddedBytes: blob.compressedBytes,
      expectedBytes: receipt.compressedBytes,
      actualSha256,
      embeddedSha256: blob.sha256,
      expectedSha256: receipt.sha256,
    })
  }
  try {
    const decoded = gunzipSync(stored, { maxOutputLength: receipt.uncompressedBytes })
    if (decoded.byteLength !== receipt.uncompressedBytes) {
      findings.push({
        rule: 'embedded-blob-uncompressed-size-mismatch',
        label,
        actualBytes: decoded.byteLength,
        expectedBytes: receipt.uncompressedBytes,
      })
    }
  } catch (error) {
    findings.push({
      rule: 'embedded-blob-gzip-invalid-or-over-limit',
      label,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function auditProductionCandidateBinding(options: {
  candidatePath: string
  appManifestPath: string
  browseManifestPath: string
  readinessPath: string
}): Promise<CheckResult> {
  const findings: Array<Record<string, unknown>> = []
  try {
    const [candidateBytes, appManifestBytes, browseManifestBytes, readinessBytes] = await Promise.all([
      readHandleBoundRegularFile(options.candidatePath, 'Production candidate', MAX_CANDIDATE_BYTES),
      readHandleBoundRegularFile(options.appManifestPath, 'Production app manifest', MAX_MANIFEST_BYTES),
      readHandleBoundRegularFile(options.browseManifestPath, 'Production browse manifest', MAX_BROWSE_MANIFEST_BYTES),
      readHandleBoundRegularFile(options.readinessPath, 'Production readiness', MAX_READINESS_BYTES),
    ])
    const candidateText = new TextDecoder('utf-8', { fatal: true }).decode(candidateBytes)
    const parsed = parseHtmlSource(candidateText)
    const snapshotScripts = elementsNamed(parsed, 'script')
      .filter((script) => attribute(script, 'id') === 'linerecall-embedded-snapshot')
    if (snapshotScripts.length !== 1) {
      throw new Error(`Expected one embedded production snapshot, found ${snapshotScripts.length}`)
    }
    const snapshotScript = snapshotScripts[0]!
    if (attribute(snapshotScript, 'type')?.trim().toLowerCase() !== 'application/json') {
      throw new Error('Embedded production snapshot is not an inert JSON script')
    }
    const payload = EmbeddedProductionSnapshotPayloadV3Schema.parse(
      JSON.parse(rawTextContent(parsed, snapshotScript).content) as unknown,
    )
    const appManifestValue = strictJson(appManifestBytes, 'Production app manifest')
    const browseManifestValue = strictJson(browseManifestBytes, 'Production browse manifest')
    const readinessValue = strictJson(readinessBytes, 'Production readiness')
    const appManifest = ProductionWireAppManifestV3Schema.parse(appManifestValue)
    const browseManifest = WireAppManifestSchema.parse(browseManifestValue)
    const readiness = ProductionDataReadinessSchema.parse(readinessValue)
    const appManifestSha256 = sha256Bytes(appManifestBytes)
    const browseManifestSha256 = sha256Bytes(browseManifestBytes)

    findings.push(...evaluateProductionDataReadiness(
      readinessValue,
      appManifestValue,
      appManifestSha256,
    ))
    if (payload.appManifestSha256 !== appManifestSha256) {
      findings.push({
        rule: 'candidate-app-manifest-digest-mismatch',
        expected: appManifestSha256,
        actual: payload.appManifestSha256,
      })
    }
    if (
      appManifest.browseManifestSha256 !== browseManifestSha256
      || !isDeepStrictEqual(appManifest.browse, browseManifest)
    ) {
      findings.push({
        rule: 'candidate-browse-manifest-binding-mismatch',
        expected: browseManifestSha256,
        actual: appManifest.browseManifestSha256,
      })
    }
    if (
      payload.releaseId !== readiness.releaseId
      || payload.releaseId !== appManifest.releaseId
      || payload.generatedAt !== appManifest.g
      || payload.familyPromotionIndexSha256 !== appManifest.familyPromotionIndexSha256
      || !isDeepStrictEqual(payload.selectionPolicy, appManifest.selectionPolicy)
      || !isDeepStrictEqual(payload.puzzlePromotion, appManifest.puzzlePromotion)
      || !isDeepStrictEqual(payload.familyCatalogRef, appManifest.familyCatalogRef)
    ) {
      findings.push({ rule: 'candidate-production-root-mismatch' })
    }

    const base = payload.base
    const browse = appManifest.browse
    if (
      base.generatedAt !== browse.g
      || !sameKeys(base.shards, browse.shards)
      || !sameKeys(base.partitions, browse.partitions)
    ) findings.push({ rule: 'candidate-browse-inventory-mismatch' })
    verifyEmbeddedBlob('browse:search', base.blobs.search, browse.blobs.search, findings)
    verifyEmbeddedBlob('browse:audit', base.blobs.audit, browse.blobs.audit, findings)
    for (const [id, receipt] of Object.entries(browse.shards)) {
      const blob = base.shards[id]
      if (blob) verifyEmbeddedBlob(`browse:shard:${id}`, blob, receipt, findings)
    }
    for (const [eco, receipt] of Object.entries(browse.partitions)) {
      const blob = base.partitions[eco]
      if (blob) verifyEmbeddedBlob(`browse:partition:${eco}`, blob, receipt, findings)
    }

    if (!sameKeys(payload.familyResources, appManifest.familyResources)) {
      findings.push({ rule: 'candidate-family-resource-inventory-mismatch' })
    }
    for (const [id, receipt] of Object.entries(appManifest.familyResources)) {
      const resource = payload.familyResources[id]
      if (!resource) continue
      if (!isDeepStrictEqual(resource.reference, receipt)) {
        findings.push({ rule: 'candidate-family-reference-mismatch', id })
      }
      verifyEmbeddedBlob(`family:${id}`, resource.blob, receipt, findings)
    }

    return {
      id: 'production-candidate-binding',
      status: findings.length === 0 ? 'pass' : 'fail',
      summary: findings.length === 0
        ? 'Candidate embeds the exact production v3 manifest and every content-addressed resource'
        : `${findings.length} production candidate binding finding(s)`,
      findings,
      metrics: {
        candidateBytes: candidateBytes.byteLength,
        candidateSha256: sha256Bytes(candidateBytes),
        appManifestSha256,
        browseManifestSha256,
        readinessSha256: sha256Bytes(readinessBytes),
        familyResources: Object.keys(payload.familyResources).length,
      },
    }
  } catch (error) {
    return {
      id: 'production-candidate-binding',
      status: 'fail',
      summary: 'Candidate is not bound to a valid production v3 snapshot',
      findings: [{
        rule: 'production-candidate-binding-invalid',
        error: error instanceof Error ? error.message : String(error),
      }],
    }
  }
}

if (isExecutedDirectly(import.meta.url)) {
  const output = option('--output', 'audit/generated/production-candidate-binding.json')
  const result = await auditProductionCandidateBinding({
    candidatePath: option('--candidate', 'build/candidate/linerecall.html'),
    appManifestPath: option('--app-manifest', 'data/generated/v3/app-snapshot-manifest.json'),
    browseManifestPath: option('--browse-manifest', 'data/generated/app-snapshot/manifest.json'),
    readinessPath: option('--readiness', 'data/generated/v3/production-data-readiness.json'),
  })
  await finishReport(output, makeReport('production-candidate-binding', [result]))
}

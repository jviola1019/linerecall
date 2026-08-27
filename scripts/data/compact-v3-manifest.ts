import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import {
  BROADCAST_PUBLISHED_GAME_TOTAL,
  assertBroadcastManifestApproved,
  type BroadcastManifestV1,
} from './broadcast-contracts.ts'
import { LichessStandardManifestSchema, type LichessStandardManifest } from './evidence-contracts.ts'
import {
  CompactSourceArchiveSchema,
  type CompactSourceArchive,
} from './compact-v3-contracts.ts'

export interface ApprovedCompactArchiveIdentity {
  month: string
  filename: string
  url: string
  sha256: string
  compressedBytes: number | null
  etagObserved: string | null
  lastModifiedObserved: string | null
  publishedGames: number | null
}

export interface ApprovedCompactCorpus {
  sourceId: CompactSourceArchive['sourceId']
  sourceManifestSha256: string
  licenseSpdxId: CompactSourceArchive['licenseSpdxId']
  cutoff: string
  publishedGameTotal: number
  archives: ApprovedCompactArchiveIdentity[]
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function lastDayOfMonth(month: string): string {
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const monthNumber = Number(monthText)
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return `${month}-${String(day).padStart(2, '0')}`
}

/**
 * Parse the exact approved manifest bytes used by a run. This function has no
 * network path: the caller must supply a local, reviewed manifest.
 */
export function approvedCompactCorpusFromBytes(
  bytes: Uint8Array,
  sourceId: CompactSourceArchive['sourceId'],
): ApprovedCompactCorpus {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error('Approved source manifest is not valid UTF-8 JSON')
  }
  const sourceManifestSha256 = sha256(bytes)
  if (sourceId === 'lichess-broadcasts') {
    assertBroadcastManifestApproved(value)
    const manifest: BroadcastManifestV1 = value
    return {
      sourceId,
      sourceManifestSha256,
      licenseSpdxId: 'CC-BY-SA-4.0',
      cutoff: lastDayOfMonth(manifest.cutoffMonth),
      publishedGameTotal: BROADCAST_PUBLISHED_GAME_TOTAL,
      archives: manifest.archives.map((archive) => ({
        month: archive.month,
        filename: archive.filename,
        url: archive.url,
        sha256: archive.sha256,
        compressedBytes: archive.bytes ?? null,
        etagObserved: archive.etagObserved ?? null,
        lastModifiedObserved: archive.lastModifiedObserved ?? null,
        publishedGames: null,
      })),
    }
  }
  const manifest: LichessStandardManifest = LichessStandardManifestSchema.parse(value)
  return {
    sourceId,
    sourceManifestSha256,
    licenseSpdxId: manifest.license.spdxId,
    cutoff: manifest.source.cutoff,
    publishedGameTotal: manifest.source.publishedGameTotal,
    archives: manifest.archives.map((archive) => ({
      month: archive.month,
      filename: archive.filename,
      url: archive.url,
      sha256: archive.sha256,
      compressedBytes: archive.bytes,
      etagObserved: archive.etagObserved,
      lastModifiedObserved: archive.lastModifiedObserved,
      publishedGames: archive.games,
    })),
  }
}

export function approvedArchiveIndex(
  corpus: ApprovedCompactCorpus,
  archive: CompactSourceArchive,
): number {
  const parsed = CompactSourceArchiveSchema.parse(archive)
  if (
    parsed.sourceId !== corpus.sourceId ||
    parsed.sourceManifestSha256 !== corpus.sourceManifestSha256 ||
    parsed.licenseSpdxId !== corpus.licenseSpdxId ||
    parsed.cutoff !== corpus.cutoff
  ) {
    throw new Error('Compact plan provenance does not match the exact approved manifest bytes')
  }
  const index = corpus.archives.findIndex((candidate) => candidate.month === parsed.month)
  const approved = corpus.archives[index]
  if (
    index < 0 || !approved ||
    parsed.filename !== approved.filename ||
    parsed.url !== approved.url ||
    parsed.sha256 !== approved.sha256 ||
    (approved.compressedBytes !== null && parsed.compressedBytes !== approved.compressedBytes) ||
    (approved.etagObserved !== null && parsed.etagObserved !== approved.etagObserved) ||
    (approved.lastModifiedObserved !== null && parsed.lastModifiedObserved !== approved.lastModifiedObserved)
  ) {
    throw new Error(`Compact plan archive ${parsed.archiveId} is not the approved manifest entry for ${parsed.month}`)
  }
  const expectedArchiveId = parsed.sourceId === 'lichess-broadcasts'
    ? `broadcast-${parsed.month}`
    : `standard-${parsed.month}`
  if (parsed.archiveId !== expectedArchiveId) {
    throw new Error(`Compact archive ID must be ${expectedArchiveId}`)
  }
  if (basename(parsed.filename) !== parsed.filename) {
    throw new Error('Compact archive filename must not contain a path')
  }
  return index
}

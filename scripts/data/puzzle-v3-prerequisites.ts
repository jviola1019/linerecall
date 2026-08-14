import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { z } from 'zod'
import { FamilyIdSchema, FamilyReleaseIdSchema, TaxonomyLineIdSchema } from '../../src/domain/opening-family.ts'
import { StockfishManifestSchema } from '../verification/lib/manifest.ts'
import { auditCompactV3Foundation } from './audit-data-foundation.ts'
import { CompactArchiveCheckpointSchema } from './compact-v3-contracts.ts'
import { receiptDigest } from './compact-v3-foundation.ts'
import { approvedCompactCorpusFromBytes, type ApprovedCompactCorpus } from './compact-v3-manifest.ts'
import { openValidatedRegularFile, readBoundedRegularFile } from './compact-v3-orchestrator.ts'
import type { PuzzleAssociationIndex } from './puzzle-contracts.ts'
import {
  PuzzleEngineCampaignV1Schema,
  PuzzleFamilyAssociationManifestV1Schema,
  PuzzleV3EvidenceBindingV1Schema,
  sha256Json,
  type PuzzleCompactCorpusBindingV1,
  type PuzzleEngineCampaignV1,
  type PuzzleFamilyAssociationManifestV1,
  type PuzzleV3EvidenceBindingV1,
} from './puzzle-v3-contracts.ts'
import type { PuzzleSourceBinding } from './puzzle-contracts.ts'

const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_ASSOCIATION_DATABASE_BYTES = 256 * 1024 * 1024 * 1024

const ProvisionReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  releaseTag: z.literal('sf_18'),
  releaseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  executable: z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).passthrough(),
}).passthrough()

type PuzzleAssociation = {
  confidence: 'exact-position' | 'opening-family' | 'unlinked'
  positionEpd: string
  taxonomyLineId: string | null
  openingTag: string | null
}

export interface V3PuzzleAssociationIndex extends PuzzleAssociationIndex {
  familyIdsForAssociation(association: PuzzleAssociation): readonly string[]
  close(): void
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function safeExistingFile(root: string, requested: string): Promise<string> {
  const rootReal = await realpath(resolve(root))
  const pathReal = await realpath(resolve(rootReal, requested))
  if (!isInside(rootReal, pathReal)) throw new Error('Puzzle prerequisite path escapes the repository root')
  return pathReal
}

async function readExactValidatedFile(options: {
  root: string
  path: string
  bytes: number
  sha256: string
  label: string
  maximumBytes: number
}): Promise<Buffer> {
  const path = await safeExistingFile(options.root, options.path)
  const file = await openValidatedRegularFile(path, {
    label: options.label,
    minimumBytes: options.bytes,
    maximumBytes: Math.min(options.maximumBytes, options.bytes),
    exactBytes: options.bytes,
  })
  try {
    const retained = options.bytes <= MAX_JSON_BYTES ? Buffer.alloc(options.bytes) : null
    const chunk = Buffer.alloc(Math.min(1024 * 1024, options.bytes))
    let offset = 0
    const digest = createHash('sha256')
    while (offset < options.bytes) {
      const requested = Math.min(chunk.byteLength, options.bytes - offset)
      const read = await file.handle.read(chunk, 0, requested, offset)
      if (read.bytesRead < 1) throw new Error(`${options.label} changed while it was read`)
      const value = chunk.subarray(0, read.bytesRead)
      digest.update(value)
      retained?.set(value, offset)
      offset += read.bytesRead
    }
    if (await file.changed()) throw new Error(`${options.label} changed while it was read`)
    if (digest.digest('hex') !== options.sha256) throw new Error(`${options.label} SHA-256 does not match its receipt`)
    return retained ?? Buffer.alloc(0)
  } finally {
    await file.close()
  }
}

async function readBoundedJson(path: string, label: string): Promise<{ bytes: Buffer; value: unknown; sha256: string }> {
  const bytes = await readBoundedRegularFile(path, MAX_JSON_BYTES, label, 1)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.includes('\0')) throw new Error(`${label} contains a NUL character`)
  return {
    bytes,
    value: JSON.parse(text) as unknown,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function finalArchiveId(corpus: ApprovedCompactCorpus): string {
  const archive = corpus.archives.at(-1)
  if (!archive) throw new Error(`Approved ${corpus.sourceId} corpus has no archives`)
  return corpus.sourceId === 'lichess-broadcasts'
    ? `broadcast-${archive.month}`
    : `standard-${archive.month}`
}

async function finalExactReceipt(options: {
  workDirectory: string
  corpus: ApprovedCompactCorpus
  expectedStateSha256: string
}): Promise<{ receiptSha256: string; stateSha256: string }> {
  const archiveId = finalArchiveId(options.corpus)
  const path = join(resolve(options.workDirectory), 'v3', archiveId, 'checkpoint.json')
  const checkpoint = CompactArchiveCheckpointSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      await readBoundedRegularFile(path, MAX_JSON_BYTES, `${archiveId} compact checkpoint`, 1),
    )) as unknown,
  )
  const exact = checkpoint.exactReceipt
  if (!exact || exact.pass !== 'exact') throw new Error(`${archiveId} has no final exact receipt`)
  if (exact.output.sha256 !== options.expectedStateSha256) {
    throw new Error(`${archiveId} final exact state differs from the validated compact foundation`)
  }
  return { receiptSha256: receiptDigest(exact), stateSha256: exact.output.sha256 }
}

function compactCorpusBinding(
  corpus: {
    sourceId: string
    sourceManifestSha256: string
    sourceSnapshotSha256: string
    archiveCount: number
    recordsSeen: number
    accepted: number
    deduplicated: number
    rejected: number
    positions: number
    edges: number
    outcomes: number
    finalStateSha256: string
  },
  finalReceiptSha256: string,
): PuzzleCompactCorpusBindingV1 {
  return {
    sourceId: corpus.sourceId as PuzzleCompactCorpusBindingV1['sourceId'],
    sourceManifestSha256: corpus.sourceManifestSha256,
    sourceSnapshotSha256: corpus.sourceSnapshotSha256,
    archiveCount: corpus.archiveCount,
    recordsSeen: corpus.recordsSeen,
    accepted: corpus.accepted,
    deduplicated: corpus.deduplicated,
    rejected: corpus.rejected,
    finalExactReceiptSha256: finalReceiptSha256,
    finalExactStateSha256: corpus.finalStateSha256,
    positions: corpus.positions,
    edges: corpus.edges,
    outcomes: corpus.outcomes,
  }
}

function rows<T>(statement: StatementSync, ...parameters: SQLInputValue[]): T[] {
  return statement.all(...parameters) as unknown as T[]
}

function validateAssociationDatabase(
  database: DatabaseSync,
  manifest: PuzzleFamilyAssociationManifestV1,
): void {
  const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
  if (integrity.integrity_check !== 'ok') throw new Error('Puzzle family association database failed integrity_check')
  const metadataCount = database.prepare('SELECT count(*) AS count FROM puzzle_family_metadata').get() as { count: number }
  if (metadataCount.count !== 1) throw new Error('Puzzle family association database must have exactly one metadata row')
  const metadata = database.prepare(`
    SELECT schema_version AS schemaVersion, release_id AS releaseId, status,
           broadcast_final_exact_state_sha256 AS broadcastFinalExactStateSha256,
           broadcast_final_exact_receipt_sha256 AS broadcastFinalExactReceiptSha256,
           q2_final_exact_state_sha256 AS q2FinalExactStateSha256,
           q2_final_exact_receipt_sha256 AS q2FinalExactReceiptSha256,
           source_snapshot_sha256 AS sourceSnapshotSha256,
           family_catalog_sha256 AS familyCatalogSha256,
           graph_reconciliation_sha256 AS graphReconciliationSha256,
           exact_position_associations AS exactPositionAssociations,
           tag_associations AS tagAssociations
    FROM puzzle_family_metadata WHERE singleton = 1
  `).get() as Record<string, unknown> | undefined
  const expected = {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    status: 'complete',
    broadcastFinalExactStateSha256: manifest.compactEvidence.broadcastFinalExactStateSha256,
    broadcastFinalExactReceiptSha256: manifest.compactEvidence.broadcastFinalExactReceiptSha256,
    q2FinalExactStateSha256: manifest.compactEvidence.q2FinalExactStateSha256,
    q2FinalExactReceiptSha256: manifest.compactEvidence.q2FinalExactReceiptSha256,
    sourceSnapshotSha256: manifest.compactEvidence.sourceSnapshotSha256,
    familyCatalogSha256: manifest.familyEvidence.catalogSha256,
    graphReconciliationSha256: manifest.familyEvidence.graphReconciliationSha256,
    exactPositionAssociations: manifest.familyEvidence.exactPositionAssociations,
    tagAssociations: manifest.familyEvidence.tagAssociations,
  }
  if (!metadata || Object.entries(expected).some(([key, value]) => metadata[key] !== value)) {
    throw new Error('Puzzle family association metadata differs from its immutable manifest')
  }

  const exactCount = database.prepare('SELECT count(*) AS count FROM puzzle_family_positions').get() as { count: number }
  const tagCount = database.prepare('SELECT count(*) AS count FROM puzzle_family_tags').get() as { count: number }
  if (
    exactCount.count !== manifest.familyEvidence.exactPositionAssociations ||
    tagCount.count !== manifest.familyEvidence.tagAssociations
  ) throw new Error('Puzzle family association row counts differ from the manifest')
  const duplicateExact = database.prepare(`
    SELECT 1 AS found FROM puzzle_family_positions GROUP BY epd, family_id HAVING count(*) > 1 LIMIT 1
  `).get()
  const duplicateTag = database.prepare(`
    SELECT 1 AS found FROM puzzle_family_tags
    GROUP BY tag, taxonomy_line_id, family_id HAVING count(*) > 1 LIMIT 1
  `).get()
  if (duplicateExact || duplicateTag) throw new Error('Puzzle family association database contains duplicate ownership rows')
  const multiplyPrimaryTaxonomy = database.prepare(`
    SELECT 1 AS found FROM puzzle_family_tags
    GROUP BY taxonomy_line_id HAVING count(DISTINCT family_id) != 1 LIMIT 1
  `).get()
  if (multiplyPrimaryTaxonomy) {
    throw new Error('Puzzle tag fallback requires exactly one primary family per taxonomy row')
  }
  const invalidText = database.prepare(`
    SELECT
      (SELECT count(*) FROM puzzle_family_positions
       WHERE length(epd) < 7 OR length(epd) > 128
          OR length(epd) - length(replace(epd, ' ', '')) != 3) +
      (SELECT count(*) FROM puzzle_family_tags
       WHERE length(tag) < 1 OR length(tag) > 128
          OR tag GLOB '*[^A-Za-z0-9_-]*') AS count
  `).get() as { count: number }
  if (invalidText.count !== 0) throw new Error('Puzzle family association database contains invalid EPD or opening-tag text')

  const identifiers = rows<{ familyId: string }>(database.prepare(`
    SELECT family_id AS familyId FROM puzzle_family_positions
    UNION SELECT family_id AS familyId FROM puzzle_family_tags
  `))
  if (identifiers.length < 1 || identifiers.length > manifest.familyEvidence.familyCount) {
    throw new Error('Puzzle family association database has an invalid family inventory')
  }
  for (const { familyId } of identifiers) FamilyIdSchema.parse(familyId)
  const taxonomyIds = rows<{ taxonomyLineId: string }>(database.prepare(`
    SELECT DISTINCT taxonomy_line_id AS taxonomyLineId FROM puzzle_family_tags
  `))
  if (taxonomyIds.length !== manifest.familyEvidence.taxonomyLineCount) {
    throw new Error('Puzzle family tag associations do not cover every taxonomy row')
  }
  for (const { taxonomyLineId } of taxonomyIds) TaxonomyLineIdSchema.parse(taxonomyLineId)
}

class SqliteV3PuzzleAssociationIndex implements V3PuzzleAssociationIndex {
  readonly #database: DatabaseSync
  readonly #exact: StatementSync
  readonly #taxonomyForTag: StatementSync
  readonly #familiesForPosition: StatementSync
  readonly #familiesForTaxonomy: StatementSync

  constructor(path: string, manifest: PuzzleFamilyAssociationManifestV1) {
    this.#database = new DatabaseSync(path, { readOnly: true })
    try {
      this.#database.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON;')
      validateAssociationDatabase(this.#database, manifest)
      this.#exact = this.#database.prepare('SELECT 1 AS found FROM puzzle_family_positions WHERE epd = ? LIMIT 1')
      this.#taxonomyForTag = this.#database.prepare(`
        SELECT DISTINCT taxonomy_line_id AS taxonomyLineId FROM puzzle_family_tags WHERE tag = ? ORDER BY taxonomy_line_id
      `)
      this.#familiesForPosition = this.#database.prepare(`
        SELECT DISTINCT family_id AS familyId FROM puzzle_family_positions WHERE epd = ? ORDER BY family_id
      `)
      this.#familiesForTaxonomy = this.#database.prepare(`
        SELECT DISTINCT family_id AS familyId FROM puzzle_family_tags WHERE taxonomy_line_id = ? ORDER BY family_id
      `)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  hasExactPosition(epd: string): boolean {
    return this.#exact.get(epd) !== undefined
  }

  taxonomyLineIdsForTag(tag: string): readonly string[] {
    return rows<{ taxonomyLineId: string }>(this.#taxonomyForTag, tag).map(({ taxonomyLineId }) => taxonomyLineId)
  }

  familyIdsForAssociation(association: PuzzleAssociation): readonly string[] {
    if (association.confidence === 'exact-position') {
      return rows<{ familyId: string }>(this.#familiesForPosition, association.positionEpd).map(({ familyId }) => familyId)
    }
    if (association.confidence === 'opening-family' && association.taxonomyLineId) {
      return rows<{ familyId: string }>(this.#familiesForTaxonomy, association.taxonomyLineId).map(({ familyId }) => familyId)
    }
    return []
  }

  close(): void {
    this.#database.close()
  }
}

export async function openValidatedPuzzleFamilyAssociation(options: {
  root: string
  manifest: unknown
  /** Fixture-only seam used to prove path replacement cannot pass promotion. */
  afterInitialDigest?: () => Promise<void>
}): Promise<V3PuzzleAssociationIndex> {
  const manifest = PuzzleFamilyAssociationManifestV1Schema.parse(options.manifest)
  const associationPath = await safeExistingFile(options.root, manifest.database.path)
  await readExactValidatedFile({
    root: options.root,
    path: manifest.database.path,
    bytes: manifest.database.bytes,
    sha256: manifest.database.sha256,
    label: 'Puzzle family association database',
    maximumBytes: MAX_ASSOCIATION_DATABASE_BYTES,
  })
  await options.afterInitialDigest?.()
  const association = new SqliteV3PuzzleAssociationIndex(associationPath, manifest)
  try {
    // DatabaseSync must reopen by pathname. Re-read the exact content receipt
    // while that read-only SQLite handle is still open so a path replacement
    // between the initial hash and inspection cannot be promoted.
    await readExactValidatedFile({
      root: options.root,
      path: manifest.database.path,
      bytes: manifest.database.bytes,
      sha256: manifest.database.sha256,
      label: 'Post-inspection puzzle family association database',
      maximumBytes: MAX_ASSOCIATION_DATABASE_BYTES,
    })
    return association
  } catch (error) {
    association.close()
    throw error
  }
}

export interface LoadPuzzleV3PrerequisitesOptions {
  root: string
  releaseId: string
  workDirectory: string
  plansDirectory: string
  broadcastManifestPath: string
  standardManifestPath: string
  stockfishManifestPath: string
  associationManifestPath: string
  engineCampaignPath: string
  puzzleSource: PuzzleSourceBinding
}

export async function loadPuzzleV3Prerequisites(
  options: LoadPuzzleV3PrerequisitesOptions,
): Promise<{
  evidence: PuzzleV3EvidenceBindingV1
  evidenceBindingSha256: string
  association: V3PuzzleAssociationIndex
}> {
  const releaseId = FamilyReleaseIdSchema.parse(options.releaseId)
  const [broadcastFile, standardFile, stockfishFile, associationFile, campaignFile] = await Promise.all([
    readBoundedJson(resolve(options.broadcastManifestPath), 'Broadcast source manifest'),
    readBoundedJson(resolve(options.standardManifestPath), 'Q2 source manifest'),
    readBoundedJson(resolve(options.stockfishManifestPath), 'Stockfish source manifest'),
    readBoundedJson(resolve(options.associationManifestPath), 'Puzzle family association manifest'),
    readBoundedJson(resolve(options.engineCampaignPath), 'Puzzle engine campaign'),
  ])
  const corpora = [
    approvedCompactCorpusFromBytes(broadcastFile.bytes, 'lichess-broadcasts'),
    approvedCompactCorpusFromBytes(standardFile.bytes, 'lichess-standard-rated-q2-2026'),
  ]
  const foundation = await auditCompactV3Foundation({
    workDirectory: options.workDirectory,
    plansDirectory: options.plansDirectory,
    corpora,
  })
  if (!foundation.complete) {
    throw new Error(`Puzzle ingestion is blocked: compact-v3 exact evidence is incomplete (${foundation.missing.join(', ')})`)
  }
  const broadcast = foundation.corpora.find(({ sourceId }) => sourceId === 'lichess-broadcasts')
  const q2 = foundation.corpora.find(({ sourceId }) => sourceId === 'lichess-standard-rated-q2-2026')
  if (!broadcast || !q2 || broadcast.sourceSnapshotSha256 !== q2.sourceSnapshotSha256) {
    throw new Error('Puzzle ingestion requires complete broadcast and Q2 evidence from one source snapshot')
  }
  const broadcastReceipt = await finalExactReceipt({
    workDirectory: options.workDirectory,
    corpus: corpora[0]!,
    expectedStateSha256: broadcast.finalStateSha256,
  })
  const q2Receipt = await finalExactReceipt({
    workDirectory: options.workDirectory,
    corpus: corpora[1]!,
    expectedStateSha256: q2.finalStateSha256,
  })

  const associationManifest = PuzzleFamilyAssociationManifestV1Schema.parse(associationFile.value)
  const campaign = PuzzleEngineCampaignV1Schema.parse(campaignFile.value)
  if (associationManifest.releaseId !== releaseId || campaign.releaseId !== releaseId) {
    throw new Error('Puzzle prerequisites belong to another release')
  }
  const expectedAssociationEvidence = {
    broadcastFinalExactStateSha256: broadcastReceipt.stateSha256,
    broadcastFinalExactReceiptSha256: broadcastReceipt.receiptSha256,
    q2FinalExactStateSha256: q2Receipt.stateSha256,
    q2FinalExactReceiptSha256: q2Receipt.receiptSha256,
    sourceSnapshotSha256: broadcast.sourceSnapshotSha256,
  }
  if (Object.entries(expectedAssociationEvidence).some(([key, value]) =>
    associationManifest.compactEvidence[key as keyof typeof expectedAssociationEvidence] !== value
  )) throw new Error('Family association input is not bound to the validated compact-v3 exact states')

  const stockfish = StockfishManifestSchema.parse(stockfishFile.value)
  if (
    campaign.engine.sourceManifestSha256 !== stockfishFile.sha256 ||
    campaign.engine.releaseCommit !== stockfish.releaseCommit ||
    JSON.stringify(campaign.engine.settings) !== JSON.stringify(stockfish.analysisConfiguration)
  ) throw new Error('Puzzle engine campaign differs from the approved Stockfish source manifest')
  const provisionBytes = await readExactValidatedFile({
    root: options.root,
    path: campaign.sourceReceipt.path,
    bytes: campaign.sourceReceipt.bytes,
    sha256: campaign.sourceReceipt.sha256,
    label: 'Stockfish provision receipt',
    maximumBytes: MAX_JSON_BYTES,
  })
  const provision = ProvisionReceiptSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(provisionBytes)) as unknown)
  if (
    provision.releaseCommit !== campaign.engine.releaseCommit ||
    provision.executable.sha256 !== campaign.engine.executableSha256
  ) throw new Error('Puzzle engine campaign differs from its verified Stockfish provision receipt')

  const association = await openValidatedPuzzleFamilyAssociation({
    root: options.root,
    manifest: associationManifest,
  })
  try {
    const evidence = PuzzleV3EvidenceBindingV1Schema.parse({
      schemaVersion: 1,
      releaseId,
      storageModel: 'bounded-two-pass-content-addressed-v3',
      releaseEligible: false,
      puzzleSource: options.puzzleSource,
      compactEvidence: {
        broadcast: compactCorpusBinding(broadcast, broadcastReceipt.receiptSha256),
        q2: compactCorpusBinding(q2, q2Receipt.receiptSha256),
        sharedSourceSnapshotSha256: broadcast.sourceSnapshotSha256,
      },
      familyAssociation: {
        manifestSha256: associationFile.sha256,
        databaseSha256: associationManifest.database.sha256,
        catalogSha256: associationManifest.familyEvidence.catalogSha256,
        graphReconciliationSha256: associationManifest.familyEvidence.graphReconciliationSha256,
        familyCount: associationManifest.familyEvidence.familyCount,
        exactPositionAssociations: associationManifest.familyEvidence.exactPositionAssociations,
        tagAssociations: associationManifest.familyEvidence.tagAssociations,
      },
      engineCampaign: {
        campaignSha256: campaignFile.sha256,
        sourceReceiptSha256: campaign.sourceReceipt.sha256,
        sourceManifestSha256: campaign.engine.sourceManifestSha256,
        releaseCommit: campaign.engine.releaseCommit,
        executableSha256: campaign.engine.executableSha256,
        nnueSha256: campaign.engine.nnueSha256,
        settingsSha256: campaign.engine.settingsSha256,
      },
    })
    return { evidence, evidenceBindingSha256: sha256Json(evidence), association }
  } catch (error) {
    association.close()
    throw error
  }
}

export function validateEngineCampaignInput(input: unknown): PuzzleEngineCampaignV1 {
  return PuzzleEngineCampaignV1Schema.parse(input)
}

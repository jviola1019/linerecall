#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { access, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { TaxonomySourceManifestSchema } from '../../src/data/taxonomy-schema.ts'
import {
  assertBroadcastManifestApproved,
  type BroadcastManifestV1,
} from './broadcast-contracts.ts'
import { verifyArchive } from './broadcast-manifest.ts'
import {
  LichessPuzzleManifestSchema,
  LichessStandardManifestSchema,
  PuzzleIntegrityReceiptSchema,
} from './evidence-contracts.ts'
import { ScidManifestSchema, StockfishManifestSchema } from '../verification/lib/manifest.ts'
import { validateGraphFoundation, type ArchiveRunEvidence, type ExpectedArchiveIdentity } from './foundation-validation.ts'
import {
  COMPACT_STORAGE_MODEL,
  CompactArchiveCheckpointSchema,
  CompactPreflightPlanSchema,
  type CompactArchiveCheckpoint,
  type CompactBenchmarkApprovalReceipt,
  type CompactPassReceipt,
  type CompactPreflightPlan,
} from './compact-v3-contracts.ts'
import {
  compactBenchmarkApprovalRelativePath,
  validateCompactBenchmarkApproval,
} from './compact-v3-benchmark-approval.ts'
import {
  approvedArchiveIndex,
  approvedCompactCorpusFromBytes,
  type ApprovedCompactCorpus,
} from './compact-v3-manifest.ts'
import { receiptDigest } from './compact-v3-foundation.ts'
import {
  digestRegularFile,
  readBoundedRegularFile,
  readVerifiedCompactCheckpoint,
} from './compact-v3-orchestrator.ts'
import { createPuzzleSourceBinding } from './puzzle-contracts.ts'
import { auditFamilyPromotion } from '../release/lib/family-promotion-audit.ts'
import {
  COMPACT_ADAPTER_STATE_SCHEMA_VERSION,
  compactAdapterConfigurationSha256,
} from './compact-v3-adapter.ts'

type GateStatus = 'pass' | 'blocked' | 'fail'

interface Gate {
  status: GateStatus
  detail: string
}

interface CompactCorpusTotals {
  sourceId: ApprovedCompactCorpus['sourceId']
  archiveCount: number
  recordsSeen: number
  accepted: number
  deduplicated: number
  rejected: number
  games: number
  positions: number
  edges: number
  outcomes: number
  finalStateSha256: string
  sourceManifestSha256: string
  sourceSnapshotSha256: string
}

export interface CompactFoundationResult {
  complete: boolean
  detail: string
  corpora: CompactCorpusTotals[]
  missing: string[]
}

interface CompactSequenceValidation {
  complete: boolean
  missing: string[]
  sourceSnapshotSha256: string | null
  totals: Omit<CompactCorpusTotals, 'games' | 'positions' | 'edges' | 'outcomes' | 'finalStateSha256'> | null
}

const pathOption = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return resolve(value)
}

const valueOption = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}

const hasFlag = (name: string): boolean => process.argv.includes(name)

async function boundedJson(path: string, maximumBytes: number, label: string): Promise<unknown> {
  const bytes = await readBoundedRegularFile(path, maximumBytes, label, 1)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function gate(status: GateStatus, detail: string): Gate {
  return { status, detail }
}

function rejectedTotal(receipt: CompactPassReceipt): number {
  return Object.values(receipt.rejected).reduce((sum, count) => sum + count, 0)
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function assertSameJson(left: unknown, right: unknown, message: string): void {
  if (fingerprint(left) !== fingerprint(right)) throw new Error(message)
}

function expectedPlanPath(plansDirectory: string, archiveId: string): string {
  return join(plansDirectory, `${archiveId}.json`)
}

function checkpointPath(workDirectory: string, archiveId: string): string {
  return join(workDirectory, 'v3', archiveId, 'checkpoint.json')
}

function absoluteArtifactPath(workDirectory: string, relativePath: string): string {
  const root = resolve(workDirectory)
  const path = resolve(root, ...relativePath.split('/'))
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Compact artifact path escapes its work directory')
  }
  return path
}

/**
 * Validate manifest binding, canonical archive order, approved benchmark proof,
 * two-pass completeness, accounting, source-snapshot identity, and state chains.
 * File and content-addressed checksum validation is performed before this helper
 * by readVerifiedCompactCheckpoint.
 */
export function validateCompactCheckpointSequence(input: {
  corpus: ApprovedCompactCorpus
  plans: Array<CompactPreflightPlan | null>
  checkpoints: Array<CompactArchiveCheckpoint | null>
  benchmarkApprovals: Array<CompactBenchmarkApprovalReceipt | null>
}): CompactSequenceValidation {
  const { corpus } = input
  if (
    input.plans.length !== corpus.archives.length ||
    input.checkpoints.length !== corpus.archives.length ||
    input.benchmarkApprovals.length !== corpus.archives.length
  ) {
    throw new Error(`Compact ${corpus.sourceId} plan/checkpoint inventory has the wrong length`)
  }
  const missing: string[] = []
  const parsedPlans: CompactPreflightPlan[] = []
  const parsedCheckpoints: CompactArchiveCheckpoint[] = []
  for (let index = 0; index < corpus.archives.length; index += 1) {
    const approved = corpus.archives[index]!
    const archiveId = corpus.sourceId === 'lichess-broadcasts'
      ? `broadcast-${approved.month}`
      : `standard-${approved.month}`
    const planValue = input.plans[index]
    const checkpointValue = input.checkpoints[index]
    const benchmarkApproval = input.benchmarkApprovals[index]
    if (planValue === null) missing.push(`plan:${archiveId}`)
    if (checkpointValue === null) missing.push(`checkpoint:${archiveId}`)
    if (benchmarkApproval === null) missing.push(`benchmark-approval:${archiveId}`)
    if (planValue === null || checkpointValue === null || benchmarkApproval === null) continue
    const plan = CompactPreflightPlanSchema.parse(planValue)
    const checkpoint = CompactArchiveCheckpointSchema.parse(checkpointValue)
    const validatedBenchmarkApproval = validateCompactBenchmarkApproval(
      plan,
      Buffer.from(`${JSON.stringify(benchmarkApproval)}\n`, 'utf8'),
      checkpoint.candidateReceipt?.toolchain.sourceSnapshotSha256,
    )
    if (approvedArchiveIndex(corpus, plan.archive) !== index) {
      throw new Error(`Compact plan ${archiveId} is out of canonical manifest order`)
    }
    if (plan.benchmark.status !== 'approved') {
      throw new Error(`Compact plan ${archiveId} lacks an approved complete-broadcast benchmark proof`)
    }
    if (
      checkpoint.candidateReceipt !== null &&
      validatedBenchmarkApproval.bootstrap.sourceSnapshotSha256 !== checkpoint.candidateReceipt.toolchain.sourceSnapshotSha256
    ) {
      throw new Error(`Compact plan ${archiveId} benchmark approval belongs to another source snapshot`)
    }
    if (
      checkpoint.archive.archiveId !== plan.archive.archiveId ||
      checkpoint.archive.sha256 !== plan.archive.sha256 ||
      checkpoint.archive.sourceManifestSha256 !== corpus.sourceManifestSha256
    ) {
      throw new Error(`Compact checkpoint ${archiveId} does not match its approved source manifest plan`)
    }
    if (checkpoint.candidateReceipt === null) missing.push(`candidate:${archiveId}`)
    if (checkpoint.exactReceipt === null) missing.push(`exact:${archiveId}`)
    parsedPlans.push(plan)
    parsedCheckpoints.push(checkpoint)
  }
  if (missing.length > 0) {
    return { complete: false, missing, sourceSnapshotSha256: null, totals: null }
  }
  if (parsedPlans.length !== corpus.archives.length || parsedCheckpoints.length !== corpus.archives.length) {
    throw new Error(`Compact ${corpus.sourceId} inventory is internally incomplete`)
  }

  const configuration = fingerprint({
    limits: parsedPlans[0]!.limits,
    bounds: parsedPlans[0]!.bounds,
    benchmark: parsedPlans[0]!.benchmark,
  })
  for (const plan of parsedPlans) {
    if (fingerprint({ limits: plan.limits, bounds: plan.bounds, benchmark: plan.benchmark }) !== configuration) {
      throw new Error(`Compact ${corpus.sourceId} plans do not share one approved configuration`)
    }
  }

  const candidateReceipts = parsedCheckpoints.map((checkpoint) => checkpoint.candidateReceipt!)
  const exactReceipts = parsedCheckpoints.map((checkpoint) => checkpoint.exactReceipt!)
  const finalCandidateDigest = receiptDigest(candidateReceipts.at(-1)!)
  let priorCandidateStateSha256: string | null = null
  let priorExactStateSha256: string | null = null
  let sourceSnapshotSha256: string | null = null
  let recordsSeen = 0
  let accepted = 0
  let deduplicated = 0
  let rejected = 0
  for (let index = 0; index < corpus.archives.length; index += 1) {
    const candidate = candidateReceipts[index]!
    const exact = exactReceipts[index]!
    if (candidate.executionPurpose !== 'evidence-candidate' || exact.executionPurpose !== 'evidence-candidate') {
      throw new Error('Provisional benchmark receipts cannot satisfy the production data foundation')
    }
    if (candidate.pass !== 'candidate' || exact.pass !== 'exact') {
      throw new Error('Compact checkpoint contains a receipt for the wrong pass')
    }
    if (candidate.priorCandidateStateSha256 !== priorCandidateStateSha256) {
      throw new Error(`Compact candidate state chain is broken at ${candidate.archive.archiveId}`)
    }
    priorCandidateStateSha256 = candidate.output.sha256
    if (exact.priorExactStateSha256 !== priorExactStateSha256) {
      throw new Error(`Compact exact state chain is broken at ${exact.archive.archiveId}`)
    }
    priorExactStateSha256 = exact.output.sha256
    if (exact.finalCandidateSetReceiptSha256 !== finalCandidateDigest) {
      throw new Error(`Compact exact receipt ${exact.archive.archiveId} is not bound to the final candidate set`)
    }
    if (
      candidate.recordsSeen !== exact.recordsSeen ||
      candidate.accepted !== exact.accepted ||
      candidate.deduplicated !== exact.deduplicated ||
      rejectedTotal(candidate) !== rejectedTotal(exact)
    ) {
      throw new Error(`Compact candidate/exact accounting differs for ${exact.archive.archiveId}`)
    }
    assertSameJson(candidate.rejected, exact.rejected, `Compact rejected accounting differs for ${exact.archive.archiveId}`)
    const snapshots = [candidate.toolchain.sourceSnapshotSha256, exact.toolchain.sourceSnapshotSha256]
    for (const snapshot of snapshots) {
      if (sourceSnapshotSha256 !== null && snapshot !== sourceSnapshotSha256) {
        throw new Error(`Compact ${corpus.sourceId} receipts span multiple source snapshots`)
      }
      sourceSnapshotSha256 = snapshot
    }
    recordsSeen += exact.recordsSeen
    accepted += exact.accepted
    deduplicated += exact.deduplicated
    rejected += rejectedTotal(exact)
    if (![recordsSeen, accepted, deduplicated, rejected].every(Number.isSafeInteger)) {
      throw new Error(`Compact ${corpus.sourceId} accounting exceeds the safe integer range`)
    }
  }
  if (recordsSeen !== accepted + deduplicated + rejected) {
    throw new Error(`Compact ${corpus.sourceId} aggregate accounting does not reconcile`)
  }
  if (recordsSeen !== corpus.publishedGameTotal) {
    throw new Error(`Compact ${corpus.sourceId} recordsSeen does not match the approved publisher total`)
  }
  return {
    complete: true,
    missing: [],
    sourceSnapshotSha256,
    totals: {
      sourceId: corpus.sourceId,
      archiveCount: corpus.archives.length,
      recordsSeen,
      accepted,
      deduplicated,
      rejected,
      sourceManifestSha256: corpus.sourceManifestSha256,
      sourceSnapshotSha256: sourceSnapshotSha256!,
    },
  }
}

async function validateFinalExactDatabase(input: {
  workDirectory: string
  corpus: ApprovedCompactCorpus
  plans: CompactPreflightPlan[]
  checkpoints: CompactArchiveCheckpoint[]
  sequence: CompactSequenceValidation
  afterInspection?: (path: string) => Promise<void>
}): Promise<Pick<CompactCorpusTotals, 'games' | 'positions' | 'edges' | 'outcomes' | 'finalStateSha256'>> {
  if (!input.sequence.complete || !input.sequence.totals) throw new Error('Cannot validate an incomplete compact corpus')
  const finalCheckpoint = input.checkpoints.at(-1)
  const exact = finalCheckpoint?.exactReceipt
  if (!exact || exact.pass !== 'exact') throw new Error('Compact corpus lacks its final exact state')
  if (!exact.output.path.endsWith('.sqlite')) throw new Error('Compact final exact state must be a SQLite artifact')
  const databasePath = absoluteArtifactPath(input.workDirectory, exact.output.path)
  const before = await digestRegularFile(databasePath, {
    label: 'Compact final exact SQLite state before inspection',
    maximumBytes: exact.output.bytes,
    minimumBytes: exact.output.bytes,
    exactBytes: exact.output.bytes,
  })
  if (before.sha256 !== exact.output.sha256) {
    throw new Error('Compact final exact SQLite digest differs before inspection')
  }
  const database = new DatabaseSync(databasePath, { readOnly: true })
  let validated: Pick<CompactCorpusTotals, 'games' | 'positions' | 'edges' | 'outcomes' | 'finalStateSha256'> | null = null
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (integrity.integrity_check !== 'ok') throw new Error('Compact final exact SQLite state failed integrity_check')
    const stateVersion = database.prepare('PRAGMA user_version').get() as { user_version: number }
    if (stateVersion.user_version !== COMPACT_ADAPTER_STATE_SCHEMA_VERSION) {
      throw new Error('Compact final exact SQLite state has an unsupported adapter schema version')
    }
    const metadata = database.prepare(`
      SELECT schema_version AS schemaVersion, pass, source_manifest_sha256 AS sourceManifestSha256,
             configuration_sha256 AS configurationSha256,
             last_archive_id AS lastArchiveId, last_archive_index AS lastArchiveIndex,
             final_candidate_receipt_sha256 AS finalCandidateReceiptSha256
      FROM compact_adapter_metadata WHERE singleton = 1
    `).get() as {
      schemaVersion: number
      pass: string
      sourceManifestSha256: string
      configurationSha256: string
      lastArchiveId: string
      lastArchiveIndex: number
      finalCandidateReceiptSha256: string
    } | undefined
    const finalCandidateDigest = receiptDigest(input.checkpoints.at(-1)!.candidateReceipt!)
    if (
      !metadata || metadata.schemaVersion !== COMPACT_ADAPTER_STATE_SCHEMA_VERSION || metadata.pass !== 'exact' ||
      metadata.sourceManifestSha256 !== input.corpus.sourceManifestSha256 ||
      metadata.configurationSha256 !== compactAdapterConfigurationSha256(
        input.plans.at(-1)!,
        input.sequence.sourceSnapshotSha256!,
        'evidence-candidate',
      ) ||
      metadata.lastArchiveId !== exact.archive.archiveId ||
      metadata.lastArchiveIndex !== input.corpus.archives.length - 1 ||
      metadata.finalCandidateReceiptSha256 !== finalCandidateDigest
    ) {
      throw new Error('Compact final exact metadata does not match the completed receipt chain')
    }
    const archiveRows = database.prepare(`
      SELECT pass, archive_id AS archiveId, archive_index AS archiveIndex, source_id AS sourceId,
             source_manifest_sha256 AS sourceManifestSha256, month, archive_sha256 AS archiveSha256,
             compressed_bytes AS compressedBytes, records_seen AS recordsSeen, accepted, deduplicated,
             rejected_json AS rejectedJson
      FROM compact_adapter_archives ORDER BY archive_index
    `).all() as unknown as Array<{
      pass: string
      archiveId: string
      archiveIndex: number
      sourceId: string
      sourceManifestSha256: string
      month: string
      archiveSha256: string
      compressedBytes: number
      recordsSeen: number
      accepted: number
      deduplicated: number
      rejectedJson: string
    }>
    if (archiveRows.length !== input.corpus.archives.length) {
      throw new Error('Compact final exact state has the wrong archive-row count')
    }
    for (let index = 0; index < archiveRows.length; index += 1) {
      const row = archiveRows[index]!
      const receipt = input.checkpoints[index]!.exactReceipt!
      if (
        row.pass !== 'exact' || row.archiveIndex !== index || row.archiveId !== receipt.archive.archiveId ||
        row.sourceId !== receipt.archive.sourceId || row.sourceManifestSha256 !== input.corpus.sourceManifestSha256 ||
        row.month !== receipt.archive.month || row.archiveSha256 !== receipt.archive.sha256 ||
        row.compressedBytes !== receipt.archive.compressedBytes || row.recordsSeen !== receipt.recordsSeen ||
        row.accepted !== receipt.accepted || row.deduplicated !== receipt.deduplicated
      ) {
        throw new Error(`Compact exact database archive row differs from receipt ${receipt.archive.archiveId}`)
      }
      let rejected: unknown
      try {
        rejected = JSON.parse(row.rejectedJson) as unknown
      } catch {
        throw new Error(`Compact exact database rejected accounting is invalid JSON for ${receipt.archive.archiveId}`)
      }
      assertSameJson(rejected, receipt.rejected, `Compact exact database rejected accounting differs for ${receipt.archive.archiveId}`)
    }
    const invalidOutcomes = database.prepare(`
      SELECT count(*) AS count FROM outcomes
      WHERE n <= 0 OR n != white_wins + draws + black_wins OR min_ply < 0 OR min_ply > 100
    `).get() as { count: number }
    const invalidReferences = database.prepare(`
      SELECT count(*) AS count FROM outcomes o
      WHERE (o.kind = 'position' AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.position_id = o.reference_id))
         OR (o.kind = 'edge' AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.edge_id = o.reference_id))
    `).get() as { count: number }
    const invalidBinaryIdentities = database.prepare(`
      SELECT
        (SELECT count(*) FROM compact_adapter_games
          WHERE typeof(game_identity_sha256) != 'blob' OR length(game_identity_sha256) != 32
             OR typeof(corruption_guard_sha256) != 'blob' OR length(corruption_guard_sha256) != 32) +
        (SELECT count(*) FROM positions
          WHERE typeof(fingerprint) != 'blob' OR length(fingerprint) != 32) +
        (SELECT count(*) FROM edges
          WHERE typeof(fingerprint) != 'blob' OR length(fingerprint) != 32) AS count
    `).get() as { count: number }
    const content = database.prepare(`
      SELECT (SELECT count(*) FROM compact_adapter_games) AS games,
             (SELECT count(*) FROM positions) AS positions,
             (SELECT count(*) FROM edges) AS edges,
             (SELECT count(*) FROM outcomes) AS outcomes
    `).get() as { games: number; positions: number; edges: number; outcomes: number }
    if (
      invalidOutcomes.count !== 0 || invalidReferences.count !== 0 || invalidBinaryIdentities.count !== 0 ||
      content.games !== input.sequence.totals.accepted ||
      content.games <= 0 || content.positions <= 0 || content.edges <= 0 || content.outcomes <= 0
    ) {
      throw new Error('Compact final exact content, references, or W/D/L arithmetic is invalid')
    }
    validated = { ...content, finalStateSha256: exact.output.sha256 }
  } finally {
    database.close()
  }
  await input.afterInspection?.(databasePath)
  const after = await digestRegularFile(databasePath, {
    label: 'Compact final exact SQLite state after inspection',
    maximumBytes: exact.output.bytes,
    minimumBytes: exact.output.bytes,
    exactBytes: exact.output.bytes,
  })
  if (
    after.sha256 !== exact.output.sha256 ||
    after.size !== before.size ||
    after.identity !== before.identity
  ) {
    throw new Error('Compact final exact SQLite identity or digest changed during inspection')
  }
  if (validated === null) throw new Error('Compact final exact SQLite inspection did not produce validated content')
  return validated
}

async function loadPlan(path: string): Promise<CompactPreflightPlan> {
  return CompactPreflightPlanSchema.parse(await boundedJson(path, 1024 * 1024, 'Compact v3 plan'))
}

export async function auditCompactV3Foundation(options: {
  workDirectory: string
  plansDirectory: string
  corpora: ApprovedCompactCorpus[]
  testHooks?: {
    afterFinalDatabaseInspection?: (path: string) => Promise<void>
  }
}): Promise<CompactFoundationResult> {
  const missing: string[] = []
  const corpora: CompactCorpusTotals[] = []
  let sharedSourceSnapshot: string | null = null
  for (const corpus of options.corpora) {
    const plans: Array<CompactPreflightPlan | null> = []
    const checkpoints: Array<CompactArchiveCheckpoint | null> = []
    const benchmarkApprovals: Array<CompactBenchmarkApprovalReceipt | null> = []
    for (const archive of corpus.archives) {
      const archiveId = corpus.sourceId === 'lichess-broadcasts'
        ? `broadcast-${archive.month}`
        : `standard-${archive.month}`
      const planPath = expectedPlanPath(options.plansDirectory, archiveId)
      if (!(await exists(planPath))) {
        plans.push(null)
        checkpoints.push(null)
        benchmarkApprovals.push(null)
        missing.push(`plan:${archiveId}`)
        continue
      }
      const plan = await loadPlan(planPath)
      plans.push(plan)
      const approvalSha256 = plan.benchmark.receiptSha256
      if (plan.benchmark.status !== 'approved' || approvalSha256 === null) {
        benchmarkApprovals.push(null)
        missing.push(`benchmark-approval:${archiveId}`)
      } else {
        const approvalPath = join(
          options.plansDirectory,
          ...compactBenchmarkApprovalRelativePath(approvalSha256).split('/'),
        )
        if (!(await exists(approvalPath))) {
          benchmarkApprovals.push(null)
          missing.push(`benchmark-approval:${archiveId}`)
        } else {
          const approvalBytes = await readBoundedRegularFile(
            approvalPath,
            4 * 1024 * 1024,
            `Compact benchmark approval ${archiveId}`,
            1,
          )
          benchmarkApprovals.push(validateCompactBenchmarkApproval(plan, approvalBytes))
        }
      }
      const checkpoint = await readVerifiedCompactCheckpoint(options.workDirectory, plan)
      checkpoints.push(checkpoint)
      if (checkpoint === null) missing.push(`checkpoint:${archiveId}`)
    }
    const sequence = validateCompactCheckpointSequence({ corpus, plans, checkpoints, benchmarkApprovals })
    missing.push(...sequence.missing.filter((item) => !missing.includes(item)))
    if (!sequence.complete || !sequence.totals) continue
    if (sharedSourceSnapshot !== null && sequence.sourceSnapshotSha256 !== sharedSourceSnapshot) {
      throw new Error('Broadcast and Standard compact evidence were produced from different source snapshots')
    }
    sharedSourceSnapshot = sequence.sourceSnapshotSha256
    const content = await validateFinalExactDatabase({
      workDirectory: options.workDirectory,
      corpus,
      plans: plans as CompactPreflightPlan[],
      checkpoints: checkpoints as CompactArchiveCheckpoint[],
      sequence,
      ...(options.testHooks?.afterFinalDatabaseInspection
        ? { afterInspection: options.testHooks.afterFinalDatabaseInspection }
        : {}),
    })
    corpora.push({ ...sequence.totals, ...content })
  }
  if (missing.length > 0 || corpora.length !== options.corpora.length) {
    return {
      complete: false,
      detail: `Compact v3 corpus evidence is incomplete (${missing.length} missing plan/pass/checkpoint item(s))`,
      corpora,
      missing: [...new Set(missing)].sort(),
    }
  }
  return {
    complete: true,
    detail: corpora.map((corpus) =>
      `${corpus.sourceId}: ${corpus.archiveCount} archives, ${corpus.recordsSeen} records, ${corpus.positions} positions, ${corpus.edges} edges`
    ).join('; '),
    corpora,
    missing: [],
  }
}

async function historicalV2Diagnostics(graphPath: string, broadcast: BroadcastManifestV1, standard: ReturnType<typeof LichessStandardManifestSchema.parse>): Promise<Record<string, Gate>> {
  const diagnostics: Record<string, Gate> = {}
  if (await exists(graphPath)) {
    try {
      const database = new DatabaseSync(graphPath, { readOnly: true })
      try {
        const metadata = new Map((database.prepare('SELECT key,value FROM graph_metadata').all() as unknown as Array<{ key: string; value: string }>)
          .map(({ key, value }) => [key, value]))
        const expected: ExpectedArchiveIdentity[] = [
          ...broadcast.archives.map((archive) => ({
            archiveId: `broadcast-${archive.month}`, sourceId: 'lichess-broadcasts' as const,
            month: archive.month, sha256: archive.sha256,
          })),
          ...standard.archives.map((archive) => ({
            archiveId: `standard-${archive.month}`, sourceId: 'lichess-standard-rated-q2-2026' as const,
            month: archive.month, sha256: archive.sha256,
          })),
        ]
        const runs = database.prepare(`
          SELECT archive_id AS archiveId, source_id AS sourceId, month, sha256, status,
                 records_seen AS recordsSeen, accepted, deduplicated, rejected_json AS rejectedJson,
                 completed_at AS completedAt
          FROM archive_runs ORDER BY archive_id
        `).all() as unknown as ArchiveRunEvidence[]
        const validated = validateGraphFoundation({
          schemaVersion: metadata.get('schemaVersion'), maximumPly: metadata.get('maximumPly'), expected, runs,
        })
        const bySource = new Map(validated.groups.map((group) => [group.sourceId, group]))
        if (validated.complete) {
          const invalidPositions = database.prepare(`
            SELECT count(*) AS count FROM position_outcomes
            WHERE n <= 0 OR n != white_wins + draws + black_wins OR min_ply < 0 OR min_ply > 30
          `).get() as { count: number }
          const invalidEdges = database.prepare(`
            SELECT count(*) AS count FROM edge_outcomes
            WHERE n <= 0 OR n != white_wins + draws + black_wins OR min_ply < 1 OR min_ply > 30
          `).get() as { count: number }
          const content = database.prepare(`
            SELECT (SELECT count(*) FROM games) AS games,
                   (SELECT count(*) FROM position_outcomes) AS positions,
                   (SELECT count(*) FROM edge_outcomes) AS edges
          `).get() as { games: number; positions: number; edges: number }
          const standardGroup = validated.groups.find(({ sourceId }) => sourceId === 'lichess-standard-rated-q2-2026')
          if (
            invalidPositions.count !== 0 || invalidEdges.count !== 0 ||
            content.games <= 0 || content.positions <= 0 || content.edges <= 0 ||
            standardGroup?.recordsSeen !== standard.source.publishedGameTotal
          ) {
            throw new Error('Historical schema-v2 graph content, totals, or W/D/L arithmetic is invalid')
          }
          diagnostics.historicalV2Graph = gate(
            'pass',
            'Historical schema-v2 graph is internally complete but never production-qualifying',
          )
        } else {
          diagnostics.historicalV2Graph = gate(
            'blocked',
            `Historical schema-v2 graph only: broadcast ${bySource.get('lichess-broadcasts')?.completed ?? 0}/78; Standard ${bySource.get('lichess-standard-rated-q2-2026')?.completed ?? 0}/3; never production-qualifying`,
          )
        }
      } finally {
        database.close()
      }
    } catch (error) {
      diagnostics.historicalV2Graph = gate('fail', `Historical schema-v2 diagnostic failed: ${(error as Error).message}`)
    }
  } else {
    diagnostics.historicalV2Graph = gate('blocked', 'No historical schema-v2 graph is present')
  }
  for (const [id, path] of [
    ['historicalV2Engine', resolve('data/generated/v2/repertoire-engine-analysis.json')],
    ['historicalV2Scid', resolve('data/generated/v2/repertoire-scid-crosscheck.json')],
    ['historicalV2Puzzles', resolve('data/generated/v2/puzzles/verified-manifest.json')],
  ] as const) {
    diagnostics[id] = await exists(path)
      ? gate('pass', `${path} exists as historical evidence only and cannot satisfy a v3 gate`)
      : gate('blocked', `${path} is absent`)
  }
  return diagnostics
}

function relativeToRoot(root: string, path: string): string {
  const rel = relative(root, resolve(root, path))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Family promotion index escapes the audit root')
  return rel.replaceAll('\\', '/')
}

export async function main(): Promise<void> {
  const root = resolve('.')
  const outputPath = pathOption('--output', 'data/generated/v3/foundation-audit.json')
  const broadcastDirectory = pathOption('--broadcast-dir', '.cache/broadcast/archives')
  const standardDirectory = pathOption('--standard-dir', '.cache/standard-q2-2026')
  const puzzlePath = pathOption('--puzzle', '.cache/puzzles/lichess_db_puzzle.csv.zst')
  const puzzleReceiptPath = pathOption('--puzzle-receipt', 'data/manifests/lichess-puzzles.integrity.json')
  const legacyGraphPath = pathOption('--legacy-graph', 'data/generated/v2/evidence-graph.sqlite')
  const v3WorkDirectory = pathOption('--v3-work-dir', 'data/generated/v3/corpus')
  const v3PlansDirectory = pathOption('--v3-plans-dir', 'data/generated/v3/plans')
  const familyPromotionIndex = relativeToRoot(root, valueOption('--family-promotion-index', 'data/generated/v3/family-promotion-index.json'))
  const verifyLocalSha = hasFlag('--verify-local-sha')
  const requireComplete = hasFlag('--require-complete')

  const manifestPaths = {
    taxonomy: resolve('data/manifests/taxonomy.source.json'),
    broadcasts: resolve('data/manifests/broadcasts.source.json'),
    stockfish: resolve('data/manifests/stockfish-18.source.json'),
    scid: resolve('data/manifests/scid.source.json'),
    standard: resolve('data/manifests/lichess-standard-q2-2026.source.json'),
    puzzles: resolve('data/manifests/lichess-puzzles.source.json'),
  }
  const [taxonomy, broadcastBytes, stockfish, scid, standardBytes, puzzle] = await Promise.all([
    TaxonomySourceManifestSchema.parse(await boundedJson(manifestPaths.taxonomy, 1024 * 1024, 'Taxonomy source manifest')),
    readBoundedRegularFile(manifestPaths.broadcasts, 4 * 1024 * 1024, 'Broadcast source manifest', 1),
    StockfishManifestSchema.parse(await boundedJson(manifestPaths.stockfish, 1024 * 1024, 'Stockfish source manifest')),
    ScidManifestSchema.parse(await boundedJson(manifestPaths.scid, 1024 * 1024, 'Scid source manifest')),
    readBoundedRegularFile(manifestPaths.standard, 1024 * 1024, 'Standard source manifest', 1),
    LichessPuzzleManifestSchema.parse(await boundedJson(manifestPaths.puzzles, 1024 * 1024, 'Puzzle source manifest')),
  ])
  const broadcastValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(broadcastBytes)) as unknown
  assertBroadcastManifestApproved(broadcastValue)
  const broadcast: BroadcastManifestV1 = broadcastValue
  const standard = LichessStandardManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(standardBytes)) as unknown)
  const compactCorpora = [
    approvedCompactCorpusFromBytes(broadcastBytes, 'lichess-broadcasts'),
    approvedCompactCorpusFromBytes(standardBytes, 'lichess-standard-rated-q2-2026'),
  ]

  const gates: Record<string, Gate> = {
    taxonomyManifest: gate(
      taxonomy.approval.status === 'approved' ? 'pass' : 'fail',
      `${taxonomy.format.expectedRows} rows / ${taxonomy.format.expectedEcoCodes} ECO codes at ${taxonomy.source.commit}`,
    ),
    broadcastManifest: gate('pass', `${broadcast.archives.length} approved CC BY-SA 4.0 archives through ${broadcast.cutoffMonth}`),
    standardManifest: gate('pass', `${standard.archives.length} approved CC0 archives / ${standard.source.publishedGameTotal} published games`),
    puzzleManifest: gate('pass', `CC0 source identity pinned at ${puzzle.source.asOf}; publisher SHA-256 unavailable`),
    stockfishManifest: gate(
      stockfish.approval.status === 'approved' ? 'pass' : 'fail',
      `Stockfish ${stockfish.version}, ${stockfish.analysisConfiguration.nodes} nodes, MultiPV ${stockfish.analysisConfiguration.multiPv}`,
    ),
    scidManifest: gate(scid.approval.status === 'approved' ? 'pass' : 'fail', `Scid audit oracle ${scid.repositoryCommit}`),
  }

  if (await exists(puzzleReceiptPath)) {
    try {
      const receipt = PuzzleIntegrityReceiptSchema.parse(await boundedJson(puzzleReceiptPath, 1024 * 1024, 'Puzzle integrity receipt'))
      createPuzzleSourceBinding(puzzle, receipt)
      gates.puzzleIntegrity = receipt.approval.status === 'approved'
        ? gate('pass', `Approved, source-bound local digest ${receipt.sha256}`)
        : gate('blocked', `Local digest receipt status is ${receipt.approval.status}`)
    } catch (error) {
      gates.puzzleIntegrity = gate('fail', `Puzzle integrity receipt is invalid or source-mismatched: ${(error as Error).message}`)
    }
  } else {
    gates.puzzleIntegrity = gate('blocked', 'No locally computed and explicitly approved puzzle SHA-256 receipt exists')
  }

  let compactFoundation: CompactFoundationResult | null = null
  if (!(await exists(v3PlansDirectory)) || !(await exists(v3WorkDirectory))) {
    gates.compactV3Corpora = gate('blocked', 'No complete compact-v3 plan and content-addressed corpus state set exists')
  } else {
    try {
      compactFoundation = await auditCompactV3Foundation({
        workDirectory: v3WorkDirectory,
        plansDirectory: v3PlansDirectory,
        corpora: compactCorpora,
      })
      gates.compactV3Corpora = compactFoundation.complete
        ? gate('pass', compactFoundation.detail)
        : gate('blocked', `${compactFoundation.detail}: ${compactFoundation.missing.slice(0, 8).join(', ')}${compactFoundation.missing.length > 8 ? ', ...' : ''}`)
    } catch (error) {
      gates.compactV3Corpora = gate('fail', `Compact-v3 receipt/state validation failed: ${(error as Error).message}`)
    }
  }

  if (await exists(resolve(root, familyPromotionIndex))) {
    const promotion = await auditFamilyPromotion({ root, indexPath: familyPromotionIndex })
    gates.compactV3VerificationPromotion = promotion.status === 'pass'
      ? gate('pass', `${promotion.counts.families} families, ${promotion.counts.eligibleEdges} eligible edges, ${promotion.counts.puzzles} puzzles are receipt-bound`)
      : gate('fail', `Family/engine/Scid/puzzle promotion audit is ${promotion.status} with ${promotion.findings.length} finding(s)`)
  } else {
    gates.compactV3VerificationPromotion = gate('blocked', 'No receipt-bound compact-v3 family, Stockfish, Scid, and puzzle promotion index exists')
  }

  const diagnostics: Record<string, Gate> = {}
  let cachedBroadcasts = 0
  for (const archive of broadcast.archives) {
    const path = join(broadcastDirectory, archive.filename)
    if (!(await exists(path))) continue
    if (verifyLocalSha) await verifyArchive(path, archive.sha256)
    cachedBroadcasts += 1
  }
  diagnostics.broadcastCache = cachedBroadcasts === broadcast.archives.length
    ? gate('pass', `${cachedBroadcasts}/78 archives present${verifyLocalSha ? ' and SHA-256 verified' : '; raw cache is not release evidence'}`)
    : gate('blocked', `${cachedBroadcasts}/78 archives cached; verified remote receipts may satisfy v3 without retained inputs`)
  let cachedStandard = 0
  for (const archive of standard.archives) {
    const path = join(standardDirectory, archive.filename)
    if (!(await exists(path))) continue
    const details = await stat(path)
    if (details.size !== archive.bytes) throw new Error(`${archive.filename} has an unexpected byte length`)
    if (verifyLocalSha) await verifyArchive(path, archive.sha256)
    cachedStandard += 1
  }
  diagnostics.standardCache = cachedStandard === standard.archives.length
    ? gate('pass', `${cachedStandard}/3 raw archives present${verifyLocalSha ? ' and SHA-256 verified' : ''}`)
    : gate('blocked', `${cachedStandard}/3 archives cached; approved HTTPS streaming does not require retaining 87.2 GB`)
  diagnostics.puzzleCache = await exists(puzzlePath)
    ? gate('pass', `Puzzle archive present at ${puzzlePath}`)
    : gate('blocked', 'Puzzle archive is not cached; an approved source-bound promotion receipt remains authoritative')
  Object.assign(diagnostics, await historicalV2Diagnostics(legacyGraphPath, broadcast, standard))

  const statuses = Object.values(gates).map(({ status }) => status)
  const result = statuses.includes('fail') ? 'fail' : statuses.includes('blocked') ? 'blocked' : 'pass'
  const corpusBySource = new Map(compactFoundation?.corpora.map((corpus) => [corpus.sourceId, corpus]) ?? [])
  const standardTotals = corpusBySource.get('lichess-standard-rated-q2-2026')
  const broadcastTotals = corpusBySource.get('lichess-broadcasts')
  const report = {
    schemaVersion: 2,
    storageModel: COMPACT_STORAGE_MODEL,
    auditedAt: new Date().toISOString(),
    result,
    releaseEligible: result === 'pass',
    claims: {
      historicalBroadcastRecordsSeen: 1_146_297,
      historicalBroadcastAccepted: 800_176,
      historicalBroadcastEvidenceScope: 'prior 7,824-position taxonomy target run; diagnostic only',
      compactV3Broadcast: broadcastTotals ?? null,
      compactV3Standard: standardTotals ?? null,
      explanation: 'Null compact-v3 totals mean the required checksum-verified corpus state is incomplete; no values are estimated.',
    },
    gates,
    diagnostics,
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`Data foundation audit: ${result}. Report: ${outputPath}\n`)
  if (requireComplete && result !== 'pass') process.exitCode = 2
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`Data foundation audit failed: ${(error as Error).message}\n`)
    process.exitCode = 1
  })
}

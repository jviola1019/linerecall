import { createHash } from 'node:crypto'
import { access, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { z } from 'zod'
import {
  CompactArchiveCheckpointSchema,
  COMPACT_ADAPTER_STATE_SCHEMA_VERSION,
  type CompactArchiveCheckpoint,
} from './compact-v3-contracts.ts'
import {
  approvedArchiveIndex,
  approvedCompactCorpusFromBytes,
  type ApprovedCompactCorpus,
} from './compact-v3-manifest.ts'
import { evidenceFingerprint, receiptDigest } from './compact-v3-foundation.ts'
import { digestRegularFile } from './compact-v3-orchestrator.ts'
import {
  CompactExactFamilyGraphHandoffV1Schema,
  FamilyGraphBuildOutputV1Schema,
  FamilyGraphBuildRequestV1Schema,
  FamilyGraphEngineProofSetV1Schema,
  FamilyGraphPackBuildSpecV1Schema,
  type CompactExactFamilyGraphHandoffV1,
  type FamilyGraphBuildOutputV1,
  type FamilyGraphEvidenceCohortDeclarationV1,
  type FamilyGraphPackBuildSpecV1,
} from './family-graph-v3-contracts.ts'
import {
  FAMILY_ENGINE_SETTINGS,
  FamilyEngineCampaignRequestV1Schema,
  FamilyEngineCandidatePackV1Schema,
  type FamilyEngineCampaignRequestV1,
  type FamilyEngineCandidatePackV1,
} from './family-engine-v3-contracts.ts'
import {
  ImmutableJsonReceiptV1Schema,
  readImmutableJsonReceipt,
  resolveSafeReceiptPath,
  safeOutputPath,
  writeImmutableJsonCandidate,
  type ImmutableJsonReceiptV1,
} from '../release/lib/immutable-json-receipt.ts'
import {
  FamilyGraphProvenanceDocumentV1Schema,
  REPERTOIRE_MAX_PLY,
  REPERTOIRE_SCHEMA_VERSION,
  RepertoireBranchEvidenceSchema,
  classifyBookTerminalStatus,
  classifyRepertoireTier,
  compareTrainingValueSummaries,
  stableRepertoireCardId,
  trainingValueSummaryForPath,
  validateEligibleSourceEdgeInventory,
  validateRepertoireGraphDocument,
  type EligibleSourceEdgeInventoryV1,
  type EvidenceCohortResult,
  type RepertoireBranchEvidence,
  type RepertoireEdge,
  type RepertoireGraphDocument,
  type RepertoireNode,
  type RepertoirePath,
} from '../../src/domain/repertoire.ts'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import {
  MAX_APPROVED_EVIDENCE_GAMES,
  TRINOMIAL_PROFILE_LIKELIHOOD_95_METHOD,
  trinomialScoreProfileLikelihoodInterval,
} from '../../src/domain/statistics.ts'

const MINIMUM_EXPLORATORY_SAMPLE = 100
const MINIMUM_DRILL_SAMPLE = 500
const SHA256 = /^[a-f0-9]{64}$/u
const CANONICAL_BANDS = ['<1800', '1800-1999', '2000-2199', '2200-2399', '2400+'] as const
const BEGINNER_BANDS = ['<1200', '1200-1499', '1500-1799'] as const

interface OutcomeRow {
  cohortId: string
  month: string
  timeControl: string
  ratingBand: string
  ratingDetail: string
  n: number
  whiteWins: number
  draws: number
  blackWins: number
}

interface ExactEdgeRow {
  edgeId: number
  fingerprint: Uint8Array
  fromPositionId: number
  toPositionId: number
  fromEpd: string
  toEpd: string
  uci: string
  san: string
}

interface ExactCorpusState {
  sourceId: ApprovedCompactCorpus['sourceId']
  corpus: ApprovedCompactCorpus
  checkpoints: CompactArchiveCheckpoint[]
  database: DatabaseSync
  databasePath: string
  artifact: { path: string; sha256: string; bytes: number }
  identity: string
  accepted: number
  sourceSnapshotSha256: string
}

export interface VerifiedCompactExactFamilyGraphHandoff {
  handoff: CompactExactFamilyGraphHandoffV1
  handoffReceipt: ImmutableJsonReceiptV1
  states: ExactCorpusState[]
  closeAndVerify: () => Promise<void>
}

interface SourceEdgeStateRow {
  state: ExactCorpusState
  row: ExactEdgeRow
  fromPositionId: number
}

interface GraphEdgeWork {
  key: string
  fromEpd: string
  toEpd: string
  uci: string
  san: string
  fromDepth: number
  evidence: RepertoireBranchEvidence
  role: RepertoireEdge['role']
  eligibleForDrill: boolean
  acceptedBookTransposition: boolean
  id: string
  fromNodeId: string
  toNodeId: string
}

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stablePositionId(epd: string): string {
  return `pos_${hash(epd).slice(0, 16)}`
}

function stableEdgeId(fromEpd: string, uci: string, toEpd: string): string {
  return `edge_${hash(`${fromEpd}\0${uci}\0${toEpd}`).slice(0, 20)}`
}

function stablePathId(packId: string, edgeIds: readonly string[]): string {
  return `path_${hash(`${packId}\0${edgeIds.join('\0')}`).slice(0, 20)}`
}

function moveInput(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

function safeArtifactPath(rootReal: string, requested: string): string {
  ImmutableJsonReceiptV1Schema.shape.path.parse(requested)
  const target = resolve(rootReal, requested)
  const rel = relative(rootReal, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Exact-state artifact path escapes its approved root')
  }
  return target
}

function addSafe(left: number, right: number, label: string): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum) || sum > MAX_APPROVED_EVIDENCE_GAMES) {
    throw new Error(`${label} exceeds the approved evidence bound`)
  }
  return sum
}

function rejectedTotal(checkpoint: CompactArchiveCheckpoint): number {
  const receipt = checkpoint.exactReceipt
  if (!receipt) return 0
  return Object.values(receipt.rejected).reduce((sum, count) => addSafe(sum, count, 'Rejected accounting'), 0)
}

async function readCheckpointReceipts(
  receiptRoot: string,
  receipts: readonly ImmutableJsonReceiptV1[],
): Promise<CompactArchiveCheckpoint[]> {
  const checkpoints: CompactArchiveCheckpoint[] = []
  for (const receipt of receipts) {
    const loaded = await readImmutableJsonReceipt({
      root: receiptRoot,
      receipt,
      maximumStoredBytes: 2 * 1024 * 1024,
      maximumDecodedBytes: 2 * 1024 * 1024,
    })
    checkpoints.push(CompactArchiveCheckpointSchema.parse(loaded.value))
  }
  return checkpoints
}

function validateCheckpointChain(corpus: ApprovedCompactCorpus, checkpoints: readonly CompactArchiveCheckpoint[]): {
  accepted: number
  sourceSnapshotSha256: string
  final: CompactArchiveCheckpoint
} {
  if (checkpoints.length !== corpus.archives.length) {
    throw new Error(`Exact ${corpus.sourceId} handoff has ${checkpoints.length}/${corpus.archives.length} checkpoints`)
  }
  let priorCandidate: string | null = null
  let priorExact: string | null = null
  let sourceSnapshot: string | null = null
  let recordsSeen = 0
  let accepted = 0
  let deduplicated = 0
  let rejected = 0
  const candidateReceipts = checkpoints.map((checkpoint) => checkpoint.candidateReceipt)
  if (candidateReceipts.some((receipt) => receipt?.pass !== 'candidate')) {
    throw new Error(`Exact ${corpus.sourceId} handoff lacks a complete candidate receipt chain`)
  }
  const finalCandidateReceiptSha256 = receiptDigest(candidateReceipts.at(-1)!)
  for (const [index, checkpoint] of checkpoints.entries()) {
    if (approvedArchiveIndex(corpus, checkpoint.archive) !== index) {
      throw new Error(`Exact ${corpus.sourceId} checkpoint order differs from the approved source manifest`)
    }
    const candidate = checkpoint.candidateReceipt
    const exact = checkpoint.exactReceipt
    if (!candidate || candidate.pass !== 'candidate' || !exact || exact.pass !== 'exact') {
      throw new Error(`Exact ${corpus.sourceId} checkpoint ${index} lacks both completed passes`)
    }
    if (candidate.executionPurpose !== 'evidence-candidate' || exact.executionPurpose !== 'evidence-candidate') {
      throw new Error('Benchmark-bootstrap output cannot enter family graph construction')
    }
    if (candidate.priorCandidateStateSha256 !== priorCandidate) {
      throw new Error(`Candidate receipt chain breaks at ${checkpoint.archive.archiveId}`)
    }
    if (exact.priorExactStateSha256 !== priorExact) {
      throw new Error(`Exact receipt chain breaks at ${checkpoint.archive.archiveId}`)
    }
    if (exact.finalCandidateSetReceiptSha256 !== finalCandidateReceiptSha256) {
      throw new Error(`Exact receipt ${checkpoint.archive.archiveId} is not bound to the final candidate set`)
    }
    if (
      candidate.recordsSeen !== exact.recordsSeen || candidate.accepted !== exact.accepted ||
      candidate.deduplicated !== exact.deduplicated ||
      JSON.stringify(candidate.rejected) !== JSON.stringify(exact.rejected)
    ) {
      throw new Error(`Candidate/exact accounting differs at ${checkpoint.archive.archiveId}`)
    }
    for (const receipt of [candidate, exact]) {
      if (receipt.toolchain.adapterStateSchemaVersion !== COMPACT_ADAPTER_STATE_SCHEMA_VERSION) {
        throw new Error('Exact receipt uses an unsupported adapter state schema')
      }
      if (sourceSnapshot !== null && sourceSnapshot !== receipt.toolchain.sourceSnapshotSha256) {
        throw new Error(`Exact ${corpus.sourceId} handoff spans multiple source snapshots`)
      }
      sourceSnapshot = receipt.toolchain.sourceSnapshotSha256
    }
    priorCandidate = candidate.output.sha256
    priorExact = exact.output.sha256
    recordsSeen = addSafe(recordsSeen, exact.recordsSeen, 'Corpus recordsSeen')
    accepted = addSafe(accepted, exact.accepted, 'Corpus accepted')
    deduplicated = addSafe(deduplicated, exact.deduplicated, 'Corpus deduplicated')
    rejected = addSafe(rejected, rejectedTotal(checkpoint), 'Corpus rejected')
  }
  if (recordsSeen !== corpus.publishedGameTotal || recordsSeen !== accepted + deduplicated + rejected) {
    throw new Error(`Exact ${corpus.sourceId} accounting does not reconcile to its approved publisher total`)
  }
  return { accepted, sourceSnapshotSha256: sourceSnapshot!, final: checkpoints.at(-1)! }
}

function tableColumns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_xinfo(${table})`).all() as unknown as Array<{ name: string; type: string; hidden: number }>)
    .filter(({ hidden }) => hidden === 0)
    .map(({ name, type }) => `${name}:${type.toUpperCase()}`)
}

function assertExactTableLayouts(database: DatabaseSync): void {
  const expected: Record<string, string[]> = {
    compact_adapter_metadata: ['singleton:INTEGER', 'schema_version:INTEGER', 'pass:TEXT', 'source_manifest_sha256:TEXT', 'configuration_sha256:TEXT', 'last_archive_id:TEXT', 'last_archive_index:INTEGER', 'sketch_snapshot:BLOB', 'final_candidate_receipt_sha256:TEXT'],
    compact_adapter_games: ['game_identity_sha256:BLOB', 'corruption_guard_sha256:BLOB', 'first_archive_index:INTEGER'],
    compact_adapter_archives: ['pass:TEXT', 'archive_id:TEXT', 'archive_index:INTEGER', 'source_id:TEXT', 'source_manifest_sha256:TEXT', 'month:TEXT', 'archive_sha256:TEXT', 'compressed_bytes:INTEGER', 'records_seen:INTEGER', 'accepted:INTEGER', 'deduplicated:INTEGER', 'rejected_json:TEXT'],
    positions: ['position_id:INTEGER', 'fingerprint:BLOB', 'epd:TEXT'],
    edges: ['edge_id:INTEGER', 'fingerprint:BLOB', 'from_position_id:INTEGER', 'uci:TEXT', 'san:TEXT', 'to_position_id:INTEGER'],
    outcomes: ['kind:TEXT', 'reference_id:INTEGER', 'cohort_id:TEXT', 'month:TEXT', 'time_control:TEXT', 'rating_band:TEXT', 'rating_detail:TEXT', 'min_ply:INTEGER', 'n:INTEGER', 'white_wins:INTEGER', 'draws:INTEGER', 'black_wins:INTEGER'],
  }
  const objects = database.prepare(`
    SELECT type, name FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view', 'trigger')
    ORDER BY type, name
  `).all() as unknown as Array<{ type: string; name: string }>
  if (objects.some(({ type }) => type !== 'table')) throw new Error('Exact state must not contain views or triggers')
  const tables = objects.map(({ name }) => name).sort()
  const expectedTables = Object.keys(expected).sort()
  if (JSON.stringify(tables) !== JSON.stringify(expectedTables)) {
    throw new Error('Exact state has an unexpected user-table inventory')
  }
  for (const [table, columns] of Object.entries(expected)) {
    if (JSON.stringify(tableColumns(database, table)) !== JSON.stringify(columns)) {
      throw new Error(`Exact state table ${table} has an unexpected schema`)
    }
  }
}

function validateExactDatabase(
  database: DatabaseSync,
  corpus: ApprovedCompactCorpus,
  checkpoints: readonly CompactArchiveCheckpoint[],
  configurationSha256: string,
  accepted: number,
): void {
  const final = checkpoints.at(-1)!.exactReceipt!
  const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
  if (integrity.integrity_check !== 'ok') throw new Error('Exact state failed SQLite integrity_check')
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeys.length !== 0) throw new Error('Exact state failed SQLite foreign_key_check')
  const userVersion = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (userVersion !== COMPACT_ADAPTER_STATE_SCHEMA_VERSION) throw new Error('Exact state user_version is unsupported')
  assertExactTableLayouts(database)
  const metadata = database.prepare(`
    SELECT schema_version AS schemaVersion, pass, source_manifest_sha256 AS sourceManifestSha256,
      configuration_sha256 AS configurationSha256, last_archive_id AS lastArchiveId,
      last_archive_index AS lastArchiveIndex,
      final_candidate_receipt_sha256 AS finalCandidateReceiptSha256
    FROM compact_adapter_metadata WHERE singleton = 1
  `).get() as {
    schemaVersion: number; pass: string; sourceManifestSha256: string; configurationSha256: string
    lastArchiveId: string; lastArchiveIndex: number; finalCandidateReceiptSha256: string
  } | undefined
  const finalCandidateSha256 = receiptDigest(checkpoints.at(-1)!.candidateReceipt!)
  if (
    !metadata || metadata.schemaVersion !== COMPACT_ADAPTER_STATE_SCHEMA_VERSION || metadata.pass !== 'exact' ||
    metadata.sourceManifestSha256 !== corpus.sourceManifestSha256 ||
    metadata.configurationSha256 !== configurationSha256 ||
    metadata.lastArchiveId !== final.archive.archiveId ||
    metadata.lastArchiveIndex !== corpus.archives.length - 1 ||
    metadata.finalCandidateReceiptSha256 !== finalCandidateSha256
  ) throw new Error('Exact state metadata is not bound to its completed checkpoint chain')

  const archiveRows = database.prepare(`
    SELECT archive_id AS archiveId, archive_index AS archiveIndex, source_id AS sourceId,
      source_manifest_sha256 AS sourceManifestSha256, archive_sha256 AS archiveSha256,
      records_seen AS recordsSeen, accepted, deduplicated, rejected_json AS rejectedJson
    FROM compact_adapter_archives WHERE pass = 'exact' ORDER BY archive_index
  `).all() as unknown as Array<{
    archiveId: string; archiveIndex: number; sourceId: string; sourceManifestSha256: string
    archiveSha256: string; recordsSeen: number; accepted: number; deduplicated: number; rejectedJson: string
  }>
  if (archiveRows.length !== checkpoints.length) throw new Error('Exact state archive inventory is incomplete')
  for (const [index, row] of archiveRows.entries()) {
    const receipt = checkpoints[index]!.exactReceipt!
    if (
      row.archiveIndex !== index || row.archiveId !== receipt.archive.archiveId ||
      row.sourceId !== receipt.archive.sourceId || row.sourceManifestSha256 !== corpus.sourceManifestSha256 ||
      row.archiveSha256 !== receipt.archive.sha256 || row.recordsSeen !== receipt.recordsSeen ||
      row.accepted !== receipt.accepted || row.deduplicated !== receipt.deduplicated ||
      row.rejectedJson !== JSON.stringify(receipt.rejected)
    ) throw new Error(`Exact state archive accounting differs at ${receipt.archive.archiveId}`)
  }
  const bad = database.prepare(`
    SELECT
      (SELECT count(*) FROM compact_adapter_games WHERE typeof(game_identity_sha256) != 'blob'
        OR length(game_identity_sha256) != 32 OR typeof(corruption_guard_sha256) != 'blob'
        OR length(corruption_guard_sha256) != 32) +
      (SELECT count(*) FROM positions WHERE typeof(fingerprint) != 'blob' OR length(fingerprint) != 32) +
      (SELECT count(*) FROM edges WHERE typeof(fingerprint) != 'blob' OR length(fingerprint) != 32) +
      (SELECT count(*) FROM outcomes WHERE n <= 0 OR white_wins < 0 OR draws < 0 OR black_wins < 0
        OR n != white_wins + draws + black_wins
        OR min_ply < 0 OR min_ply > 100) AS count
  `).get() as { count: number }
  if (bad.count !== 0) throw new Error('Exact state contains invalid binary identities or W/D/L arithmetic')
  const games = (database.prepare('SELECT count(*) AS count FROM compact_adapter_games').get() as { count: number }).count
  if (games !== accepted) throw new Error('Exact-state game ledger does not match accepted corpus accounting')
}

/** Open and independently replay the exact handoff receipt chain. */
export async function openVerifiedCompactExactFamilyGraphHandoff(options: {
  receiptRoot: string
  artifactRoot: string
  handoffReceipt: unknown
}): Promise<VerifiedCompactExactFamilyGraphHandoff> {
  const loaded = await readImmutableJsonReceipt({
    root: options.receiptRoot,
    receipt: options.handoffReceipt,
    maximumStoredBytes: 4 * 1024 * 1024,
    maximumDecodedBytes: 4 * 1024 * 1024,
  })
  const handoff = CompactExactFamilyGraphHandoffV1Schema.parse(loaded.value)
  const artifactRootReal = await realpath(options.artifactRoot)
  const states: ExactCorpusState[] = []
  try {
    for (const corpusInput of handoff.corpora) {
      const manifestLoaded = await readImmutableJsonReceipt({
        root: options.receiptRoot,
        receipt: corpusInput.sourceManifest,
        maximumStoredBytes: 4 * 1024 * 1024,
        maximumDecodedBytes: 4 * 1024 * 1024,
      })
      const corpus = approvedCompactCorpusFromBytes(manifestLoaded.storedBytes, corpusInput.sourceId)
      const checkpoints = await readCheckpointReceipts(options.receiptRoot, corpusInput.checkpoints)
      const chain = validateCheckpointChain(corpus, checkpoints)
      const finalReceipt = chain.final.exactReceipt!
      if (
        finalReceipt.output.path !== corpusInput.finalExactState.path ||
        finalReceipt.output.sha256 !== corpusInput.finalExactState.sha256 ||
        finalReceipt.output.bytes !== corpusInput.finalExactState.bytes
      ) throw new Error(`Exact ${corpusInput.sourceId} state does not match its terminal receipt`)
      const databasePath = safeArtifactPath(artifactRootReal, corpusInput.finalExactState.path)
      const before = await digestRegularFile(databasePath, {
        label: `Exact ${corpusInput.sourceId} graph-build state`,
        exactBytes: corpusInput.finalExactState.bytes,
        minimumBytes: corpusInput.finalExactState.bytes,
        maximumBytes: corpusInput.finalExactState.bytes,
      })
      if (before.sha256 !== corpusInput.finalExactState.sha256) throw new Error('Exact-state SHA-256 mismatch')
      const database = new DatabaseSync(databasePath, { readOnly: true })
      try {
        validateExactDatabase(database, corpus, checkpoints, corpusInput.configurationSha256, chain.accepted)
      } catch (error) {
        database.close()
        throw error
      }
      states.push({
        sourceId: corpusInput.sourceId,
        corpus,
        checkpoints,
        database,
        databasePath,
        artifact: corpusInput.finalExactState,
        identity: before.identity,
        accepted: chain.accepted,
        sourceSnapshotSha256: chain.sourceSnapshotSha256,
      })
    }
  } catch (error) {
    for (const state of states) state.database.close()
    throw error
  }
  if (new Set(states.map(({ sourceSnapshotSha256 }) => sourceSnapshotSha256)).size !== 1) {
    for (const state of states) state.database.close()
    throw new Error('Broadcast and Q2 exact states were built from different source snapshots')
  }
  let closed = false
  return {
    handoff,
    handoffReceipt: loaded.receipt,
    states,
    closeAndVerify: async () => {
      if (closed) return
      closed = true
      for (const state of states) state.database.close()
      for (const state of states) {
        const after = await digestRegularFile(state.databasePath, {
          label: `Exact ${state.sourceId} state after graph build`,
          exactBytes: state.artifact.bytes,
          minimumBytes: state.artifact.bytes,
          maximumBytes: state.artifact.bytes,
        })
        if (after.sha256 !== state.artifact.sha256 || after.identity !== state.identity) {
          throw new Error(`Exact ${state.sourceId} state identity changed during graph construction`)
        }
      }
    },
  }
}

function positionRow(database: DatabaseSync, epd: string): { positionId: number; fingerprint: Uint8Array } | null {
  const row = database.prepare(`
    SELECT position_id AS positionId, fingerprint FROM positions WHERE epd = ?
  `).get(epd) as { positionId: number; fingerprint: Uint8Array } | undefined
  if (!row) return null
  const expected = Buffer.from(evidenceFingerprint({ kind: 'position', epd }), 'hex')
  if (!Buffer.from(row.fingerprint).equals(expected)) throw new Error('Exact position fingerprint differs from its EPD')
  return row
}

function outgoingRows(database: DatabaseSync, fromPositionId: number): ExactEdgeRow[] {
  return database.prepare(`
    SELECT e.edge_id AS edgeId, e.fingerprint, e.from_position_id AS fromPositionId,
      e.to_position_id AS toPositionId, source.epd AS fromEpd, target.epd AS toEpd,
      e.uci, e.san
    FROM edges e
    JOIN positions source ON source.position_id = e.from_position_id
    JOIN positions target ON target.position_id = e.to_position_id
    WHERE e.from_position_id = ?
    ORDER BY e.uci, target.epd
  `).all(fromPositionId) as unknown as ExactEdgeRow[]
}

function outcomeRows(database: DatabaseSync, kind: 'position' | 'edge', referenceId: number): OutcomeRow[] {
  return database.prepare(`
    SELECT cohort_id AS cohortId, month, time_control AS timeControl,
      rating_band AS ratingBand, rating_detail AS ratingDetail,
      n, white_wins AS whiteWins, draws, black_wins AS blackWins
    FROM outcomes WHERE kind = ? AND reference_id = ?
    ORDER BY cohort_id, time_control, rating_band, rating_detail, month
  `).all(kind, referenceId) as unknown as OutcomeRow[]
}

function assertLegalExactEdge(row: ExactEdgeRow): void {
  const source = new Chess(`${row.fromEpd} 0 1`)
  if (normalizedEpd(source) !== row.fromEpd) throw new Error(`Noncanonical exact source EPD: ${row.fromEpd}`)
  const move = source.move(moveInput(row.uci))
  if (move.san !== row.san) throw new Error(`Exact edge ${row.uci} has a SAN mismatch`)
  if (normalizedEpd(source) !== row.toEpd) throw new Error(`Exact edge ${row.uci} has a false resulting EPD`)
  const fingerprint = evidenceFingerprint({ kind: 'edge', fromEpd: row.fromEpd, uci: row.uci, toEpd: row.toEpd })
  if (!SHA256.test(fingerprint) || !Buffer.from(row.fingerprint).equals(Buffer.from(fingerprint, 'hex'))) {
    throw new Error('Exact edge fingerprint differs from its legal move identity')
  }
}

interface RawCount {
  n: number
  whiteWins: number
  draws: number
  blackWins: number
}

function zeroCount(): RawCount {
  return { n: 0, whiteWins: 0, draws: 0, blackWins: 0 }
}

function sumCount(target: RawCount, row: OutcomeRow, label: string): void {
  target.n = addSafe(target.n, row.n, `${label} N`)
  target.whiteWins = addSafe(target.whiteWins, row.whiteWins, `${label} White wins`)
  target.draws = addSafe(target.draws, row.draws, `${label} draws`)
  target.blackWins = addSafe(target.blackWins, row.blackWins, `${label} Black wins`)
}

function outcomeValue(move: RawCount, reachN: number, side: 'white' | 'black') {
  const wins = side === 'white' ? move.whiteWins : move.blackWins
  const losses = side === 'white' ? move.blackWins : move.whiteWins
  const interval = move.n === 0 ? null : trinomialScoreProfileLikelihoodInterval(wins, move.draws, losses)
  return {
    reachN,
    moveN: move.n,
    whiteWins: move.whiteWins,
    draws: move.draws,
    blackWins: move.blackWins,
    wins,
    losses,
    score: move.n === 0 ? null : (wins + move.draws * 0.5) / move.n,
    conditionalUsage: reachN === 0 ? 0 : move.n / reachN,
    scoreInterval: interval === null ? null : {
      method: TRINOMIAL_PROFILE_LIKELIHOOD_95_METHOD,
      confidenceLevel: 0.95 as const,
      ...interval,
    },
  }
}

function validateRawOutcomeRows(
  rows: readonly OutcomeRow[],
  declaration: FamilyGraphEvidenceCohortDeclarationV1,
  sourceId: ExactCorpusState['sourceId'],
): void {
  for (const row of rows) {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(row.month)) {
      throw new Error('Exact outcome row has an invalid month')
    }
    if (
      ![row.n, row.whiteWins, row.draws, row.blackWins].every((value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= MAX_APPROVED_EVIDENCE_GAMES) ||
      row.n <= 0 || row.n !== row.whiteWins + row.draws + row.blackWins
    ) {
      throw new Error('Exact outcome row has invalid W/D/L arithmetic')
    }
    if (!CANONICAL_BANDS.includes(row.ratingBand as typeof CANONICAL_BANDS[number])) {
      throw new Error(`Exact outcome row has invalid rating band ${row.ratingBand}`)
    }
    if (row.month > declaration.cutoff.slice(0, 7)) throw new Error('Exact outcome row exceeds its declared cutoff')
    if (sourceId === 'lichess-broadcasts' && row.ratingDetail !== '') {
      throw new Error('Broadcast evidence cannot contain Lichess beginner rating details')
    }
    if (sourceId === 'lichess-standard-rated-q2-2026') {
      if (row.ratingBand === '<1800' && !BEGINNER_BANDS.includes(row.ratingDetail as typeof BEGINNER_BANDS[number])) {
        throw new Error('Q2 under-1800 evidence must preserve a beginner rating detail')
      }
      if (row.ratingBand !== '<1800' && row.ratingDetail !== '') {
        throw new Error('Q2 beginner rating detail is valid only inside the canonical under-1800 band')
      }
    }
  }
}

function cohortResult(options: {
  declaration: FamilyGraphEvidenceCohortDeclarationV1
  side: 'white' | 'black'
  sourceId: ExactCorpusState['sourceId']
  positionRows: readonly OutcomeRow[]
  edgeRows: readonly OutcomeRow[]
}): EvidenceCohortResult {
  const { declaration } = options
  const matches = (row: OutcomeRow): boolean =>
    row.cohortId === declaration.cohortId && row.timeControl === declaration.timeControl
  const positionRows = options.positionRows.filter(matches)
  const edgeRows = options.edgeRows.filter(matches)
  validateRawOutcomeRows(positionRows, declaration, options.sourceId)
  validateRawOutcomeRows(edgeRows, declaration, options.sourceId)

  const canonical = CANONICAL_BANDS.map((band) => {
    const reach = zeroCount()
    const move = zeroCount()
    for (const row of positionRows.filter(({ ratingBand }) => ratingBand === band)) sumCount(reach, row, `${declaration.cohortId} reach`)
    for (const row of edgeRows.filter(({ ratingBand }) => ratingBand === band)) sumCount(move, row, `${declaration.cohortId} move`)
    return { band, ...outcomeValue(move, reach.n, options.side) }
  })
  const aggregateMove = zeroCount()
  let aggregateReach = 0
  for (const band of canonical) {
    aggregateReach = addSafe(aggregateReach, band.reachN, `${declaration.cohortId} aggregate reach`)
    aggregateMove.n = addSafe(aggregateMove.n, band.moveN, `${declaration.cohortId} aggregate N`)
    aggregateMove.whiteWins = addSafe(aggregateMove.whiteWins, band.whiteWins, 'Aggregate White wins')
    aggregateMove.draws = addSafe(aggregateMove.draws, band.draws, 'Aggregate draws')
    aggregateMove.blackWins = addSafe(aggregateMove.blackWins, band.blackWins, 'Aggregate Black wins')
  }
  const beginner = options.sourceId === 'lichess-standard-rated-q2-2026'
    ? BEGINNER_BANDS.map((band) => {
      const reach = zeroCount()
      const move = zeroCount()
      for (const row of positionRows.filter(({ ratingBand, ratingDetail }) => ratingBand === '<1800' && ratingDetail === band)) {
        sumCount(reach, row, `${declaration.cohortId} ${band} reach`)
      }
      for (const row of edgeRows.filter(({ ratingBand, ratingDetail }) => ratingBand === '<1800' && ratingDetail === band)) {
        sumCount(move, row, `${declaration.cohortId} ${band} move`)
      }
      return { band, ...outcomeValue(move, reach.n, options.side) }
    })
    : []
  return {
    cohortId: declaration.cohortId,
    source: declaration.source,
    ratingSystem: declaration.ratingSystem,
    timeControl: declaration.timeControl,
    cutoff: declaration.cutoff,
    trainedSide: options.side,
    aggregate: outcomeValue(aggregateMove, aggregateReach, options.side),
    canonicalBands: canonical,
    lichessBeginnerBands: beginner,
  }
}

function ensureNoUndeclaredEvidence(
  rows: readonly OutcomeRow[],
  sourceId: ExactCorpusState['sourceId'],
  declarations: readonly FamilyGraphEvidenceCohortDeclarationV1[],
): void {
  const declared = new Set(
    declarations
      .filter(({ exactSourceId }) => exactSourceId === sourceId)
      .map(({ cohortId, timeControl }) => `${cohortId}\0${timeControl}`),
  )
  for (const row of rows) {
    if (row.timeControl === 'unknown') throw new Error('Unknown time-control evidence cannot enter family construction')
    if (!declared.has(`${row.cohortId}\0${row.timeControl}`)) {
      throw new Error(`Exact evidence cohort ${row.cohortId}/${row.timeControl} is undeclared`)
    }
  }
}

function engineEvidence(
  check: z.infer<typeof FamilyGraphEngineProofSetV1Schema>['proofs'][number]['check'] | null,
): RepertoireBranchEvidence['engine'] {
  if (check === null) {
    return {
      status: 'unverified',
      centipawnLoss: null,
      forcedMateAgainstLearner: false,
      quarantineReasons: [],
      check: null,
    }
  }
  const quarantined = check.forcedMateAgainstLearner || (check.centipawnLoss ?? 0) >= 100
  const quarantineReasons = [
    ...(check.forcedMateAgainstLearner ? ['Stockfish found a forced mate against the trained side'] : []),
    ...((check.centipawnLoss ?? 0) >= 100 ? ['Stockfish loss is at least 100 centipawns'] : []),
  ]
  return {
    status: quarantined ? 'quarantined' : 'verified',
    centipawnLoss: check.centipawnLoss,
    forcedMateAgainstLearner: check.forcedMateAgainstLearner,
    quarantineReasons,
    check,
  }
}

async function validateProvenanceAndProofs(options: {
  receiptRoot: string
  spec: FamilyGraphPackBuildSpecV1
  verified: VerifiedCompactExactFamilyGraphHandoff
}): Promise<z.infer<typeof FamilyGraphEngineProofSetV1Schema>> {
  if (options.spec.provenanceDocument === undefined) {
    throw new Error('Final family graph construction requires a content-addressed provenance document')
  }
  if (options.spec.engineProofSet === undefined) {
    throw new Error('Final family graph construction requires a content-addressed engine proof set')
  }
  if (options.spec.engineCandidatePack === undefined) {
    throw new Error('Final family graph construction requires its exact pre-engine candidate receipt')
  }
  const provenanceLoaded = await readImmutableJsonReceipt({
    root: options.receiptRoot,
    receipt: options.spec.provenanceDocument,
    maximumStoredBytes: 16 * 1024 * 1024,
    maximumDecodedBytes: 32 * 1024 * 1024,
  })
  const provenance = FamilyGraphProvenanceDocumentV1Schema.parse(provenanceLoaded.value)
  if (provenance.releaseId !== options.spec.releaseId || provenance.familyId !== options.spec.familyId) {
    throw new Error('Family graph provenance document belongs to another release or family')
  }
  const binding = provenance.bindings.find(({ provenanceRef }) => provenanceRef === options.spec.provenanceRef)
  if (!binding) throw new Error('Family pack provenance reference has no immutable binding')
  const receipts = new Map(provenance.receipts.map((receipt) => [receipt.id, receipt]))
  const corpusKinds = new Set(binding.corpusReceiptIds.map((id) => receipts.get(id)?.kind))
  if (!corpusKinds.has('broadcast-corpus') || !corpusKinds.has('lichess-standard-corpus')) {
    throw new Error('Family pack provenance is not bound to both exact evidence cohorts')
  }
  for (const receipt of provenance.receipts) {
    const nested = await readImmutableJsonReceipt({
      root: options.receiptRoot,
      receipt: {
        path: receipt.path,
        sha256: receipt.sha256,
        bytes: receipt.bytes,
        uncompressedBytes: receipt.bytes,
        encoding: 'identity',
      },
      maximumStoredBytes: 16 * 1024 * 1024,
      maximumDecodedBytes: 16 * 1024 * 1024,
    })
    if (nested.value === null || typeof nested.value !== 'object' || Array.isArray(nested.value)) {
      throw new Error(`Nested ${receipt.kind} provenance receipt is not a JSON object`)
    }
  }
  const proofLoaded = await readImmutableJsonReceipt({
    root: options.receiptRoot,
    receipt: options.spec.engineProofSet,
    maximumStoredBytes: 64 * 1024 * 1024,
    maximumDecodedBytes: 128 * 1024 * 1024,
  })
  const proofSet = FamilyGraphEngineProofSetV1Schema.parse(proofLoaded.value)
  if (
    proofSet.releaseId !== options.spec.releaseId || proofSet.familyId !== options.spec.familyId ||
    proofSet.packId !== options.spec.packId || proofSet.provenanceRef !== options.spec.provenanceRef
  ) throw new Error('Engine proof set belongs to another release, family, pack, or provenance binding')
  const candidateLoaded = await readImmutableJsonReceipt({
    root: options.receiptRoot,
    receipt: options.spec.engineCandidatePack,
    maximumStoredBytes: 64 * 1024 * 1024,
    maximumDecodedBytes: 128 * 1024 * 1024,
  })
  const candidatePack = FamilyEngineCandidatePackV1Schema.parse(candidateLoaded.value)
  const recomputed = buildFamilyEngineCandidatePackFromVerifiedExactStates({
    verified: options.verified,
    specValue: options.spec,
  })
  if (
    hash(jsonContent(recomputed)) !== candidateLoaded.receipt.sha256 ||
    JSON.stringify(recomputed) !== JSON.stringify(candidatePack)
  ) throw new Error('Engine candidate pack differs from a fresh traversal of the exact source states')
  if (
    proofSet.candidatePackSha256 !== candidateLoaded.receipt.sha256 ||
    proofSet.empiricalInventorySha256 !== candidatePack.empiricalInventorySha256
  ) throw new Error('Engine proof set is not bound to the exact empirical candidate inventory')
  const expectedProofKeys = candidatePack.learnerNodes.flatMap(({ candidateEdges }) =>
    candidateEdges.map(({ fromEpd, uci, toEpd }) => engineProofKey(fromEpd, uci, toEpd))).sort()
  const actualProofKeys = proofSet.proofs.map(({ fromEpd, uci, toEpd }) =>
    engineProofKey(fromEpd, uci, toEpd)).sort()
  if (
    expectedProofKeys.length !== actualProofKeys.length ||
    expectedProofKeys.some((key, index) => key !== actualProofKeys[index])
  ) throw new Error('Engine proof inventory is not exactly equal to every empirical learner candidate edge')
  const engineReceipt = receipts.get(binding.engineReceiptId)
  if (
    !engineReceipt || engineReceipt.kind !== 'engine' ||
    engineReceipt.path !== proofLoaded.receipt.path || engineReceipt.sha256 !== proofLoaded.receipt.sha256 ||
    engineReceipt.bytes !== proofLoaded.receipt.bytes || proofLoaded.receipt.encoding !== 'identity'
  ) throw new Error('Engine proof set is not the exact engine receipt bound by graph provenance')
  return proofSet
}

function edgeRowsAtPosition(states: readonly ExactCorpusState[], epd: string): {
  positionBySource: Map<ExactCorpusState['sourceId'], { state: ExactCorpusState; positionId: number }>
  edges: Map<string, SourceEdgeStateRow[]>
} {
  const positionBySource = new Map<ExactCorpusState['sourceId'], { state: ExactCorpusState; positionId: number }>()
  const edges = new Map<string, SourceEdgeStateRow[]>()
  for (const state of states) {
    const position = positionRow(state.database, epd)
    if (!position) continue
    positionBySource.set(state.sourceId, { state, positionId: position.positionId })
    for (const row of outgoingRows(state.database, position.positionId)) {
      assertLegalExactEdge(row)
      const key = `${row.fromEpd}\0${row.uci}`
      const existing = edges.get(key) ?? []
      if (existing.some(({ row: prior }) => prior.toEpd !== row.toEpd || prior.san !== row.san)) {
        throw new Error(`Exact corpora disagree about ${row.uci} from ${row.fromEpd}`)
      }
      existing.push({ state, row, fromPositionId: position.positionId })
      edges.set(key, existing)
    }
  }
  return { positionBySource, edges }
}

function buildBranchEvidence(options: {
  spec: FamilyGraphPackBuildSpecV1
  sourceRows: readonly SourceEdgeStateRow[]
  positionBySource: ReadonlyMap<ExactCorpusState['sourceId'], { state: ExactCorpusState; positionId: number }>
  check: z.infer<typeof FamilyGraphEngineProofSetV1Schema>['proofs'][number]['check'] | null
}): RepertoireBranchEvidence {
  const cohorts: EvidenceCohortResult[] = []
  for (const declaration of options.spec.cohorts) {
    const position = options.positionBySource.get(declaration.exactSourceId)
    const sourceEdge = options.sourceRows.find(({ state }) => state.sourceId === declaration.exactSourceId)
    const positionRows = position ? outcomeRows(position.state.database, 'position', position.positionId) : []
    const edgeRows = sourceEdge ? outcomeRows(sourceEdge.state.database, 'edge', sourceEdge.row.edgeId) : []
    ensureNoUndeclaredEvidence(positionRows, declaration.exactSourceId, options.spec.cohorts)
    ensureNoUndeclaredEvidence(edgeRows, declaration.exactSourceId, options.spec.cohorts)
    cohorts.push(cohortResult({
      declaration,
      side: options.spec.side,
      sourceId: declaration.exactSourceId,
      positionRows,
      edgeRows,
    }))
  }
  const selected = cohorts.find(({ cohortId }) => cohortId === options.spec.selectionCohortId)
  if (!selected) throw new Error('Selection cohort disappeared during evidence construction')
  return RepertoireBranchEvidenceSchema.parse({
    cohorts,
    selectionCohortId: options.spec.selectionCohortId,
    conditionalUsage: selected.aggregate.conditionalUsage,
    engine: engineEvidence(options.check),
  })
}

function engineProofKey(fromEpd: string, uci: string, toEpd: string): string {
  return `${fromEpd}\0${uci}\0${toEpd}`
}

function roleAndEligibility(
  evidence: RepertoireBranchEvidence,
  identity: string,
  learnerTurn: boolean,
): { role: RepertoireEdge['role']; eligibleForDrill: boolean } | null {
  const maximumN = Math.max(...evidence.cohorts.map(({ aggregate }) => aggregate.moveN))
  if (maximumN < MINIMUM_EXPLORATORY_SAMPLE) return null
  if (maximumN < MINIMUM_DRILL_SAMPLE) return { role: 'exploratory', eligibleForDrill: false }
  if (!learnerTurn) {
    if (evidence.engine.status !== 'unverified') {
      throw new Error(`Opponent edge ${identity} must use empirical evidence rather than a learner-engine proof`)
    }
    return { role: 'book', eligibleForDrill: true }
  }
  const engine = evidence.engine
  if (engine.status === 'unverified' || engine.centipawnLoss === null) {
    throw new Error(`N>=500 edge ${identity} lacks a classifiable exact Stockfish proof`)
  }
  if (engine.status === 'quarantined') return { role: 'book', eligibleForDrill: false }
  if (engine.centipawnLoss > 50) {
    return { role: 'inaccuracy', eligibleForDrill: false }
  }
  return { role: 'book', eligibleForDrill: true }
}

function matchingFamilyTag(spec: FamilyGraphPackBuildSpecV1, moves: readonly string[]): string {
  const matching = spec.branchRules
    .filter(({ movePrefix }) => movePrefix.length <= moves.length && movePrefix.every((move, index) => moves[index] === move))
    .sort((left, right) => right.movePrefix.length - left.movePrefix.length || left.id.localeCompare(right.id, 'en'))
  if (matching.length > 1 && matching[0]!.movePrefix.length === matching[1]!.movePrefix.length) {
    throw new Error(`Ambiguous equal-depth branch rules ${matching[0]!.id} and ${matching[1]!.id}`)
  }
  return matching[0]?.canonicalName ?? spec.canonicalName
}

function emittedEdge(edge: GraphEdgeWork, provenanceRef: string): RepertoireEdge {
  return {
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    uci: edge.uci,
    san: edge.san,
    role: edge.role,
    eligibleForDrill: edge.eligibleForDrill,
    acceptedBookTransposition: edge.acceptedBookTransposition,
    evidence: edge.evidence,
    provenanceRef,
  }
}

/**
 * Pre-engine traversal. It deliberately over-includes every reachable N>=500
 * empirical learner edge; the later Stockfish campaign may quarantine an edge
 * but cannot discover or add one outside this exact receipt-bound inventory.
 */
export function buildFamilyEngineCandidatePackFromVerifiedExactStates(options: {
  verified: VerifiedCompactExactFamilyGraphHandoff
  specValue: unknown
}): FamilyEngineCandidatePackV1 {
  const spec = FamilyGraphPackBuildSpecV1Schema.parse(options.specValue)
  if (spec.releaseId !== options.verified.handoff.releaseId) {
    throw new Error('Family engine candidate spec belongs to another exact-state release')
  }
  const root = new Chess(`${spec.rootEpd} 0 1`)
  if (normalizedEpd(root) !== spec.rootEpd) throw new Error('Family engine candidate root EPD is not canonical')
  const queue: Array<{ epd: string; absolutePly: number }> = [{ epd: spec.rootEpd, absolutePly: spec.rootPly }]
  const visited = new Map<string, number>()
  const empiricalEdges = new Map<string, { fromEpd: string; uci: string; toEpd: string }>()
  const candidatesByEpd = new Map<string, Array<{ fromEpd: string; uci: string; toEpd: string }>>()
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!
    const priorDepth = visited.get(current.epd)
    if (priorDepth !== undefined && priorDepth <= current.absolutePly) continue
    visited.set(current.epd, current.absolutePly)
    const { positionBySource, edges } = edgeRowsAtPosition(options.verified.states, current.epd)
    if (positionBySource.size === 0) throw new Error(`Engine candidate position is absent from exact evidence: ${current.epd}`)
    for (const sourceRows of edges.values()) {
      const row = sourceRows[0]!.row
      const evidence = buildBranchEvidence({ spec, sourceRows, positionBySource, check: null })
      const maximumN = Math.max(...evidence.cohorts.map(({ aggregate }) => aggregate.moveN))
      if (maximumN < MINIMUM_DRILL_SAMPLE) continue
      const identity = engineProofKey(row.fromEpd, row.uci, row.toEpd)
      empiricalEdges.set(identity, { fromEpd: row.fromEpd, uci: row.uci, toEpd: row.toEpd })
      const learnerTurn = row.fromEpd.split(' ')[1] === (spec.side === 'white' ? 'w' : 'b')
      if (learnerTurn) {
        const candidates = candidatesByEpd.get(row.fromEpd) ?? []
        candidates.push({ fromEpd: row.fromEpd, uci: row.uci, toEpd: row.toEpd })
        candidatesByEpd.set(row.fromEpd, candidates)
      }
      if (current.absolutePly + 1 < REPERTOIRE_MAX_PLY) {
        queue.push({ epd: row.toEpd, absolutePly: current.absolutePly + 1 })
      }
      if (visited.size + queue.length > spec.limits.maximumNodes * 2) {
        throw new Error('Engine candidate traversal exceeded its bounded node work queue')
      }
      if (empiricalEdges.size > spec.limits.maximumEdges) {
        throw new Error('Engine candidate traversal exceeded its empirical-edge hard cap')
      }
    }
  }
  const inventory = [...empiricalEdges.values()].sort((left, right) =>
    left.fromEpd.localeCompare(right.fromEpd, 'en') || left.uci.localeCompare(right.uci, 'en') ||
    left.toEpd.localeCompare(right.toEpd, 'en'))
  const empiricalInventorySha256 = hash(`${JSON.stringify(inventory)}\n`)
  const learnerNodes = [...candidatesByEpd.entries()]
    .map(([epd, candidateEdges]) => ({
      positionId: stablePositionId(epd),
      epd,
      learnerSide: spec.side,
      candidateEdges: candidateEdges.sort((left, right) =>
        left.uci.localeCompare(right.uci, 'en') || left.toEpd.localeCompare(right.toEpd, 'en')),
    }))
    .sort((left, right) => left.positionId.localeCompare(right.positionId, 'en'))
  return FamilyEngineCandidatePackV1Schema.parse({
    schemaVersion: 1,
    kind: 'linerecall-family-engine-candidate-pack',
    releaseId: spec.releaseId,
    familyId: spec.familyId,
    packId: spec.packId,
    side: spec.side,
    provenanceRef: spec.provenanceRef,
    empiricalInventorySha256,
    learnerNodes,
  })
}

/**
 * Construct one family/side pack from exact position evidence. Traversal is
 * bounded by explicit hard caps and aborts instead of truncating eligible data.
 */
export async function buildFamilyGraphFromVerifiedExactStates(options: {
  receiptRoot: string
  verified: VerifiedCompactExactFamilyGraphHandoff
  specValue: unknown
}): Promise<{
  graph: RepertoireGraphDocument
  inventory: EligibleSourceEdgeInventoryV1
}> {
  const spec = FamilyGraphPackBuildSpecV1Schema.parse(options.specValue)
  if (spec.releaseId !== options.verified.handoff.releaseId) {
    throw new Error('Family pack spec belongs to another exact-state release')
  }
  const root = new Chess(`${spec.rootEpd} 0 1`)
  if (normalizedEpd(root) !== spec.rootEpd) throw new Error('Family pack root EPD is not canonical')
  if ((spec.rootEpd.split(' ')[1] === 'w' ? spec.rootPly % 2 === 0 : spec.rootPly % 2 === 1) === false) {
    throw new Error('Family pack root ply is inconsistent with side to move')
  }
  const proofSet = await validateProvenanceAndProofs({
    receiptRoot: options.receiptRoot,
    spec,
    verified: options.verified,
  })
  const proofs = new Map(proofSet.proofs.map((proof) => [engineProofKey(proof.fromEpd, proof.uci, proof.toEpd), proof.check]))
  const nodesByEpd = new Map<string, { id: string; depth: number; outgoing: string[] }>()
  const edgesByKey = new Map<string, GraphEdgeWork>()
  const queue: string[] = [spec.rootEpd]
  const enqueued = new Set<string>(queue)
  nodesByEpd.set(spec.rootEpd, { id: stablePositionId(spec.rootEpd), depth: spec.rootPly, outgoing: [] })

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const epd = queue[queueIndex]!
    const sourceNode = nodesByEpd.get(epd)!
    const { positionBySource, edges } = edgeRowsAtPosition(options.verified.states, epd)
    if (positionBySource.size === 0) throw new Error(`Family graph position is absent from both exact states: ${epd}`)
    for (const sourceRows of edges.values()) {
      const row = sourceRows[0]!.row
      const identity = engineProofKey(row.fromEpd, row.uci, row.toEpd)
      const check = proofs.get(identity) ?? null
      const evidence = buildBranchEvidence({ spec, sourceRows, positionBySource, check })
      const learnerTurn = row.fromEpd.split(' ')[1] === (spec.side === 'white' ? 'w' : 'b')
      const classification = roleAndEligibility(evidence, `${row.uci} at ${row.fromEpd}`, learnerTurn)
      if (classification === null) continue
      const destinationDepth = sourceNode.depth + 1
      if (destinationDepth > REPERTOIRE_MAX_PLY) continue
      let destination = nodesByEpd.get(row.toEpd)
      if (!destination) {
        destination = { id: stablePositionId(row.toEpd), depth: destinationDepth, outgoing: [] }
        nodesByEpd.set(row.toEpd, destination)
      } else {
        destination.depth = Math.min(destination.depth, destinationDepth)
      }
      const id = stableEdgeId(row.fromEpd, row.uci, row.toEpd)
      if (edgesByKey.has(identity)) throw new Error(`Duplicate emitted exact edge ${identity}`)
      const edge: GraphEdgeWork = {
        key: identity,
        fromEpd: row.fromEpd,
        toEpd: row.toEpd,
        uci: row.uci,
        san: row.san,
        fromDepth: sourceNode.depth,
        evidence,
        ...classification,
        acceptedBookTransposition: false,
        id,
        fromNodeId: sourceNode.id,
        toNodeId: destination.id,
      }
      edgesByKey.set(identity, edge)
      sourceNode.outgoing.push(id)
      if (classification.eligibleForDrill && destinationDepth < REPERTOIRE_MAX_PLY && !enqueued.has(row.toEpd)) {
        queue.push(row.toEpd)
        enqueued.add(row.toEpd)
      }
      if (nodesByEpd.size > spec.limits.maximumNodes) throw new Error('Family graph exceeded its node hard cap; no partial output was emitted')
      if (edgesByKey.size > spec.limits.maximumEdges) throw new Error('Family graph exceeded its edge hard cap; no partial output was emitted')
    }
  }
  const eligibleEdges = [...edgesByKey.values()].filter(({ eligibleForDrill }) => eligibleForDrill)
  if (eligibleEdges.length === 0) throw new Error('Family pack has no sampled, engine-approved drill edge')
  const incoming = new Map<string, GraphEdgeWork[]>()
  const eligibleOutgoing = new Map<string, GraphEdgeWork[]>()
  const allOutgoing = new Map<string, GraphEdgeWork[]>()
  for (const edge of edgesByKey.values()) {
    const all = allOutgoing.get(edge.fromNodeId) ?? []
    all.push(edge)
    allOutgoing.set(edge.fromNodeId, all)
    if (!edge.eligibleForDrill) continue
    const from = eligibleOutgoing.get(edge.fromNodeId) ?? []
    from.push(edge)
    eligibleOutgoing.set(edge.fromNodeId, from)
    const to = incoming.get(edge.toNodeId) ?? []
    to.push(edge)
    incoming.set(edge.toNodeId, to)
  }
  for (const edges of [...eligibleOutgoing.values(), ...allOutgoing.values()]) {
    edges.sort((left, right) => left.uci.localeCompare(right.uci, 'en') || left.toEpd.localeCompare(right.toEpd, 'en'))
  }
  for (const edge of eligibleEdges) {
    edge.acceptedBookTransposition = (incoming.get(edge.toNodeId)?.length ?? 0) > 1
      && (eligibleOutgoing.get(edge.toNodeId)?.length ?? 0) > 0
  }

  const rootNodeId = stablePositionId(spec.rootEpd)
  const pathWork: Array<{ nodeIds: string[]; edges: GraphEdgeWork[] }> = []
  const walk = (nodeId: string, absolutePly: number, nodeIds: string[], edges: GraphEdgeWork[], active: Set<string>): void => {
    if (active.has(nodeId)) throw new Error('Exact family graph contains a drillable EPD cycle')
    const continuations = absolutePly >= REPERTOIRE_MAX_PLY ? [] : (eligibleOutgoing.get(nodeId) ?? [])
    if (continuations.length === 0) {
      if (edges.length > 0) pathWork.push({ nodeIds, edges })
      if (pathWork.length > spec.limits.maximumPaths) throw new Error('Family graph exceeded its path hard cap; no eligible path was truncated')
      return
    }
    const nextActive = new Set(active).add(nodeId)
    for (const edge of continuations) {
      walk(edge.toNodeId, absolutePly + 1, [...nodeIds, edge.toNodeId], [...edges, edge], nextActive)
    }
  }
  walk(rootNodeId, spec.rootPly, [rootNodeId], [], new Set())
  if (pathWork.length === 0) throw new Error('Family pack has no root-to-terminal drill path')

  const nodeEpdById = new Map([...nodesByEpd.entries()].map(([epd, node]) => [node.id, epd]))
  const paths: RepertoirePath[] = pathWork.map(({ nodeIds, edges }) => {
    const terminalPly = spec.rootPly + edges.length
    const terminalNodeId = nodeIds.at(-1)!
    const terminalOutgoing = allOutgoing.get(terminalNodeId) ?? []
    const terminalStatus = classifyBookTerminalStatus({
      terminalPly,
      hasEligibleContinuation: terminalOutgoing.some(({ eligibleForDrill }) => eligibleForDrill),
      hasExploratoryContinuation: terminalOutgoing.some(({ role }) => role === 'exploratory'),
      hasQuarantinedContinuation: terminalOutgoing.some(({ role, evidence }) =>
        role === 'book' && evidence.engine.status === 'quarantined'),
    })
    const edgeIds = edges.map(({ id }) => id)
    const moves = edges.map(({ uci }) => uci)
    const learnerDecisionCount = nodeIds.slice(0, -1).filter((nodeId) => {
      const epd = nodeEpdById.get(nodeId)!
      return epd.split(' ')[1] === (spec.side === 'white' ? 'w' : 'b')
    }).length
    const conditionalUsage = edges.reduce((product, edge) => {
      const cohort = edge.evidence.cohorts.find(({ cohortId }) => cohortId === spec.selectionCohortId)!
      return product * cohort.aggregate.conditionalUsage
    }, 1)
    return {
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id: stablePathId(spec.packId, edgeIds),
      packId: spec.packId,
      nodeIds,
      edgeIds,
      learnerDecisionCount,
      terminalPly,
      terminalStatus,
      familyTags: [matchingFamilyTag(spec, moves)],
      conditionalUsage,
      provenanceRef: spec.provenanceRef,
    }
  })

  const emittedEdges = [...edgesByKey.values()]
    .map((edge) => emittedEdge(edge, spec.provenanceRef))
    .sort((left, right) => left.id.localeCompare(right.id, 'en'))
  const eligibleReachable = new Set<string>([rootNodeId])
  for (const path of paths) for (const nodeId of path.nodeIds) eligibleReachable.add(nodeId)
  const nodes: RepertoireNode[] = [...nodesByEpd.entries()].map(([epd, node]) => {
    const learnerTurn = epd.split(' ')[1] === (spec.side === 'white' ? 'w' : 'b')
    return {
      schemaVersion: REPERTOIRE_SCHEMA_VERSION,
      id: node.id,
      epd,
      learnerTurn,
      outgoingEdgeIds: [...node.outgoing].sort(),
      ...(learnerTurn && eligibleReachable.has(node.id) ? { cardId: stableRepertoireCardId(spec.packId, node.id) } : {}),
      provenanceRef: spec.provenanceRef,
    }
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'))
  let opponentBranchCountAfterRoot = 0
  for (const node of nodes) {
    if (node.id === rootNodeId || node.learnerTurn || !eligibleReachable.has(node.id)) continue
    opponentBranchCountAfterRoot = Math.max(
      opponentBranchCountAfterRoot,
      node.outgoingEdgeIds.filter((id) => emittedEdges.find((edge) => edge.id === id)?.eligibleForDrill).length,
    )
  }
  const coreDepth = Math.max(...paths.map(({ learnerDecisionCount }) => learnerDecisionCount)
  )
  const pack: RepertoireGraphDocument['pack'] = {
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    id: spec.packId,
    side: spec.side,
    rootNodeId,
    rootPly: spec.rootPly,
    tier: classifyRepertoireTier(coreDepth, opponentBranchCountAfterRoot),
    coreDepth,
    opponentBranchCountAfterRoot,
    coverage: Math.min(1, paths.reduce((sum, path) => sum + path.conditionalUsage, 0)),
    ecoCodes: [...spec.ecoCodes].sort(),
    nodeIds: nodes.map(({ id }) => id),
    edgeIds: emittedEdges.map(({ id }) => id),
    pathIds: [],
    provenanceRef: spec.provenanceRef,
  }
  const rankingGraph: RepertoireGraphDocument = {
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    releaseId: spec.releaseId,
    pack,
    nodes,
    edges: emittedEdges,
    paths,
  }
  const pathValues = new Map(paths.map((path) => [path.id, trainingValueSummaryForPath(rankingGraph, path)]))
  paths.sort((left, right) => compareTrainingValueSummaries(
    pathValues.get(left.id)!,
    pathValues.get(right.id)!,
    left.id,
    right.id,
  ))
  const bestPathByEdgeId = new Map<string, RepertoirePath>()
  for (const path of paths) {
    for (const edgeId of path.edgeIds) bestPathByEdgeId.set(edgeId, bestPathByEdgeId.get(edgeId) ?? path)
  }
  const edgeById = new Map(emittedEdges.map((edge) => [edge.id, edge]))
  for (const node of nodes) {
    node.outgoingEdgeIds.sort((leftId, rightId) => {
      const leftPath = bestPathByEdgeId.get(leftId)
      const rightPath = bestPathByEdgeId.get(rightId)
      if (leftPath && rightPath) {
        return compareTrainingValueSummaries(
          pathValues.get(leftPath.id)!,
          pathValues.get(rightPath.id)!,
          edgeById.get(leftId)?.uci ?? leftId,
          edgeById.get(rightId)?.uci ?? rightId,
        )
      }
      if (leftPath) return -1
      if (rightPath) return 1
      return (edgeById.get(leftId)?.uci ?? leftId).localeCompare(edgeById.get(rightId)?.uci ?? rightId, 'en')
    })
  }
  pack.pathIds = paths.map(({ id }) => id)
  const graphValue: RepertoireGraphDocument = {
    schemaVersion: REPERTOIRE_SCHEMA_VERSION,
    releaseId: spec.releaseId,
    pack,
    nodes,
    edges: emittedEdges,
    paths,
  }
  const graph = await validateRepertoireGraphDocument(graphValue)
  const inventory: EligibleSourceEdgeInventoryV1 = {
    schemaVersion: 1,
    releaseId: spec.releaseId,
    packId: spec.packId,
    sourceReceiptSha256: options.verified.handoffReceipt.sha256,
    eligibleEdgeIds: eligibleEdges.map(({ id }) => id).sort(),
  }
  validateEligibleSourceEdgeInventory(graph, inventory)
  return { graph, inventory }
}

function jsonContent(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
}

async function immutableJsonResource(options: {
  root: string
  prefix: string
  value: unknown
}): Promise<ImmutableJsonReceiptV1> {
  const bytes = jsonContent(options.value)
  const sha256 = hash(bytes)
  const path = `${options.prefix}/${sha256}.json`
  const receipt = ImmutableJsonReceiptV1Schema.parse({
    path,
    sha256,
    bytes: bytes.byteLength,
    uncompressedBytes: bytes.byteLength,
    encoding: 'identity',
  })
  try {
    await access(safeOutputPath(options.root, path))
    const existing = await readImmutableJsonReceipt({ root: options.root, receipt })
    if (hash(existing.storedBytes) !== sha256) throw new Error(`Existing content-addressed resource differs: ${path}`)
    return receipt
  } catch (error) {
    if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
  }
  const candidate = await writeImmutableJsonCandidate({ root: options.root, outputPath: path, value: options.value })
  if (candidate.sha256 !== sha256 || candidate.bytes !== bytes.byteLength) {
    await candidate.discard()
    throw new Error('Immutable JSON serialization changed during content-addressed promotion')
  }
  await candidate.promote()
  return receipt
}

export async function buildFamilyEngineCandidateResourcesV3(options: {
  receiptRoot: string
  artifactRoot: string
  outputRoot: string
  outputPath: string
  requestValue: unknown
}): Promise<{ request: FamilyEngineCampaignRequestV1; receipt: ImmutableJsonReceiptV1 }> {
  const request = FamilyGraphBuildRequestV1Schema.parse(options.requestValue)
  const verified = await openVerifiedCompactExactFamilyGraphHandoff({
    receiptRoot: options.receiptRoot,
    artifactRoot: options.artifactRoot,
    handoffReceipt: request.handoff,
  })
  try {
    const candidatePacks: ImmutableJsonReceiptV1[] = []
    for (const specReceipt of request.packSpecs) {
      const loaded = await readImmutableJsonReceipt({
        root: options.receiptRoot,
        receipt: specReceipt,
        maximumStoredBytes: 64 * 1024 * 1024,
        maximumDecodedBytes: 128 * 1024 * 1024,
      })
      const spec = FamilyGraphPackBuildSpecV1Schema.parse(loaded.value)
      const candidate = buildFamilyEngineCandidatePackFromVerifiedExactStates({ verified, specValue: spec })
      candidatePacks.push(await immutableJsonResource({
        root: options.outputRoot,
        prefix: `family-engine-candidates/${candidate.releaseId}/${candidate.packId}`,
        value: candidate,
      }))
    }
    candidatePacks.sort((left, right) => left.path.localeCompare(right.path, 'en'))
    // Candidate blobs are inert until this request is promoted. Re-hash and
    // close both exact databases before publishing the request that makes the
    // blobs discoverable by the engine campaign.
    await verified.closeAndVerify()
    const campaignRequest = FamilyEngineCampaignRequestV1Schema.parse({
      schemaVersion: 1,
      kind: 'linerecall-stockfish-18-family-campaign-request',
      releaseId: verified.handoff.releaseId,
      settings: FAMILY_ENGINE_SETTINGS,
      candidatePacks,
    })
    const content = jsonContent(campaignRequest)
    const receipt = ImmutableJsonReceiptV1Schema.parse({
      path: options.outputPath,
      sha256: hash(content),
      bytes: content.byteLength,
      uncompressedBytes: content.byteLength,
      encoding: 'identity',
    })
    try {
      await access(safeOutputPath(options.outputRoot, options.outputPath))
      await readImmutableJsonReceipt({ root: options.outputRoot, receipt })
      return { request: campaignRequest, receipt }
    } catch (error) {
      if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
    }
    const promoted = await writeImmutableJsonCandidate({
      root: options.outputRoot,
      outputPath: options.outputPath,
      value: campaignRequest,
    })
    if (promoted.sha256 !== receipt.sha256 || promoted.bytes !== receipt.bytes) {
      await promoted.discard()
      throw new Error('Engine campaign request serialization changed before promotion')
    }
    await promoted.promote()
    return { request: campaignRequest, receipt }
  } finally {
    await verified.closeAndVerify()
  }
}

/** Pack-granular resume: already verified content-addressed resources are reused. */
export async function buildFamilyGraphCandidatesV3(options: {
  receiptRoot: string
  artifactRoot: string
  outputRoot: string
  outputPath: string
  requestValue: unknown
}): Promise<{ output: FamilyGraphBuildOutputV1; receipt: ImmutableJsonReceiptV1 }> {
  const request = FamilyGraphBuildRequestV1Schema.parse(options.requestValue)
  const verified = await openVerifiedCompactExactFamilyGraphHandoff({
    receiptRoot: options.receiptRoot,
    artifactRoot: options.artifactRoot,
    handoffReceipt: request.handoff,
  })
  try {
    const packs: FamilyGraphBuildOutputV1['packs'] = []
    for (const specReceipt of request.packSpecs) {
      const loaded = await readImmutableJsonReceipt({
        root: options.receiptRoot,
        receipt: specReceipt,
        maximumStoredBytes: 64 * 1024 * 1024,
        maximumDecodedBytes: 128 * 1024 * 1024,
      })
      const spec = FamilyGraphPackBuildSpecV1Schema.parse(loaded.value)
      const built = await buildFamilyGraphFromVerifiedExactStates({
        receiptRoot: options.receiptRoot,
        verified,
        specValue: spec,
      })
      const prefix = `family-graph-candidates/${spec.releaseId}/${spec.packId}`
      const graph = await immutableJsonResource({ root: options.outputRoot, prefix: `${prefix}/graphs`, value: built.graph })
      const eligibleInventory = await immutableJsonResource({ root: options.outputRoot, prefix: `${prefix}/inventories`, value: built.inventory })
      packs.push({
        familyId: spec.familyId,
        packId: spec.packId,
        graph,
        eligibleInventory,
        sourceExactStateSha256s: verified.states.map(({ artifact }) => artifact.sha256).sort() as [string, string],
      })
    }
    packs.sort((left, right) => left.packId.localeCompare(right.packId, 'en'))
    // Graph/inventory blobs remain unreferenced if this identity recheck fails;
    // never publish the build manifest before both exact states are closed and
    // proven unchanged.
    await verified.closeAndVerify()
    const output = FamilyGraphBuildOutputV1Schema.parse({
      schemaVersion: 1,
      kind: 'linerecall-compact-v3-family-graph-build-output',
      releaseId: verified.handoff.releaseId,
      exactHandoffSha256: verified.handoffReceipt.sha256,
      selectionPolicy: {
        practiceBranches: 'all-eligible-audited',
        maximumPracticeBranches: null,
        minimumDrillSample: 500,
        minimumExploratorySample: 100,
        maximumPly: 100,
      },
      packs,
    })
    const content = jsonContent(output)
    const expectedReceipt = ImmutableJsonReceiptV1Schema.parse({
      path: options.outputPath,
      sha256: hash(content),
      bytes: content.byteLength,
      uncompressedBytes: content.byteLength,
      encoding: 'identity',
    })
    try {
      await access(safeOutputPath(options.outputRoot, options.outputPath))
      await readImmutableJsonReceipt({ root: options.outputRoot, receipt: expectedReceipt })
      return { output, receipt: expectedReceipt }
    } catch (error) {
      if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
    }
    const candidate = await writeImmutableJsonCandidate({ root: options.outputRoot, outputPath: options.outputPath, value: output })
    if (candidate.sha256 !== expectedReceipt.sha256 || candidate.bytes !== expectedReceipt.bytes) {
      await candidate.discard()
      throw new Error('Family graph output manifest serialization changed before promotion')
    }
    await candidate.promote()
    return { output, receipt: expectedReceipt }
  } finally {
    await verified.closeAndVerify()
  }
}

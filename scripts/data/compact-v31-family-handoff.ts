#!/usr/bin/env node
/**
 * Deep compact-v3.1 to family/side handoff.
 *
 * This module intentionally has no corpus adapter and performs no network or
 * engine work.  It consumes only already audited, content-addressed receipts,
 * then replays the pinned taxonomy to discover legal roots and edge ownership.
 */
import { createHash } from 'node:crypto'
import { Chess } from 'chess.js'
import { readFile } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRegularFileBound } from '../security/lib/files.ts'
import { EpdSchema } from '../../src/domain/opening-data.ts'
import { TaxonomySourceManifestSchema } from '../../src/data/taxonomy-schema.ts'
import { FamilyIdSchema, FamilyPackIdSchema, FamilyReleaseIdSchema } from '../../src/domain/opening-family.ts'
import { validateOpeningFamilyEditorialLedger, type OpeningFamilyEditorialLedgerV1 } from '../../src/domain/opening-family-editorial.ts'
import {
  PinnedTaxonomyInventoryV1Schema,
  validatePinnedTaxonomyInventory,
  type PinnedTaxonomyInventoryV1,
} from './taxonomy-inventory.ts'
import {
  CompactV31ProductionExactEdgeRowSchema,
  CompactV31ProductionMergeReceiptSchema,
} from './compact-v31-production-contracts.ts'
import {
  auditCompactV31ProductionCorpusChain,
  verifyCompactV31ProductionFileReceipt,
} from './compact-v31-production-chain-audit.ts'
import {
  CompactV31FamilyEligibilityIndexSchema,
  CompactV31FamilyRootEdgeInventorySchema,
  type DeepVerifiedCorpusBinding,
} from './compact-v31-family-eligibility.ts'
import {
  ImmutableJsonReceiptV1Schema,
  readImmutableJsonReceipt,
  safeOutputPath,
  writeImmutableJsonCandidate,
  type ImmutableJsonReceiptV1,
} from '../release/lib/immutable-json-receipt.ts'

const MAX_CONTROL_BYTES = 128 * 1024 * 1024
const MAX_NDJSON_LINE_BYTES = 16 * 1024
/** Maximum exact rows retained by the bounded handoff index. */
export const MAX_HANDOFF_EXACT_EDGE_ROWS = 1_000_000
const DEFAULT_COMPLETED_AT = '1970-01-01T00:00:00.000Z'
const SHA256 = /^[a-f0-9]{64}$/u
type FileReceipt = { path: string; bytes: number; sha256: string }
type Side = 'white' | 'black'
type EdgeRow = ReturnType<typeof CompactV31ProductionExactEdgeRowSchema.parse>
export type CompactV31FamilyRootHint = { familyId: string; side: Side; rootEpd: string }
type RootHint = CompactV31FamilyRootHint

function digest(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex') }
function fileCore(value: unknown): FileReceipt {
  const receipt = ImmutableJsonReceiptV1Schema.parse(value)
  return { path: receipt.path, bytes: receipt.bytes, sha256: receipt.sha256 }
}
function sameEdge(left: EdgeRow, right: EdgeRow): boolean {
  return left.edgeId === right.edgeId && left.fromEpdSha256 === right.fromEpdSha256 &&
    left.toEpdSha256 === right.toEpdSha256 && left.uci === right.uci
}
function uci(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`
}
function canonicalEpd(chess: Chess): string {
  const fields = chess.fen().split(' ')
  return fields.slice(0, 4).join(' ')
}
function hashEpd(epd: string): string { return digest(epd) }
function sideAt(epd: string): Side { return epd.split(' ')[1] === 'w' ? 'white' : 'black' }
function safeInputPath(root: string, requested: string): string {
  // Use the shared canonical receipt path rules on both Windows and POSIX.
  return safeOutputPath(root, requested)
}

async function identityReceipt(root: string, requested: string): Promise<ImmutableJsonReceiptV1> {
  const path = safeInputPath(root, requested)
  const bytes = await readRegularFileBound(path, MAX_CONTROL_BYTES)
  if (bytes.byteLength === 0) throw new Error(`Invalid handoff control file: ${requested}`)
  const receipt = { path: relative(root, path).replaceAll('\\', '/'), bytes: bytes.byteLength, sha256: digest(bytes), uncompressedBytes: bytes.byteLength, encoding: 'identity' as const }
  return ImmutableJsonReceiptV1Schema.parse(receipt)
}
async function readJson(root: string, receipt: FileReceipt): Promise<unknown> {
  return (await readImmutableJsonReceipt({ root, receipt: { ...receipt, uncompressedBytes: receipt.bytes, encoding: 'identity' }, maximumStoredBytes: MAX_CONTROL_BYTES, maximumDecodedBytes: MAX_CONTROL_BYTES })).value
}

async function* readNdjson(root: string, receipt: FileReceipt): AsyncGenerator<EdgeRow> {
  const path = safeInputPath(root, receipt.path)
  const handle = await open(path, 'r')
  const fileHash = createHash('sha256')
  const chunk = Buffer.alloc(64 * 1024)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let offset = 0
  let carry = ''
  let previous: string | null = null
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size !== receipt.bytes) throw new Error(`Exact partition receipt changed: ${receipt.path}`)
    while (offset < receipt.bytes) {
      const requested = Math.min(chunk.byteLength, receipt.bytes - offset)
      const { bytesRead } = await handle.read(chunk, 0, requested, offset)
      if (bytesRead < 1) throw new Error(`Exact partition receipt changed while reading: ${receipt.path}`)
      const bytes = chunk.subarray(0, bytesRead)
      offset += bytesRead
      fileHash.update(bytes)
      carry += decoder.decode(bytes, { stream: true })
      while (true) {
        const newline = carry.indexOf('\n')
        if (newline < 0) break
        const line = carry.slice(0, newline)
        carry = carry.slice(newline + 1)
        if (line.length === 0 || line.includes('\r') || Buffer.byteLength(line, 'utf8') > MAX_NDJSON_LINE_BYTES) throw new Error(`Exact edge row is empty, non-canonical, or oversized: ${receipt.path}`)
        const row = CompactV31ProductionExactEdgeRowSchema.parse(JSON.parse(line))
        if (previous !== null && previous >= row.edgeId) throw new Error(`Exact edge rows are not strictly sorted: ${receipt.path}`)
        previous = row.edgeId
        yield row
      }
      if (Buffer.byteLength(carry, 'utf8') > MAX_NDJSON_LINE_BYTES) throw new Error(`Exact edge row exceeds bounded line size: ${receipt.path}`)
    }
    carry += decoder.decode()
    if (carry.length > 0) throw new Error(`Exact partition lacks its final canonical newline: ${receipt.path}`)
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || fileHash.digest('hex') !== receipt.sha256) throw new Error(`Exact partition receipt changed: ${receipt.path}`)
  } finally {
    await handle.close()
  }
}

/** Stream exact merged rows for release-gate rederivation.  The generator is
 * intentionally bounded and receipt-verifying so consumers cannot trust a
 * self-authored eligibility index without replaying the immutable partitions. */
export async function* readCompactV31ExactRows(root: string, mergeReceipt: FileReceipt): AsyncGenerator<EdgeRow> {
  const merge = CompactV31ProductionMergeReceiptSchema.parse(await readJson(root, mergeReceipt))
  for (const partition of merge.outputPartitions) {
    await verifyCompactV31ProductionFileReceipt(root, partition)
    yield* readNdjson(root, partition)
  }
}

function replayTaxonomy(inventory: PinnedTaxonomyInventoryV1): Map<string, Map<string, number>> {
  const output = new Map<string, Map<string, number>>()
  for (const row of inventory.rows) {
    const chess = new Chess()
    const positions = new Map<string, number>()
    positions.set(canonicalEpd(chess), 0)
    for (const [index, move] of row.uci.entries()) {
      try { chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), ...(move.length > 4 ? { promotion: move[4] } : {}) }) }
      catch (error) { throw new Error(`Taxonomy row ${row.id} contains an illegal move at ply ${index + 1}`, { cause: error }) }
      const epd = canonicalEpd(chess)
      const prior = positions.get(epd)
      if (prior === undefined || index + 1 < prior) positions.set(epd, index + 1)
    }
    output.set(row.id, positions)
  }
  return output
}

type EdgeEvidence = { row: EdgeRow; sampleByCorpus: Map<string, number>; maximumCohortSample: number }
function maximumCohortSample(edge: EdgeEvidence): number { return edge.maximumCohortSample }
type EdgeRows = Iterable<unknown> | AsyncIterable<unknown>
function expectedRatingSystem(corpus: string): 'broadcast-rating' | 'lichess-glicko2' {
  if (corpus === 'lichess-broadcasts') return 'broadcast-rating'
  if (corpus === 'lichess-standard-rated-q2-2026') return 'lichess-glicko2'
  throw new Error(`Unknown exact evidence corpus: ${corpus}`)
}
function individualCohortSampleSize(row: EdgeRow, corpus: string): number {
  const expected = expectedRatingSystem(corpus)
  if (row.cells.some((cell) => cell.ratingSystem !== expected)) {
    throw new Error(`Exact edge ${row.edgeId} contains a cell from the wrong corpus cohort`)
  }
  // The v3.1 row contract currently declares sampleSize as the maximum cell
  // N.  A multi-band row cannot establish a complete source/time-control
  // cohort (canonical <1800 may overlap its beginner sub-bands), so fail
  // closed rather than treating a cell maximum as a fabricated cohort total.
  const dimensions = new Set(row.cells.map((cell) => `${cell.ratingSystem}:${cell.timeControl}`))
  if (dimensions.size !== 1 || row.cells.length > 1) {
    throw new Error(`Exact edge ${row.edgeId} lacks a disjoint canonical cohort total; v3.1 eligibility requires richer band/cohort evidence`)
  }
  // With one unambiguous cell this is the maximum valid individual cohort N.
  return Math.max(...row.cells.map(({ n }) => n))
}
async function buildEdgeEvidence(rowsByCorpus: readonly { corpus: string; rows: EdgeRows }[]): Promise<Map<string, EdgeEvidence>> {
  const result = new Map<string, EdgeEvidence>()
  const edgeIds = new Map<string, string>()
  let rowCount = 0
  for (const { corpus, rows } of rowsByCorpus) {
    for await (const rawRow of rows) {
      const row = CompactV31ProductionExactEdgeRowSchema.parse(rawRow)
      rowCount += 1
      if (rowCount > MAX_HANDOFF_EXACT_EDGE_ROWS) throw new Error(`Exact evidence exceeds bounded handoff index (${MAX_HANDOFF_EXACT_EDGE_ROWS} rows)`)
      const sampleSize = individualCohortSampleSize(row, corpus)
      const key = `${row.fromEpdSha256}\0${row.uci}\0${row.toEpdSha256}`
      const priorKey = edgeIds.get(row.edgeId)
      if (priorKey !== undefined && priorKey !== key) throw new Error(`Edge ID is owned by multiple exact identities: ${row.edgeId}`)
      edgeIds.set(row.edgeId, key)
      const prior = result.get(key)
      if (!prior) { result.set(key, { row, sampleByCorpus: new Map([[corpus, sampleSize]]), maximumCohortSample: sampleSize }); continue }
      if (!sameEdge(prior.row, row)) throw new Error(`Duplicate edge ownership or conflicting exact edge identity: ${row.edgeId}`)
      const maximum = Math.max(prior.sampleByCorpus.get(corpus) ?? 0, sampleSize)
      prior.sampleByCorpus.set(corpus, maximum)
      prior.maximumCohortSample = Math.max(...prior.sampleByCorpus.values())
    }
  }
  return result
}

function commonRootCandidates(
  familyRows: readonly { id: string }[],
  positions: ReadonlyMap<string, Map<string, number>>,
  edgesByFrom: ReadonlyMap<string, readonly EdgeEvidence[]>,
  side: Side,
): Array<{ epd: string; ply: number; hasExploratory: boolean }> {
  if (familyRows.length === 0) return []
  let common = new Set(positions.get(familyRows[0]!.id)?.keys() ?? [])
  for (const row of familyRows.slice(1)) {
    const rowPositions = positions.get(row.id)
    common = new Set([...common].filter((epd) => rowPositions?.has(epd)))
  }
  return [...common].filter((epd) => sideAt(epd) === side).flatMap((epd) => {
    const edges = edgesByFrom.get(hashEpd(epd)) ?? []
    const max = Math.max(...edges.map(maximumCohortSample), 0)
    if (max < 100) return []
    return [{ epd, ply: Math.max(...familyRows.map(({ id }) => positions.get(id)!.get(epd)!)), hasExploratory: max < 500 }]
  }).sort((left, right) => right.ply - left.ply || left.epd.localeCompare(right.epd, 'en'))
}

/**
 * Walk every eligible edge reachable from a reviewed root.  Exact rows only
 * carry hashes, so each move is replayed from the known EPD at the frontier;
 * a hash mismatch is evidence corruption, not a reason to hide the edge.
 */
function reachableEdges(options: {
  rootEpd: string
  rootPly: number
  edgesByFrom: ReadonlyMap<string, readonly EdgeEvidence[]>
}): { eligible: EdgeEvidence[]; book: EdgeEvidence[]; exploratory: EdgeEvidence[] } {
  const eligible = new Map<string, EdgeEvidence>()
  const expandedAtDepth = new Map<string, number>()
  const stack: Array<{ epd: string; ply: number; active: Set<string> }> = [{ epd: options.rootEpd, ply: options.rootPly, active: new Set([hashEpd(options.rootEpd)]) }]
  while (stack.length > 0) {
    const state = stack.pop()!
    if (state.ply >= 100) continue
    const fromHash = hashEpd(state.epd)
    const priorDepth = expandedAtDepth.get(fromHash)
    if (priorDepth !== undefined && priorDepth <= state.ply) continue
    expandedAtDepth.set(fromHash, state.ply)
    const outgoing = options.edgesByFrom.get(fromHash) ?? []
    for (const edge of outgoing) {
      if (maximumCohortSample(edge) < 100) continue
      let chess: Chess
      try { chess = new Chess(`${state.epd} 0 1`) }
      catch (error) { throw new Error(`Reachable root EPD is not legal: ${state.epd}`, { cause: error }) }
      let nextEpd: string
      try {
        chess.move({ from: edge.row.uci.slice(0, 2), to: edge.row.uci.slice(2, 4), ...(edge.row.uci.length > 4 ? { promotion: edge.row.uci[4] } : {}) })
        nextEpd = canonicalEpd(chess)
      } catch (error) {
        throw new Error(`Eligible edge ${edge.row.edgeId} is illegal from reachable EPD ${state.epd}`, { cause: error })
      }
      if (hashEpd(nextEpd) !== edge.row.toEpdSha256) {
        throw new Error(`Eligible edge ${edge.row.edgeId} has a to-EPD hash mismatch from reachable EPD ${state.epd}`)
      }
      eligible.set(edge.row.edgeId, edge)
      const nextHash = hashEpd(nextEpd)
      if (state.active.has(nextHash)) throw new Error(`Cyclic eligible exact-state continuation reaches EPD hash ${nextHash}`)
      stack.push({ epd: nextEpd, ply: state.ply + 1, active: new Set([...state.active, nextHash]) })
    }
  }
  const values = [...eligible.values()].sort((left, right) => left.row.edgeId.localeCompare(right.row.edgeId, 'en'))
  return { eligible: values, book: values.filter((edge) => maximumCohortSample(edge) >= 500), exploratory: values.filter((edge) => maximumCohortSample(edge) < 500) }
}

export interface CompactV31FamilyHandoffResult {
  index: ReturnType<typeof CompactV31FamilyEligibilityIndexSchema.parse>
  receipt: ImmutableJsonReceiptV1
  rootReceipts: readonly ImmutableJsonReceiptV1[]
}

export async function deriveCompactV31FamilyHandoff(options: {
  releaseId: string
  completedAt?: string
  taxonomyInventory: unknown
  taxonomyManifest: unknown
  editorialLedger: unknown
  corpusBindings: readonly [DeepVerifiedCorpusBinding, DeepVerifiedCorpusBinding]
  exactRows: readonly [{ corpus: string; rows: EdgeRows }, { corpus: string; rows: EdgeRows }]
  rootHints?: readonly RootHint[]
}): Promise<{
  index: ReturnType<typeof CompactV31FamilyEligibilityIndexSchema.parse>
  rootInventories: readonly ReturnType<typeof CompactV31FamilyRootEdgeInventorySchema.parse>[]
}> {
  const releaseId = FamilyReleaseIdSchema.parse(options.releaseId)
  const completedAt = options.completedAt ?? DEFAULT_COMPLETED_AT
  const taxonomyManifest = TaxonomySourceManifestSchema.parse(options.taxonomyManifest)
  const inventory = validatePinnedTaxonomyInventory(options.taxonomyInventory, taxonomyManifest)
  const ledger = validateOpeningFamilyEditorialLedger(options.editorialLedger)
  if (ledger.editorialStatus !== 'approved' || !ledger.promotionEligible) throw new Error('Only the fully approved editorial ledger may enter the compact-v3.1 family handoff')
  if (ledger.taxonomyCommit !== inventory.sourceCommit) throw new Error('Editorial ledger taxonomy commit differs from pinned inventory')
  // The proposal review denominator is fixed at 149, but approved merge/split
  // decisions may produce a different canonical family count. Every resulting
  // family must be named by at least one approved decision; otherwise the
  // source-derived handoff would contain an orphan canonical family.
  const resultingFamilyIds = new Set(ledger.decisions.flatMap((entry) => entry.reviewStatus === 'approved' ? entry.decision.resultingFamilyIds : []))
  const orphanFamilies = ledger.families.filter(({ id }) => !resultingFamilyIds.has(id)).map(({ id }) => id)
  if (orphanFamilies.length > 0) throw new Error(`Editorial ledger contains canonical families unowned by approved decisions: ${orphanFamilies.join(', ')}`)
  const owner = new Map(ledger.families.flatMap((family) => family.primaryTaxonomyLineIds.map((id) => [id, family.id] as const)))
  if (owner.size !== inventory.rows.length) throw new Error('Editorial ledger does not own the exact pinned taxonomy universe')
  const pinnedIds = new Set(inventory.rows.map(({ id }) => id))
  if (owner.size !== pinnedIds.size || [...owner.keys()].some((id) => !pinnedIds.has(id))) throw new Error('Editorial ledger contains unknown or omitted pinned taxonomy rows')
  const positions = replayTaxonomy(inventory)
  if (options.exactRows[0]!.corpus !== 'lichess-broadcasts' || options.exactRows[1]!.corpus !== 'lichess-standard-rated-q2-2026') {
    throw new Error('Family handoff requires broadcast and Q2 exact evidence in canonical order')
  }
  if (options.corpusBindings[0]!.corpus !== options.exactRows[0]!.corpus || options.corpusBindings[1]!.corpus !== options.exactRows[1]!.corpus) {
    throw new Error('Exact evidence rows are not bound to their declared corpus receipts')
  }
  const evidence = await buildEdgeEvidence(options.exactRows)
  const edgesByFrom = new Map<string, EdgeEvidence[]>()
  for (const edge of evidence.values()) (edgesByFrom.get(edge.row.fromEpdSha256) ?? (edgesByFrom.set(edge.row.fromEpdSha256, []), edgesByFrom.get(edge.row.fromEpdSha256)!)).push(edge)
  const families = [...ledger.families].sort((a, b) => a.id.localeCompare(b.id, 'en'))
  const hints = new Map<string, string>()
  const familyIds = new Set(families.map(({ id }) => id))
  for (const hint of options.rootHints ?? []) {
    const familyId = FamilyIdSchema.parse(hint.familyId)
    const rootEpd = EpdSchema.parse(hint.rootEpd)
    if (hint.side !== 'white' && hint.side !== 'black') throw new Error(`Root hint has an invalid learner side for ${familyId}`)
    if (!familyIds.has(familyId)) throw new Error(`Root hint names an unknown editorial family: ${familyId}`)
    const hintKey = `${familyId}:${hint.side}`
    if (hints.has(hintKey)) throw new Error(`Duplicate root hint for ${hintKey}`)
    hints.set(hintKey, rootEpd)
  }
  const roots: ReturnType<typeof CompactV31FamilyRootEdgeInventorySchema.parse>[] = []
  const dispositions: Array<{ familyId: string; side: Side; taxonomyLineIds: string[]; readiness: 'trainable' | 'study-only'; reason: 'eligible-root' | 'insufficient-sample' | 'no-root'; rootEpd: string | null }> = []
  const usedRoots = new Map<string, string>()
  for (const family of families) {
    const familyRows = family.primaryTaxonomyLineIds.map((id) => inventory.rows.find((row) => row.id === id)).filter((row): row is PinnedTaxonomyInventoryV1['rows'][number] => row !== undefined)
    for (const side of ['white', 'black'] as const) {
      const key = `${family.id}:${side}`
      const hinted = hints.get(key)
      const candidates = commonRootCandidates(familyRows, positions, edgesByFrom, side)
      if (candidates.length > 1 && candidates[0]!.ply === candidates[1]!.ply) throw new Error(`Ambiguous or multiple exact roots for ${key}`)
      const selected = candidates[0]
      if (hinted !== undefined) {
        const parsedHint = EpdSchema.parse(hinted)
        if (selected === undefined || selected.epd !== parsedHint) throw new Error(`Root hint is not the uniquely selected empirical root for ${key}`)
      }
      const rootEpd = selected?.epd ?? null
      if (rootEpd !== null && selected!.ply >= 100) throw new Error(`Family root exceeds the adaptive ply-100 boundary: ${key}`)
      if (rootEpd === null) {
        const anyAtRoot = familyRows.some(({ id }) => [...(positions.get(id)?.keys() ?? [])].some((epd) => sideAt(epd) === side && (edgesByFrom.get(hashEpd(epd)) ?? []).some((edge) => maximumCohortSample(edge) > 0)))
        dispositions.push({ familyId: family.id, side, taxonomyLineIds: [...family.primaryTaxonomyLineIds], readiness: 'study-only', reason: anyAtRoot ? 'insufficient-sample' : 'no-root', rootEpd: null })
        continue
      }
      const ownerKey = `${hashEpd(rootEpd)}:${side}`
      const priorOwner = usedRoots.get(ownerKey)
      if (priorOwner !== undefined && priorOwner !== family.id) throw new Error(`Ambiguous exact EPD root ownership between ${priorOwner} and ${family.id}`)
      usedRoots.set(ownerKey, family.id)
      const reachable = reachableEdges({ rootEpd, rootPly: selected!.ply, edgesByFrom })
      if (reachable.eligible.length === 0) throw new Error(`Root ${rootEpd} has no eligible edge inventory for ${key}`)
      const inventoryValue = CompactV31FamilyRootEdgeInventorySchema.parse({
        schemaVersion: 1, kind: 'linerecall-compact-v31-family-root-edge-inventory', releaseEligible: false,
        releaseId, familyId: family.id, side, packId: FamilyPackIdSchema.parse(`${family.id}_${side}`), rootEpd,
        corpusBindings: options.corpusBindings, eligibleEdgeIds: reachable.eligible.map(({ row }) => row.edgeId),
        bookEdgeIds: reachable.book.map(({ row }) => row.edgeId), exploratoryEdgeIds: reachable.exploratory.map(({ row }) => row.edgeId), taxonomyLineIds: [...family.primaryTaxonomyLineIds], completedAt,
      })
      roots.push(inventoryValue)
      dispositions.push({ familyId: family.id, side, taxonomyLineIds: [...family.primaryTaxonomyLineIds], readiness: reachable.book.length > 0 ? 'trainable' : 'study-only', reason: reachable.book.length > 0 ? 'eligible-root' : 'insufficient-sample', rootEpd })
    }
  }
  const index = CompactV31FamilyEligibilityIndexSchema.parse({
    schemaVersion: 1, kind: 'linerecall-compact-v31-family-eligibility-index', releaseEligible: false, releaseId,
    corpusBindings: options.corpusBindings,
    // Derivation callers do not necessarily have file receipts.  This is a
    // digest of the validated values; the file-based builder replaces these
    // with the exact identity-receipt digests before promotion.
    taxonomyInventorySha256: digest(`${JSON.stringify(inventory)}\n`),
    editorialLedgerSha256: digest(`${JSON.stringify(ledger)}\n`),
    proposedFamilyCount: ledger.proposedFamilyCount,
    familyCount: families.length, familyDispositions: dispositions.sort((a, b) => `${a.familyId}:${a.side}`.localeCompare(`${b.familyId}:${b.side}`, 'en')),
    roots: roots.sort((a, b) => `${a.familyId}:${a.side}`.localeCompare(`${b.familyId}:${b.side}`, 'en')).map((root) => ({ familyId: root.familyId, side: root.side, packId: root.packId, eligibleEdgeCount: root.eligibleEdgeIds.length, edgeInventory: { path: `pending/${root.packId}.json`, bytes: 1, sha256: digest(root.packId) } })), completedAt,
  })
  return { index, rootInventories: roots }
}

export async function buildCompactV31FamilyHandoff(options: {
  root: string
  releaseId: string
  broadcastCorpusReceipt: FileReceipt
  q2CorpusReceipt: FileReceipt
  taxonomyInventoryPath: string
  taxonomyManifestPath: string
  editorialLedgerPath: string
  outputRoot?: string
  outputPath: string
  completedAt?: string
  rootHints?: readonly RootHint[]
}): Promise<CompactV31FamilyHandoffResult> {
  const root = resolve(options.root)
  const [broadcastAudit, q2Audit] = await Promise.all([
    auditCompactV31ProductionCorpusChain({ root, corpusReceipt: options.broadcastCorpusReceipt }),
    auditCompactV31ProductionCorpusChain({ root, corpusReceipt: options.q2CorpusReceipt }),
  ])
  const taxonomyInventoryReceipt = await identityReceipt(root, options.taxonomyInventoryPath)
  const taxonomyManifestReceipt = await identityReceipt(root, options.taxonomyManifestPath)
  const editorialLedgerReceipt = await identityReceipt(root, options.editorialLedgerPath)
  const [taxonomyInventory, taxonomyManifest, editorialLedger] = await Promise.all([
    readJson(root, fileCore(taxonomyInventoryReceipt)), readJson(root, fileCore(taxonomyManifestReceipt)), readJson(root, fileCore(editorialLedgerReceipt)),
  ])
  const rows = await Promise.all([
    readCompactV31ExactRows(root, broadcastAudit.receipt.exactMergeReceipt), readCompactV31ExactRows(root, q2Audit.receipt.exactMergeReceipt),
  ])
  const bindings = [
    { corpus: 'lichess-broadcasts', corpusReceiptSha256: broadcastAudit.corpusReceiptSha256, sourceManifestSha256: broadcastAudit.sourceManifestSha256, exactMergeReceiptSha256: broadcastAudit.exactMergeReceiptSha256, sourceEdgeInventorySha256: broadcastAudit.sourceEdgeInventorySha256 },
    { corpus: 'lichess-standard-rated-q2-2026', corpusReceiptSha256: q2Audit.corpusReceiptSha256, sourceManifestSha256: q2Audit.sourceManifestSha256, exactMergeReceiptSha256: q2Audit.exactMergeReceiptSha256, sourceEdgeInventorySha256: q2Audit.sourceEdgeInventorySha256 },
  ] as const
  const derived = await deriveCompactV31FamilyHandoff({ releaseId: options.releaseId, ...(options.completedAt === undefined ? {} : { completedAt: options.completedAt }), taxonomyInventory, taxonomyManifest, editorialLedger, corpusBindings: bindings, exactRows: [{ corpus: bindings[0].corpus, rows: rows[0] }, { corpus: bindings[1].corpus, rows: rows[1] }], ...(options.rootHints === undefined ? {} : { rootHints: options.rootHints }) })
  const outputRoot = options.outputRoot ?? `${dirname(options.outputPath)}/roots`
  const pending: Array<{ candidate: Awaited<ReturnType<typeof writeImmutableJsonCandidate>>; value: ReturnType<typeof CompactV31FamilyRootEdgeInventorySchema.parse> }> = []
  try {
    for (const value of derived.rootInventories) {
      const candidate = await writeImmutableJsonCandidate({ root, outputPath: `${outputRoot}/${value.packId}.json`, value })
      pending.push({ candidate, value })
    }
    const receipts = pending.map(({ candidate, value }) => ({ value, receipt: ImmutableJsonReceiptV1Schema.parse({ path: `${outputRoot}/${value.packId}.json`, bytes: candidate.bytes, sha256: candidate.sha256, uncompressedBytes: candidate.bytes, encoding: 'identity' }) }))
    const indexValue = CompactV31FamilyEligibilityIndexSchema.parse({ ...derived.index, taxonomyInventorySha256: taxonomyInventoryReceipt.sha256, editorialLedgerSha256: editorialLedgerReceipt.sha256, roots: receipts.map(({ value, receipt }) => ({ familyId: value.familyId, side: value.side, packId: value.packId, eligibleEdgeCount: value.eligibleEdgeIds.length, edgeInventory: { path: receipt.path, bytes: receipt.bytes, sha256: receipt.sha256 } })) })
    const indexCandidate = await writeImmutableJsonCandidate({ root, outputPath: options.outputPath, value: indexValue })
    await Promise.all(pending.map(({ candidate }) => candidate.promote()))
    await indexCandidate.promote()
    return { index: indexValue, receipt: ImmutableJsonReceiptV1Schema.parse({ path: options.outputPath, bytes: indexCandidate.bytes, sha256: indexCandidate.sha256, uncompressedBytes: indexCandidate.bytes, encoding: 'identity' }), rootReceipts: receipts.map(({ receipt }) => receipt) }
  } catch (error) {
    await Promise.all(pending.map(({ candidate }) => candidate.discard()))
    throw error
  }
}

/** Descriptive aliases used by release tooling and migration callers. */
export const buildCompactV31FamilyEligibilityIndex = buildCompactV31FamilyHandoff
export const deriveFamilyEligibilityInventory = deriveCompactV31FamilyHandoff

function option(name: string, fallback: string): string { const index = process.argv.indexOf(name); const value = index < 0 ? fallback : process.argv[index + 1]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`); return value }
async function main(): Promise<void> {
  const root = resolve(option('--root', '.'))
  const value = await buildCompactV31FamilyHandoff({ root, releaseId: option('--release-id', 'release-required'), broadcastCorpusReceipt: JSON.parse(await readFile(resolve(root, option('--broadcast-corpus-receipt', 'data/generated/v31/production/broadcast/corpus.json')), 'utf8')) as FileReceipt, q2CorpusReceipt: JSON.parse(await readFile(resolve(root, option('--q2-corpus-receipt', 'data/generated/v31/production/standard-q2-2026/corpus.json')), 'utf8')) as FileReceipt, taxonomyInventoryPath: option('--taxonomy-inventory', 'data/manifests/taxonomy.inventory.v1.json'), taxonomyManifestPath: option('--taxonomy-manifest', 'data/manifests/taxonomy.source.json'), editorialLedgerPath: option('--editorial-ledger', 'data/manifests/opening-family-editorial.approved.json'), outputRoot: option('--output-root', 'data/generated/v31/family-roots'), outputPath: option('--output', 'data/generated/v31/family-eligibility-index.json') })
  process.stdout.write(`${JSON.stringify({ result: 'compact-v31-family-handoff-created', receipt: value.receipt }, null, 2)}\n`)
}
const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invoked === import.meta.url) main().catch((error) => { process.stderr.write(`Compact-v3.1 family handoff failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })

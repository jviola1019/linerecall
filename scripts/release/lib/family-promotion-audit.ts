import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import {
  ContentAddressedRefV1Schema,
  OpeningFamilyCatalogV1Schema,
  OpeningFamilyManifestV1Schema,
  TacticalPuzzleShardV1Schema,
  type ContentAddressedRefV1,
  type OpeningFamilyManifestV1,
} from '../../../src/domain/opening-family.ts'
import {
  EligibleSourceEdgeInventoryV1Schema,
  validateEligibleSourceEdgeInventory,
  validateRepertoireGraphDocument,
} from '../../../src/domain/repertoire.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9_./-]{0,510}$/u
const MAX_INDEX_BYTES = 1 * 1024 * 1024
const MAX_COMPRESSED_RESOURCE_BYTES = 64 * 1024 * 1024
const MAX_UNCOMPRESSED_RESOURCE_BYTES = 256 * 1024 * 1024
const EXPECTED_Q2_GAMES = 267_333_507
const EXPECTED_Q2_COMPRESSED_BYTES = 87_256_474_116
const EXPECTED_TAXONOMY_LINES = 3_790

const SafePathSchema = z.string().min(1).max(512).regex(SAFE_RELATIVE_PATH)
const FileReceiptSchema = z.object({
  path: SafePathSchema,
  sha256: z.string().regex(SHA256),
  bytes: z.number().int().positive().max(MAX_COMPRESSED_RESOURCE_BYTES),
  uncompressedBytes: z.number().int().positive().max(MAX_UNCOMPRESSED_RESOURCE_BYTES),
  encoding: z.enum(['identity', 'gzip']),
}).strict().superRefine((value, context) => {
  if (value.encoding === 'identity' && value.bytes !== value.uncompressedBytes) {
    context.addIssue({ code: 'custom', path: ['uncompressedBytes'], message: 'Identity resources must have equal byte lengths' })
  }
})

const GateFileMapSchema = z.object({
  q2: FileReceiptSchema.optional(),
  engine: FileReceiptSchema.optional(),
  scid: FileReceiptSchema.optional(),
  puzzles: FileReceiptSchema.optional(),
}).strict()

export const FamilyPromotionAuditIndexV1Schema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,159}$/u),
  selectionPolicy: z.object({
    practiceBranches: z.literal('all-eligible-audited'),
    maximumPracticeBranches: z.null(),
  }).strict(),
  catalog: FileReceiptSchema,
  families: z.array(z.object({
    familyId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    manifest: FileReceiptSchema,
    provenance: FileReceiptSchema,
  }).strict()).min(1).max(EXPECTED_TAXONOMY_LINES),
  packs: z.array(z.object({
    familyId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    packId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}$/u),
    graph: FileReceiptSchema,
    eligibleInventory: FileReceiptSchema,
  }).strict()).min(1).max(100_000),
  puzzleShards: z.array(z.object({
    familyIds: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)).min(1).max(256),
    shard: FileReceiptSchema,
  }).strict()).min(1).max(1_000),
  promotionReceipts: GateFileMapSchema,
}).strict().superRefine((index, context) => {
  const allPaths = [
    index.catalog.path,
    ...index.families.flatMap(({ manifest, provenance }) => [manifest.path, provenance.path]),
    ...index.packs.flatMap(({ graph, eligibleInventory }) => [graph.path, eligibleInventory.path]),
    ...index.puzzleShards.map(({ shard }) => shard.path),
    ...Object.values(index.promotionReceipts).flatMap((receipt) => receipt ? [receipt.path] : []),
  ]
  if (new Set(allPaths).size !== allPaths.length) {
    context.addIssue({ code: 'custom', path: ['families'], message: 'Every indexed resource path must be unique' })
  }
  if (new Set(index.families.map(({ familyId }) => familyId)).size !== index.families.length) {
    context.addIssue({ code: 'custom', path: ['families'], message: 'Family index entries must be unique' })
  }
  if (new Set(index.packs.map(({ packId }) => packId)).size !== index.packs.length) {
    context.addIssue({ code: 'custom', path: ['packs'], message: 'Pack index entries must be unique' })
  }
})

const BaseGateSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,159}$/u),
  status: z.literal('pass'),
  completedAt: z.string().datetime({ offset: true }),
}).strict()

const Q2ReceiptSchema = BaseGateSchema.extend({
  gate: z.literal('lichess-standard-q2-2026'),
  archiveMonths: z.tuple([z.literal('2026-04'), z.literal('2026-05'), z.literal('2026-06')]),
  archiveCount: z.literal(3),
  archivesComplete: z.literal(true),
  digestsVerified: z.literal(true),
  recordsSeen: z.literal(EXPECTED_Q2_GAMES),
  publishedRecords: z.literal(EXPECTED_Q2_GAMES),
  publishedCompressedBytes: z.literal(EXPECTED_Q2_COMPRESSED_BYTES),
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  deduplicated: z.number().int().nonnegative(),
  accountingReconciles: z.literal(true),
}).strict().superRefine((receipt, context) => {
  if (receipt.accepted + receipt.rejected + receipt.deduplicated !== receipt.recordsSeen) {
    context.addIssue({ code: 'custom', path: ['accountingReconciles'], message: 'Q2 accepted, rejected, and deduplicated totals must reconcile exactly' })
  }
})

const EngineReceiptSchema = BaseGateSchema.extend({
  gate: z.literal('stockfish-18-family-graphs'),
  engineName: z.literal('Stockfish 18'),
  threads: z.literal(1),
  hashMb: z.literal(128),
  multiPv: z.literal(5),
  nodesPerPosition: z.literal(250_000),
  learnerNodesChecked: z.number().int().positive(),
  allDrillableLearnerNodesChecked: z.literal(true),
  engineSha256: z.string().regex(SHA256),
  nnueSha256: z.array(z.string().regex(SHA256)).min(1).max(8),
}).strict()

const ScidReceiptSchema = BaseGateSchema.extend({
  gate: z.literal('scid-family-crosscheck'),
  stratifiedSampleComplete: z.literal(true),
  sampledLines: z.number().int().positive().max(250),
  conflictingBaseEcoInDrills: z.literal(0),
  oracleContentShipped: z.literal(false),
}).strict()

const PuzzlePromotionReceiptSchema = BaseGateSchema.extend({
  gate: z.literal('lichess-puzzle-promotion'),
  sourceDigestApproved: z.literal(true),
  sourceSha256: z.string().regex(SHA256),
  promotedShardCount: z.number().int().positive().max(1_000),
  promotedPuzzleCount: z.number().int().positive(),
  legalityComplete: z.literal(true),
  associationComplete: z.literal(true),
  engineChecksComplete: z.literal(true),
  duplicatePuzzleIds: z.literal(0),
}).strict()

export interface FamilyPromotionFinding {
  code: string
  path: string | null
  message: string
}

export interface FamilyPromotionAuditReportV1 {
  schemaVersion: 1
  audit: 'linerecall-family-promotion'
  generatedAt: string
  releaseId: string | null
  status: 'pass' | 'blocked'
  counts: {
    families: number
    packs: number
    paths: number
    eligibleEdges: number
    puzzleShards: number
    puzzles: number
  }
  gates: Array<{ id: string; status: 'pass' | 'blocked'; detail: string }>
  findings: FamilyPromotionFinding[]
}

export interface AuditFamilyPromotionOptions {
  root: string
  indexPath: string
  now?: () => Date
}

function finding(error: unknown, code: string, path: string | null): FamilyPromotionFinding {
  return { code, path, message: error instanceof Error ? error.message : String(error) }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function safeExistingPath(rootReal: string, relativePath: string): Promise<string> {
  SafePathSchema.parse(relativePath)
  const candidate = resolve(rootReal, relativePath)
  const targetReal = await realpath(candidate)
  if (!isWithinRoot(rootReal, targetReal)) throw new Error('Indexed resource escapes the approved audit root')
  const details = await stat(targetReal)
  if (!details.isFile()) throw new Error('Indexed resource is not a regular file')
  return targetReal
}

async function readExactFile(path: string, expectedBytes: number, maximumBytes: number): Promise<Uint8Array> {
  if (expectedBytes > maximumBytes) throw new Error(`Resource exceeds the ${maximumBytes}-byte audit bound`)
  const handle = await open(path, 'r')
  try {
    const details = await handle.stat()
    if (!details.isFile() || details.size !== expectedBytes) throw new Error('Resource byte receipt does not match the file')
    const bytes = new Uint8Array(expectedBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== expectedBytes) throw new Error('Resource changed or exceeded its byte receipt while being read')
    return bytes.subarray(0, expectedBytes)
  } finally {
    await handle.close()
  }
}

function decodeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (text.includes('\0')) throw new Error('JSON resource contains a NUL character')
  return JSON.parse(text) as unknown
}

async function readIndexedJson(rootReal: string, receiptInput: z.infer<typeof FileReceiptSchema>): Promise<unknown> {
  const receipt = FileReceiptSchema.parse(receiptInput)
  const path = await safeExistingPath(rootReal, receipt.path)
  const compressed = await readExactFile(path, receipt.bytes, MAX_COMPRESSED_RESOURCE_BYTES)
  const digest = createHash('sha256').update(compressed).digest('hex')
  if (digest !== receipt.sha256) throw new Error('Resource SHA-256 receipt does not match the file')
  const decoded = receipt.encoding === 'gzip'
    ? new Uint8Array(gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_RESOURCE_BYTES }))
    : compressed
  if (decoded.byteLength !== receipt.uncompressedBytes) {
    throw new Error('Resource uncompressed-byte receipt does not match the decoded JSON')
  }
  return decodeJson(decoded)
}

function sameContentReference(reference: ContentAddressedRefV1, receipt: z.infer<typeof FileReceiptSchema>): boolean {
  return receipt.encoding === 'gzip'
    && reference.path === receipt.path
    && reference.sha256 === receipt.sha256
    && reference.compressedBytes === receipt.bytes
    && reference.uncompressedBytes === receipt.uncompressedBytes
}

function gateResult(
  gates: FamilyPromotionAuditReportV1['gates'],
  id: string,
  ok: boolean,
  detail: string,
): void {
  gates.push({ id, status: ok ? 'pass' : 'blocked', detail })
}

export async function auditFamilyPromotion(
  options: AuditFamilyPromotionOptions,
): Promise<FamilyPromotionAuditReportV1> {
  const findings: FamilyPromotionFinding[] = []
  const gates: FamilyPromotionAuditReportV1['gates'] = []
  const counts = { families: 0, packs: 0, paths: 0, eligibleEdges: 0, puzzleShards: 0, puzzles: 0 }
  let releaseId: string | null = null
  const generatedAt = (options.now ?? (() => new Date()))().toISOString()
  let rootReal: string
  try {
    rootReal = await realpath(options.root)
  } catch (error) {
    findings.push(finding(error, 'audit-root-unavailable', null))
    return { schemaVersion: 1, audit: 'linerecall-family-promotion', generatedAt, releaseId, status: 'blocked', counts, gates, findings }
  }

  let index: z.infer<typeof FamilyPromotionAuditIndexV1Schema>
  try {
    SafePathSchema.parse(options.indexPath)
    const indexFile = await safeExistingPath(rootReal, options.indexPath)
    const indexStat = await stat(indexFile)
    const indexBytes = await readExactFile(indexFile, indexStat.size, MAX_INDEX_BYTES)
    index = FamilyPromotionAuditIndexV1Schema.parse(decodeJson(indexBytes))
    releaseId = index.releaseId
    gateResult(gates, 'safe-index', true, 'The bounded relative-path index is valid')
  } catch (error) {
    findings.push(finding(error, 'promotion-index-invalid', options.indexPath))
    gateResult(gates, 'safe-index', false, 'The promotion index is absent, unsafe, oversized, or invalid')
    return { schemaVersion: 1, audit: 'linerecall-family-promotion', generatedAt, releaseId, status: 'blocked', counts, gates, findings }
  }

  const manifests = new Map<string, OpeningFamilyManifestV1>()
  let catalog: z.infer<typeof OpeningFamilyCatalogV1Schema> | null = null
  try {
    catalog = OpeningFamilyCatalogV1Schema.parse(await readIndexedJson(rootReal, index.catalog))
    if (catalog.releaseId !== index.releaseId) throw new Error('Catalog belongs to another release')
    if (catalog.taxonomyLineCount !== EXPECTED_TAXONOMY_LINES) throw new Error('Catalog does not assign all 3,790 taxonomy rows')
    counts.families = catalog.families.length
  } catch (error) {
    findings.push(finding(error, 'family-catalog-invalid', index.catalog.path))
  }

  if (catalog) {
    const familyIndex = new Map(index.families.map((entry) => [entry.familyId, entry]))
    const taxonomyOwners = new Map<string, string>()
    for (const entry of catalog.families) {
      const indexed = familyIndex.get(entry.id)
      if (!indexed) {
        findings.push({ code: 'family-manifest-unindexed', path: null, message: `Family ${entry.id} has no indexed manifest` })
        continue
      }
      try {
        if (!sameContentReference(ContentAddressedRefV1Schema.parse(entry.manifestRef), indexed.manifest)) {
          throw new Error('Manifest receipt does not match its catalog content reference')
        }
        const manifest = OpeningFamilyManifestV1Schema.parse(await readIndexedJson(rootReal, indexed.manifest))
        if (manifest.id !== entry.id || manifest.releaseId !== index.releaseId) throw new Error('Manifest identity does not match its catalog family')
        if (manifest.taxonomyLineIds.length !== entry.taxonomyLineCount) throw new Error('Manifest taxonomy count differs from its catalog entry')
        if (!sameContentReference(manifest.provenanceRef, indexed.provenance)) throw new Error('Provenance receipt differs from the family manifest')
        await readIndexedJson(rootReal, indexed.provenance)
        for (const lineId of manifest.taxonomyLineIds) {
          const prior = taxonomyOwners.get(lineId)
          if (prior) throw new Error(`Taxonomy row ${lineId} has primary ownership in both ${prior} and ${manifest.id}`)
          taxonomyOwners.set(lineId, manifest.id)
        }
        manifests.set(manifest.id, manifest)
      } catch (error) {
        findings.push(finding(error, 'family-manifest-invalid', indexed.manifest.path))
      }
    }
    for (const indexed of index.families) {
      if (!catalog.families.some(({ id }) => id === indexed.familyId)) {
        findings.push({ code: 'unreferenced-family-index-entry', path: indexed.manifest.path, message: `Indexed family ${indexed.familyId} is absent from the catalog` })
      }
    }
    if (taxonomyOwners.size !== catalog.taxonomyLineCount) {
      findings.push({ code: 'taxonomy-primary-ownership-incomplete', path: index.catalog.path, message: `Expected ${catalog.taxonomyLineCount} uniquely owned taxonomy rows; found ${taxonomyOwners.size}` })
    }
  }
  gateResult(gates, 'family-catalog-and-manifests', findings.every(({ code }) => !code.includes('family') && !code.includes('taxonomy')), `${manifests.size} family manifests validated`)

  const packMemberships = new Map<string, Set<string>>()
  for (const manifest of manifests.values()) {
    for (const membership of manifest.pathMemberships) {
      const values = packMemberships.get(membership.packId) ?? new Set<string>()
      values.add(membership.pathId)
      packMemberships.set(membership.packId, values)
    }
  }
  for (const indexed of index.packs) {
    const manifest = manifests.get(indexed.familyId)
    const packRef = manifest?.packRefs.find(({ packId }) => packId === indexed.packId)
    try {
      if (!manifest || !packRef) throw new Error('Pack is not owned by its indexed family manifest')
      if (!sameContentReference(packRef.graphShardRef, indexed.graph)) throw new Error('Graph receipt differs from its family manifest reference')
      const graph = await validateRepertoireGraphDocument(await readIndexedJson(rootReal, indexed.graph))
      const inventory = EligibleSourceEdgeInventoryV1Schema.parse(await readIndexedJson(rootReal, indexed.eligibleInventory))
      validateEligibleSourceEdgeInventory(graph, inventory)
      if (graph.releaseId !== index.releaseId || graph.pack.id !== indexed.packId) throw new Error('Graph identity differs from the promotion index')
      if (graph.pack.side !== packRef.side || graph.pack.rootNodeId !== packRef.rootNodeId) throw new Error('Graph pack does not match its family pack reference')
      const membership = packMemberships.get(graph.pack.id) ?? new Set()
      if (membership.size !== graph.paths.length || graph.paths.some(({ id }) => !membership.has(id))) {
        throw new Error('Family path membership is not exactly equal to the graph path inventory')
      }
      counts.packs += 1
      counts.paths += graph.paths.length
      counts.eligibleEdges += inventory.eligibleEdgeIds.length
    } catch (error) {
      findings.push(finding(error, 'pack-promotion-invalid', indexed.graph.path))
    }
  }
  const referencedPackCount = [...manifests.values()].reduce((total, manifest) => total + manifest.packRefs.length, 0)
  if (index.packs.length !== referencedPackCount || counts.packs !== referencedPackCount) {
    findings.push({ code: 'pack-inventory-incomplete', path: null, message: `Expected ${referencedPackCount} referenced packs; validated ${counts.packs}` })
  }
  gateResult(gates, 'graphs-and-exact-eligible-edge-inventories', counts.packs === referencedPackCount && !findings.some(({ code }) => code.startsWith('pack-')), `${counts.eligibleEdges} eligible edges retained with no top-N cutoff`)

  const expectedPuzzleRefs = new Map<string, { reference: ContentAddressedRefV1; familyIds: Set<string> }>()
  for (const manifest of manifests.values()) {
    for (const reference of manifest.puzzleShardRefs) {
      const prior = expectedPuzzleRefs.get(reference.id)
      if (prior && prior.reference.sha256 !== reference.sha256) {
        findings.push({ code: 'puzzle-reference-conflict', path: reference.path, message: 'Puzzle content ID has conflicting receipts' })
      }
      const record = prior ?? { reference, familyIds: new Set<string>() }
      record.familyIds.add(manifest.id)
      expectedPuzzleRefs.set(reference.id, record)
    }
  }
  const puzzleIds = new Set<string>()
  for (const indexed of index.puzzleShards) {
    try {
      const matching = [...expectedPuzzleRefs.values()].find(({ reference }) => sameContentReference(reference, indexed.shard))
      if (!matching) throw new Error('Puzzle shard is not referenced by an approved family manifest')
      if (indexed.familyIds.length !== matching.familyIds.size || indexed.familyIds.some((id) => !matching.familyIds.has(id))) {
        throw new Error('Puzzle shard family ownership differs from the family manifests')
      }
      const shard = TacticalPuzzleShardV1Schema.parse(await readIndexedJson(rootReal, indexed.shard))
      if (shard.releaseId !== index.releaseId) throw new Error('Puzzle shard belongs to another release')
      if (shard.familyIds.length !== indexed.familyIds.length || shard.familyIds.some((id) => !indexed.familyIds.includes(id))) {
        throw new Error('Puzzle shard content family IDs differ from the promotion index')
      }
      for (const puzzle of shard.puzzles) {
        if (puzzleIds.has(puzzle.puzzleId)) throw new Error(`Duplicate promoted puzzle ID ${puzzle.puzzleId}`)
        puzzleIds.add(puzzle.puzzleId)
      }
      counts.puzzleShards += 1
      counts.puzzles += shard.puzzles.length
    } catch (error) {
      findings.push(finding(error, 'puzzle-shard-invalid', indexed.shard.path))
    }
  }
  if (counts.puzzleShards !== expectedPuzzleRefs.size) {
    findings.push({ code: 'puzzle-shard-inventory-incomplete', path: null, message: `Expected ${expectedPuzzleRefs.size} referenced puzzle shards; validated ${counts.puzzleShards}` })
  }
  gateResult(gates, 'promoted-puzzle-shards', counts.puzzleShards === expectedPuzzleRefs.size && counts.puzzles > 0, `${counts.puzzles} promoted puzzles validated`)

  const gateDefinitions = [
    ['q2', Q2ReceiptSchema],
    ['engine', EngineReceiptSchema],
    ['scid', ScidReceiptSchema],
    ['puzzles', PuzzlePromotionReceiptSchema],
  ] as const
  for (const [id, schema] of gateDefinitions) {
    const receipt = index.promotionReceipts[id]
    if (!receipt) {
      findings.push({ code: `${id}-promotion-receipt-absent`, path: null, message: `Required ${id} promotion receipt is absent` })
      gateResult(gates, `${id}-promotion-receipt`, false, 'Required promotion evidence is absent')
      continue
    }
    try {
      const value = schema.parse(await readIndexedJson(rootReal, receipt))
      if (value.releaseId !== index.releaseId) throw new Error('Promotion receipt belongs to another release')
      if (
        value.gate === 'lichess-puzzle-promotion'
        && (value.promotedShardCount !== counts.puzzleShards || value.promotedPuzzleCount !== counts.puzzles)
      ) {
        throw new Error('Puzzle promotion totals differ from validated shards')
      }
      gateResult(gates, `${id}-promotion-receipt`, true, 'Receipt passed strict release-specific validation')
    } catch (error) {
      findings.push(finding(error, `${id}-promotion-receipt-invalid`, receipt.path))
      gateResult(gates, `${id}-promotion-receipt`, false, 'Receipt failed strict validation')
    }
  }

  return {
    schemaVersion: 1,
    audit: 'linerecall-family-promotion',
    generatedAt,
    releaseId,
    status: findings.length === 0 && gates.every(({ status }) => status === 'pass') ? 'pass' : 'blocked',
    counts,
    gates,
    findings,
  }
}

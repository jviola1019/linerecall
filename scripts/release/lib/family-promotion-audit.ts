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
  TacticalPuzzleShardPayloadV1Schema,
  type ContentAddressedRefV1,
  type OpeningFamilyManifestV1,
} from '../../../src/domain/opening-family.ts'
import { validateApprovedOpeningFamilyEditorialLedger } from '../../../src/domain/opening-family-editorial.ts'
import {
  EligibleSourceEdgeInventoryV1Schema,
  FamilyGraphProvenanceDocumentV1Schema,
  validateEligibleSourceEdgeInventory,
  validateRepertoireGraphDocument,
  type FamilyGraphProvenanceDocumentV1,
} from '../../../src/domain/repertoire.ts'
import { PuzzlePromotionReceiptV1Schema, sha256Json } from '../../data/puzzle-v3-contracts.ts'
import {
  derivePuzzlePromotionReceipt,
  validatePromotedPuzzleShardAgainstInventory,
  validatePuzzlePromotionProofInventory,
} from '../../data/puzzle-v3-promotion.ts'
import {
  FamilyEngineCampaignProofInventoryV1Schema,
  FamilyEngineCandidatePackV1Schema,
  FamilyEnginePackProofDocumentV1Schema,
  FamilyEnginePromotionReceiptV1Schema,
  deriveFamilyEnginePromotionReceipt,
} from '../../data/family-engine-v3-contracts.ts'
import {
  FamilyGraphBuildOutputV1Schema,
  FamilyGraphEngineProofSetV1Schema,
} from '../../data/family-graph-v3-contracts.ts'
import {
  FamilyScidCampaignReportV1Schema,
  FamilyScidCandidateInventoryV1Schema,
  FamilyScidPromotionReceiptV1Schema,
  deriveFamilyScidPromotionReceipt,
} from '../../data/family-scid-v3.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9_./-]{0,510}$/u
const MAX_INDEX_BYTES = 1 * 1024 * 1024
const MAX_NESTED_EVIDENCE_RECEIPT_BYTES = 1 * 1024 * 1024
const MAX_COMPRESSED_RESOURCE_BYTES = 64 * 1024 * 1024
const MAX_UNCOMPRESSED_RESOURCE_BYTES = 256 * 1024 * 1024
const EXPECTED_BROADCAST_GAMES = 1_146_297
const EXPECTED_BROADCAST_ARCHIVES = 78
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
  broadcast: FileReceiptSchema.optional(),
  q2: FileReceiptSchema.optional(),
  evidence: FileReceiptSchema.optional(),
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
  editorialLedger: FileReceiptSchema,
  familyGraphBuild: FileReceiptSchema,
  engineProofInventory: FileReceiptSchema,
  scidCrosscheckReport: FileReceiptSchema,
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
  puzzleProofInventory: FileReceiptSchema,
  promotionReceipts: GateFileMapSchema,
}).strict().superRefine((index, context) => {
  const allPaths = [
    index.catalog.path,
    index.editorialLedger.path,
    index.familyGraphBuild.path,
    index.engineProofInventory.path,
    index.scidCrosscheckReport.path,
    ...index.families.flatMap(({ manifest, provenance }) => [manifest.path, provenance.path]),
    ...index.packs.flatMap(({ graph, eligibleInventory }) => [graph.path, eligibleInventory.path]),
    ...index.puzzleShards.map(({ shard }) => shard.path),
    index.puzzleProofInventory.path,
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

const BroadcastReceiptSchema = BaseGateSchema.extend({
  gate: z.literal('lichess-broadcasts-through-2026-06'),
  archiveCount: z.literal(EXPECTED_BROADCAST_ARCHIVES),
  archivesComplete: z.literal(true),
  digestsVerified: z.literal(true),
  recordsSeen: z.literal(EXPECTED_BROADCAST_GAMES),
  publishedRecords: z.literal(EXPECTED_BROADCAST_GAMES),
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  deduplicated: z.number().int().nonnegative(),
  accountingReconciles: z.literal(true),
  finalExactReceiptSha256: z.string().regex(SHA256),
}).strict().superRefine((receipt, context) => {
  if (receipt.accepted + receipt.rejected + receipt.deduplicated !== receipt.recordsSeen) {
    context.addIssue({ code: 'custom', path: ['accountingReconciles'], message: 'Broadcast accepted, rejected, and deduplicated totals must reconcile exactly' })
  }
})

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
  finalExactReceiptSha256: z.string().regex(SHA256),
}).strict().superRefine((receipt, context) => {
  if (receipt.accepted + receipt.rejected + receipt.deduplicated !== receipt.recordsSeen) {
    context.addIssue({ code: 'custom', path: ['accountingReconciles'], message: 'Q2 accepted, rejected, and deduplicated totals must reconcile exactly' })
  }
})

const EvidenceReconciliationReceiptSchema = BaseGateSchema.extend({
  gate: z.literal('compact-v3-family-evidence-reconciliation'),
  broadcastExactReceiptSha256: z.string().regex(SHA256),
  q2ExactReceiptSha256: z.string().regex(SHA256),
  eligibleInventorySourceSha256s: z.array(z.string().regex(SHA256)).min(1).max(100_000),
  sourceEdgeInventoryComplete: z.literal(true),
  topNPracticeCutoffApplied: z.literal(false),
  hiddenEligiblePracticeBranches: z.literal(0),
  provenanceMissing: z.literal(0),
  illegalEdges: z.literal(0),
  quarantinedEdgesInDrills: z.literal(0),
}).strict().superRefine((receipt, context) => {
  if (new Set(receipt.eligibleInventorySourceSha256s).size !== receipt.eligibleInventorySourceSha256s.length) {
    context.addIssue({ code: 'custom', path: ['eligibleInventorySourceSha256s'], message: 'Eligible inventory source receipts must be unique' })
  }
})

const EngineReceiptSchema = FamilyEnginePromotionReceiptV1Schema
const ScidReceiptSchema = FamilyScidPromotionReceiptV1Schema

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

function sameFileReceipt(
  left: z.infer<typeof FileReceiptSchema>,
  right: z.infer<typeof FileReceiptSchema>,
): boolean {
  return left.path === right.path
    && left.sha256 === right.sha256
    && left.bytes === right.bytes
    && left.uncompressedBytes === right.uncompressedBytes
    && left.encoding === right.encoding
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function engineEdgeKey(fromEpd: string, uci: string, toEpd: string): string {
  return `${fromEpd}\0${uci}\0${toEpd}`
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
  const graphProvenanceByFamily = new Map<string, FamilyGraphProvenanceDocumentV1>()
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
        const provenance = FamilyGraphProvenanceDocumentV1Schema.parse(
          await readIndexedJson(rootReal, indexed.provenance),
        )
        if (provenance.releaseId !== index.releaseId || provenance.familyId !== manifest.id) {
          throw new Error('Graph provenance inventory identity differs from its family manifest')
        }
        for (const receipt of provenance.receipts) {
          const receiptPath = await safeExistingPath(rootReal, receipt.path)
          const receiptBytes = await readExactFile(
            receiptPath,
            receipt.bytes,
            MAX_NESTED_EVIDENCE_RECEIPT_BYTES,
          )
          if (createHash('sha256').update(receiptBytes).digest('hex') !== receipt.sha256) {
            throw new Error(`Nested ${receipt.kind} evidence receipt SHA-256 does not match its immutable binding`)
          }
          const payload = decodeJson(receiptBytes)
          if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error(`Nested ${receipt.kind} evidence receipt must contain a JSON object`)
          }
        }
        graphProvenanceByFamily.set(manifest.id, provenance)
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

  let editorialLedgerApproved = false
  try {
    if (!catalog) throw new Error('Editorial validation requires a valid promoted family catalog')
    const expectedFamilies = catalog.families.map((entry) => {
      const manifest = manifests.get(entry.id)
      if (!manifest) throw new Error(`Editorial validation is missing promoted manifest ${entry.id}`)
      return {
        id: entry.id,
        canonicalName: entry.canonicalName,
        aliases: entry.aliases,
        ecoCodes: entry.ecoCodes,
        taxonomyLineIds: manifest.taxonomyLineIds,
      }
    })
    validateApprovedOpeningFamilyEditorialLedger(
      await readIndexedJson(rootReal, index.editorialLedger),
      expectedFamilies,
    )
    editorialLedgerApproved = true
  } catch (error) {
    findings.push(finding(error, 'family-editorial-ledger-invalid', index.editorialLedger.path))
  }
  gateResult(
    gates,
    'family-editorial-review',
    editorialLedgerApproved,
    editorialLedgerApproved
      ? 'All 149 proposed families and 3,790 primary assignments have approved editorial decisions bound to the promoted catalog'
      : 'The complete human family/editorial ledger is absent, pending, or differs from the promoted catalog',
  )

  const packMemberships = new Map<string, Set<string>>()
  const eligibleInventorySourceSha256s = new Set<string>()
  const promotedGraphs = new Map<string, Awaited<ReturnType<typeof validateRepertoireGraphDocument>>>()
  let graphBuild: z.infer<typeof FamilyGraphBuildOutputV1Schema> | null = null
  try {
    graphBuild = FamilyGraphBuildOutputV1Schema.parse(await readIndexedJson(rootReal, index.familyGraphBuild))
    if (graphBuild.releaseId !== index.releaseId) throw new Error('Family graph build output belongs to another release')
    if (graphBuild.selectionPolicy.practiceBranches !== 'all-eligible-audited' || graphBuild.selectionPolicy.maximumPracticeBranches !== null) {
      throw new Error('Family graph build applied a practice-branch cutoff')
    }
  } catch (error) {
    findings.push(finding(error, 'family-graph-build-invalid', index.familyGraphBuild.path))
  }
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
      const provenance = graphProvenanceByFamily.get(manifest.id)
      if (!provenance) throw new Error(`Family ${manifest.id} has no validated graph provenance document`)
      const bindings = new Map(provenance.bindings.map((binding) => [binding.provenanceRef, binding]))
      const receipts = new Map(provenance.receipts.map((receipt) => [receipt.id, receipt]))
      const graphSubjects = [
        { kind: 'pack', id: graph.pack.id, provenanceRef: graph.pack.provenanceRef },
        ...graph.nodes.map(({ id, provenanceRef }) => ({ kind: 'node', id, provenanceRef })),
        ...graph.edges.map(({ id, provenanceRef }) => ({ kind: 'edge', id, provenanceRef })),
        ...graph.paths.map(({ id, provenanceRef }) => ({ kind: 'path', id, provenanceRef })),
      ]
      const unboundSubject = graphSubjects.find(({ provenanceRef }) => !bindings.has(provenanceRef))
      if (unboundSubject) {
        throw new Error(`Graph ${unboundSubject.kind} ${unboundSubject.id} has no immutable family provenance binding`)
      }
      for (const edge of graph.edges) {
        const binding = bindings.get(edge.provenanceRef)!
        const corpusKinds = new Set(binding.corpusReceiptIds.map((id) => receipts.get(id)?.kind))
        for (const cohort of edge.evidence.cohorts) {
          const requiredKind = cohort.source === 'broadcast' ? 'broadcast-corpus' : 'lichess-standard-corpus'
          if (!corpusKinds.has(requiredKind)) {
            throw new Error(`Graph edge ${edge.id} cohort ${cohort.cohortId} is not bound to its ${requiredKind} receipt`)
          }
        }
      }
      const membership = packMemberships.get(graph.pack.id) ?? new Set()
      if (membership.size !== graph.paths.length || graph.paths.some(({ id }) => !membership.has(id))) {
        throw new Error('Family path membership is not exactly equal to the graph path inventory')
      }
      eligibleInventorySourceSha256s.add(inventory.sourceReceiptSha256)
      promotedGraphs.set(graph.pack.id, graph)
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
  if (graphBuild) {
    const indexedByPack = new Map(index.packs.map((pack) => [pack.packId, pack]))
    if (graphBuild.packs.length !== index.packs.length) {
      findings.push({ code: 'family-graph-build-inventory-mismatch', path: index.familyGraphBuild.path, message: 'Graph build output and promotion index contain different pack counts' })
    }
    for (const built of graphBuild.packs) {
      const indexed = indexedByPack.get(built.packId)
      if (
        !indexed || indexed.familyId !== built.familyId ||
        !sameFileReceipt(built.graph, indexed.graph) ||
        !sameFileReceipt(built.eligibleInventory, indexed.eligibleInventory)
      ) {
        findings.push({ code: 'family-graph-build-inventory-mismatch', path: index.familyGraphBuild.path, message: `Graph build output does not exactly bind promoted pack ${built.packId}` })
      }
    }
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
  const promotedPuzzleShards = new Map<string, z.infer<typeof TacticalPuzzleShardPayloadV1Schema>>()
  for (const indexed of index.puzzleShards) {
    try {
      const matching = [...expectedPuzzleRefs.values()].find(({ reference }) => sameContentReference(reference, indexed.shard))
      if (!matching) throw new Error('Puzzle shard is not referenced by an approved family manifest')
      if (indexed.familyIds.length !== matching.familyIds.size || indexed.familyIds.some((id) => !matching.familyIds.has(id))) {
        throw new Error('Puzzle shard family ownership differs from the family manifests')
      }
      // Persisted shards omit `id`; a legacy or caller-controlled internal ID
      // fails this strict schema. Runtime identity is derived from the verified
      // content reference after these exact bytes pass SHA-256 verification.
      const shard = TacticalPuzzleShardPayloadV1Schema.parse(await readIndexedJson(rootReal, indexed.shard))
      if (shard.releaseId !== index.releaseId) throw new Error('Puzzle shard belongs to another release')
      if (shard.familyIds.length !== indexed.familyIds.length || shard.familyIds.some((id) => !indexed.familyIds.includes(id))) {
        throw new Error('Puzzle shard content family IDs differ from the promotion index')
      }
      for (const puzzle of shard.puzzles) {
        if (puzzleIds.has(puzzle.puzzleId)) throw new Error(`Duplicate promoted puzzle ID ${puzzle.puzzleId}`)
        puzzleIds.add(puzzle.puzzleId)
      }
      if (promotedPuzzleShards.has(indexed.shard.sha256)) {
        throw new Error('Promoted puzzle shard SHA-256 appears more than once')
      }
      promotedPuzzleShards.set(indexed.shard.sha256, shard)
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
    ['broadcast', BroadcastReceiptSchema],
    ['q2', Q2ReceiptSchema],
    ['evidence', EvidenceReconciliationReceiptSchema],
    ['engine', EngineReceiptSchema],
    ['scid', ScidReceiptSchema],
    ['puzzles', PuzzlePromotionReceiptV1Schema],
  ] as const
  let broadcastReceipt: z.infer<typeof BroadcastReceiptSchema> | null = null
  let q2Receipt: z.infer<typeof Q2ReceiptSchema> | null = null
  let evidenceReceipt: z.infer<typeof EvidenceReconciliationReceiptSchema> | null = null
  let engineReceipt: z.infer<typeof EngineReceiptSchema> | null = null
  let scidReceipt: z.infer<typeof ScidReceiptSchema> | null = null
  let puzzleReceipt: z.infer<typeof PuzzlePromotionReceiptV1Schema> | null = null
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
      if (value.gate === 'lichess-broadcasts-through-2026-06') broadcastReceipt = value
      if (value.gate === 'lichess-standard-q2-2026') q2Receipt = value
      if (value.gate === 'compact-v3-family-evidence-reconciliation') evidenceReceipt = value
      if (value.gate === 'stockfish-18-family-graphs') engineReceipt = value
      if (value.gate === 'scid-family-crosscheck') scidReceipt = value
      if (value.gate === 'lichess-puzzle-promotion') {
        puzzleReceipt = value
      } else {
        gateResult(gates, `${id}-promotion-receipt`, true, 'Receipt passed strict release-specific validation')
      }
    } catch (error) {
      findings.push(finding(error, `${id}-promotion-receipt-invalid`, receipt.path))
      gateResult(gates, `${id}-promotion-receipt`, false, 'Receipt failed strict validation')
    }
  }
  if (engineReceipt !== null) {
    try {
      if (!sameFileReceipt(engineReceipt.proofInventory, index.engineProofInventory)) {
        throw new Error('Engine promotion receipt and index reference different campaign proof inventories')
      }
      const inventory = FamilyEngineCampaignProofInventoryV1Schema.parse(
        await readIndexedJson(rootReal, index.engineProofInventory),
      )
      const derived = deriveFamilyEnginePromotionReceipt({
        inventory,
        proofInventory: index.engineProofInventory,
        completedAt: engineReceipt.completedAt,
      })
      if (JSON.stringify(derived) !== JSON.stringify(engineReceipt)) {
        throw new Error('Engine promotion receipt was not derived from the complete campaign proof inventory')
      }
      const campaignPacks = new Map(inventory.packs.map((pack) => [pack.packId, pack]))
      if (campaignPacks.size !== index.packs.length || inventory.packs.length !== index.packs.length) {
        throw new Error('Engine campaign and promoted graph index contain different pack inventories')
      }
      let checkedLearnerNodes = 0
      for (const indexed of index.packs) {
        const graph = promotedGraphs.get(indexed.packId)
        const campaign = campaignPacks.get(indexed.packId)
        if (!graph || !campaign || campaign.familyId !== indexed.familyId) {
          throw new Error(`Engine campaign does not own promoted pack ${indexed.packId}`)
        }
        const candidatePack = FamilyEngineCandidatePackV1Schema.parse(
          await readIndexedJson(rootReal, campaign.candidatePack),
        )
        const proofDocument = FamilyEnginePackProofDocumentV1Schema.parse(
          await readIndexedJson(rootReal, campaign.proofDocument),
        )
        const proofSet = FamilyGraphEngineProofSetV1Schema.parse(
          await readIndexedJson(rootReal, campaign.graphProofSet),
        )
        if (
          candidatePack.releaseId !== index.releaseId || candidatePack.familyId !== indexed.familyId ||
          candidatePack.packId !== indexed.packId || proofDocument.releaseId !== index.releaseId ||
          proofDocument.familyId !== indexed.familyId || proofDocument.packId !== indexed.packId ||
          proofSet.releaseId !== index.releaseId || proofSet.familyId !== indexed.familyId ||
          proofSet.packId !== indexed.packId
        ) throw new Error(`Engine proof resources have inconsistent identity for pack ${indexed.packId}`)
        if (
          proofDocument.candidatePackSha256 !== campaign.candidatePack.sha256 ||
          proofSet.candidatePackSha256 !== campaign.candidatePack.sha256 ||
          proofDocument.empiricalInventorySha256 !== candidatePack.empiricalInventorySha256 ||
          proofSet.empiricalInventorySha256 !== candidatePack.empiricalInventorySha256
        ) throw new Error(`Engine proof resources are not bound to the empirical candidate pack ${indexed.packId}`)
        if (
          proofDocument.engineSha256 !== inventory.engine.executableSha256 ||
          !sameStringSet(proofDocument.nnueSha256, inventory.engine.nnueSha256) ||
          proofDocument.settingsSha256 !== inventory.engine.settingsSha256
        ) throw new Error(`Engine proof document uses a different Stockfish campaign for pack ${indexed.packId}`)

        const candidates = new Map(candidatePack.learnerNodes.flatMap((node) => node.candidateEdges.map((edge) => [
          engineEdgeKey(edge.fromEpd, edge.uci, edge.toEpd),
          node.positionId,
        ] as const)))
        const documentProofs = new Map(proofDocument.analyses.flatMap((analysis) => analysis.edgeChecks.map(({ toEpd, check }) => [
          engineEdgeKey(analysis.epd, check.analyzedMoveUci, toEpd),
          check,
        ] as const)))
        const graphProofs = new Map(proofSet.proofs.map((proof) => [
          engineEdgeKey(proof.fromEpd, proof.uci, proof.toEpd),
          proof.check,
        ] as const))
        if (
          candidates.size !== campaign.candidateEdgeCount || documentProofs.size !== candidates.size ||
          graphProofs.size !== candidates.size || campaign.learnerNodeCount !== candidatePack.learnerNodes.length ||
          proofDocument.analyses.length !== candidatePack.learnerNodes.length
        ) throw new Error(`Engine proof counts do not reconcile for pack ${indexed.packId}`)
        for (const key of candidates.keys()) {
          const documentCheck = documentProofs.get(key)
          const graphCheck = graphProofs.get(key)
          if (!documentCheck || !graphCheck || JSON.stringify(documentCheck) !== JSON.stringify(graphCheck)) {
            throw new Error(`Engine candidate ${key} lacks one identical proof in pack ${indexed.packId}`)
          }
        }
        const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
        const graphChecks = new Map(graph.edges.flatMap((edge) => {
          const from = nodeById.get(edge.fromNodeId)
          const to = nodeById.get(edge.toNodeId)
          const check = edge.evidence.engine.check
          return from?.learnerTurn && to && check
            ? [[engineEdgeKey(from.epd, edge.uci, to.epd), check] as const]
            : []
        }))
        if (graphChecks.size !== graphProofs.size) {
          throw new Error(`Promoted graph and Stockfish proof set contain different learner edges for pack ${indexed.packId}`)
        }
        for (const [key, check] of graphProofs) {
          if (JSON.stringify(graphChecks.get(key)) !== JSON.stringify(check)) {
            throw new Error(`Promoted graph engine evidence differs at ${key}`)
          }
        }
        checkedLearnerNodes += candidatePack.learnerNodes.length
      }
      if (checkedLearnerNodes !== engineReceipt.learnerNodesChecked) {
        throw new Error('Engine campaign learner-node memberships do not reconcile to promoted packs')
      }
      gateResult(gates, 'engine-campaign-proof-inventory', true, `${checkedLearnerNodes} learner-node memberships were revalidated from complete Stockfish proofs`)
    } catch (error) {
      findings.push(finding(error, 'engine-campaign-proof-inventory-invalid', index.engineProofInventory.path))
      gateResult(gates, 'engine-campaign-proof-inventory', false, 'Stockfish proof inventory or promoted graph equality failed validation')
    }
  }
  if (scidReceipt !== null) {
    try {
      if (!sameFileReceipt(scidReceipt.crosscheckReport, index.scidCrosscheckReport)) {
        throw new Error('Scid promotion receipt and index reference different cross-check reports')
      }
      const report = FamilyScidCampaignReportV1Schema.parse(
        await readIndexedJson(rootReal, index.scidCrosscheckReport),
      )
      if (report.releaseId !== index.releaseId) throw new Error('Scid report belongs to another release')
      if (report.familyGraphBuildSha256 !== index.familyGraphBuild.sha256) {
        throw new Error('Scid report is not bound to the promoted family graph build output')
      }
      const candidateInventory = FamilyScidCandidateInventoryV1Schema.parse(
        await readIndexedJson(rootReal, report.candidateInventory),
      )
      if (
        candidateInventory.releaseId !== index.releaseId ||
        candidateInventory.familyGraphBuildSha256 !== index.familyGraphBuild.sha256
      ) throw new Error('Scid candidate inventory is not bound to the promoted family graph build')
      const candidates = new Map(candidateInventory.lines.map((line) => [line.lineId, line]))
      for (const result of report.results) {
        const candidate = candidates.get(result.lineId)
        if (
          !candidate || candidate.familyId !== result.familyId || candidate.packId !== result.packId ||
          candidate.pathId !== result.pathId || candidate.expectedBaseEco !== result.expectedBaseEco ||
          !candidate.drillEligible || candidate.engineQuarantined
        ) throw new Error(`Scid result ${result.lineId} is absent from the eligible candidate inventory`)
      }
      const promotedDrillPathIds = new Set([...promotedGraphs.values()].flatMap(({ paths }) => paths.map(({ id }) => id)))
      const derived = deriveFamilyScidPromotionReceipt({
        report,
        reportReceipt: index.scidCrosscheckReport,
        promotedDrillPathIds,
        completedAt: scidReceipt.completedAt,
      })
      if (JSON.stringify(derived) !== JSON.stringify(scidReceipt)) {
        throw new Error('Scid promotion receipt was not derived from the per-line cross-check report')
      }
      gateResult(gates, 'scid-crosscheck-report', true, `${report.results.length} stratified Scid results were revalidated`)
    } catch (error) {
      findings.push(finding(error, 'scid-crosscheck-report-invalid', index.scidCrosscheckReport.path))
      gateResult(gates, 'scid-crosscheck-report', false, 'Scid per-line report or graph-quarantine equality failed validation')
    }
  }
  if (puzzleReceipt !== null) {
    try {
      if (!sameFileReceipt(puzzleReceipt.proofInventory, index.puzzleProofInventory)) {
        throw new Error('Puzzle promotion receipt and index reference different proof inventories')
      }
      const proofInventory = validatePuzzlePromotionProofInventory(
        await readIndexedJson(rootReal, index.puzzleProofInventory),
      )
      if (
        proofInventory.releaseId !== index.releaseId ||
        puzzleReceipt.evidenceBindingSha256 !== proofInventory.evidenceBindingSha256 ||
        puzzleReceipt.evidenceBindingSha256 !== sha256Json(proofInventory.evidence) ||
        puzzleReceipt.engineCampaignSha256 !== proofInventory.evidence.engineCampaign.campaignSha256
      ) throw new Error('Puzzle proof inventory differs from its release, evidence, or engine-campaign binding')
      if (!broadcastReceipt || !q2Receipt || !evidenceReceipt || !engineReceipt) {
        throw new Error('Puzzle proof validation requires promoted broadcast, Q2, graph, and engine receipts')
      }
      if (
        proofInventory.evidence.compactEvidence.broadcast.finalExactReceiptSha256 !== broadcastReceipt.finalExactReceiptSha256 ||
        proofInventory.evidence.compactEvidence.q2.finalExactReceiptSha256 !== q2Receipt.finalExactReceiptSha256
      ) throw new Error('Puzzle proof inventory is not bound to both promoted exact-corpus receipts')
      if (
        proofInventory.evidence.familyAssociation.graphReconciliationSha256 !== index.promotionReceipts.evidence?.sha256
      ) throw new Error('Puzzle proof inventory is not bound to the promoted family evidence reconciliation')
      if (
        proofInventory.evidence.engineCampaign.executableSha256 !== engineReceipt.engineSha256 ||
        !sameStringSet(proofInventory.evidence.engineCampaign.nnueSha256, engineReceipt.nnueSha256)
      ) throw new Error('Puzzle proof inventory uses a different Stockfish executable or NNUE campaign')
      if (proofInventory.evidence.puzzleSource.sha256 !== puzzleReceipt.sourceSha256) {
        throw new Error('Puzzle promotion source digest differs from its verified proof inventory')
      }
      const promotedShards = [...promotedPuzzleShards].map(([sha256, shard]) => {
        validatePromotedPuzzleShardAgainstInventory({ shardSha256: sha256, shard, inventory: proofInventory })
        return { sha256, shard }
      })
      const derived = derivePuzzlePromotionReceipt({
        inventory: proofInventory,
        promotedShards,
        proofInventory: index.puzzleProofInventory,
        completedAt: puzzleReceipt.completedAt,
      })
      if (JSON.stringify(derived) !== JSON.stringify(puzzleReceipt)) {
        throw new Error('Puzzle promotion receipt was not derived from the validated shards and proofs')
      }
      gateResult(gates, 'puzzles-promotion-receipt', true, 'Every shipped puzzle and proof matches the bound Stockfish campaign')
    } catch (error) {
      findings.push(finding(error, 'puzzles-promotion-receipt-invalid', index.promotionReceipts.puzzles?.path ?? null))
      gateResult(gates, 'puzzles-promotion-receipt', false, 'Puzzle proof inventory or shipped proof mapping failed validation')
    }
  }
  const expectedInventorySources = [...eligibleInventorySourceSha256s].sort()
  const declaredInventorySources = [...(evidenceReceipt?.eligibleInventorySourceSha256s ?? [])].sort()
  const evidenceChainValid = broadcastReceipt !== null
    && q2Receipt !== null
    && evidenceReceipt !== null
    && evidenceReceipt.broadcastExactReceiptSha256 === broadcastReceipt.finalExactReceiptSha256
    && evidenceReceipt.q2ExactReceiptSha256 === q2Receipt.finalExactReceiptSha256
    && expectedInventorySources.length === declaredInventorySources.length
    && expectedInventorySources.every((sha256, indexValue) => sha256 === declaredInventorySources[indexValue])
  if (!evidenceChainValid) {
    findings.push({
      code: 'source-edge-reconciliation-mismatch',
      path: index.promotionReceipts.evidence?.path ?? null,
      message: 'Eligible source-edge inventories are not exactly bound to the promoted broadcast and Q2 exact evidence receipts',
    })
  }
  gateResult(
    gates,
    'source-edge-evidence-chain',
    evidenceChainValid,
    evidenceChainValid
      ? `${expectedInventorySources.length} eligible-inventory source receipt(s) are bound to both exact corpora`
      : 'The exact-corpus-to-eligible-inventory evidence chain is incomplete or inconsistent',
  )

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

import { Chess } from 'chess.js'
import { z } from 'zod'
import {
  DataManifestSchema,
  EngineScoreSchema,
  OpeningPartitionSchema,
  ProvenanceSchema,
  type BandStats,
  type EngineCheck,
  type MoveEvidence,
  type OpeningPartition,
} from '../domain/opening-data.ts'

const UciSchema = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u)
const EvidenceShardIdSchema = z.string().regex(/^s_[a-f0-9]{16}$/u)
/**
 * Fixed-width W/D/L counts are the hottest leaf in the global evidence
 * schema. At the verified JSON.parse boundary, a custom Zod predicate enforces
 * the same values as `z.array(z.number().int().nonnegative()).length(15)` while
 * deliberately requiring a plain dense array. That stricter shape avoids
 * retaining hostile prototypes/accessors and avoids a new 15-element clone for
 * every position and outgoing move in the audited index.
 */
export const WireCountsSchema = z.custom<number[]>((value) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 15) return false
  for (let index = 0; index < 15; index += 1) {
    // JSON.parse creates dense arrays with own data properties. Requiring that
    // shape prevents sparse arrays or hostile prototypes from supplying a
    // value that Array#every would otherwise skip or inherit.
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (!descriptor || !('value' in descriptor)) return false
    const count = descriptor.value as unknown
    if (!Number.isSafeInteger(count) || (count as number) < 0) return false
  }
  return true
}, { error: 'Expected exactly 15 nonnegative safe-integer result counts' })
const CountsSchema = WireCountsSchema
const ScoreWireSchema = z.tuple([z.union([z.literal(0), z.literal(1)]), z.number().int()])
const VariationWireSchema = z.tuple([
  z.number().int().min(1).max(5),
  z.number().int().nonnegative().nullable(),
  z.number().int().nonnegative().nullable(),
  z.number().int().nonnegative().nullable(),
  ScoreWireSchema,
  z.union([z.literal(0), z.literal(1), z.literal(2)]),
  z.string().min(4),
])
const EngineMoveWireSchema = z.tuple([UciSchema, ScoreWireSchema.nullable(), z.string()])
const EnginePositionWireSchema = z.tuple([
  z.string().min(1).max(128),
  UciSchema,
  ScoreWireSchema,
  z.array(VariationWireSchema).min(1).max(5),
  z.array(EngineMoveWireSchema),
])
const PositionMoveWireSchema = z.tuple([UciSchema, CountsSchema])
const BookMoveWireSchema = z.tuple([
  UciSchema,
  z.array(z.number().int().min(0).max(3_789)).min(1).max(3_790),
])
const PositionWireSchema = z.tuple([
  z.string().min(1).max(128).refine(
    (value) => value.trim() === value && value.split(/\s+/u).length === 4,
  ),
  z.array(z.number().int().min(0).max(3_789)).max(3_790),
  CountsSchema,
  z.array(PositionMoveWireSchema).max(256),
  z.array(BookMoveWireSchema).max(256),
])

const MoveClassificationWireSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
])
const NodeMoveWireSchema = z.tuple([
  UciSchema,
  z.number().int().min(0).max(3),
  MoveClassificationWireSchema,
  z.number().int().nonnegative().nullable(),
])

export const WireSearchLineSchema = z.tuple([
  z.string().regex(/^tax_[a-f0-9]{24}$/u),
  z.string().regex(/^[A-E][0-9]{2}$/u),
  z.string().min(1).max(256),
  z.string().min(1).max(4_096),
  z.string().min(4).max(1_200).regex(/^[a-h][1-8][a-h][1-8][qrbn]?(?: [a-h][1-8][a-h][1-8][qrbn]?)*$/u),
  z.string().min(1).max(128).refine(
    (value) => value.trim() === value && value.split(/\s+/u).length === 4,
  ),
  z.number().int().nonnegative(),
  z.string().regex(/^prov_[a-f0-9]{16}$/u),
])

export const WireVariantSummarySchema = z.tuple([
  z.string().min(1).max(220),
  z.number().int().min(0).max(3_789),
  z.union([z.literal(0), z.literal(1)]),
  z.number().int().min(1).max(100),
])

const GraphPositionWireSchema = z.tuple([
  z.string().min(1).max(128).refine(
    (value) => value.trim() === value && value.split(/\s+/u).length === 4,
  ),
  z.array(BookMoveWireSchema).min(1).max(256),
])

export const WireSearchSnapshotSchema = z.object({
  v: z.literal(2),
  g: z.string().datetime({ offset: true }),
  l: z.array(WireSearchLineSchema).length(3_790),
  c: z.array(z.tuple([
    z.string().regex(/^[A-E][0-9]{2}$/u),
    z.number().int().nonnegative(),
    z.number().int().positive(),
  ])).length(500),
  x: z.array(WireVariantSummarySchema).min(1).max(1_155),
  q: z.array(GraphPositionWireSchema).min(1).max(7_824),
}).strict().superRefine((snapshot, context) => {
  let cursor = 0
  const lineIds = new Set<string>()
  for (const [index, line] of snapshot.l.entries()) {
    if (lineIds.has(line[0])) {
      context.addIssue({ code: 'custom', message: 'Search line IDs must be unique', path: ['l', index, 0] })
    }
    lineIds.add(line[0])
  }
  for (const [index, entry] of snapshot.c.entries()) {
    const volume = String.fromCharCode(65 + Math.floor(index / 100))
    const expectedEco = `${volume}${String(index % 100).padStart(2, '0')}`
    if (entry[0] !== expectedEco) {
      context.addIssue({ code: 'custom', message: `Expected catalog ECO ${expectedEco}`, path: ['c', index, 0] })
    }
    if (entry[1] !== cursor) {
      context.addIssue({ code: 'custom', message: 'Catalog slices must be contiguous', path: ['c', index, 1] })
    }
    for (let lineIndex = entry[1]; lineIndex < entry[1] + entry[2]; lineIndex += 1) {
      if (snapshot.l[lineIndex]?.[1] !== entry[0]) {
        context.addIssue({ code: 'custom', message: 'Catalog slice contains the wrong ECO', path: ['l', lineIndex, 1] })
        break
      }
    }
    cursor += entry[2]
  }
  if (cursor !== snapshot.l.length) {
    context.addIssue({ code: 'custom', message: 'Catalog slices do not cover every search line', path: ['c'] })
  }
  const variantIds = new Set<string>()
  let previousVariantId = ''
  for (const [index, variant] of snapshot.x.entries()) {
    const [variantId, sourceLineIndex, trainedSide, nodeCount] = variant
    const source = snapshot.l[sourceLineIndex]
    if (!source) {
      context.addIssue({ code: 'custom', message: 'Variant summary references an unknown source line', path: ['x', index, 1] })
      continue
    }
    if (variantIds.has(variantId)) {
      context.addIssue({ code: 'custom', message: 'Variant summary IDs must be unique', path: ['x', index, 0] })
    }
    variantIds.add(variantId)
    if (index > 0 && previousVariantId.localeCompare(variantId, 'en') >= 0) {
      context.addIssue({ code: 'custom', message: 'Variant summaries must be sorted by ID', path: ['x', index, 0] })
    }
    previousVariantId = variantId
    const side = trainedSide === 0 ? 'white' : 'black'
    if (variantId !== `${source[0]}:${side}`) {
      context.addIssue({ code: 'custom', message: 'Variant summary identity does not match its source and side', path: ['x', index, 0] })
    }
    const plyCount = source[4].split(' ').length
    const expectedNodeCount = trainedSide === 0 ? Math.ceil(plyCount / 2) : Math.floor(plyCount / 2)
    if (nodeCount !== expectedNodeCount) {
      context.addIssue({ code: 'custom', message: 'Variant card count does not cover every learner decision', path: ['x', index, 3] })
    }
  }
  const graphEpds = new Set<string>()
  for (const [positionIndex, position] of snapshot.q.entries()) {
    if (graphEpds.has(position[0])) {
      context.addIssue({ code: 'custom', message: 'Graph EPDs must be unique', path: ['q', positionIndex, 0] })
    }
    graphEpds.add(position[0])
    const moveUcis = new Set<string>()
    for (const [moveIndex, move] of position[1].entries()) {
      if (moveUcis.has(move[0])) {
        context.addIssue({ code: 'custom', message: 'Graph moves must be unique', path: ['q', positionIndex, 1, moveIndex, 0] })
      }
      moveUcis.add(move[0])
      if (new Set(move[1]).size !== move[1].length) {
        context.addIssue({ code: 'custom', message: 'Graph move line indexes must be unique', path: ['q', positionIndex, 1, moveIndex, 1] })
      }
      if (move[1].some((lineIndex) => snapshot.l[lineIndex] === undefined)) {
        context.addIssue({ code: 'custom', message: 'Graph move references an unknown line', path: ['q', positionIndex, 1, moveIndex, 1] })
      }
    }
  }
})

export const WireEvidenceSnapshotSchema = z.object({
  v: z.literal(1),
  g: z.string().datetime({ offset: true }),
  p: z.array(PositionWireSchema).length(7_824),
  e: z.array(EnginePositionWireSchema).min(1),
}).strict().superRefine((snapshot, context) => {
  const refinementStart = 'linerecall-evidence-invariants-start'
  globalThis.performance?.mark?.(refinementStart)
  const epds = new Set<string>()
  for (const [positionIndex, position] of snapshot.p.entries()) {
    if (epds.has(position[0])) {
      context.addIssue({ code: 'custom', message: 'Evidence EPDs must be unique', path: ['p', positionIndex, 0] })
    }
    epds.add(position[0])
    if (new Set(position[1]).size !== position[1].length) {
      context.addIssue({ code: 'custom', message: 'Position line indexes must be unique', path: ['p', positionIndex, 1] })
    }
    if (new Set(position[3].map((move) => move[0])).size !== position[3].length) {
      context.addIssue({ code: 'custom', message: 'Position moves must be unique', path: ['p', positionIndex, 3] })
    }
    if (new Set(position[4].map((move) => move[0])).size !== position[4].length) {
      context.addIssue({ code: 'custom', message: 'Book moves must be unique', path: ['p', positionIndex, 4] })
    }
  }
  const fens = new Set<string>()
  for (const [engineIndex, engine] of snapshot.e.entries()) {
    if (fens.has(engine[0])) {
      context.addIssue({ code: 'custom', message: 'Engine FENs must be unique', path: ['e', engineIndex, 0] })
    }
    fens.add(engine[0])
    if (new Set(engine[3].map((variation) => variation[0])).size !== engine[3].length) {
      context.addIssue({ code: 'custom', message: 'MultiPV ranks must be unique', path: ['e', engineIndex, 3] })
    }
    if (new Set(engine[4].map((move) => move[0])).size !== engine[4].length) {
      context.addIssue({ code: 'custom', message: 'Engine moves must be unique', path: ['e', engineIndex, 4] })
    }
  }
  globalThis.performance?.measure?.('linerecall-evidence-invariants', refinementStart)
})

export const WireEvidenceShardSchema = z.object({
  v: z.literal(2),
  g: z.string().datetime({ offset: true }),
  s: EvidenceShardIdSchema,
  c: z.array(z.string().regex(/^[A-E][0-9]{2}$/u)).min(1).max(500),
  p: z.array(z.tuple([z.number().int().min(0).max(7_823), PositionWireSchema])).max(7_824),
  a: z.array(z.tuple([z.number().int().min(0).max(649), EnginePositionWireSchema])).max(650),
}).strict().superRefine((shard, context) => {
  if (shard.p.length + shard.a.length === 0) {
    context.addIssue({ code: 'custom', message: 'Evidence shard must not be empty', path: ['p'] })
  }
  if ([...shard.c].sort((left, right) => left.localeCompare(right, 'en')).some((eco, index) => eco !== shard.c[index])) {
    context.addIssue({ code: 'custom', message: 'Evidence shard consumers must be sorted', path: ['c'] })
  }
  if (new Set(shard.c).size !== shard.c.length) {
    context.addIssue({ code: 'custom', message: 'Evidence shard consumers must be unique', path: ['c'] })
  }
  if (new Set(shard.p.map((entry) => entry[0])).size !== shard.p.length) {
    context.addIssue({ code: 'custom', message: 'Evidence shard position indexes must be unique', path: ['p'] })
  }
  const epds = new Set<string>()
  for (const [entryIndex, [, position]] of shard.p.entries()) {
    if (epds.has(position[0])) {
      context.addIssue({ code: 'custom', message: 'Evidence shard EPDs must be unique', path: ['p', entryIndex, 1, 0] })
    }
    epds.add(position[0])
    if (new Set(position[1]).size !== position[1].length) {
      context.addIssue({ code: 'custom', message: 'Position line indexes must be unique', path: ['p', entryIndex, 1, 1] })
    }
    if (new Set(position[3].map((move) => move[0])).size !== position[3].length) {
      context.addIssue({ code: 'custom', message: 'Position moves must be unique', path: ['p', entryIndex, 1, 3] })
    }
    if (new Set(position[4].map((move) => move[0])).size !== position[4].length) {
      context.addIssue({ code: 'custom', message: 'Book moves must be unique', path: ['p', entryIndex, 1, 4] })
    }
  }
  if (new Set(shard.a.map((entry) => entry[0])).size !== shard.a.length) {
    context.addIssue({ code: 'custom', message: 'Evidence shard engine indexes must be unique', path: ['a'] })
  }
  const fens = new Set<string>()
  for (const [entryIndex, [, engine]] of shard.a.entries()) {
    if (fens.has(engine[0])) {
      context.addIssue({ code: 'custom', message: 'Evidence shard engine FENs must be unique', path: ['a', entryIndex, 1, 0] })
    }
    fens.add(engine[0])
    if (new Set(engine[3].map((variation) => variation[0])).size !== engine[3].length) {
      context.addIssue({ code: 'custom', message: 'MultiPV ranks must be unique', path: ['a', entryIndex, 1, 3] })
    }
    if (new Set(engine[4].map((move) => move[0])).size !== engine[4].length) {
      context.addIssue({ code: 'custom', message: 'Engine moves must be unique', path: ['a', entryIndex, 1, 4] })
    }
  }
})

const VariantNodeWireSchema = z.tuple([
  z.string().min(1).max(240),
  z.number().int().nonnegative().max(200),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.array(z.string().min(1).max(500)),
  z.array(NodeMoveWireSchema).min(1).max(128),
])
const VariantWireSchema = z.tuple([
  z.string().min(1).max(220),
  z.number().int().nonnegative(),
  z.union([z.literal(0), z.literal(1)]),
  z.union([z.literal(0), z.literal(1)]),
  z.array(z.string().min(1).max(500)),
  z.number().int().min(0).max(5),
  z.array(VariantNodeWireSchema).min(1).max(100),
])

const PartitionLineWireSchema = z.tuple([
  z.number().int().min(0).max(3_789),
  z.number().int().min(0).max(7_823),
])

export const WirePartitionSchema = z.object({
  v: z.literal(2),
  g: z.string().datetime({ offset: true }),
  e: z.string().regex(/^[A-E][0-9]{2}$/u),
  l: z.array(PartitionLineWireSchema).min(1),
  s: z.array(EvidenceShardIdSchema).min(1).max(4_731),
  m: DataManifestSchema.shape.engine,
  r: z.array(ProvenanceSchema).min(1).max(3_790),
  x: z.array(VariantWireSchema).max(6),
}).strict().superRefine((partition, context) => {
  const lineIndexes = partition.l.map((line) => line[0])
  if (new Set(lineIndexes).size !== lineIndexes.length) {
    context.addIssue({ code: 'custom', message: 'Partition line indexes must be unique', path: ['l'] })
  }
  if (new Set(partition.s).size !== partition.s.length) {
    context.addIssue({ code: 'custom', message: 'Partition evidence shard references must be unique', path: ['s'] })
  }
  if (new Set(partition.r.map((provenance) => provenance.id)).size !== partition.r.length) {
    context.addIssue({ code: 'custom', message: 'Partition provenance IDs must be unique', path: ['r'] })
  }
  const variants = new Set<string>()
  const trainedSides = new Set<string>()
  for (const [variantIndex, variant] of partition.x.entries()) {
    if (variants.has(variant[0])) {
      context.addIssue({ code: 'custom', message: 'Variant IDs must be unique', path: ['x', variantIndex, 0] })
    }
    variants.add(variant[0])
    const sideKey = `${variant[1]}:${variant[2]}`
    if (trainedSides.has(sideKey)) {
      context.addIssue({ code: 'custom', message: 'Line trained-side variants must be unique', path: ['x', variantIndex, 2] })
    }
    trainedSides.add(sideKey)
    if (!lineIndexes.includes(variant[1])) {
      context.addIssue({ code: 'custom', message: 'Variant line index is outside the partition', path: ['x', variantIndex, 1] })
    }
    const nodeIds = new Set<string>()
    const plies = new Set<number>()
    for (const [nodeIndex, node] of variant[6].entries()) {
      if (nodeIds.has(node[0]) || plies.has(node[1])) {
        context.addIssue({ code: 'custom', message: 'Variant node IDs and plies must be unique', path: ['x', variantIndex, 6, nodeIndex] })
      }
      nodeIds.add(node[0])
      plies.add(node[1])
      if (new Set(node[5].map((move) => move[0])).size !== node[5].length) {
        context.addIssue({ code: 'custom', message: 'Node moves must be unique', path: ['x', variantIndex, 6, nodeIndex, 5] })
      }
    }
  }
})

export const WireBlobReceiptSchema = z.object({
  path: z.string().regex(/^(?:search|audit)\.json\.gz$|^partitions\/[A-E][0-9]{2}\.json\.gz$|^shards\/s_[a-f0-9]{16}\.json\.gz$/u),
  compressedBytes: z.number().int().positive(),
  uncompressedBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

export const WireAppManifestSchema = z.object({
  v: z.literal(2),
  g: z.string().datetime({ offset: true }),
  schema: z.literal('linerecall-app-wire-v2'),
  blobs: z.object({
    search: WireBlobReceiptSchema,
    audit: WireBlobReceiptSchema,
  }).strict(),
  shards: z.record(EvidenceShardIdSchema, WireBlobReceiptSchema),
  partitions: z.record(z.string().regex(/^[A-E][0-9]{2}$/u), WireBlobReceiptSchema),
  totals: z.object({
    lines: z.literal(3_790),
    positions: z.literal(7_824),
    enginePositions: z.number().int().positive(),
    variants: z.number().int().positive(),
    shards: z.number().int().positive(),
    maxSelectedEcoShards: z.number().int().positive(),
    maxSelectedEcoCompressedBytes: z.number().int().positive(),
    maxSelectedEcoUncompressedBytes: z.number().int().positive(),
    partitions: z.literal(500),
    compressedBytes: z.number().int().positive(),
    estimatedBase64Bytes: z.number().int().positive(),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const expectedCorePaths = {
    search: 'search.json.gz',
    audit: 'audit.json.gz',
  } as const
  for (const [key, expectedPath] of Object.entries(expectedCorePaths)) {
    if (manifest.blobs[key as keyof typeof manifest.blobs].path !== expectedPath) {
      context.addIssue({ code: 'custom', message: `Expected ${expectedPath}`, path: ['blobs', key, 'path'] })
    }
  }
  const partitionEntries = Object.entries(manifest.partitions)
  const shardEntries = Object.entries(manifest.shards)
  if (partitionEntries.length !== 500) {
    context.addIssue({ code: 'custom', message: 'Expected 500 partition receipts', path: ['partitions'] })
  }
  for (const [eco, receipt] of partitionEntries) {
    if (receipt.path !== `partitions/${eco}.json.gz`) {
      context.addIssue({ code: 'custom', message: 'Partition receipt path does not match its ECO', path: ['partitions', eco, 'path'] })
    }
  }
  if (shardEntries.length !== manifest.totals.shards) {
    context.addIssue({ code: 'custom', message: 'Evidence shard receipt count does not reconcile', path: ['shards'] })
  }
  if (manifest.totals.maxSelectedEcoShards >= manifest.totals.shards) {
    context.addIssue({ code: 'custom', message: 'An ECO selection must not inflate the entire evidence store', path: ['totals', 'maxSelectedEcoShards'] })
  }
  for (const [shardId, receipt] of shardEntries) {
    if (receipt.path !== `shards/${shardId}.json.gz`) {
      context.addIssue({ code: 'custom', message: 'Evidence shard receipt path does not match its ID', path: ['shards', shardId, 'path'] })
    }
  }
  const receipts = [...Object.values(manifest.blobs), ...shardEntries.map(([, receipt]) => receipt), ...partitionEntries.map(([, receipt]) => receipt)]
  if (new Set(receipts.map((receipt) => receipt.path)).size !== receipts.length) {
    context.addIssue({ code: 'custom', message: 'Blob receipt paths must be unique', path: ['partitions'] })
  }
  const compressedBytes = receipts.reduce((sum, receipt) => sum + receipt.compressedBytes, 0)
  const base64Bytes = receipts.reduce((sum, receipt) => sum + Math.ceil(receipt.compressedBytes / 3) * 4, 0)
  if (compressedBytes !== manifest.totals.compressedBytes) {
    context.addIssue({ code: 'custom', message: 'Compressed byte total does not reconcile', path: ['totals', 'compressedBytes'] })
  }
  if (base64Bytes !== manifest.totals.estimatedBase64Bytes) {
    context.addIssue({ code: 'custom', message: 'Base64 byte estimate does not reconcile', path: ['totals', 'estimatedBase64Bytes'] })
  }
})

export type WireSearchSnapshot = z.infer<typeof WireSearchSnapshotSchema>
export type WireEvidenceSnapshot = z.infer<typeof WireEvidenceSnapshotSchema>
export type WireEvidenceShard = z.infer<typeof WireEvidenceShardSchema>
export type WirePosition = WireEvidenceSnapshot['p'][number]
export type WireEnginePosition = WireEvidenceSnapshot['e'][number]
export type WirePartition = z.infer<typeof WirePartitionSchema>
export type WireBlobReceipt = z.infer<typeof WireBlobReceiptSchema>
export type WireAppManifest = z.infer<typeof WireAppManifestSchema>

export interface WirePartitionEvidence {
  positions: ReadonlyMap<number, WirePosition>
  engines: ReadonlyMap<number, WireEnginePosition>
}

const BANDS = ['<1800', '1800-1999', '2000-2199', '2200-2399', '2400+'] as const
const CROSSCHECK = [
  'match',
  'naming_difference',
  'missing_oracle_entry',
  'base_eco_mismatch',
  'ambiguous_oracle_base',
  'not_sampled',
] as const
const MOVE_CLASSIFICATIONS = [
  'book',
  'playable',
  'inaccuracy',
  'mistake',
  'unverified_deviation',
] as const
function scoreFromWire(score: z.infer<typeof ScoreWireSchema>): z.infer<typeof EngineScoreSchema> {
  return score[0] === 0 ? { kind: 'centipawn', value: score[1] } : { kind: 'mate', value: score[1] }
}

function scoreOrderingValue(score: z.infer<typeof EngineScoreSchema>): number {
  if (score.kind === 'centipawn') return score.value
  if (score.value > 0) return 1_000_000 - Math.min(score.value, 999) * 1_000
  if (score.value < 0) return -1_000_000 + Math.min(Math.abs(score.value), 999) * 1_000
  return 0
}

function centipawnLoss(
  best: z.infer<typeof EngineScoreSchema>,
  candidate: z.infer<typeof EngineScoreSchema>,
): number {
  return Math.max(0, scoreOrderingValue(best) - scoreOrderingValue(candidate))
}

function rawAt(counts: number[], index: number): { whiteWins: number; draws: number; blackWins: number; n: number } {
  const whiteWins = counts[index * 3] ?? 0
  const draws = counts[index * 3 + 1] ?? 0
  const blackWins = counts[index * 3 + 2] ?? 0
  return { whiteWins, draws, blackWins, n: whiteWins + draws + blackWins }
}

function rate(value: number, n: number): number | null {
  return n === 0 ? null : Math.round((value / n) * 10_000) / 100
}

function statsFromCounts(counts: number[], side: 'white' | 'black'): BandStats[] {
  return BANDS.map((band, index) => {
    const raw = rawAt(counts, index)
    const wins = side === 'white' ? raw.whiteWins : raw.blackWins
    const losses = side === 'white' ? raw.blackWins : raw.whiteWins
    return {
      band,
      ...raw,
      wins,
      losses,
      winRate: rate(wins, raw.n),
      drawRate: rate(raw.draws, raw.n),
      lossRate: rate(losses, raw.n),
      lowSample: raw.n > 0 && raw.n < 100,
    }
  })
}

function legalSanByUci(chess: Chess): Map<string, string> {
  return new Map(chess.moves({ verbose: true }).map((move) => [
    `${move.from}${move.to}${move.promotion ?? ''}`,
    move.san,
  ]))
}

function splitMoves(value: string): string[] {
  return value === '' ? [] : value.split(' ')
}

function assertMoveEvidencePolicy(move: MoveEvidence): void {
  if ((move.expected || move.acceptedBookTransposition) && move.classification !== 'book') {
    throw new Error(`Book move ${move.uci} has a non-book classification`)
  }
  if (move.independentlyEngineAnalyzed !== (move.score !== null)) {
    throw new Error(`Engine-analysis flag does not match score evidence for ${move.uci}`)
  }
  if (move.centipawnLoss !== null && move.score === null) {
    throw new Error(`Centipawn loss has no engine score for ${move.uci}`)
  }
  if (move.classification === 'playable' && (
    move.sampleSize < 100 || move.centipawnLoss === null || move.centipawnLoss > 50
  )) throw new Error(`Playable classification violates policy for ${move.uci}`)
  if (move.classification === 'inaccuracy' && (
    move.centipawnLoss === null || move.centipawnLoss < 51 || move.centipawnLoss > 99
  )) throw new Error(`Inaccuracy classification violates policy for ${move.uci}`)
  if (move.classification === 'mistake' && (
    move.centipawnLoss === null || (move.centipawnLoss < 100 && !(move.score?.kind === 'mate' && move.score.value < 0))
  )) throw new Error(`Mistake classification violates policy for ${move.uci}`)
  if (move.classification === 'unverified_deviation' && move.centipawnLoss !== null) {
    throw new Error(`Unverified deviation has a centipawn-loss claim for ${move.uci}`)
  }
}

export function hydrateWirePartition(options: {
  search: WireSearchSnapshot
  partition: WirePartition
  evidence: WirePartitionEvidence
}): OpeningPartition {
  const search = WireSearchSnapshotSchema.parse(options.search)
  const partition = WirePartitionSchema.parse(options.partition)
  return hydrateParsedWirePartition({ search, partition, evidence: options.evidence })
}

export function hydrateParsedWirePartition(options: {
  search: WireSearchSnapshot
  partition: WirePartition
  evidence: WirePartitionEvidence
}): OpeningPartition {
  const { search, partition, evidence } = options
  if (search.g !== partition.g) {
    throw new Error('Wire snapshot generation metadata does not match')
  }
  const catalogEntry = search.c.find((entry) => entry[0] === partition.e)
  if (!catalogEntry) throw new Error(`Wire partition ${partition.e} is absent from the search catalog`)
  const expectedLineIndexes = Array.from({ length: catalogEntry[2] }, (_, index) => catalogEntry[1] + index)
  const partitionLineIndexes = partition.l.map((line) => line[0])
  if (JSON.stringify(partitionLineIndexes) !== JSON.stringify(expectedLineIndexes)) {
    throw new Error(`Wire partition ${partition.e} does not match its canonical catalog slice`)
  }
  const provenanceById = new Map(partition.r.map((provenance) => [provenance.id, provenance]))
  if (provenanceById.size !== partition.r.length) throw new Error(`Wire partition ${partition.e} has duplicate provenance`)
  const requiredPositionIndexes = new Set(partition.l.map((line) => line[1]))
  const requiredEngineIndexes = new Set<number>()
  for (const variant of partition.x) {
    for (const node of variant[6]) {
      requiredEngineIndexes.add(node[2])
      requiredPositionIndexes.add(node[3])
    }
  }
  if (
    evidence.positions.size !== requiredPositionIndexes.size ||
    evidence.engines.size !== requiredEngineIndexes.size ||
    [...requiredPositionIndexes].some((index) => !evidence.positions.has(index)) ||
    [...requiredEngineIndexes].some((index) => !evidence.engines.has(index))
  ) throw new Error(`Wire partition ${partition.e} evidence shards do not exactly cover its references`)
  const variantsByLine = new Map<number, string[]>()
  const variantIds = new Set<string>()
  const variantSides = new Set<string>()
  for (const variant of partition.x) {
    if (!partitionLineIndexes.includes(variant[1])) {
      throw new Error(`Wire variant ${variant[0]} references a line outside partition ${partition.e}`)
    }
    if (variantIds.has(variant[0])) throw new Error(`Duplicate wire variant ${variant[0]}`)
    variantIds.add(variant[0])
    const sideKey = `${variant[1]}:${variant[2]}`
    if (variantSides.has(sideKey)) throw new Error(`Duplicate trained-side variant for line index ${variant[1]}`)
    variantSides.add(sideKey)
    const ids = variantsByLine.get(variant[1]) ?? []
    ids.push(variant[0])
    variantsByLine.set(variant[1], ids)
  }
  // A side-specific variant can revisit the same audited position through
  // several source lines or move orders. D36, for example, contains 47 node
  // occurrences backed by only 18 engine/position evidence pairs. Derive the
  // immutable evidence once per selected partition while retaining every
  // node-specific expected-move, classification, and quarantine check below.
  // The final OpeningPartitionSchema parse remains the runtime domain boundary.
  const countStatsCache = new WeakMap<number[], { white: BandStats[]; black: BandStats[]; sampleSize: number }>()
  const statsForCounts = (counts: number[], side: 'white' | 'black'): BandStats[] => {
    let cached = countStatsCache.get(counts)
    if (!cached) {
      cached = {
        white: statsFromCounts(counts, 'white'),
        black: statsFromCounts(counts, 'black'),
        sampleSize: counts.reduce((sum, value) => sum + value, 0),
      }
      countStatsCache.set(counts, cached)
    }
    return cached[side]
  }
  const sampleSizeForCounts = (counts: number[]): number => {
    let cached = countStatsCache.get(counts)
    if (!cached) {
      cached = {
        white: statsFromCounts(counts, 'white'),
        black: statsFromCounts(counts, 'black'),
        sampleSize: counts.reduce((sum, value) => sum + value, 0),
      }
      countStatsCache.set(counts, cached)
    }
    return cached.sampleSize
  }
  const emptyCounts = Array.from({ length: 15 }, () => 0)
  const positionDerivations = new Map<number, {
    epd: string
    equivalentPositionLineIds: string[]
    bookMoves: Map<string, number[]>
    positionMoves: Map<string, WirePosition[3][number]>
  }>()
  const positionDerivation = (index: number): {
    epd: string
    equivalentPositionLineIds: string[]
    bookMoves: Map<string, number[]>
    positionMoves: Map<string, WirePosition[3][number]>
  } => {
    const cached = positionDerivations.get(index)
    if (cached) return cached
    const position = evidence.positions.get(index)
    if (!position) throw new Error(`Wire partition ${partition.e} has an invalid position evidence index ${index}`)
    const derived = {
      epd: position[0],
      equivalentPositionLineIds: position[1]
        .map((lineIndex) => search.l[lineIndex]?.[0])
        .filter((id): id is string => id !== undefined),
      bookMoves: new Map(position[4].map((move) => [move[0], move[1]])),
      positionMoves: new Map(position[3].map((move) => [move[0], move])),
    }
    positionDerivations.set(index, derived)
    return derived
  }
  const engineDerivations = new Map<number, {
    fen: string
    epd: string
    side: 'white' | 'black'
    bestMoveUci: string
    bestScore: z.infer<typeof EngineScoreSchema>
    sanByUci: Map<string, string>
    engineMoves: Map<string, {
      score: z.infer<typeof EngineScoreSchema> | null
      principalVariationUci: string[]
    }>
    topVariations: EngineCheck['topVariations']
  }>()
  const engineDerivation = (index: number): {
    fen: string
    epd: string
    side: 'white' | 'black'
    bestMoveUci: string
    bestScore: z.infer<typeof EngineScoreSchema>
    sanByUci: Map<string, string>
    engineMoves: Map<string, {
      score: z.infer<typeof EngineScoreSchema> | null
      principalVariationUci: string[]
    }>
    topVariations: EngineCheck['topVariations']
  } => {
    const cached = engineDerivations.get(index)
    if (cached) return cached
    const engine = evidence.engines.get(index)
    if (!engine) throw new Error(`Wire partition ${partition.e} has an invalid engine evidence index ${index}`)
    const chess = new Chess(engine[0])
    const sanByUci = legalSanByUci(chess)
    const derived = {
      fen: engine[0],
      epd: chess.fen().split(' ').slice(0, 4).join(' '),
      side: (chess.turn() === 'w' ? 'white' : 'black') as 'white' | 'black',
      bestMoveUci: engine[1],
      bestScore: scoreFromWire(engine[2]),
      sanByUci,
      engineMoves: new Map(engine[4].map((move) => [move[0], {
        score: move[1] === null ? null : scoreFromWire(move[1]),
        principalVariationUci: splitMoves(move[2]),
      }])),
      topVariations: engine[3].map((variation) => ({
        multipv: variation[0],
        depth: variation[1],
        selectiveDepth: variation[2],
        nodes: variation[3],
        score: scoreFromWire(variation[4]),
        bound: variation[5] === 0 ? 'exact' as const : variation[5] === 1 ? 'lower' as const : 'upper' as const,
        movesUci: splitMoves(variation[6]),
      })),
    }
    engineDerivations.set(index, derived)
    return derived
  }
  const lines = partition.l.map(([lineIndex, terminalPositionIndex]) => {
    const line = search.l[lineIndex]
    if (!line || line[1] !== partition.e) throw new Error(`Wire partition ${partition.e} has an invalid line index`)
    const position = evidence.positions.get(terminalPositionIndex)
    if (!position) throw new Error(`Wire line ${line[0]} has no terminal position`)
    if (position[0] !== line[5]) throw new Error(`Wire line ${line[0]} terminal EPD does not match its position evidence`)
    const positionSampleSize = sampleSizeForCounts(position[2])
    if (positionSampleSize !== line[6]) {
      throw new Error(`Wire line ${line[0]} terminal sample does not match its position evidence`)
    }
    return {
      sourceLineId: line[0],
      eco: line[1],
      name: line[2],
      pgn: line[3],
      uci: splitMoves(line[4]),
      terminalSampleSize: line[6],
      terminalWhiteStats: statsForCounts(position[2], 'white'),
      terminalBlackStats: statsForCounts(position[2], 'black'),
      backtestEligible: line[6] >= 500,
      verifiedVariantIds: (variantsByLine.get(lineIndex) ?? []).sort((left, right) => left.localeCompare(right, 'en')),
      provenanceRef: line[7],
    }
  })
  const referencedProvenance = new Set(lines.map((line) => line.provenanceRef))
  if (
    referencedProvenance.size !== lines.length ||
    referencedProvenance.size !== partition.r.length ||
    [...referencedProvenance].some((reference) => !provenanceById.has(reference))
  ) throw new Error(`Wire partition ${partition.e} provenance does not exactly cover its lines`)
  const lineByIndex = new Map(partition.l.map(([lineIndex], index) => [lineIndex, lines[index]!]))
  const verifiedLines = partition.x.map((variant) => {
    const source = lineByIndex.get(variant[1])
    if (!source) throw new Error(`Wire variant ${variant[0]} references a line outside its partition`)
    const side = variant[2] === 0 ? 'white' : 'black'
    if ((variant[3] === 1) !== (variant[4].length === 0)) {
      throw new Error(`Wire variant ${variant[0]} has inconsistent drill/quarantine state`)
    }
    const nodes = variant[6].map((wireNode, nodeIndex) => {
      const engine = engineDerivation(wireNode[2])
      const position = positionDerivation(wireNode[3])
      const expectedMoveUci = source.uci[wireNode[1]]
      if (!expectedMoveUci) throw new Error(`Wire node ${wireNode[0]} has no expected move`)
      if ((wireNode[1] % 2 === 0 ? 'white' : 'black') !== side) {
        throw new Error(`Wire node ${wireNode[0]} is not a ${side} decision ply`)
      }
      if (engine.epd !== position.epd) {
        throw new Error(`Wire node ${wireNode[0]} engine and backtest positions differ`)
      }
      if (engine.side !== side) {
        throw new Error(`Wire node ${wireNode[0]} FEN has the wrong side to move`)
      }
      const nodeMoveIds = new Set<string>()
      const moves = wireNode[5].map((nodeMove): MoveEvidence => {
        const uci = nodeMove[0]
        if (nodeMoveIds.has(uci)) throw new Error(`Duplicate move ${uci} in wire node ${wireNode[0]}`)
        nodeMoveIds.add(uci)
        const positionMove = position.positionMoves.get(uci)
        const counts = positionMove?.[1] ?? emptyCounts
        const sampleSize = sampleSizeForCounts(counts)
        const independentlyEngineAnalyzed = (nodeMove[1] & 2) !== 0
        const analysis = independentlyEngineAnalyzed ? engine.engineMoves.get(uci) : undefined
        if (independentlyEngineAnalyzed && (!analysis || analysis.score === null)) {
          throw new Error(`Wire node ${wireNode[0]} is missing cached analysis for ${uci}`)
        }
        const score = analysis?.score ?? null
        const expected = uci === expectedMoveUci
        const acceptedBookTransposition = (nodeMove[1] & 1) !== 0
        const knownBook = (position.bookMoves.get(uci)?.length ?? 0) > 0 && !expected
        if (acceptedBookTransposition && !knownBook) {
          throw new Error(`Wire node ${wireNode[0]} has inconsistent book metadata for ${uci}`)
        }
        if (expected && acceptedBookTransposition) {
          throw new Error(`Wire node ${wireNode[0]} marks its expected move as a transposition`)
        }
        const classification = MOVE_CLASSIFICATIONS[nodeMove[2]]
        const san = engine.sanByUci.get(uci)
        if (!san) throw new Error(`Wire move ${uci} is illegal at ${engine.fen}`)
        const result: MoveEvidence = {
          uci,
          san,
          classification,
          expected,
          acceptedBookTransposition,
          sampleSize,
          bands: statsForCounts(counts, side),
          centipawnLoss: nodeMove[3],
          score,
          principalVariationUci: analysis?.principalVariationUci ?? [],
          independentlyEngineAnalyzed,
        }
        if (result.centipawnLoss !== null && result.score !== null &&
          result.centipawnLoss !== centipawnLoss(engine.bestScore, result.score)) {
          throw new Error(`Wire node ${wireNode[0]} has inconsistent centipawn loss for ${uci}`)
        }
        assertMoveEvidencePolicy(result)
        return result
      })
      if (!nodeMoveIds.has(expectedMoveUci)) {
        throw new Error(`Wire node ${wireNode[0]} does not retain its expected move`)
      }
      const expectedMove = moves.find((move) => move.expected)
      if (!expectedMove || expectedMove.centipawnLoss === null) {
        throw new Error(`Wire node ${wireNode[0]} expected move lacks exact engine evidence`)
      }
      if (!engine.sanByUci.has(engine.bestMoveUci)) {
        throw new Error(`Wire best move ${engine.bestMoveUci} is illegal at ${engine.fen}`)
      }
      return {
        id: wireNode[0],
        ply: wireNode[1],
        epd: position.epd,
        fen: engine.fen,
        sideToMove: side,
        expectedMoveUci,
        nextNodeId: variant[6][nodeIndex + 1]?.[0] ?? null,
        equivalentPositionLineIds: position.equivalentPositionLineIds,
        moves,
        engine: {
          engineRef: partition.m.id,
          bestMoveUci: engine.bestMoveUci,
          bestScore: engine.bestScore,
          expectedMoveCentipawnLoss: expectedMove.centipawnLoss,
          topVariations: engine.topVariations,
          analyzedAt: partition.m.analyzedAt,
          quarantined: wireNode[4].length > 0,
          quarantineReasons: wireNode[4],
        },
        provenanceRef: source.provenanceRef,
      }
    })
    return {
      id: variant[0],
      sourceLineId: source.sourceLineId,
      eco: source.eco,
      name: source.name,
      pgn: source.pgn,
      uci: source.uci,
      trainedSide: side,
      terminalSampleSize: source.terminalSampleSize,
      terminalStats: side === 'white' ? source.terminalWhiteStats : source.terminalBlackStats,
      drillEligible: variant[3] === 1,
      insufficientBacktestSample: false,
      selectedForEngineVerification: true,
      quarantined: variant[4].length > 0,
      quarantineReasons: variant[4],
      crosscheckStatus: CROSSCHECK[variant[5]] ?? 'not_sampled',
      nodes,
      provenanceRef: source.provenanceRef,
    }
  })
  return OpeningPartitionSchema.parse({
    schemaVersion: 1,
    eco: partition.e,
    generatedAt: search.g,
    lines,
    verifiedLines,
  })
}

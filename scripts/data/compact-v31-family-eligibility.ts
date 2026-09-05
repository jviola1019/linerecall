import { z } from 'zod'
import { FamilyIdSchema, FamilyPackIdSchema, FamilyReleaseIdSchema } from '../../src/domain/opening-family.ts'
import { EpdSchema } from '../../src/domain/opening-data.ts'
import { CompactV31FileReceiptSchema } from './compact-v31-contracts.ts'
import { MAXIMUM_AUDITED_FAMILY_PACKS } from './family-engine-v3-contracts.ts'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const IsoDateTimeSchema = z.string().datetime({ offset: true })
const EdgeIdSchema = z.string().regex(/^edge_[a-f0-9]{16,64}$/u)

const VerifiedCorpusBindingSchema = z.object({
  corpus: z.enum(['lichess-broadcasts', 'lichess-standard-rated-q2-2026']),
  corpusReceiptSha256: Sha256Schema,
  sourceManifestSha256: Sha256Schema,
  exactMergeReceiptSha256: Sha256Schema,
  sourceEdgeInventorySha256: Sha256Schema,
}).strict()

export const CompactV31FamilyRootEdgeInventorySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-family-root-edge-inventory'),
  releaseEligible: z.literal(false),
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  side: z.enum(['white', 'black']),
  packId: FamilyPackIdSchema,
  rootEpd: EpdSchema,
  corpusBindings: z.tuple([
    VerifiedCorpusBindingSchema.extend({ corpus: z.literal('lichess-broadcasts') }).strict(),
    VerifiedCorpusBindingSchema.extend({ corpus: z.literal('lichess-standard-rated-q2-2026') }).strict(),
  ]),
  /** Every edge with a single-corpus cell at N >= 100. */
  eligibleEdgeIds: z.array(EdgeIdSchema).min(1).max(2_000_000),
  /** The disjoint N >= 500 and N100-499 projections retained for consumers. */
  bookEdgeIds: z.array(EdgeIdSchema).min(0).max(2_000_000).optional(),
  exploratoryEdgeIds: z.array(EdgeIdSchema).min(0).max(2_000_000).optional(),
  taxonomyLineIds: z.array(z.string().regex(/^tax_[a-f0-9]{24}$/u)).min(1).max(3_790).optional(),
  completedAt: IsoDateTimeSchema,
}).strict().superRefine((inventory, context) => {
  if (new Set(inventory.eligibleEdgeIds).size !== inventory.eligibleEdgeIds.length) {
    context.addIssue({ code: 'custom', path: ['eligibleEdgeIds'], message: 'Eligible source-edge IDs must be unique' })
  }
  if (inventory.bookEdgeIds !== undefined && new Set(inventory.bookEdgeIds).size !== inventory.bookEdgeIds.length) {
    context.addIssue({ code: 'custom', path: ['bookEdgeIds'], message: 'Book edge IDs must be unique' })
  }
  if (inventory.exploratoryEdgeIds !== undefined && new Set(inventory.exploratoryEdgeIds).size !== inventory.exploratoryEdgeIds.length) {
    context.addIssue({ code: 'custom', path: ['exploratoryEdgeIds'], message: 'Exploratory edge IDs must be unique' })
  }
  if (inventory.bookEdgeIds !== undefined && inventory.exploratoryEdgeIds !== undefined) {
    const eligible = new Set(inventory.eligibleEdgeIds)
    if (inventory.bookEdgeIds.some((id) => !eligible.has(id)) || inventory.exploratoryEdgeIds.some((id) => !eligible.has(id))) {
      context.addIssue({ code: 'custom', path: ['eligibleEdgeIds'], message: 'Book and exploratory IDs must be eligible IDs' })
    }
    if (inventory.bookEdgeIds.some((id) => inventory.exploratoryEdgeIds!.includes(id))) {
      context.addIssue({ code: 'custom', path: ['exploratoryEdgeIds'], message: 'Book and exploratory IDs must be disjoint' })
    }
  }
})

export const CompactV31FamilyDispositionSchema = z.object({
  familyId: FamilyIdSchema,
  side: z.enum(['white', 'black']),
  taxonomyLineIds: z.array(z.string().regex(/^tax_[a-f0-9]{24}$/u)).min(1).max(3_790),
  readiness: z.enum(['trainable', 'study-only']),
  reason: z.enum(['eligible-root', 'insufficient-sample', 'no-root']),
  rootEpd: EpdSchema.nullable(),
}).strict().superRefine((entry, context) => {
  if (entry.readiness === 'trainable' && (entry.reason !== 'eligible-root' || entry.rootEpd === null)) {
    context.addIssue({ code: 'custom', path: ['readiness'], message: 'Trainable dispositions require an eligible root' })
  }
  if (entry.reason === 'no-root' && entry.rootEpd !== null) {
    context.addIssue({ code: 'custom', path: ['rootEpd'], message: 'No-root dispositions cannot name a root EPD' })
  }
})

export const CompactV31FamilyEligibilityIndexSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-compact-v31-family-eligibility-index'),
  releaseEligible: z.literal(false),
  releaseId: FamilyReleaseIdSchema,
  corpusBindings: z.tuple([
    VerifiedCorpusBindingSchema.extend({ corpus: z.literal('lichess-broadcasts') }).strict(),
    VerifiedCorpusBindingSchema.extend({ corpus: z.literal('lichess-standard-rated-q2-2026') }).strict(),
  ]),
  /** Digests of the exact pinned taxonomy and approved editorial ledger. */
  taxonomyInventorySha256: Sha256Schema,
  editorialLedgerSha256: Sha256Schema,
  /** The 149-family proposal/review denominator is independent of final taxonomy shape. */
  proposedFamilyCount: z.literal(149),
  /** Number of canonical families after the approved keep/merge/split/nest ledger. */
  familyCount: z.number().int().positive().max(3_790),
  /** Exactly one source-derived disposition for each learner side of every canonical family. */
  familyDispositions: z.array(CompactV31FamilyDispositionSchema).min(2).max(7_580),
  roots: z.array(z.object({
    familyId: FamilyIdSchema,
    side: z.enum(['white', 'black']),
    packId: FamilyPackIdSchema,
    eligibleEdgeCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    edgeInventory: CompactV31FileReceiptSchema,
  }).strict()).min(0).max(MAXIMUM_AUDITED_FAMILY_PACKS),
  completedAt: IsoDateTimeSchema,
}).strict().superRefine((index, context) => {
  const rootKeys = index.roots.map(({ familyId, side }) => `${familyId}:${side}`)
  const packIds = index.roots.map(({ packId }) => packId)
  const inventoryPaths = index.roots.map(({ edgeInventory }) => edgeInventory.path)
  if (new Set(rootKeys).size !== rootKeys.length) {
    context.addIssue({ code: 'custom', path: ['roots'], message: 'A family/side may own only one exact-state root inventory' })
  }
  if (new Set(packIds).size !== packIds.length) {
    context.addIssue({ code: 'custom', path: ['roots'], message: 'Every exact-state family root must own one distinct pack' })
  }
  if (new Set(inventoryPaths).size !== inventoryPaths.length) {
    context.addIssue({ code: 'custom', path: ['roots'], message: 'Every family root must own one distinct edge-inventory receipt' })
  }
  const dispositions = index.familyDispositions
  const keys = dispositions.map(({ familyId, side }) => `${familyId}:${side}`)
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', path: ['familyDispositions'], message: 'Family dispositions must be unique by family and side' })
  const familyIds = new Set(dispositions.map(({ familyId }) => familyId))
  if (familyIds.size !== index.familyCount) context.addIssue({ code: 'custom', path: ['familyDispositions'], message: `Family dispositions must cover exactly ${index.familyCount} canonical families` })
  if (dispositions.length !== index.familyCount * 2) context.addIssue({ code: 'custom', path: ['familyDispositions'], message: 'Family dispositions must contain exactly two learner sides per canonical family' })
  for (const familyId of familyIds) {
    if (!dispositions.some((entry) => entry.familyId === familyId && entry.side === 'white') ||
      !dispositions.some((entry) => entry.familyId === familyId && entry.side === 'black')) {
      context.addIssue({ code: 'custom', path: ['familyDispositions'], message: `Family ${familyId} must have both learner-side dispositions` })
    }
  }
})

export interface DeepVerifiedCorpusBinding {
  corpus: 'lichess-broadcasts' | 'lichess-standard-rated-q2-2026'
  corpusReceiptSha256: string
  sourceManifestSha256: string
  exactMergeReceiptSha256: string
  sourceEdgeInventorySha256: string
}

/** Only deep-audited corpus results may authorize a family eligibility index. */
export function validateFamilyEligibilityCorpusBindings(options: {
  index: unknown
  broadcast: DeepVerifiedCorpusBinding
  q2: DeepVerifiedCorpusBinding
}): z.infer<typeof CompactV31FamilyEligibilityIndexSchema> {
  const index = CompactV31FamilyEligibilityIndexSchema.parse(options.index)
  const expected = [options.broadcast, options.q2]
  if (expected[0]!.corpus !== 'lichess-broadcasts' || expected[1]!.corpus !== 'lichess-standard-rated-q2-2026') {
    throw new Error('Family eligibility requires deep-verified broadcast and Q2 bindings in canonical order')
  }
  if (JSON.stringify(index.corpusBindings) !== JSON.stringify(expected)) {
    throw new Error('Family eligibility index is not bound to the deep-verified corpus/source/merge/edge chain')
  }
  return index
}

/**
 * Rankings may order packs but cannot omit them. This equality check replaces
 * the historical 128-pack acceptance ceiling.
 */
export function assertCompleteFamilyPackInventory(options: {
  index: unknown
  emittedPacks: readonly { familyId: string; side: 'white' | 'black'; packId: string }[]
}): { packCount: number; familySideCount: number } {
  const index = CompactV31FamilyEligibilityIndexSchema.parse(options.index)
  const expected = new Map(index.roots.map((root) => [root.packId, `${root.familyId}:${root.side}`]))
  const emitted = new Map<string, string>()
  for (const pack of options.emittedPacks) {
    const familyId = FamilyIdSchema.parse(pack.familyId)
    const packId = FamilyPackIdSchema.parse(pack.packId)
    if (emitted.has(packId)) throw new Error(`Duplicate emitted pack ${packId}`)
    emitted.set(packId, `${familyId}:${pack.side}`)
  }
  const missing = [...expected].filter(([packId, key]) => emitted.get(packId) !== key)
  const extra = [...emitted].filter(([packId, key]) => expected.get(packId) !== key)
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Family pack inventory differs from exact-state eligibility: ${missing.length} missing, ${extra.length} extra`)
  }
  return { packCount: emitted.size, familySideCount: expected.size }
}

export type CompactV31FamilyEligibilityIndex = z.infer<typeof CompactV31FamilyEligibilityIndexSchema>

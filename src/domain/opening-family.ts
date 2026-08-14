import { z } from 'zod'
import {
  RepertoireGraphDocumentSchema,
  validateRepertoireGraphDocument,
  type RepertoireGraphDocument,
  type RepertoirePath,
} from './repertoire.ts'
import { PuzzleRecordV1Schema } from './tactical-puzzles.ts'
import { EcoCodeSchema, Sha256Schema } from './opening-data.ts'

export const OPENING_FAMILY_SCHEMA_VERSION = 1 as const

export const FamilyIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
export const FamilyBranchIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
export const FamilyPackIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}$/u)
export const FamilyPathIdSchema = z.string().regex(/^path_[a-f0-9]{20}$/u)
export const FamilyPositionIdSchema = z.string().regex(/^pos_[a-f0-9]{16}$/u)
export const TaxonomyLineIdSchema = z.string().regex(/^tax_[a-f0-9]{24}$/u)
export const FamilyReleaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,159}$/u)

const FAMILY_TEXT_MAX = 128
const SAFE_RESOURCE_PATH = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-z0-9][a-z0-9_./-]{0,238}\.json\.gz$/u

function isCanonicalText(value: string): boolean {
  return value === value.normalize('NFC').trim().replace(/\s+/gu, ' ')
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function normalizedIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function canonicalTextSchema(maximum = FAMILY_TEXT_MAX) {
  return z.string().min(1).max(maximum).refine(
    isCanonicalText,
    'Text must be NFC-normalized, trimmed, single-spaced, and free of control characters',
  )
}

function addUniqueIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  if (!unique(values)) context.addIssue({ code: 'custom', path, message })
}

function addIdentityIssues(
  canonicalName: string,
  aliases: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[] = ['aliases'],
): void {
  const identities = [canonicalName, ...aliases].map(normalizedIdentity)
  if (!unique(identities)) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'Canonical name and aliases must be unique after Unicode, case, and whitespace normalization',
    })
  }
}

export const ContentAddressedRefV1Schema = z.object({
  schemaVersion: z.literal(OPENING_FAMILY_SCHEMA_VERSION),
  id: z.string().regex(/^blob_[a-f0-9]{16}$/u),
  releaseId: FamilyReleaseIdSchema,
  path: z.string().min(8).max(256).regex(SAFE_RESOURCE_PATH),
  sha256: Sha256Schema,
  compressedBytes: z.number().int().positive().max(64 * 1024 * 1024),
  uncompressedBytes: z.number().int().positive().max(256 * 1024 * 1024),
  contentType: z.literal('application/json'),
  contentEncoding: z.literal('gzip'),
}).strict().superRefine((reference, context) => {
  if (reference.id !== `blob_${reference.sha256.slice(0, 16)}`) {
    context.addIssue({
      code: 'custom',
      path: ['id'],
      message: 'Content reference ID must equal the first 16 hexadecimal characters of its SHA-256',
    })
  }
})

export const FamilyPackRefV1Schema = z.object({
  schemaVersion: z.literal(OPENING_FAMILY_SCHEMA_VERSION),
  packId: FamilyPackIdSchema,
  side: z.enum(['white', 'black']),
  rootNodeId: FamilyPositionIdSchema,
  graphShardRef: ContentAddressedRefV1Schema,
}).strict()

export const FamilyBranchV1Schema = z.object({
  schemaVersion: z.literal(OPENING_FAMILY_SCHEMA_VERSION),
  id: FamilyBranchIdSchema,
  familyId: FamilyIdSchema,
  canonicalName: canonicalTextSchema(),
  parentId: FamilyBranchIdSchema.optional(),
  aliases: z.array(canonicalTextSchema()).max(64),
}).strict().superRefine((branch, context) => {
  if (branch.parentId === branch.id) {
    context.addIssue({ code: 'custom', path: ['parentId'], message: 'A branch cannot be its own parent' })
  }
  addIdentityIssues(branch.canonicalName, branch.aliases, context)
})

export const FamilyPathMembershipV1Schema = z.object({
  schemaVersion: z.literal(OPENING_FAMILY_SCHEMA_VERSION),
  packId: FamilyPackIdSchema,
  pathId: FamilyPathIdSchema,
  primaryBranchId: FamilyBranchIdSchema,
  secondaryBranchIds: z.array(FamilyBranchIdSchema).max(64),
}).strict().superRefine((membership, context) => {
  addUniqueIssues(
    membership.secondaryBranchIds,
    context,
    ['secondaryBranchIds'],
    'Secondary branch IDs must be unique',
  )
  if (membership.secondaryBranchIds.includes(membership.primaryBranchId)) {
    context.addIssue({
      code: 'custom',
      path: ['secondaryBranchIds'],
      message: 'The primary branch cannot also be a secondary branch',
    })
  }
})

export const OpeningFamilyManifestV1Schema = z.object({
  schemaVersion: z.literal(OPENING_FAMILY_SCHEMA_VERSION),
  releaseId: FamilyReleaseIdSchema,
  id: FamilyIdSchema,
  canonicalName: canonicalTextSchema(),
  aliases: z.array(canonicalTextSchema()).max(128),
  ecoCodes: z.array(EcoCodeSchema).min(1).max(500),
  taxonomyLineIds: z.array(TaxonomyLineIdSchema).min(1).max(3_790),
  packRefs: z.array(FamilyPackRefV1Schema).max(64),
  branches: z.array(FamilyBranchV1Schema).min(1).max(10_000),
  pathMemberships: z.array(FamilyPathMembershipV1Schema).max(100_000),
  puzzleShardRefs: z.array(ContentAddressedRefV1Schema).max(1_000),
  provenanceRef: ContentAddressedRefV1Schema,
}).strict().superRefine((manifest, context) => {
  addIdentityIssues(manifest.canonicalName, manifest.aliases, context)
  addUniqueIssues(manifest.ecoCodes, context, ['ecoCodes'], 'ECO codes must be unique')
  addUniqueIssues(
    manifest.taxonomyLineIds,
    context,
    ['taxonomyLineIds'],
    'Primary taxonomy line IDs must be unique within a family',
  )
  addUniqueIssues(
    manifest.packRefs.map(({ packId }) => packId),
    context,
    ['packRefs'],
    'Pack IDs must be unique within a family',
  )
  addUniqueIssues(
    manifest.packRefs.map(({ graphShardRef }) => graphShardRef.id),
    context,
    ['packRefs'],
    'Graph shard references must be unique within a family',
  )
  addUniqueIssues(
    manifest.branches.map(({ id }) => id),
    context,
    ['branches'],
    'Branch IDs must be unique within a family',
  )
  addUniqueIssues(
    manifest.pathMemberships.map(({ pathId }) => pathId),
    context,
    ['pathMemberships'],
    'Each path must have exactly one primary family membership',
  )
  addUniqueIssues(
    manifest.puzzleShardRefs.map(({ id }) => id),
    context,
    ['puzzleShardRefs'],
    'Puzzle shard references must be unique within a family',
  )

  const packIds = new Set(manifest.packRefs.map(({ packId }) => packId))
  const branches = new Map(manifest.branches.map((branch) => [branch.id, branch]))
  for (const [index, branch] of manifest.branches.entries()) {
    if (branch.familyId !== manifest.id) {
      context.addIssue({
        code: 'custom',
        path: ['branches', index, 'familyId'],
        message: 'Every branch must belong to its containing family',
      })
    }
    if (branch.parentId !== undefined && !branches.has(branch.parentId)) {
      context.addIssue({
        code: 'custom',
        path: ['branches', index, 'parentId'],
        message: 'Branch parent does not exist in this family',
      })
    }
  }

  for (const [index, branch] of manifest.branches.entries()) {
    const visited = new Set<string>([branch.id])
    let parentId = branch.parentId
    while (parentId !== undefined) {
      if (visited.has(parentId)) {
        context.addIssue({
          code: 'custom',
          path: ['branches', index, 'parentId'],
          message: 'Branch hierarchy contains a cycle',
        })
        break
      }
      visited.add(parentId)
      parentId = branches.get(parentId)?.parentId
    }
  }

  for (const [index, membership] of manifest.pathMemberships.entries()) {
    if (!packIds.has(membership.packId)) {
      context.addIssue({
        code: 'custom',
        path: ['pathMemberships', index, 'packId'],
        message: 'Path membership references a pack outside this family',
      })
    }
    for (const branchId of [membership.primaryBranchId, ...membership.secondaryBranchIds]) {
      if (!branches.has(branchId)) {
        context.addIssue({
          code: 'custom',
          path: ['pathMemberships', index],
          message: `Path membership references unknown branch ${branchId}`,
        })
      }
    }
  }

  const releaseRefs = [
    ...manifest.packRefs.map(({ graphShardRef }) => graphShardRef),
    ...manifest.puzzleShardRefs,
    manifest.provenanceRef,
  ]
  if (releaseRefs.some(({ releaseId }) => releaseId !== manifest.releaseId)) {
    context.addIssue({
      code: 'custom',
      message: 'Every content reference must use the family manifest release ID',
    })
  }
})

export const OpeningFamilyCatalogEntryV1Schema = z.object({
  schemaVersion: z.literal(OPENING_FAMILY_SCHEMA_VERSION),
  id: FamilyIdSchema,
  canonicalName: canonicalTextSchema(),
  aliases: z.array(canonicalTextSchema()).max(128),
  ecoCodes: z.array(EcoCodeSchema).min(1).max(500),
  taxonomyLineCount: z.number().int().positive().max(3_790),
  packCount: z.number().int().nonnegative().max(64),
  cardCount: z.number().int().nonnegative().max(100_000),
  availableSides: z.array(z.enum(['white', 'black'])).max(2),
  manifestRef: ContentAddressedRefV1Schema,
}).strict().superRefine((entry, context) => {
  addIdentityIssues(entry.canonicalName, entry.aliases, context)
  addUniqueIssues(entry.ecoCodes, context, ['ecoCodes'], 'ECO codes must be unique')
  addUniqueIssues(entry.availableSides, context, ['availableSides'], 'Available sides must be unique')
})

export const OpeningFamilyCatalogV1Schema = z.object({
  schemaVersion: z.literal(OPENING_FAMILY_SCHEMA_VERSION),
  releaseId: FamilyReleaseIdSchema,
  generatedAt: z.string().datetime({ offset: true }),
  taxonomyLineCount: z.number().int().positive().max(3_790),
  familyCount: z.number().int().positive().max(3_790),
  families: z.array(OpeningFamilyCatalogEntryV1Schema).min(1).max(3_790),
}).strict().superRefine((catalog, context) => {
  if (catalog.familyCount !== catalog.families.length) {
    context.addIssue({ code: 'custom', path: ['familyCount'], message: 'Family count does not match catalog entries' })
  }
  addUniqueIssues(catalog.families.map(({ id }) => id), context, ['families'], 'Family IDs must be unique')
  addUniqueIssues(
    catalog.families.map(({ manifestRef }) => manifestRef.id),
    context,
    ['families'],
    'Family manifest references must be unique',
  )

  const globalIdentities = new Map<string, string>()
  for (const [index, family] of catalog.families.entries()) {
    if (family.manifestRef.releaseId !== catalog.releaseId) {
      context.addIssue({
        code: 'custom',
        path: ['families', index, 'manifestRef', 'releaseId'],
        message: 'Family manifest reference uses another release',
      })
    }
    for (const identity of [family.canonicalName, ...family.aliases]) {
      const key = normalizedIdentity(identity)
      const owner = globalIdentities.get(key)
      if (owner !== undefined && owner !== family.id) {
        context.addIssue({
          code: 'custom',
          path: ['families', index, 'aliases'],
          message: `Normalized family identity conflicts with ${owner}`,
        })
      } else {
        globalIdentities.set(key, family.id)
      }
    }
  }
})

export const FamilyTrainingCursorV1Schema = z.object({
  schemaVersion: z.literal(OPENING_FAMILY_SCHEMA_VERSION),
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  side: z.enum(['white', 'black']),
  coverageCycleId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::coverage:[0-9]+$/u),
  authoritativeDueCardIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::pos_[a-f0-9]{16}$/u)).max(100_000),
  reviewedCardIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::pos_[a-f0-9]{16}$/u)).max(100_000),
  completedPathIds: z.array(FamilyPathIdSchema).max(100_000),
  pendingPathIds: z.array(FamilyPathIdSchema).max(100_000),
  batchIndex: z.number().int().nonnegative(),
}).strict().superRefine((cursor, context) => {
  const coveragePackId = cursor.coverageCycleId.slice(
    0,
    cursor.coverageCycleId.indexOf('::coverage:'),
  )
  for (const [key, values] of [
    ['authoritativeDueCardIds', cursor.authoritativeDueCardIds],
    ['reviewedCardIds', cursor.reviewedCardIds],
    ['completedPathIds', cursor.completedPathIds],
    ['pendingPathIds', cursor.pendingPathIds],
  ] as const) {
    addUniqueIssues(values, context, [key], `${key} must be unique`)
  }
  if (cursor.reviewedCardIds.some((cardId) => !cursor.authoritativeDueCardIds.includes(cardId))) {
    context.addIssue({
      code: 'custom',
      path: ['reviewedCardIds'],
      message: 'Reviewed cards must belong to the authoritative due-card set',
    })
  }
  if (cursor.completedPathIds.some((pathId) => cursor.pendingPathIds.includes(pathId))) {
    context.addIssue({
      code: 'custom',
      path: ['pendingPathIds'],
      message: 'A path cannot be both completed and pending',
    })
  }
  for (const [key, cardIds] of [
    ['authoritativeDueCardIds', cursor.authoritativeDueCardIds],
    ['reviewedCardIds', cursor.reviewedCardIds],
  ] as const) {
    if (cardIds.some((cardId) => !cardId.startsWith(`${coveragePackId}::pos_`))) {
      context.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} must belong to the coverage-cycle graph pack`,
      })
    }
  }
})

export const FamilyCoverageEventV1Schema = z.object({
  schemaVersion: z.literal(OPENING_FAMILY_SCHEMA_VERSION),
  eventId: z.string().uuid(),
  releaseId: FamilyReleaseIdSchema,
  familyId: FamilyIdSchema,
  packId: FamilyPackIdSchema,
  pathId: FamilyPathIdSchema,
  coverageCycleId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}::coverage:[0-9]+$/u),
  completedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((event, context) => {
  if (!event.coverageCycleId.startsWith(`${event.packId}::coverage:`)) {
    context.addIssue({
      code: 'custom',
      path: ['coverageCycleId'],
      message: 'Coverage cycle must belong to the completed graph pack',
    })
  }
})

export const TacticalPuzzleShardV1Schema = z.object({
  schemaVersion: z.literal(OPENING_FAMILY_SCHEMA_VERSION),
  id: z.string().regex(/^blob_[a-f0-9]{16}$/u),
  releaseId: FamilyReleaseIdSchema,
  generatedAt: z.string().datetime({ offset: true }),
  familyIds: z.array(FamilyIdSchema).min(1).max(256),
  puzzles: z.array(PuzzleRecordV1Schema).max(10_000),
}).strict().superRefine((shard, context) => {
  addUniqueIssues(shard.familyIds, context, ['familyIds'], 'Puzzle shard family IDs must be unique')
  addUniqueIssues(
    shard.puzzles.map(({ puzzleId }) => puzzleId),
    context,
    ['puzzles'],
    'Puzzle IDs must be unique within a shard',
  )
})

export type ContentAddressedRefV1 = z.infer<typeof ContentAddressedRefV1Schema>
export type FamilyPackRefV1 = z.infer<typeof FamilyPackRefV1Schema>
export type FamilyBranchV1 = z.infer<typeof FamilyBranchV1Schema>
export type FamilyPathMembershipV1 = z.infer<typeof FamilyPathMembershipV1Schema>
export type OpeningFamilyManifestV1 = z.infer<typeof OpeningFamilyManifestV1Schema>
export type OpeningFamilyCatalogEntryV1 = z.infer<typeof OpeningFamilyCatalogEntryV1Schema>
export type OpeningFamilyCatalogV1 = z.infer<typeof OpeningFamilyCatalogV1Schema>
export type FamilyTrainingCursorV1 = z.infer<typeof FamilyTrainingCursorV1Schema>
export type FamilyCoverageEventV1 = z.infer<typeof FamilyCoverageEventV1Schema>
export type TacticalPuzzleShardV1 = z.infer<typeof TacticalPuzzleShardV1Schema>

export interface FamilyBranchPathFactV1 {
  packId: string
  pathId: string
  learnerDecisionCount: number
  terminalStatus: RepertoirePath['terminalStatus']
}

export interface FamilyBranchRouteSummaryV1 {
  key: string
  canonicalName: string
  aliases: string[]
  branchIds: string[]
  pathIds: string[]
  routeCount: number
  minimumDepth: number
  maximumDepth: number
  terminalStatuses: RepertoirePath['terminalStatus'][]
  searchText: string
}

/**
 * Verifies the manifest-to-graph ownership boundary synchronously after a
 * content-addressed loader has completed the graph's deeper semantic audit.
 * Runtime consumers must not infer ownership from graph labels.
 */
export function validateFamilyPackGraphOwnership(input: {
  manifest: unknown
  packId: string
  graph: unknown
}): {
  manifest: OpeningFamilyManifestV1
  packRef: FamilyPackRefV1
  graph: RepertoireGraphDocument
} {
  const manifest = OpeningFamilyManifestV1Schema.parse(input.manifest)
  const graph = RepertoireGraphDocumentSchema.parse(input.graph)
  const packRef = manifest.packRefs.find(({ packId }) => packId === input.packId)
  const issues: string[] = []
  if (!packRef) {
    issues.push(`Pack ${input.packId} is not owned by family ${manifest.id}`)
  } else {
    if (graph.releaseId !== manifest.releaseId) issues.push(`Graph ${input.packId} uses another release`)
    if (graph.pack.id !== packRef.packId) issues.push(`Graph ${input.packId} uses another pack identity`)
    if (graph.pack.side !== packRef.side) issues.push(`Graph ${input.packId} uses another learner side`)
    if (graph.pack.rootNodeId !== packRef.rootNodeId) issues.push(`Graph ${input.packId} uses another root position`)
    if (graph.pack.ecoCodes.some((eco) => !manifest.ecoCodes.includes(eco))) {
      issues.push(`Graph ${input.packId} contains an ECO code outside family ${manifest.id}`)
    }
    const membershipPathIds = manifest.pathMemberships
      .filter((membership) => membership.packId === packRef.packId)
      .map(({ pathId }) => pathId)
    if (!sameStringSet(membershipPathIds, graph.pack.pathIds)) {
      issues.push(`Family path memberships do not exactly cover graph ${input.packId}`)
    }
  }
  if (issues.length > 0) throw new OpeningFamilyRegistryError(issues)
  return { manifest, packRef: packRef!, graph }
}

/**
 * Builds the learner-facing syllabus exclusively from signed manifest branch
 * IDs and path memberships. Duplicate display labels collapse into one row,
 * while every path ID remains in that row's inventory.
 */
export function summarizeFamilyBranchRoutes(input: {
  manifest: unknown
  side: 'white' | 'black'
  paths: readonly FamilyBranchPathFactV1[]
}): FamilyBranchRouteSummaryV1[] {
  const manifest = OpeningFamilyManifestV1Schema.parse(input.manifest)
  const sidePackIds = new Set(
    manifest.packRefs.filter(({ side }) => side === input.side).map(({ packId }) => packId),
  )
  const memberships = manifest.pathMemberships.filter(({ packId }) => sidePackIds.has(packId))
  const pathFacts = new Map<string, FamilyBranchPathFactV1>()
  const issues: string[] = []
  for (const path of input.paths) {
    const key = `${path.packId}\0${path.pathId}`
    if (pathFacts.has(key)) issues.push(`Path ${path.pathId} was supplied more than once`)
    if (!sidePackIds.has(path.packId)) issues.push(`Path ${path.pathId} belongs to another learner side`)
    pathFacts.set(key, path)
  }
  const membershipKeys = new Set(memberships.map(({ packId, pathId }) => `${packId}\0${pathId}`))
  if (
    pathFacts.size !== membershipKeys.size
    || [...pathFacts.keys()].some((key) => !membershipKeys.has(key))
  ) {
    issues.push(`Branch syllabus paths do not exactly cover the ${input.side} manifest memberships`)
  }
  if (issues.length > 0) throw new OpeningFamilyRegistryError(issues)

  const branchById = new Map(manifest.branches.map((branch) => [branch.id, branch]))
  const groups = new Map<string, {
    canonicalName: string
    aliases: Set<string>
    branchIds: Set<string>
    pathIds: string[]
    depths: number[]
    terminalStatuses: Set<RepertoirePath['terminalStatus']>
    searchTerms: Set<string>
  }>()

  const addBranchHierarchy = (branchId: string, terms: Set<string>): void => {
    const visited = new Set<string>()
    let current = branchById.get(branchId)
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      terms.add(current.canonicalName)
      current.aliases.forEach((alias) => terms.add(alias))
      current = current.parentId ? branchById.get(current.parentId) : undefined
    }
  }

  for (const membership of memberships) {
    const branch = branchById.get(membership.primaryBranchId)!
    const fact = pathFacts.get(`${membership.packId}\0${membership.pathId}`)!
    const key = normalizedIdentity(branch.canonicalName)
    const group = groups.get(key) ?? {
      canonicalName: branch.canonicalName,
      aliases: new Set<string>(),
      branchIds: new Set<string>(),
      pathIds: [],
      depths: [],
      terminalStatuses: new Set<RepertoirePath['terminalStatus']>(),
      searchTerms: new Set<string>(),
    }
    branch.aliases.forEach((alias) => group.aliases.add(alias))
    group.branchIds.add(branch.id)
    group.pathIds.push(fact.pathId)
    group.depths.push(fact.learnerDecisionCount)
    group.terminalStatuses.add(fact.terminalStatus)
    addBranchHierarchy(branch.id, group.searchTerms)
    for (const secondaryBranchId of membership.secondaryBranchIds) {
      addBranchHierarchy(secondaryBranchId, group.searchTerms)
    }
    groups.set(key, group)
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      canonicalName: group.canonicalName,
      aliases: [...group.aliases].sort((left, right) => left.localeCompare(right, 'en')),
      branchIds: [...group.branchIds].sort((left, right) => left.localeCompare(right, 'en')),
      pathIds: [...group.pathIds],
      routeCount: group.pathIds.length,
      minimumDepth: Math.min(...group.depths),
      maximumDepth: Math.max(...group.depths),
      terminalStatuses: [...group.terminalStatuses].sort((left, right) => left.localeCompare(right, 'en')),
      searchText: [...group.searchTerms].join(' ').toLocaleLowerCase('en-US'),
    }))
    .sort((left, right) =>
      right.routeCount - left.routeCount
      || left.canonicalName.localeCompare(right.canonicalName, 'en'))
}

export interface OpeningFamilyRegistry {
  catalog: OpeningFamilyCatalogV1
  manifests: OpeningFamilyManifestV1[]
  repertoireGraphs: RepertoireGraphDocument[]
  puzzleShards: TacticalPuzzleShardV1[]
}

export class OpeningFamilyRegistryError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`Opening family registry validation failed: ${issues.join('; ')}`)
    this.name = 'OpeningFamilyRegistryError'
    this.issues = issues
  }
}

export async function validateOpeningFamilyRegistry(input: {
  catalog: unknown
  manifests: readonly unknown[]
  repertoireGraphs: readonly unknown[]
  expectedTaxonomyLineIds: readonly string[]
  puzzleShards?: readonly unknown[]
}): Promise<OpeningFamilyRegistry> {
  const catalog = OpeningFamilyCatalogV1Schema.parse(input.catalog)
  const manifests = input.manifests.map((manifest) => OpeningFamilyManifestV1Schema.parse(manifest))
  const repertoireGraphs = await Promise.all(input.repertoireGraphs.map((graph) =>
    validateRepertoireGraphDocument(RepertoireGraphDocumentSchema.parse(graph))))
  const puzzleShards = (input.puzzleShards ?? []).map((shard) => TacticalPuzzleShardV1Schema.parse(shard))
  const expectedTaxonomyLineIds = z.array(TaxonomyLineIdSchema).min(1).max(3_790).parse(input.expectedTaxonomyLineIds)
  const issues: string[] = []

  if (!unique(expectedTaxonomyLineIds)) issues.push('Expected taxonomy line IDs must be unique')
  if (catalog.taxonomyLineCount !== expectedTaxonomyLineIds.length) {
    issues.push('Catalog taxonomy total does not match the expected taxonomy inventory')
  }
  if (manifests.length !== catalog.families.length) {
    issues.push('Catalog and manifest family counts do not match')
  }

  const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]))
  if (manifestById.size !== manifests.length) issues.push('Family manifest IDs must be unique')
  const graphByPackId = new Map(repertoireGraphs.map((graph) => [graph.pack.id, graph]))
  if (graphByPackId.size !== repertoireGraphs.length) issues.push('Repertoire graph pack IDs must be globally unique')
  const catalogIds = new Set(catalog.families.map(({ id }) => id))
  if (manifests.some(({ id }) => !catalogIds.has(id))) issues.push('A family manifest is absent from the catalog')

  const ownedTaxonomyLines = new Map<string, string>()
  const referencedPackIds = new Set<string>()
  const referencedGraphRefs = new Set<string>()
  const referencedPuzzleRefs = new Map<string, Set<string>>()
  const allMembershipPaths = new Set<string>()

  for (const entry of catalog.families) {
    const manifest = manifestById.get(entry.id)
    if (!manifest) {
      issues.push(`Catalog family ${entry.id} has no manifest`)
      continue
    }
    if (manifest.releaseId !== catalog.releaseId) issues.push(`Family ${entry.id} uses another release`)
    if (
      manifest.canonicalName !== entry.canonicalName
      || !sameStringSet(manifest.aliases, entry.aliases)
      || !sameStringSet(manifest.ecoCodes, entry.ecoCodes)
      || manifest.taxonomyLineIds.length !== entry.taxonomyLineCount
      || manifest.packRefs.length !== entry.packCount
    ) issues.push(`Catalog summary for ${entry.id} does not match its manifest`)
    const manifestSides = [...new Set(manifest.packRefs.map(({ side }) => side))]
    if (!sameStringSet(manifestSides, entry.availableSides)) {
      issues.push(`Catalog sides for ${entry.id} do not match its manifest`)
    }

    for (const taxonomyLineId of manifest.taxonomyLineIds) {
      const owner = ownedTaxonomyLines.get(taxonomyLineId)
      if (owner !== undefined) issues.push(`Taxonomy line ${taxonomyLineId} has multiple primary families: ${owner}, ${entry.id}`)
      else ownedTaxonomyLines.set(taxonomyLineId, entry.id)
    }

    for (const puzzleRef of manifest.puzzleShardRefs) {
      const owners = referencedPuzzleRefs.get(puzzleRef.id) ?? new Set<string>()
      owners.add(manifest.id)
      referencedPuzzleRefs.set(puzzleRef.id, owners)
    }

    const membershipsByPack = new Map<string, FamilyPathMembershipV1[]>()
    let familyCardCount = 0
    for (const membership of manifest.pathMemberships) {
      if (allMembershipPaths.has(membership.pathId)) {
        issues.push(`Path ${membership.pathId} has multiple family memberships`)
      } else {
        allMembershipPaths.add(membership.pathId)
      }
      const memberships = membershipsByPack.get(membership.packId) ?? []
      memberships.push(membership)
      membershipsByPack.set(membership.packId, memberships)
    }

    for (const packRef of manifest.packRefs) {
      if (referencedPackIds.has(packRef.packId)) issues.push(`Pack ${packRef.packId} belongs to multiple families`)
      referencedPackIds.add(packRef.packId)
      if (referencedGraphRefs.has(packRef.graphShardRef.id)) {
        issues.push(`Graph shard ${packRef.graphShardRef.id} is assigned to multiple packs`)
      }
      referencedGraphRefs.add(packRef.graphShardRef.id)
      const graph = graphByPackId.get(packRef.packId)
      if (!graph) {
        issues.push(`Family ${entry.id} references missing graph pack ${packRef.packId}`)
        continue
      }
      if (graph.releaseId !== catalog.releaseId) issues.push(`Graph ${packRef.packId} uses another release`)
      if (graph.pack.side !== packRef.side) issues.push(`Graph ${packRef.packId} side does not match its family reference`)
      if (graph.pack.rootNodeId !== packRef.rootNodeId) issues.push(`Graph ${packRef.packId} root does not match its family reference`)
      if (graph.pack.ecoCodes.some((eco) => !manifest.ecoCodes.includes(eco))) {
        issues.push(`Graph ${packRef.packId} contains an ECO code outside family ${entry.id}`)
      }
      familyCardCount += graph.nodes.filter(({ cardId }) => cardId !== undefined).length
      const membershipPathIds = (membershipsByPack.get(packRef.packId) ?? []).map(({ pathId }) => pathId)
      if (!sameStringSet(membershipPathIds, graph.pack.pathIds)) {
        issues.push(`Family path memberships do not exactly cover graph ${packRef.packId}`)
      }
    }
    if (familyCardCount !== entry.cardCount) {
      issues.push(`Catalog card count for ${entry.id} does not match its validated graphs`)
    }
  }

  const expectedTaxonomySet = new Set(expectedTaxonomyLineIds)
  for (const taxonomyLineId of expectedTaxonomyLineIds) {
    if (!ownedTaxonomyLines.has(taxonomyLineId)) issues.push(`Taxonomy line ${taxonomyLineId} has no primary family`)
  }
  for (const taxonomyLineId of ownedTaxonomyLines.keys()) {
    if (!expectedTaxonomySet.has(taxonomyLineId)) issues.push(`Family registry contains unexpected taxonomy line ${taxonomyLineId}`)
  }
  for (const graph of repertoireGraphs) {
    if (!referencedPackIds.has(graph.pack.id)) issues.push(`Graph ${graph.pack.id} is not referenced by a family`)
  }

  const puzzleShardById = new Map<string, TacticalPuzzleShardV1>()
  const globalPuzzleIds = new Set<string>()
  for (const shard of puzzleShards) {
    // Puzzle content is bound to its receipt by the data source. Registry-level
    // validation verifies release, family ownership, and cross-shard identity.
    if (puzzleShardById.has(shard.id)) issues.push(`Puzzle shard ${shard.id} was loaded more than once`)
    puzzleShardById.set(shard.id, shard)
    if (shard.releaseId !== catalog.releaseId) issues.push('A puzzle shard uses another release')
    const expectedOwners = referencedPuzzleRefs.get(shard.id)
    if (expectedOwners === undefined) {
      issues.push(`Puzzle shard ${shard.id} is not referenced by a family`)
    } else if (!sameStringSet([...expectedOwners], shard.familyIds)) {
      issues.push(`Puzzle shard ${shard.id} family ownership does not match its manifest references`)
    }
    for (const familyId of shard.familyIds) {
      if (!manifestById.has(familyId)) issues.push(`Puzzle shard references unknown family ${familyId}`)
    }
    for (const puzzle of shard.puzzles) {
      if (globalPuzzleIds.has(puzzle.puzzleId)) issues.push(`Puzzle ${puzzle.puzzleId} appears in multiple shards`)
      globalPuzzleIds.add(puzzle.puzzleId)
    }
  }
  if (input.puzzleShards !== undefined) {
    for (const shardId of referencedPuzzleRefs.keys()) {
      if (!puzzleShardById.has(shardId)) issues.push(`Referenced puzzle shard ${shardId} was not loaded`)
    }
  }

  if (issues.length > 0) throw new OpeningFamilyRegistryError(issues)
  return { catalog, manifests, repertoireGraphs, puzzleShards }
}

function ecoRange(volume: string, first: number, last: number): string[] {
  return Array.from({ length: last - first + 1 }, (_, index) => `${volume}${String(first + index).padStart(2, '0')}`)
}

export const REQUIRED_OPENING_FAMILY_REGRESSIONS = [
  { id: 'caro-kann', ecoCodes: ecoRange('B', 10, 19) },
  { id: 'sicilian-defence', ecoCodes: ecoRange('B', 20, 99) },
  { id: 'ruy-lopez', ecoCodes: ecoRange('C', 60, 99) },
] as const

export function validateRequiredOpeningFamilyRegressions(
  manifestsInput: readonly unknown[],
): OpeningFamilyManifestV1[] {
  const manifests = manifestsInput.map((manifest) => OpeningFamilyManifestV1Schema.parse(manifest))
  const issues: string[] = []
  for (const requirement of REQUIRED_OPENING_FAMILY_REGRESSIONS) {
    const matching = manifests.filter(({ id }) => id === requirement.id)
    if (matching.length !== 1) {
      issues.push(`Required family ${requirement.id} must appear exactly once`)
      continue
    }
    if (!sameStringSet(matching[0]!.ecoCodes, requirement.ecoCodes)) {
      issues.push(`Required family ${requirement.id} must own ECO range ${requirement.ecoCodes[0]}-${requirement.ecoCodes.at(-1)}`)
    }
  }
  if (issues.length > 0) throw new OpeningFamilyRegistryError(issues)
  return manifests
}

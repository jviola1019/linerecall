import { z } from 'zod'
import {
  ContentAddressedRefV1Schema,
  FamilyIdSchema,
  FamilyReleaseIdSchema,
  OpeningFamilyCatalogV1Schema,
  TaxonomyLineIdSchema,
  type ContentAddressedRefV1,
  type OpeningFamilyCatalogV1,
  type OpeningFamilyManifestV1,
} from '../../src/domain/opening-family.ts'
import { EcoCodeSchema } from '../../src/domain/opening-data.ts'
import { NormalizedTaxonomyLineSchema } from '../../src/data/taxonomy-schema.ts'

const FamilySourceRowSchema = z.union([
  z.object({
    sourceLineId: TaxonomyLineIdSchema,
    eco: EcoCodeSchema,
    name: z.string().min(1).max(256),
  }).strict(),
  NormalizedTaxonomyLineSchema.transform((line) => ({
    sourceLineId: line.id,
    eco: line.eco,
    name: line.name,
  })),
])

const FamilyRootOverrideSchema = z.object({
  sourceRoot: z.string().min(1).max(128),
  familyId: FamilyIdSchema,
  canonicalName: z.string().min(1).max(128),
  aliases: z.array(z.string().min(1).max(128)).max(64),
}).strict()

export interface OpeningFamilySeed {
  id: string
  canonicalName: string
  aliases: string[]
  ecoCodes: string[]
  taxonomyLineIds: string[]
  sourceRoots: string[]
}

export interface FamilyPackCatalogSummary {
  familyId: string
  packId: string
  side: 'white' | 'black'
  cardCount: number
}

export interface FamilyManifestCatalogReference {
  familyId: string
  manifestRef: ContentAddressedRefV1
}

export const REVIEWED_FAMILY_ROOT_OVERRIDES = [
  {
    sourceRoot: 'Caro-Kann Defense',
    familyId: 'caro-kann',
    canonicalName: 'Caro–Kann',
    aliases: ['Caro-Kann', 'Caro-Kann Defense'],
  },
  {
    sourceRoot: 'Sicilian Defense',
    familyId: 'sicilian-defence',
    canonicalName: 'Sicilian Defence',
    aliases: ['Sicilian Defense'],
  },
  {
    sourceRoot: 'Ruy Lopez',
    familyId: 'ruy-lopez',
    canonicalName: 'Ruy Lopez',
    aliases: ['Ruy Lopez Opening'],
  },
] as const

function familyRoot(name: string): string {
  return name.split(':', 1)[0]!.trim().replace(/\s+/gu, ' ')
}

export function familyIdFromRoot(root: string): string {
  const value = root
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return FamilyIdSchema.parse(value)
}

/**
 * Build-time-only candidate grouping. The returned ownership is persisted in
 * manifests; application runtime code must never infer family identity from a
 * display name.
 */
export function deriveOpeningFamilySeeds(
  rowsInput: readonly unknown[],
  overridesInput: readonly unknown[] = REVIEWED_FAMILY_ROOT_OVERRIDES,
): OpeningFamilySeed[] {
  const rows = z.array(FamilySourceRowSchema).min(1).max(3_790).parse(rowsInput)
  const overrides = z.array(FamilyRootOverrideSchema).max(3_790).parse(overridesInput)
  if (new Set(rows.map(({ sourceLineId }) => sourceLineId)).size !== rows.length) {
    throw new Error('Every taxonomy row must have a unique sourceLineId before family derivation')
  }
  if (new Set(overrides.map(({ sourceRoot }) => sourceRoot)).size !== overrides.length) {
    throw new Error('Reviewed family root overrides must be unique')
  }
  const overrideByRoot = new Map(overrides.map((override) => [override.sourceRoot, override]))
  const ownerById = new Map<string, { sourceRoot: string; explicit: boolean; canonicalName: string }>()
  const seeds = new Map<string, OpeningFamilySeed>()

  for (const row of rows) {
    const sourceRoot = familyRoot(row.name)
    const override = overrideByRoot.get(sourceRoot)
    const familyId = override?.familyId ?? familyIdFromRoot(sourceRoot)
    const priorOwner = ownerById.get(familyId)
    if (priorOwner !== undefined && priorOwner.sourceRoot !== sourceRoot) {
      if (!priorOwner.explicit || override === undefined) {
        throw new Error(`Family slug ${familyId} is ambiguous for ${priorOwner.sourceRoot} and ${sourceRoot}; add reviewed overrides`)
      }
      if (priorOwner.canonicalName !== override.canonicalName) {
        throw new Error(`Reviewed roots merged into ${familyId} must use one canonical family name`)
      }
    }
    ownerById.set(familyId, {
      sourceRoot,
      explicit: override !== undefined,
      canonicalName: override?.canonicalName ?? sourceRoot,
    })
    const seed = seeds.get(familyId) ?? {
      id: familyId,
      canonicalName: override?.canonicalName ?? sourceRoot,
      aliases: override ? [...override.aliases] : [],
      ecoCodes: [],
      taxonomyLineIds: [],
      sourceRoots: [],
    }
    if (override) seed.aliases.push(...override.aliases)
    seed.ecoCodes.push(row.eco)
    seed.taxonomyLineIds.push(row.sourceLineId)
    seed.sourceRoots.push(sourceRoot)
    seeds.set(familyId, seed)
  }

  return [...seeds.values()]
    .map((seed) => ({
      ...seed,
      aliases: [...new Set(seed.aliases)].sort((left, right) => left.localeCompare(right, 'en')),
      ecoCodes: [...new Set(seed.ecoCodes)].sort((left, right) => left.localeCompare(right, 'en')),
      taxonomyLineIds: [...new Set(seed.taxonomyLineIds)].sort((left, right) => left.localeCompare(right, 'en')),
      sourceRoots: [...new Set(seed.sourceRoots)].sort((left, right) => left.localeCompare(right, 'en')),
    }))
    .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName, 'en'))
}

/**
 * Deterministically materializes the runtime catalog from exact taxonomy rows.
 * Name splitting is confined to this build-time function; the returned catalog
 * stores canonical family ownership and is the only runtime source of truth.
 */
export function buildOpeningFamilyCatalog(options: {
  releaseId: string
  generatedAt: string
  rows: readonly unknown[]
  manifestReferences: readonly FamilyManifestCatalogReference[]
  packSummaries?: readonly FamilyPackCatalogSummary[]
  overrides?: readonly unknown[]
}): OpeningFamilyCatalogV1 {
  const releaseId = FamilyReleaseIdSchema.parse(options.releaseId)
  const generatedAt = z.string().datetime({ offset: true }).parse(options.generatedAt)
  const seeds = deriveOpeningFamilySeeds(options.rows, options.overrides)
  const manifestReferences = z.array(z.object({
    familyId: FamilyIdSchema,
    manifestRef: ContentAddressedRefV1Schema,
  }).strict()).parse(options.manifestReferences)
  const packSummaries = z.array(z.object({
    familyId: FamilyIdSchema,
    packId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}$/u),
    side: z.enum(['white', 'black']),
    cardCount: z.number().int().nonnegative().max(100_000),
  }).strict()).parse(options.packSummaries ?? [])

  if (new Set(manifestReferences.map(({ familyId }) => familyId)).size !== manifestReferences.length) {
    throw new Error('Every family must have exactly one manifest reference')
  }
  if (new Set(manifestReferences.map(({ manifestRef }) => manifestRef.id)).size !== manifestReferences.length) {
    throw new Error('Family manifest content references must be unique')
  }
  if (new Set(packSummaries.map(({ packId }) => packId)).size !== packSummaries.length) {
    throw new Error('Family catalog pack IDs must be globally unique')
  }
  if (
    manifestReferences.some(({ manifestRef }) => manifestRef.releaseId !== releaseId)
  ) throw new Error('Family manifest references must use the catalog release ID')

  const manifestRefByFamily = new Map(
    manifestReferences.map(({ familyId, manifestRef }) => [familyId, manifestRef]),
  )
  const seedIds = new Set(seeds.map(({ id }) => id))
  if (manifestReferences.some(({ familyId }) => !seedIds.has(familyId))) {
    throw new Error('A manifest reference names a family absent from taxonomy')
  }
  if (packSummaries.some(({ familyId }) => !seedIds.has(familyId))) {
    throw new Error('A pack summary names a family absent from taxonomy')
  }

  const families = seeds.map((seed) => {
    const manifestRef = manifestRefByFamily.get(seed.id)
    if (!manifestRef) throw new Error(`Family ${seed.id} has no manifest reference`)
    const packs = packSummaries.filter(({ familyId }) => familyId === seed.id)
    return {
      schemaVersion: 1 as const,
      id: seed.id,
      canonicalName: seed.canonicalName,
      aliases: seed.aliases,
      ecoCodes: seed.ecoCodes,
      taxonomyLineCount: seed.taxonomyLineIds.length,
      packCount: packs.length,
      cardCount: packs.reduce((total, pack) => total + pack.cardCount, 0),
      availableSides: [...new Set(packs.map(({ side }) => side))].sort() as Array<'white' | 'black'>,
      manifestRef,
    }
  })
  return OpeningFamilyCatalogV1Schema.parse({
    schemaVersion: 1,
    releaseId,
    generatedAt,
    taxonomyLineCount: seeds.reduce((total, seed) => total + seed.taxonomyLineIds.length, 0),
    familyCount: families.length,
    families,
  })
}

export function primaryFamilyOwnership(
  manifests: readonly OpeningFamilyManifestV1[],
): ReadonlyMap<string, string> {
  const ownership = new Map<string, string>()
  for (const manifest of manifests) {
    for (const taxonomyLineId of manifest.taxonomyLineIds) {
      const existing = ownership.get(taxonomyLineId)
      if (existing !== undefined) {
        throw new Error(`Taxonomy line ${taxonomyLineId} has multiple primary families: ${existing}, ${manifest.id}`)
      }
      ownership.set(taxonomyLineId, manifest.id)
    }
  }
  return ownership
}

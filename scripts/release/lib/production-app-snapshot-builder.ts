import { z } from 'zod'
import {
  ContentAddressedRefV1Schema,
  OpeningFamilyCatalogV1Schema,
  OpeningFamilyManifestV1Schema,
  TacticalPuzzleShardPayloadV1Schema,
  type ContentAddressedRefV1,
} from '../../../src/domain/opening-family.ts'
import {
  ProductionWireAppManifestV3Schema,
  type ProductionWireAppManifestV3,
} from '../../../src/data/production-wire.ts'
import { WireAppManifestSchema } from '../../../src/data/wire.ts'
import { PuzzlePromotionReceiptV1Schema } from '../../data/puzzle-v3-contracts.ts'
import {
  deriveTacticalPuzzlePromotionBinding,
  validatePuzzlePromotionProofInventory,
} from '../../data/puzzle-v3-promotion.ts'
import {
  FamilyPromotionAuditIndexV1Schema,
  auditFamilyPromotion,
} from './family-promotion-audit.ts'
import {
  ImmutableJsonReceiptV1Schema,
  readImmutableJsonReceipt,
  safeOutputPath,
  safePathIdentity,
  writeImmutableJsonCandidate,
  type ImmutableJsonReceiptV1,
} from './immutable-json-receipt.ts'

export const ProductionAppSnapshotBuildInputV1Schema = z.object({
  schemaVersion: z.literal(1),
  familyPromotionIndex: ImmutableJsonReceiptV1Schema,
  browseManifest: ImmutableJsonReceiptV1Schema,
}).strict()

function sameReference(left: ContentAddressedRefV1, right: ContentAddressedRefV1): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.id === right.id
    && left.releaseId === right.releaseId
    && left.path === right.path
    && left.sha256 === right.sha256
    && left.compressedBytes === right.compressedBytes
    && left.uncompressedBytes === right.uncompressedBytes
    && left.contentType === right.contentType
    && left.contentEncoding === right.contentEncoding
}

function referenceMatchesReceipt(reference: ContentAddressedRefV1, receipt: ImmutableJsonReceiptV1): boolean {
  return receipt.encoding === 'gzip'
    && reference.path === receipt.path
    && reference.sha256 === receipt.sha256
    && reference.compressedBytes === receipt.bytes
    && reference.uncompressedBytes === receipt.uncompressedBytes
}

function referenceFromReceipt(
  releaseId: string,
  receipt: ImmutableJsonReceiptV1,
): ContentAddressedRefV1 {
  if (receipt.encoding !== 'gzip') throw new Error('Runtime family resources must use gzip encoding')
  return ContentAddressedRefV1Schema.parse({
    schemaVersion: 1,
    id: `blob_${receipt.sha256.slice(0, 16)}`,
    releaseId,
    path: receipt.path,
    sha256: receipt.sha256,
    compressedBytes: receipt.bytes,
    uncompressedBytes: receipt.uncompressedBytes,
    contentType: 'application/json',
    contentEncoding: 'gzip',
  })
}

function addReference(
  resources: Map<string, ContentAddressedRefV1>,
  reference: ContentAddressedRefV1,
): void {
  const prior = resources.get(reference.id)
  if (prior && !sameReference(prior, reference)) {
    throw new Error(`Content ID ${reference.id} has conflicting runtime references`)
  }
  if ([...resources.values()].some((candidate) =>
    candidate.id !== reference.id && candidate.path === reference.path)) {
    throw new Error(`Runtime resource path ${reference.path} has conflicting content IDs`)
  }
  resources.set(reference.id, reference)
}

/**
 * Build the strict app-wire-v3 root only from an already passing immutable
 * family promotion index and the complete checksum-bound v2 browse snapshot.
 * This does not copy, amend, or invent any graph or evidence resource.
 */
export async function buildProductionAppSnapshotManifest(options: {
  root: string
  outputPath: string
  input: unknown
  now?: () => Date
}): Promise<{
  manifest: ProductionWireAppManifestV3
  outputPath: string
  bytes: number
  sha256: string
}> {
  const input = ProductionAppSnapshotBuildInputV1Schema.parse(options.input)
  safeOutputPath(options.root, options.outputPath)
  const outputIdentity = safePathIdentity(options.root, options.outputPath)
  if ([input.familyPromotionIndex.path, input.browseManifest.path].some((path) =>
    safePathIdentity(options.root, path) === outputIdentity)) {
    throw new Error('Production app manifest cannot replace one of its immutable inputs')
  }

  const indexRead = await readImmutableJsonReceipt({
    root: options.root,
    receipt: input.familyPromotionIndex,
    maximumStoredBytes: 1 * 1024 * 1024,
    maximumDecodedBytes: 1 * 1024 * 1024,
  })
  const index = FamilyPromotionAuditIndexV1Schema.parse(indexRead.value)
  const audit = await auditFamilyPromotion({
    root: options.root,
    indexPath: input.familyPromotionIndex.path,
  })
  if (audit.status !== 'pass') {
    throw new Error(`Family promotion is blocked by ${audit.findings.length} finding(s)`)
  }
  // The path-based audit must have inspected the exact immutable index bytes
  // parsed above. A replacement before or during that audit fails this second
  // receipt read instead of letting two different documents be projected.
  await readImmutableJsonReceipt({
    root: options.root,
    receipt: input.familyPromotionIndex,
    maximumStoredBytes: 1 * 1024 * 1024,
    maximumDecodedBytes: 1 * 1024 * 1024,
  })

  const browseRead = await readImmutableJsonReceipt({
    root: options.root,
    receipt: input.browseManifest,
    maximumStoredBytes: 16 * 1024 * 1024,
    maximumDecodedBytes: 16 * 1024 * 1024,
  })
  const browse = WireAppManifestSchema.parse(browseRead.value)

  const puzzlePromotionReceiptRef = index.promotionReceipts.puzzles
  if (!puzzlePromotionReceiptRef) {
    throw new Error('Passing family promotion index omitted its tactical puzzle receipt')
  }
  const puzzlePromotionReceipt = PuzzlePromotionReceiptV1Schema.parse((await readImmutableJsonReceipt({
    root: options.root,
    receipt: puzzlePromotionReceiptRef,
  })).value)
  const puzzleProofInventory = validatePuzzlePromotionProofInventory((await readImmutableJsonReceipt({
    root: options.root,
    receipt: index.puzzleProofInventory,
  })).value)
  const promotedPuzzleShards = await Promise.all(index.puzzleShards.map(async ({ shard }) => ({
    sha256: shard.sha256,
    shard: TacticalPuzzleShardPayloadV1Schema.parse((await readImmutableJsonReceipt({
      root: options.root,
      receipt: shard,
    })).value),
  })))
  const puzzlePromotion = deriveTacticalPuzzlePromotionBinding({
    familyPromotionIndexSha256: input.familyPromotionIndex.sha256,
    promotionReceiptSha256: puzzlePromotionReceiptRef.sha256,
    proofInventorySha256: index.puzzleProofInventory.sha256,
    receipt: puzzlePromotionReceipt,
    inventory: puzzleProofInventory,
    promotedShards: promotedPuzzleShards,
  })

  const catalogRead = await readImmutableJsonReceipt({ root: options.root, receipt: index.catalog })
  const catalog = OpeningFamilyCatalogV1Schema.parse(catalogRead.value)
  if (catalog.releaseId !== index.releaseId || catalog.familyCount !== index.families.length) {
    throw new Error('Family catalog does not match the promoted release index')
  }

  const resources = new Map<string, ContentAddressedRefV1>()
  const familyCatalogRef = referenceFromReceipt(index.releaseId, index.catalog)
  addReference(resources, familyCatalogRef)
  const indexedFamilies = new Map(index.families.map((entry) => [entry.familyId, entry]))
  const indexedPacks = new Map(index.packs.map((entry) => [entry.packId, entry]))
  for (const catalogEntry of catalog.families) {
    const indexedFamily = indexedFamilies.get(catalogEntry.id)
    if (!indexedFamily || !referenceMatchesReceipt(catalogEntry.manifestRef, indexedFamily.manifest)) {
      throw new Error(`Family ${catalogEntry.id} manifest receipt differs from the promoted catalog`)
    }
    addReference(resources, catalogEntry.manifestRef)
    const manifestRead = await readImmutableJsonReceipt({ root: options.root, receipt: indexedFamily.manifest })
    const manifest = OpeningFamilyManifestV1Schema.parse(manifestRead.value)
    if (manifest.releaseId !== index.releaseId || manifest.id !== catalogEntry.id) {
      throw new Error(`Family ${catalogEntry.id} manifest belongs to another release or family`)
    }
    if (!referenceMatchesReceipt(manifest.provenanceRef, indexedFamily.provenance)) {
      throw new Error(`Family ${catalogEntry.id} provenance receipt differs from its manifest`)
    }
    addReference(resources, manifest.provenanceRef)
    for (const packRef of manifest.packRefs) {
      const indexedPack = indexedPacks.get(packRef.packId)
      if (
        !indexedPack
        || indexedPack.familyId !== manifest.id
        || !referenceMatchesReceipt(packRef.graphShardRef, indexedPack.graph)
      ) {
        throw new Error(`Pack ${packRef.packId} graph receipt differs from its family manifest`)
      }
      addReference(resources, packRef.graphShardRef)
    }
    for (const puzzleRef of manifest.puzzleShardRefs) addReference(resources, puzzleRef)
  }
  if (resources.size < 1) throw new Error('Production app has no promoted family resources')

  const orderedResources = Object.fromEntries(
    [...resources.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')),
  )
  const familyCompressedBytes = [...resources.values()].reduce(
    (sum, reference) => sum + reference.compressedBytes,
    0,
  )
  const familyBase64Bytes = [...resources.values()].reduce(
    (sum, reference) => sum + Math.ceil(reference.compressedBytes / 3) * 4,
    0,
  )
  const manifest = ProductionWireAppManifestV3Schema.parse({
    v: 3,
    schema: 'linerecall-app-wire-v3',
    releaseId: index.releaseId,
    g: (options.now ?? (() => new Date()))().toISOString(),
    selectionPolicy: {
      practiceBranches: 'all-eligible-audited',
      maximumPracticeBranches: null,
      terminal: 'evidence-defined-through-ply-100',
    },
    familyPromotionIndexSha256: input.familyPromotionIndex.sha256,
    puzzlePromotion,
    browseManifestSha256: input.browseManifest.sha256,
    browse,
    familyCatalogRef,
    familyResources: orderedResources,
    totals: {
      families: index.families.length,
      packs: index.packs.length,
      graphs: index.packs.length,
      puzzleShards: index.puzzleShards.length,
      familyResources: resources.size,
      compressedBytes: browse.totals.compressedBytes + familyCompressedBytes,
      estimatedBase64Bytes: browse.totals.estimatedBase64Bytes + familyBase64Bytes,
    },
  })
  const candidate = await writeImmutableJsonCandidate({
    root: options.root,
    outputPath: options.outputPath,
    value: manifest,
  })
  try {
    await candidate.promote()
  } catch (error) {
    await candidate.discard()
    throw error
  }
  return {
    manifest,
    outputPath: options.outputPath,
    bytes: candidate.bytes,
    sha256: candidate.sha256,
  }
}

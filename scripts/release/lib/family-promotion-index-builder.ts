import { z } from 'zod'
import { FamilyIdSchema, FamilyPackIdSchema, FamilyReleaseIdSchema } from '../../../src/domain/opening-family.ts'
import {
  FamilyPromotionAuditIndexV1Schema,
  auditFamilyPromotion,
  type FamilyPromotionAuditReportV1,
} from './family-promotion-audit.ts'
import {
  ImmutableJsonReceiptV1Schema,
  safePathIdentity,
  safeOutputPath,
  writeImmutableJsonCandidate,
} from './immutable-json-receipt.ts'

const ReceiptSchema = ImmutableJsonReceiptV1Schema

export const FamilyPromotionIndexBuildInputV1Schema = z.object({
  schemaVersion: z.literal(1),
  releaseId: FamilyReleaseIdSchema,
  selectionPolicy: z.object({
    practiceBranches: z.literal('all-eligible-audited'),
    maximumPracticeBranches: z.null(),
  }).strict(),
  taxonomySourceManifest: ReceiptSchema,
  taxonomyInventory: ReceiptSchema,
  catalog: ReceiptSchema,
  editorialLedger: ReceiptSchema,
  campaignSourceBinding: ReceiptSchema,
  familyGraphBuild: ReceiptSchema,
  engineProofInventory: ReceiptSchema,
  scidCrosscheckReport: ReceiptSchema,
  families: z.array(z.object({
    familyId: FamilyIdSchema,
    manifest: ReceiptSchema,
    provenance: ReceiptSchema,
  }).strict()).min(1).max(3_790),
  packs: z.array(z.object({
    familyId: FamilyIdSchema,
    packId: FamilyPackIdSchema,
    graph: ReceiptSchema,
    eligibleInventory: ReceiptSchema,
  }).strict()).min(1).max(100_000),
  puzzleShards: z.array(z.object({
    familyIds: z.array(FamilyIdSchema).min(1).max(256),
    shard: ReceiptSchema,
  }).strict()).min(1).max(1_000),
  puzzleProofInventory: ReceiptSchema,
  promotionReceipts: z.object({
    broadcast: ReceiptSchema,
    q2: ReceiptSchema,
    evidence: ReceiptSchema,
    engine: ReceiptSchema,
    scid: ReceiptSchema,
    puzzles: ReceiptSchema,
  }).strict(),
}).strict()

export type FamilyPromotionIndexBuildInputV1 = z.infer<typeof FamilyPromotionIndexBuildInputV1Schema>

export class FamilyPromotionIndexBuildError extends Error {
  readonly report: FamilyPromotionAuditReportV1 | null

  constructor(message: string, report: FamilyPromotionAuditReportV1 | null = null) {
    super(message)
    this.name = 'FamilyPromotionIndexBuildError'
    this.report = report
  }
}

function allResourcePaths(input: FamilyPromotionIndexBuildInputV1): string[] {
  return [
    input.taxonomySourceManifest.path,
    input.taxonomyInventory.path,
    input.catalog.path,
    input.editorialLedger.path,
    input.campaignSourceBinding.path,
    input.familyGraphBuild.path,
    input.engineProofInventory.path,
    input.scidCrosscheckReport.path,
    ...input.families.flatMap(({ manifest, provenance }) => [manifest.path, provenance.path]),
    ...input.packs.flatMap(({ graph, eligibleInventory }) => [graph.path, eligibleInventory.path]),
    ...input.puzzleShards.map(({ shard }) => shard.path),
    input.puzzleProofInventory.path,
    ...Object.values(input.promotionReceipts).map(({ path }) => path),
  ]
}

/**
 * Promote only an index whose exact referenced bytes pass the existing family
 * promotion audit. The candidate is removed on every blocked result and no
 * prior immutable index is overwritten.
 */
export async function buildFamilyPromotionIndex(options: {
  root: string
  outputPath: string
  input: unknown
  now?: () => Date
}): Promise<{
  index: z.infer<typeof FamilyPromotionAuditIndexV1Schema>
  outputPath: string
  bytes: number
  sha256: string
  audit: FamilyPromotionAuditReportV1
}> {
  const input = FamilyPromotionIndexBuildInputV1Schema.parse(options.input)
  safeOutputPath(options.root, options.outputPath)
  const outputIdentity = safePathIdentity(options.root, options.outputPath)
  if (allResourcePaths(input).some((path) => safePathIdentity(options.root, path) === outputIdentity)) {
    throw new FamilyPromotionIndexBuildError('Family promotion index cannot replace one of its immutable inputs')
  }
  const index = FamilyPromotionAuditIndexV1Schema.parse({
    schemaVersion: 1,
    releaseId: input.releaseId,
    selectionPolicy: input.selectionPolicy,
    taxonomySourceManifest: input.taxonomySourceManifest,
    taxonomyInventory: input.taxonomyInventory,
    catalog: input.catalog,
    editorialLedger: input.editorialLedger,
    campaignSourceBinding: input.campaignSourceBinding,
    familyGraphBuild: input.familyGraphBuild,
    engineProofInventory: input.engineProofInventory,
    scidCrosscheckReport: input.scidCrosscheckReport,
    families: input.families,
    packs: input.packs,
    puzzleShards: input.puzzleShards,
    puzzleProofInventory: input.puzzleProofInventory,
    promotionReceipts: input.promotionReceipts,
  })
  const candidate = await writeImmutableJsonCandidate({
    root: options.root,
    outputPath: options.outputPath,
    value: index,
  })
  let report: FamilyPromotionAuditReportV1 | null = null
  try {
    report = await auditFamilyPromotion({
      root: options.root,
      indexPath: candidate.candidateRelativePath,
      ...(options.now ? { now: options.now } : {}),
    })
    if (report.status !== 'pass') {
      throw new FamilyPromotionIndexBuildError(
        `Family promotion index is blocked by ${report.findings.length} finding(s)`,
        report,
      )
    }
    await candidate.promote()
    return {
      index,
      outputPath: options.outputPath,
      bytes: candidate.bytes,
      sha256: candidate.sha256,
      audit: report,
    }
  } catch (error) {
    await candidate.discard()
    if (error instanceof FamilyPromotionIndexBuildError) throw error
    throw new FamilyPromotionIndexBuildError(
      error instanceof Error ? error.message : String(error),
      report,
    )
  }
}

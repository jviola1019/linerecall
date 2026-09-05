import { createHash } from 'node:crypto'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { z } from 'zod'
import {
  FamilyIdSchema,
  FamilyPackIdSchema,
  FamilyReleaseIdSchema,
} from '../../src/domain/opening-family.ts'
import { EcoCodeSchema, UciMoveSchema } from '../../src/domain/opening-data.ts'
import {
  ImmutableJsonReceiptV1Schema,
  readImmutableJsonReceipt,
  resolveReceiptRoot,
  resolveSafeReceiptPath,
  writeImmutableJsonCandidate,
  type ImmutableJsonReceiptV1,
} from '../release/lib/immutable-json-receipt.ts'
import { readHandleBoundRegularFile } from '../lib/handle-bound-file.ts'
import {
  ScidManifestSchema,
  assertScidProvisionMatchesManifest,
} from '../verification/lib/manifest.ts'
import {
  buildScidPositionIndex,
  crosscheckLine,
  parseScidEco,
  type ScidEcoEntry,
} from '../verification/lib/scid-crosscheck.ts'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const PathIdSchema = z.string().regex(/^path_[a-f0-9]{20}$/u)
const MAX_CONTROL_BYTES = 32 * 1024 * 1024

export const FamilyScidCandidateLineV1Schema = z.object({
  lineId: z.string().regex(/^scidline_[a-f0-9]{20}$/u),
  familyId: FamilyIdSchema,
  packId: FamilyPackIdSchema,
  pathId: PathIdSchema,
  expectedBaseEco: EcoCodeSchema,
  canonicalName: z.string().min(1).max(300),
  movesUci: z.array(UciMoveSchema).min(1).max(100),
  drillEligible: z.boolean(),
  engineQuarantined: z.boolean(),
}).strict()

export const FamilyScidCandidateInventoryV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-family-scid-candidate-inventory'),
  releaseId: FamilyReleaseIdSchema,
  familyGraphBuildSha256: Sha256Schema,
  lines: z.array(FamilyScidCandidateLineV1Schema).min(1).max(100_000),
}).strict().superRefine((inventory, context) => {
  for (const key of [
    inventory.lines.map(({ lineId }) => lineId),
    inventory.lines.map(({ packId, pathId }) => `${packId}\0${pathId}`),
  ]) {
    if (new Set(key).size !== key.length) {
      context.addIssue({ code: 'custom', path: ['lines'], message: 'Scid candidate lines and pack paths must be unique' })
    }
  }
  if (inventory.lines.some(({ engineQuarantined, drillEligible }) => engineQuarantined && drillEligible)) {
    context.addIssue({ code: 'custom', path: ['lines'], message: 'An engine-quarantined line cannot remain drill eligible' })
  }
})

export const FamilyScidCampaignRequestV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-scid-family-crosscheck-request'),
  releaseId: FamilyReleaseIdSchema,
  candidateInventory: ImmutableJsonReceiptV1Schema,
  sampling: z.object({
    maximum: z.literal(250),
    seed: z.string().min(1).max(128),
    method: z.literal('sha256-round-robin-eco-volumes-a-e'),
  }).strict(),
}).strict()

const ScidStatusSchema = z.enum([
  'match', 'naming_difference', 'missing_oracle_entry', 'base_eco_mismatch', 'ambiguous_oracle_base',
])

export const FamilyScidCampaignReportV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-scid-family-crosscheck-report'),
  releaseId: FamilyReleaseIdSchema,
  completedAt: z.string().datetime({ offset: true }),
  candidateInventory: ImmutableJsonReceiptV1Schema,
  familyGraphBuildSha256: Sha256Schema,
  oracle: z.object({
    repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    sourceManifestSha256: Sha256Schema,
    provisionReceiptSha256: Sha256Schema,
    sha256: Sha256Schema,
    license: z.literal('GPL-2.0-only'),
    parsedEntryCount: z.number().int().positive(),
    rejectedEntryCount: z.literal(0),
    oracleContentShipped: z.literal(false),
  }).strict(),
  sampling: z.object({
    method: z.literal('sha256-round-robin-eco-volumes-a-e'),
    seed: z.string().min(1).max(128),
    maximum: z.literal(250),
    eligibleLineCount: z.number().int().positive().max(100_000),
    requiredSampleSize: z.number().int().positive().max(250),
    selected: z.number().int().positive().max(250),
    complete: z.literal(true),
    byVolume: z.object({ A: z.number().int().nonnegative(), B: z.number().int().nonnegative(), C: z.number().int().nonnegative(), D: z.number().int().nonnegative(), E: z.number().int().nonnegative() }).strict(),
  }).strict(),
  summary: z.object({
    match: z.number().int().nonnegative(),
    namingDifference: z.number().int().nonnegative(),
    missingOracleEntry: z.number().int().nonnegative(),
    baseEcoMismatch: z.number().int().nonnegative(),
    ambiguousOracleBase: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
  }).strict(),
  results: z.array(z.object({
    lineId: z.string().regex(/^scidline_[a-f0-9]{20}$/u),
    familyId: FamilyIdSchema,
    packId: FamilyPackIdSchema,
    pathId: PathIdSchema,
    expectedBaseEco: EcoCodeSchema,
    status: ScidStatusSchema,
    quarantined: z.boolean(),
    deepestMatchedPly: z.number().int().positive().max(100).nullable(),
  }).strict()).min(1).max(250),
}).strict().superRefine((report, context) => {
  if (report.sampling.requiredSampleSize !== Math.min(report.sampling.maximum, report.sampling.eligibleLineCount)) {
    context.addIssue({ code: 'custom', path: ['sampling', 'requiredSampleSize'], message: 'Required Scid sample must equal min(250, eligible lines)' })
  }
  if (report.sampling.selected !== report.sampling.requiredSampleSize || report.results.length !== report.sampling.selected) {
    context.addIssue({ code: 'custom', path: ['sampling', 'selected'], message: 'Scid stratified sample is incomplete' })
  }
  const byVolume = Object.values(report.sampling.byVolume).reduce((sum, value) => sum + value, 0)
  if (byVolume !== report.sampling.selected) {
    context.addIssue({ code: 'custom', path: ['sampling', 'byVolume'], message: 'Scid volume counts must reconcile to selected lines' })
  }
  if (new Set(report.results.map(({ lineId }) => lineId)).size !== report.results.length) {
    context.addIssue({ code: 'custom', path: ['results'], message: 'Scid results must be unique' })
  }
  const derived = {
    match: report.results.filter(({ status }) => status === 'match').length,
    namingDifference: report.results.filter(({ status }) => status === 'naming_difference').length,
    missingOracleEntry: report.results.filter(({ status }) => status === 'missing_oracle_entry').length,
    baseEcoMismatch: report.results.filter(({ status }) => status === 'base_eco_mismatch').length,
    ambiguousOracleBase: report.results.filter(({ status }) => status === 'ambiguous_oracle_base').length,
    quarantined: report.results.filter(({ quarantined }) => quarantined).length,
  }
  for (const key of Object.keys(derived) as Array<keyof typeof derived>) {
    if (derived[key] !== report.summary[key]) context.addIssue({ code: 'custom', path: ['summary', key], message: 'Scid summary must be derived from individual results' })
  }
  for (const [index, result] of report.results.entries()) {
    const expectedQuarantine = result.status === 'base_eco_mismatch' || result.status === 'ambiguous_oracle_base'
    if (result.quarantined !== expectedQuarantine) {
      context.addIssue({ code: 'custom', path: ['results', index, 'quarantined'], message: 'Only conflicting base-ECO results are quarantined' })
    }
  }
})

export const FamilyScidPromotionReceiptV1Schema = z.object({
  schemaVersion: z.literal(1),
  releaseId: FamilyReleaseIdSchema,
  status: z.literal('pass'),
  completedAt: z.string().datetime({ offset: true }),
  gate: z.literal('scid-family-crosscheck'),
  crosscheckReport: ImmutableJsonReceiptV1Schema,
  familyGraphBuildSha256: Sha256Schema,
  stratifiedSampleComplete: z.literal(true),
  eligibleLines: z.number().int().positive().max(100_000),
  requiredSampleSize: z.number().int().positive().max(250),
  sampledLines: z.number().int().positive().max(250),
  conflictingBaseEcoResults: z.number().int().nonnegative().max(250),
  conflictingBaseEcoQuarantined: z.number().int().nonnegative().max(250),
  conflictingBaseEcoInDrills: z.literal(0),
  oracleContentShipped: z.literal(false),
}).strict().superRefine((receipt, context) => {
  if (receipt.sampledLines !== receipt.requiredSampleSize) {
    context.addIssue({ code: 'custom', path: ['sampledLines'], message: 'Scid promotion requires the complete stratified sample' })
  }
  if (receipt.conflictingBaseEcoResults !== receipt.conflictingBaseEcoQuarantined) {
    context.addIssue({ code: 'custom', path: ['conflictingBaseEcoQuarantined'], message: 'Every conflicting base ECO must be quarantined before promotion' })
  }
})

export type FamilyScidCandidateInventoryV1 = z.infer<typeof FamilyScidCandidateInventoryV1Schema>
export type FamilyScidCampaignReportV1 = z.infer<typeof FamilyScidCampaignReportV1Schema>
export type FamilyScidPromotionReceiptV1 = z.infer<typeof FamilyScidPromotionReceiptV1Schema>

function stableRank(seed: string, lineId: string): string {
  return createHash('sha256').update(`${seed}\0${lineId}`).digest('hex')
}

export function selectFamilyScidSample(
  inventory: FamilyScidCandidateInventoryV1,
  maximum: 250,
  seed: string,
): FamilyScidCandidateInventoryV1['lines'] {
  const eligible = inventory.lines.filter(({ drillEligible, engineQuarantined }) => drillEligible && !engineQuarantined)
  const groups = new Map<string, typeof eligible>(['A', 'B', 'C', 'D', 'E'].map((volume) => [volume, []]))
  for (const line of eligible) groups.get(line.expectedBaseEco[0]!)!.push(line)
  for (const group of groups.values()) group.sort((left, right) => stableRank(seed, left.lineId).localeCompare(stableRank(seed, right.lineId), 'en'))
  const target = Math.min(maximum, eligible.length)
  const selected: typeof eligible = []
  for (let offset = 0; selected.length < target; offset += 1) {
    let added = false
    for (const volume of ['A', 'B', 'C', 'D', 'E']) {
      const line = groups.get(volume)?.[offset]
      if (line) {
        selected.push(line)
        added = true
        if (selected.length === target) break
      }
    }
    if (!added) throw new Error('Scid stratified sampler could not complete the required sample')
  }
  return selected
}

export function assertFamilyScidSampleMatchesInventory(options: {
  report: FamilyScidCampaignReportV1
  inventory: FamilyScidCandidateInventoryV1
}): void {
  const report = FamilyScidCampaignReportV1Schema.parse(options.report)
  const inventory = FamilyScidCandidateInventoryV1Schema.parse(options.inventory)
  if (
    report.releaseId !== inventory.releaseId
    || report.familyGraphBuildSha256 !== inventory.familyGraphBuildSha256
  ) throw new Error('Scid report and candidate inventory belong to different graph releases')
  const eligibleLineCount = inventory.lines.filter(({ drillEligible, engineQuarantined }) =>
    drillEligible && !engineQuarantined).length
  if (report.sampling.eligibleLineCount !== eligibleLineCount) {
    throw new Error('Scid report eligible-line count differs from its candidate inventory')
  }
  const expected = selectFamilyScidSample(inventory, report.sampling.maximum, report.sampling.seed)
  if (
    expected.length !== report.results.length
    || expected.some((line, index) => line.lineId !== report.results[index]?.lineId)
  ) throw new Error('Scid report membership or order differs from the deterministic stratified sample')
  for (const volume of ['A', 'B', 'C', 'D', 'E'] as const) {
    const expectedCount = expected.filter(({ expectedBaseEco }) => expectedBaseEco.startsWith(volume)).length
    if (report.sampling.byVolume[volume] !== expectedCount) {
      throw new Error(`Scid report ${volume}-volume count differs from the deterministic sample`)
    }
  }
}

function moveInput(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

function assertLegalLine(line: FamilyScidCandidateInventoryV1['lines'][number]): void {
  const chess = new Chess()
  for (const [index, uci] of line.movesUci.entries()) {
    try {
      chess.move(moveInput(uci))
    } catch {
      throw new Error(`Scid candidate ${line.lineId} contains illegal move ${uci} at ply ${index + 1}`)
    }
  }
}

export function buildFamilyScidCampaignReport(options: {
  releaseId: string
  inventory: FamilyScidCandidateInventoryV1
  inventoryReceipt: ImmutableJsonReceiptV1
  oracleEntries: ScidEcoEntry[]
  oracle: {
    repositoryCommit: string
    sourceManifestSha256: string
    provisionReceiptSha256: string
    sha256: string
  }
  seed: string
  completedAt: string
}): FamilyScidCampaignReportV1 {
  if (options.inventory.releaseId !== options.releaseId) throw new Error('Scid candidate inventory belongs to another release')
  const selected = selectFamilyScidSample(options.inventory, 250, options.seed)
  if (selected.length === 0) throw new Error('Scid campaign has no eligible drill lines')
  const index = buildScidPositionIndex(options.oracleEntries)
  const results = selected.map((line) => {
    assertLegalLine(line)
    const result = crosscheckLine({
      id: line.lineId,
      eco: line.expectedBaseEco,
      name: line.canonicalName,
      drillEligible: true,
      quarantined: false,
      movesUci: line.movesUci,
    }, index)
    return {
      lineId: line.lineId,
      familyId: line.familyId,
      packId: line.packId,
      pathId: line.pathId,
      expectedBaseEco: line.expectedBaseEco,
      status: result.status,
      quarantined: result.quarantined,
      deepestMatchedPly: result.deepestMatchedPly,
    }
  })
  const eligibleLineCount = options.inventory.lines.filter(({ drillEligible, engineQuarantined }) => drillEligible && !engineQuarantined).length
  return FamilyScidCampaignReportV1Schema.parse({
    schemaVersion: 1,
    kind: 'linerecall-scid-family-crosscheck-report',
    releaseId: options.releaseId,
    completedAt: options.completedAt,
    candidateInventory: options.inventoryReceipt,
    familyGraphBuildSha256: options.inventory.familyGraphBuildSha256,
    oracle: {
      ...options.oracle,
      license: 'GPL-2.0-only',
      parsedEntryCount: options.oracleEntries.length,
      rejectedEntryCount: 0,
      oracleContentShipped: false,
    },
    sampling: {
      method: 'sha256-round-robin-eco-volumes-a-e',
      seed: options.seed,
      maximum: 250,
      eligibleLineCount,
      requiredSampleSize: Math.min(250, eligibleLineCount),
      selected: selected.length,
      complete: true,
      byVolume: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((volume) => [
        volume,
        selected.filter(({ expectedBaseEco }) => expectedBaseEco.startsWith(volume)).length,
      ])),
    },
    summary: {
      match: results.filter(({ status }) => status === 'match').length,
      namingDifference: results.filter(({ status }) => status === 'naming_difference').length,
      missingOracleEntry: results.filter(({ status }) => status === 'missing_oracle_entry').length,
      baseEcoMismatch: results.filter(({ status }) => status === 'base_eco_mismatch').length,
      ambiguousOracleBase: results.filter(({ status }) => status === 'ambiguous_oracle_base').length,
      quarantined: results.filter(({ quarantined }) => quarantined).length,
    },
    results,
  })
}

export function deriveFamilyScidPromotionReceipt(options: {
  report: FamilyScidCampaignReportV1
  reportReceipt: ImmutableJsonReceiptV1
  promotedDrillPathIds: ReadonlySet<string>
  completedAt: string
}): FamilyScidPromotionReceiptV1 {
  const report = FamilyScidCampaignReportV1Schema.parse(options.report)
  const conflicts = report.results.filter(({ quarantined }) => quarantined)
  const stillInDrills = conflicts.filter(({ pathId }) => options.promotedDrillPathIds.has(pathId))
  if (stillInDrills.length > 0) throw new Error(`Scid base-ECO conflict remains in ${stillInDrills.length} promoted drill path(s)`)
  return FamilyScidPromotionReceiptV1Schema.parse({
    schemaVersion: 1,
    releaseId: report.releaseId,
    status: 'pass',
    completedAt: options.completedAt,
    gate: 'scid-family-crosscheck',
    crosscheckReport: options.reportReceipt,
    familyGraphBuildSha256: report.familyGraphBuildSha256,
    stratifiedSampleComplete: true,
    eligibleLines: report.sampling.eligibleLineCount,
    requiredSampleSize: report.sampling.requiredSampleSize,
    sampledLines: report.sampling.selected,
    conflictingBaseEcoResults: conflicts.length,
    conflictingBaseEcoQuarantined: conflicts.length,
    conflictingBaseEcoInDrills: 0,
    oracleContentShipped: false,
  })
}

async function immutableOutput(root: string, outputPath: string, value: unknown): Promise<ImmutableJsonReceiptV1> {
  const expected = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  const expectedSha256 = createHash('sha256').update(expected).digest('hex')
  const reusable = async (): Promise<ImmutableJsonReceiptV1 | null> => {
    try {
      const rootReal = await resolveReceiptRoot(root)
      const existingPath = await resolveSafeReceiptPath(rootReal, outputPath)
      const bytes = await readHandleBoundRegularFile(existingPath, `Existing immutable Scid output ${outputPath}`, expected.byteLength)
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (bytes.byteLength !== expected.byteLength || actual !== expectedSha256) {
        throw new Error(`Existing immutable Scid output differs: ${outputPath}`)
      }
      return { path: outputPath, sha256: actual, bytes: bytes.byteLength, uncompressedBytes: bytes.byteLength, encoding: 'identity' }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }
  const prior = await reusable()
  if (prior) return prior
  const pending = await writeImmutableJsonCandidate({ root, outputPath, value })
  try {
    await pending.promote()
    return { path: outputPath, sha256: pending.sha256, bytes: pending.bytes, uncompressedBytes: pending.bytes, encoding: 'identity' }
  } catch (error) {
    await pending.discard()
    if (error instanceof Error && error.message.startsWith('Immutable handoff output already exists:')) {
      const raced = await reusable()
      if (raced) return raced
    }
    throw error
  }
}

export async function runFamilyScidCampaign(options: {
  receiptRoot: string
  requestReceipt: ImmutableJsonReceiptV1
  outputPath: string
  scidEcoPath: string
  scidManifestPath: string
  scidProvisionReceiptPath: string
  now?: () => Date
}): Promise<{ report: FamilyScidCampaignReportV1; receipt: ImmutableJsonReceiptV1 }> {
  const requestLoaded = await readImmutableJsonReceipt({ root: options.receiptRoot, receipt: options.requestReceipt, maximumStoredBytes: 2 * 1024 * 1024, maximumDecodedBytes: 2 * 1024 * 1024 })
  const request = FamilyScidCampaignRequestV1Schema.parse(requestLoaded.value)
  const candidateLoaded = await readImmutableJsonReceipt({ root: options.receiptRoot, receipt: request.candidateInventory, maximumStoredBytes: MAX_CONTROL_BYTES, maximumDecodedBytes: MAX_CONTROL_BYTES })
  const inventory = FamilyScidCandidateInventoryV1Schema.parse(candidateLoaded.value)
  if (inventory.releaseId !== request.releaseId) throw new Error('Scid request and candidate inventory releases differ')
  const manifestBytes = await readHandleBoundRegularFile(options.scidManifestPath, 'Scid source manifest', 2 * 1024 * 1024)
  const manifest = ScidManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')) as unknown)
  const provisionBytes = await readHandleBoundRegularFile(options.scidProvisionReceiptPath, 'Scid provision receipt', 2 * 1024 * 1024)
  assertScidProvisionMatchesManifest(manifest, JSON.parse(provisionBytes.toString('utf8')) as unknown)
  const oracleBytes = await readHandleBoundRegularFile(options.scidEcoPath, 'Scid ECO oracle', manifest.size)
  const oracleSha256 = createHash('sha256').update(oracleBytes).digest('hex')
  if (oracleBytes.byteLength !== manifest.size || oracleSha256 !== manifest.sha256) throw new Error('Scid ECO oracle differs from its approved manifest')
  const parsed = parseScidEco(oracleBytes.toString('utf8'))
  if (parsed.failures.length > 0) throw new Error(`Scid parser rejected ${parsed.failures.length} oracle entries`)
  const report = buildFamilyScidCampaignReport({
    releaseId: request.releaseId,
    inventory,
    inventoryReceipt: request.candidateInventory,
    oracleEntries: parsed.entries,
    oracle: {
      repositoryCommit: manifest.repositoryCommit,
      sourceManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      provisionReceiptSha256: createHash('sha256').update(provisionBytes).digest('hex'),
      sha256: oracleSha256,
    },
    seed: request.sampling.seed,
    completedAt: (options.now ?? (() => new Date()))().toISOString(),
  })
  const receipt = await immutableOutput(options.receiptRoot, options.outputPath, report)
  return { report, receipt }
}

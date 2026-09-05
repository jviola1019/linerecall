import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { Chess } from 'chess.js'
import { z } from 'zod'
import {
  PUZZLE_ENGINE_SETTINGS,
  PUZZLE_ENGINE_SETTINGS_SHA256,
  PuzzleEngineProofSchema,
  PuzzleEngineSearchObservationSchema,
  type PuzzleCandidate,
} from './puzzle-contracts.ts'
import {
  PuzzleV3CandidateEnvelopeV1Schema,
  PuzzleV3CandidateManifestV1Schema,
  PuzzleV3EvidenceBindingV1Schema,
  PuzzleV3VerifiedEnvelopeV1Schema,
  PuzzleEngineCampaignV1Schema,
  sha256Json,
  type PuzzleV3EvidenceBindingV1,
  type PuzzleV3VerifiedEnvelopeV1,
} from './puzzle-v3-contracts.ts'
import { TacticalPuzzleShardPayloadV1Schema } from '../../src/domain/opening-family.ts'
import {
  PuzzlePromotionProofInventoryV1Schema,
  tacticalPuzzleFromVerifiedEnvelope,
  type PuzzlePromotionProofInventoryV1,
} from './puzzle-v3-promotion.ts'
import {
  StockfishManifestSchema,
  assertStockfishProvisionMatchesManifest,
} from '../verification/lib/manifest.ts'
import { UciEngine, type UciAnalysis } from '../verification/lib/uci-engine.ts'
import { sha256File } from '../verification/lib/files.ts'
import { readHandleBoundRegularFile } from '../lib/handle-bound-file.ts'
import {
  readImmutableJsonReceipt,
  resolveReceiptRoot,
  resolveSafeReceiptPath,
  writeImmutableJsonCandidate,
  type ImmutableJsonReceiptV1,
} from '../release/lib/immutable-json-receipt.ts'

const MAX_CONTROL_FILE_BYTES = 4 * 1024 * 1024
// This runner deliberately uses the bounded-subset option instead of making
// an unbounded in-memory corpus claim.  The candidate manifest is checked
// against these limits before the candidate path is opened.
export const MAX_PUZZLE_ENGINE_CANDIDATES = 10_000
export const MAX_PUZZLE_ENGINE_CANDIDATE_STORED_BYTES = 64 * 1024 * 1024
export const MAX_PUZZLE_ENGINE_CANDIDATE_DECODED_BYTES = 256 * 1024 * 1024
// Shards roll over at a small fixed page size so one family cannot force a
// promotion consumer to materialize a giant family-owned resource.
export const MAX_PUZZLE_ENGINE_SHARD_PUZZLES = 256
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/u

export interface PuzzleEngineAnalysisAdapter {
  resetForPosition(timeoutMs?: number): Promise<void>
  setMultiPv(value: 1 | 5): void
  analyze(options: { fen: string; nodes: 250_000; searchMoveUci?: string; timeoutMs?: number }): Promise<UciAnalysis>
}

export interface PuzzleEngineCandidateInput {
  receipt?: ImmutableJsonReceiptV1
  value: z.infer<typeof PuzzleV3CandidateEnvelopeV1Schema>
}

/**
 * Decode one already digest-checked candidate shard within the campaign
 * bounds. Keeping this as a separate bounded step makes truncated gzip and
 * duplicate-page failures happen before an engine process is started.
 */
export function parsePuzzleCandidateShard(
  candidateBytes: Uint8Array,
  expectedCount: number,
): PuzzleEngineCandidateInput[] {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > MAX_PUZZLE_ENGINE_CANDIDATES) {
    throw new Error(`Candidate count is outside the ${MAX_PUZZLE_ENGINE_CANDIDATES}-candidate bounded subset limit`)
  }
  if (candidateBytes.byteLength > MAX_PUZZLE_ENGINE_CANDIDATE_STORED_BYTES) {
    throw new Error(`Candidate shard exceeds the ${MAX_PUZZLE_ENGINE_CANDIDATE_STORED_BYTES}-byte stored shard limit`)
  }
  const candidateDecoded = gunzipSync(candidateBytes, { maxOutputLength: MAX_PUZZLE_ENGINE_CANDIDATE_DECODED_BYTES })
  const candidates: PuzzleEngineCandidateInput[] = []
  const seenIds = new Set<string>()
  for (const line of new TextDecoder('utf8', { fatal: true }).decode(candidateDecoded).split('\n')) {
    if (line.length === 0) continue
    const value = PuzzleV3CandidateEnvelopeV1Schema.parse(JSON.parse(line) as unknown)
    if (candidates.length >= expectedCount) throw new Error('Candidate shard contains more records than its manifest')
    if (seenIds.has(value.candidate.puzzleId)) throw new Error(`Duplicate puzzle candidate ${value.candidate.puzzleId}`)
    seenIds.add(value.candidate.puzzleId)
    candidates.push({ value })
  }
  if (candidates.length !== expectedCount) throw new Error('Candidate shard count differs from its manifest')
  return candidates
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function scoreValue(score: { kind: 'centipawn' | 'mate'; value: number }): number {
  if (score.kind === 'centipawn') return score.value
  return score.value > 0 ? 1_000_000 - Math.min(score.value, 999) * 1_000 : -1_000_000 + Math.min(Math.abs(score.value), 999) * 1_000
}

function derive(best: { kind: 'centipawn' | 'mate'; value: number }, candidate: { kind: 'centipawn' | 'mate'; value: number }) {
  const losesByMate = candidate.kind === 'mate' && candidate.value < 0
  const mateConsistent = !losesByMate && (best.kind === 'centipawn'
    ? candidate.kind === 'centipawn' || (candidate.kind === 'mate' && candidate.value > 0)
    : best.value > 0 && candidate.kind === 'mate' && candidate.value > 0)
  const centipawnLoss = best.kind === 'centipawn' && candidate.kind === 'centipawn'
    ? Math.max(0, best.value - candidate.value)
    : best.kind === 'mate' && candidate.kind === 'mate' && best.value > 0 && candidate.value > 0 ? 0 : null
  return { centipawnLoss, mateConsistent, status: mateConsistent && (centipawnLoss === null || centipawnLoss <= 50) ? 'pass' as const : 'fail' as const }
}

function legalPv(epd: string, moves: readonly string[]): void {
  const chess = new Chess(`${epd} 0 1`)
  for (const [index, uci] of moves.entries()) {
    if (!UCI.test(uci)) throw new Error(`Engine PV contains malformed UCI move at ply ${index + 1}`)
    try {
      chess.move({ from: uci.slice(0, 2) as never, to: uci.slice(2, 4) as never, ...(uci.length === 5 ? { promotion: uci[4] as never } : {}) })
    } catch {
      throw new Error(`Engine PV contains illegal move ${uci} at ply ${index + 1}`)
    }
  }
}

function exact(variation: UciAnalysis['variations'][number], epd: string, label: string) {
  if (variation.bound !== 'exact') throw new Error(`${label} did not return an exact bound`)
  if (variation.nodes === null || variation.nodes < PUZZLE_ENGINE_SETTINGS.nodes) {
    throw new Error(`${label} did not record at least ${PUZZLE_ENGINE_SETTINGS.nodes} nodes`)
  }
  legalPv(epd, variation.movesUci)
  return PuzzleEngineSearchObservationSchema.parse({ ...variation, nodes: variation.nodes })
}

function puzzleNodes(candidate: PuzzleCandidate): PuzzleCandidate['learnerNodes'] {
  return candidate.learnerNodes
}

function stableStringCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Analyze one candidate list. The runner never accepts caller-provided result fields. */
export async function analyzePuzzleCandidates(options: {
  candidates: readonly PuzzleEngineCandidateInput[]
  engine: PuzzleEngineAnalysisAdapter
  engineSha256: string
  nnueSha256: readonly string[]
  analyzedAt: string
  releaseId: string
  evidence: PuzzleV3EvidenceBindingV1
  evidenceBindingSha256: string
  repeatRoots?: boolean
}): Promise<PuzzleV3VerifiedEnvelopeV1[]> {
  const parsedTime = new Date(options.analyzedAt)
  if (!Number.isFinite(parsedTime.getTime())) throw new Error('Puzzle engine analysis time must be an ISO timestamp')
  const evidence = PuzzleV3EvidenceBindingV1Schema.parse(options.evidence)
  if (evidence.releaseId !== options.releaseId || sha256Json(evidence) !== options.evidenceBindingSha256) {
    throw new Error('Puzzle engine evidence binding does not match its release or content hash')
  }
  if (
    options.engineSha256 !== evidence.engineCampaign.executableSha256
    || JSON.stringify([...options.nnueSha256].sort()) !== JSON.stringify([...evidence.engineCampaign.nnueSha256].sort())
  ) {
    throw new Error('Puzzle engine identity differs from the release-bound campaign source')
  }
  const seenIds = new Set<string>()
  const output: PuzzleV3VerifiedEnvelopeV1[] = []
  for (const candidateInput of options.candidates) {
    const envelope = PuzzleV3CandidateEnvelopeV1Schema.parse(candidateInput.value)
    if (envelope.releaseId !== options.releaseId) throw new Error(`Puzzle ${envelope.candidate.puzzleId} belongs to another release`)
    if (envelope.evidenceBindingSha256 !== options.evidenceBindingSha256) throw new Error(`Puzzle ${envelope.candidate.puzzleId} has another evidence binding`)
    if (seenIds.has(envelope.candidate.puzzleId)) throw new Error(`Duplicate puzzle candidate ${envelope.candidate.puzzleId}`)
    seenIds.add(envelope.candidate.puzzleId)
    const checks = []
    for (const node of puzzleNodes(envelope.candidate)) {
      const chess = new Chess(`${node.epd} 0 1`)
      const legalMoveCount = chess.moves().length
      const required = Math.min(PUZZLE_ENGINE_SETTINGS.multiPv, legalMoveCount)
      await options.engine.resetForPosition()
      options.engine.setMultiPv(5)
      const rootResult = await options.engine.analyze({ fen: `${node.epd} 0 1`, nodes: PUZZLE_ENGINE_SETTINGS.nodes })
      const root = rootResult.variations
        .sort((left, right) => left.multipv - right.multipv)
        .map((variation, index) => {
          if (variation.multipv !== index + 1) throw new Error(`Root MultiPV ordinals are not contiguous at ${envelope.candidate.puzzleId}/${node.learnerIndex}`)
          return exact(variation, node.epd, `Puzzle ${envelope.candidate.puzzleId} root MultiPV ${index + 1}`)
        })
      if (root.length !== required) throw new Error(`Root MultiPV returned ${root.length}/${required} lines at ${envelope.candidate.puzzleId}/${node.learnerIndex}`)
      if (root.some((variation, index) => variation.multipv !== index + 1)) throw new Error('Root MultiPV observations are not contiguous')
      if (root.slice(1).some((variation, index) => scoreValue(variation.score) > scoreValue(root[index]!.score))) throw new Error('Root MultiPV scores are not ordered best-first')
      const best = root[0]!
      if (rootResult.bestMoveUci !== best.movesUci[0]) throw new Error('UCI bestmove differs from exact MultiPV 1')
      const matching = root.find((variation) => variation.movesUci[0] === node.expectedMoveUci)
      let expected = matching
      let searchMode: 'root-multipv' | 'forced-search' = 'root-multipv'
      if (!expected) {
        await options.engine.resetForPosition()
        options.engine.setMultiPv(1)
        const forcedResult = await options.engine.analyze({ fen: `${node.epd} 0 1`, nodes: PUZZLE_ENGINE_SETTINGS.nodes, searchMoveUci: node.expectedMoveUci })
        if (forcedResult.bestMoveUci !== node.expectedMoveUci || forcedResult.variations.length !== 1) throw new Error('Forced search did not return the expected move')
        expected = exact(forcedResult.variations[0]!, node.epd, `Puzzle ${envelope.candidate.puzzleId} forced search`)
        searchMode = 'forced-search'
      }
      if (!expected || expected.movesUci[0] !== node.expectedMoveUci) throw new Error('Expected-move observation does not begin with the puzzle move')
      if (options.repeatRoots !== false) {
        await options.engine.resetForPosition()
        options.engine.setMultiPv(5)
        const repeated = await options.engine.analyze({ fen: `${node.epd} 0 1`, nodes: PUZZLE_ENGINE_SETTINGS.nodes })
        const repeatedRoot = repeated.variations.sort((left, right) => left.multipv - right.multipv).map((variation, index) => exact(variation, node.epd, `Puzzle ${envelope.candidate.puzzleId} repeated root ${index + 1}`))
        if (JSON.stringify(repeatedRoot) !== JSON.stringify(root) || repeated.bestMoveUci !== rootResult.bestMoveUci) throw new Error(`Stockfish root search was not repeatable at ${envelope.candidate.puzzleId}/${node.learnerIndex}`)
      }
      const derived = derive(best.score, expected.score)
      checks.push(PuzzleEngineProofSchema.parse({
        learnerIndex: node.learnerIndex,
        positionEpd: node.epd,
        expectedMoveUci: node.expectedMoveUci,
        engineBestMoveUci: best.movesUci[0],
        ...derived,
        engine: 'Stockfish 18',
        engineSha256: options.engineSha256,
        // Puzzle proof schema records the active network; the campaign
        // evidence retains the complete big/small set.
        nnueSha256: [...options.nnueSha256].sort()[0]!,
        settingsSha256: PUZZLE_ENGINE_SETTINGS_SHA256,
        settings: PUZZLE_ENGINE_SETTINGS,
        rootVariations: root,
        expectedMoveObservation: { searchMode, variation: expected },
        principalVariationUci: best.movesUci,
        analyzedAt: options.analyzedAt,
      }))
    }
    const record = {
      ...envelope.candidate,
      engineStatus: 'verified' as const,
      engineChecks: checks,
      releaseEligible: true,
    }
    output.push(PuzzleV3VerifiedEnvelopeV1Schema.parse({
      schemaVersion: 1,
      releaseId: options.releaseId,
      evidenceBindingSha256: options.evidenceBindingSha256,
      familyIds: envelope.familyIds,
      record,
    }))
  }
  return output
}

/** Build promotion-ready, content-addressed shards from complete proof envelopes. */
export function buildPuzzleProofInventory(options: {
  releaseId: string
  completedAt: string
  evidence: PuzzleV3EvidenceBindingV1
  evidenceBindingSha256: string
  verified: readonly PuzzleV3VerifiedEnvelopeV1[]
}): PuzzlePromotionProofInventoryV1 {
  const evidence = PuzzleV3EvidenceBindingV1Schema.parse(options.evidence)
  if (sha256Json(evidence) !== options.evidenceBindingSha256 || evidence.releaseId !== options.releaseId) throw new Error('Proof inventory evidence binding is invalid')
  const groups = new Map<string, { familyIds: string[]; verified: PuzzleV3VerifiedEnvelopeV1[] }>()
  for (const envelopeInput of options.verified) {
    const envelope = PuzzleV3VerifiedEnvelopeV1Schema.parse(envelopeInput)
    if (envelope.releaseId !== options.releaseId || envelope.evidenceBindingSha256 !== options.evidenceBindingSha256) throw new Error(`Puzzle ${envelope.record.puzzleId} has cross-release evidence`)
    const key = [...envelope.familyIds].sort().join('|')
    const group = groups.get(key) ?? { familyIds: [...envelope.familyIds].sort(), verified: [] }
    group.verified.push(envelope)
    groups.set(key, group)
  }
  const shards = [...groups.values()]
    .sort((left, right) => stableStringCompare(left.familyIds.join('|'), right.familyIds.join('|')))
    .flatMap((group) => {
      // Puzzle IDs are the stable ordering key. This makes page rollover and
      // compressed receipts independent of candidate input/page arrival order.
      const ordered = [...group.verified].sort((left, right) => stableStringCompare(left.record.puzzleId, right.record.puzzleId))
      const pages: PuzzlePromotionProofInventoryV1['shards'] = []
      for (let offset = 0; offset < ordered.length; offset += MAX_PUZZLE_ENGINE_SHARD_PUZZLES) {
        const page = ordered.slice(offset, offset + MAX_PUZZLE_ENGINE_SHARD_PUZZLES)
        const puzzles = page.map((envelope) => tacticalPuzzleFromVerifiedEnvelope(envelope, evidence))
        const shard = TacticalPuzzleShardPayloadV1Schema.parse({ schemaVersion: 1, releaseId: options.releaseId, generatedAt: options.completedAt, familyIds: group.familyIds, puzzles })
        // The proof inventory must bind the bytes that are actually shipped.
        // All promoted puzzle resources use deterministic gzip over this exact
        // JSON representation; hashing uncompressed JSON would permit a
        // different compressed resource under the same receipt.
        const shippedBytes = gzipSync(`${JSON.stringify(shard, null, 2)}\n`)
        pages.push({ shardSha256: sha256(shippedBytes), familyIds: group.familyIds, verified: page })
      }
      return pages
    })
  return PuzzlePromotionProofInventoryV1Schema.parse({
    schemaVersion: 1,
    releaseId: options.releaseId,
    generatedAt: options.completedAt,
    evidence,
    evidenceBindingSha256: options.evidenceBindingSha256,
    shards,
  })
}

interface CampaignIdentity {
  manifestBytes: Buffer
  provisionBytes: Buffer
  releaseCommit: string
  engineSha256: string
}

async function campaignIdentity(options: { enginePath: string; stockfishManifestPath: string; provisionReceiptPath: string }): Promise<CampaignIdentity> {
  const manifestBytes = await readHandleBoundRegularFile(options.stockfishManifestPath, 'Stockfish source manifest', MAX_CONTROL_FILE_BYTES)
  const manifest = StockfishManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')) as unknown)
  if (JSON.stringify(manifest.analysisConfiguration) !== JSON.stringify(PUZZLE_ENGINE_SETTINGS)) throw new Error('Pinned Stockfish manifest settings differ from puzzle policy')
  const provisionBytes = await readHandleBoundRegularFile(options.provisionReceiptPath, 'Stockfish provision receipt', MAX_CONTROL_FILE_BYTES)
  const provision = assertStockfishProvisionMatchesManifest(manifest, JSON.parse(provisionBytes.toString('utf8')) as unknown)
  const engineSha256 = await sha256File(options.enginePath)
  if (engineSha256 !== provision.executable.sha256) throw new Error('Stockfish executable differs from its verified provision receipt')
  return { manifestBytes, provisionBytes, releaseCommit: manifest.releaseCommit, engineSha256 }
}

/** Filesystem runner used by the offline build. It fails before engine start on bad source/provision. */
export async function runPuzzleEngineCampaign(options: {
  receiptRoot: string
  candidateManifestReceipt: ImmutableJsonReceiptV1
  enginePath: string
  stockfishManifestPath: string
  provisionReceiptPath: string
  engineCampaignPath: string
  outputPath: string
  now?: () => Date
}): Promise<PuzzlePromotionProofInventoryV1> {
  const root = await resolveReceiptRoot(options.receiptRoot)
  const loadedManifest = await readImmutableJsonReceipt({ root, receipt: options.candidateManifestReceipt, maximumStoredBytes: MAX_CONTROL_FILE_BYTES, maximumDecodedBytes: MAX_CONTROL_FILE_BYTES })
  const manifest = PuzzleV3CandidateManifestV1Schema.parse(loadedManifest.value)
  // Do not even resolve/open a candidate shard whose manifest asks this
  // process to handle an unbounded corpus. The subsequent read/decode is
  // intentionally bounded by the same caps.
  if (manifest.totals.candidates > MAX_PUZZLE_ENGINE_CANDIDATES) {
    throw new Error(`Candidate manifest exceeds the ${MAX_PUZZLE_ENGINE_CANDIDATES}-candidate bounded subset limit`)
  }
  if (manifest.candidates.bytes > MAX_PUZZLE_ENGINE_CANDIDATE_STORED_BYTES) {
    throw new Error(`Candidate manifest exceeds the ${MAX_PUZZLE_ENGINE_CANDIDATE_STORED_BYTES}-byte stored shard limit`)
  }
  if (manifest.totals.candidates === 0) throw new Error('Candidate manifest contains no candidates')
  if (typeof options.engineCampaignPath !== 'string' || options.engineCampaignPath.length === 0) {
    throw new Error('Puzzle engine campaign receipt is mandatory')
  }

  // A campaign receipt is mandatory. Reopen it through a handle-bound read,
  // hash the exact bytes, and verify every source/config field before any
  // Stockfish process is started or candidate bytes are consumed.
  const campaignBytes = await readHandleBoundRegularFile(options.engineCampaignPath, 'Puzzle engine campaign', MAX_CONTROL_FILE_BYTES)
  const campaign = PuzzleEngineCampaignV1Schema.parse(JSON.parse(campaignBytes.toString('utf8')) as unknown)
  const evidence = PuzzleV3EvidenceBindingV1Schema.parse(manifest.evidence)
  if (
    sha256(campaignBytes) !== evidence.engineCampaign.campaignSha256
    || campaign.releaseId !== manifest.releaseId
    || campaign.releaseId !== evidence.releaseId
  ) throw new Error('Candidate evidence does not match the immutable puzzle engine campaign')

  const identity = await campaignIdentity({ enginePath: options.enginePath, stockfishManifestPath: options.stockfishManifestPath, provisionReceiptPath: options.provisionReceiptPath })
  const campaignSourcePath = await resolveSafeReceiptPath(root, campaign.sourceReceipt.path)
  const campaignProvisionBytes = await readHandleBoundRegularFile(campaignSourcePath, 'Campaign Stockfish provision receipt', MAX_CONTROL_FILE_BYTES)
  if (
    campaign.sourceReceipt.bytes !== campaignProvisionBytes.byteLength
    || campaign.sourceReceipt.sha256 !== sha256(campaignProvisionBytes)
    || campaign.sourceReceipt.sha256 !== sha256(identity.provisionBytes)
    || campaignProvisionBytes.toString('utf8') !== identity.provisionBytes.toString('utf8')
  ) throw new Error('Puzzle engine campaign source receipt differs from the verified provision receipt')
  assertStockfishProvisionMatchesManifest(
    JSON.parse(identity.manifestBytes.toString('utf8')) as unknown,
    JSON.parse(campaignProvisionBytes.toString('utf8')) as unknown,
  )
  if (
    campaign.engine.sourceManifestSha256 !== sha256(identity.manifestBytes)
    || campaign.engine.releaseCommit !== identity.releaseCommit
    || campaign.engine.executableSha256 !== identity.engineSha256
    || JSON.stringify(campaign.engine.settings) !== JSON.stringify(PUZZLE_ENGINE_SETTINGS)
    || campaign.engine.settingsSha256 !== PUZZLE_ENGINE_SETTINGS_SHA256
    || campaign.engine.sourceManifestSha256 !== evidence.engineCampaign.sourceManifestSha256
    || campaign.engine.releaseCommit !== evidence.engineCampaign.releaseCommit
    || campaign.engine.executableSha256 !== evidence.engineCampaign.executableSha256
    || JSON.stringify([...campaign.engine.nnueSha256].sort()) !== JSON.stringify([...evidence.engineCampaign.nnueSha256].sort())
    || campaign.sourceReceipt.sha256 !== evidence.engineCampaign.sourceReceiptSha256
  ) throw new Error('Puzzle engine campaign differs from the release-bound Stockfish source or configuration')

  const candidatePath = await resolveSafeReceiptPath(root, manifest.candidates.path)
  const candidateBytes = await readHandleBoundRegularFile(candidatePath, 'Puzzle candidate shard', MAX_PUZZLE_ENGINE_CANDIDATE_STORED_BYTES)
  if (candidateBytes.byteLength !== manifest.candidates.bytes || sha256(candidateBytes) !== manifest.candidates.sha256) {
    throw new Error('Candidate shard differs from its immutable manifest receipt')
  }
  const candidates = parsePuzzleCandidateShard(candidateBytes, manifest.totals.candidates)
  const started = await UciEngine.start({ executablePath: options.enginePath, workingDirectory: root })
  try {
    if (!/^Stockfish 18(?:\s|$)/u.test(started.identity.name)) throw new Error(`Expected Stockfish 18, received ${started.identity.name}`)
    const networks = await started.engine.exportNetworkHashes()
    const nnueSha256 = networks.map(({ sha256: value }) => value).sort()
    for (const network of networks) {
      const optionName = network.role === 'big' ? 'EvalFile' : 'EvalFileSmall'
      const configured = started.identity.optionDefaults[optionName]
      if (configured !== `nn-${network.sha256.slice(0, 12)}.nnue`) {
        throw new Error(`${network.role} NNUE hash does not match Stockfish's default network filename`)
      }
    }
    if (evidence.engineCampaign.executableSha256 !== identity.engineSha256 || evidence.engineCampaign.releaseCommit !== identity.releaseCommit || evidence.engineCampaign.sourceManifestSha256 !== sha256(identity.manifestBytes) || evidence.engineCampaign.sourceReceiptSha256 !== sha256(identity.provisionBytes)) throw new Error('Candidate evidence does not match pinned Stockfish source/provision')
    if (JSON.stringify(evidence.engineCampaign.nnueSha256) !== JSON.stringify(nnueSha256)) throw new Error('Candidate evidence NNUE identity differs from the pinned engine')
    const completedAt = (options.now ?? (() => new Date()))().toISOString()
    const verified = await analyzePuzzleCandidates({ candidates, engine: started.engine, engineSha256: identity.engineSha256, nnueSha256, analyzedAt: completedAt, releaseId: manifest.releaseId, evidence, evidenceBindingSha256: manifest.evidenceBindingSha256 })
    const inventory = buildPuzzleProofInventory({ releaseId: manifest.releaseId, completedAt, evidence, evidenceBindingSha256: manifest.evidenceBindingSha256, verified })
    const pending = await writeImmutableJsonCandidate({ root, outputPath: options.outputPath, value: inventory })
    await pending.promote()
    return inventory
  } finally {
    await started.engine.close()
  }
}

export const puzzleEngineSettingsHash = PUZZLE_ENGINE_SETTINGS_SHA256

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Chess, type PieceSymbol, type Square } from 'chess.js'
import { z } from 'zod'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import { RepertoireEngineCheckSchema } from '../../src/domain/repertoire.ts'
import type { EnginePrincipalVariation } from '../../src/data/verification/contracts.ts'
import {
  FAMILY_ENGINE_SETTINGS,
  FamilyEngineCampaignProofInventoryV1Schema,
  FamilyEngineCampaignRequestV1Schema,
  FamilyEngineCandidatePackV1Schema,
  FamilyEnginePackProofDocumentV1Schema,
  FamilyEnginePrincipalVariationV1Schema,
  type FamilyEngineCampaignProofInventoryV1,
  type FamilyEngineCandidatePackV1,
  type FamilyEnginePackProofDocumentV1,
} from './family-engine-v3-contracts.ts'
import { FamilyGraphEngineProofSetV1Schema } from './family-graph-v3-contracts.ts'
import {
  readImmutableJsonReceipt,
  resolveReceiptRoot,
  resolveSafeReceiptPath,
  writeImmutableJsonCandidate,
  type ImmutableJsonReceiptV1,
} from '../release/lib/immutable-json-receipt.ts'
import { readHandleBoundRegularFile } from '../lib/handle-bound-file.ts'
import {
  StockfishManifestSchema,
  assertStockfishProvisionMatchesManifest,
} from '../verification/lib/manifest.ts'
import { sha256File } from '../verification/lib/files.ts'
import { UciEngine, type UciAnalysis, type UciIdentity } from '../verification/lib/uci-engine.ts'

const MAX_CONTROL_FILE_BYTES = 2 * 1024 * 1024
const SETTINGS_SHA256 = createHash('sha256').update(JSON.stringify(FAMILY_ENGINE_SETTINGS)).digest('hex')

const CachedAnalysisSchema = z.object({
  schemaVersion: z.literal(1),
  cacheKey: z.string().regex(/^[a-f0-9]{64}$/u),
  engineSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  nnueSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).max(8),
  settingsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  epd: z.string().min(1).max(128),
  searchMoveUci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u).nullable(),
  result: z.object({
    bestMoveUci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u),
    variations: z.array(z.object({
      multipv: z.number().int().min(1).max(5),
      depth: z.number().int().nonnegative().nullable(),
      selectiveDepth: z.number().int().nonnegative().nullable(),
      nodes: z.number().int().nonnegative().nullable(),
      score: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('centipawn'), value: z.number().int() }).strict(),
        z.object({ kind: z.literal('mate'), value: z.number().int() }).strict(),
      ]),
      bound: z.enum(['exact', 'lower', 'upper']),
      movesUci: z.array(z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/u)).min(1).max(64),
    }).strict()).min(1).max(5),
  }).strict(),
}).strict()

export interface FamilyEngineAnalysisAdapter {
  resetForPosition(timeoutMs?: number): Promise<void>
  setMultiPv(value: 1 | 5): void
  analyze(options: { fen: string; nodes: 250_000; searchMoveUci?: string; timeoutMs?: number }): Promise<UciAnalysis>
}

export interface FamilyEngineCache {
  load(key: string): Promise<UciAnalysis | null>
  save(key: string, value: UciAnalysis, identity: { epd: string; searchMoveUci: string | null }): Promise<void>
}

export class JsonFileFamilyEngineCache implements FamilyEngineCache {
  constructor(
    private readonly directory: string,
    private readonly identity: { engineSha256: string; nnueSha256: string[] },
  ) {}

  async load(key: string): Promise<UciAnalysis | null> {
    const path = join(this.directory, `${key}.json`)
    try {
      const bytes = await readHandleBoundRegularFile(
        path,
        'Engine cache entry',
        MAX_CONTROL_FILE_BYTES,
      )
      const parsed = CachedAnalysisSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown)
      if (
        parsed.cacheKey !== key ||
        parsed.engineSha256 !== this.identity.engineSha256 ||
        parsed.settingsSha256 !== SETTINGS_SHA256 ||
        JSON.stringify(parsed.nnueSha256) !== JSON.stringify([...this.identity.nnueSha256].sort())
      ) throw new Error('Engine cache entry identity differs from its campaign key')
      const recomputed = familyEngineCacheKey({
        epd: parsed.epd,
        searchMoveUci: parsed.searchMoveUci,
        engineSha256: parsed.engineSha256,
        nnueSha256: parsed.nnueSha256,
      })
      if (recomputed !== key) throw new Error('Engine cache payload does not match its content key')
      return parsed.result
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }

  async save(key: string, value: UciAnalysis, identity: { epd: string; searchMoveUci: string | null }): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const path = join(this.directory, `${key}.json`)
    const temporary = `${path}.${process.pid}.tmp`
    const payload = CachedAnalysisSchema.parse({
      schemaVersion: 1,
      cacheKey: key,
      engineSha256: this.identity.engineSha256,
      nnueSha256: [...this.identity.nnueSha256].sort(),
      settingsSha256: SETTINGS_SHA256,
      epd: identity.epd,
      searchMoveUci: identity.searchMoveUci,
      result: value,
    })
    try {
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true })
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return
      throw error
    }
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function familyEngineCacheKey(options: {
  epd: string
  searchMoveUci: string | null
  engineSha256: string
  nnueSha256: readonly string[]
}): string {
  return sha256(JSON.stringify({
    epd: options.epd,
    searchMoveUci: options.searchMoveUci,
    engineSha256: options.engineSha256,
    nnueSha256: [...options.nnueSha256].sort(),
    settingsSha256: SETTINGS_SHA256,
  }))
}

function moveInput(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

export function assertLegalPrincipalVariation(epd: string, moves: readonly string[], label: string): void {
  const chess = new Chess(`${epd} 0 1`)
  for (const [index, uci] of moves.entries()) {
    try {
      chess.move(moveInput(uci))
    } catch {
      throw new Error(`${label} contains illegal move ${uci} at PV ply ${index + 1}`)
    }
  }
}

function validateCandidatePack(pack: FamilyEngineCandidatePackV1): void {
  for (const node of pack.learnerNodes) {
    const chess = new Chess(`${node.epd} 0 1`)
    const expectedTurn = pack.side === 'white' ? 'w' : 'b'
    if (chess.turn() !== expectedTurn) throw new Error(`Candidate ${pack.packId}/${node.positionId} is not the learner's turn`)
    if (node.positionId !== `pos_${sha256(node.epd).slice(0, 16)}`) {
      throw new Error(`Candidate position ID does not match its canonical EPD: ${node.positionId}`)
    }
    if (normalizedEpd(chess) !== node.epd) throw new Error(`Candidate EPD is not canonical: ${node.epd}`)
    for (const edge of node.candidateEdges) {
      const copy = new Chess(`${node.epd} 0 1`)
      try {
        copy.move(moveInput(edge.uci))
      } catch {
        throw new Error(`Candidate edge ${edge.uci} is illegal at ${node.positionId}`)
      }
      if (normalizedEpd(copy) !== edge.toEpd) throw new Error(`Candidate edge ${edge.uci} has the wrong destination EPD`)
    }
  }
}

function exactVariation(variation: EnginePrincipalVariation, epd: string, label: string) {
  if (variation.bound !== 'exact') throw new Error(`${label} returned a bounded rather than exact score`)
  if (variation.nodes === null || variation.nodes < FAMILY_ENGINE_SETTINGS.nodes) {
    throw new Error(`${label} did not record the required 250,000-node search`)
  }
  assertLegalPrincipalVariation(epd, variation.movesUci, label)
  return FamilyEnginePrincipalVariationV1Schema.parse({ ...variation, nodes: variation.nodes })
}

function evaluation(score: EnginePrincipalVariation['score']) {
  return score.kind === 'centipawn'
    ? { kind: 'centipawn' as const, value: score.value, unit: 'centipawn' as const, perspective: 'trained-side' as const }
    : { kind: 'mate' as const, value: score.value, unit: 'signed-plies-to-mate' as const, perspective: 'trained-side' as const }
}

function comparison(best: EnginePrincipalVariation['score'], candidate: EnginePrincipalVariation['score']) {
  const forcedMateAgainstLearner = candidate.kind === 'mate' && candidate.value < 0
  if (best.kind === 'centipawn' && candidate.kind === 'centipawn') {
    return { centipawnLoss: Math.max(0, best.value - candidate.value), forcedMateAgainstLearner }
  }
  if (best.kind === 'mate' && candidate.kind === 'mate' && best.value > 0 && candidate.value > 0) {
    return { centipawnLoss: 0, forcedMateAgainstLearner }
  }
  return { centipawnLoss: null, forcedMateAgainstLearner }
}

async function cachedAnalyze(options: {
  engine: FamilyEngineAnalysisAdapter
  cache: FamilyEngineCache | null
  memory: Map<string, Promise<UciAnalysis>>
  epd: string
  searchMoveUci: string | null
  engineSha256: string
  nnueSha256: readonly string[]
  repeatRoot?: boolean
}): Promise<{ key: string; result: UciAnalysis }> {
  const key = familyEngineCacheKey(options)
  // Repeatability is per emitted learner node. Do not collapse duplicate EPD
  // memberships in this mode; each pack/node receives two fresh searches.
  const prior = options.repeatRoot ? undefined : options.memory.get(key)
  if (prior) return { key, result: await prior }
  const pending = (async () => {
    // A repeated root is an authenticity check, so cached output cannot stand
    // in for two fresh UCI searches. Ordinary forced searches may reuse cache.
    const cached = options.repeatRoot ? null : await options.cache?.load(key)
    if (cached) return cached
    await options.engine.resetForPosition()
    options.engine.setMultiPv(options.searchMoveUci === null ? 5 : 1)
    const result = await options.engine.analyze({
      fen: `${options.epd} 0 1`,
      nodes: FAMILY_ENGINE_SETTINGS.nodes,
      ...(options.searchMoveUci === null ? {} : { searchMoveUci: options.searchMoveUci }),
    })
    if (options.repeatRoot) {
      await options.engine.resetForPosition()
      options.engine.setMultiPv(5)
      const repeated = await options.engine.analyze({
        fen: `${options.epd} 0 1`,
        nodes: FAMILY_ENGINE_SETTINGS.nodes,
      })
      if (JSON.stringify(repeated) !== JSON.stringify(result)) {
        throw new Error(`Stockfish root search was not repeatable at ${options.epd}`)
      }
    }
    await options.cache?.save(key, result, { epd: options.epd, searchMoveUci: options.searchMoveUci })
    return result
  })()
  if (!options.repeatRoot) options.memory.set(key, pending)
  try {
    return { key, result: await pending }
  } catch (error) {
    if (!options.repeatRoot) options.memory.delete(key)
    throw error
  }
}

export async function analyzeFamilyEngineCandidatePacks(options: {
  packs: Array<{ receipt: ImmutableJsonReceiptV1; value: FamilyEngineCandidatePackV1 }>
  engine: FamilyEngineAnalysisAdapter
  engineSha256: string
  nnueSha256: string[]
  analyzedAt: string
  cache?: FamilyEngineCache
  repeatRoots?: boolean
}): Promise<FamilyEnginePackProofDocumentV1[]> {
  const parsedTime = new Date(options.analyzedAt)
  if (!Number.isFinite(parsedTime.getTime())) throw new Error('Campaign analysis time must be an ISO timestamp')
  const packIds = options.packs.map(({ value }) => value.packId)
  if (new Set(packIds).size !== packIds.length) throw new Error('Engine candidate pack IDs must be unique')
  if (new Set(options.packs.map(({ value }) => value.releaseId)).size !== 1) {
    throw new Error('Engine candidate packs must belong to one release')
  }
  const memory = new Map<string, Promise<UciAnalysis>>()
  const output: FamilyEnginePackProofDocumentV1[] = []
  for (const { receipt, value: pack } of options.packs) {
    validateCandidatePack(pack)
    const analyses: FamilyEnginePackProofDocumentV1['analyses'] = []
    for (const node of pack.learnerNodes) {
      const root = await cachedAnalyze({
        engine: options.engine,
        cache: options.cache ?? null,
        memory,
        epd: node.epd,
        searchMoveUci: null,
        engineSha256: options.engineSha256,
        nnueSha256: options.nnueSha256,
        repeatRoot: options.repeatRoots === true,
      })
      const legalMoveCount = new Chess(`${node.epd} 0 1`).moves().length
      const expectedMultiPv = Math.min(FAMILY_ENGINE_SETTINGS.multiPv, legalMoveCount)
      if (root.result.variations.length !== expectedMultiPv) {
        throw new Error(`Stockfish returned ${root.result.variations.length}/${expectedMultiPv} required MultiPV lines at ${node.positionId}`)
      }
      const topVariations = root.result.variations.map((variation, index) =>
        exactVariation(variation, node.epd, `${node.positionId} MultiPV ${index + 1}`))
      const best = topVariations.find(({ multipv }) => multipv === 1)
      if (!best || best.movesUci[0] !== root.result.bestMoveUci) {
        throw new Error(`Stockfish bestmove and exact MultiPV 1 disagree at ${node.positionId}`)
      }
      const edgeChecks: FamilyEnginePackProofDocumentV1['analyses'][number]['edgeChecks'] = []
      for (const edge of node.candidateEdges) {
        const rootCandidate = topVariations.find(({ movesUci }) => movesUci[0] === edge.uci)
        let candidate = rootCandidate
        let cacheKey = root.key
        let searchMode: 'root-multipv' | 'forced-search' = 'root-multipv'
        if (!candidate) {
          const forced = await cachedAnalyze({
            engine: options.engine,
            cache: options.cache ?? null,
            memory,
            epd: node.epd,
            searchMoveUci: edge.uci,
            engineSha256: options.engineSha256,
            nnueSha256: options.nnueSha256,
          })
          cacheKey = forced.key
          const variation = forced.result.variations[0]
          if (!variation || forced.result.variations.length !== 1 || variation.movesUci[0] !== edge.uci) {
            throw new Error(`Forced Stockfish search did not return candidate ${edge.uci} at ${node.positionId}`)
          }
          if (forced.result.bestMoveUci !== edge.uci) {
            throw new Error(`Forced Stockfish bestmove did not match candidate ${edge.uci} at ${node.positionId}`)
          }
          candidate = exactVariation(variation, node.epd, `${node.positionId} candidate ${edge.uci}`)
          searchMode = 'forced-search'
        }
        const derived = comparison(best.score, candidate.score)
        const check = RepertoireEngineCheckSchema.parse({
          engineName: 'Stockfish 18',
          engineSha256: options.engineSha256,
          nnueSha256: [...options.nnueSha256].sort(),
          settings: FAMILY_ENGINE_SETTINGS,
          analyzedAt: options.analyzedAt,
          analyzedMoveUci: edge.uci,
          bestMoveUci: root.result.bestMoveUci,
          bestEvaluation: evaluation(best.score),
          moveEvaluation: evaluation(candidate.score),
          ...derived,
          bestPrincipalVariationUci: best.movesUci,
          movePrincipalVariationUci: candidate.movesUci,
        })
        edgeChecks.push({
          toEpd: edge.toEpd,
          cacheKey,
          observation: { searchMode, variation: candidate },
          check,
        })
      }
      analyses.push(FamilyEnginePackProofDocumentV1Schema.shape.analyses.element.parse({
        positionId: node.positionId,
        epd: node.epd,
        learnerSide: node.learnerSide,
        rootCacheKey: root.key,
        bestMoveUci: root.result.bestMoveUci,
        topVariations,
        edgeChecks,
      }))
    }
    output.push(FamilyEnginePackProofDocumentV1Schema.parse({
      schemaVersion: 1,
      kind: 'linerecall-stockfish-18-family-pack-proof-document',
      releaseId: pack.releaseId,
      familyId: pack.familyId,
      packId: pack.packId,
      side: pack.side,
      provenanceRef: pack.provenanceRef,
      candidatePackSha256: receipt.sha256,
      empiricalInventorySha256: pack.empiricalInventorySha256,
      engineSha256: options.engineSha256,
      nnueSha256: [...options.nnueSha256].sort(),
      settingsSha256: SETTINGS_SHA256,
      analyses,
    }))
  }
  return output
}

async function immutableOutput(root: string, path: string, value: unknown): Promise<ImmutableJsonReceiptV1> {
  const expected = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  const expectedSha256 = sha256(expected)
  const reusable = async (): Promise<ImmutableJsonReceiptV1 | null> => {
    try {
      const rootReal = await resolveReceiptRoot(root)
      const existingPath = await resolveSafeReceiptPath(rootReal, path)
      const bytes = await readHandleBoundRegularFile(existingPath, `Existing immutable engine output ${path}`, expected.byteLength)
      if (bytes.byteLength !== expected.byteLength || sha256(bytes) !== expectedSha256) {
        throw new Error(`Existing immutable engine output differs: ${path}`)
      }
      return { path, sha256: expectedSha256, bytes: bytes.byteLength, uncompressedBytes: bytes.byteLength, encoding: 'identity' }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }
  const prior = await reusable()
  if (prior) return prior
  const pending = await writeImmutableJsonCandidate({ root, outputPath: path, value })
  try {
    await pending.promote()
    return {
      path,
      sha256: pending.sha256,
      bytes: pending.bytes,
      uncompressedBytes: pending.bytes,
      encoding: 'identity',
    }
  } catch (error) {
    await pending.discard()
    if (error instanceof Error && error.message.startsWith('Immutable handoff output already exists:')) {
      const raced = await reusable()
      if (raced) return raced
    }
    throw error
  }
}

function graphProofSetDocument(document: FamilyEnginePackProofDocumentV1) {
  return FamilyGraphEngineProofSetV1Schema.parse({
    schemaVersion: 1,
    kind: 'linerecall-stockfish-18-family-edge-proofs',
    releaseId: document.releaseId,
    familyId: document.familyId,
    packId: document.packId,
    provenanceRef: document.provenanceRef,
    candidatePackSha256: document.candidatePackSha256,
    empiricalInventorySha256: document.empiricalInventorySha256,
    proofs: document.analyses.flatMap((analysis) => analysis.edgeChecks.map(({ toEpd, check }) => ({
      fromEpd: analysis.epd,
      uci: check.analyzedMoveUci,
      toEpd,
      check,
    }))),
  })
}

function networkNameMatchesHash(identity: UciIdentity, role: 'big' | 'small', hash: string): void {
  const name = identity.optionDefaults[role === 'big' ? 'EvalFile' : 'EvalFileSmall']
  const match = /^nn-([a-f0-9]{12})\.nnue$/u.exec(name ?? '')
  if (match?.[1] === undefined || !hash.startsWith(match[1])) {
    throw new Error(`${role} NNUE hash does not match Stockfish's default network filename`)
  }
}

export async function runFamilyEngineCampaign(options: {
  receiptRoot: string
  requestReceipt: ImmutableJsonReceiptV1
  outputPath: string
  outputPrefix: string
  enginePath: string
  stockfishManifestPath: string
  provisionReceiptPath: string
  cacheDirectory: string
  now?: () => Date
}): Promise<FamilyEngineCampaignProofInventoryV1> {
  const requestLoaded = await readImmutableJsonReceipt({
    root: options.receiptRoot,
    receipt: options.requestReceipt,
    maximumStoredBytes: MAX_CONTROL_FILE_BYTES,
    maximumDecodedBytes: MAX_CONTROL_FILE_BYTES,
  })
  const request = FamilyEngineCampaignRequestV1Schema.parse(requestLoaded.value)
  const packs: Array<{ receipt: ImmutableJsonReceiptV1; value: FamilyEngineCandidatePackV1 }> = []
  for (const receipt of request.candidatePacks) {
    const loaded = await readImmutableJsonReceipt({ root: options.receiptRoot, receipt })
    const value = FamilyEngineCandidatePackV1Schema.parse(loaded.value)
    if (value.releaseId !== request.releaseId) throw new Error(`Candidate pack ${value.packId} belongs to another release`)
    packs.push({ receipt, value })
  }
  const manifestBytes = await readHandleBoundRegularFile(options.stockfishManifestPath, 'Stockfish source manifest', MAX_CONTROL_FILE_BYTES)
  const manifest = StockfishManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')) as unknown)
  if (JSON.stringify(manifest.analysisConfiguration) !== JSON.stringify(FAMILY_ENGINE_SETTINGS)) {
    throw new Error('Pinned Stockfish manifest settings differ from the family campaign')
  }
  const provisionBytes = await readHandleBoundRegularFile(options.provisionReceiptPath, 'Stockfish provision receipt', MAX_CONTROL_FILE_BYTES)
  const provision = assertStockfishProvisionMatchesManifest(
    manifest,
    JSON.parse(provisionBytes.toString('utf8')) as unknown,
  )
  const engineSha256 = await sha256File(options.enginePath)
  if (engineSha256 !== provision.executable.sha256) throw new Error('Stockfish executable differs from its provision receipt')

  const work = await mkdtemp(join(tmpdir(), 'linerecall-family-engine-'))
  let engine: UciEngine | null = null
  try {
    const started = await UciEngine.start({ executablePath: options.enginePath, workingDirectory: work })
    engine = started.engine
    if (!/^Stockfish 18(?:\s|$)/u.test(started.identity.name)) throw new Error(`Expected Stockfish 18, received ${started.identity.name}`)
    const networks = await engine.exportNetworkHashes()
    const nnueSha256 = networks.map(({ sha256: networkHash }) => networkHash).sort()
    for (const network of networks) networkNameMatchesHash(started.identity, network.role, network.sha256)
    const cache = new JsonFileFamilyEngineCache(options.cacheDirectory, { engineSha256, nnueSha256 })
    const completedAt = (options.now ?? (() => new Date()))().toISOString()
    const documents = await analyzeFamilyEngineCandidatePacks({
      packs,
      engine,
      engineSha256,
      nnueSha256,
      analyzedAt: completedAt,
      cache,
      repeatRoots: true,
    })
    const indexedPacks: FamilyEngineCampaignProofInventoryV1['packs'] = []
    for (const [index, document] of documents.entries()) {
      const source = packs[index]!
      const base = `${options.outputPrefix}/${document.packId}`
      const proofSha = sha256(`${JSON.stringify(document, null, 2)}\n`)
      const graphProofValue = graphProofSetDocument(document)
      const graphProofSha = sha256(`${JSON.stringify(graphProofValue, null, 2)}\n`)
      const proofDocument = await immutableOutput(options.receiptRoot, `${base}/proofs/${proofSha}.json`, document)
      const graphProofSet = await immutableOutput(options.receiptRoot, `${base}/graph-proofs/${graphProofSha}.json`, graphProofValue)
      const candidateEdgeCount = document.analyses.reduce((total, analysis) => total + analysis.edgeChecks.length, 0)
      const quarantinedEdgeCount = document.analyses.reduce((total, analysis) => total + analysis.edgeChecks.filter(({ check }) =>
        check.forcedMateAgainstLearner || (check.centipawnLoss ?? 0) >= 100).length, 0)
      indexedPacks.push({
        familyId: document.familyId,
        packId: document.packId,
        candidatePack: source.receipt,
        proofDocument,
        graphProofSet,
        learnerNodeCount: document.analyses.length,
        candidateEdgeCount,
        quarantinedEdgeCount,
      })
    }
    const allEpds = new Set(documents.flatMap(({ analyses }) => analyses.map(({ epd }) => epd)))
    const nodeMemberships = documents.reduce((total, document) => total + document.analyses.length, 0)
    const edgeProofs = indexedPacks.reduce((total, pack) => total + pack.candidateEdgeCount, 0)
    const inventory = FamilyEngineCampaignProofInventoryV1Schema.parse({
      schemaVersion: 1,
      kind: 'linerecall-stockfish-18-family-campaign-proof-inventory',
      releaseId: request.releaseId,
      completedAt,
      engine: {
        name: 'Stockfish 18',
        releaseCommit: manifest.releaseCommit,
        sourceManifestSha256: sha256(manifestBytes),
        provisionReceiptSha256: sha256(provisionBytes),
        executableSha256: engineSha256,
        nnueSha256,
        settings: FAMILY_ENGINE_SETTINGS,
        settingsSha256: SETTINGS_SHA256,
      },
      packs: indexedPacks,
      coverage: {
        candidatePacks: indexedPacks.length,
        uniqueLearnerPositions: allEpds.size,
        learnerNodeMemberships: nodeMemberships,
        rootSearchesRepeated: nodeMemberships,
        rootRepeatabilityMismatches: 0,
        expectedEdgeProofs: edgeProofs,
        emittedEdgeProofs: edgeProofs,
        missingEdgeProofs: 0,
        duplicateEdgeProofs: 0,
        crossReleaseCandidates: 0,
      },
    })
    await immutableOutput(options.receiptRoot, options.outputPath, inventory)
    return inventory
  } finally {
    await engine?.close()
    await rm(work, { recursive: true, force: true })
  }
}

export const FAMILY_ENGINE_SETTINGS_SHA256 = SETTINGS_SHA256

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import { Chess } from 'chess.js'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import type { EnginePrincipalVariation } from '../../src/data/verification/contracts.ts'
import {
  FamilyEngineCampaignRequestV1Schema,
  FamilyEngineCandidatePackV1Schema,
  FamilyEnginePackProofDocumentV1Schema,
  type FamilyEngineCandidatePackV1,
} from '../../scripts/data/family-engine-v3-contracts.ts'
import {
  analyzeFamilyEngineCandidatePacks,
  familyEngineCacheKey,
  type FamilyEngineAnalysisAdapter,
} from '../../scripts/data/family-engine-v3.ts'
import { FamilyGraphBuildRequestV1Schema } from '../../scripts/data/family-graph-v3-contracts.ts'

const HASH = 'a'.repeat(64)
const RELEASE = 'release-2026-08-engine-test'
const START = normalizedEpd(new Chess())

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function destination(epd: string, uci: string): string {
  const chess = new Chess(`${epd} 0 1`)
  chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) })
  return normalizedEpd(chess)
}

function candidatePack(options: {
  packId?: string
  releaseId?: string
  epd?: string
  side?: 'white' | 'black'
  moves?: string[]
} = {}): FamilyEngineCandidatePackV1 {
  const epd = options.epd ?? START
  const side = options.side ?? 'white'
  const moves = options.moves ?? ['e2e4', 'd2d4']
  return FamilyEngineCandidatePackV1Schema.parse({
    schemaVersion: 1,
    kind: 'linerecall-family-engine-candidate-pack',
    releaseId: options.releaseId ?? RELEASE,
    familyId: 'synthetic-family',
    packId: options.packId ?? 'synthetic_white',
    side,
    provenanceRef: `prov_${'b'.repeat(16)}`,
    empiricalInventorySha256: 'c'.repeat(64),
    learnerNodes: [{
      positionId: `pos_${digest(epd).slice(0, 16)}`,
      epd,
      learnerSide: side,
      candidateEdges: moves.map((uci) => ({ fromEpd: epd, uci, toEpd: destination(epd, uci) })),
    }],
  })
}

function receipt(path: string, marker: string) {
  return { path, sha256: digest(marker), bytes: 10, uncompressedBytes: 10, encoding: 'identity' as const }
}

function pv(multipv: number, move: string, score: number | { mate: number }): EnginePrincipalVariation {
  return {
    multipv,
    depth: 20,
    selectiveDepth: 30,
    nodes: 250_000,
    score: typeof score === 'number' ? { kind: 'centipawn', value: score } : { kind: 'mate', value: score.mate },
    bound: 'exact',
    movesUci: [move],
  }
}

function whiteEngine(overrides: { illegalPv?: boolean; d4Score?: number } = {}) {
  let calls = 0
  const engine: FamilyEngineAnalysisAdapter = {
    resetForPosition: async () => undefined,
    setMultiPv: () => undefined,
    analyze: async ({ searchMoveUci }) => {
      calls += 1
      if (searchMoveUci) return { bestMoveUci: searchMoveUci, variations: [pv(1, searchMoveUci, 0)] }
      return {
        bestMoveUci: 'e2e4',
        variations: [
          pv(1, overrides.illegalPv ? 'e2e5' : 'e2e4', 40),
          pv(2, 'd2d4', overrides.d4Score ?? 20),
          pv(3, 'g1f3', 10),
          pv(4, 'c2c4', 5),
          pv(5, 'b2b3', 0),
        ],
      }
    },
  }
  return { engine, calls: () => calls }
}

describe('family Stockfish v3 campaign', () => {
  test('whole-release requests retain more than 128 family packs without truncation', () => {
    const packs = Array.from({ length: 129 }, (_, index) =>
      receipt(`packs/pack-${index}.json`, `pack-${index}`))
    assert.equal(FamilyEngineCampaignRequestV1Schema.parse({
      schemaVersion: 1,
      kind: 'linerecall-stockfish-18-family-campaign-request',
      releaseId: RELEASE,
      settings: { threads: 1, hashMb: 128, multiPv: 5, nodes: 250_000 },
      candidatePacks: packs,
    }).candidatePacks.length, 129)
    assert.equal(FamilyGraphBuildRequestV1Schema.parse({
      schemaVersion: 1,
      handoff: receipt('handoff/exact.json', 'handoff'),
      packSpecs: packs,
    }).packSpecs.length, 129)
  })

  test('checks every candidate learner edge without a top-N family cutoff and reuses identical EPD analysis', async () => {
    const first = candidatePack()
    const second = candidatePack({ packId: 'synthetic_white_second' })
    const mock = whiteEngine()
    const documents = await analyzeFamilyEngineCandidatePacks({
      packs: [
        { receipt: receipt('candidates/one.json', 'one'), value: first },
        { receipt: receipt('candidates/two.json', 'two'), value: second },
      ],
      engine: mock.engine,
      engineSha256: HASH,
      nnueSha256: ['d'.repeat(64)],
      analyzedAt: '2026-08-06T12:00:00.000Z',
    })
    assert.equal(documents.length, 2)
    assert.deepEqual(documents.map(({ analyses }) => analyses[0]?.edgeChecks.length), [2, 2])
    assert.equal(mock.calls(), 1, 'the EPD/settings/engine cache is shared across packs')
    assert.ok(documents.every(({ analyses }) => analyses[0]?.topVariations.length === 5))
  })

  test('can require two fresh, byte-identical root observations for every learner node', async () => {
    const mock = whiteEngine()
    await analyzeFamilyEngineCandidatePacks({
      packs: [
        { receipt: receipt('candidates/repeat.json', 'repeat'), value: candidatePack() },
        { receipt: receipt('candidates/repeat-two.json', 'repeat-two'), value: candidatePack({ packId: 'synthetic_repeat_two' }) },
      ],
      engine: mock.engine,
      engineSha256: HASH,
      nnueSha256: ['d'.repeat(64)],
      analyzedAt: '2026-08-06T12:00:00.000Z',
      repeatRoots: true,
    })
    assert.equal(mock.calls(), 4, 'duplicate EPD memberships are repeated independently')

    let calls = 0
    const nondeterministic: FamilyEngineAnalysisAdapter = {
      resetForPosition: async () => undefined,
      setMultiPv: () => undefined,
      analyze: async () => {
        calls += 1
        return {
          bestMoveUci: 'e2e4',
          variations: [
            pv(1, 'e2e4', 40 + calls),
            pv(2, 'd2d4', 20),
            pv(3, 'g1f3', 10),
            pv(4, 'c2c4', 5),
            pv(5, 'b2b3', 0),
          ],
        }
      },
    }
    await assert.rejects(
      analyzeFamilyEngineCandidatePacks({
        packs: [{ receipt: receipt('candidates/nonrepeat.json', 'nonrepeat'), value: candidatePack() }],
        engine: nondeterministic,
        engineSha256: HASH,
        nnueSha256: ['d'.repeat(64)],
        analyzedAt: '2026-08-06T12:00:00.000Z',
        repeatRoots: true,
      }),
      /not repeatable/u,
    )
  })

  test('derives a 100cp quarantine boundary from trained-side evaluations rather than a caller flag', async () => {
    const mock = whiteEngine({ d4Score: -60 })
    const [document] = await analyzeFamilyEngineCandidatePacks({
      packs: [{ receipt: receipt('candidates/one.json', 'one'), value: candidatePack() }],
      engine: mock.engine,
      engineSha256: HASH,
      nnueSha256: ['d'.repeat(64)],
      analyzedAt: '2026-08-06T12:00:00.000Z',
    })
    const d4 = document?.analyses[0]?.edgeChecks.find(({ check }) => check.analyzedMoveUci === 'd2d4')
    assert.equal(d4?.check.centipawnLoss, 100)
    assert.equal(d4?.check.forcedMateAgainstLearner, false)
  })

  test('retains exact forced-search observations and rejects altered bounds, nodes, or derived checks', async () => {
    const mock = whiteEngine()
    const [document] = await analyzeFamilyEngineCandidatePacks({
      packs: [{
        receipt: receipt('candidates/forced.json', 'forced'),
        value: candidatePack({ moves: ['e2e4', 'a2a3'] }),
      }],
      engine: mock.engine,
      engineSha256: HASH,
      nnueSha256: ['d'.repeat(64)],
      analyzedAt: '2026-08-06T12:00:00.000Z',
    })
    assert.ok(document)
    const forced = document.analyses[0]?.edgeChecks.find(({ check }) => check.analyzedMoveUci === 'a2a3')
    assert.equal(forced?.observation.searchMode, 'forced-search')
    assert.equal(forced?.observation.variation.nodes, 250_000)
    assert.equal(forced?.observation.variation.bound, 'exact')

    const alteredNodes = structuredClone(document)
    alteredNodes.analyses[0]!.edgeChecks[1]!.observation.variation.nodes = 249_999
    assert.equal(FamilyEnginePackProofDocumentV1Schema.safeParse(alteredNodes).success, false)

    const alteredBound = structuredClone(document) as unknown as {
      analyses: Array<{ edgeChecks: Array<{ observation: { variation: { bound: string } } }> }>
    }
    alteredBound.analyses[0]!.edgeChecks[1]!.observation.variation.bound = 'lower'
    assert.equal(FamilyEnginePackProofDocumentV1Schema.safeParse(alteredBound).success, false)

    const alteredProjection = structuredClone(document)
    alteredProjection.analyses[0]!.edgeChecks[1]!.check.movePrincipalVariationUci = ['a2a4']
    assert.equal(FamilyEnginePackProofDocumentV1Schema.safeParse(alteredProjection).success, false)
  })

  test('derives losing-mate quarantine directly from the searched candidate score', async () => {
    const engine: FamilyEngineAnalysisAdapter = {
      resetForPosition: async () => undefined,
      setMultiPv: () => undefined,
      analyze: async () => ({
        bestMoveUci: 'e2e4',
        variations: [
          pv(1, 'e2e4', 40), pv(2, 'd2d4', { mate: -3 }), pv(3, 'g1f3', 10), pv(4, 'c2c4', 5), pv(5, 'b2b3', 0),
        ],
      }),
    }
    const [document] = await analyzeFamilyEngineCandidatePacks({
      packs: [{ receipt: receipt('candidates/one.json', 'one'), value: candidatePack() }],
      engine,
      engineSha256: HASH,
      nnueSha256: ['d'.repeat(64)],
      analyzedAt: '2026-08-06T12:00:00.000Z',
    })
    const d4 = document?.analyses[0]?.edgeChecks.find(({ check }) => check.analyzedMoveUci === 'd2d4')
    assert.equal(d4?.check.centipawnLoss, null)
    assert.equal(d4?.check.forcedMateAgainstLearner, true)
  })

  test('preserves the root side-to-move score as the trained-side perspective for Black', async () => {
    const chess = new Chess()
    chess.move('e4')
    const epd = normalizedEpd(chess)
    const moves = ['e7e5', 'c7c5']
    const engine: FamilyEngineAnalysisAdapter = {
      resetForPosition: async () => undefined,
      setMultiPv: () => undefined,
      analyze: async () => ({
        bestMoveUci: 'e7e5',
        variations: [
          pv(1, 'e7e5', 35), pv(2, 'c7c5', 20), pv(3, 'e7e6', 10), pv(4, 'c7c6', 5), pv(5, 'g8f6', 0),
        ],
      }),
    }
    const [document] = await analyzeFamilyEngineCandidatePacks({
      packs: [{ receipt: receipt('candidates/black.json', 'black'), value: candidatePack({ packId: 'synthetic_black', epd, side: 'black', moves }) }],
      engine,
      engineSha256: HASH,
      nnueSha256: ['d'.repeat(64)],
      analyzedAt: '2026-08-06T12:00:00.000Z',
    })
    const evaluation = document?.analyses[0]?.edgeChecks[0]?.check.bestEvaluation
    assert.deepEqual(evaluation, { kind: 'centipawn', value: 35, unit: 'centipawn', perspective: 'trained-side' })
  })

  test('clears engine state before every uncached root so pack order cannot change proofs', async () => {
    const chess = new Chess()
    chess.move('e4')
    const blackEpd = normalizedEpd(chess)
    const white = candidatePack({ packId: 'synthetic_order_white' })
    const black = candidatePack({
      packId: 'synthetic_order_black',
      epd: blackEpd,
      side: 'black',
      moves: ['e7e5', 'c7c5'],
    })
    const run = async (packs: FamilyEngineCandidatePackV1[]) => {
      let dirty = 0
      let resets = 0
      const engine: FamilyEngineAnalysisAdapter = {
        resetForPosition: async () => {
          dirty = 0
          resets += 1
        },
        setMultiPv: () => undefined,
        analyze: async ({ fen }) => {
          const blackTurn = fen.split(' ')[1] === 'b'
          const moves = blackTurn
            ? ['e7e5', 'c7c5', 'e7e6', 'c7c6', 'g8f6']
            : ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'b2b3']
          const contamination = dirty * 1_000
          dirty += 1
          return {
            bestMoveUci: moves[0]!,
            variations: moves.map((move, index) => pv(index + 1, move, 40 - index * 10 + contamination)),
          }
        },
      }
      const documents = await analyzeFamilyEngineCandidatePacks({
        packs: packs.map((value) => ({ receipt: receipt(`candidates/${value.packId}.json`, value.packId), value })),
        engine,
        engineSha256: HASH,
        nnueSha256: ['d'.repeat(64)],
        analyzedAt: '2026-08-06T12:00:00.000Z',
      })
      assert.equal(resets, 2)
      return Object.fromEntries(documents.map((document) => [document.packId, document.analyses]))
    }
    assert.deepEqual(await run([white, black]), await run([black, white]))
  })

  test('rejects illegal PVs, cross-release candidate packs, and duplicate candidate moves', async () => {
    const invalid = structuredClone(candidatePack())
    invalid.learnerNodes[0]!.candidateEdges.push(invalid.learnerNodes[0]!.candidateEdges[0]!)
    assert.equal(FamilyEngineCandidatePackV1Schema.safeParse(invalid).success, false)

    await assert.rejects(
      analyzeFamilyEngineCandidatePacks({
        packs: [{ receipt: receipt('candidates/one.json', 'one'), value: candidatePack() }],
        engine: whiteEngine({ illegalPv: true }).engine,
        engineSha256: HASH,
        nnueSha256: ['d'.repeat(64)],
        analyzedAt: '2026-08-06T12:00:00.000Z',
      }),
      /illegal move/u,
    )
    await assert.rejects(
      analyzeFamilyEngineCandidatePacks({
        packs: [
          { receipt: receipt('candidates/one.json', 'one'), value: candidatePack() },
          { receipt: receipt('candidates/two.json', 'two'), value: candidatePack({ packId: 'synthetic_second', releaseId: 'other-release' }) },
        ],
        engine: whiteEngine().engine,
        engineSha256: HASH,
        nnueSha256: ['d'.repeat(64)],
        analyzedAt: '2026-08-06T12:00:00.000Z',
      }),
      /one release/u,
    )
  })

  test('cache identity changes for a stale executable or NNUE network', () => {
    const base = { epd: START, searchMoveUci: null, engineSha256: HASH, nnueSha256: ['d'.repeat(64)] }
    assert.notEqual(familyEngineCacheKey(base), familyEngineCacheKey({ ...base, engineSha256: 'e'.repeat(64) }))
    assert.notEqual(familyEngineCacheKey(base), familyEngineCacheKey({ ...base, nnueSha256: ['f'.repeat(64)] }))
  })
})

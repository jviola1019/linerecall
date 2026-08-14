import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import { Chess } from 'chess.js'
import { normalizedEpd } from '../../src/domain/input-validation.ts'
import type { EnginePrincipalVariation } from '../../src/data/verification/contracts.ts'
import {
  FamilyEngineCandidatePackV1Schema,
  type FamilyEngineCandidatePackV1,
} from '../../scripts/data/family-engine-v3-contracts.ts'
import {
  analyzeFamilyEngineCandidatePacks,
  familyEngineCacheKey,
  type FamilyEngineAnalysisAdapter,
} from '../../scripts/data/family-engine-v3.ts'

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

  test('derives losing-mate quarantine directly from the searched candidate score', async () => {
    const engine: FamilyEngineAnalysisAdapter = {
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

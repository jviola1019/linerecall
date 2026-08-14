import {
  FamilyGraphProvenanceDocumentV1Schema,
  RepertoireBranchEvidenceSchema,
  type FamilyGraphProvenanceDocumentV1,
  type RepertoireBranchEvidence,
} from '../../src/domain/repertoire.ts'
import {
  TRINOMIAL_PROFILE_LIKELIHOOD_95_METHOD,
  trinomialScoreProfileLikelihoodInterval,
} from '../../src/domain/statistics.ts'

export const SYNTHETIC_GRAPH_PROVENANCE_REF = 'synthetic-fixture-not-production-evidence'

const CANONICAL_BANDS = ['<1800', '1800-1999', '2000-2199', '2200-2399', '2400+'] as const
const BEGINNER_BANDS = ['<1200', '1200-1499', '1500-1799'] as const

function outcome(moveN: number, reachN: number, trainedSide: 'white' | 'black') {
  const whiteWins = Math.floor(moveN * 0.4)
  const draws = Math.floor(moveN * 0.2)
  const blackWins = moveN - whiteWins - draws
  const wins = trainedSide === 'white' ? whiteWins : blackWins
  const losses = trainedSide === 'white' ? blackWins : whiteWins
  return {
    reachN,
    moveN,
    whiteWins,
    draws,
    blackWins,
    wins,
    losses,
    score: moveN === 0 ? null : (wins + draws * 0.5) / moveN,
    conditionalUsage: reachN === 0 ? 0 : moveN / reachN,
    scoreInterval: moveN === 0 ? null : {
      method: TRINOMIAL_PROFILE_LIKELIHOOD_95_METHOD,
      confidenceLevel: 0.95 as const,
      ...trinomialScoreProfileLikelihoodInterval(wins, draws, losses)!,
    },
  }
}

function zeroOutcome(trainedSide: 'white' | 'black') {
  return outcome(0, 0, trainedSide)
}

function cohort(options: {
  cohortId: string
  source: 'broadcast' | 'lichess-standard'
  trainedSide: 'white' | 'black'
  moveN: number
  reachN: number
}) {
  const aggregate = outcome(options.moveN, options.reachN, options.trainedSide)
  return {
    cohortId: options.cohortId,
    source: options.source,
    ratingSystem: options.source === 'broadcast' ? 'broadcast-rating' as const : 'lichess-glicko2' as const,
    timeControl: 'classical' as const,
    cutoff: '2026-06-30',
    trainedSide: options.trainedSide,
    aggregate,
    canonicalBands: CANONICAL_BANDS.map((band) => ({
      band,
      ...(band === '<1800' ? aggregate : zeroOutcome(options.trainedSide)),
    })),
    lichessBeginnerBands: options.source === 'lichess-standard'
      ? BEGINNER_BANDS.map((band) => ({
        band,
        ...(band === '<1200' ? aggregate : zeroOutcome(options.trainedSide)),
      }))
      : [],
  }
}

/** Explicitly synthetic evidence for schema and graph-behavior fixtures only. */
export function createSyntheticRepertoireEvidence(options: {
  uci: string
  trainedSide: 'white' | 'black'
  moveN?: number
  reachN?: number
  status?: 'verified' | 'unverified' | 'quarantined'
  centipawnLoss?: number | null
  forcedMateAgainstLearner?: boolean
  quarantineReasons?: string[]
}): RepertoireBranchEvidence {
  const moveN = options.moveN ?? 500
  const reachN = options.reachN ?? 1_000
  const status = options.status ?? 'verified'
  const centipawnLoss = options.centipawnLoss === undefined
    ? status === 'unverified' ? null : 0
    : options.centipawnLoss
  const forcedMateAgainstLearner = options.forcedMateAgainstLearner ?? false
  const quarantineReasons = options.quarantineReasons ?? (status === 'quarantined' ? ['synthetic fixture quarantine'] : [])
  const broadcast = cohort({
    cohortId: 'cohort_synthetic-broadcast-fixture',
    source: 'broadcast',
    trainedSide: options.trainedSide,
    moveN,
    reachN,
  })
  const lichess = cohort({
    cohortId: 'cohort_synthetic-lichess-fixture',
    source: 'lichess-standard',
    trainedSide: options.trainedSide,
    moveN,
    reachN,
  })
  const check = status === 'unverified' || centipawnLoss === null ? null : {
    engineName: 'Stockfish 18' as const,
    engineSha256: 'f'.repeat(64),
    nnueSha256: ['e'.repeat(64)],
    settings: { threads: 1 as const, hashMb: 128 as const, multiPv: 5 as const, nodes: 250_000 as const },
    analyzedAt: '2026-07-01T00:00:00.000Z',
    analyzedMoveUci: options.uci,
    bestMoveUci: options.uci,
    bestEvaluation: { kind: 'centipawn' as const, value: 20, unit: 'centipawn' as const, perspective: 'trained-side' as const },
    moveEvaluation: { kind: 'centipawn' as const, value: 20 - centipawnLoss, unit: 'centipawn' as const, perspective: 'trained-side' as const },
    centipawnLoss,
    forcedMateAgainstLearner,
    bestPrincipalVariationUci: [options.uci],
    movePrincipalVariationUci: [options.uci],
  }
  return RepertoireBranchEvidenceSchema.parse({
    cohorts: [broadcast, lichess],
    selectionCohortId: broadcast.cohortId,
    conditionalUsage: broadcast.aggregate.conditionalUsage,
    engine: { status, centipawnLoss, forcedMateAgainstLearner, quarantineReasons, check },
  })
}

type SyntheticImmutableReceipt = Pick<
  FamilyGraphProvenanceDocumentV1['receipts'][number],
  'kind' | 'path' | 'sha256' | 'bytes'
>

function receipt(
  kind: FamilyGraphProvenanceDocumentV1['receipts'][number]['kind'],
  nibble: string,
  immutable?: Omit<SyntheticImmutableReceipt, 'kind'>,
) {
  const sha256 = immutable?.sha256 ?? nibble.repeat(64)
  const license = {
    taxonomy: 'CC0-1.0',
    'broadcast-corpus': 'CC-BY-SA-4.0',
    'lichess-standard-corpus': 'CC0-1.0',
    engine: 'GPL-3.0-only',
    scid: 'GPL-2.0-only',
  } as const
  return {
    schemaVersion: 1 as const,
    id: `receipt_${sha256.slice(0, 16)}`,
    kind,
    path: immutable?.path ?? `receipts/${kind}-${sha256.slice(0, 8)}.json`,
    sha256,
    bytes: immutable?.bytes ?? 1_024,
    contentType: 'application/json' as const,
    sourceUrl: `https://example.invalid/linerecall-fixtures/${kind}`,
    retrievedAt: '2026-07-01T00:00:00.000Z',
    sourceRevision: 'synthetic-fixture-not-production',
    license: license[kind],
  }
}

export function createSyntheticFamilyGraphProvenanceDocument(options: {
  releaseId: string
  familyId: string
  provenanceRefs?: string[]
  receipts?: SyntheticImmutableReceipt[]
}): FamilyGraphProvenanceDocumentV1 {
  const definitions = [
    ['taxonomy', '1'],
    ['broadcast-corpus', '2'],
    ['lichess-standard-corpus', '3'],
    ['engine', '4'],
    ['scid', '5'],
  ] as const
  const supplied = new Map((options.receipts ?? []).map((value) => [value.kind, value]))
  const receipts = definitions.map(([kind, nibble]) => {
    const immutable = supplied.get(kind)
    return receipt(kind, nibble, immutable === undefined ? undefined : {
      path: immutable.path,
      sha256: immutable.sha256,
      bytes: immutable.bytes,
    })
  })
  const byKind = new Map(receipts.map((value) => [value.kind, value]))
  return FamilyGraphProvenanceDocumentV1Schema.parse({
    schemaVersion: 1,
    releaseId: options.releaseId,
    familyId: options.familyId,
    receipts,
    bindings: [...new Set(options.provenanceRefs ?? [SYNTHETIC_GRAPH_PROVENANCE_REF])].map((provenanceRef) => ({
      provenanceRef,
      taxonomyReceiptId: byKind.get('taxonomy')!.id,
      corpusReceiptIds: [byKind.get('broadcast-corpus')!.id, byKind.get('lichess-standard-corpus')!.id],
      engineReceiptId: byKind.get('engine')!.id,
      scidReceiptId: byKind.get('scid')!.id,
    })),
  })
}

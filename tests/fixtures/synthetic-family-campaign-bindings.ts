import { createHash } from 'node:crypto'
import type { ImmutableJsonReceiptV1 } from '../../scripts/release/lib/immutable-json-receipt.ts'
import {
  deriveFamilyEnginePromotionReceipt,
  type FamilyEngineCandidatePackV1,
  type FamilyEngineCampaignProofInventoryV1,
  type FamilyEnginePackProofDocumentV1,
} from '../../scripts/data/family-engine-v3-contracts.ts'
import type {
  FamilyGraphBuildOutputV1,
  FamilyGraphEngineProofSetV1,
} from '../../scripts/data/family-graph-v3-contracts.ts'
import {
  deriveFamilyScidPromotionReceipt,
  type FamilyScidCampaignReportV1,
  type FamilyScidCandidateInventoryV1,
} from '../../scripts/data/family-scid-v3.ts'
import type { RepertoireGraphDocument } from '../../src/domain/repertoire.ts'

const HASH = 'a'.repeat(64)

export interface SyntheticCampaignBindings {
  familyGraphBuild: ImmutableJsonReceiptV1
  engineProofInventory: ImmutableJsonReceiptV1
  scidCrosscheckReport: ImmutableJsonReceiptV1
  enginePromotionReceipt: ImmutableJsonReceiptV1
  scidPromotionReceipt: ImmutableJsonReceiptV1
  learnerNodeCount: number
}

type WriteJson = (path: string, value: unknown) => Promise<ImmutableJsonReceiptV1>

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Build receipt-complete synthetic verification evidence for release-gate
 * tests. Every value is derived from the supplied legal fixture graph and is
 * explicitly non-production; none of these values are opening statistics.
 */
export async function createSyntheticFamilyCampaignBindings(options: {
  releaseId: string
  familyId: string
  graph: RepertoireGraphDocument
  graphReceipt: ImmutableJsonReceiptV1
  eligibleInventoryReceipt: ImmutableJsonReceiptV1
  writeJson: WriteJson
  completedAt: string
  engineLearnerNodesOverride?: number
}): Promise<SyntheticCampaignBindings> {
  const { graph, writeJson } = options
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]))

  const familyGraphBuildValue: FamilyGraphBuildOutputV1 = {
    schemaVersion: 1,
    kind: 'linerecall-compact-v3-family-graph-build-output',
    releaseId: options.releaseId,
    exactHandoffSha256: sha256('synthetic-exact-handoff'),
    selectionPolicy: {
      practiceBranches: 'all-eligible-audited',
      maximumPracticeBranches: null,
      minimumDrillSample: 500,
      minimumExploratorySample: 100,
      maximumPly: 100,
    },
    packs: [{
      familyId: options.familyId,
      packId: graph.pack.id,
      graph: options.graphReceipt,
      eligibleInventory: options.eligibleInventoryReceipt,
      sourceExactStateSha256s: [sha256('synthetic-broadcast-state'), sha256('synthetic-q2-state')],
    }],
  }
  const familyGraphBuild = await writeJson('resources/family-graph-build.json', familyGraphBuildValue)

  const learnerNodes = graph.nodes.flatMap((node) => {
    if (!node.learnerTurn) return []
    const candidateEdges = node.outgoingEdgeIds.flatMap((edgeId) => {
      const edge = edgeById.get(edgeId)
      const to = edge ? nodeById.get(edge.toNodeId) : undefined
      return edge?.eligibleForDrill && edge.evidence.engine.check && to
        ? [{ fromEpd: node.epd, uci: edge.uci, toEpd: to.epd }]
        : []
    })
    return candidateEdges.length > 0
      ? [{ positionId: node.id, epd: node.epd, learnerSide: graph.pack.side, candidateEdges }]
      : []
  })
  if (learnerNodes.length === 0) throw new Error('Synthetic campaign fixture requires a verified learner edge')

  const candidatePack: FamilyEngineCandidatePackV1 = {
    schemaVersion: 1,
    kind: 'linerecall-family-engine-candidate-pack',
    releaseId: options.releaseId,
    familyId: options.familyId,
    packId: graph.pack.id,
    side: graph.pack.side,
    provenanceRef: graph.pack.provenanceRef,
    empiricalInventorySha256: options.eligibleInventoryReceipt.sha256,
    learnerNodes,
  }
  const candidatePackReceipt = await writeJson('resources/engine-candidate-pack.json', candidatePack)
  const settingsSha256 = sha256(JSON.stringify({ threads: 1, hashMb: 128, multiPv: 5, nodes: 250_000 }))

  const analyses: FamilyEnginePackProofDocumentV1['analyses'] = learnerNodes.map((node) => {
    const checks = node.candidateEdges.map((candidate) => {
      const graphEdge = graph.edges.find((edge) => {
        const from = nodeById.get(edge.fromNodeId)
        const to = nodeById.get(edge.toNodeId)
        return from?.epd === candidate.fromEpd && edge.uci === candidate.uci && to?.epd === candidate.toEpd
      })
      if (!graphEdge?.evidence.engine.check) throw new Error('Synthetic learner candidate lacks its graph engine check')
      return {
        toEpd: candidate.toEpd,
        cacheKey: sha256(`${candidate.fromEpd}\0${candidate.uci}\0${candidate.toEpd}`),
        check: graphEdge.evidence.engine.check,
      }
    })
    const bestMoveUci = node.candidateEdges[0]!.uci
    return {
      positionId: node.positionId,
      epd: node.epd,
      learnerSide: node.learnerSide,
      rootCacheKey: sha256(node.epd),
      bestMoveUci,
      topVariations: [{
        multipv: 1,
        depth: 20,
        selectiveDepth: 30,
        nodes: 250_000,
        score: { kind: 'centipawn', value: 0 },
        bound: 'exact',
        movesUci: [bestMoveUci],
      }],
      edgeChecks: checks,
    }
  })
  const proofDocument: FamilyEnginePackProofDocumentV1 = {
    schemaVersion: 1,
    kind: 'linerecall-stockfish-18-family-pack-proof-document',
    releaseId: options.releaseId,
    familyId: options.familyId,
    packId: graph.pack.id,
    side: graph.pack.side,
    provenanceRef: graph.pack.provenanceRef,
    candidatePackSha256: candidatePackReceipt.sha256,
    empiricalInventorySha256: candidatePack.empiricalInventorySha256,
    engineSha256: HASH,
    nnueSha256: [HASH],
    settingsSha256,
    analyses,
  }
  const proofDocumentReceipt = await writeJson('resources/engine-proof-document.json', proofDocument)
  const graphProofSet: FamilyGraphEngineProofSetV1 = {
    schemaVersion: 1,
    kind: 'linerecall-stockfish-18-family-edge-proofs',
    releaseId: options.releaseId,
    familyId: options.familyId,
    packId: graph.pack.id,
    provenanceRef: graph.pack.provenanceRef,
    candidatePackSha256: candidatePackReceipt.sha256,
    empiricalInventorySha256: candidatePack.empiricalInventorySha256,
    proofs: analyses.flatMap((analysis) => analysis.edgeChecks.map(({ toEpd, check }) => ({
      fromEpd: analysis.epd,
      uci: check.analyzedMoveUci,
      toEpd,
      check,
    }))),
  }
  const graphProofSetReceipt = await writeJson('resources/engine-graph-proof-set.json', graphProofSet)
  const edgeProofCount = graphProofSet.proofs.length
  const inventory: FamilyEngineCampaignProofInventoryV1 = {
    schemaVersion: 1,
    kind: 'linerecall-stockfish-18-family-campaign-proof-inventory',
    releaseId: options.releaseId,
    completedAt: options.completedAt,
    engine: {
      name: 'Stockfish 18',
      releaseCommit: 'a'.repeat(40),
      sourceManifestSha256: HASH,
      provisionReceiptSha256: HASH,
      executableSha256: HASH,
      nnueSha256: [HASH],
      settings: { threads: 1, hashMb: 128, multiPv: 5, nodes: 250_000 },
      settingsSha256,
    },
    packs: [{
      familyId: options.familyId,
      packId: graph.pack.id,
      candidatePack: candidatePackReceipt,
      proofDocument: proofDocumentReceipt,
      graphProofSet: graphProofSetReceipt,
      learnerNodeCount: learnerNodes.length,
      candidateEdgeCount: edgeProofCount,
      quarantinedEdgeCount: 0,
    }],
    coverage: {
      candidatePacks: 1,
      uniqueLearnerPositions: new Set(learnerNodes.map(({ epd }) => epd)).size,
      learnerNodeMemberships: options.engineLearnerNodesOverride ?? learnerNodes.length,
      expectedEdgeProofs: edgeProofCount,
      emittedEdgeProofs: edgeProofCount,
      missingEdgeProofs: 0,
      duplicateEdgeProofs: 0,
      crossReleaseCandidates: 0,
    },
  }
  const engineProofInventory = await writeJson('resources/engine-proof-inventory.json', inventory)
  const enginePromotionReceipt = await writeJson(
    'receipts/engine.json',
    deriveFamilyEnginePromotionReceipt({
      inventory,
      proofInventory: engineProofInventory,
      completedAt: options.completedAt,
    }),
  )

  const scidLines: FamilyScidCandidateInventoryV1['lines'] = graph.paths.map((path) => ({
    lineId: `scidline_${sha256(path.id).slice(0, 20)}`,
    familyId: options.familyId,
    packId: graph.pack.id,
    pathId: path.id,
    expectedBaseEco: graph.pack.ecoCodes[0]!,
    canonicalName: path.familyTags[0] ?? options.familyId,
    movesUci: path.edgeIds.map((edgeId) => {
      const edge = edgeById.get(edgeId)
      if (!edge) throw new Error(`Synthetic path references missing edge ${edgeId}`)
      return edge.uci
    }),
    drillEligible: true,
    engineQuarantined: false,
  }))
  const scidInventory: FamilyScidCandidateInventoryV1 = {
    schemaVersion: 1,
    kind: 'linerecall-family-scid-candidate-inventory',
    releaseId: options.releaseId,
    familyGraphBuildSha256: familyGraphBuild.sha256,
    lines: scidLines,
  }
  const scidInventoryReceipt = await writeJson('resources/scid-candidate-inventory.json', scidInventory)
  const byVolume = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  for (const line of scidLines) byVolume[line.expectedBaseEco[0] as keyof typeof byVolume] += 1
  const scidReport: FamilyScidCampaignReportV1 = {
    schemaVersion: 1,
    kind: 'linerecall-scid-family-crosscheck-report',
    releaseId: options.releaseId,
    completedAt: options.completedAt,
    candidateInventory: scidInventoryReceipt,
    familyGraphBuildSha256: familyGraphBuild.sha256,
    oracle: {
      repositoryCommit: 'a'.repeat(40),
      sourceManifestSha256: HASH,
      sha256: HASH,
      license: 'GPL-2.0-only',
      parsedEntryCount: 1,
      rejectedEntryCount: 0,
      oracleContentShipped: false,
    },
    sampling: {
      method: 'sha256-round-robin-eco-volumes-a-e',
      seed: 'synthetic-release-gate-fixture',
      maximum: 250,
      eligibleLineCount: scidLines.length,
      requiredSampleSize: scidLines.length,
      selected: scidLines.length,
      complete: true,
      byVolume,
    },
    summary: {
      match: 0,
      namingDifference: 0,
      missingOracleEntry: scidLines.length,
      baseEcoMismatch: 0,
      ambiguousOracleBase: 0,
      quarantined: 0,
    },
    results: scidLines.map((line) => ({
      lineId: line.lineId,
      familyId: line.familyId,
      packId: line.packId,
      pathId: line.pathId,
      expectedBaseEco: line.expectedBaseEco,
      status: 'missing_oracle_entry' as const,
      quarantined: false,
      deepestMatchedPly: null,
    })),
  }
  const scidCrosscheckReport = await writeJson('resources/scid-crosscheck-report.json', scidReport)
  const scidPromotionReceipt = await writeJson(
    'receipts/scid.json',
    deriveFamilyScidPromotionReceipt({
      report: scidReport,
      reportReceipt: scidCrosscheckReport,
      promotedDrillPathIds: new Set(graph.paths.map(({ id }) => id)),
      completedAt: options.completedAt,
    }),
  )

  return {
    familyGraphBuild,
    engineProofInventory,
    scidCrosscheckReport,
    enginePromotionReceipt,
    scidPromotionReceipt,
    learnerNodeCount: learnerNodes.length,
  }
}

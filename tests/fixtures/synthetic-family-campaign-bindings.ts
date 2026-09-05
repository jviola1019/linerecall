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
  selectFamilyScidSample,
  type FamilyScidCampaignReportV1,
  type FamilyScidCandidateInventoryV1,
} from '../../scripts/data/family-scid-v3.ts'
import type { RepertoireGraphDocument } from '../../src/domain/repertoire.ts'
import {
  SYNTHETIC_STOCKFISH_BIG_NNUE_PAYLOAD,
  SYNTHETIC_STOCKFISH_EXECUTABLE_PAYLOAD,
  SYNTHETIC_STOCKFISH_NNUE_SHA256,
  SYNTHETIC_STOCKFISH_SMALL_NNUE_PAYLOAD,
} from './synthetic-repertoire-evidence.ts'

const SYNTHETIC_STOCKFISH_RELEASE_COMMIT = 'a'.repeat(40)

export interface SyntheticCampaignBindings {
  campaignSourceBinding: ImmutableJsonReceiptV1
  familyGraphBuild: ImmutableJsonReceiptV1
  engineProofInventory: ImmutableJsonReceiptV1
  scidCrosscheckReport: ImmutableJsonReceiptV1
  enginePromotionReceipt: ImmutableJsonReceiptV1
  scidPromotionReceipt: ImmutableJsonReceiptV1
  learnerNodeCount: number
  stockfishSourceManifestSha256: string
  stockfishProvisionReceiptSha256: string
  stockfishReleaseCommit: string
  engineSha256: string
  nnueSha256: string[]
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

  const executable = await writeJson(
    'resources/verification/stockfish-synthetic.exe',
    SYNTHETIC_STOCKFISH_EXECUTABLE_PAYLOAD,
  )
  const bigNetwork = await writeJson(
    'resources/verification/stockfish-network-big.nnue',
    SYNTHETIC_STOCKFISH_BIG_NNUE_PAYLOAD,
  )
  const smallNetwork = await writeJson(
    'resources/verification/stockfish-network-small.nnue',
    SYNTHETIC_STOCKFISH_SMALL_NNUE_PAYLOAD,
  )
  const nnueSha256 = [bigNetwork.sha256, smallNetwork.sha256].sort()
  if (JSON.stringify(nnueSha256) !== JSON.stringify(SYNTHETIC_STOCKFISH_NNUE_SHA256)) {
    throw new Error('Synthetic NNUE fixture serializer changed its byte identity')
  }
  const stockfishLicense = {
    spdx: 'GPL-3.0-only' as const,
    name: 'GNU General Public License v3.0 only',
    url: 'https://github.com/official-stockfish/Stockfish/blob/cb3d4ee9b47d0c5aae855b12379378ea1439675c/Copying.txt',
    distributionPolicy: 'Synthetic test fixture only; no engine bytes are distributed.',
  }
  const stockfishArtifact = {
    platform: 'win32' as const,
    arch: 'x64' as const,
    fileName: 'stockfish-windows-x86-64.zip',
    url: 'https://github.com/official-stockfish/Stockfish/releases/download/sf_18/stockfish-windows-x86-64.zip',
    size: 1,
    sha256: sha256('synthetic-stockfish-archive'),
  }
  const stockfishManifestValue = {
    schemaVersion: 1 as const,
    name: 'Stockfish' as const,
    version: '18' as const,
    releaseTag: 'sf_18' as const,
    releaseCommit: SYNTHETIC_STOCKFISH_RELEASE_COMMIT,
    releasedAt: '2026-01-31T14:33:53.000Z',
    sourceUrl: `https://github.com/official-stockfish/Stockfish/tree/${SYNTHETIC_STOCKFISH_RELEASE_COMMIT}`,
    releaseUrl: 'https://github.com/official-stockfish/Stockfish/releases/tag/sf_18',
    approval: {
      status: 'approved' as const,
      approvedOn: '2026-07-11',
      scope: 'Synthetic verification fixture only.',
      basis: 'Exercises immutable campaign-source bindings without claiming production evidence.',
      reviewRequiredWhen: 'Fixture source bytes change.',
    },
    license: stockfishLicense,
    analysisConfiguration: { threads: 1 as const, hashMb: 128 as const, multiPv: 5 as const, nodes: 250_000 as const },
    artifacts: [stockfishArtifact],
  }
  const stockfishSourceManifest = await writeJson(
    'resources/verification/stockfish-18.source.json',
    stockfishManifestValue,
  )
  const stockfishProvisionReceipt = await writeJson(
    'resources/verification/stockfish-provision.json',
    {
      schemaVersion: 1,
      provisionedAt: options.completedAt,
      releaseTag: 'sf_18',
      releaseCommit: SYNTHETIC_STOCKFISH_RELEASE_COMMIT,
      license: stockfishLicense,
      artifact: {
        ...stockfishArtifact,
        archiveSha256Verified: stockfishArtifact.sha256,
        archiveReused: false,
      },
      executable: {
        path: executable.path,
        fileName: 'stockfish-synthetic.exe',
        sha256: executable.sha256,
      },
    },
  )

  const scidOracle = await writeJson('resources/verification/scid.eco', {
    fixture: 'synthetic-scid-oracle-bytes',
    productionEvidence: false,
  })
  const scidSourceManifest = await writeJson('resources/verification/scid.source.json', {
    schemaVersion: 1,
    name: 'Scid ECO classification oracle',
    repositoryCommit: 'b'.repeat(40),
    filePath: 'scid.eco',
    url: `https://raw.githubusercontent.com/benini/scid/${'b'.repeat(40)}/scid.eco`,
    sourceUrl: `https://github.com/benini/scid/tree/${'b'.repeat(40)}`,
    size: scidOracle.bytes,
    sha256: scidOracle.sha256,
    approval: {
      status: 'approved',
      approvedOn: '2026-07-11',
      scope: 'Synthetic verification fixture only.',
      basis: 'Exercises immutable Scid byte binding without shipping the oracle.',
      reviewRequiredWhen: 'Fixture oracle bytes change.',
    },
    license: {
      spdx: 'GPL-2.0-only',
      name: 'GNU General Public License v2.0 only',
      url: 'https://github.com/benini/scid/blob/master/COPYING',
      distributionPolicy: 'Audit-only synthetic fixture; oracle bytes are not shipped.',
    },
  })
  const scidProvisionReceipt = await writeJson('resources/verification/scid-provision.json', {
    schemaVersion: 1,
    provisionedAt: options.completedAt,
    repositoryCommit: 'b'.repeat(40),
    file: {
      path: 'scid.eco',
      size: scidOracle.bytes,
      sha256: scidOracle.sha256,
      reused: false,
    },
    license: {
      spdx: 'GPL-2.0-only',
      name: 'GNU General Public License v2.0 only',
      url: 'https://github.com/benini/scid/blob/master/COPYING',
      distributionPolicy: 'Audit-only synthetic fixture; oracle bytes are not shipped.',
    },
  })
  const campaignSourceBinding = await writeJson('resources/verification/campaign-source-binding.json', {
    schemaVersion: 1,
    kind: 'linerecall-verification-campaign-source-binding',
    releaseId: options.releaseId,
    boundAt: options.completedAt,
    stockfish: {
      sourceManifest: { path: stockfishSourceManifest.path, bytes: stockfishSourceManifest.bytes, sha256: stockfishSourceManifest.sha256 },
      provisionReceipt: { path: stockfishProvisionReceipt.path, bytes: stockfishProvisionReceipt.bytes, sha256: stockfishProvisionReceipt.sha256 },
      executable: { path: executable.path, bytes: executable.bytes, sha256: executable.sha256 },
      networks: [
        {
          role: 'big',
          defaultFileName: `nn-${bigNetwork.sha256.slice(0, 12)}.nnue`,
          file: { path: bigNetwork.path, bytes: bigNetwork.bytes, sha256: bigNetwork.sha256 },
        },
        {
          role: 'small',
          defaultFileName: `nn-${smallNetwork.sha256.slice(0, 12)}.nnue`,
          file: { path: smallNetwork.path, bytes: smallNetwork.bytes, sha256: smallNetwork.sha256 },
        },
      ],
    },
    scid: {
      sourceManifest: { path: scidSourceManifest.path, bytes: scidSourceManifest.bytes, sha256: scidSourceManifest.sha256 },
      provisionReceipt: { path: scidProvisionReceipt.path, bytes: scidProvisionReceipt.bytes, sha256: scidProvisionReceipt.sha256 },
      oracle: { path: scidOracle.path, bytes: scidOracle.bytes, sha256: scidOracle.sha256 },
    },
  })

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
      const check = graphEdge.evidence.engine.check
      const isRootVariation = check.analyzedMoveUci === check.bestMoveUci
      return {
        toEpd: candidate.toEpd,
        cacheKey: isRootVariation
          ? sha256(node.epd)
          : sha256(`${candidate.fromEpd}\0${candidate.uci}\0${candidate.toEpd}`),
        observation: {
          searchMode: isRootVariation ? 'root-multipv' as const : 'forced-search' as const,
          variation: {
            multipv: 1,
            depth: 20,
            selectiveDepth: 30,
            nodes: 250_000,
            score: { kind: check.moveEvaluation.kind, value: check.moveEvaluation.value },
            bound: 'exact' as const,
            movesUci: check.movePrincipalVariationUci,
          },
        },
        check,
      }
    })
    const bestCheck = checks[0]!.check
    const bestMoveUci = bestCheck.bestMoveUci
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
        score: { kind: bestCheck.bestEvaluation.kind, value: bestCheck.bestEvaluation.value },
        bound: 'exact',
        movesUci: bestCheck.bestPrincipalVariationUci,
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
    engineSha256: executable.sha256,
    nnueSha256,
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
      releaseCommit: SYNTHETIC_STOCKFISH_RELEASE_COMMIT,
      sourceManifestSha256: stockfishSourceManifest.sha256,
      provisionReceiptSha256: stockfishProvisionReceipt.sha256,
      executableSha256: executable.sha256,
      nnueSha256,
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
      rootSearchesRepeated: options.engineLearnerNodesOverride ?? learnerNodes.length,
      rootRepeatabilityMismatches: 0,
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
  const scidSample = selectFamilyScidSample(scidInventory, 250, 'synthetic-release-gate-fixture')
  const byVolume = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  for (const line of scidSample) byVolume[line.expectedBaseEco[0] as keyof typeof byVolume] += 1
  const scidReport: FamilyScidCampaignReportV1 = {
    schemaVersion: 1,
    kind: 'linerecall-scid-family-crosscheck-report',
    releaseId: options.releaseId,
    completedAt: options.completedAt,
    candidateInventory: scidInventoryReceipt,
    familyGraphBuildSha256: familyGraphBuild.sha256,
    oracle: {
      repositoryCommit: 'b'.repeat(40),
      sourceManifestSha256: scidSourceManifest.sha256,
      provisionReceiptSha256: scidProvisionReceipt.sha256,
      sha256: scidOracle.sha256,
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
      requiredSampleSize: scidSample.length,
      selected: scidSample.length,
      complete: true,
      byVolume,
    },
    summary: {
      match: 0,
      namingDifference: 0,
      missingOracleEntry: scidSample.length,
      baseEcoMismatch: 0,
      ambiguousOracleBase: 0,
      quarantined: 0,
    },
    results: scidSample.map((line) => ({
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
    campaignSourceBinding,
    familyGraphBuild,
    engineProofInventory,
    scidCrosscheckReport,
    enginePromotionReceipt,
    scidPromotionReceipt,
    learnerNodeCount: learnerNodes.length,
    stockfishSourceManifestSha256: stockfishSourceManifest.sha256,
    stockfishProvisionReceiptSha256: stockfishProvisionReceipt.sha256,
    stockfishReleaseCommit: SYNTHETIC_STOCKFISH_RELEASE_COMMIT,
    engineSha256: executable.sha256,
    nnueSha256,
  }
}

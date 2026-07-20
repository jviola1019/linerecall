import { Chess } from 'chess.js';

import {
  STOCKFISH_ANALYSIS_CONFIGURATION as CONFIG,
  type EngineAnalysisInput,
  type EnginePrincipalVariation,
  type MoveClassification,
  type UciScore,
  type VerificationLineInput,
} from '../../../src/data/verification/contracts.ts';
import type { UciAnalysis } from './uci-engine.ts';

export interface StockfishAnalysisAdapter {
  setMultiPv(value: 1 | 5): void;
  analyze(options: {
    fen: string;
    nodes: 250000;
    searchMoveUci?: string;
    timeoutMs?: number;
  }): Promise<UciAnalysis>;
}

export interface ClassifiedMove {
  moveUci: string;
  sampleSize: number;
  acceptedBookTransposition: boolean;
  classification: MoveClassification;
  centipawnLoss: number | null;
  score: UciScore | null;
  principalVariationUci: string[];
  independentlyEngineAnalyzed: boolean;
}

export interface AnalyzedDecisionNode {
  id: string;
  fen: string;
  expectedMoveUci: string;
  bestMoveUci: string;
  bestScore: UciScore;
  topVariations: EnginePrincipalVariation[];
  moves: ClassifiedMove[];
  expectedMoveCentipawnLoss: number;
  quarantined: boolean;
  quarantineReasons: string[];
}

export interface AnalyzedLine {
  id: string;
  sourceLineId: string;
  eco: string;
  name: string;
  trainedSide: 'white' | 'black';
  terminalSampleSize: number;
  quarantined: boolean;
  quarantineReasons: string[];
  nodes: AnalyzedDecisionNode[];
}

function scoreOrderingValue(score: UciScore): number {
  if (score.kind === 'centipawn') return score.value;
  if (score.value > 0) return 1_000_000 - Math.min(score.value, 999) * 1_000;
  if (score.value < 0) return -1_000_000 + Math.min(Math.abs(score.value), 999) * 1_000;
  return 0;
}

export function centipawnLoss(best: UciScore, candidate: UciScore): number {
  return Math.max(0, scoreOrderingValue(best) - scoreOrderingValue(candidate));
}

export function classifyAlternative(options: {
  expected: boolean;
  acceptedBookTransposition: boolean;
  sampleSize: number;
  bestScore: UciScore;
  candidateScore: UciScore | null;
  exactEngineScore: boolean;
}): { classification: MoveClassification; centipawnLoss: number | null } {
  if (options.expected || options.acceptedBookTransposition) {
    return {
      classification: 'book',
      centipawnLoss:
        options.candidateScore === null ? null : centipawnLoss(options.bestScore, options.candidateScore),
    };
  }
  if (
    options.sampleSize < CONFIG.independentlyAnalyzedAlternativeMinimumSampleSize ||
    options.candidateScore === null ||
    !options.exactEngineScore
  ) {
    return { classification: 'unverified_deviation', centipawnLoss: null };
  }
  const loss = centipawnLoss(options.bestScore, options.candidateScore);
  if (options.candidateScore.kind === 'mate' && options.candidateScore.value < 0) {
    return { classification: 'mistake', centipawnLoss: loss };
  }
  if (loss <= CONFIG.playableMaximumCentipawnLoss) {
    return { classification: 'playable', centipawnLoss: loss };
  }
  if (loss <= CONFIG.inaccuracyMaximumCentipawnLoss) {
    return { classification: 'inaccuracy', centipawnLoss: loss };
  }
  return { classification: 'mistake', centipawnLoss: loss };
}

export function selectTopEligibleLines(lines: VerificationLineInput[]): VerificationLineInput[] {
  const groups = new Map<string, Map<string, VerificationLineInput[]>>();
  for (const line of lines) {
    if (
      !line.drillEligible ||
      line.terminalSampleSize < CONFIG.minimumTerminalSampleSize ||
      line.preexistingQuarantineReasons.length > 0
    ) {
      continue;
    }
    const ecoGroup = groups.get(line.eco) ?? new Map<string, VerificationLineInput[]>();
    const sourceLineId = line.sourceLineId ?? line.id;
    const variants = ecoGroup.get(sourceLineId) ?? [];
    variants.push(line);
    ecoGroup.set(sourceLineId, variants);
    groups.set(line.eco, ecoGroup);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .flatMap(([, ecoGroup]) =>
      [...ecoGroup.entries()]
        .sort(([, left], [, right]) => {
          const leftSample = Math.max(...left.map((line) => line.terminalSampleSize));
          const rightSample = Math.max(...right.map((line) => line.terminalSampleSize));
          return rightSample - leftSample || (left[0]?.sourceLineId ?? left[0]?.id ?? '').localeCompare(
            right[0]?.sourceLineId ?? right[0]?.id ?? '',
            'en',
          );
        })
        .slice(0, CONFIG.maximumLinesPerEco)
        .flatMap(([, variants]) =>
          variants.sort((left, right) => left.trainedSide.localeCompare(right.trainedSide, 'en')),
        ),
    );
}

function moveParts(moveUci: string): { from: string; to: string; promotion?: string } {
  const promotion = moveUci[4];
  return promotion === undefined
    ? { from: moveUci.slice(0, 2), to: moveUci.slice(2, 4) }
    : { from: moveUci.slice(0, 2), to: moveUci.slice(2, 4), promotion };
}

function validateDecisionNode(line: VerificationLineInput, nodeIndex: number): void {
  const node = line.decisionNodes[nodeIndex];
  if (node === undefined) throw new Error(`Missing decision node ${nodeIndex} in ${line.id}`);
  let chess: Chess;
  try {
    chess = new Chess(node.fen);
  } catch (error) {
    throw new Error(`Invalid FEN for ${line.id}/${node.id}: ${(error as Error).message}`);
  }
  const expectedTurn = line.trainedSide === 'white' ? 'w' : 'b';
  if (chess.turn() !== expectedTurn) {
    throw new Error(`Decision node ${line.id}/${node.id} is not the trained side's turn`);
  }
  const candidates = new Set<string>();
  for (const move of [
    { moveUci: node.expectedMoveUci, label: 'expected' },
    ...node.candidateMoves.map((candidate) => ({ moveUci: candidate.moveUci, label: 'candidate' })),
  ]) {
    if (move.label === 'candidate' && candidates.has(move.moveUci)) {
      throw new Error(`Duplicate candidate ${move.moveUci} at ${line.id}/${node.id}`);
    }
    if (move.label === 'candidate') candidates.add(move.moveUci);
    const copy = new Chess(node.fen);
    try {
      const played = copy.move(moveParts(move.moveUci));
      if (played === null) throw new Error('move returned null');
    } catch {
      throw new Error(`Illegal ${move.label} move ${move.moveUci} at ${line.id}/${node.id}`);
    }
  }
}

async function independentlyAnalyzeMove(
  engine: StockfishAnalysisAdapter,
  fen: string,
  moveUci: string,
): Promise<EnginePrincipalVariation> {
  engine.setMultiPv(1);
  try {
    const result = await engine.analyze({
      fen,
      nodes: CONFIG.nodes,
      searchMoveUci: moveUci,
    });
    const variation = result.variations[0];
    if (variation === undefined || variation.movesUci[0] !== moveUci) {
      throw new Error(`Forced analysis did not return ${moveUci} as its root move`);
    }
    return variation;
  } finally {
    engine.setMultiPv(5);
  }
}

export async function analyzeDecisionNode(
  engine: StockfishAnalysisAdapter,
  line: VerificationLineInput,
  nodeIndex: number,
): Promise<AnalyzedDecisionNode> {
  validateDecisionNode(line, nodeIndex);
  const node = line.decisionNodes[nodeIndex] as VerificationLineInput['decisionNodes'][number];
  engine.setMultiPv(5);
  const root = await engine.analyze({ fen: node.fen, nodes: CONFIG.nodes });
  const best = root.variations.find((variation) => variation.multipv === 1) ?? root.variations[0];
  if (best === undefined || best.bound !== 'exact') {
    throw new Error(`No exact best score returned for ${line.id}/${node.id}`);
  }

  const variationsByMove = new Map(
    root.variations
      .filter((variation) => variation.movesUci[0] !== undefined)
      .map((variation) => [variation.movesUci[0] as string, variation]),
  );
  const candidateMetadata = new Map(
    node.candidateMoves.map((candidate) => [candidate.moveUci, candidate]),
  );
  if (!candidateMetadata.has(node.expectedMoveUci)) {
    candidateMetadata.set(node.expectedMoveUci, {
      moveUci: node.expectedMoveUci,
      sampleSize: node.candidateMoves.find((candidate) => candidate.moveUci === node.expectedMoveUci)?.sampleSize ?? 0,
      acceptedBookTransposition: false,
    });
  }
  for (const variation of root.variations) {
    const move = variation.movesUci[0];
    if (move !== undefined && !candidateMetadata.has(move)) {
      candidateMetadata.set(move, {
        moveUci: move,
        sampleSize: 0,
        acceptedBookTransposition: false,
      });
    }
  }

  for (const candidate of candidateMetadata.values()) {
    const mustHaveEngineScore =
      candidate.moveUci === node.expectedMoveUci ||
      candidate.sampleSize >= CONFIG.independentlyAnalyzedAlternativeMinimumSampleSize;
    const existing = variationsByMove.get(candidate.moveUci);
    if (mustHaveEngineScore && (existing === undefined || existing.bound !== 'exact')) {
      variationsByMove.set(
        candidate.moveUci,
        await independentlyAnalyzeMove(engine, node.fen, candidate.moveUci),
      );
    }
  }

  const moves: ClassifiedMove[] = [...candidateMetadata.values()]
    .sort((left, right) => left.moveUci.localeCompare(right.moveUci, 'en'))
    .map((candidate) => {
      const variation = variationsByMove.get(candidate.moveUci) ?? null;
      const classified = classifyAlternative({
        expected: candidate.moveUci === node.expectedMoveUci,
        acceptedBookTransposition: candidate.acceptedBookTransposition,
        sampleSize: candidate.sampleSize,
        bestScore: best.score,
        candidateScore: variation?.score ?? null,
        exactEngineScore: variation?.bound === 'exact',
      });
      return {
        ...candidate,
        ...classified,
        score: variation?.score ?? null,
        principalVariationUci: variation?.movesUci ?? [],
        independentlyEngineAnalyzed: variation !== null,
      };
    });
  const expected = moves.find((move) => move.moveUci === node.expectedMoveUci);
  if (expected?.score === null || expected?.score === undefined || expected.centipawnLoss === null) {
    throw new Error(`Expected move ${node.expectedMoveUci} was not scored at ${line.id}/${node.id}`);
  }

  const quarantineReasons: string[] = [];
  if (expected.score.kind === 'mate' && expected.score.value < 0) {
    quarantineReasons.push(`Expected move ${node.expectedMoveUci} enters a forced mate against the trained side`);
  }
  if (expected.centipawnLoss >= CONFIG.quarantineCentipawnLoss) {
    quarantineReasons.push(
      `Expected move ${node.expectedMoveUci} loses ${expected.centipawnLoss} centipawns versus ${root.bestMoveUci}`,
    );
  }
  return {
    id: node.id,
    fen: node.fen,
    expectedMoveUci: node.expectedMoveUci,
    bestMoveUci: root.bestMoveUci,
    bestScore: best.score,
    topVariations: root.variations,
    moves,
    expectedMoveCentipawnLoss: expected.centipawnLoss,
    quarantined: quarantineReasons.length > 0,
    quarantineReasons,
  };
}

export async function analyzeSelectedLines(
  engine: StockfishAnalysisAdapter,
  input: EngineAnalysisInput,
): Promise<AnalyzedLine[]> {
  const selected = selectTopEligibleLines(input.lines);
  return analyzeVerificationLines(engine, selected);
}

export async function analyzeVerificationLines(
  engine: StockfishAnalysisAdapter,
  selected: VerificationLineInput[],
  onLine?: (line: AnalyzedLine) => void,
): Promise<AnalyzedLine[]> {
  const output: AnalyzedLine[] = [];
  for (const line of selected) {
    const nodes: AnalyzedDecisionNode[] = [];
    for (let index = 0; index < line.decisionNodes.length; index += 1) {
      nodes.push(await analyzeDecisionNode(engine, line, index));
    }
    const quarantineReasons = nodes.flatMap((node) =>
      node.quarantineReasons.map((reason) => `${node.id}: ${reason}`),
    );
    const analyzedLine: AnalyzedLine = {
      id: line.id,
      sourceLineId: line.sourceLineId ?? line.id,
      eco: line.eco,
      name: line.name,
      trainedSide: line.trainedSide,
      terminalSampleSize: line.terminalSampleSize,
      quarantined: quarantineReasons.length > 0,
      quarantineReasons,
      nodes,
    };
    output.push(analyzedLine);
    onLine?.(analyzedLine);
  }
  return output;
}

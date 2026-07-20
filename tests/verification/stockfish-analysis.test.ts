import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EnginePrincipalVariation, VerificationLineInput } from '../../src/data/verification/contracts.ts';
import {
  analyzeDecisionNode,
  centipawnLoss,
  classifyAlternative,
  selectTopEligibleLines,
  type StockfishAnalysisAdapter,
} from '../../scripts/verification/lib/stockfish-analysis.ts';

function variation(
  multipv: number,
  move: string,
  score: number,
): EnginePrincipalVariation {
  return {
    multipv,
    depth: 20,
    selectiveDepth: 30,
    nodes: 250_000,
    score: { kind: 'centipawn', value: score },
    bound: 'exact',
    movesUci: [move],
  };
}

function sampleLine(overrides: Partial<VerificationLineInput> = {}): VerificationLineInput {
  return {
    id: 'line-1',
    eco: 'B00',
    name: 'Sample',
    trainedSide: 'white',
    terminalSampleSize: 1_000,
    drillEligible: true,
    preexistingQuarantineReasons: [],
    decisionNodes: [
      {
        id: 'start',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        expectedMoveUci: 'd2d4',
        candidateMoves: [
          { moveUci: 'd2d4', sampleSize: 500, acceptedBookTransposition: false },
          { moveUci: 'e2e4', sampleSize: 600, acceptedBookTransposition: false },
        ],
      },
    ],
    ...overrides,
  };
}

describe('Stockfish verification policy', () => {
  it('keeps only the top three eligible lines in each ECO', () => {
    const lines = [700, 900, 800, 600, 499].map((sampleSize, index) =>
      sampleLine({ id: `line-${index}`, terminalSampleSize: sampleSize }),
    );
    lines.push(sampleLine({ id: 'other-eco', eco: 'C20', terminalSampleSize: 500 }));
    assert.deepEqual(selectTopEligibleLines(lines).map((line) => line.id), [
      'line-1',
      'line-2',
      'line-0',
      'other-eco',
    ]);
  });

  it('selects three source lines per ECO while retaining both color variants', () => {
    const variants = [900, 800, 700, 600].flatMap((sampleSize, index) => [
      sampleLine({
        id: `source-${index}:white`,
        sourceLineId: `source-${index}`,
        trainedSide: 'white',
        terminalSampleSize: sampleSize,
      }),
      sampleLine({
        id: `source-${index}:black`,
        sourceLineId: `source-${index}`,
        trainedSide: 'black',
        terminalSampleSize: sampleSize,
      }),
    ]);
    const selected = selectTopEligibleLines(variants);
    assert.deepEqual([...new Set(selected.map((line) => line.sourceLineId))], [
      'source-0',
      'source-1',
      'source-2',
    ]);
    assert.equal(selected.length, 6);
  });

  it('applies the exact playable/inaccuracy/mistake boundaries and sample floor', () => {
    const best = { kind: 'centipawn' as const, value: 40 };
    const classify = (loss: number, sampleSize = 100) =>
      classifyAlternative({
        expected: false,
        acceptedBookTransposition: false,
        sampleSize,
        bestScore: best,
        candidateScore: { kind: 'centipawn', value: best.value - loss },
        exactEngineScore: true,
      }).classification;
    assert.equal(classify(50), 'playable');
    assert.equal(classify(51), 'inaccuracy');
    assert.equal(classify(99), 'inaccuracy');
    assert.equal(classify(100), 'mistake');
    assert.equal(classify(0, 99), 'unverified_deviation');
  });

  it('orders mate scores without converting them to fabricated centipawn evaluations', () => {
    assert.equal(
      centipawnLoss(
        { kind: 'mate', value: 2 },
        { kind: 'mate', value: 5 },
      ),
      3_000,
    );
    assert.equal(
      classifyAlternative({
        expected: false,
        acceptedBookTransposition: false,
        sampleSize: 100,
        bestScore: { kind: 'centipawn', value: 0 },
        candidateScore: { kind: 'mate', value: -5 },
        exactEngineScore: true,
      }).classification,
      'mistake',
    );
  });

  it('quarantines a line when its expected move loses at least 100 centipawns', async () => {
    const calls: Array<{ searchMoveUci?: string }> = [];
    const engine: StockfishAnalysisAdapter = {
      setMultiPv: () => undefined,
      analyze: async (options) => {
        calls.push({ ...(options.searchMoveUci === undefined ? {} : { searchMoveUci: options.searchMoveUci }) });
        return {
          bestMoveUci: 'e2e4',
          variations: [variation(1, 'e2e4', 30), variation(2, 'd2d4', -70)],
        };
      },
    };
    const result = await analyzeDecisionNode(engine, sampleLine(), 0);
    assert.equal(result.quarantined, true);
    assert.equal(result.expectedMoveCentipawnLoss, 100);
    assert.match(result.quarantineReasons[0] ?? '', /loses 100 centipawns/u);
    assert.equal(calls.length, 1);
  });

  it('rejects a decision node that is not the trained side turn', async () => {
    const engine: StockfishAnalysisAdapter = {
      setMultiPv: () => undefined,
      analyze: async () => ({ bestMoveUci: 'e7e5', variations: [variation(1, 'e7e5', 0)] }),
    };
    const wrongTurn = sampleLine({
      decisionNodes: [
        {
          id: 'black-turn',
          fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
          expectedMoveUci: 'e7e5',
          candidateMoves: [{ moveUci: 'e7e5', sampleSize: 500, acceptedBookTransposition: false }],
        },
      ],
    });
    await assert.rejects(analyzeDecisionNode(engine, wrongTurn, 0), /not the trained side's turn/u);
  });
});

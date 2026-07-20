import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { latestUciVariations, parseUciInfo } from '../../scripts/verification/lib/uci-engine.ts';

describe('UCI output parser', () => {
  it('parses exact MultiPV centipawn output', () => {
    assert.deepEqual(
      parseUciInfo(
        'info depth 18 seldepth 25 multipv 2 score cp -34 nodes 250000 nps 1000000 time 250 pv d2d4 d7d5 c2c4',
      ),
      {
        multipv: 2,
        depth: 18,
        selectiveDepth: 25,
        nodes: 250000,
        score: { kind: 'centipawn', value: -34 },
        bound: 'exact',
        movesUci: ['d2d4', 'd7d5', 'c2c4'],
      },
    );
  });

  it('preserves mate scores and bounds', () => {
    const parsed = parseUciInfo('info depth 30 score mate -3 upperbound pv h7h8q');
    assert.deepEqual(parsed?.score, { kind: 'mate', value: -3 });
    assert.equal(parsed?.bound, 'upper');
  });

  it('ignores status lines without a scored principal variation', () => {
    assert.equal(parseUciInfo('info depth 20 currmove e2e4 currmovenumber 1'), null);
  });

  it('does not let a later aspiration bound overwrite an exact MultiPV score', () => {
    const variations = latestUciVariations([
      'info depth 16 multipv 1 score cp 22 nodes 200000 pv e2e4 e7e5',
      'info depth 17 multipv 1 score cp 30 lowerbound nodes 250000 pv e2e4 e7e5',
      'info depth 16 multipv 2 score cp 15 nodes 200000 pv d2d4 d7d5',
    ]);
    assert.deepEqual(
      variations.map((variation) => ({ multipv: variation.multipv, score: variation.score, bound: variation.bound })),
      [
        { multipv: 1, score: { kind: 'centipawn', value: 22 }, bound: 'exact' },
        { multipv: 2, score: { kind: 'centipawn', value: 15 }, bound: 'exact' },
      ],
    );
  });
});

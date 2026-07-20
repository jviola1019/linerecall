import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CrosscheckLineInput } from '../../src/data/verification/contracts.ts';
import {
  buildScidPositionIndex,
  crosscheckLine,
  parseScidEco,
  selectStratifiedLines,
} from '../../scripts/verification/lib/scid-crosscheck.ts';

const fixturePath = resolve('tests/verification/fixtures/scid-mini.eco');

async function fixtureIndex() {
  const parsed = parseScidEco(await readFile(fixturePath, 'utf8'));
  assert.deepEqual(parsed.failures, []);
  return { parsed, index: buildScidPositionIndex(parsed.entries) };
}

function line(overrides: Partial<CrosscheckLineInput> = {}): CrosscheckLineInput {
  return {
    id: 'sicilian',
    eco: 'B20',
    name: 'Sicilian Defense',
    drillEligible: true,
    quarantined: false,
    movesSan: ['e4', 'c5'],
    ...overrides,
  } as CrosscheckLineInput;
}

describe('Scid ECO parser and cross-check', () => {
  it('parses inline and multiline entries into terminal positions', async () => {
    const { parsed } = await fixtureIndex();
    assert.equal(parsed.entries.length, 7);
    assert.equal(parsed.entries.find((entry) => entry.code === 'E00a')?.plyCount, 5);
  });

  it('distinguishes exact, naming, missing, and base-code discrepancies', async () => {
    const { index } = await fixtureIndex();
    assert.deepEqual(
      (({ status, quarantined }) => ({ status, quarantined }))(crosscheckLine(line(), index)),
      { status: 'match', quarantined: false },
    );
    assert.deepEqual(
      (({ status, quarantined }) => ({ status, quarantined }))(
        crosscheckLine(line({ name: 'Modern Sicilian label' }), index),
      ),
      { status: 'naming_difference', quarantined: false },
    );
    assert.deepEqual(
      (({ status, quarantined }) => ({ status, quarantined }))(
        crosscheckLine(line({ id: 'missing', eco: 'A00', name: 'Anderssen', movesSan: ['a3'] }), index),
      ),
      { status: 'missing_oracle_entry', quarantined: false },
    );
    assert.deepEqual(
      (({ status, quarantined }) => ({ status, quarantined }))(
        crosscheckLine(line({ eco: 'B21' }), index),
      ),
      { status: 'base_eco_mismatch', quarantined: true },
    );
  });

  it('recognizes an oracle position reached by a different move order', async () => {
    const { index } = await fixtureIndex();
    const result = crosscheckLine(
      line({
        id: 'reti-transposition',
        eco: 'A04',
        name: 'Reti Opening',
        movesSan: ['g3', 'd5', 'Nf3'],
      }),
      index,
    );
    assert.deepEqual(
      { status: result.status, quarantined: result.quarantined, deepestMatchedPly: result.deepestMatchedPly },
      { status: 'match', quarantined: false, deepestMatchedPly: 3 },
    );
  });

  it('selects a deterministic, balanced sample from eligible volumes', () => {
    const candidates: CrosscheckLineInput[] = [];
    for (const volume of ['A', 'B', 'C', 'D', 'E']) {
      for (let index = 0; index < 3; index += 1) {
        candidates.push(
          line({
            id: `${volume}-${index}`,
            eco: `${volume}00`,
            name: `${volume} line ${index}`,
            movesSan: ['e4'],
          }),
        );
      }
    }
    const first = selectStratifiedLines(candidates, 7, 'fixed-seed');
    const second = selectStratifiedLines([...candidates].reverse(), 7, 'fixed-seed');
    assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
    assert.deepEqual(first.map((item) => item.eco[0]), ['A', 'B', 'C', 'D', 'E', 'A', 'B']);
  });
});

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ScidManifestSchema, StockfishManifestSchema } from '../../scripts/verification/lib/manifest.ts';
import { selectStockfishArtifact } from '../../scripts/verification/provision-stockfish.ts';

describe('verification source manifests', () => {
  it('pins parseable Stockfish 18 and Scid metadata with checksums and licenses', async () => {
    const stockfish = StockfishManifestSchema.parse(
      JSON.parse(await readFile(resolve('data/manifests/stockfish-18.source.json'), 'utf8')),
    );
    const scid = ScidManifestSchema.parse(
      JSON.parse(await readFile(resolve('data/manifests/scid.source.json'), 'utf8')),
    );
    assert.equal(stockfish.releaseCommit.length, 40);
    assert.equal(stockfish.approval.status, 'approved');
    assert.equal(stockfish.license.spdx, 'GPL-3.0-only');
    assert.deepEqual(stockfish.analysisConfiguration, {
      threads: 1,
      hashMb: 128,
      multiPv: 5,
      nodes: 250000,
    });
    assert.equal(scid.license.spdx, 'GPL-2.0-only');
    assert.equal(scid.approval.status, 'approved');
    assert.equal(scid.sha256.length, 64);
  });

  it('selects only a pinned host artifact and fails closed otherwise', async () => {
    const stockfish = StockfishManifestSchema.parse(
      JSON.parse(await readFile(resolve('data/manifests/stockfish-18.source.json'), 'utf8')),
    );
    assert.equal(selectStockfishArtifact(stockfish.artifacts, 'win32', 'x64').fileName,
      'stockfish-windows-x86-64.zip',
    );
    assert.throws(
      () => selectStockfishArtifact(stockfish.artifacts, 'linux', 'arm64'),
      /No pinned Stockfish 18 artifact/u,
    );
  });
});

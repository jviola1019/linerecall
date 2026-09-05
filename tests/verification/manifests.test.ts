import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ScidManifestSchema,
  StockfishManifestSchema,
  assertScidProvisionMatchesManifest,
  assertStockfishProvisionMatchesManifest,
} from '../../scripts/verification/lib/manifest.ts';
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

  it('binds a provision receipt to the complete pinned archive tuple and verified digest', async () => {
    const stockfish = StockfishManifestSchema.parse(
      JSON.parse(await readFile(resolve('data/manifests/stockfish-18.source.json'), 'utf8')),
    );
    const artifact = stockfish.artifacts[0]!;
    const receipt = {
      schemaVersion: 1,
      provisionedAt: '2026-08-27T12:00:00.000Z',
      releaseTag: stockfish.releaseTag,
      releaseCommit: stockfish.releaseCommit,
      license: stockfish.license,
      artifact: {
        ...artifact,
        archiveSha256Verified: artifact.sha256,
        archiveReused: false,
      },
      executable: {
        path: '.cache/stockfish/sf_18/extracted/win32-x64/stockfish-windows-x86-64.exe',
        fileName: 'stockfish-windows-x86-64.exe',
        sha256: 'a'.repeat(64),
      },
    };
    assert.equal(assertStockfishProvisionMatchesManifest(stockfish, receipt).artifact.sha256, artifact.sha256);
    assert.throws(
      () => assertStockfishProvisionMatchesManifest(stockfish, {
        ...receipt,
        artifact: { ...receipt.artifact, url: 'https://example.invalid/stockfish.zip' },
      }),
      /artifact tuple/u,
    );
    assert.throws(
      () => assertStockfishProvisionMatchesManifest(stockfish, {
        ...receipt,
        artifact: { ...receipt.artifact, archiveSha256Verified: 'b'.repeat(64) },
      }),
      /pinned archive digest/u,
    );
  });

  it('binds the Scid provision receipt to the complete pinned oracle tuple', async () => {
    const scid = ScidManifestSchema.parse(
      JSON.parse(await readFile(resolve('data/manifests/scid.source.json'), 'utf8')),
    );
    const receipt = {
      schemaVersion: 1,
      provisionedAt: '2026-08-27T12:00:00.000Z',
      repositoryCommit: scid.repositoryCommit,
      file: { path: scid.filePath, size: scid.size, sha256: scid.sha256, reused: false },
      license: scid.license,
    };
    assert.equal(assertScidProvisionMatchesManifest(scid, receipt).file.sha256, scid.sha256);
    assert.throws(
      () => assertScidProvisionMatchesManifest(scid, { ...receipt, file: { ...receipt.file, sha256: '0'.repeat(64) } }),
      /pinned oracle manifest/u,
    );
    assert.throws(
      () => assertScidProvisionMatchesManifest(scid, { ...receipt, repositoryCommit: 'a'.repeat(40) }),
      /pinned oracle manifest/u,
    );
  });
});

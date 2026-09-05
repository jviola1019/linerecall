import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { Chess } from "chess.js";
import { TaxonomySourceManifestSchema, type TaxonomySourceManifest } from "../../src/data/taxonomy-schema.ts";
import {
  assertManifestApproved,
  buildBroadcastTargetIndex,
  normalizeTaxonomyRow,
  normalizedEpd,
  parseTaxonomyTsv,
  verifySourceBytes,
  type TaxonomySourceRow,
} from "../../scripts/data/ingest-taxonomy.ts";

async function loadManifest(): Promise<TaxonomySourceManifest> {
  return TaxonomySourceManifestSchema.parse(
    JSON.parse(await readFile("data/manifests/taxonomy.source.json", "utf8")),
  );
}

function row(
  pgn: string,
  name = "Test Opening",
  eco = "A00",
  sourceRow = 2,
): TaxonomySourceRow {
  return {
    eco,
    name,
    pgn,
    sourceFile: "a.tsv",
    sourceRow,
    sourceSha256: "41722fa3d44f294357326fe2ca1b956d9e56490b30efcfa68db61114c9df7e10",
  };
}

describe("taxonomy source approval and integrity", () => {
  it("pins an approved CC0 source with complete A-E totals", async () => {
    const manifest = await loadManifest();
    assert.equal(manifest.approval.status, "approved");
    assert.equal(manifest.license.spdxId, "CC0-1.0");
    assert.equal(manifest.files.reduce((sum, file) => sum + file.rows, 0), 3_790);
    assert.deepEqual(manifest.files.map(({ volume }) => volume), ["A", "B", "C", "D", "E"]);
  });

  it("fails closed before ingestion when approval is not current", async () => {
    const pending = structuredClone(await loadManifest());
    pending.approval.status = "pending";
    assert.throws(() => assertManifestApproved(pending), /not approved/u);
  });

  it("checks both byte length and SHA-256", () => {
    const bytes = Buffer.from("abc", "utf8");
    assert.doesNotThrow(() => verifySourceBytes(bytes, {
      path: "fixture.tsv",
      bytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    }));
    assert.throws(() => verifySourceBytes(bytes, {
      path: "fixture.tsv",
      bytes: 3,
      sha256: "0".repeat(64),
    }), /SHA-256 mismatch/u);
    assert.throws(() => verifySourceBytes(bytes, {
      path: "fixture.tsv",
      bytes: 4,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    }), /expected 4 bytes/u);
  });
});

describe("taxonomy TSV parsing and chess normalization", () => {
  it("parses only the exact approved three-column format", () => {
    const source = { path: "a.tsv", rows: 1, volume: "A", sha256: "0".repeat(64) };
    assert.deepEqual(parseTaxonomyTsv("eco\tname\tpgn\nA00\tTest Opening\t1. e4\n", source), [{
      eco: "A00",
      name: "Test Opening",
      pgn: "1. e4",
      sourceFile: "a.tsv",
      sourceRow: 2,
      sourceSha256: "0".repeat(64),
    }]);
    assert.throws(() => parseTaxonomyTsv("eco\tname\tpgn\r\nA00\tTest\t1. e4\r\n", source), /only LF/u);
    assert.throws(() => parseTaxonomyTsv("eco\tname\tpgn\nB00\tWrong volume\t1. e4\n", source), /does not belong/u);
    assert.throws(() => parseTaxonomyTsv("eco\tname\tpgn\nA00\t<script>\t1. e4\textra\n", source), /exactly three/u);
  });

  it("uses chess.js to derive UCI, position path, and legal normalized EPD", async () => {
    const manifest = await loadManifest();
    const line = normalizeTaxonomyRow(row("1. e4 e5 2. Nf3 Nc6 3. Bb5", "Ruy Lopez"), manifest, "2026-07-11T00:00:00.000Z");
    assert.deepEqual(line.uci, ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]);
    assert.equal(line.plyCount, 5);
    assert.equal(line.positions.length, 6);
    assert.equal(line.positions[0]!.moveFromPrevious, undefined);
    assert.equal(line.positions.at(-1)!.epd, line.epd);
    assert.match(line.epd, / b KQkq -$/u);
    assert.throws(
      () => normalizeTaxonomyRow(row("1. e4 e5 2. Bh6"), manifest, "2026-07-11T00:00:00.000Z"),
      /illegal or malformed PGN/u,
    );
  });

  it("keeps an en-passant square only when a legal capture exists", () => {
    const noCapture = new Chess();
    noCapture.move("e4");
    assert.match(normalizedEpd(noCapture.fen({ forceEnpassantSquare: true })), / w | b /u);
    assert.equal(normalizedEpd(noCapture.fen({ forceEnpassantSquare: true })).split(" ")[3], "-");

    const legalCapture = new Chess();
    legalCapture.loadPgn("1. e4 Nf6 2. e5 d5", { strict: true });
    assert.equal(normalizedEpd(legalCapture.fen({ forceEnpassantSquare: true })).split(" ")[3], "d6");
  });
});

describe("broadcast target adapter", () => {
  it("merges transposed positions without merging line identity", async () => {
    const manifest = await loadManifest();
    const pulledAt = "2026-07-11T00:00:00.000Z";
    const first = normalizeTaxonomyRow(row("1. Nf3 d5 2. d4 Nf6", "Transposition One", "A06", 2), manifest, pulledAt);
    const second = normalizeTaxonomyRow(row("1. d4 Nf6 2. Nf3 d5", "Transposition Two", "A45", 3), manifest, pulledAt);
    assert.equal(first.epd, second.epd);

    const index = buildBroadcastTargetIndex([first, second], manifest.source.commit);
    const terminal = index.targets.find(({ epd }) => epd === first.epd);
    assert.deepEqual(terminal?.lineIds, [first.id, second.id].sort());
    assert.deepEqual(terminal?.terminalLineIds, [first.id, second.id].sort());
    assert.equal(index.maxPly, 4);
  });
});

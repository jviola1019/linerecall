import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Chess } from "chess.js";
import {
  BroadcastTargetIndexV1Schema,
  NormalizedTaxonomyLineSchema,
  TaxonomyCatalogSchema,
  TaxonomyPartitionSchema,
  TaxonomySearchIndexSchema,
  TaxonomySourceManifestSchema,
  type BroadcastTargetIndexV1,
  type NormalizedTaxonomyLine,
  type TaxonomyCatalog,
  type TaxonomySearchIndex,
  type TaxonomySourceManifest,
} from "../../src/data/taxonomy-schema.ts";

const DEFAULT_MANIFEST = "data/manifests/taxonomy.source.json";
const DEFAULT_OUTPUT = "data/generated/taxonomy";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export interface TaxonomySourceRow {
  eco: string;
  name: string;
  pgn: string;
  sourceFile: string;
  sourceRow: number;
  sourceSha256: string;
}

interface CliOptions {
  manifestPath: string;
  outputDirectory: string;
  offlineSourceDirectory?: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8Bytes(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function assertManifestApproved(manifest: TaxonomySourceManifest): void {
  if (manifest.approval.status !== "approved") {
    throw new Error(`Taxonomy ingestion is not approved (status: ${manifest.approval.status})`);
  }
  const rights = manifest.license.permissions;
  if (!rights.download || !rights.transform || !rights.redistribute) {
    throw new Error("Taxonomy license approval does not cover download, transformation, and redistribution");
  }
}

export async function loadApprovedManifest(path: string): Promise<TaxonomySourceManifest> {
  let untrusted: unknown;
  try {
    untrusted = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read taxonomy source manifest at ${path}`, { cause: error });
  }
  const manifest = TaxonomySourceManifestSchema.parse(untrusted);
  assertManifestApproved(manifest);
  return manifest;
}

export function verifySourceBytes(
  bytes: Uint8Array,
  expected: { bytes: number; sha256: string; path: string },
): void {
  if (bytes.byteLength !== expected.bytes) {
    throw new Error(`${expected.path}: expected ${expected.bytes} bytes, received ${bytes.byteLength}`);
  }
  const actualDigest = sha256(bytes);
  if (actualDigest !== expected.sha256) {
    throw new Error(`${expected.path}: SHA-256 mismatch (expected ${expected.sha256}, received ${actualDigest})`);
  }
}

async function acquireSourceFile(
  source: { path: string; url: string; bytes: number; sha256: string },
  offlineSourceDirectory?: string,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (offlineSourceDirectory !== undefined) {
    const localPath = resolve(offlineSourceDirectory, source.path);
    const localRoot = resolve(offlineSourceDirectory);
    const localRelative = relative(localRoot, localPath);
    if (localRelative.startsWith("..") || isAbsolute(localRelative)) {
      throw new Error(`Unsafe source path: ${source.path}`);
    }
    bytes = await readFile(localPath);
  } else {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30_000);
    try {
      const response = await fetch(source.url, {
        redirect: "follow",
        signal: abort.signal,
        headers: { "user-agent": "LineRecall-taxonomy-ingestion/1" },
      });
      if (!response.ok) {
        throw new Error(`${source.path}: HTTP ${response.status} ${response.statusText}`);
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  }
  verifySourceBytes(bytes, source);
  return bytes;
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${path}: source is not valid UTF-8`, { cause: error });
  }
}

export function parseTaxonomyTsv(
  text: string,
  source: { path: string; rows: number; sha256: string; volume: string },
): TaxonomySourceRow[] {
  if (text.includes("\r")) {
    throw new Error(`${source.path}: only LF line endings are approved`);
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines[0] !== "eco\tname\tpgn") {
    throw new Error(`${source.path}: expected exact TSV header eco\\tname\\tpgn`);
  }
  const rows = lines.slice(1).map((line, offset) => {
    const rowNumber = offset + 2;
    if (line.length === 0) {
      throw new Error(`${source.path}:${rowNumber}: unexpected blank row`);
    }
    const columns = line.split("\t");
    if (columns.length !== 3) {
      throw new Error(`${source.path}:${rowNumber}: expected exactly three tab-separated columns`);
    }
    const [eco, name, pgn] = columns;
    if (eco === undefined || name === undefined || pgn === undefined) {
      throw new Error(`${source.path}:${rowNumber}: missing required column`);
    }
    if (!new RegExp(`^${source.volume}[0-9]{2}$`, "u").test(eco)) {
      throw new Error(`${source.path}:${rowNumber}: ECO ${eco} does not belong to volume ${source.volume}`);
    }
    if (name.trim() !== name || name.length === 0 || name.length > 256 || CONTROL_CHARACTER.test(name)) {
      throw new Error(`${source.path}:${rowNumber}: invalid opening name`);
    }
    if (pgn.trim() !== pgn || pgn.length === 0 || pgn.length > 4096 || CONTROL_CHARACTER.test(pgn)) {
      throw new Error(`${source.path}:${rowNumber}: invalid PGN movetext`);
    }
    return { eco, name, pgn, sourceFile: source.path, sourceRow: rowNumber, sourceSha256: source.sha256 };
  });
  if (rows.length !== source.rows) {
    throw new Error(`${source.path}: expected ${source.rows} rows, parsed ${rows.length}`);
  }
  return rows;
}

export function normalizedEpd(fen: string): string {
  const normalizedFen = new Chess(fen).fen();
  const fields = normalizedFen.split(" ");
  if (fields.length !== 6) {
    throw new Error(`Unexpected FEN field count: ${normalizedFen}`);
  }
  return fields.slice(0, 4).join(" ");
}

function uciFor(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

export function normalizeTaxonomyRow(
  row: TaxonomySourceRow,
  manifest: TaxonomySourceManifest,
  pulledAt: string,
): NormalizedTaxonomyLine {
  const chess = new Chess();
  try {
    chess.loadPgn(row.pgn, { strict: true });
  } catch (error) {
    throw new Error(`${row.sourceFile}:${row.sourceRow}: illegal or malformed PGN`, { cause: error });
  }
  const moves = chess.history({ verbose: true });
  if (moves.length === 0 || moves.length > 200) {
    throw new Error(`${row.sourceFile}:${row.sourceRow}: PGN must contain 1-200 legal plies`);
  }
  const uci = moves.map(uciFor);
  const fens = [moves[0]!.before, ...moves.map(({ after }) => after)];
  const positions = fens.map((fen, ply) => {
    const fields = fen.split(" ");
    const sideToMove = fields[1] === "w" ? "white" as const : "black" as const;
    return {
      ply,
      epd: normalizedEpd(fen),
      sideToMove,
      ...(ply > 0 ? { moveFromPrevious: uci[ply - 1]! } : {}),
    };
  });
  const id = `tax_${sha256(`${row.eco}\0${row.name}\0${row.pgn}`).slice(0, 24)}`;
  return NormalizedTaxonomyLineSchema.parse({
    id,
    eco: row.eco,
    volume: row.eco[0],
    name: row.name,
    pgn: row.pgn,
    uci,
    epd: positions.at(-1)!.epd,
    plyCount: moves.length,
    positions,
    provenance: {
      sourceId: manifest.source.id,
      sourceCommit: manifest.source.commit,
      sourceFile: row.sourceFile,
      sourceRow: row.sourceRow,
      sourceSha256: row.sourceSha256,
      licenseSpdxId: manifest.license.spdxId,
      pulledAt,
    },
  });
}

function allExpectedEcoCodes(): Set<string> {
  const expected = new Set<string>();
  for (const volume of ["A", "B", "C", "D", "E"] as const) {
    for (let number = 0; number < 100; number += 1) expected.add(`${volume}${number.toString().padStart(2, "0")}`);
  }
  return expected;
}

export function buildBroadcastTargetIndex(
  lines: readonly NormalizedTaxonomyLine[],
  taxonomyCommit: string,
): BroadcastTargetIndexV1 {
  const targets = new Map<string, { lineIds: Set<string>; terminalLineIds: Set<string> }>();
  let maxPly = 0;
  for (const line of lines) {
    maxPly = Math.max(maxPly, line.plyCount);
    for (const position of line.positions) {
      const target = targets.get(position.epd) ?? { lineIds: new Set<string>(), terminalLineIds: new Set<string>() };
      target.lineIds.add(line.id);
      if (position.ply === line.plyCount) target.terminalLineIds.add(line.id);
      targets.set(position.epd, target);
    }
  }
  return BroadcastTargetIndexV1Schema.parse({
    schemaVersion: 1,
    taxonomyCommit,
    maxPly,
    targets: [...targets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([epd, target]) => ({
      epd,
      lineIds: [...target.lineIds].sort(),
      ...(target.terminalLineIds.size > 0 ? { terminalLineIds: [...target.terminalLineIds].sort() } : {}),
    })),
  });
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function assertSafeOutputDirectory(path: string): string {
  const workspace = resolve(process.cwd());
  const target = resolve(path);
  const child = relative(workspace, target);
  if (child === "" || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`Output directory must be a child of the workspace: ${target}`);
  }
  return target;
}

async function replaceDirectory(staging: string, target: string): Promise<void> {
  const backup = `${target}.previous-${process.pid}-${Date.now()}`;
  const hadTarget = await pathExists(target);
  if (hadTarget) await rename(target, backup);
  try {
    await rename(staging, target);
    if (hadTarget) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadTarget && !(await pathExists(target))) await rename(backup, target);
    throw error;
  }
}

export async function ingestTaxonomy(options: CliOptions): Promise<{ lines: number; ecoCodes: number; outputDirectory: string }> {
  // This approval gate intentionally occurs before the first source read or fetch.
  const manifest = await loadApprovedManifest(resolve(options.manifestPath));
  const pulledAt = new Date().toISOString();

  const licenseBytes = await acquireSourceFile(manifest.license.sourceFile, options.offlineSourceDirectory);
  const licenseText = decodeUtf8(licenseBytes, manifest.license.sourceFile.path);
  if (!licenseText.includes("CC0 1.0 Universal") && !licenseText.includes("CC0 1.0 UNIVERSAL")) {
    throw new Error("Pinned license file does not identify CC0 1.0 Universal");
  }

  const rowGroups = await Promise.all(manifest.files.map(async (source) => {
    const bytes = await acquireSourceFile(source, options.offlineSourceDirectory);
    return parseTaxonomyTsv(decodeUtf8(bytes, source.path), source);
  }));
  const rows = rowGroups.flat();
  if (rows.length !== manifest.format.expectedRows) throw new Error("Combined row count does not match manifest");

  const lines = rows.map((row) => normalizeTaxonomyRow(row, manifest, pulledAt));
  const ids = new Set(lines.map(({ id }) => id));
  if (ids.size !== lines.length) throw new Error("Duplicate taxonomy line content or stable ID collision detected");
  const actualEcoCodes = new Set(lines.map(({ eco }) => eco));
  const expectedEcoCodes = allExpectedEcoCodes();
  if (actualEcoCodes.size !== manifest.format.expectedEcoCodes || [...expectedEcoCodes].some((eco) => !actualEcoCodes.has(eco))) {
    throw new Error(`Expected complete A00-E99 coverage; found ${actualEcoCodes.size} ECO codes`);
  }

  const outputDirectory = assertSafeOutputDirectory(options.outputDirectory);
  const staging = `${outputDirectory}.staging-${process.pid}-${Date.now()}`;
  await mkdir(join(staging, "partitions"), { recursive: true });
  try {
    const catalogEntries: TaxonomyCatalog["entries"] = [];
    for (const eco of [...actualEcoCodes].sort()) {
      const partitionLines = lines.filter((line) => line.eco === eco).sort((left, right) => left.name.localeCompare(right.name) || left.pgn.localeCompare(right.pgn));
      const partition = TaxonomyPartitionSchema.parse({ schemaVersion: 1, eco, generatedAt: pulledAt, taxonomyCommit: manifest.source.commit, lines: partitionLines });
      const json = stableJson(partition);
      const partitionPath = `partitions/${eco}.json`;
      await writeFile(join(staging, partitionPath), json, "utf8");
      catalogEntries.push({
        eco,
        volume: eco[0] as "A" | "B" | "C" | "D" | "E",
        lineCount: partitionLines.length,
        names: [...new Set(partitionLines.map(({ name }) => name))].sort(),
        partitionPath,
        bytes: utf8Bytes(json).byteLength,
        sha256: sha256(json),
      });
    }

    const catalog = TaxonomyCatalogSchema.parse({
      schemaVersion: 1,
      generatedAt: pulledAt,
      taxonomyCommit: manifest.source.commit,
      sourceLicense: manifest.license.spdxId,
      totalLines: lines.length,
      ecoCodeCount: actualEcoCodes.size,
      entries: catalogEntries,
    });
    const searchIndex: TaxonomySearchIndex = TaxonomySearchIndexSchema.parse({
      schemaVersion: 1,
      generatedAt: pulledAt,
      taxonomyCommit: manifest.source.commit,
      entries: lines.map(({ id, eco, name, pgn, uci, epd }) => ({ id, eco, name, pgn, uci, epd })),
    });
    const targetIndex = buildBroadcastTargetIndex(lines, manifest.source.commit);
    const provenance = {
      schemaVersion: 1,
      generatedAt: pulledAt,
      manifestPath: relative(process.cwd(), resolve(options.manifestPath)).replaceAll("\\", "/"),
      manifestSha256: sha256(await readFile(resolve(options.manifestPath))),
      source: manifest.source,
      license: manifest.license,
      approval: manifest.approval,
      files: manifest.files,
      totals: { lines: lines.length, ecoCodes: actualEcoCodes.size, uniquePositions: targetIndex.targets.length, maxPly: targetIndex.maxPly },
    };
    await Promise.all([
      writeFile(join(staging, "catalog.json"), stableJson(catalog), "utf8"),
      writeFile(join(staging, "search-index.json"), stableJson(searchIndex), "utf8"),
      writeFile(join(staging, "broadcast-targets.v1.json"), stableJson(targetIndex), "utf8"),
      writeFile(join(staging, "provenance.json"), stableJson(provenance), "utf8"),
    ]);
    await mkdir(dirname(outputDirectory), { recursive: true });
    await replaceDirectory(staging, outputDirectory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { lines: lines.length, ecoCodes: actualEcoCodes.size, outputDirectory };
}

function parseArguments(argv: readonly string[]): CliOptions {
  const options: CliOptions = { manifestPath: DEFAULT_MANIFEST, outputDirectory: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--manifest" && value !== undefined) options.manifestPath = value;
    else if (flag === "--out-dir" && value !== undefined) options.outputDirectory = value;
    else if (flag === "--offline-source-dir" && value !== undefined) options.offlineSourceDirectory = value;
    else throw new Error(`Unknown or incomplete argument: ${flag ?? ""}`);
    index += 1;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await ingestTaxonomy(parseArguments(argv));
  process.stdout.write(`Ingested ${result.lines} taxonomy lines across ${result.ecoCodes} ECO codes into ${result.outputDirectory}\n`);
}

const entryPoint = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (entryPoint === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

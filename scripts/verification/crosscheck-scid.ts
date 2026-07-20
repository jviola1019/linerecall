import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ScidCrosscheckInputSchema } from '../../src/data/verification/contracts.ts';
import { readJsonFile, sha256File, sha256Text, writeJsonAtomic } from './lib/files.ts';
import { ScidManifestSchema } from './lib/manifest.ts';
import {
  buildScidPositionIndex,
  crosscheckLine,
  parseScidEco,
  selectStratifiedLines,
} from './lib/scid-crosscheck.ts';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_MANIFEST = join(REPOSITORY_ROOT, 'data', 'manifests', 'scid.source.json');
const DEFAULT_SEED = 'linerecall-scid-crosscheck-v1';

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Missing required argument ${name}`);
  return value;
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export async function runScidCrosscheck(options: {
  inputPath: string;
  outputPath: string;
  scidEcoPath: string;
  manifestPath: string;
  maximumSampleSize: number;
  seed: string;
}): Promise<void> {
  const manifest = ScidManifestSchema.parse(await readJsonFile(options.manifestPath));
  const fileStats = await stat(options.scidEcoPath);
  if (fileStats.size !== manifest.size) {
    throw new Error(`Scid oracle size mismatch: expected ${manifest.size}, received ${fileStats.size}`);
  }
  const oracleSha256 = await sha256File(options.scidEcoPath);
  if (oracleSha256 !== manifest.sha256) {
    throw new Error(`Scid oracle SHA-256 mismatch: expected ${manifest.sha256}, received ${oracleSha256}`);
  }
  const rawInput = await readFile(options.inputPath, 'utf8');
  const input = ScidCrosscheckInputSchema.parse(JSON.parse(rawInput) as unknown);
  const oracleSource = await readFile(options.scidEcoPath, 'utf8');
  const parsed = parseScidEco(oracleSource);
  if (parsed.failures.length > 0) {
    const first = parsed.failures[0];
    throw new Error(
      `Scid parser rejected ${parsed.failures.length} entries; first at line ${String(first?.sourceLine)}: ${first?.reason ?? 'unknown error'}`,
    );
  }

  const sampled = selectStratifiedLines(input.lines, options.maximumSampleSize, options.seed);
  const index = buildScidPositionIndex(parsed.entries);
  const results = sampled.map((line) => crosscheckLine(line, index));
  const statuses = {
    match: results.filter((result) => result.status === 'match').length,
    namingDifference: results.filter((result) => result.status === 'naming_difference').length,
    missingOracleEntry: results.filter((result) => result.status === 'missing_oracle_entry').length,
    baseEcoMismatch: results.filter((result) => result.status === 'base_eco_mismatch').length,
    ambiguousOracleBase: results.filter((result) => result.status === 'ambiguous_oracle_base').length,
  };
  await writeJsonAtomic(options.outputPath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    input: {
      path: basename(options.inputPath),
      sha256: sha256Text(rawInput),
      eligibleLineCount: input.lines.filter((line) => line.drillEligible && !line.quarantined).length,
    },
    oracle: {
      repositoryCommit: manifest.repositoryCommit,
      sha256: oracleSha256,
      license: manifest.license,
      parsedEntryCount: parsed.entries.length,
      rejectedEntryCount: parsed.failures.length,
    },
    sampling: {
      algorithm: 'deterministic SHA-256 rank, round-robin across ECO volumes A-E',
      seed: options.seed,
      maximum: options.maximumSampleSize,
      selected: sampled.length,
      byVolume: Object.fromEntries(
        ['A', 'B', 'C', 'D', 'E'].map((volume) => [
          volume,
          sampled.filter((line) => line.eco.startsWith(volume)).length,
        ]),
      ),
    },
    summary: {
      ...statuses,
      quarantinedLineCount: results.filter((result) => result.quarantined).length,
    },
    results,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const maximum = Number(optionalArgument('--max') ?? '250');
  await runScidCrosscheck({
    inputPath: resolve(requiredArgument('--input')),
    outputPath: resolve(requiredArgument('--output')),
    scidEcoPath: resolve(requiredArgument('--scid-eco')),
    manifestPath: resolve(optionalArgument('--manifest') ?? DEFAULT_MANIFEST),
    maximumSampleSize: maximum,
    seed: optionalArgument('--seed') ?? DEFAULT_SEED,
  });
  process.stdout.write('Scid independent cross-check report written.\n');
}

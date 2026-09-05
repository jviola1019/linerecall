import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EngineAnalysisInputSchema,
  STOCKFISH_ANALYSIS_CONFIGURATION as CONFIG,
} from '../../src/data/verification/contracts.ts';
import { readJsonFile, sha256File, sha256Text, writeJsonAtomic } from './lib/files.ts';
import { StockfishManifestSchema, assertStockfishProvisionMatchesManifest } from './lib/manifest.ts';
import { analyzeVerificationLines, selectTopEligibleLines } from './lib/stockfish-analysis.ts';
import { createSharedAnalysisCache, SharedAnalysisCacheAdapter } from './lib/shared-analysis-cache.ts';
import { UciEngine } from './lib/uci-engine.ts';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_MANIFEST = join(REPOSITORY_ROOT, 'data', 'manifests', 'stockfish-18.source.json');

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

function defaultNetworkName(
  optionDefaults: Record<string, string | null>,
  role: 'big' | 'small',
): string | null {
  return optionDefaults[role === 'big' ? 'EvalFile' : 'EvalFileSmall'] ?? null;
}

function assertNetworkNameMatchesHash(name: string | null, sha256: string, role: 'big' | 'small'): void {
  if (name === null) throw new Error(`Stockfish did not report the ${role} NNUE default filename`);
  const match = /^nn-([a-f0-9]{12})\.nnue$/u.exec(name);
  if (match?.[1] === undefined || !sha256.startsWith(match[1])) {
    throw new Error(`${role} NNUE hash ${sha256} does not match its UCI filename ${name}`);
  }
}

export async function runStockfishAnalysis(options: {
  inputPath: string;
  outputPath: string;
  enginePath: string;
  receiptPath: string;
  manifestPath: string;
  concurrency?: number;
}): Promise<void> {
  const rawInput = await readFile(options.inputPath, 'utf8');
  const input = EngineAnalysisInputSchema.parse(JSON.parse(rawInput) as unknown);
  const manifest = StockfishManifestSchema.parse(await readJsonFile(options.manifestPath));
  const receipt = assertStockfishProvisionMatchesManifest(manifest, await readJsonFile(options.receiptPath));
  const binarySha256 = await sha256File(options.enginePath);
  if (binarySha256 !== receipt.executable.sha256) {
    throw new Error('Stockfish executable SHA-256 does not match its verified provision receipt');
  }

  const workingDirectory = await mkdtemp(join(tmpdir(), 'linerecall-stockfish-'));
  const engines: UciEngine[] = [];
  try {
    const selected = selectTopEligibleLines(input.lines);
    const requestedConcurrency = options.concurrency ?? Math.max(1, Math.min(6, availableParallelism() - 1));
    if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 16) {
      throw new Error('Stockfish concurrency must be an integer from 1 through 16');
    }
    const concurrency = Math.max(1, Math.min(requestedConcurrency, selected.length || 1));
    const startedEngines = await Promise.all(
      Array.from({ length: concurrency }, async (_, index) => {
        const directory = join(workingDirectory, `worker-${String(index).padStart(2, '0')}`);
        await mkdir(directory, { recursive: true });
        return UciEngine.start({ executablePath: options.enginePath, workingDirectory: directory });
      }),
    );
    engines.push(...startedEngines.map(({ engine }) => engine));
    const referenceIdentity = startedEngines[0]?.identity;
    if (!referenceIdentity || !/^Stockfish 18(?:\s|$)/u.test(referenceIdentity.name)) {
      throw new Error(`Expected Stockfish 18, received ${referenceIdentity?.name ?? '(missing identity)'}`);
    }
    for (const { identity } of startedEngines) {
      if (
        identity.name !== referenceIdentity.name ||
        identity.author !== referenceIdentity.author ||
        JSON.stringify(identity.optionDefaults) !== JSON.stringify(referenceIdentity.optionDefaults)
      ) {
        throw new Error('Parallel Stockfish processes reported inconsistent identities or option defaults');
      }
    }
    const referenceEngine = engines[0];
    if (!referenceEngine) throw new Error('No Stockfish process was started');
    const exported = await referenceEngine.exportNetworkHashes();
    const nnue = exported.map((network) => {
      const defaultFileName = defaultNetworkName(referenceIdentity.optionDefaults, network.role);
      assertNetworkNameMatchesHash(defaultFileName, network.sha256, network.role);
      return { role: network.role, defaultFileName, sha256: network.sha256 };
    });

    const assignments: Array<{ cost: number; lines: typeof selected }> = Array.from(
      { length: concurrency },
      () => ({ cost: 0, lines: [] }),
    );
    const estimatedCost = (line: (typeof selected)[number]): number =>
      line.decisionNodes.reduce(
        (sum, node) =>
          sum +
          1 +
          node.candidateMoves.filter(
            (candidate) =>
              candidate.sampleSize >= CONFIG.independentlyAnalyzedAlternativeMinimumSampleSize,
          ).length,
        0,
      );
    for (const line of [...selected].sort((left, right) =>
      estimatedCost(right) - estimatedCost(left) || left.id.localeCompare(right.id, 'en'),
    )) {
      assignments.sort((left, right) => left.cost - right.cost);
      const assignment = assignments[0];
      if (!assignment) throw new Error('No Stockfish assignment slot is available');
      assignment.lines.push(line);
      assignment.cost += estimatedCost(line);
    }
    let completedLines = 0;
    const sharedAnalysis = createSharedAnalysisCache();
    const analysisAdapters = engines.map((engine) => new SharedAnalysisCacheAdapter(engine, sharedAnalysis));
    let abortPromise: Promise<void> | null = null;
    const abortAll = (): Promise<void> => {
      abortPromise ??= Promise.allSettled(engines.map((engine) => engine.close())).then(() => undefined);
      return abortPromise;
    };
    const settledGroups = await Promise.allSettled(
      assignments.map((assignment, index) =>
        analyzeVerificationLines(analysisAdapters[index]!, assignment.lines, (line) => {
          completedLines += 1;
          if (completedLines === selected.length || completedLines % 5 === 0) {
            process.stdout.write(
              `analyzed ${completedLines}/${selected.length} variants; latest ${line.id}\n`,
            );
          }
        }).catch(async (error: unknown) => {
          await abortAll();
          throw error;
        }),
      ),
    );
    const failedGroup = settledGroups.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failedGroup) throw failedGroup.reason;
    const analyzedGroups = settledGroups.map((result) => {
      if (result.status !== 'fulfilled') throw new Error('Unreachable rejected engine group');
      return result.value;
    });
    const selectedOrder = new Map(selected.map((line, index) => [line.id, index]));
    const lines = analyzedGroups
      .flat()
      .sort((left, right) => (selectedOrder.get(left.id) ?? 0) - (selectedOrder.get(right.id) ?? 0));
    const selectedCount = selected.length;
    await writeJsonAtomic(options.outputPath, {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      input: {
        path: basename(options.inputPath),
        sha256: sha256Text(rawInput),
        lineCount: input.lines.length,
      },
      configuration: {
        ...CONFIG,
        releaseCommit: manifest.releaseCommit,
      },
      engine: {
        name: referenceIdentity.name,
        author: referenceIdentity.author,
        executableFileName: basename(options.enginePath),
        binarySha256,
        nnue,
        license: manifest.license,
      },
      summary: {
        selectedLineCount: selectedCount,
        analyzedDecisionNodeCount: lines.reduce((count, line) => count + line.nodes.length, 0),
        quarantinedLineCount: lines.filter((line) => line.quarantined).length,
        engineSearchRequests: sharedAnalysis.requests,
        uniqueEngineSearchCount: sharedAnalysis.misses,
        reusedEngineSearchCount: sharedAnalysis.requests - sharedAnalysis.misses,
      },
      lines,
    });
  } finally {
    await Promise.allSettled(engines.map((engine) => engine.close()));
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runStockfishAnalysis({
    inputPath: resolve(requiredArgument('--input')),
    outputPath: resolve(requiredArgument('--output')),
    enginePath: resolve(requiredArgument('--engine')),
    receiptPath: resolve(requiredArgument('--receipt')),
    manifestPath: resolve(optionalArgument('--manifest') ?? DEFAULT_MANIFEST),
    concurrency: Number(optionalArgument('--workers') ?? Math.max(1, Math.min(6, availableParallelism() - 1))),
  });
  process.stdout.write('Stockfish verification report written.\n');
}

import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadVerifiedFile, readJsonFile, sha256File, writeJsonAtomic } from './lib/files.ts';
import { StockfishManifestSchema, type StockfishArtifact } from './lib/manifest.ts';
import { runProcess } from './lib/process.ts';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_MANIFEST = join(REPOSITORY_ROOT, 'data', 'manifests', 'stockfish-18.source.json');
const DEFAULT_CACHE = join(REPOSITORY_ROOT, '.cache', 'stockfish', 'sf_18');

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function selectStockfishArtifact(
  artifacts: StockfishArtifact[],
  platform: NodeJS.Platform,
  arch: string,
): StockfishArtifact {
  const found = artifacts.find((artifact) => artifact.platform === platform && artifact.arch === arch);
  if (found === undefined) {
    throw new Error(
      `No pinned Stockfish 18 artifact for ${platform}/${arch}. Build Stockfish from the pinned source commit instead.`,
    );
  }
  return found;
}

function assertSafeArchiveEntries(listing: string): void {
  for (const rawEntry of listing.split(/\r?\n/u)) {
    const entry = rawEntry.trim().replaceAll('\\', '/');
    if (entry === '') continue;
    const segments = entry.split('/');
    if (entry.startsWith('/') || /^[A-Za-z]:\//u.test(entry) || segments.includes('..')) {
      throw new Error(`Unsafe archive entry rejected: ${entry}`);
    }
  }
}

async function findEngineExecutable(root: string, platform: NodeJS.Platform): Promise<string> {
  const candidates: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const matches =
          platform === 'win32'
            ? /^stockfish-[a-z0-9-]+\.exe$/u.test(entry.name)
            : /^stockfish-(?:ubuntu|macos)-[a-z0-9-]+$/u.test(entry.name);
        if (matches) candidates.push(path);
      }
    }
  }
  await walk(root);
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one Stockfish executable; found ${candidates.length}`);
  }
  return candidates[0] as string;
}

export async function provisionStockfish(options: {
  manifestPath: string;
  cacheDirectory: string;
  platform: NodeJS.Platform;
  arch: string;
}): Promise<{ executablePath: string; receiptPath: string }> {
  const manifest = StockfishManifestSchema.parse(await readJsonFile(options.manifestPath));
  const artifact = selectStockfishArtifact(manifest.artifacts, options.platform, options.arch);
  const cacheDirectory = resolve(options.cacheDirectory);
  const archivePath = join(cacheDirectory, 'downloads', artifact.fileName);
  const extractionDirectory = join(cacheDirectory, 'extracted', `${artifact.platform}-${artifact.arch}`);
  const download = await downloadVerifiedFile({
    url: artifact.url,
    destination: archivePath,
    expectedSha256: artifact.sha256,
    expectedSize: artifact.size,
  });

  const listing = await runProcess('tar', ['-tf', archivePath], { timeoutMs: 60_000 });
  assertSafeArchiveEntries(listing.stdout);
  await rm(extractionDirectory, { recursive: true, force: true });
  await mkdir(extractionDirectory, { recursive: true });
  await runProcess('tar', ['-xf', archivePath, '-C', extractionDirectory], { timeoutMs: 120_000 });
  const executablePath = await findEngineExecutable(extractionDirectory, options.platform);
  if (!resolve(executablePath).startsWith(`${extractionDirectory}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Extracted executable escaped the cache directory');
  }
  if (options.platform !== 'win32') await chmod(executablePath, 0o755);

  const receiptPath = join(cacheDirectory, `provision-${artifact.platform}-${artifact.arch}.json`);
  await writeJsonAtomic(receiptPath, {
    schemaVersion: 1,
    provisionedAt: new Date().toISOString(),
    releaseTag: manifest.releaseTag,
    releaseCommit: manifest.releaseCommit,
    license: manifest.license,
    artifact: {
      ...artifact,
      archiveSha256Verified: download.sha256,
      archiveReused: download.reused,
    },
    executable: {
      path: relative(REPOSITORY_ROOT, executablePath).replaceAll('\\', '/'),
      fileName: basename(executablePath),
      sha256: await sha256File(executablePath),
    },
  });
  return { executablePath, receiptPath };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await provisionStockfish({
    manifestPath: resolve(argumentValue('--manifest') ?? DEFAULT_MANIFEST),
    cacheDirectory: resolve(argumentValue('--cache') ?? DEFAULT_CACHE),
    platform: (argumentValue('--platform') ?? process.platform) as NodeJS.Platform,
    arch: argumentValue('--arch') ?? process.arch,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadVerifiedFile, readJsonFile, writeJsonAtomic } from './lib/files.ts';
import { ScidManifestSchema } from './lib/manifest.ts';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_MANIFEST = join(REPOSITORY_ROOT, 'data', 'manifests', 'scid.source.json');
const DEFAULT_CACHE = join(REPOSITORY_ROOT, '.cache', 'scid');

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export async function provisionScid(options: {
  manifestPath: string;
  cacheDirectory: string;
}): Promise<{ ecoPath: string; receiptPath: string }> {
  const manifest = ScidManifestSchema.parse(await readJsonFile(options.manifestPath));
  const directory = join(resolve(options.cacheDirectory), manifest.repositoryCommit);
  const ecoPath = join(directory, manifest.filePath);
  const download = await downloadVerifiedFile({
    url: manifest.url,
    destination: ecoPath,
    expectedSha256: manifest.sha256,
    expectedSize: manifest.size,
  });
  const receiptPath = join(directory, 'provision.json');
  await writeJsonAtomic(receiptPath, {
    schemaVersion: 1,
    provisionedAt: new Date().toISOString(),
    repositoryCommit: manifest.repositoryCommit,
    file: {
      path: manifest.filePath,
      size: download.size,
      sha256: download.sha256,
      reused: download.reused,
    },
    license: manifest.license,
  });
  return { ecoPath, receiptPath };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await provisionScid({
    manifestPath: resolve(argumentValue('--manifest') ?? DEFAULT_MANIFEST),
    cacheDirectory: resolve(argumentValue('--cache') ?? DEFAULT_CACHE),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

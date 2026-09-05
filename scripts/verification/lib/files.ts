import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await rm(temporaryPath, { force: true });
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
  );
  await rename(temporaryPath, path);
}

export async function downloadVerifiedFile(options: {
  url: string;
  destination: string;
  expectedSha256: string;
  expectedSize: number;
}): Promise<{ sha256: string; size: number; reused: boolean }> {
  const expectedHash = options.expectedSha256.toLowerCase();
  try {
    const existing = await stat(options.destination);
    if (existing.size === options.expectedSize && (await sha256File(options.destination)) === expectedHash) {
      return { sha256: expectedHash, size: existing.size, reused: true };
    }
  } catch {
    // A missing or invalid cache entry is replaced only after the new download verifies.
  }

  await mkdir(dirname(options.destination), { recursive: true });
  const temporaryPath = `${options.destination}.${process.pid}.download`;
  await rm(temporaryPath, { force: true });
  const response = await fetch(options.url, { redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${options.url}`);
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength !== options.expectedSize) {
    throw new Error(
      `Server declared ${declaredLength} bytes for ${options.url}; expected ${options.expectedSize}`,
    );
  }

  try {
    await pipeline(
      Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
      createWriteStream(temporaryPath, { flags: 'wx' }),
    );
    const downloaded = await stat(temporaryPath);
    if (downloaded.size !== options.expectedSize) {
      throw new Error(`Downloaded ${downloaded.size} bytes; expected ${options.expectedSize}`);
    }
    const actualHash = await sha256File(temporaryPath);
    if (actualHash !== expectedHash) {
      throw new Error(`SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}`);
    }
    await rm(options.destination, { force: true });
    await rename(temporaryPath, options.destination);
    return { sha256: actualHash, size: downloaded.size, reused: false };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

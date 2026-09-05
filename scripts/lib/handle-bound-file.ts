import { open } from 'node:fs/promises'

/**
 * Read one regular file through the same open handle used for validation.
 *
 * This deliberately avoids a path-based stat followed by a second path-based
 * read. Replacing a directory entry after open cannot redirect the read to a
 * different file. The before/after metadata comparison also rejects a file
 * that changes while its bytes are being copied into memory.
 */
export async function readHandleBoundRegularFile(
  path: string,
  label: string,
  maximumBytes: number = Number.MAX_SAFE_INTEGER,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error(`${label} maximum byte length is invalid`)
  }
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error(`${label} is not a regular file`)
    if (before.size > maximumBytes) {
      throw new Error(`${label} exceeds its ${maximumBytes}-byte hard cap`)
    }

    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new Error(`${label} changed while it was being read`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

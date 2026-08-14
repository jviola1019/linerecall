import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { TextDecoder } from 'node:util'
import { z } from 'zod'

const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9_./-]{0,510}$/u
const DEFAULT_MAX_STORED_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_DECODED_BYTES = 256 * 1024 * 1024

export const ImmutableJsonReceiptV1Schema = z.object({
  path: z.string().min(1).max(512).regex(SAFE_RELATIVE_PATH),
  sha256: z.string().regex(SHA256),
  bytes: z.number().int().positive().max(DEFAULT_MAX_STORED_BYTES),
  uncompressedBytes: z.number().int().positive().max(DEFAULT_MAX_DECODED_BYTES),
  encoding: z.enum(['identity', 'gzip']),
}).strict().superRefine((receipt, context) => {
  if (receipt.encoding === 'identity' && receipt.bytes !== receipt.uncompressedBytes) {
    context.addIssue({
      code: 'custom',
      path: ['uncompressedBytes'],
      message: 'Identity JSON must have equal stored and decoded byte receipts',
    })
  }
})

export type ImmutableJsonReceiptV1 = z.infer<typeof ImmutableJsonReceiptV1Schema>

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export async function resolveReceiptRoot(root: string): Promise<string> {
  const rootReal = await realpath(root)
  if (!(await stat(rootReal)).isDirectory()) throw new Error('Receipt root is not a directory')
  return rootReal
}

export async function resolveSafeReceiptPath(rootReal: string, requested: string): Promise<string> {
  ImmutableJsonReceiptV1Schema.shape.path.parse(requested)
  const targetReal = await realpath(resolve(rootReal, requested))
  if (!isWithinRoot(rootReal, targetReal)) throw new Error('Receipt path escapes the approved root')
  const details = await stat(targetReal)
  if (!details.isFile()) throw new Error('Receipt path is not a regular file')
  return targetReal
}

async function readExact(path: string, expectedBytes: number, maximumBytes: number): Promise<Uint8Array> {
  if (expectedBytes > maximumBytes) throw new Error(`Receipt exceeds the ${maximumBytes}-byte stored-data bound`)
  const handle = await open(path, 'r')
  try {
    const details = await handle.stat()
    if (!details.isFile() || details.size !== expectedBytes) {
      throw new Error('Receipt byte length does not match the immutable file')
    }
    const output = new Uint8Array(expectedBytes + 1)
    let offset = 0
    while (offset < output.length) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== expectedBytes) throw new Error('Receipt file changed while it was read')
    return output.subarray(0, expectedBytes)
  } finally {
    await handle.close()
  }
}

export async function readImmutableJsonReceipt(options: {
  root: string
  receipt: unknown
  maximumStoredBytes?: number
  maximumDecodedBytes?: number
}): Promise<{ receipt: ImmutableJsonReceiptV1; value: unknown; storedBytes: Uint8Array }> {
  const receipt = ImmutableJsonReceiptV1Schema.parse(options.receipt)
  const maximumStoredBytes = options.maximumStoredBytes ?? DEFAULT_MAX_STORED_BYTES
  const maximumDecodedBytes = options.maximumDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES
  const rootReal = await resolveReceiptRoot(options.root)
  const path = await resolveSafeReceiptPath(rootReal, receipt.path)
  const storedBytes = await readExact(path, receipt.bytes, maximumStoredBytes)
  const digest = createHash('sha256').update(storedBytes).digest('hex')
  if (digest !== receipt.sha256) throw new Error(`Receipt SHA-256 mismatch for ${receipt.path}`)
  const decoded = receipt.encoding === 'gzip'
    ? new Uint8Array(gunzipSync(storedBytes, { maxOutputLength: maximumDecodedBytes }))
    : storedBytes
  if (decoded.byteLength !== receipt.uncompressedBytes) {
    throw new Error(`Decoded byte length mismatch for ${receipt.path}`)
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
  if (text.includes('\0')) throw new Error(`Receipt JSON contains a NUL character: ${receipt.path}`)
  return { receipt, value: JSON.parse(text) as unknown, storedBytes }
}

export function safeOutputPath(root: string, requested: string): string {
  ImmutableJsonReceiptV1Schema.shape.path.parse(requested)
  const rootAbsolute = resolve(root)
  const output = resolve(rootAbsolute, requested)
  if (!isWithinRoot(rootAbsolute, output)) throw new Error('Output path escapes the approved root')
  return output
}

/** Filesystem-aware identity used when an output must not alias an input. */
export function safePathIdentity(root: string, requested: string): string {
  const absolute = safeOutputPath(root, requested)
  return process.platform === 'win32' ? absolute.toLocaleLowerCase('en-US') : absolute
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    // Windows and some network filesystems do not expose directory fsync.
    // The candidate itself is always fsynced; only known unsupported cases
    // are tolerated here.
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EISDIR'].includes(errorCode(error) ?? '')) throw error
  } finally {
    await handle?.close()
  }
}

/**
 * Write a new immutable handoff document without replacing an existing one.
 * Callers validate a candidate before invoking promote().
 */
export async function writeImmutableJsonCandidate(options: {
  root: string
  outputPath: string
  value: unknown
}): Promise<{
  candidatePath: string
  candidateRelativePath: string
  bytes: number
  sha256: string
  promote: () => Promise<void>
  discard: () => Promise<void>
}> {
  const output = safeOutputPath(options.root, options.outputPath)
  await mkdir(dirname(output), { recursive: true })
  const rootReal = await resolveReceiptRoot(options.root)
  const parentReal = await realpath(dirname(output))
  if (!isWithinRoot(rootReal, parentReal)) throw new Error('Output parent escapes the approved root')
  try {
    await stat(output)
    throw new Error(`Immutable handoff output already exists: ${options.outputPath}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Immutable handoff output already exists:')) throw error
    if (errorCode(error) !== 'ENOENT') throw error
  }

  const candidate = `${output}.candidate-${randomUUID()}`
  const candidateRelativePath = relative(rootReal, candidate).replaceAll('\\', '/')
  ImmutableJsonReceiptV1Schema.shape.path.parse(candidateRelativePath)
  const content = `${JSON.stringify(options.value, null, 2)}\n`
  const candidateHandle = await open(candidate, 'wx')
  try {
    await candidateHandle.writeFile(content, { encoding: 'utf8' })
    await candidateHandle.sync()
  } catch (error) {
    await candidateHandle.close()
    try {
      await unlink(candidate)
    } catch (cleanupError) {
      if (errorCode(cleanupError) !== 'ENOENT') throw cleanupError
    }
    throw error
  }
  await candidateHandle.close()
  const bytes = Buffer.byteLength(content, 'utf8')
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
  let pending = true
  return {
    candidatePath: candidate,
    candidateRelativePath,
    bytes,
    sha256,
    promote: async () => {
      if (!pending) throw new Error('Handoff candidate has already been finalized')
      let outputLinked = false
      try {
        // A hard link is atomic and, unlike rename(), never replaces an
        // output that appeared after the initial existence check.
        await link(candidate, output)
        outputLinked = true
        await syncDirectory(parentReal)
        await unlink(candidate)
        await syncDirectory(parentReal)
        pending = false
      } catch (error) {
        if (outputLinked && pending) {
          try {
            await unlink(output)
          } catch (cleanupError) {
            if (errorCode(cleanupError) !== 'ENOENT') throw cleanupError
          }
        }
        if (errorCode(error) === 'EEXIST') {
          throw new Error(`Immutable handoff output already exists: ${options.outputPath}`)
        }
        throw error
      }
    },
    discard: async () => {
      if (!pending) return
      try {
        await unlink(candidate)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
      pending = false
    },
  }
}

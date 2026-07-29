import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  type FileHandle,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  COMPACT_EVIDENCE_SCHEMA_VERSION,
  COMPACT_STORAGE_MODEL,
  CompactArchiveCheckpointSchema,
  CompactPassReceiptSchema,
  CompactPreflightPlanSchema,
  type CompactArchiveCheckpoint,
  type CompactExecutionPurpose,
  type CompactPassReceipt,
  type CompactPreflightPlan,
  type CompactRemoteInputAcquisition,
} from './compact-v3-contracts.ts'
import {
  assessCompactV3Storage,
  receiptDigest,
  resumeAction,
  type CompactStorageAssessment,
} from './compact-v3-foundation.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const FILE_READ_CHUNK_BYTES = 64 * 1024
const PRIVATE_DIRECTORY_MODE = 0o700
const GROUP_OR_WORLD_WRITE = 0o022
const STICKY_DIRECTORY = 0o1000
const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'])

export interface SecureCompactWorkBoundary {
  workDirectory: string
  v3Directory: string | null
  adapterWorkingDirectory: string | null
  windowsAclVerified: boolean
}

async function validateDirectoryIdentity(path: string, label: string): Promise<string> {
  const requestedPath = resolve(path)
  const requestedEntry = await lstat(requestedPath, { bigint: true })
  if (requestedEntry.isSymbolicLink() || !requestedEntry.isDirectory()) {
    throw new Error(`${label} must be a non-symbolic-link directory`)
  }
  const canonicalPath = await realpath(requestedPath)
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const opened = await handle.stat({ bigint: true })
    const pathEntry = await lstat(canonicalPath, { bigint: true })
    if (
      !opened.isDirectory() ||
      pathEntry.isSymbolicLink() ||
      !pathEntry.isDirectory() ||
      pathEntry.dev !== opened.dev ||
      pathEntry.ino !== opened.ino
    ) {
      throw new Error(`${label} changed or resolved through a symbolic link while opening`)
    }
    if (process.platform !== 'win32') {
      const effectiveUid = typeof process.geteuid === 'function'
        ? process.geteuid()
        : typeof process.getuid === 'function'
          ? process.getuid()
          : null
      if (effectiveUid === null) throw new Error(`${label} ownership cannot be verified on this platform`)
      if (opened.uid !== BigInt(effectiveUid)) {
        throw new Error(`${label} must be owned by the effective user`)
      }
      if ((Number(opened.mode) & GROUP_OR_WORLD_WRITE) !== 0) {
        throw new Error(`${label} must not be group- or world-writable`)
      }
    }
  } finally {
    await handle.close()
  }
  return canonicalPath
}

async function validatePosixParentChain(path: string, label: string): Promise<void> {
  if (process.platform === 'win32') return
  let current = dirname(path)
  while (true) {
    const entry = await lstat(current, { bigint: true })
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`${label} has an unsafe parent path`)
    }
    const mode = Number(entry.mode)
    if ((mode & GROUP_OR_WORLD_WRITE) !== 0 && (mode & STICKY_DIRECTORY) === 0) {
      throw new Error(`${label} has a group- or world-writable non-sticky parent directory`)
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

async function ensurePrivateDirectory(parent: string, name: string, label: string): Promise<string> {
  const path = join(parent, name)
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return validateDirectoryIdentity(path, label)
}

/**
 * Establish the trust boundary for all mutable compact-v3 state. On POSIX the
 * root and private children must be owned by the effective user and reject
 * group/world writes; writable ancestors are accepted only when sticky (for
 * example /tmp). Windows supplies no portable ownership/ACL data through
 * fs.stat, so the strongest platform-neutral checks are canonical local path,
 * non-reparse identity, exclusive file creation, and private child modes.
 */
export async function ensureSecureCompactWorkDirectory(
  workDirectory: string,
  options: {
    createV3?: boolean
    createAdapterWorking?: boolean
  } = {},
): Promise<SecureCompactWorkBoundary> {
  const root = await validateDirectoryIdentity(workDirectory, 'Compact v3 work root')
  await validatePosixParentChain(root, 'Compact v3 work root')
  const createV3 = options.createV3 ?? true
  let v3Directory: string | null = null
  try {
    v3Directory = await validateDirectoryIdentity(join(root, 'v3'), 'Compact v3 private directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (createV3) {
      v3Directory = await ensurePrivateDirectory(root, 'v3', 'Compact v3 private directory')
    }
  }
  let adapterWorkingDirectory: string | null = null
  if (options.createAdapterWorking) {
    if (v3Directory === null) {
      v3Directory = await ensurePrivateDirectory(root, 'v3', 'Compact v3 private directory')
    }
    adapterWorkingDirectory = await ensurePrivateDirectory(
      v3Directory,
      '.adapter-working',
      'Compact v3 SQLite working directory',
    )
  }
  return {
    workDirectory: root,
    v3Directory,
    adapterWorkingDirectory,
    windowsAclVerified: process.platform !== 'win32',
  }
}

/**
 * Make a completed link/rename durable when the filesystem supports directory
 * fsync. Windows rejects directory fsync with EPERM; that platform-specific
 * unsupported result is explicit rather than treated as evidence of a sync.
 */
export async function syncCompactParentDirectory(path: string): Promise<boolean> {
  const directory = dirname(resolve(path))
  const handle = await open(
    directory,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  )
  try {
    await handle.sync()
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (DIRECTORY_SYNC_UNSUPPORTED.has(code) || (process.platform === 'win32' && code === 'EPERM')) {
      return false
    }
    throw error
  } finally {
    await handle.close()
  }
}

export interface ValidatedRegularFile {
  handle: FileHandle
  size: number
  changed(): Promise<boolean>
  close(): Promise<void>
}

/**
 * Bind validation and use to one open file description. Opening happens before
 * the path-entry check, so replacing the pathname cannot redirect the later
 * read. O_NOFOLLOW is used where Node exposes it; the post-open lstat/identity
 * comparison supplies the equivalent fail-closed check on Windows.
 */
export async function openValidatedRegularFile(
  path: string,
  options: {
    label: string
    maximumBytes: number
    minimumBytes?: number
    exactBytes?: number
  },
): Promise<ValidatedRegularFile> {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 0) {
    throw new Error(`${options.label} maximum byte length is invalid`)
  }
  const minimumBytes = options.minimumBytes ?? 0
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 0 || minimumBytes > options.maximumBytes) {
    throw new Error(`${options.label} minimum byte length is invalid`)
  }
  if (
    options.exactBytes !== undefined &&
    (!Number.isSafeInteger(options.exactBytes) ||
      options.exactBytes < minimumBytes ||
      options.exactBytes > options.maximumBytes)
  ) {
    throw new Error(`${options.label} exact byte length is invalid`)
  }

  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile()) throw new Error(`${options.label} must be a regular file`)
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${options.label} byte length exceeds the safe integer range`)
    }
    const size = Number(opened.size)
    if (
      size < minimumBytes ||
      size > options.maximumBytes ||
      (options.exactBytes !== undefined && size !== options.exactBytes)
    ) {
      throw new Error(`${options.label} byte length is outside its approved bounds`)
    }

    const pathEntry = await lstat(path, { bigint: true })
    if (
      pathEntry.isSymbolicLink() ||
      !pathEntry.isFile() ||
      pathEntry.dev !== opened.dev ||
      pathEntry.ino !== opened.ino
    ) {
      throw new Error(`${options.label} path changed or resolved through a symbolic link while opening`)
    }
    return {
      handle,
      size,
      async changed() {
        const current = await handle.stat({ bigint: true })
        return current.size !== opened.size ||
          current.mtimeNs !== opened.mtimeNs ||
          current.ctimeNs !== opened.ctimeNs
      },
      async close() {
        await handle.close()
      },
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function withValidatedRegularFile<T>(
  path: string,
  options: {
    label: string
    maximumBytes: number
    minimumBytes?: number
    exactBytes?: number
  },
  use: (file: ValidatedRegularFile) => Promise<T>,
): Promise<T> {
  const file = await openValidatedRegularFile(path, options)
  try {
    return await use(file)
  } finally {
    await file.close()
  }
}

export async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
  minimumBytes: number = 0,
): Promise<Buffer> {
  return withValidatedRegularFile(
    path,
    { label, maximumBytes, minimumBytes },
    async ({ handle, size, changed }) => {
      const bytes = Buffer.alloc(size)
      let offset = 0
      while (offset < size) {
        const result = await handle.read(
          bytes,
          offset,
          Math.min(FILE_READ_CHUNK_BYTES, size - offset),
          offset,
        )
        if (result.bytesRead < 1) throw new Error(`${label} changed while being read`)
        offset += result.bytesRead
      }
      const extra = Buffer.alloc(1)
      if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0 || await changed()) {
        throw new Error(`${label} changed while being read`)
      }
      return bytes
    },
  )
}

async function digestRegularFile(
  path: string,
  options: {
    label: string
    maximumBytes: number
    minimumBytes?: number
    exactBytes?: number
  },
): Promise<{ size: number; sha256: string }> {
  return withValidatedRegularFile(path, options, async ({ handle, size, changed }) => {
    const hash = createHash('sha256')
    let bytes = 0
    const stream = handle.createReadStream({ autoClose: false, start: 0 })
    for await (const chunkValue of stream) {
      const chunk = Buffer.from(chunkValue)
      bytes += chunk.byteLength
      if (!Number.isSafeInteger(bytes) || bytes > options.maximumBytes) {
        throw new Error(`${options.label} exceeded its byte cap while hashing`)
      }
      hash.update(chunk)
    }
    if (bytes !== size || await changed()) throw new Error(`${options.label} changed while being hashed`)
    return { size, sha256: hash.digest('hex') }
  })
}

async function restoreClaimWithoutOverwrite(claimedPath: string, path: string): Promise<void> {
  try {
    await link(claimedPath, path)
    await syncCompactParentDirectory(path)
    await rm(claimedPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Could not restore changed filesystem entry ${path}; retained ${claimedPath} for inspection`)
    }
    throw error
  }
}

/**
 * Atomically move a pathname out of service before deciding whether it is the
 * caller-owned file. A replacement can therefore never be unlinked merely
 * because an earlier read matched.
 */
export async function removeFileIfUnchanged(
  path: string,
  expected: Uint8Array,
  maximumBytes: number,
  label: string,
): Promise<boolean> {
  const claimedPath = `${path}.claimed-${process.pid}-${randomBytes(16).toString('hex')}`
  try {
    await rename(path, claimedPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    const observed = await readBoundedRegularFile(claimedPath, maximumBytes, label)
    if (!observed.equals(Buffer.from(expected))) {
      throw new Error(`${label} changed before its atomic removal claim`)
    }
    await rm(claimedPath)
    return true
  } catch (error) {
    try {
      await restoreClaimWithoutOverwrite(claimedPath, path)
    } catch (restoreError) {
      if ((restoreError as NodeJS.ErrnoException).code !== 'ENOENT') throw restoreError
    }
    throw error
  }
}
const OUTPUT_EXTENSION = /^[a-z0-9]{1,12}$/u

export interface CompactPassAccounting {
  recordsSeen: number
  accepted: number
  deduplicated: number
  rejected: Record<string, number>
}

export interface CompactCandidatePassSummary extends CompactPassAccounting {
  pass: 'candidate'
  priorCandidateStateSha256: string | null
  adaptiveObservationsSeen: number
  candidateRows: number
}

export interface CompactExactPassSummary extends CompactPassAccounting {
  pass: 'exact'
  finalCandidateSetReceiptSha256: string
  completeBaselineObservationsRetained: number
  adaptiveCandidateObservationsRetained: number
  adaptiveNoncandidateObservationsRejected: number
  normalizedPositionRows: number
  normalizedEdgeRows: number
}

export type CompactPassSummary = CompactCandidatePassSummary | CompactExactPassSummary

export interface CompactToolchainReceipt {
  node: string
  chessJs: string
  zstd: string
  sourceSnapshotSha256: string
}

export interface CompactArtifactSink {
  readonly maximumBytes: number
  readonly bytesWritten: number
  write(chunk: Uint8Array): Promise<void>
}

export interface CompactPassProcessorContext {
  /**
   * The exact compressed archive. It must be consumed to completion. Hashing
   * and byte counting happen in this iterator before a shard can be promoted.
   */
  input: AsyncIterable<Uint8Array>
  /** A staging-only sink which aborts before writing beyond its hard cap. */
  output: CompactArtifactSink
}

export type CompactPassProcessor = (
  context: CompactPassProcessorContext,
) => Promise<CompactPassSummary>

export interface CompactArchivePassOptions {
  plan: CompactPreflightPlan
  pass: 'candidate' | 'exact'
  /** Existing directory dedicated to schema-v3 work. */
  workDirectory: string
  /** Must create a fresh stream because an interrupted archive replays from byte zero. */
  openCompressedInput: () => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>
  /**
   * Present only for the allowlisted HTTPS input. It is read after the stream
   * verifies and must fail until that exact stream was consumed completely.
   */
  remoteInputAcquisition?: () => CompactRemoteInputAcquisition
  process: CompactPassProcessor
  toolchain: CompactToolchainReceipt
  /** Benchmark mode is isolated and always emits provisional, release-ineligible receipts. */
  executionPurpose?: CompactExecutionPurpose
  outputExtension?: string
  availableBytes?: () => Promise<number>
  now?: () => Date
}

export interface CompactArchivePassResult {
  status: 'promoted' | 'already-committed'
  receipt: CompactPassReceipt
  receiptSha256: string
  checkpoint: CompactArchiveCheckpoint
  preflight: CompactStorageAssessment
}

interface ManagedPaths {
  archiveDirectory: string
  checkpoint: string
  lock: string
  outputPartial: string
  receiptPartial: string
}

interface LockRecord {
  schemaVersion: 1
  archiveId: string
  pid: number
  hostname: string
  createdAt: string
}

function ensureSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a nonnegative safe integer`)
}

function isoTime(now: () => Date): string {
  const value = now()
  if (!Number.isFinite(value.getTime())) throw new Error('Clock returned an invalid date')
  return value.toISOString()
}

function pathsFor(workDirectory: string, archiveId: string, pass: 'candidate' | 'exact'): ManagedPaths {
  const archiveDirectory = join(resolve(workDirectory), 'v3', archiveId)
  return {
    archiveDirectory,
    checkpoint: join(archiveDirectory, 'checkpoint.json'),
    lock: join(archiveDirectory, 'orchestration.lock'),
    outputPartial: join(archiveDirectory, 'staging', `${pass}.output.partial`),
    receiptPartial: join(archiveDirectory, 'staging', `${pass}.receipt.partial`),
  }
}

function relativeOutputPath(
  archiveId: string,
  pass: 'candidate' | 'exact',
  sha256: string,
  extension: string,
): string {
  return `v3/${archiveId}/shards/sha256/${sha256}.${pass}.${extension}`
}

function receiptRelativePath(archiveId: string, sha256: string): string {
  return `v3/${archiveId}/receipts/sha256/${sha256}.json`
}

function absoluteArtifactPath(workDirectory: string, relativePath: string): string {
  return join(resolve(workDirectory), ...relativePath.split('/'))
}

async function availableBytesAt(path: string): Promise<number> {
  const filesystem = await statfs(path, { bigint: true })
  const bytes = filesystem.bavail * filesystem.bsize
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Available storage exceeds the safe integer range')
  return Number(bytes)
}

/**
 * Count every retained object under the schema-v3 tree. Existing v2 data and
 * source archives are deliberately outside this path and are never opened or
 * removed by this function.
 */
export async function compactRetainedStateBytes(workDirectory: string): Promise<number> {
  const boundary = await ensureSecureCompactWorkDirectory(workDirectory, { createV3: false })
  if (boundary.v3Directory === null) return 0
  const root = boundary.v3Directory
  const pending = [root]
  let filesSeen = 0
  let total = 0
  while (pending.length > 0) {
    const pendingDirectory = pending.pop()!
    const directory = pendingDirectory === root
      ? root
      : await validateDirectoryIdentity(pendingDirectory, 'Retained schema-v3 directory')
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && directory === root) return 0
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Schema-v3 work tree must not contain symbolic links')
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!entry.isFile()) throw new Error('Schema-v3 work tree contains an unsupported filesystem entry')
      filesSeen += 1
      if (filesSeen > 1_000_000) throw new Error('Schema-v3 work tree exceeds the retained-file safety limit')
      const size = await withValidatedRegularFile(
        path,
        {
          label: 'Retained schema-v3 file',
          maximumBytes: Number.MAX_SAFE_INTEGER,
        },
        async (file) => file.size,
      )
      const next = total + size
      if (!Number.isSafeInteger(next)) throw new Error('Retained schema-v3 bytes exceed the safe integer range')
      total = next
    }
  }
  return total
}

async function writeAndSync(path: string, bytes: Uint8Array, maximumBytes: number): Promise<void> {
  if (bytes.byteLength > maximumBytes) throw new Error(`Atomic metadata exceeds its ${maximumBytes}-byte hard cap`)
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicReplace(path: string, bytes: Uint8Array, maximumBytes: number): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(16).toString('hex')}.partial`
  try {
    await writeAndSync(temporary, bytes, maximumBytes)
    await rename(temporary, path)
    await syncCompactParentDirectory(path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function promoteContentAddressed(
  partialPath: string,
  destinationPath: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true })
  try {
    await link(partialPath, destinationPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await digestRegularFile(destinationPath, {
      label: 'Existing content-addressed artifact',
      maximumBytes: expectedBytes,
      minimumBytes: expectedBytes,
      exactBytes: expectedBytes,
    })
    if (existing.sha256 !== expectedSha256) {
      throw new Error('A corrupt artifact already occupies the content-addressed destination')
    }
  }
  await syncCompactParentDirectory(destinationPath)
  const promoted = await digestRegularFile(destinationPath, {
    label: 'Promoted content-addressed artifact',
    maximumBytes: expectedBytes,
    minimumBytes: expectedBytes,
    exactBytes: expectedBytes,
  })
  if (promoted.sha256 !== expectedSha256) {
    throw new Error('Promoted content-addressed artifact does not match its approved digest')
  }
  await rm(partialPath, { force: true })
}

class VerifiedCompressedInput implements AsyncIterable<Uint8Array> {
  private readonly hash = createHash('sha256')
  private consumed = false
  private iterationStarted = false
  private byteCount = 0

  constructor(
    private readonly source: AsyncIterable<Uint8Array>,
    private readonly expectedBytes: number,
    private readonly expectedSha256: string,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.iterationStarted) throw new Error('Compressed input may be consumed only once per archive pass')
    this.iterationStarted = true
    for await (const sourceChunk of this.source) {
      const chunk = Buffer.from(sourceChunk)
      const nextBytes = this.byteCount + chunk.byteLength
      if (!Number.isSafeInteger(nextBytes) || nextBytes > this.expectedBytes) {
        throw new Error(`Compressed input exceeds approved byte length ${this.expectedBytes}`)
      }
      this.byteCount = nextBytes
      this.hash.update(chunk)
      yield chunk
    }
    this.consumed = true
  }

  verify(): { bytes: number; sha256: string } {
    if (!this.consumed) throw new Error('Processor did not consume the complete compressed archive')
    if (this.byteCount !== this.expectedBytes) {
      throw new Error(`Compressed input byte mismatch: expected ${this.expectedBytes}, received ${this.byteCount}`)
    }
    const sha256 = this.hash.digest('hex')
    if (sha256 !== this.expectedSha256) {
      throw new Error(`Compressed input SHA-256 mismatch: expected ${this.expectedSha256}, received ${sha256}`)
    }
    return { bytes: this.byteCount, sha256 }
  }
}

class BoundedArtifactFileSink implements CompactArtifactSink {
  private handle: FileHandle | null = null
  private readonly hash = createHash('sha256')
  private writing = false
  private finished = false
  private bytes = 0

  constructor(
    private readonly path: string,
    readonly maximumBytes: number,
  ) {}

  get bytesWritten(): number {
    return this.bytes
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    this.handle = await open(this.path, 'wx', 0o600)
  }

  async write(source: Uint8Array): Promise<void> {
    if (this.finished || this.handle === null) throw new Error('Artifact sink is not open')
    if (this.writing) throw new Error('Concurrent artifact writes are not supported')
    const nextBytes = this.bytes + source.byteLength
    if (!Number.isSafeInteger(nextBytes) || nextBytes > this.maximumBytes) {
      throw new Error(`Promoted shard would exceed its ${this.maximumBytes}-byte hard cap`)
    }
    const chunk = Buffer.from(source)
    this.writing = true
    try {
      let offset = 0
      while (offset < chunk.byteLength) {
        const result = await this.handle.write(chunk, offset, chunk.byteLength - offset, null)
        if (result.bytesWritten < 1) throw new Error('Artifact sink made no write progress')
        offset += result.bytesWritten
      }
      this.hash.update(chunk)
      this.bytes = nextBytes
    } finally {
      this.writing = false
    }
  }

  async finish(): Promise<{ bytes: number; sha256: string }> {
    if (this.finished || this.handle === null || this.writing) throw new Error('Artifact sink cannot finish now')
    if (this.bytes === 0) throw new Error('A compact shard cannot be empty')
    this.finished = true
    await this.handle.sync()
    await this.handle.close()
    this.handle = null
    return { bytes: this.bytes, sha256: this.hash.digest('hex') }
  }

  async abort(): Promise<void> {
    this.finished = true
    if (this.handle !== null) {
      await this.handle.close()
      this.handle = null
    }
    await rm(this.path, { force: true })
  }
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function acquireLock(path: string, archiveId: string, createdAt: string): Promise<() => Promise<void>> {
  const record: LockRecord = {
    schemaVersion: 1,
    archiveId,
    pid: process.pid,
    hostname: hostname(),
    createdAt,
  }
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeAndSync(path, bytes, 2_048)
      return async () => {
        try {
          await removeFileIfUnchanged(path, bytes, 2_048, 'Compact archive lock')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let existing: LockRecord
      let observed: Buffer
      try {
        observed = await readBoundedRegularFile(path, 2_048, 'Compact archive lock', 1)
        existing = JSON.parse(observed.toString('utf8')) as LockRecord
      } catch {
        throw new Error('Compact archive lock is corrupt; inspect it before resuming')
      }
      if (
        existing.schemaVersion !== 1 ||
        existing.archiveId !== archiveId ||
        existing.hostname !== hostname() ||
        processExists(existing.pid)
      ) {
        throw new Error(`Compact archive ${archiveId} is already locked`)
      }
      if (observed.toString('utf8') !== `${JSON.stringify(existing)}\n`) {
        throw new Error('Compact archive lock changed while checking stale ownership')
      }
      await removeFileIfUnchanged(path, observed, 2_048, 'Compact archive lock')
    }
  }
  throw new Error(`Could not acquire compact archive lock for ${archiveId}`)
}

function checkpointBytes(checkpoint: CompactArchiveCheckpoint): Buffer {
  return Buffer.from(`${JSON.stringify(CompactArchiveCheckpointSchema.parse(checkpoint), null, 2)}\n`, 'utf8')
}

async function verifyReceiptArtifacts(
  workDirectory: string,
  archiveId: string,
  receiptValue: CompactPassReceipt,
  metadataMaximumBytes: number,
  outputMaximumBytes: number,
): Promise<void> {
  const receipt = CompactPassReceiptSchema.parse(receiptValue)
  const digest = receiptDigest(receipt)
  const storedReceiptPath = absoluteArtifactPath(workDirectory, receiptRelativePath(archiveId, digest))
  const storedReceipt = await readBoundedRegularFile(
    storedReceiptPath,
    metadataMaximumBytes,
    `Content-addressed ${receipt.pass} receipt`,
    1,
  )
  if (createHash('sha256').update(storedReceipt).digest('hex') !== digest) {
    throw new Error(`Content-addressed ${receipt.pass} receipt is corrupt`)
  }
  const parsedStoredReceipt = CompactPassReceiptSchema.parse(JSON.parse(storedReceipt.toString('utf8')) as unknown)
  if (receiptDigest(parsedStoredReceipt) !== digest || receiptDigest(receipt) !== digest) {
    throw new Error(`Checkpoint ${receipt.pass} receipt does not match its stored receipt`)
  }
  const outputExtension = receipt.output.path.split('.').at(-1) ?? ''
  if (!OUTPUT_EXTENSION.test(outputExtension)) throw new Error(`Checkpoint ${receipt.pass} output extension is invalid`)
  if (receipt.output.bytes > outputMaximumBytes) throw new Error(`Checkpoint ${receipt.pass} output exceeds its hard cap`)
  const expectedOutput = relativeOutputPath(
    archiveId,
    receipt.pass,
    receipt.output.sha256,
    outputExtension,
  )
  if (receipt.output.path !== expectedOutput) throw new Error(`Checkpoint ${receipt.pass} output path is not canonical`)
  const outputPath = absoluteArtifactPath(workDirectory, receipt.output.path)
  let output: { size: number; sha256: string }
  try {
    output = await digestRegularFile(outputPath, {
      label: `Content-addressed ${receipt.pass} shard`,
      maximumBytes: outputMaximumBytes,
      minimumBytes: receipt.output.bytes,
      exactBytes: receipt.output.bytes,
    })
  } catch (cause) {
    throw new Error(`Content-addressed ${receipt.pass} shard is corrupt`, { cause })
  }
  if (output.sha256 !== receipt.output.sha256) {
    throw new Error(`Content-addressed ${receipt.pass} shard is corrupt`)
  }
}

export async function readVerifiedCompactCheckpoint(
  workDirectory: string,
  planValue: CompactPreflightPlan,
): Promise<CompactArchiveCheckpoint | null> {
  const plan = CompactPreflightPlanSchema.parse(planValue)
  const boundary = await ensureSecureCompactWorkDirectory(workDirectory, { createV3: false })
  if (boundary.v3Directory === null) return null
  const paths = pathsFor(boundary.workDirectory, plan.archive.archiveId, 'candidate')
  let checkpointBuffer: Buffer
  try {
    checkpointBuffer = await readBoundedRegularFile(
      paths.checkpoint,
      plan.bounds.checkpointMaxBytes,
      'Compact archive checkpoint',
      1,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const checkpoint = CompactArchiveCheckpointSchema.parse(JSON.parse(checkpointBuffer.toString('utf8')) as unknown)
  if (
    checkpoint.archive.archiveId !== plan.archive.archiveId ||
    checkpoint.archive.sha256 !== plan.archive.sha256 ||
    checkpoint.archive.sourceManifestSha256 !== plan.archive.sourceManifestSha256
  ) {
    throw new Error('Compact archive checkpoint does not match the approved plan')
  }
  if (checkpoint.candidateReceipt) {
    await verifyReceiptArtifacts(
      boundary.workDirectory,
      plan.archive.archiveId,
      checkpoint.candidateReceipt,
      plan.bounds.checkpointMaxBytes,
      plan.bounds.atomicPromotionMaxBytes,
    )
  }
  if (checkpoint.exactReceipt) {
    await verifyReceiptArtifacts(
      boundary.workDirectory,
      plan.archive.archiveId,
      checkpoint.exactReceipt,
      plan.bounds.checkpointMaxBytes,
      plan.bounds.atomicPromotionMaxBytes,
    )
  }
  return checkpoint
}

function emptyCheckpoint(plan: CompactPreflightPlan, updatedAt: string): CompactArchiveCheckpoint {
  return CompactArchiveCheckpointSchema.parse({
    schemaVersion: COMPACT_EVIDENCE_SCHEMA_VERSION,
    archive: plan.archive,
    candidateReceipt: null,
    exactReceipt: null,
    updatedAt,
    resumePolicy: 'archive-pass-atomic-replay-from-start',
  })
}

function existingReceiptFor(
  checkpoint: CompactArchiveCheckpoint,
  pass: 'candidate' | 'exact',
): CompactPassReceipt | null {
  return pass === 'candidate' ? checkpoint.candidateReceipt : checkpoint.exactReceipt
}

function receiptFor(
  options: CompactArchivePassOptions,
  summary: CompactPassSummary,
  startedAt: string,
  completedAt: string,
  input: { bytes: number; sha256: string },
  output: { path: string; bytes: number; sha256: string },
  acquisition?: CompactRemoteInputAcquisition,
): CompactPassReceipt {
  const common = {
    schemaVersion: COMPACT_EVIDENCE_SCHEMA_VERSION,
    storageModel: COMPACT_STORAGE_MODEL,
    executionPurpose: options.executionPurpose ?? 'evidence-candidate',
    releaseEligible: false as const,
    archive: options.plan.archive,
    limits: options.plan.limits,
    startedAt,
    completedAt,
    compressedInput: {
      ...input,
      verified: true as const,
      ...(acquisition ? { acquisition } : {}),
    },
    output,
    recordsSeen: summary.recordsSeen,
    accepted: summary.accepted,
    deduplicated: summary.deduplicated,
    rejected: summary.rejected,
    toolchain: options.toolchain,
  }
  if (summary.pass === 'candidate') {
    return CompactPassReceiptSchema.parse({
      ...common,
      pass: summary.pass,
      priorCandidateStateSha256: summary.priorCandidateStateSha256,
      nextCandidateStateSha256: output.sha256,
      adaptiveObservationsSeen: summary.adaptiveObservationsSeen,
      candidateRows: summary.candidateRows,
      candidateFalsePositivesAllowed: true,
      candidateFalseNegativesAllowed: false,
      hardCapReached: false,
    })
  }
  return CompactPassReceiptSchema.parse({
    ...common,
    pass: summary.pass,
    finalCandidateSetReceiptSha256: summary.finalCandidateSetReceiptSha256,
    completeBaselineObservationsRetained: summary.completeBaselineObservationsRetained,
    adaptiveCandidateObservationsRetained: summary.adaptiveCandidateObservationsRetained,
    adaptiveNoncandidateObservationsRejected: summary.adaptiveNoncandidateObservationsRejected,
    normalizedPositionRows: summary.normalizedPositionRows,
    normalizedEdgeRows: summary.normalizedEdgeRows,
    hardCapReached: false,
  })
}

/**
 * Run one archive/pass transaction. The source stream is never staged. The
 * shard and its receipt are promoted first, both by content hash; checkpoint
 * replacement is the final commit. A crash before that replacement leaves at
 * most reusable immutable objects, and the archive pass restarts at byte zero.
 */
export async function runCompactArchivePass(
  optionsValue: CompactArchivePassOptions,
): Promise<CompactArchivePassResult> {
  const plan = CompactPreflightPlanSchema.parse(optionsValue.plan)
  const boundary = await ensureSecureCompactWorkDirectory(optionsValue.workDirectory)
  const options: CompactArchivePassOptions = {
    ...optionsValue,
    plan,
    workDirectory: boundary.workDirectory,
  }
  const executionPurpose = options.executionPurpose ?? 'evidence-candidate'
  const extension = options.outputExtension ?? 'bin'
  if (!OUTPUT_EXTENSION.test(extension)) throw new Error('Compact shard extension is invalid')
  if (!SHA256.test(options.toolchain.sourceSnapshotSha256)) {
    throw new Error('Toolchain source snapshot must be a SHA-256 digest')
  }
  const availableBytes = await (options.availableBytes ?? (() => availableBytesAt(options.workDirectory)))()
  ensureSafeInteger(availableBytes, 'Available storage')
  const retainedBytesAlreadyPresent = await compactRetainedStateBytes(options.workDirectory)
  const preflight = assessCompactV3Storage(plan, availableBytes, {
    executionPurpose,
    retainedBytesAlreadyPresent,
  })
  if (!preflight.safeToStart) throw new Error(`Compact v3 preflight blocked: ${preflight.reasonCode}`)

  const now = options.now ?? (() => new Date())
  const basePaths = pathsFor(options.workDirectory, plan.archive.archiveId, options.pass)
  const stagingNonce = randomBytes(16).toString('hex')
  const paths: ManagedPaths = {
    ...basePaths,
    outputPartial: `${basePaths.outputPartial}.${stagingNonce}`,
    receiptPartial: `${basePaths.receiptPartial}.${stagingNonce}`,
  }
  await mkdir(paths.archiveDirectory, { recursive: true })
  const releaseLock = await acquireLock(paths.lock, plan.archive.archiveId, isoTime(now))
  let sink: BoundedArtifactFileSink | null = null
  try {
    const loaded = await readVerifiedCompactCheckpoint(options.workDirectory, plan)
    const checkpoint = loaded ?? emptyCheckpoint(plan, isoTime(now))
    const alreadyCommitted = existingReceiptFor(checkpoint, options.pass)
    if (alreadyCommitted) {
      return {
        status: 'already-committed',
        receipt: alreadyCommitted,
        receiptSha256: receiptDigest(alreadyCommitted),
        checkpoint,
        preflight,
      }
    }
    if (options.pass === 'exact' && resumeAction(checkpoint) !== 'exact') {
      throw new Error('Exact pass cannot start before the candidate pass commits')
    }

    sink = new BoundedArtifactFileSink(paths.outputPartial, plan.bounds.atomicPromotionMaxBytes)
    await sink.start()
    const input = new VerifiedCompressedInput(
      await options.openCompressedInput(),
      plan.archive.compressedBytes,
      plan.archive.sha256,
    )
    const startedAt = isoTime(now)
    const summary = await options.process({ input, output: sink })
    if (summary.pass !== options.pass) throw new Error(`Processor returned ${summary.pass} for a ${options.pass} pass`)
    const verifiedInput = input.verify()
    const remoteAcquisition = options.remoteInputAcquisition?.()
    const stagedOutput = await sink.finish()
    sink = null
    const outputPath = relativeOutputPath(
      plan.archive.archiveId,
      options.pass,
      stagedOutput.sha256,
      extension,
    )
    const completedAt = isoTime(now)
    const receipt = receiptFor(
      options,
      summary,
      startedAt,
      completedAt,
      verifiedInput,
      { path: outputPath, ...stagedOutput },
      remoteAcquisition,
    )

    const digest = receiptDigest(receipt)
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8')
    if (createHash('sha256').update(receiptBytes).digest('hex') !== digest) {
      throw new Error('Receipt canonicalization is inconsistent')
    }
    const nextCheckpoint = CompactArchiveCheckpointSchema.parse({
      ...checkpoint,
      candidateReceipt: options.pass === 'candidate' ? receipt : checkpoint.candidateReceipt,
      exactReceipt: options.pass === 'exact' ? receipt : checkpoint.exactReceipt,
      updatedAt: completedAt,
    })
    const nextCheckpointBytes = checkpointBytes(nextCheckpoint)
    const destination = absoluteArtifactPath(options.workDirectory, outputPath)
    const receiptDestination = absoluteArtifactPath(
      options.workDirectory,
      receiptRelativePath(plan.archive.archiveId, digest),
    )
    const additionalIfMissing = async (path: string, bytes: number): Promise<number> => {
      try {
        await withValidatedRegularFile(
          path,
          { label: 'Existing promoted compact artifact', maximumBytes: Number.MAX_SAFE_INTEGER },
          async () => undefined,
        )
        return 0
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return bytes
        throw error
      }
    }
    let currentCheckpointBytes = 0
    try {
      currentCheckpointBytes = await withValidatedRegularFile(
        paths.checkpoint,
        { label: 'Current compact checkpoint', maximumBytes: plan.bounds.checkpointMaxBytes },
        async (file) => file.size,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const permanentDelta = [
      await additionalIfMissing(destination, stagedOutput.bytes),
      await additionalIfMissing(receiptDestination, receiptBytes.byteLength),
      Math.max(0, nextCheckpointBytes.byteLength - currentCheckpointBytes),
    ].reduce((sum, bytes) => sum + bytes, 0)
    if (
      !Number.isSafeInteger(permanentDelta) ||
      retainedBytesAlreadyPresent + permanentDelta > plan.bounds.retainedCorpusMaxBytes
    ) {
      throw new Error('Compact promotion would exceed the corpus-wide retained-state hard cap')
    }

    await promoteContentAddressed(paths.outputPartial, destination, stagedOutput.bytes, stagedOutput.sha256)
    await writeAndSync(paths.receiptPartial, receiptBytes, plan.bounds.checkpointMaxBytes)
    await promoteContentAddressed(
      paths.receiptPartial,
      receiptDestination,
      receiptBytes.byteLength,
      digest,
    )
    await atomicReplace(paths.checkpoint, nextCheckpointBytes, plan.bounds.checkpointMaxBytes)
    return { status: 'promoted', receipt, receiptSha256: digest, checkpoint: nextCheckpoint, preflight }
  } catch (error) {
    if (sink !== null) await sink.abort()
    await rm(paths.outputPartial, { force: true })
    await rm(paths.receiptPartial, { force: true })
    throw error
  } finally {
    await releaseLock()
  }
}

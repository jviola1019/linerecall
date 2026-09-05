#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { open, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { approvedCompactCorpusFromBytes } from './compact-v3-manifest.ts'
import { openValidatedRegularFile } from './compact-v3-orchestrator.ts'
import { createSourceSnapshot } from '../release/lib/source-snapshot.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024
const MAX_REDIRECTS = 3
const REQUEST_TIMEOUT_MS = 30_000
const READ_CHUNK_BYTES = 64 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const SafeHeaderSchema = z.string().min(1).max(512).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  'Observed response metadata contains control characters',
)

const ObservedArchiveSchema = z.object({
  archiveId: z.string().regex(/^broadcast-\d{4}-(?:0[1-9]|1[0-2])$/u),
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
  filename: z.string().regex(/^lichess_db_broadcast_\d{4}-(?:0[1-9]|1[0-2])\.pgn\.zst$/u),
  approvedUrl: z.string().url().startsWith('https://database.lichess.org/broadcast/'),
  approvedSha256: z.string().regex(SHA256),
  observation: z.object({
    method: z.literal('HEAD'),
    requestedUrl: z.string().url().startsWith('https://database.lichess.org/broadcast/'),
    finalUrl: z.string().url().startsWith('https://database.lichess.org/'),
    redirectCount: z.number().int().min(0).max(MAX_REDIRECTS),
    contentLength: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
    etagObserved: SafeHeaderSchema,
    lastModifiedObserved: SafeHeaderSchema,
    retrievedAt: z.string().datetime({ offset: true }),
  }).strict(),
  localVerification: z.discriminatedUnion('status', [
    z.object({ status: z.literal('not-requested') }).strict(),
    z.object({
      status: z.literal('verified'),
      filename: z.string().min(1).max(255),
      bytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
      sha256: z.string().regex(SHA256),
    }).strict(),
  ]),
}).strict().superRefine((archive, context) => {
  if (archive.observation.requestedUrl !== archive.approvedUrl) {
    context.addIssue({ code: 'custom', path: ['observation', 'requestedUrl'], message: 'HEAD request must use the approved URL' })
  }
  if (archive.localVerification.status === 'verified' && (
    archive.localVerification.filename !== archive.filename
    || archive.localVerification.sha256 !== archive.approvedSha256
    || archive.localVerification.bytes !== archive.observation.contentLength
  )) {
    context.addIssue({ code: 'custom', path: ['localVerification'], message: 'Local verification differs from the approved or observed identity' })
  }
})

export const PendingBroadcastMetadataInventorySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('linerecall-broadcast-metadata-observation'),
  reviewStatus: z.literal('pending'),
  releaseEligible: z.literal(false),
  sourceId: z.literal('lichess-broadcasts'),
  sourceManifestSha256: z.string().regex(SHA256),
  sourceSnapshotSha256: z.string().regex(SHA256),
  observedAt: z.string().datetime({ offset: true }),
  policy: z.object({
    method: z.literal('HEAD'),
    concurrency: z.literal(1),
    requestTimeoutMs: z.literal(REQUEST_TIMEOUT_MS),
    maximumRedirects: z.literal(MAX_REDIRECTS),
    maximumResponseHeaderBytes: z.literal(MAX_RESPONSE_HEADER_BYTES),
    maximumArchiveBytes: z.literal(MAX_ARCHIVE_BYTES),
    redirectHostPolicy: z.literal('same-approved-host-https-default-port'),
    networkDateHeaderRetained: z.literal(false),
  }).strict(),
  archiveCount: z.literal(78),
  archives: z.array(ObservedArchiveSchema).length(78),
  note: z.literal('Pending metadata observation only. It does not amend the approved manifest or authorize ingestion.'),
}).strict().superRefine((inventory, context) => {
  if (new Set(inventory.archives.map(({ archiveId }) => archiveId)).size !== inventory.archives.length) {
    context.addIssue({ code: 'custom', path: ['archives'], message: 'Archive observations must be unique' })
  }
})

export type PendingBroadcastMetadataInventory = z.infer<typeof PendingBroadcastMetadataInventorySchema>

export interface BroadcastHeadRequest {
  url: string
  signal: AbortSignal
}

export interface BroadcastHeadResponse {
  statusCode: number
  headers: Record<string, string | readonly string[] | undefined>
  bodyBytes: number
}

export type BroadcastHeadTransport = (request: BroadcastHeadRequest) => Promise<BroadcastHeadResponse>

export interface ObserveBroadcastMetadataOptions {
  manifestBytes: Uint8Array
  observedAt: string
  sourceSnapshotSha256: string
  localArchiveDirectory?: string
  transport?: BroadcastHeadTransport
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function singleHeader(
  headers: BroadcastHeadResponse['headers'],
  name: string,
  required = true,
): string | null {
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === name.toLowerCase())
  if (entries.length > 1) throw new Error(`HEAD response repeats ${name}`)
  const value = entries[0]?.[1]
  if (value === undefined) {
    if (required) throw new Error(`HEAD response is missing ${name}`)
    return null
  }
  if (Array.isArray(value)) {
    if (value.length !== 1 || typeof value[0] !== 'string') throw new Error(`HEAD response has ambiguous ${name}`)
    return SafeHeaderSchema.parse(value[0])
  }
  return SafeHeaderSchema.parse(value)
}

function headerBytes(headers: BroadcastHeadResponse['headers']): number {
  let total = 0
  for (const [name, rawValue] of Object.entries(headers)) {
    const values = Array.isArray(rawValue) ? rawValue : rawValue === undefined ? [] : [rawValue]
    for (const value of values) {
      total += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8') + 4
      if (total > MAX_RESPONSE_HEADER_BYTES) throw new Error('HEAD response headers exceed the byte limit')
    }
  }
  return total
}

function checkedUrl(value: string, approved: URL): URL {
  const url = new URL(value, approved)
  if (
    url.protocol !== 'https:'
    || url.hostname !== approved.hostname
    || (url.port !== '' && url.port !== '443')
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
  ) {
    throw new Error('HEAD redirect leaves the approved HTTPS host boundary')
  }
  return url
}

async function requestWithTimeout(
  transport: BroadcastHeadTransport,
  url: string,
): Promise<BroadcastHeadResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('HEAD request timed out')), REQUEST_TIMEOUT_MS)
  try {
    return await transport({ url, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error('HEAD request timed out')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function observeHead(
  approvedUrl: string,
  transport: BroadcastHeadTransport,
): Promise<{
  finalUrl: string
  redirectCount: number
  contentLength: number
  etagObserved: string
  lastModifiedObserved: string
}> {
  const approved = new URL(approvedUrl)
  let current = approved
  let redirectCount = 0
  for (;;) {
    const response = await requestWithTimeout(transport, current.href)
    headerBytes(response.headers)
    if (!Number.isSafeInteger(response.bodyBytes) || response.bodyBytes < 0 || response.bodyBytes > 0) {
      throw new Error('HEAD response unexpectedly contained a body')
    }
    if (REDIRECT_STATUSES.has(response.statusCode)) {
      if (redirectCount >= MAX_REDIRECTS) throw new Error('HEAD response exceeds the redirect limit')
      const location = singleHeader(response.headers, 'location')
      current = checkedUrl(location!, approved)
      redirectCount += 1
      continue
    }
    if (response.statusCode !== 200) throw new Error(`HEAD response returned HTTP ${response.statusCode}`)
    const contentLengthText = singleHeader(response.headers, 'content-length')!
    if (!/^\d+$/u.test(contentLengthText)) throw new Error('HEAD Content-Length is not a decimal integer')
    const contentLength = Number(contentLengthText)
    if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > MAX_ARCHIVE_BYTES) {
      throw new Error('HEAD Content-Length is outside the archive byte limit')
    }
    return {
      finalUrl: current.href,
      redirectCount,
      contentLength,
      etagObserved: singleHeader(response.headers, 'etag')!,
      lastModifiedObserved: singleHeader(response.headers, 'last-modified')!,
    }
  }
}

async function verifyLocalArchive(
  directory: string,
  filename: string,
  expectedSha256: string,
): Promise<{ status: 'verified'; filename: string; bytes: number; sha256: string }> {
  if (basename(filename) !== filename) throw new Error('Approved archive filename contains a path')
  const path = join(resolve(directory), filename)
  const validated = await openValidatedRegularFile(path, {
    label: `Local broadcast archive ${filename}`,
    maximumBytes: MAX_ARCHIVE_BYTES,
    minimumBytes: 1,
  })
  const hash = createHash('sha256')
  try {
    let offset = 0
    const chunk = Buffer.alloc(READ_CHUNK_BYTES)
    while (offset < validated.size) {
      const result = await validated.handle.read(chunk, 0, Math.min(chunk.byteLength, validated.size - offset), offset)
      if (result.bytesRead < 1) throw new Error(`Local broadcast archive ${filename} changed while hashing`)
      hash.update(chunk.subarray(0, result.bytesRead))
      offset += result.bytesRead
    }
    if (await validated.changed()) throw new Error(`Local broadcast archive ${filename} changed while hashing`)
  } finally {
    await validated.close()
  }
  const actualSha256 = hash.digest('hex')
  if (actualSha256 !== expectedSha256) throw new Error(`Local broadcast archive ${filename} failed SHA-256 verification`)
  return { status: 'verified', filename, bytes: validated.size, sha256: actualSha256 }
}

export async function observePendingBroadcastMetadata(
  options: ObserveBroadcastMetadataOptions,
): Promise<PendingBroadcastMetadataInventory> {
  const observedAt = z.string().datetime({ offset: true }).parse(options.observedAt)
  if (!SHA256.test(options.sourceSnapshotSha256)) throw new Error('Source snapshot must be a lowercase SHA-256 digest')
  const corpus = approvedCompactCorpusFromBytes(options.manifestBytes, 'lichess-broadcasts')
  if (corpus.archives.length !== 78) throw new Error('Broadcast metadata observation requires all 78 approved archives')
  const transport = options.transport ?? defaultBroadcastHeadTransport
  const archives: z.infer<typeof ObservedArchiveSchema>[] = []
  // Deliberately sequential: the next HEAD request cannot begin until the
  // current response and optional local digest have both completed.
  for (const archive of corpus.archives) {
    const observation = await observeHead(archive.url, transport)
    const localVerification = options.localArchiveDirectory
      ? await verifyLocalArchive(options.localArchiveDirectory, archive.filename, archive.sha256)
      : { status: 'not-requested' as const }
    archives.push(ObservedArchiveSchema.parse({
      archiveId: `broadcast-${archive.month}`,
      month: archive.month,
      filename: archive.filename,
      approvedUrl: archive.url,
      approvedSha256: archive.sha256,
      observation: {
        method: 'HEAD',
        requestedUrl: archive.url,
        finalUrl: observation.finalUrl,
        redirectCount: observation.redirectCount,
        contentLength: observation.contentLength,
        etagObserved: observation.etagObserved,
        lastModifiedObserved: observation.lastModifiedObserved,
        retrievedAt: observedAt,
      },
      localVerification,
    }))
  }
  return PendingBroadcastMetadataInventorySchema.parse({
    schemaVersion: 1,
    kind: 'linerecall-broadcast-metadata-observation',
    reviewStatus: 'pending',
    releaseEligible: false,
    sourceId: 'lichess-broadcasts',
    sourceManifestSha256: corpus.sourceManifestSha256,
    sourceSnapshotSha256: options.sourceSnapshotSha256,
    observedAt,
    policy: {
      method: 'HEAD',
      concurrency: 1,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maximumRedirects: MAX_REDIRECTS,
      maximumResponseHeaderBytes: MAX_RESPONSE_HEADER_BYTES,
      maximumArchiveBytes: MAX_ARCHIVE_BYTES,
      redirectHostPolicy: 'same-approved-host-https-default-port',
      networkDateHeaderRetained: false,
    },
    archiveCount: 78,
    archives,
    note: 'Pending metadata observation only. It does not amend the approved manifest or authorize ingestion.',
  })
}

export const defaultBroadcastHeadTransport: BroadcastHeadTransport = async ({ url, signal }) => {
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'manual',
    signal,
    headers: { 'accept-encoding': 'identity' },
  })
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => { headers[name] = value })
  let bodyBytes = 0
  if (response.body !== null) {
    const reader = response.body.getReader()
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        bodyBytes += result.value.byteLength
        if (bodyBytes > 0) break
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }
  return { statusCode: response.status, headers, bodyBytes }
}

interface CliArguments {
  manifestPath: string
  outputPath: string
  observedAt: string
  sourceSnapshotSha256: string
  localArchiveDirectory?: string
}

function cliArguments(argv: readonly string[]): CliArguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid option near ${name ?? '<end>'}`)
    const key = name.slice(2)
    if (values.has(key)) throw new Error(`Duplicate option ${name}`)
    values.set(key, value)
  }
  const required = ['manifest', 'output', 'observed-at', 'source-snapshot-sha256']
  for (const key of required) if (!values.get(key)) throw new Error(`Missing --${key}`)
  const allowed = new Set([...required, 'local-archives-dir'])
  if ([...values.keys()].some((key) => !allowed.has(key))) throw new Error('Unknown broadcast metadata option')
  return {
    manifestPath: resolve(values.get('manifest')!),
    outputPath: resolve(values.get('output')!),
    observedAt: values.get('observed-at')!,
    sourceSnapshotSha256: values.get('source-snapshot-sha256')!,
    ...(values.get('local-archives-dir') ? { localArchiveDirectory: resolve(values.get('local-archives-dir')!) } : {}),
  }
}

async function main(): Promise<void> {
  const args = cliArguments(process.argv.slice(2))
  const currentSnapshot = await createSourceSnapshot()
  if (currentSnapshot.treeSha256 !== args.sourceSnapshotSha256) {
    throw new Error(`Source snapshot is stale; current tree SHA-256 is ${currentSnapshot.treeSha256}`)
  }
  const manifestBytes = await readFile(args.manifestPath)
  const inventory = await observePendingBroadcastMetadata({
    manifestBytes,
    observedAt: args.observedAt,
    sourceSnapshotSha256: args.sourceSnapshotSha256,
    ...(args.localArchiveDirectory ? { localArchiveDirectory: args.localArchiveDirectory } : {}),
  })
  const bytes = canonicalBytes(inventory)
  const output = await open(args.outputPath, 'wx', 0o600)
  try {
    await output.writeFile(bytes)
    await output.sync()
  } finally {
    await output.close()
  }
  process.stdout.write(`${JSON.stringify({
    result: 'pending-broadcast-metadata-observed',
    output: args.outputPath,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    archiveCount: inventory.archiveCount,
    reviewStatus: inventory.reviewStatus,
    releaseEligible: inventory.releaseEligible,
  }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Broadcast metadata observation failed: ${(error as Error).message}\n`)
    process.exitCode = 1
  })
}

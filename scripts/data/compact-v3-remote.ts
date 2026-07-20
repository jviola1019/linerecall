import type { LookupAddress } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'
import { open, lstat, readFile, rm } from 'node:fs/promises'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CompactRemoteInputAcquisitionSchema,
  type CompactRemoteInputAcquisition,
} from './compact-v3-contracts.ts'

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_IDLE_TIMEOUT_MS = 120_000
const DEFAULT_OVERALL_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_REDIRECTS = 3

const blockedAddresses = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv4')

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fec0::', 10],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv6')

export interface CompactRemoteTimeouts {
  connectMs: number
  idleMs: number
  overallMs: number
}

export interface CompactRemoteTransportResponse {
  statusCode: number
  headers: Readonly<Record<string, string | readonly string[] | undefined>>
  body: AsyncIterable<Uint8Array>
  remoteAddress: string
  abort(reason?: Error): void
}

export interface CompactRemoteTransportRequest {
  url: URL
  addresses: readonly LookupAddress[]
  signal: AbortSignal
  timeouts: CompactRemoteTimeouts
}

export type CompactRemoteResolver = (hostname: string) => Promise<readonly LookupAddress[]>
export type CompactRemoteTransport = (
  request: CompactRemoteTransportRequest,
) => Promise<CompactRemoteTransportResponse>

export interface CompactRemoteTestSeams {
  resolver?: CompactRemoteResolver
  transport?: CompactRemoteTransport
  now?: () => Date
  timeouts?: Partial<CompactRemoteTimeouts>
  maximumRedirects?: number
}

export interface ApprovedHttpsArchiveInputOptions {
  approvedUrl: string
  expectedBytes: number
  approvedEtag: string | null
  approvedLastModified: string | null
  testSeams?: CompactRemoteTestSeams
}

export interface ApprovedHttpsArchiveInput {
  input: AsyncIterable<Uint8Array>
  receipt(): CompactRemoteInputAcquisition
}

export class CompactRemoteArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null = null,
    options?: ErrorOptions,
  ) {
    super(
      `${message} ${retryable
        ? 'Retry the same archive pass from byte zero; partial output was not committed.'
        : 'Correct the approved source or policy before retrying.'}`,
      options,
    )
    this.name = 'CompactRemoteArchiveError'
  }
}

function positiveTimeout(value: number | undefined, fallback: number, field: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 7 * 24 * 60 * 60 * 1_000) {
    throw new Error(`${field} must be a positive bounded integer`)
  }
  return selected
}

function timeoutsFor(seams: CompactRemoteTestSeams | undefined): CompactRemoteTimeouts {
  return {
    connectMs: positiveTimeout(seams?.timeouts?.connectMs, DEFAULT_CONNECT_TIMEOUT_MS, 'Connect timeout'),
    idleMs: positiveTimeout(seams?.timeouts?.idleMs, DEFAULT_IDLE_TIMEOUT_MS, 'Idle timeout'),
    overallMs: positiveTimeout(seams?.timeouts?.overallMs, DEFAULT_OVERALL_TIMEOUT_MS, 'Overall timeout'),
  }
}

function approvedUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new CompactRemoteArchiveError('invalid_approved_url', 'Approved archive URL is invalid.', false, null, { cause })
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.hash !== '' || url.port !== '' || url.href !== value
  ) {
    throw new CompactRemoteArchiveError(
      'invalid_approved_url',
      'Archive input must be the exact canonical HTTPS URL with no credentials, fragment, or custom port.',
      false,
    )
  }
  return url
}

export function assertPublicCompactRemoteAddress(address: string): void {
  const family = isIP(address)
  if (family !== 4 && family !== 6) {
    throw new CompactRemoteArchiveError('invalid_dns_address', 'DNS returned a non-IP address.', false)
  }
  if (family === 6 && /^::ffff:/iu.test(address)) {
    throw new CompactRemoteArchiveError(
      'blocked_dns_address',
      `DNS resolved the approved archive host to a mapped address (${address}).`,
      false,
    )
  }
  if (blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new CompactRemoteArchiveError(
      'blocked_dns_address',
      `DNS resolved the approved archive host to a non-public address (${address}).`,
      false,
    )
  }
}

function validateResolvedAddresses(values: readonly LookupAddress[]): LookupAddress[] {
  if (values.length === 0 || values.length > 32) {
    throw new CompactRemoteArchiveError('invalid_dns_result', 'DNS must return between one and 32 addresses.', true)
  }
  const result: LookupAddress[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if ((value.family !== 4 && value.family !== 6) || typeof value.address !== 'string') {
      throw new CompactRemoteArchiveError('invalid_dns_address', 'DNS returned an invalid address family.', false)
    }
    assertPublicCompactRemoteAddress(value.address)
    const identity = `${value.family}:${value.address}`
    if (!seen.has(identity)) {
      seen.add(identity)
      result.push({ address: value.address, family: value.family })
    }
  }
  return result
}

async function defaultResolver(hostname: string): Promise<readonly LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

function nodeHeaders(headers: IncomingHttpHeaders): Record<string, string | readonly string[] | undefined> {
  return { ...headers }
}

async function defaultTransport(
  context: CompactRemoteTransportRequest,
): Promise<CompactRemoteTransportResponse> {
  return new Promise((resolve, reject) => {
    let responseReceived = false
    let connectTimer: NodeJS.Timeout | null = null
    const addresses = [...context.addresses]
    const lookup: LookupFunction = (_hostname, options, callback) => {
      const family = options.family === 4 || options.family === 6 ? options.family : 0
      const eligible = family === 0 ? addresses : addresses.filter((address) => address.family === family)
      if (eligible.length === 0) {
        const error = new Error('No vetted DNS address matches the requested family') as NodeJS.ErrnoException
        error.code = 'ENOTFOUND'
        callback(error, '')
        return
      }
      if (options.all) callback(null, eligible)
      else callback(null, eligible[0]!.address, eligible[0]!.family)
    }
    const request = httpsRequest(context.url, {
      method: 'GET',
      agent: false,
      servername: context.url.hostname,
      lookup,
      signal: context.signal,
      maxHeaderSize: 16 * 1024,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      headers: {
        accept: 'application/octet-stream',
        'accept-encoding': 'identity',
        'user-agent': 'LineRecall-compact-v3/1 (+https://github.com/jviola1019/linerecall)',
      },
    }, (response: IncomingMessage) => {
      responseReceived = true
      if (connectTimer) clearTimeout(connectTimer)
      response.setTimeout(context.timeouts.idleMs, () => {
        response.destroy(new CompactRemoteArchiveError('idle_timeout', 'Remote archive stream became idle.', true))
      })
      const remoteAddress = response.socket.remoteAddress
      if (!remoteAddress) {
        response.destroy()
        reject(new CompactRemoteArchiveError('missing_remote_address', 'TLS peer address is unavailable.', true))
        return
      }
      resolve({
        statusCode: response.statusCode ?? 0,
        headers: nodeHeaders(response.headers),
        body: response,
        remoteAddress,
        abort(reason) {
          response.destroy(reason)
          request.destroy(reason)
        },
      })
    })
    connectTimer = setTimeout(() => {
      request.destroy(new CompactRemoteArchiveError('connect_timeout', 'Remote archive connection timed out.', true))
    }, context.timeouts.connectMs)
    request.setTimeout(context.timeouts.idleMs, () => {
      request.destroy(new CompactRemoteArchiveError('idle_timeout', 'Remote archive request became idle.', true))
    })
    request.once('error', (cause) => {
      if (connectTimer) clearTimeout(connectTimer)
      if (!responseReceived) reject(cause)
    })
    request.end()
  })
}

function singleHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | null {
  const value = headers[name]
  if (value === undefined) return null
  if (Array.isArray(value)) {
    if (value.length !== 1 || value[0] === undefined) {
      throw new CompactRemoteArchiveError('ambiguous_response_header', `Response ${name} header is ambiguous.`, false)
    }
    return value[0]
  }
  return value as string
}

function receiptHeader(value: string | null, name: string): string | null {
  if (value === null) return null
  if (value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CompactRemoteArchiveError('invalid_response_header', `Response ${name} header is invalid.`, false)
  }
  return value
}

function retryAfterSeconds(headers: CompactRemoteTransportResponse['headers']): number | null {
  const value = singleHeader(headers, 'retry-after')
  if (value === null) return null
  if (/^\d+$/u.test(value)) return Math.min(Number(value), 24 * 60 * 60)
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return null
  return Math.max(0, Math.min(Math.ceil((date - Date.now()) / 1_000), 24 * 60 * 60))
}

function retryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 ||
    statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

let activeRemoteArchiveStream = false

interface RemoteStreamLock {
  schemaVersion: 1
  pid: number
  hostname: string
  createdAt: string
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

async function acquireRemoteStreamLease(testMode: boolean): Promise<() => Promise<void>> {
  if (activeRemoteArchiveStream) {
    throw new CompactRemoteArchiveError('concurrent_download', 'Only one remote archive stream may run.', true)
  }
  activeRemoteArchiveStream = true
  const path = join(
    tmpdir(),
    testMode
      ? `linerecall-compact-v3-approved-https-${process.pid}.lock`
      : 'linerecall-compact-v3-approved-https.lock',
  )
  const record: RemoteStreamLock = {
    schemaVersion: 1,
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  }
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, 'wx', 0o600)
        try {
          await handle.writeFile(bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
        return async () => {
          try {
            const current = await readFile(path)
            if (current.equals(bytes)) await rm(path, { force: true })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          } finally {
            activeRemoteArchiveStream = false
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let existing: RemoteStreamLock
        let observed: Buffer
        try {
          const details = await lstat(path)
          if (!details.isFile() || details.isSymbolicLink() || details.size > 2_048) {
            throw new Error('invalid remote stream lock')
          }
          observed = await readFile(path)
          existing = JSON.parse(observed.toString('utf8')) as RemoteStreamLock
        } catch (cause) {
          throw new CompactRemoteArchiveError(
            'corrupt_download_lock',
            'Remote archive concurrency lock is corrupt; inspect it before retrying.',
            false,
            null,
            { cause },
          )
        }
        if (
          existing.schemaVersion !== 1 || existing.hostname !== hostname() ||
          processExists(existing.pid)
        ) {
          throw new CompactRemoteArchiveError(
            'concurrent_download',
            'Another remote archive stream holds the host-wide concurrency lock.',
            true,
          )
        }
        if (!(await readFile(path)).equals(observed)) {
          throw new CompactRemoteArchiveError(
            'download_lock_changed',
            'Remote archive concurrency lock changed during stale-lock recovery.',
            true,
          )
        }
        await rm(path, { force: true })
      }
    }
    throw new CompactRemoteArchiveError('concurrent_download', 'Could not acquire remote archive lock.', true)
  } catch (error) {
    activeRemoteArchiveStream = false
    throw error
  }
}

/**
 * Open one approved archive as a non-restartable stream. There is no automatic
 * retry: any interruption invalidates the pass, and the adapter replays the
 * archive from byte zero on the next explicit invocation.
 */
export function createApprovedHttpsArchiveInput(
  options: ApprovedHttpsArchiveInputOptions,
): ApprovedHttpsArchiveInput {
  const canonicalUrl = approvedUrl(options.approvedUrl)
  if (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 1) {
    throw new Error('Approved remote archive byte length must be a positive safe integer')
  }
  const seams = options.testSeams
  const resolver = seams?.resolver ?? defaultResolver
  const transport = seams?.transport ?? defaultTransport
  const now = seams?.now ?? (() => new Date())
  const timeouts = timeoutsFor(seams)
  const maximumRedirects = seams?.maximumRedirects ?? DEFAULT_MAX_REDIRECTS
  if (!Number.isSafeInteger(maximumRedirects) || maximumRedirects < 0 || maximumRedirects > 3) {
    throw new Error('Maximum redirects must be between zero and three')
  }
  let acquisition: CompactRemoteInputAcquisition | null = null

  async function* stream(): AsyncGenerator<Uint8Array> {
    const releaseRemoteStreamLease = await acquireRemoteStreamLease(seams !== undefined)
    const abort = new AbortController()
    let currentResponse: CompactRemoteTransportResponse | null = null
    const overallTimer = setTimeout(() => {
      const error = new CompactRemoteArchiveError(
        'overall_timeout',
        'Remote archive pass exceeded its overall timeout.',
        true,
      )
      abort.abort(error)
      currentResponse?.abort(error)
    }, timeouts.overallMs)
    try {
      let currentUrl = canonicalUrl
      let redirects = 0
      while (true) {
        const addresses = validateResolvedAddresses(await withAbort(resolver(currentUrl.hostname), abort.signal))
        currentResponse = await withAbort(transport({
          url: currentUrl,
          addresses,
          signal: abort.signal,
          timeouts,
        }), abort.signal)
        assertPublicCompactRemoteAddress(currentResponse.remoteAddress)
        if (!addresses.some((address) => address.address === currentResponse!.remoteAddress)) {
          throw new CompactRemoteArchiveError(
            'dns_rebinding_detected',
            'TLS connected to an address outside the vetted DNS result.',
            false,
          )
        }
        const status = currentResponse.statusCode
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = singleHeader(currentResponse.headers, 'location')
          currentResponse.abort()
          currentResponse = null
          if (location === null) {
            throw new CompactRemoteArchiveError('redirect_without_location', 'Redirect response omitted Location.', false)
          }
          let target: URL
          try {
            target = new URL(location, currentUrl)
          } catch (cause) {
            throw new CompactRemoteArchiveError('invalid_redirect', 'Redirect target is invalid.', false, null, { cause })
          }
          if (target.href !== canonicalUrl.href) {
            throw new CompactRemoteArchiveError(
              'redirect_not_allowlisted',
              'Redirect target is not the exact approved HTTPS archive URL.',
              false,
            )
          }
          redirects += 1
          if (redirects > maximumRedirects) {
            throw new CompactRemoteArchiveError('redirect_limit', 'Remote archive exceeded its redirect limit.', false)
          }
          currentUrl = target
          continue
        }
        if (status !== 200) {
          const retryable = retryableStatus(status)
          const retryAfter = status === 429 ? retryAfterSeconds(currentResponse.headers) : null
          currentResponse.abort()
          currentResponse = null
          throw new CompactRemoteArchiveError(
            `http_${status}`,
            `Remote archive returned HTTP ${status}.`,
            retryable,
            retryAfter,
          )
        }
        const encoding = singleHeader(currentResponse.headers, 'content-encoding')
        if (encoding !== null && encoding.toLowerCase() !== 'identity') {
          throw new CompactRemoteArchiveError('content_encoding', 'Remote archive response changed the approved bytes.', false)
        }
        const contentLength = singleHeader(currentResponse.headers, 'content-length')
        if (contentLength !== null && (
          !/^\d+$/u.test(contentLength) || Number(contentLength) !== options.expectedBytes
        )) {
          throw new CompactRemoteArchiveError(
            'content_length_mismatch',
            `Response length does not match the approved ${options.expectedBytes} bytes.`,
            false,
          )
        }
        const etag = receiptHeader(singleHeader(currentResponse.headers, 'etag'), 'ETag')
        const lastModified = receiptHeader(
          singleHeader(currentResponse.headers, 'last-modified'),
          'Last-Modified',
        )
        if (options.approvedEtag !== null && etag !== options.approvedEtag) {
          throw new CompactRemoteArchiveError('etag_mismatch', 'Response ETag differs from the approved manifest.', false)
        }
        if (options.approvedLastModified !== null && lastModified !== options.approvedLastModified) {
          throw new CompactRemoteArchiveError(
            'last_modified_mismatch',
            'Response Last-Modified differs from the approved manifest.',
            false,
          )
        }
        let bytes = 0
        const responseIterator = currentResponse.body[Symbol.asyncIterator]()
        while (true) {
          const nextChunk = await withAbort(Promise.resolve(responseIterator.next()), abort.signal)
          if (nextChunk.done) break
          if (abort.signal.aborted) throw abort.signal.reason
          const chunk = Buffer.from(nextChunk.value)
          const next = bytes + chunk.byteLength
          if (!Number.isSafeInteger(next) || next > options.expectedBytes) {
            throw new CompactRemoteArchiveError(
              'response_too_large',
              `Remote response exceeded the approved ${options.expectedBytes}-byte cap.`,
              false,
            )
          }
          bytes = next
          yield chunk
        }
        if (bytes !== options.expectedBytes) {
          throw new CompactRemoteArchiveError(
            'response_too_short',
            `Remote response ended at ${bytes} of ${options.expectedBytes} approved bytes.`,
            true,
          )
        }
        const retrievedAt = now()
        if (!Number.isFinite(retrievedAt.getTime())) throw new Error('Remote retrieval clock returned an invalid date')
        acquisition = CompactRemoteInputAcquisitionSchema.parse({
          transport: 'approved-https',
          requestedUrl: canonicalUrl.href,
          finalUrl: currentUrl.href,
          redirectCount: redirects,
          retrievedAt: retrievedAt.toISOString(),
          etagObserved: etag,
          lastModifiedObserved: lastModified,
        })
        currentResponse = null
        return
      }
    } catch (cause) {
      if (cause instanceof CompactRemoteArchiveError) throw cause
      if (abort.signal.aborted && abort.signal.reason instanceof Error) throw abort.signal.reason
      throw new CompactRemoteArchiveError(
        'network_failure',
        `Remote archive stream failed: ${cause instanceof Error ? cause.message : 'unknown error'}.`,
        true,
        null,
        { cause },
      )
    } finally {
      clearTimeout(overallTimer)
      currentResponse?.abort()
      await releaseRemoteStreamLease()
    }
  }

  return {
    input: stream(),
    receipt() {
      if (acquisition === null) {
        throw new Error('Remote acquisition receipt is unavailable until the stream completes')
      }
      return acquisition
    },
  }
}

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  BROADCAST_CHECKSUMS_URL,
  BROADCAST_CUTOFF_MONTH,
  BROADCAST_LICENSE,
  BROADCAST_LICENSE_URL,
  BROADCAST_LIST_URL,
  BROADCAST_SCHEMA_VERSION,
  BROADCAST_START_MONTH,
  assertBroadcastManifest,
  isMonth,
  type BroadcastArchive,
  type BroadcastManifestV1,
} from './broadcast-contracts.ts'

const ARCHIVE_PATTERN = /^lichess_db_broadcast_(\d{4}-(?:0[1-9]|1[0-2]))\.pgn\.zst$/

export type FetchLike = typeof fetch

export function parseDownloadList(text: string): Map<string, string> {
  const urls = new Map<string, string>()
  for (const token of text.split(/\s+/).filter(Boolean)) {
    let url: URL
    try {
      url = new URL(token)
    } catch {
      throw new Error(`Invalid URL in official broadcast list: ${token}`)
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'database.lichess.org' ||
      url.pathname.split('/').filter(Boolean).length !== 2 ||
      !url.pathname.startsWith('/broadcast/')
    ) {
      throw new Error(`Unapproved URL in official broadcast list: ${token}`)
    }
    const filename = basename(url.pathname)
    if (!ARCHIVE_PATTERN.test(filename)) {
      throw new Error(`Unexpected filename in official broadcast list: ${filename}`)
    }
    if (urls.has(filename)) throw new Error(`Duplicate archive in broadcast list: ${filename}`)
    url.search = ''
    url.hash = ''
    urls.set(filename, url.toString())
  }
  return urls
}

export function parseSha256Sums(text: string): Map<string, string> {
  const checksums = new Map<string, string>()
  const normalized = text.replace(/\r\n/g, '\n').trim()
  const matches = normalized.matchAll(
    /(?:^|\n)([a-fA-F0-9]{64})\s+\*?(lichess_db_broadcast_\d{4}-(?:0[1-9]|1[0-2])\.pgn\.zst)(?=\s|$)/g,
  )
  for (const match of matches) {
    const sha256 = match[1]?.toLowerCase()
    const filename = match[2]
    if (!sha256 || !filename) continue
    if (checksums.has(filename)) throw new Error(`Duplicate checksum for ${filename}`)
    checksums.set(filename, sha256)
  }
  if (checksums.size === 0) throw new Error('Official checksum file contained no recognized entries')
  return checksums
}

function nextMonth(month: string): string {
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const monthNumber = Number(monthText)
  if (monthNumber === 12) return `${year + 1}-01`
  return `${year}-${String(monthNumber + 1).padStart(2, '0')}`
}

function assertContiguousMonths(
  archives: readonly BroadcastArchive[],
  startMonth: string,
  cutoffMonth: string,
): void {
  const actual = new Set(archives.map((archive) => archive.month))
  let month = startMonth
  while (month <= cutoffMonth) {
    if (!actual.has(month)) throw new Error(`Official broadcast sources are missing month ${month}`)
    month = nextMonth(month)
  }
  if (actual.size !== archives.length) throw new Error('Broadcast manifest contains a duplicate month')
}

async function fetchOfficialText(fetchImpl: FetchLike, url: string): Promise<string> {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'LineRecall-data-pipeline/1.0' },
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`Fetching ${url} failed with HTTP ${response.status}`)
  const finalUrl = new URL(response.url || url)
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'database.lichess.org') {
    throw new Error(`Official source redirected to an unapproved host: ${finalUrl.toString()}`)
  }
  return response.text()
}

export async function buildBroadcastManifest(options: {
  cutoffMonth?: string
  startMonth?: string
  fetchImpl?: FetchLike
  now?: Date
} = {}): Promise<BroadcastManifestV1> {
  const cutoffMonth = options.cutoffMonth ?? BROADCAST_CUTOFF_MONTH
  const startMonth = options.startMonth ?? BROADCAST_START_MONTH
  if (!isMonth(cutoffMonth) || !isMonth(startMonth) || startMonth > cutoffMonth) {
    throw new Error('Broadcast start/cutoff must be valid ordered YYYY-MM values')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const [listText, checksumsText] = await Promise.all([
    fetchOfficialText(fetchImpl, BROADCAST_LIST_URL),
    fetchOfficialText(fetchImpl, BROADCAST_CHECKSUMS_URL),
  ])
  const urls = parseDownloadList(listText)
  const checksums = parseSha256Sums(checksumsText)
  const archives: BroadcastArchive[] = []
  for (const [filename, url] of urls) {
    const month = ARCHIVE_PATTERN.exec(filename)?.[1]
    if (!month || month < startMonth || month > cutoffMonth) continue
    const sha256 = checksums.get(filename)
    if (!sha256) throw new Error(`No official SHA-256 checksum is published for ${filename}`)
    archives.push({ month, filename, url, sha256 })
  }
  archives.sort((left, right) => left.month.localeCompare(right.month))
  assertContiguousMonths(archives, startMonth, cutoffMonth)

  const manifest: BroadcastManifestV1 = {
    schemaVersion: BROADCAST_SCHEMA_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    startMonth,
    cutoffMonth,
    source: {
      listUrl: BROADCAST_LIST_URL,
      checksumsUrl: BROADCAST_CHECKSUMS_URL,
      license: BROADCAST_LICENSE,
      licenseUrl: BROADCAST_LICENSE_URL,
    },
    approval: {
      status: 'pending',
      approvedOn: null,
      scope: 'No download, transformation, or redistribution is approved until this manifest is reviewed.',
      basis: 'Pending review of the pinned archive list, checksums, and CC BY-SA 4.0 terms.',
      reviewRequiredWhen: 'Always before first use, and whenever the source list, cutoff, checksums, license, or redistribution model changes.',
    },
    archives,
  }
  assertBroadcastManifest(manifest)
  return manifest
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyArchive(path: string, expectedSha256: string): Promise<void> {
  const actual = await sha256File(path)
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${path}: expected ${expectedSha256}, received ${actual}`)
  }
}

async function existingVerified(path: string, sha256: string): Promise<boolean> {
  try {
    const details = await stat(path)
    if (!details.isFile()) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  await verifyArchive(path, sha256)
  return true
}

export async function downloadArchive(
  archive: BroadcastArchive,
  destinationDirectory: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ path: string; downloaded: boolean }> {
  await mkdir(destinationDirectory, { recursive: true })
  const destination = join(destinationDirectory, archive.filename)
  if (await existingVerified(destination, archive.sha256)) {
    return { path: destination, downloaded: false }
  }

  const partial = `${destination}.part`
  await rm(partial, { force: true })
  const response = await fetchImpl(archive.url, {
    headers: { 'user-agent': 'LineRecall-data-pipeline/1.0' },
    redirect: 'follow',
  })
  if (!response.ok || !response.body) {
    throw new Error(`Downloading ${archive.url} failed with HTTP ${response.status}`)
  }
  const finalUrl = new URL(response.url || archive.url)
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'database.lichess.org') {
    throw new Error(`Archive redirected to an unapproved host: ${finalUrl.toString()}`)
  }

  const hash = createHash('sha256')
  const file = await open(partial, 'wx')
  try {
    for await (const chunk of response.body) {
      hash.update(chunk)
      await file.write(chunk)
    }
    await file.sync()
  } catch (error) {
    await file.close()
    await rm(partial, { force: true })
    throw error
  }
  await file.close()
  const actual = hash.digest('hex')
  if (actual !== archive.sha256) {
    await rm(partial, { force: true })
    throw new Error(
      `SHA-256 mismatch for ${archive.filename}: expected ${archive.sha256}, received ${actual}`,
    )
  }
  await rename(partial, destination)
  return { path: destination, downloaded: true }
}

export async function downloadManifestArchives(
  manifest: BroadcastManifestV1,
  destinationDirectory: string,
  options: { fetchImpl?: FetchLike; onArchive?: (archive: BroadcastArchive, downloaded: boolean) => void } = {},
): Promise<string[]> {
  assertBroadcastManifest(manifest)
  const paths: string[] = []
  for (const archive of manifest.archives) {
    const result = await downloadArchive(archive, destinationDirectory, options.fetchImpl)
    paths.push(result.path)
    options.onArchive?.(archive, result.downloaded)
  }
  return paths
}

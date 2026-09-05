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
const APPROVED_BROADCAST_MONTHS = Object.freeze([
  '2020-01', '2020-02', '2020-03', '2020-04', '2020-05', '2020-06',
  '2020-07', '2020-08', '2020-09', '2020-10', '2020-11', '2020-12',
  '2021-01', '2021-02', '2021-03', '2021-04', '2021-05', '2021-06',
  '2021-07', '2021-08', '2021-09', '2021-10', '2021-11', '2021-12',
  '2022-01', '2022-02', '2022-03', '2022-04', '2022-05', '2022-06',
  '2022-07', '2022-08', '2022-09', '2022-10', '2022-11', '2022-12',
  '2023-01', '2023-02', '2023-03', '2023-04', '2023-05', '2023-06',
  '2023-07', '2023-08', '2023-09', '2023-10', '2023-11', '2023-12',
  '2024-01', '2024-02', '2024-03', '2024-04', '2024-05', '2024-06',
  '2024-07', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12',
  '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06',
  '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
  '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
] as const)

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

function assertApprovedMonthAllowlist(): void {
  let expected = BROADCAST_START_MONTH
  for (const month of APPROVED_BROADCAST_MONTHS) {
    if (month !== expected) throw new Error(`Approved broadcast month allowlist is missing ${expected}`)
    expected = nextMonth(expected)
  }
  if (expected !== nextMonth(BROADCAST_CUTOFF_MONTH)) {
    throw new Error('Approved broadcast month allowlist does not end at the configured cutoff')
  }
}

assertApprovedMonthAllowlist()

function approvedArchiveIdentity(archive: BroadcastArchive): { filename: string; url: string } {
  const approvedMonth = APPROVED_BROADCAST_MONTHS.find((month) => month === archive.month)
  if (approvedMonth === undefined) {
    throw new Error(`Broadcast archive month is outside the exact approved allowlist: ${archive.month}`)
  }
  const filename = `lichess_db_broadcast_${approvedMonth}.pgn.zst`
  const url = `https://database.lichess.org/broadcast/${filename}`
  if (archive.filename !== filename || archive.url !== url) {
    throw new Error(`Broadcast archive is not the exact approved source for ${approvedMonth}`)
  }
  if (!/^[a-f0-9]{64}$/u.test(archive.sha256)) {
    throw new Error(`Broadcast archive SHA-256 is invalid for ${approvedMonth}`)
  }
  return { filename, url }
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
  const approved = approvedArchiveIdentity(archive)
  await mkdir(destinationDirectory, { recursive: true })
  const destination = join(destinationDirectory, approved.filename)
  if (await existingVerified(destination, archive.sha256)) {
    return { path: destination, downloaded: false }
  }

  const partial = `${destination}.part`
  await rm(partial, { force: true })
  const response = await fetchImpl(approved.url, {
    headers: { 'user-agent': 'LineRecall-data-pipeline/1.0' },
    redirect: 'error',
  })
  if (!response.ok || !response.body) {
    throw new Error(`Downloading ${approved.url} failed with HTTP ${response.status}`)
  }
  const finalUrl = response.url || approved.url
  if (finalUrl !== approved.url) {
    throw new Error(`Archive response URL is not the exact approved source: ${finalUrl}`)
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
      `SHA-256 mismatch for ${approved.filename}: expected ${archive.sha256}, received ${actual}`,
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

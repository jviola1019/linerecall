import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { Chess } from 'chess.js'
import { aggregatePlainPgnStreams } from '../../scripts/data/broadcast-aggregate.ts'
import { processArchive } from '../../scripts/data/broadcast-archive-worker.ts'
import {
  BROADCAST_CHECKSUMS_URL,
  BROADCAST_LIST_URL,
  ratingBandFor,
  type BroadcastTargetIndexV1,
} from '../../scripts/data/broadcast-contracts.ts'
import {
  buildBroadcastManifest,
  downloadArchive,
  parseDownloadList,
  parseSha256Sums,
} from '../../scripts/data/broadcast-manifest.ts'
import {
  normalizedEpd,
  parseBroadcastPgn,
  readZstdPgnRecords,
} from '../../scripts/data/broadcast-pgn.ts'

const fixture = resolve('tests/fixtures/broadcast/sample.pgn')

function moveSequence(...moves: string[]): Chess {
  const chess = new Chess()
  for (const san of moves) chess.move(san)
  return chess
}

test('rating bands use the arithmetic mean and exact boundaries', () => {
  assert.equal(ratingBandFor(1799, 1800), '<1800')
  assert.equal(ratingBandFor(1800, 1800), '1800-1999')
  assert.equal(ratingBandFor(1999, 2000), '1800-1999')
  assert.equal(ratingBandFor(2000, 2000), '2000-2199')
  assert.equal(ratingBandFor(2200, 2200), '2200-2399')
  assert.equal(ratingBandFor(2400, 2400), '2400+')
})

test('normalized EPD excludes clocks and retains only a legal en-passant square', () => {
  const legalEnPassant = moveSequence('e4', 'a6', 'e5', 'd5')
  assert.match(normalizedEpd(legalEnPassant), / d6$/)

  const noEnPassantCapture = moveSequence('e4', 'd5')
  assert.match(normalizedEpd(noEnPassantCapture), / -$/)
  assert.equal(normalizedEpd(new Chess()).split(/\s+/).length, 4)
})

test('manifest parser rejects unapproved URLs and joins official checksums', async () => {
  const january = 'lichess_db_broadcast_2020-01.pgn.zst'
  const february = 'lichess_db_broadcast_2020-02.pgn.zst'
  const list = [
    `https://database.lichess.org/broadcast/${february}`,
    `https://database.lichess.org/broadcast/${january}`,
  ].join('\n')
  const checksums = `${'a'.repeat(64)}  ${january}\n${'b'.repeat(64)}  ${february}\n`
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url === BROADCAST_LIST_URL) return new Response(list, { status: 200 })
    if (url === BROADCAST_CHECKSUMS_URL) return new Response(checksums, { status: 200 })
    return new Response('', { status: 404 })
  }) as typeof fetch
  const manifest = await buildBroadcastManifest({
    startMonth: '2020-01',
    cutoffMonth: '2020-02',
    fetchImpl,
    now: new Date('2026-07-10T00:00:00.000Z'),
  })
  assert.deepEqual(
    manifest.archives.map((archive) => archive.month),
    ['2020-01', '2020-02'],
  )
  assert.equal(manifest.archives[0]?.sha256, 'a'.repeat(64))
  assert.throws(
    () => parseDownloadList('https://example.com/broadcast/lichess_db_broadcast_2020-01.pgn.zst'),
    /Unapproved URL/,
  )
  assert.equal(parseSha256Sums(checksums).size, 2)
})

test('archive download is atomic and refuses a checksum mismatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-broadcast-'))
  try {
    const body = Buffer.from('fixture archive bytes')
    const archive = {
      month: '2026-06',
      filename: 'lichess_db_broadcast_2026-06.pgn.zst',
      url: 'https://database.lichess.org/broadcast/lichess_db_broadcast_2026-06.pgn.zst',
      sha256: createHash('sha256').update(body).digest('hex'),
    }
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), redirect: init?.redirect })
      return new Response(body)
    }) as typeof fetch
    const downloaded = await downloadArchive(archive, directory, fetchImpl)
    assert.equal(downloaded.downloaded, true)
    assert.deepEqual(await readFile(downloaded.path), body)
    assert.deepEqual(requests, [{ url: archive.url, redirect: 'error' }])
    const reused = await downloadArchive(archive, directory, fetchImpl)
    assert.equal(reused.downloaded, false)

    await assert.rejects(
      downloadArchive(
        {
          ...archive,
          month: '2026-05',
          filename: 'lichess_db_broadcast_2026-05.pgn.zst',
          url: 'https://database.lichess.org/broadcast/lichess_db_broadcast_2026-05.pgn.zst',
          sha256: '0'.repeat(64),
        },
        directory,
        fetchImpl,
      ),
      /SHA-256 mismatch/,
    )

    let hostileFetchCalled = false
    await assert.rejects(
      downloadArchive(
        { ...archive, url: 'https://example.com/controlled-by-file.pgn.zst' },
        directory,
        (async () => {
          hostileFetchCalled = true
          return new Response(body)
        }) as typeof fetch,
      ),
      /exact approved source/iu,
    )
    assert.equal(hostileFetchCalled, false)

    await assert.rejects(
      downloadArchive(
        {
          ...archive,
          month: '2026-07',
          filename: 'lichess_db_broadcast_2026-07.pgn.zst',
          url: 'https://database.lichess.org/broadcast/lichess_db_broadcast_2026-07.pgn.zst',
        },
        directory,
        (async () => {
          hostileFetchCalled = true
          return new Response(body)
        }) as typeof fetch,
      ),
      /outside the exact approved allowlist/iu,
    )
    assert.equal(hostileFetchCalled, false)

    const redirectedResponse = new Response(body)
    Object.defineProperty(redirectedResponse, 'url', {
      configurable: true,
      value: 'https://database.lichess.org/broadcast/not-the-approved-object.pgn.zst',
    })
    await assert.rejects(
      downloadArchive(
        {
          ...archive,
          month: '2026-04',
          filename: 'lichess_db_broadcast_2026-04.pgn.zst',
          url: 'https://database.lichess.org/broadcast/lichess_db_broadcast_2026-04.pgn.zst',
        },
        directory,
        (async () => redirectedResponse) as typeof fetch,
      ),
      /response URL is not the exact approved source/iu,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('PGN validation fails gracefully on malformed and unsupported records', () => {
  const malformed = parseBroadcastPgn(
    '[Event "broken"]\n[Variant "Standard"]\n[WhiteElo "1800"]\n[BlackElo "1800"]\n[Result "1-0"]\n\n1. e4 e9 1-0',
  )
  assert.deepEqual(malformed, { accepted: false, reason: 'malformed_pgn' })
  const missingVariant = parseBroadcastPgn(
    '[Event "x"]\n[WhiteElo "1800"]\n[BlackElo "1800"]\n[Result "1-0"]\n\n1. e4 1-0',
  )
  assert.deepEqual(missingVariant, { accepted: false, reason: 'missing_variant' })

  const consecutiveComments = parseBroadcastPgn(
    '[Event "comments"]\n[Variant "Standard"]\n[WhiteElo "1800"]\n[BlackElo "1800"]\n[Result "1-0"]\n\n1. e4 { first } { second } e5 2. Nf3 1-0',
  )
  assert.equal(consecutiveComments.accepted, true)
  if (consecutiveComments.accepted) {
    assert.deepEqual(
      consecutiveComments.game.moves.map((move) => `${move.from}${move.to}${move.promotion ?? ''}`),
      ['e2e4', 'e7e5', 'g1f3'],
    )
  }

  const unterminatedComment = parseBroadcastPgn(
    '[Event "comments"]\n[Variant "Standard"]\n[WhiteElo "1800"]\n[BlackElo "1800"]\n[Result "1-0"]\n\n1. e4 { never closed 1-0',
  )
  assert.deepEqual(unterminatedComment, { accepted: false, reason: 'invalid_result' })
})

test('native Node Zstandard decompression yields bounded PGN records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-zstd-'))
  try {
    const pgn = await readFile(fixture)
    const archive = join(directory, 'fixture.pgn.zst')
    await writeFile(archive, zstdCompressSync(pgn))
    const records = []
    for await (const record of readZstdPgnRecords(archive)) records.push(record)
    assert.equal(records.length, 6)
    assert.ok(records.every((record) => record.pgn !== null))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('archive worker preserves canonical records and emits compact target hits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-worker-'))
  try {
    const archive = join(directory, 'fixture.pgn.zst')
    await writeFile(archive, zstdCompressSync(await readFile(fixture)))
    const start = normalizedEpd(new Chess())
    const afterE4 = normalizedEpd(moveSequence('e4'))
    const result = await processArchive({
      archiveIndex: 7,
      archivePath: archive,
      targetEpds: [start, afterE4],
      maxPly: 6,
    })
    assert.equal(result.archiveIndex, 7)
    assert.equal(result.recordsSeen, 6)
    assert.equal(result.games.length, 4)
    assert.deepEqual(result.rejected, { non_standard_variant: 1, invalid_black_elo: 1 })
    assert.deepEqual(result.games[0]?.hits[0], { targetIndex: 0, uci: 'e2e4', san: 'e4' })
    assert.deepEqual(result.games[0]?.hits[1], { targetIndex: 1, uci: 'e7e5', san: 'e5' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('official leading Zstandard skippable metadata frame is handled safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-zstd-skip-'))
  try {
    const pgn = await readFile(fixture)
    const midpoint = Math.floor(pgn.byteLength / 2)
    const compressedFrames = [
      zstdCompressSync(pgn.subarray(0, midpoint)),
      zstdCompressSync(pgn.subarray(midpoint)),
    ]
    const wrappedFrame = (compressed: Buffer): Buffer => {
      const skippable = Buffer.alloc(12)
      skippable.writeUInt32LE(0x184d2a50, 0)
      skippable.writeUInt32LE(4, 4)
      skippable.writeUInt32LE(compressed.byteLength, 8)
      return Buffer.concat([skippable, compressed])
    }
    const archive = join(directory, 'fixture-skippable.pgn.zst')
    await writeFile(archive, Buffer.concat(compressedFrames.map(wrappedFrame)))
    const records = []
    for await (const record of readZstdPgnRecords(archive)) records.push(record)
    assert.equal(records.length, 6)
    assert.ok(records.every((record) => record.pgn !== null))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stream aggregation deduplicates, merges transpositions, and reports both perspectives', async () => {
  const initial = normalizedEpd(new Chess())
  const transposed = normalizedEpd(moveSequence('d4', 'Nf6', 'Nf3', 'd5'))
  assert.equal(transposed, normalizedEpd(moveSequence('Nf3', 'd5', 'd4', 'Nf6')))
  const targets: BroadcastTargetIndexV1 = {
    schemaVersion: 1,
    taxonomyCommit: '17ee660257de02870636f36248e919f2e01d8e85',
    maxPly: 12,
    targets: [
      { epd: initial, lineIds: ['transpose-line'] },
      { epd: transposed, lineIds: ['transpose-line'], terminalLineIds: ['transpose-line'] },
    ],
  }
  const result = await aggregatePlainPgnStreams([createReadStream(fixture)], targets)
  assert.deepEqual(result.totals, {
    recordsSeen: 6,
    accepted: 3,
    deduplicated: 1,
    rejected: { non_standard_variant: 1, invalid_black_elo: 1 },
  })

  const root = result.positions.find((position) => position.epd === initial)
  assert.ok(root)
  assert.equal(root.bands['<1800'].n, 1)
  assert.equal(root.bands['1800-1999'].n, 1)
  assert.equal(root.bands['2000-2199'].n, 1)
  assert.deepEqual(
    root.moves.map((move) => move.uci).sort(),
    ['d2d4', 'e2e4', 'g1f3'],
  )

  const terminal = result.terminalLines[0]
  assert.ok(terminal)
  assert.equal(terminal.totalSampleSize, 2)
  assert.equal(terminal.drillEligible, false)
  assert.equal(terminal.provenanceRef, 'corpus')
  assert.equal(terminal.bands['1800-1999'].raw.draws, 1)
  assert.equal(terminal.bands['1800-1999'].whitePerspective.drawRate, 100)
  assert.equal(terminal.bands['2000-2199'].blackPerspective.winRate, 100)
})

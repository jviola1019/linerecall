import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { splitPgnStream } from '../../scripts/data/broadcast-pgn.ts'
import {
  EvidenceGraphStore,
  classifyTimeControl,
  ingestGraphRecords,
  parseBroadcastGraphPgn,
  parseLichessStandardGraphPgn,
} from '../../scripts/data/evidence-graph.ts'

const fixture = resolve('tests/fixtures/broadcast/sample.pgn')

test('time-control cohorts are explicit and sub-bullet/ambiguous data remains unknown', () => {
  assert.equal(classifyTimeControl('60+0', undefined), 'unknown')
  assert.equal(classifyTimeControl('179+0', undefined), 'unknown')
  assert.equal(classifyTimeControl('180+0', undefined), 'blitz')
  assert.equal(classifyTimeControl('300+3', undefined), 'blitz')
  assert.equal(classifyTimeControl('600+0', undefined), 'rapid')
  assert.equal(classifyTimeControl('1500+0', undefined), 'classical')
  assert.equal(classifyTimeControl('90m+30s', undefined), 'classical')
  assert.equal(classifyTimeControl('10+0', undefined), 'unknown')
  assert.equal(classifyTimeControl('21600+0', undefined), 'unknown')
  assert.equal(classifyTimeControl(undefined, 'rated rapid game'), 'rapid')
  assert.equal(classifyTimeControl('60+0', 'rated bullet game'), 'unknown')
  assert.equal(classifyTimeControl('120+1', 'rated ultraBullet game'), 'unknown')
  assert.equal(classifyTimeControl('86400+0', 'rated correspondence game'), 'unknown')
  assert.equal(classifyTimeControl('40/7200:3600+30', undefined), 'unknown')
})

test('ply-30 graph ingestion is resumable, deduplicated, and retains exact legal successor EPDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-evidence-'))
  const store = new EvidenceGraphStore(join(directory, 'graph.sqlite'))
  const identity = {
    archiveId: 'broadcast-fixture',
    sourceId: 'lichess-broadcasts' as const,
    month: '2026-06',
    sha256: 'a'.repeat(64),
  }
  try {
    const totals = await ingestGraphRecords({
      store,
      identity,
      records: splitPgnStream(createReadStream(fixture)),
      parse: parseBroadcastGraphPgn,
      ingestion: { batchGames: 2 },
    })
    assert.deepEqual(totals, {
      recordsSeen: 6,
      accepted: 3,
      deduplicated: 1,
      rejected: { non_standard_variant: 1, invalid_black_elo: 1 },
      skipped: false,
    })
    const root = store.database.prepare(`
      SELECT sum(n) AS n, sum(white_wins) AS whiteWins, sum(draws) AS draws, sum(black_wins) AS blackWins
      FROM position_outcomes
      WHERE epd = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
    `).get() as { n: number; whiteWins: number; draws: number; blackWins: number }
    assert.deepEqual({ ...root }, { n: 3, whiteWins: 1, draws: 1, blackWins: 1 })
    const edges = store.database.prepare(`
      SELECT uci, san, from_epd AS fromEpd, to_epd AS toEpd, sum(n) AS n
      FROM edge_outcomes
      WHERE from_epd = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
      GROUP BY uci, san, from_epd, to_epd ORDER BY uci
    `).all() as unknown as Array<{ uci: string; san: string; fromEpd: string; toEpd: string; n: number }>
    assert.deepEqual(edges.map(({ uci }) => uci), ['d2d4', 'e2e4', 'g1f3'])
    assert.ok(edges.every(({ toEpd }) => toEpd.split(/\s+/u).length === 4))

    const repeated = await ingestGraphRecords({
      store,
      identity,
      records: splitPgnStream(createReadStream(fixture)),
      parse: parseBroadcastGraphPgn,
    })
    assert.equal(repeated.skipped, true)
    assert.equal(repeated.accepted, 3)

    const shardPath = join(directory, 'duplicate-shard.sqlite')
    const shard = new EvidenceGraphStore(shardPath)
    const duplicateIdentity = { ...identity, archiveId: 'broadcast-fixture-copy', month: '2026-05' }
    try {
      await ingestGraphRecords({
        store: shard,
        identity: duplicateIdentity,
        records: splitPgnStream(createReadStream(fixture)),
        parse: (pgn) => parseBroadcastGraphPgn(pgn, duplicateIdentity.month),
      })
    } finally {
      shard.close()
    }
    assert.equal(store.mergeCompletedShard(duplicateIdentity, shardPath), false)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('standard-game parser requires a stable Lichess ID, excludes bots and unsupported speeds', () => {
  const base = [
    '[Event "rated blitz game"]',
    '[Site "https://lichess.org/Ab12Cd34"]',
    '[White "One"]',
    '[Black "Two"]',
    '[Result "1-0"]',
    '[WhiteElo "1100"]',
    '[BlackElo "1300"]',
    '[TimeControl "180+0"]',
    '',
    '1. e4 e5 2. Nf3 1-0',
  ].join('\n')
  const parsed = parseLichessStandardGraphPgn(base, '2026-04')
  assert.equal(parsed.accepted, true)
  if (parsed.accepted) {
    assert.equal(parsed.game.deduplicationKey, 'lichess:Ab12Cd34')
    assert.equal(parsed.game.ratingBand, '<1800')
    assert.equal(parsed.game.ratingDetail, '1200-1499')
    assert.equal(parsed.game.timeControl, 'blitz')
  }
  assert.deepEqual(
    parseLichessStandardGraphPgn(base.replace('[White "One"]', '[White "One"]\n[WhiteTitle "BOT"]'), '2026-04'),
    { accepted: false, reason: 'bot_game' },
  )
  assert.deepEqual(
    parseLichessStandardGraphPgn(base.replace('[Event "rated blitz game"]\n', ''), '2026-04'),
    { accepted: false, reason: 'unsupported_time_control' },
  )
  assert.deepEqual(
    parseLichessStandardGraphPgn(base.replace('rated blitz game', 'rated bullet game').replace('180+0', '60+0'), '2026-04'),
    { accepted: false, reason: 'unsupported_time_control' },
  )
  assert.deepEqual(
    parseLichessStandardGraphPgn(base.replace('rated blitz game', 'rated ultraBullet game').replace('180+0', '120+1'), '2026-04'),
    { accepted: false, reason: 'unsupported_time_control' },
  )
})

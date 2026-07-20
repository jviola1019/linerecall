import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiError } from '../src/errors.js'
import { buildLichessGamesUrl, processLichessGameResponse } from '../src/connections/lichess-game-stream.js'

const SYNC_START = new Date('2026-07-14T12:00:00.000Z')

function game(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abcdEF12', rated: true, variant: 'standard', speed: 'rapid', perf: 'rapid',
    createdAt: 1_752_000_000_000, lastMoveAt: SYNC_START.getTime() - 1_000, status: 'resign',
    players: {
      white: { user: { id: 'line-user', name: 'LineUser' }, rating: 1850 },
      black: { user: { id: 'opponent', name: 'Opponent' }, rating: 1900 },
    },
    winner: 'white', opening: { eco: 'C50', name: 'Italian Game', ply: 3 },
    moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6',
    ...overrides,
  }
}

function ndjson(records: unknown[], options: { contentType?: string } = {}): Response {
  return new Response(`${records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n')}\n`, {
    status: 200, headers: { 'content-type': options.contentType ?? 'application/x-ndjson' },
  })
}

describe('finished Lichess game stream', () => {
  it('builds an ascending, overlapped, bounded no-analysis request', () => {
    const url = buildLichessGamesUrl('line-user', {
      lastMoveAt: 1_752_000_000_000, gameIdDigest: 'a'.repeat(64),
    }, SYNC_START)
    assert.equal(url.origin, 'https://lichess.org')
    assert.equal(url.searchParams.get('sort'), 'dateAsc')
    assert.equal(url.searchParams.get('rated'), 'true')
    assert.equal(url.searchParams.get('perfType'), 'blitz,rapid,classical')
    assert.equal(url.searchParams.get('since'), '1751999999000')
    assert.equal(url.searchParams.get('until'), String(SYNC_START.getTime()))
    assert.equal(url.searchParams.get('evals'), 'false')
    assert.throws(() => buildLichessGamesUrl('../other', null, SYNC_START), /account ID/)
    const initial = buildLichessGamesUrl('line-user', null, SYNC_START)
    assert.equal(initial.searchParams.get('since'), '1356998400070')
    const clamped = buildLichessGamesUrl('line-user', { lastMoveAt: 1, gameIdDigest: 'a'.repeat(64) }, SYNC_START)
    assert.equal(clamped.searchParams.get('since'), '1356998400070')
    assert.throws(() => buildLichessGamesUrl('line-user', null, new Date(0)), /sync boundary/)
  })

  it('retains only anonymized opening edges through ply 30', async () => {
    const result = await processLichessGameResponse(ndjson([game()]), 'line-user', SYNC_START)
    assert.equal(result.accepted.length, 1)
    const accepted = result.accepted[0]!
    assert.match(accepted.gameIdDigest, /^[a-f0-9]{64}$/u)
    assert.equal(accepted.side, 'white')
    assert.equal(accepted.outcome, 'win')
    assert.equal(accepted.edges[0]?.uci, 'e2e4')
    assert.equal(accepted.edges[5]?.san, 'Nf6')
    assert.equal(JSON.stringify(accepted).includes('opponent'), false)
    assert.equal(JSON.stringify(accepted).includes('abcdEF12'), false)
    assert.equal(result.cursor?.gameIdDigest, accepted.gameIdDigest)
  })

  it('skips malformed, unsupported, future, and illegal records without inventing aggregates', async () => {
    const result = await processLichessGameResponse(ndjson([
      '{not-json',
      game({ id: 'wrongVar1', variant: 'chess960' }),
      game({ id: 'future001', lastMoveAt: SYNC_START.getTime() + 1 }),
      game({ id: 'badmoves', moves: 'e4 e5 Ka9' }),
      game({ id: 'bullet01', speed: 'bullet', perf: 'bullet' }),
    ]), 'line-user', SYNC_START)
    assert.equal(result.accepted.length, 0)
    assert.deepEqual(result.rejected, { malformed_json: 1, schema_rejected: 2, not_eligible: 1, invalid_movetext: 1 })
  })

  it('fails visibly on rate limiting and a wrong response type', async () => {
    await assert.rejects(
      () => processLichessGameResponse(new Response('', { status: 429 }), 'line-user', SYNC_START),
      (error: unknown) => error instanceof ApiError && error.retryAfterSeconds === 60,
    )
    await assert.rejects(
      () => processLichessGameResponse(ndjson([], { contentType: 'text/plain' }), 'line-user', SYNC_START),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_provider_response',
    )
  })

  it('classifies account, result, setup, opening-name, and movetext eligibility without retaining raw records', async () => {
    const tooManyMoves = Array.from({ length: 2_049 }, () => 'e4').join(' ')
    const result = await processLichessGameResponse(ndjson([
      game({ id: 'black001', players: {
        white: { user: { id: 'opponent' }, rating: 1900 },
        black: { user: { id: 'line-user' }, rating: 1850 },
      }, winner: 'white' }),
      game({ id: 'draw0001', status: 'draw', winner: undefined }),
      game({ id: 'missing1', status: 'timeout', winner: undefined }),
      game({ id: 'setup001', initialFen: 'startpos' }),
      game({ id: 'ongoing1', status: 'started' }),
      game({ id: 'neither1', players: {
        white: { user: { id: 'other-a' }, rating: 1900 },
        black: { user: { id: 'other-b' }, rating: 1850 },
      } }),
      game({ id: 'both0001', players: {
        white: { user: { id: 'line-user' }, rating: 1900 },
        black: { user: { id: 'LINE-USER' }, rating: 1850 },
      } }),
      game({ id: 'badname1', opening: { eco: 'C50', name: 'Unsafe\u0007name', ply: 3 } }),
      game({ id: 'nomoves1', moves: '   ' }),
      game({ id: 'manymove', moves: tooManyMoves }),
    ]), 'line-user', SYNC_START)

    assert.equal(result.accepted.length, 2)
    assert.equal(result.accepted[0]?.side, 'black')
    assert.equal(result.accepted[0]?.outcome, 'loss')
    assert.equal(result.accepted[0]?.playerRating, 1850)
    assert.equal(result.accepted[1]?.outcome, 'draw')
    assert.deepEqual(result.rejected, {
      missing_result: 1,
      not_eligible: 2,
      account_mismatch: 2,
      invalid_opening_name: 1,
      invalid_movetext: 2,
    })
  })

  it('supports split UTF-8 chunks and a final record without a newline', async () => {
    const payload = JSON.stringify(game({ id: 'chunk001' }))
    const bytes = new TextEncoder().encode(payload)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 17))
        controller.enqueue(bytes.slice(17, 91))
        controller.enqueue(bytes.slice(91))
        controller.close()
      },
    })
    const response = new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } })
    const result = await processLichessGameResponse(response, 'line-user', SYNC_START)
    assert.equal(result.accepted.length, 1)
    assert.equal(result.accepted[0]?.openingName, 'Italian Game')
  })

  it('rejects missing bodies, upstream failures, malformed UTF-8, and oversized NDJSON lines', async () => {
    const cases: Array<{ response: Response; code: string }> = [
      { response: new Response(null, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }), code: 'provider_games_failed' },
      { response: new Response('failure', { status: 503 }), code: 'provider_games_failed' },
      { response: new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/x-ndjson' } }), code: 'provider_malformed_unicode' },
      { response: new Response('x'.repeat(131_073), { headers: { 'content-type': 'application/x-ndjson' } }), code: 'provider_line_too_large' },
      { response: new Response(`${'x'.repeat(131_073)}\n`, { headers: { 'content-type': 'application/x-ndjson' } }), code: 'provider_line_too_large' },
    ]
    for (const { response, code } of cases) {
      await assert.rejects(
        () => processLichessGameResponse(response, 'line-user', SYNC_START),
        (error: unknown) => error instanceof ApiError && error.code === code,
      )
    }
  })
})

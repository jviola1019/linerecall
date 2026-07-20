import { createHash } from 'node:crypto'
import { Chess } from 'chess.js'
import { z } from 'zod'
import { ApiError } from '../errors.js'

const FINISHED_STATUSES = new Set(['mate', 'resign', 'stalemate', 'timeout', 'draw', 'outoftime', 'insufficientMaterialClaim'])
const SPEEDS = ['blitz', 'rapid', 'classical'] as const
const MAX_NDJSON_LINE_BYTES = 131_072
const MAX_STREAM_GAMES = 500_000

const PlayerSchema = z.object({
  user: z.object({ id: z.string().min(1).max(64) }).passthrough(),
  rating: z.number().int().min(0).max(5_000),
}).passthrough()

const LichessGameSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9]{8,12}$/u),
  rated: z.literal(true),
  variant: z.literal('standard'),
  speed: z.enum(SPEEDS),
  createdAt: z.number().int().nonnegative(),
  lastMoveAt: z.number().int().nonnegative(),
  status: z.string().min(1).max(64),
  players: z.object({ white: PlayerSchema, black: PlayerSchema }).strict(),
  winner: z.enum(['white', 'black']).optional(),
  opening: z.object({
    eco: z.string().regex(/^[A-E][0-9]{2}$/u),
    name: z.string().trim().min(1).max(256),
    ply: z.number().int().min(0).max(60),
  }).strict(),
  moves: z.string().max(65_536),
  initialFen: z.string().optional(),
}).passthrough()

export interface LichessSyncCursor {
  lastMoveAt: number
  gameIdDigest: string
}

export interface PersonalOpeningEdge {
  ply: number
  fromEpd: string
  uci: string
  san: string
  toEpd: string
}

export interface PersonalGameAggregate {
  gameIdDigest: string
  lastMoveAt: number
  speed: (typeof SPEEDS)[number]
  side: 'white' | 'black'
  outcome: 'win' | 'draw' | 'loss'
  openingEco: string
  openingName: string
  openingPly: number
  playerRating: number
  edges: PersonalOpeningEdge[]
}

export interface LichessStreamResult {
  accepted: PersonalGameAggregate[]
  rejected: Record<string, number>
  cursor: LichessSyncCursor | null
}

export interface LichessStreamChunk extends LichessStreamResult {
  records: number
}

function epd(chess: Chess): string {
  return chess.fen().split(' ').slice(0, 4).join(' ')
}

function safeOpeningName(value: string): string | null {
  const normalized = value.normalize('NFC').trim()
  if (!normalized || normalized.length > 128 || /[\u0000-\u001F\u007F-\u009F\uD800-\uDFFF]/u.test(normalized)) return null
  return normalized
}

function digestGameId(id: string): string {
  return createHash('sha256').update(`lichess-game-v1\0${id}`).digest('hex')
}

function laterCursor(current: LichessSyncCursor | null, candidate: LichessSyncCursor | null): LichessSyncCursor | null {
  if (!candidate) return current
  if (!current || candidate.lastMoveAt > current.lastMoveAt) return candidate
  if (candidate.lastMoveAt === current.lastMoveAt && candidate.gameIdDigest > current.gameIdDigest) return candidate
  return current
}

function observedCursor(value: unknown, syncStartedAt: Date): LichessSyncCursor | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { id?: unknown; lastMoveAt?: unknown }
  if (typeof candidate.id !== 'string' || !/^[A-Za-z0-9]{8,12}$/u.test(candidate.id)) return null
  if (!Number.isSafeInteger(candidate.lastMoveAt) || (candidate.lastMoveAt as number) < 0) return null
  if ((candidate.lastMoveAt as number) > syncStartedAt.getTime()) return null
  return { lastMoveAt: candidate.lastMoveAt as number, gameIdDigest: digestGameId(candidate.id) }
}

export function buildLichessGamesUrl(username: string, cursor: LichessSyncCursor | null, syncStartedAt: Date): URL {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(username)) throw new Error('Invalid connected Lichess account ID')
  const until = syncStartedAt.getTime()
  if (!Number.isSafeInteger(until) || until < 1_356_998_400_070) throw new Error('Invalid provider sync boundary')
  const url = new URL(`https://lichess.org/api/games/user/${encodeURIComponent(username)}`)
  const since = cursor ? Math.max(1_356_998_400_070, cursor.lastMoveAt - 1_000) : 1_356_998_400_070
  url.search = new URLSearchParams({
    since: String(since), until: String(until), rated: 'true', perfType: SPEEDS.join(','),
    moves: 'true', opening: 'true', ongoing: 'false', finished: 'true', sort: 'dateAsc',
    clocks: 'false', evals: 'false', accuracy: 'false', literate: 'false', pgnInJson: 'false',
  }).toString()
  return url
}

function parseGame(value: unknown, accountId: string, syncStartedAt: Date): { aggregate: PersonalGameAggregate } | { reason: string } {
  const parsed = LichessGameSchema.safeParse(value)
  if (!parsed.success) return { reason: 'schema_rejected' }
  const game = parsed.data
  if (!FINISHED_STATUSES.has(game.status) || game.lastMoveAt > syncStartedAt.getTime() || game.initialFen) {
    return { reason: 'not_eligible' }
  }
  const white = game.players.white.user.id.toLocaleLowerCase('en-US') === accountId.toLocaleLowerCase('en-US')
  const black = game.players.black.user.id.toLocaleLowerCase('en-US') === accountId.toLocaleLowerCase('en-US')
  if (white === black) return { reason: 'account_mismatch' }
  const openingName = safeOpeningName(game.opening.name)
  if (!openingName) return { reason: 'invalid_opening_name' }
  const side = white ? 'white' : 'black'
  const draw = !game.winner && ['stalemate', 'draw', 'insufficientMaterialClaim'].includes(game.status)
  if (!draw && !game.winner) return { reason: 'missing_result' }
  const outcome = draw ? 'draw' : game.winner === side ? 'win' : 'loss'
  const chess = new Chess()
  const tokens = game.moves.trim() ? game.moves.trim().split(/\s+/u) : []
  if (tokens.length === 0 || tokens.length > 2_048) return { reason: 'invalid_movetext' }
  const edges: PersonalOpeningEdge[] = []
  try {
    for (const [index, sanInput] of tokens.entries()) {
      const fromEpd = epd(chess)
      const move = chess.move(sanInput, { strict: false })
      if (!move) return { reason: 'invalid_movetext' }
      if (index < 30) edges.push({
        ply: index + 1,
        fromEpd,
        uci: `${move.from}${move.to}${move.promotion ?? ''}`,
        san: move.san,
        toEpd: epd(chess),
      })
    }
  } catch {
    return { reason: 'invalid_movetext' }
  }
  return { aggregate: {
    gameIdDigest: digestGameId(game.id),
    lastMoveAt: game.lastMoveAt,
    speed: game.speed,
    side,
    outcome,
    openingEco: game.opening.eco,
    openingName,
    openingPly: game.opening.ply,
    playerRating: white ? game.players.white.rating : game.players.black.rating,
    edges,
  } }
}

async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      if (Buffer.byteLength(pending, 'utf8') > MAX_NDJSON_LINE_BYTES && !pending.includes('\n')) {
        throw new ApiError(502, 'provider_line_too_large', 'Lichess returned an oversized game record')
      }
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/u, '')
        pending = pending.slice(newline + 1)
        if (Buffer.byteLength(line, 'utf8') > MAX_NDJSON_LINE_BYTES) {
          throw new ApiError(502, 'provider_line_too_large', 'Lichess returned an oversized game record')
        }
        if (line.trim()) yield line
        newline = pending.indexOf('\n')
      }
      if (done) break
    }
    if (pending.trim()) yield pending
  } catch (error) {
    if (error instanceof TypeError) throw new ApiError(502, 'provider_malformed_unicode', 'Lichess returned malformed UTF-8')
    throw error
  } finally {
    reader.releaseLock()
  }
}

export async function processLichessGameResponse(
  response: Response,
  accountId: string,
  syncStartedAt: Date,
): Promise<LichessStreamResult> {
  const accepted: PersonalGameAggregate[] = []
  const rejected: Record<string, number> = {}
  let cursor: LichessSyncCursor | null = null
  for await (const chunk of streamLichessGameResponse(response, accountId, syncStartedAt)) {
    accepted.push(...chunk.accepted)
    for (const [reason, count] of Object.entries(chunk.rejected)) rejected[reason] = (rejected[reason] ?? 0) + count
    cursor = laterCursor(cursor, chunk.cursor)
  }
  return { accepted, rejected, cursor }
}

/**
 * Parses a provider body incrementally. Each yielded chunk is independently
 * commit-safe: its cursor covers all safely identified records in that chunk,
 * including eligible records that were rejected from private analytics.
 */
export async function* streamLichessGameResponse(
  response: Response,
  accountId: string,
  syncStartedAt: Date,
  batchSize = 250,
): AsyncGenerator<LichessStreamChunk> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) throw new RangeError('Invalid Lichess stream batch size')
  if (response.status === 429) throw new ApiError(429, 'provider_rate_limited', 'Lichess requested a cooldown', { retryAfterSeconds: 60 })
  if (!response.ok || !response.body) throw new ApiError(502, 'provider_games_failed', 'Could not stream finished Lichess games')
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/x-ndjson') throw new ApiError(502, 'invalid_provider_response', 'Lichess did not return NDJSON')
  let accepted: PersonalGameAggregate[] = []
  let rejected: Record<string, number> = {}
  let cursor: LichessSyncCursor | null = null
  let records = 0
  let chunkRecords = 0
  for await (const line of ndjsonLines(response.body)) {
    records += 1
    chunkRecords += 1
    if (records > MAX_STREAM_GAMES) throw new ApiError(502, 'provider_stream_too_large', 'Lichess returned too many games in one sync')
    let value: unknown
    try {
      value = JSON.parse(line)
      cursor = laterCursor(cursor, observedCursor(value, syncStartedAt))
      const result = parseGame(value, accountId, syncStartedAt)
      if ('reason' in result) rejected[result.reason] = (rejected[result.reason] ?? 0) + 1
      else accepted.push(result.aggregate)
    } catch {
      rejected.malformed_json = (rejected.malformed_json ?? 0) + 1
    }
    if (chunkRecords >= batchSize) {
      yield { accepted, rejected, cursor, records: chunkRecords }
      accepted = []
      rejected = {}
      cursor = null
      chunkRecords = 0
    }
  }
  if (chunkRecords > 0) yield { accepted, rejected, cursor, records: chunkRecords }
}

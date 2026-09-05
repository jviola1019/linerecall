import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import { createZstdDecompress } from 'node:zlib'
import { Chess, DEFAULT_POSITION, type Move, type PieceSymbol, type Square } from 'chess.js'
import {
  ratingBandFor,
  type GameResult,
  type RatingBand,
  type RejectionReason,
} from './broadcast-contracts.ts'

export interface PgnLimits {
  maxGameBytes: number
  maxLineBytes: number
  maxHeaders: number
  maxPlies: number
}

export const DEFAULT_PGN_LIMITS: Readonly<PgnLimits> = {
  maxGameBytes: 2 * 1024 * 1024,
  maxLineBytes: 64 * 1024,
  maxHeaders: 256,
  maxPlies: 1_000,
}

export interface PgnRecord {
  pgn: string | null
  rejection?: 'record_too_large' | 'line_too_long'
}

export interface ParsedBroadcastGame {
  headers: Record<string, string>
  result: GameResult
  whiteElo: number
  blackElo: number
  ratingBand: RatingBand
  deduplicationKey: string
  moves: Array<Pick<Move, 'from' | 'to' | 'promotion'>>
}

export type ParseBroadcastResult =
  | { accepted: true; game: ParsedBroadcastGame }
  | { accepted: false; reason: RejectionReason }

/**
 * Yield one bounded PGN at a time. Boundaries are recognized when a new tag
 * section follows movetext, so the decompressed corpus is never buffered whole.
 */
export async function* splitPgnStream(
  input: Readable,
  limits: Pick<PgnLimits, 'maxGameBytes' | 'maxLineBytes'> = DEFAULT_PGN_LIMITS,
): AsyncGenerator<PgnRecord> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  let current: string[] = []
  let bytes = 0
  let sawMovetext = false
  let previousBlank = false
  let rejection: PgnRecord['rejection']

  const reset = (): void => {
    current = []
    bytes = 0
    sawMovetext = false
    previousBlank = false
    rejection = undefined
  }

  const finish = (): PgnRecord | null => {
    if (current.length === 0 && !rejection) return null
    if (rejection) return { pgn: null, rejection }
    return { pgn: `${current.join('\n').trim()}\n` }
  }

  for await (const line of lines) {
    const isHeader = /^\[[A-Za-z0-9_]+\s+"/.test(line)
    if (sawMovetext && previousBlank && isHeader) {
      const record = finish()
      if (record) yield record
      reset()
    }
    if (current.length === 0 && line.trim() === '') continue

    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (!rejection && lineBytes > limits.maxLineBytes) rejection = 'line_too_long'
    bytes += lineBytes + 1
    if (!rejection && bytes > limits.maxGameBytes) rejection = 'record_too_large'
    if (!rejection) current.push(line)

    if (line.trim() !== '' && !isHeader) sawMovetext = true
    previousBlank = line.trim() === ''
  }
  const finalRecord = finish()
  if (finalRecord) yield finalRecord
}

const ZSTD_FRAME_MAGIC = 0xfd2fb528
const ZSTD_SKIPPABLE_MIN = 0x184d2a50
const ZSTD_SKIPPABLE_MAX = 0x184d2a5f

/**
 * Lichess broadcast files wrap each independent Zstandard frame in a four-byte
 * skippable record containing that frame's compressed byte length. Strip every
 * wrapper while validating all declared boundaries and frame magic values.
 */
async function* zstdPayloadChunks(path: string): AsyncGenerator<Buffer> {
  const file = await open(path, 'r')
  try {
    const details = await file.stat()
    let offset = 0
    let frameCount = 0
    while (offset < details.size) {
      if (frameCount > 10_000) throw new Error(`${path}: unreasonable Zstandard frame count`)
      const header = Buffer.alloc(12)
      const { bytesRead } = await file.read(header, 0, 12, offset)
      if (bytesRead < 4) throw new Error(`${path}: truncated Zstandard header at byte ${offset}`)
      const descriptor = header.readUInt32LE(0)
      if (descriptor === ZSTD_FRAME_MAGIC && offset === 0) {
        for await (const chunk of createReadStream(path)) yield Buffer.from(chunk)
        return
      }
      if (
        descriptor < ZSTD_SKIPPABLE_MIN ||
        descriptor > ZSTD_SKIPPABLE_MAX ||
        bytesRead < 12 ||
        header.readUInt32LE(4) !== 4
      ) {
        throw new Error(`${path}: unknown Zstandard wrapper at byte ${offset}`)
      }
      const compressedBytes = header.readUInt32LE(8)
      const frameStart = offset + 12
      const frameEndExclusive = frameStart + compressedBytes
      if (compressedBytes < 4 || frameEndExclusive > details.size) {
        throw new Error(`${path}: invalid wrapped Zstandard frame length at byte ${offset}`)
      }
      const magic = Buffer.alloc(4)
      const magicRead = await file.read(magic, 0, 4, frameStart)
      if (magicRead.bytesRead !== 4 || magic.readUInt32LE(0) !== ZSTD_FRAME_MAGIC) {
        throw new Error(`${path}: wrapped payload is not a Zstandard frame at byte ${frameStart}`)
      }
      for await (const chunk of createReadStream(path, {
        start: frameStart,
        end: frameEndExclusive - 1,
      })) {
        yield Buffer.from(chunk)
      }
      frameCount += 1
      offset = frameEndExclusive
    }
    if (frameCount === 0) throw new Error(`${path}: no Zstandard frame found`)
  } finally {
    await file.close()
  }
}

export function createZstdPgnStream(path: string): Readable {
  const compressed = Readable.from(zstdPayloadChunks(path))
  const decompressor = createZstdDecompress()
  compressed.on('error', (error) => decompressor.destroy(error))
  return compressed.pipe(decompressor)
}

export async function* readZstdPgnRecords(
  path: string,
  limits: Pick<PgnLimits, 'maxGameBytes' | 'maxLineBytes'> = DEFAULT_PGN_LIMITS,
): AsyncGenerator<PgnRecord> {
  yield* splitPgnStream(createZstdPgnStream(path), limits)
}

function topLevelMovetextResult(pgn: string): string | null {
  const movetext = pgn
    .split(/\r?\n/u)
    .filter((line) => !/^\s*\[/u.test(line))
    .join('\n')
  let token = ''
  let result: string | null = null
  let variationDepth = 0
  let inBraceComment = false
  let inSemicolonComment = false
  const flush = (): void => {
    if (variationDepth === 0 && /^(?:1-0|0-1|1\/2-1\/2|\*)$/u.test(token)) result = token
    token = ''
  }
  for (const character of movetext) {
    if (inSemicolonComment) {
      if (character === '\n') inSemicolonComment = false
      continue
    }
    if (inBraceComment) {
      if (character === '}') inBraceComment = false
      continue
    }
    if (character === '{') { flush(); inBraceComment = true; continue }
    if (character === ';') { flush(); inSemicolonComment = true; continue }
    if (character === '(') { flush(); variationDepth += 1; continue }
    if (character === ')') { flush(); variationDepth = Math.max(0, variationDepth - 1); continue }
    if (/\s/u.test(character)) flush()
    else token += character
  }
  flush()
  return result
}

function parsePositiveRating(value: string | undefined): number | null {
  if (!value || !/^\d{1,4}$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 4_000 ? parsed : null
}

function countHeaderLines(pgn: string): number {
  let count = 0
  for (const line of pgn.split(/\r?\n/)) {
    if (/^\[[A-Za-z0-9_]+\s+"/.test(line)) count += 1
    else if (line.trim() !== '') break
  }
  return count
}

function decodePgnTagValue(value: string): string {
  return value.replace(/\\(["\\])/gu, '$1')
}

function parseLeadingHeaders(pgn: string): Record<string, string> | null {
  const headers: Record<string, string> = {}
  let sawHeader = false
  for (const line of pgn.split(/\r?\n/u)) {
    if (line.trim() === '') {
      if (sawHeader) break
      continue
    }
    if (!line.startsWith('[')) break
    const match = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\["\\])*)"\]\s*$/u.exec(line)
    if (!match?.[1] || match[2] === undefined) return null
    headers[match[1]] = decodePgnTagValue(match[2])
    sawHeader = true
  }
  return sawHeader ? headers : null
}

/**
 * chess.js 1.4 rejects consecutive legal PGN comments. Comments carry no
 * backtest semantics, so remove them with a bounded state machine before
 * asking chess.js to validate the complete mainline. Tag-pair lines are kept
 * byte-for-byte and malformed unterminated/stray brace comments fail closed.
 */
function withoutMovetextComments(pgn: string): string | null {
  const separator = /\r?\n\s*\r?\n/u.exec(pgn)
  if (!separator || separator.index === undefined) return null
  const movetextStart = separator.index + separator[0].length
  const headers = pgn.slice(0, movetextStart)
  const movetext = pgn.slice(movetextStart)
  let output = ''
  let inBraceComment = false
  let inSemicolonComment = false
  let needsSeparator = false
  for (const character of movetext) {
    if (inSemicolonComment) {
      if (character === '\n') {
        inSemicolonComment = false
        output += '\n'
        needsSeparator = false
      }
      continue
    }
    if (inBraceComment) {
      if (character === '}') {
        inBraceComment = false
        needsSeparator = true
      }
      continue
    }
    if (character === '}') return null
    if (character === '{') {
      inBraceComment = true
      if (output.length > 0 && !/\s$/u.test(output)) output += ' '
      continue
    }
    if (character === ';') {
      inSemicolonComment = true
      if (output.length > 0 && !/\s$/u.test(output)) output += ' '
      continue
    }
    if (needsSeparator && !/\s/u.test(character) && output.length > 0 && !/\s$/u.test(output)) {
      output += ' '
    }
    needsSeparator = false
    output += character
  }
  if (inBraceComment) return null
  return `${headers}${output}`
}

interface PinnedChessJsInternalMove {
  from: number
  to: number
  promotion?: string
}

interface PinnedChessJsHistoryEntry {
  move: PinnedChessJsInternalMove
}

function algebraicFrom0x88(square: number): Square {
  const file = square & 15
  const rankIndex = square >> 4
  if (!Number.isInteger(square) || file < 0 || file > 7 || rankIndex < 0 || rankIndex > 7) {
    throw new Error('chess.js returned an invalid internal square')
  }
  return `${'abcdefgh'[file]}${8 - rankIndex}` as Square
}

/**
 * chess.js validates and stores every parsed move, but its public history()
 * method regenerates all legal moves and SAN a second time. The corpus only
 * needs coordinates; with the dependency pinned to 1.4.0, read that audited
 * history shape and fail closed if it changes. Chess rules and PGN legality
 * still remain entirely delegated to chess.js.
 */
function coordinateHistory(chess: Chess): ParsedBroadcastGame['moves'] {
  const history = (chess as unknown as { _history?: unknown })._history
  if (!Array.isArray(history)) throw new Error('Unsupported chess.js history shape')
  return history.map((untrusted): ParsedBroadcastGame['moves'][number] => {
    if (typeof untrusted !== 'object' || untrusted === null || !('move' in untrusted)) {
      throw new Error('Unsupported chess.js history entry')
    }
    const move = (untrusted as PinnedChessJsHistoryEntry).move
    if (
      typeof move !== 'object' ||
      move === null ||
      !Number.isInteger(move.from) ||
      !Number.isInteger(move.to) ||
      (move.promotion !== undefined && !/^[qrbn]$/u.test(move.promotion))
    ) {
      throw new Error('Unsupported chess.js internal move')
    }
    const from = algebraicFrom0x88(move.from)
    const to = algebraicFrom0x88(move.to)
    return move.promotion === undefined
      ? { from, to }
      : { from, to, promotion: move.promotion as PieceSymbol }
  })
}

function normalizedGameUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'lichess.org' ||
      !url.pathname.startsWith('/broadcast/')
    ) {
      return null
    }
    url.hostname = 'lichess.org'
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return null
  }
}

function fallbackGameHash(
  headers: Record<string, string>,
  result: GameResult,
  moves: ParsedBroadcastGame['moves'],
): string {
  const identityHeaders = [
    'White',
    'Black',
    'UTCDate',
    'Date',
    'UTCTime',
    'Round',
    'Board',
    'Event',
  ].map((name) => headers[name]?.trim() ?? '')
  const uci = moves.map((move) => `${move.from}${move.to}${move.promotion ?? ''}`).join(' ')
  return createHash('sha256')
    .update(JSON.stringify([identityHeaders, result, uci]))
    .digest('hex')
}

export function parseBroadcastPgn(
  pgn: string,
  limits: Pick<PgnLimits, 'maxHeaders' | 'maxPlies'> = DEFAULT_PGN_LIMITS,
): ParseBroadcastResult {
  if (countHeaderLines(pgn) > limits.maxHeaders) {
    return { accepted: false, reason: 'too_many_headers' }
  }
  const preflightHeaders = parseLeadingHeaders(pgn)
  if (preflightHeaders === null) return { accepted: false, reason: 'malformed_pgn' }
  if (!preflightHeaders.Variant) return { accepted: false, reason: 'missing_variant' }
  if (preflightHeaders.Variant.trim().toLowerCase() !== 'standard') {
    return { accepted: false, reason: 'non_standard_variant' }
  }
  if (
    preflightHeaders.Result !== '1-0' &&
    preflightHeaders.Result !== '0-1' &&
    preflightHeaders.Result !== '1/2-1/2'
  ) {
    return { accepted: false, reason: 'invalid_result' }
  }
  if (topLevelMovetextResult(pgn) !== preflightHeaders.Result) {
    return { accepted: false, reason: 'invalid_result' }
  }
  const preflightWhiteElo = parsePositiveRating(preflightHeaders.WhiteElo)
  if (preflightWhiteElo === null) return { accepted: false, reason: 'invalid_white_elo' }
  const preflightBlackElo = parsePositiveRating(preflightHeaders.BlackElo)
  if (preflightBlackElo === null) return { accepted: false, reason: 'invalid_black_elo' }
  if (preflightHeaders.FEN) {
    try {
      if (normalizedEpd(new Chess(preflightHeaders.FEN)) !== normalizedEpd(new Chess(DEFAULT_POSITION))) {
        return { accepted: false, reason: 'non_initial_position' }
      }
    } catch {
      return { accepted: false, reason: 'malformed_pgn' }
    }
  }
  const chess = new Chess()
  try {
    const normalizedPgn = withoutMovetextComments(pgn)
    if (normalizedPgn === null) return { accepted: false, reason: 'malformed_pgn' }
    chess.loadPgn(normalizedPgn, { strict: false })
  } catch {
    return { accepted: false, reason: 'malformed_pgn' }
  }
  const headers = chess.getHeaders()
  for (const field of ['Variant', 'Result', 'WhiteElo', 'BlackElo', 'FEN'] as const) {
    if ((headers[field] ?? undefined) !== (preflightHeaders[field] ?? undefined)) {
      return { accepted: false, reason: 'malformed_pgn' }
    }
  }
  if (!headers.Variant) return { accepted: false, reason: 'missing_variant' }
  if (headers.Variant.trim().toLowerCase() !== 'standard') {
    return { accepted: false, reason: 'non_standard_variant' }
  }
  if (headers.Result !== '1-0' && headers.Result !== '0-1' && headers.Result !== '1/2-1/2') {
    return { accepted: false, reason: 'invalid_result' }
  }
  if (topLevelMovetextResult(pgn) !== headers.Result) {
    return { accepted: false, reason: 'invalid_result' }
  }
  const whiteElo = parsePositiveRating(headers.WhiteElo)
  if (whiteElo === null) return { accepted: false, reason: 'invalid_white_elo' }
  const blackElo = parsePositiveRating(headers.BlackElo)
  if (blackElo === null) return { accepted: false, reason: 'invalid_black_elo' }

  if (headers.FEN) {
    try {
      if (normalizedEpd(new Chess(headers.FEN)) !== normalizedEpd(new Chess(DEFAULT_POSITION))) {
        return { accepted: false, reason: 'non_initial_position' }
      }
    } catch {
      return { accepted: false, reason: 'malformed_pgn' }
    }
  }

  let coordinateMoves: ParsedBroadcastGame['moves']
  try {
    coordinateMoves = coordinateHistory(chess)
  } catch {
    return { accepted: false, reason: 'malformed_pgn' }
  }
  if (coordinateMoves.length > limits.maxPlies) {
    return { accepted: false, reason: 'too_many_plies' }
  }
  const moves = coordinateMoves
  const result = headers.Result
  const gameUrl = normalizedGameUrl(headers.GameURL)
  const deduplicationKey = gameUrl
    ? `url:${gameUrl}`
    : `sha256:${fallbackGameHash(headers, result, moves)}`
  return {
    accepted: true,
    game: {
      headers,
      result,
      whiteElo,
      blackElo,
      ratingBand: ratingBandFor(whiteElo, blackElo),
      deduplicationKey,
      moves,
    },
  }
}

/**
 * Normalize to piece placement, side, castling rights, and a legally usable
 * en-passant square. Move clocks are intentionally excluded.
 */
export function normalizedEpd(chess: Chess): string {
  const fields = chess.fen().split(' ')
  if (fields.length !== 6) throw new Error(`Unexpected FEN emitted by chess.js: ${chess.fen()}`)
  let enPassant = fields[3] ?? '-'
  if (
    enPassant !== '-' &&
    !chess.moves({ verbose: true }).some((move) => move.flags.includes('e'))
  ) {
    enPassant = '-'
  }
  return `${fields[0]} ${fields[1]} ${fields[2]} ${enPassant}`
}

export function uciForMove(move: Pick<Move, 'from' | 'to' | 'promotion'>): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`
}

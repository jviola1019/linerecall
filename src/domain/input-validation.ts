import { Chess, DEFAULT_POSITION, type Move, type PieceSymbol, type Square } from 'chess.js'

export const INPUT_LIMITS = Object.freeze({
  searchCharacters: 128,
  moveSequenceCharacters: 512,
  moveSequenceTokens: 64,
  pgnBytes: 32 * 1024,
  pgnPlies: 200,
  pgnHeaders: 64,
  pgnLineCharacters: 4_096,
  pgnTokenCharacters: 128,
})

export interface ParsedMoveInput {
  uci: string[]
  san: string[]
  epds: string[]
}

export interface OpeningSearchEntry {
  sourceLineId: string
  eco: string
  name: string
  pgn: string
  uci: string[]
  terminalEpd: string
  terminalSampleSize: number
  backtestEligible: boolean
  verifiedVariantIds: string[]
}

export interface OpeningSearchMatch extends OpeningSearchEntry {
  matchKind: 'text' | 'move_prefix' | 'transposition'
  matchedPlies: number
}

function hasMalformedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function assertSafeUnicode(value: string, label: string): void {
  if (value.includes('\0')) throw new Error(`${label} contains a forbidden NUL character`)
  if (hasMalformedUnicode(value)) throw new Error(`${label} contains malformed Unicode`)
}

export function normalizeSearchQuery(value: string): string {
  assertSafeUnicode(value, 'Search')
  if (/\p{Cc}/u.test(value)) throw new Error('Search contains a forbidden control character')
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if ([...normalized].length > INPUT_LIMITS.searchCharacters) {
    throw new Error(`Search is limited to ${INPUT_LIMITS.searchCharacters} characters`)
  }
  return normalized
}

function moveParts(uci: string): { from: Square; to: Square; promotion?: PieceSymbol } {
  const promotion = uci[4] as PieceSymbol | undefined
  return promotion === undefined
    ? { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square }
    : { from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, promotion }
}

export function normalizedEpd(chess: Chess): string {
  const [placement, turn, castling, rawEnPassant] = chess.fen().split(/\s+/u)
  if (!placement || !turn || !castling || !rawEnPassant) throw new Error('chess.js returned an invalid FEN')
  const enPassant = rawEnPassant !== '-' && chess.moves({ verbose: true }).some((move) => move.isEnPassant())
    ? rawEnPassant
    : '-'
  return `${placement} ${turn} ${castling} ${enPassant}`
}

function parsedMoves(moves: Move[]): ParsedMoveInput {
  const chess = new Chess()
  const uci: string[] = []
  const san: string[] = []
  const epds = [normalizedEpd(chess)]
  for (const move of moves) {
    const applied = chess.move(moveParts(`${move.from}${move.to}${move.promotion ?? ''}`))
    if (!applied) throw new Error('Could not replay a validated move')
    uci.push(`${applied.from}${applied.to}${applied.promotion ?? ''}`)
    san.push(applied.san)
    epds.push(normalizedEpd(chess))
  }
  return { uci, san, epds }
}

export function parseMoveSequence(value: string): ParsedMoveInput {
  assertSafeUnicode(value, 'Move sequence')
  if (value.length > INPUT_LIMITS.moveSequenceCharacters) {
    throw new Error(`Move sequence is limited to ${INPUT_LIMITS.moveSequenceCharacters} characters`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error('Move sequence contains a forbidden control character')
  }
  const tokens = value
    .trim()
    .split(/\s+/u)
    .map((token) => token.replace(/^\d+\.(?:\.\.)?/u, ''))
    .filter((token) => token !== '' && !/^(?:1-0|0-1|1\/2-1\/2|\*)$/u.test(token))
  if (tokens.length === 0) throw new Error('Enter at least one move')
  if (tokens.length > INPUT_LIMITS.moveSequenceTokens) {
    throw new Error(`Move sequence is limited to ${INPUT_LIMITS.moveSequenceTokens} move tokens`)
  }
  const chess = new Chess()
  const moves: Move[] = []
  for (const [index, token] of tokens.entries()) {
    if ([...token].length > INPUT_LIMITS.pgnTokenCharacters) throw new Error(`Move token ${index + 1} is too long`)
    try {
      const move = /^[a-h][1-8][a-h][1-8][qrbn]?$/u.test(token)
        ? chess.move(moveParts(token))
        : chess.move(token, { strict: false })
      if (!move) throw new Error('move returned null')
      moves.push(move)
    } catch {
      throw new Error(`Move ${index + 1} (“${token}”) is not legal in this position`)
    }
  }
  return parsedMoves(moves)
}

function withoutComments(pgn: string): string | null {
  const startsWithHeaders = /^\s*\[/u.test(pgn)
  const separator = startsWithHeaders ? /\r?\n\s*\r?\n/u.exec(pgn) : null
  if (startsWithHeaders && (!separator || separator.index === undefined)) return null
  const movetextStart = separator && separator.index !== undefined
    ? separator.index + separator[0].length
    : 0
  let output = pgn.slice(0, movetextStart)
  let inBrace = false
  let inSemicolon = false
  for (let index = movetextStart; index < pgn.length; index += 1) {
    const character = pgn[index]!
    if (inSemicolon) {
      if (character === '\n') { inSemicolon = false; output += '\n' }
      continue
    }
    if (inBrace) {
      if (character === '}') { inBrace = false; output += ' ' }
      continue
    }
    if (character === '}') return null
    if (character === '{') { inBrace = true; output += ' '; continue }
    if (character === ';') { inSemicolon = true; output += ' '; continue }
    output += character
  }
  return inBrace ? null : output
}

export function parsePgnForSearch(value: string): ParsedMoveInput {
  assertSafeUnicode(value, 'PGN')
  if (new TextEncoder().encode(value).byteLength > INPUT_LIMITS.pgnBytes) {
    throw new Error(`PGN is limited to ${INPUT_LIMITS.pgnBytes / 1024} KB`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error('PGN contains a forbidden control character')
  }
  const lines = value.split(/\r?\n/u)
  if (lines.some((line) => [...line].length > INPUT_LIMITS.pgnLineCharacters)) {
    throw new Error(`PGN lines are limited to ${INPUT_LIMITS.pgnLineCharacters} characters`)
  }
  if (lines.some((line) => line.split(/\s+/u).some((token) => [...token].length > INPUT_LIMITS.pgnTokenCharacters))) {
    throw new Error(`PGN tokens are limited to ${INPUT_LIMITS.pgnTokenCharacters} characters`)
  }
  const headerCount = lines.filter((line) => /^\s*\[[A-Za-z0-9_]+\s+"/u.test(line)).length
  if (headerCount > INPUT_LIMITS.pgnHeaders) throw new Error(`PGN is limited to ${INPUT_LIMITS.pgnHeaders} headers`)
  const normalized = withoutComments(value)
  if (normalized === null) throw new Error('PGN contains an unterminated or stray comment')
  const movetext = normalized
    .split(/\r?\n/u)
    .filter((line) => !/^\s*\[/u.test(line))
    .join(' ')
  if (movetext.split(/\s+/u).some((token) => [...token].length > INPUT_LIMITS.pgnTokenCharacters)) {
    throw new Error(`PGN tokens are limited to ${INPUT_LIMITS.pgnTokenCharacters} characters`)
  }
  const chess = new Chess()
  try {
    chess.loadPgn(normalized, { strict: false })
  } catch {
    throw new Error('PGN movetext is malformed or contains an illegal move')
  }
  const headers = chess.getHeaders()
  if (headers.Variant && headers.Variant.trim().toLowerCase() !== 'standard') {
    throw new Error('Only Standard chess PGNs can be searched')
  }
  if (headers.FEN) {
    try {
      if (normalizedEpd(new Chess(headers.FEN)) !== normalizedEpd(new Chess(DEFAULT_POSITION))) {
        throw new Error('non-initial')
      }
    } catch {
      throw new Error('PGN must begin from the standard initial position')
    }
  }
  const moves = chess.history({ verbose: true })
  if (moves.length === 0) throw new Error('PGN does not contain any moves')
  if (moves.length > INPUT_LIMITS.pgnPlies) throw new Error(`PGN is limited to ${INPUT_LIMITS.pgnPlies} plies`)
  return parsedMoves(moves)
}

function normalizedText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
}

export function searchOpenings(
  entries: readonly OpeningSearchEntry[],
  query: string,
  parsedMovesInput?: ParsedMoveInput,
  maximum = 100,
): OpeningSearchMatch[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 500) throw new Error('Search result limit is invalid')
  if (parsedMovesInput) {
    const inputPositions = new Map(parsedMovesInput.epds.map((epd, index) => [epd, index]))
    return entries
      .flatMap((entry): OpeningSearchMatch[] => {
        let prefix = 0
        while (prefix < entry.uci.length && entry.uci[prefix] === parsedMovesInput.uci[prefix]) prefix += 1
        const transpositionPly = inputPositions.get(entry.terminalEpd)
        if (prefix === 0 && transpositionPly === undefined) return []
        const exactPrefix = prefix === entry.uci.length || prefix === parsedMovesInput.uci.length
        return [{
          ...entry,
          matchKind: exactPrefix && prefix > 0 ? 'move_prefix' : 'transposition',
          matchedPlies: Math.max(prefix, transpositionPly ?? 0),
        }]
      })
      .sort((left, right) =>
        right.matchedPlies - left.matchedPlies ||
        right.terminalSampleSize - left.terminalSampleSize ||
        left.eco.localeCompare(right.eco, 'en') ||
        left.name.localeCompare(right.name, 'en')
      )
      .slice(0, maximum)
  }
  const normalizedQuery = normalizedText(normalizeSearchQuery(query))
  if (normalizedQuery === '') return []
  const terms = normalizedQuery.split(/\s+/u)
  return entries
    .filter((entry) => {
      const haystack = normalizedText(`${entry.eco} ${entry.name} ${entry.pgn} ${entry.uci.join(' ')}`)
      return terms.every((term) => haystack.includes(term))
    })
    .sort((left, right) =>
      Number(right.eco.toLocaleLowerCase('en-US') === normalizedQuery) - Number(left.eco.toLocaleLowerCase('en-US') === normalizedQuery) ||
      right.terminalSampleSize - left.terminalSampleSize ||
      left.eco.localeCompare(right.eco, 'en') ||
      left.name.localeCompare(right.name, 'en')
    )
    .slice(0, maximum)
    .map((entry) => ({ ...entry, matchKind: 'text', matchedPlies: 0 }))
}

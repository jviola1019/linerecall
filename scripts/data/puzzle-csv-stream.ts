export const PUZZLE_CSV_MAX_RECORD_BYTES = 16 * 1024
export const PUZZLE_CSV_MAX_FIELD_BYTES = 8 * 1024
export const PUZZLE_CSV_EXPECTED_FIELDS = 10

export type PuzzleCsvRecord =
  | { accepted: true; recordNumber: number; fields: string[]; bytes: number }
  | {
      accepted: false
      recordNumber: number
      reason: 'malformed_csv' | 'record_too_long' | 'field_too_long' | 'too_many_fields'
      bytes: number
    }

export interface PuzzleCsvStreamLimits {
  maximumRecordBytes: number
  maximumFieldBytes: number
  maximumFields: number
}

const DEFAULT_LIMITS: PuzzleCsvStreamLimits = Object.freeze({
  maximumRecordBytes: PUZZLE_CSV_MAX_RECORD_BYTES,
  maximumFieldBytes: PUZZLE_CSV_MAX_FIELD_BYTES,
  maximumFields: PUZZLE_CSV_EXPECTED_FIELDS,
})

function validateLimits(limits: PuzzleCsvStreamLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024) {
      throw new Error(`Puzzle CSV ${name} must be a positive integer no larger than 1 MiB`)
    }
  }
}

/**
 * Streaming RFC-4180 record parser with hard memory bounds. Quoted CR/LF and
 * escaped quotes are accepted even when a UTF-8 sequence or escape pair spans
 * chunks. A malformed record is consumed through its record boundary and
 * returned as rejected; invalid UTF-8 aborts the stream because its boundaries
 * cannot be trusted.
 */
export async function* streamPuzzleCsvRecords(
  chunks: AsyncIterable<Uint8Array | string>,
  limitsInput: Partial<PuzzleCsvStreamLimits> = {},
): AsyncGenerator<PuzzleCsvRecord> {
  const limits: PuzzleCsvStreamLimits = { ...DEFAULT_LIMITS, ...limitsInput }
  validateLimits(limits)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let fields: string[] = []
  let field = ''
  let fieldBytes = 0
  let recordBytes = 0
  let recordNumber = 0
  let mode: 'unquoted' | 'quoted' | 'after-quote' = 'unquoted'
  let atFieldStart = true
  let malformed = false
  let recordTooLong = false
  let fieldTooLong = false
  let tooManyFields = false
  let skipLineFeed = false
  let hasRecordContent = false

  const results: PuzzleCsvRecord[] = []

  const append = (character: string): void => {
    const bytes = Buffer.byteLength(character, 'utf8')
    fieldBytes += bytes
    if (fieldBytes > limits.maximumFieldBytes) {
      fieldTooLong = true
      return
    }
    if (!fieldTooLong && !recordTooLong) field += character
  }

  const finishField = (): void => {
    if (fields.length >= limits.maximumFields) {
      tooManyFields = true
    } else if (!recordTooLong && !fieldTooLong) {
      fields.push(field)
    }
    field = ''
    fieldBytes = 0
    atFieldStart = true
    mode = 'unquoted'
  }

  const reset = (): void => {
    fields = []
    field = ''
    fieldBytes = 0
    recordBytes = 0
    mode = 'unquoted'
    atFieldStart = true
    malformed = false
    recordTooLong = false
    fieldTooLong = false
    tooManyFields = false
    hasRecordContent = false
  }

  const finishRecord = (): void => {
    recordNumber += 1
    if (mode === 'quoted') malformed = true
    finishField()
    const bytes = recordBytes
    if (recordTooLong) {
      results.push({ accepted: false, recordNumber, reason: 'record_too_long', bytes })
    } else if (fieldTooLong) {
      results.push({ accepted: false, recordNumber, reason: 'field_too_long', bytes })
    } else if (tooManyFields) {
      results.push({ accepted: false, recordNumber, reason: 'too_many_fields', bytes })
    } else if (malformed) {
      results.push({ accepted: false, recordNumber, reason: 'malformed_csv', bytes })
    } else {
      results.push({ accepted: true, recordNumber, fields, bytes })
    }
    reset()
  }

  const processText = (text: string): void => {
    for (const character of text) {
      if (skipLineFeed) {
        skipLineFeed = false
        if (character === '\n') continue
      }
      hasRecordContent = true
      const bytes = Buffer.byteLength(character, 'utf8')
      recordBytes = Math.min(Number.MAX_SAFE_INTEGER, recordBytes + bytes)
      if (recordBytes > limits.maximumRecordBytes) recordTooLong = true

      if (mode === 'quoted') {
        if (character === '"') {
          mode = 'after-quote'
        } else {
          if (character === '\0' || (/^[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]$/u).test(character)) {
            malformed = true
          }
          append(character)
        }
        continue
      }

      if (mode === 'after-quote') {
        if (character === '"') {
          append('"')
          mode = 'quoted'
        } else if (character === ',') {
          finishField()
        } else if (character === '\r' || character === '\n') {
          if (character === '\r') skipLineFeed = true
          finishRecord()
        } else {
          malformed = true
          mode = 'unquoted'
        }
        continue
      }

      if (character === ',') {
        finishField()
      } else if (character === '\r' || character === '\n') {
        if (character === '\r') skipLineFeed = true
        finishRecord()
      } else if (character === '"') {
        if (!atFieldStart) malformed = true
        else mode = 'quoted'
        atFieldStart = false
      } else {
        if (character === '\0' || (/^[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]$/u).test(character)) {
          malformed = true
        }
        append(character)
        atFieldStart = false
      }
    }
  }

  try {
    for await (const chunk of chunks) {
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      processText(text)
      while (results.length > 0) yield results.shift()!
    }
    processText(decoder.decode())
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Puzzle CSV stream contains malformed UTF-8', { cause: error })
    throw error
  }
  if (hasRecordContent || fields.length > 0 || field.length > 0 || mode !== 'unquoted') finishRecord()
  while (results.length > 0) yield results.shift()!
}

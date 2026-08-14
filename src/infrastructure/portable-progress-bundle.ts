import { z } from 'zod'
import {
  FamilyTrainingJournalSnapshotV1Schema,
  type FamilyTrainingJournalSnapshotV1,
} from '../domain/family-training-journal.ts'
import { ProgressV1Schema, type ProgressV1 } from '../domain/progress.ts'
import { PuzzleProgressV1Schema, type PuzzleProgress } from '../domain/puzzle-progress.ts'
import {
  MAX_PROGRESS_IMPORT_BYTES,
  migrateProgress,
} from './progress-repository.ts'

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export const PORTABLE_PROGRESS_BUNDLE_FORMAT = 'linerecall-portable-progress' as const

export const PortableProgressBundleV1Schema = z.object({
  format: z.literal(PORTABLE_PROGRESS_BUNDLE_FORMAT),
  version: z.literal(1),
  exportedAt: z.string().datetime({ offset: true }),
  openingProgress: ProgressV1Schema,
  puzzleProgress: PuzzleProgressV1Schema,
  familyJournal: FamilyTrainingJournalSnapshotV1Schema,
}).strict()

export type PortableProgressBundleV1 = z.infer<typeof PortableProgressBundleV1Schema>

export type PortableProgressImport =
  | { kind: 'bundle-v1'; bundle: PortableProgressBundleV1 }
  | { kind: 'legacy-progress-only'; progress: ProgressV1 }

function containsMalformedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function rejectReservedKeys(value: unknown): void {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current !== 'object' || current === null) continue
    for (const key of Object.keys(current)) {
      if (RESERVED_KEYS.has(key)) throw new Error('Progress file contains a reserved object key')
      pending.push((current as Record<string, unknown>)[key])
    }
  }
}

function parseBoundedJson(source: string): unknown {
  if (new TextEncoder().encode(source).byteLength > MAX_PROGRESS_IMPORT_BYTES) {
    throw new Error('Progress file exceeds the 1 MB limit')
  }
  if (source.includes('\0')) throw new Error('Progress file contains a forbidden NUL character')
  if (containsMalformedUnicode(source)) throw new Error('Progress file contains malformed Unicode')
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  } catch {
    throw new Error('Progress file is not valid JSON')
  }
  rejectReservedKeys(parsed)
  return parsed
}

export function createPortableProgressBundle(input: {
  openingProgress: ProgressV1
  puzzleProgress: PuzzleProgress
  familyJournal: FamilyTrainingJournalSnapshotV1
  exportedAt?: Date
}): PortableProgressBundleV1 {
  const exportedAt = input.exportedAt ?? new Date()
  if (Number.isNaN(exportedAt.getTime())) throw new Error('Progress export time is invalid')
  return PortableProgressBundleV1Schema.parse({
    format: PORTABLE_PROGRESS_BUNDLE_FORMAT,
    version: 1,
    exportedAt: exportedAt.toISOString(),
    openingProgress: input.openingProgress,
    puzzleProgress: input.puzzleProgress,
    familyJournal: input.familyJournal,
  })
}

export function exportPortableProgressJson(bundle: PortableProgressBundleV1): string {
  return `${JSON.stringify(PortableProgressBundleV1Schema.parse(bundle), null, 2)}\n`
}

/**
 * Accepts the complete portable format and historical progress-only JSON.
 * The caller must preserve puzzle/family state for the legacy result.
 */
export function importPortableProgressJson(source: string): PortableProgressImport {
  const parsed = parseBoundedJson(source)
  if (
    typeof parsed === 'object'
    && parsed !== null
    && Object.hasOwn(parsed, 'format')
  ) {
    const result = PortableProgressBundleV1Schema.safeParse(parsed)
    if (!result.success) {
      throw new Error('Progress bundle has an unsupported version or invalid fields')
    }
    return { kind: 'bundle-v1', bundle: result.data }
  }

  try {
    return { kind: 'legacy-progress-only', progress: migrateProgress(parsed) }
  } catch {
    throw new Error('Progress file has an unsupported version or invalid fields')
  }
}

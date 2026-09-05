import { z } from 'zod'
import type { Square } from 'chess.js'
import type { BoardOrientation } from './board.ts'

export const MAX_BOARD_ANNOTATIONS = 32

export const BoardSquareSchema = z.string().regex(/^[a-h][1-8]$/u)
export const BoardAnnotationToneSchema = z.enum(['study', 'alternative', 'warning'])

const ArrowAnnotationSchema = z.object({
  kind: z.literal('arrow'),
  from: BoardSquareSchema,
  to: BoardSquareSchema,
  tone: BoardAnnotationToneSchema,
}).strict()

const CircleAnnotationSchema = z.object({
  kind: z.literal('circle'),
  square: BoardSquareSchema,
  tone: BoardAnnotationToneSchema,
}).strict()

export const BoardAnnotationSchema = z.discriminatedUnion('kind', [
  ArrowAnnotationSchema,
  CircleAnnotationSchema,
]).superRefine((annotation, context) => {
  if (annotation.kind === 'arrow' && annotation.from === annotation.to) {
    context.addIssue({
      code: 'custom',
      message: 'An annotation arrow must connect two different squares',
      path: ['to'],
    })
  }
})

export const BoardAnnotationListSchema = z.array(BoardAnnotationSchema).max(MAX_BOARD_ANNOTATIONS)

export type BoardAnnotationTone = z.infer<typeof BoardAnnotationToneSchema>
export type BoardAnnotation = z.infer<typeof BoardAnnotationSchema>

export type AnnotationChange = 'added' | 'removed' | 'retagged'

const TONE_LABELS: Readonly<Record<BoardAnnotationTone, string>> = Object.freeze({
  study: 'Study',
  alternative: 'Alternative',
  warning: 'Warning',
})

function geometryKey(annotation: BoardAnnotation): string {
  return annotation.kind === 'arrow'
    ? `arrow:${annotation.from}:${annotation.to}`
    : `circle:${annotation.square}`
}

export function annotationKey(annotation: BoardAnnotation): string {
  return `${geometryKey(annotation)}:${annotation.tone}`
}

export function annotationDescription(annotation: BoardAnnotation): string {
  const tone = TONE_LABELS[annotation.tone]
  return annotation.kind === 'arrow'
    ? `${tone} arrow from ${annotation.from} to ${annotation.to}`
    : `${tone} circle on ${annotation.square}`
}

export function toggleBoardAnnotation(
  current: readonly BoardAnnotation[],
  candidate: BoardAnnotation,
): { annotations: BoardAnnotation[]; change: AnnotationChange } {
  const annotations = BoardAnnotationListSchema.parse(current)
  const next = BoardAnnotationSchema.parse(candidate)
  const index = annotations.findIndex((annotation) => geometryKey(annotation) === geometryKey(next))
  if (index >= 0) {
    const existing = annotations[index]
    if (existing?.tone === next.tone) {
      return {
        annotations: annotations.filter((_annotation, annotationIndex) => annotationIndex !== index),
        change: 'removed',
      }
    }
    const replaced = [...annotations]
    replaced[index] = next
    return { annotations: BoardAnnotationListSchema.parse(replaced), change: 'retagged' }
  }
  if (annotations.length >= MAX_BOARD_ANNOTATIONS) {
    throw new Error(`A board can contain at most ${MAX_BOARD_ANNOTATIONS} annotations`)
  }
  return {
    annotations: BoardAnnotationListSchema.parse([...annotations, next]),
    change: 'added',
  }
}

export function removeBoardAnnotation(
  current: readonly BoardAnnotation[],
  annotation: BoardAnnotation,
): BoardAnnotation[] {
  const target = annotationKey(BoardAnnotationSchema.parse(annotation))
  return BoardAnnotationListSchema.parse(current).filter((candidate) => annotationKey(candidate) !== target)
}

export function boardAnnotationPoint(
  square: Square,
  orientation: BoardOrientation,
): { x: number; y: number } {
  const parsed = BoardSquareSchema.parse(square)
  const file = parsed.charCodeAt(0) - 'a'.charCodeAt(0)
  const rank = Number(parsed[1])
  const column = orientation === 'white' ? file : 7 - file
  const row = orientation === 'white' ? 8 - rank : rank - 1
  return {
    x: (column + 0.5) * 12.5,
    y: (row + 0.5) * 12.5,
  }
}

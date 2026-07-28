import { z } from 'zod'
import {
  PuzzleRecordListV1Schema,
  type PuzzleRecord,
} from '../domain/tactical-puzzles.ts'

const ResourceMessageSchema = z.string().trim().min(1).max(512)
const NonEmptyPuzzleListSchema = PuzzleRecordListV1Schema.refine(
  (puzzles) => puzzles.length > 0,
  'This resource state requires at least one puzzle',
)

/**
 * Complete, fail-closed state model for an audited tactical-puzzle shard.
 * `stale` and `offline` may carry previously verified records; corrupt records
 * never remain available through either state.
 */
export const TacticalPuzzleResourceSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('disabled'),
    reason: ResourceMessageSchema,
  }).strict(),
  z.object({
    status: z.literal('loading'),
  }).strict(),
  z.object({
    status: z.literal('ready'),
    puzzles: NonEmptyPuzzleListSchema,
  }).strict(),
  z.object({
    status: z.literal('empty'),
    reason: ResourceMessageSchema,
  }).strict(),
  z.object({
    status: z.literal('stale'),
    puzzles: NonEmptyPuzzleListSchema,
    staleAt: z.string().datetime({ offset: true }),
    reason: ResourceMessageSchema,
  }).strict(),
  z.object({
    status: z.literal('offline'),
    puzzles: PuzzleRecordListV1Schema,
    reason: ResourceMessageSchema,
  }).strict(),
  z.object({
    status: z.literal('rate-limited'),
    retryAt: z.string().datetime({ offset: true }),
    retryAfterSeconds: z.number().int().min(1).max(86_400),
    reason: ResourceMessageSchema,
  }).strict(),
  z.object({
    status: z.literal('corrupt'),
    reason: ResourceMessageSchema,
  }).strict(),
  z.object({
    status: z.literal('error'),
    reason: ResourceMessageSchema,
  }).strict(),
])

export type TacticalPuzzleResource = z.infer<typeof TacticalPuzzleResourceSchema>

export function validateTacticalPuzzleRecords(records: unknown): PuzzleRecord[] {
  return PuzzleRecordListV1Schema.parse(records)
}

export function validateTacticalPuzzleResource(resource: unknown): TacticalPuzzleResource {
  return TacticalPuzzleResourceSchema.parse(resource)
}

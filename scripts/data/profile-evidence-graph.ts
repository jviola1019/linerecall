#!/usr/bin/env node
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const ArchiveRowSchema = z.object({
  sourceId: z.string().min(1),
  archives: z.number().int().nonnegative(),
  recordsSeen: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  deduplicated: z.number().int().nonnegative(),
  firstCompletedAt: z.string().nullable(),
  lastCompletedAt: z.string().nullable(),
})

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return value
}

function scalar(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(pragma).get() as Record<string, unknown> | undefined
  const value = row ? Object.values(row)[0] : undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Unexpected numeric result for ${pragma}`)
  }
  return value
}

function plannerEstimates(database: DatabaseSync): Array<{
  table: string
  index: string | null
  estimate: string
}> {
  const exists = database.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='sqlite_stat1'",
  ).get() as { present?: number } | undefined
  if (exists?.present !== 1) return []
  return database.prepare(`
    SELECT tbl AS "table", idx AS "index", stat AS estimate
    FROM sqlite_stat1
    ORDER BY tbl, idx
  `).all() as Array<{ table: string; index: string | null; estimate: string }>
}

async function main(): Promise<void> {
  const path = resolve(option('--db', 'data/generated/v2/evidence-graph.sqlite'))
  const details = await stat(path)
  if (!details.isFile()) throw new Error('Evidence graph path is not a file')
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const archives = z.array(ArchiveRowSchema).parse(database.prepare(`
      SELECT source_id AS sourceId, count(*) AS archives,
        sum(records_seen) AS recordsSeen, sum(accepted) AS accepted,
        sum(deduplicated) AS deduplicated,
        min(completed_at) AS firstCompletedAt,
        max(completed_at) AS lastCompletedAt
      FROM archive_runs
      WHERE status = 'complete'
      GROUP BY source_id
      ORDER BY source_id
    `).all())
    const metadata = database.prepare(
      'SELECT key, value FROM graph_metadata ORDER BY key',
    ).all() as Array<{ key: string; value: string }>
    for (const item of metadata) {
      if (item.key.toLowerCase().includes('sha256')) Sha256Schema.parse(item.value)
    }
    const pageCount = scalar(database, 'PRAGMA page_count')
    const pageSize = scalar(database, 'PRAGMA page_size')
    const freePages = scalar(database, 'PRAGMA freelist_count')
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      path,
      fileBytes: details.size,
      pageSize,
      pageCount,
      freePages,
      allocatedBytes: pageCount * pageSize,
      liveAllocatedBytes: (pageCount - freePages) * pageSize,
      archives,
      metadata,
      plannerEstimates: plannerEstimates(database),
      note: 'This bounded profile intentionally does not count position or edge rows.',
    }, null, 2)}\n`)
  } finally {
    database.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Evidence graph profile failed: ${(error as Error).message}\n`)
  process.exitCode = 1
})

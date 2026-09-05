import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PoolClient } from 'pg'
import {
  COMPUTE_WORKLOADS,
  PgBossJobQueue,
  deadLetterQueueName,
  parseDurableJobPayload,
  queueName,
} from '../src/jobs/durable-queue.js'

function fixture(sendResult: string | null = '018f22c0-1d7a-7000-8000-000000000001') {
  const created: string[] = []
  const updated: string[] = []
  const sent: Array<{ name: string; data: object | null | undefined; options: Record<string, unknown> | undefined }> = []
  const stopped: Array<{ graceful?: boolean; timeout?: number; wait?: boolean } | undefined> = []
  const boss = {
    async createQueue(name: string) { created.push(name) },
    async updateQueue(name: string) { updated.push(name) },
    async send(name: string, data?: object | null, options?: Record<string, unknown>) {
      sent.push({ name, data, options })
      return sendResult
    },
    async stop(options?: { graceful?: boolean; timeout?: number; wait?: boolean }) { stopped.push(options) },
  }
  return { queue: new PgBossJobQueue(boss as never), created, updated, sent, stopped }
}

describe('pg-boss durable compute queue', () => {
  it('creates retrying workload queues and retained dead letters', async () => {
    const { queue, created, updated } = fixture()
    await queue.initialize()
    assert.deepEqual(created, COMPUTE_WORKLOADS.flatMap((workload) => [deadLetterQueueName(workload), queueName(workload)]))
    assert.deepEqual(updated, COMPUTE_WORKLOADS.map(queueName))
  })

  it('uses the caller transaction when enqueuing an import', async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = []
    const client = {
      async query(text: string, values?: readonly unknown[]) {
        queries.push(values === undefined ? { text } : { text, values })
        return { rows: [{ ok: true }] }
      },
    } as unknown as PoolClient
    const { queue, sent } = fixture()
    const jobId = '018f22c0-1d7a-7000-8000-000000000001'
    await queue.enqueue(client, {
      jobId,
      workload: 'pgn-import',
      objectKey: 'private/imports/018f22c01d7a70008000000000000001',
    })
    assert.equal(sent[0]?.name, 'linerecall-pgn-import')
    assert.equal(sent[0]?.options?.id, jobId)
    const db = sent[0]?.options?.db as { executeSql(text: string, values?: unknown[]): Promise<unknown> }
    await db.executeSql('SELECT $1::text', ['same-transaction'])
    assert.deepEqual(queries, [{ text: 'SELECT $1::text', values: ['same-transaction'] }])
  })

  it('rejects malformed envelopes and a queue insertion conflict', async () => {
    const client = { query: async () => ({ rows: [] }) } as unknown as PoolClient
    const accepted = fixture()
    await assert.rejects(() => accepted.queue.enqueue(client, {
      jobId: '018f22c0-1d7a-7000-8000-000000000001',
      workload: 'pgn-import',
      objectKey: '../escape',
    }))
    const rejected = fixture(null)
    await assert.rejects(() => rejected.queue.enqueue(client, {
      jobId: '018f22c0-1d7a-7000-8000-000000000001',
      workload: 'pgn-import',
      objectKey: 'private/imports/018f22c01d7a70008000000000000001',
    }), /rejected/)
  })

  it('parses worker envelopes at the trust boundary and rejects unknown fields', () => {
    const payload = {
      jobId: '018f22c0-1d7a-7000-8000-000000000001',
      workload: 'stockfish',
      objectKey: 'staging/releases/2026-q2/analysis',
    } as const
    assert.deepEqual(parseDurableJobPayload(payload), payload)
    assert.throws(() => parseDurableJobPayload({ ...payload, injected: '<script>' }))
  })

  it('stops pg-boss gracefully with a bounded shutdown timeout', async () => {
    const { queue, stopped } = fixture()
    await queue.close()
    assert.deepEqual(stopped, [{ graceful: true, timeout: 15_000 }])
  })
})

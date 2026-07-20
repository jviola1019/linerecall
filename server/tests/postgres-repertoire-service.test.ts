import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { PostgresRepertoireService } from '../src/adapters/postgres-repertoire-service.js'
import { ApiError } from '../src/errors.js'
import type { ObjectStore } from '../src/infrastructure/ports.js'
import type { DurableJobPayload, TransactionalJobQueue } from '../src/jobs/durable-queue.js'

type QueryResult = { rows?: unknown[]; rowCount?: number | null }

class ScriptedDatabase {
  readonly statements: Array<{ sql: string; values: readonly unknown[] | undefined }> = []
  readonly client: PoolClient
  readonly pool: Pool
  released = 0

  constructor(private readonly answer: (sql: string, values: readonly unknown[] | undefined) => QueryResult = () => ({})) {
    const query = async (sql: string, values?: readonly unknown[]) => {
      this.statements.push({ sql, values })
      const result = this.answer(sql, values)
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 }
    }
    this.client = { query, release: () => { this.released += 1 } } as unknown as PoolClient
    this.pool = { connect: async () => this.client, query } as unknown as Pool
  }
}

class RecordingObjects implements ObjectStore {
  puts: Array<{ key: string; body: Uint8Array; contentType: string; sha256Hex: string }> = []
  deletes: string[] = []
  failDelete = false
  async putPrivateImmutable(input: { key: string; body: Uint8Array; contentType: string; sha256Hex: string }) {
    this.puts.push(input)
  }
  async deletePrivate(key: string) {
    this.deletes.push(key)
    if (this.failDelete) throw new Error('object cleanup failed')
  }
}

class RecordingJobs implements TransactionalJobQueue {
  payloads: DurableJobPayload[] = []
  fail = false
  async enqueue(_client: PoolClient, input: DurableJobPayload) {
    this.payloads.push(input)
    if (this.fail) throw new Error('queue unavailable')
  }
}

const NOW = new Date('2026-07-14T12:00:00.000Z')

describe('PostgreSQL repertoire repository', () => {
  it('stores the exact PGN digest and enqueues the import in the database transaction', async () => {
    const database = new ScriptedDatabase((sql) => sql.includes('count(*)') ? { rows: [{ count: '0' }] } : {})
    const objects = new RecordingObjects()
    const jobs = new RecordingJobs()
    const service = new PostgresRepertoireService(database.pool, objects, jobs)

    const result = await service.createImport('user-a', { name: 'My e4 lines', pgn: '1. e4 e5 2. Nf3', side: 'white' }, NOW) as {
      id: string; status: string; submittedAt: string
    }

    assert.match(result.id, /^[0-9a-f-]{36}$/u)
    assert.equal(result.status, 'queued')
    assert.equal(result.submittedAt, NOW.toISOString())
    assert.equal(objects.puts.length, 1)
    assert.equal(Buffer.from(objects.puts[0]!.body).toString('utf8'), '1. e4 e5 2. Nf3')
    assert.equal(objects.puts[0]!.sha256Hex, createHash('sha256').update('1. e4 e5 2. Nf3').digest('hex'))
    assert.deepEqual(jobs.payloads[0], {
      jobId: result.id,
      workload: 'pgn-import',
      objectKey: `private/imports/${result.id.replaceAll('-', '')}`,
    })
    assert.ok(database.statements.some(({ sql, values }) => sql.includes("set_config('app.user_id'") && values?.[0] === 'user-a'))
    assert.ok(database.statements.some(({ sql }) => sql === 'COMMIT'))
    assert.equal(database.released, 1)
  })

  it('rolls back and removes the private object on concurrency or queue failure', async () => {
    for (const scenario of ['active', 'queue'] as const) {
      const database = new ScriptedDatabase((sql) => sql.includes('count(*)')
        ? { rows: [{ count: scenario === 'active' ? '2' : '0' }] } : {})
      const objects = new RecordingObjects()
      objects.failDelete = scenario === 'active'
      const jobs = new RecordingJobs()
      jobs.fail = scenario === 'queue'
      const service = new PostgresRepertoireService(database.pool, objects, jobs)

      await assert.rejects(
        () => service.createImport('user-a', { name: 'Import', pgn: '1. d4', side: 'black' }, NOW),
        scenario === 'active'
          ? (error: unknown) => error instanceof ApiError && error.code === 'too_many_active_imports'
          : /queue unavailable/,
      )
      assert.equal(objects.deletes.length, 1)
      assert.ok(database.statements.some(({ sql }) => sql === 'ROLLBACK'))
      assert.equal(database.released, 1)
    }
  })

  it('returns a bounded import view or null inside a read-only tenant transaction', async () => {
    const row = {
      id: 'job-1', display_name: 'French', trained_side: 'black', status: 'ready', failure_code: null,
      created_at: new Date('2026-07-01T00:00:00Z'), updated_at: new Date('2026-07-02T00:00:00Z'),
    }
    let found = true
    const database = new ScriptedDatabase((sql) => sql.includes('FROM repertoire_import_jobs')
      ? { rows: found ? [row] : [] } : {})
    const service = new PostgresRepertoireService(database.pool, new RecordingObjects(), new RecordingJobs())

    assert.deepEqual(await service.getImport('user-a', 'job-1'), {
      id: 'job-1', name: 'French', side: 'black', status: 'ready', failureCode: null,
      createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z',
    })
    found = false
    assert.equal(await service.getImport('user-a', 'missing'), null)
    assert.ok(database.statements.some(({ sql }) => sql === 'BEGIN READ ONLY'))
  })

  it('creates immutable first and later repertoire revisions with optimistic ETags', async () => {
    let current = 0
    const database = new ScriptedDatabase((sql) => sql.startsWith('SELECT version') ? { rows: [{ version: current }] } : {})
    const service = new PostgresRepertoireService(database.pool, new RecordingObjects(), new RecordingJobs())

    const first = await service.update('user-a', 'rep-white', '"0"', { nodes: ['a'] }, NOW) as { version: number; etag: string }
    assert.deepEqual({ version: first.version, etag: first.etag }, { version: 1, etag: '"1"' })
    assert.ok(database.statements.some(({ sql }) => sql.startsWith('INSERT INTO repertoires')))
    current = 2
    const later = await service.update('user-a', 'rep-white', '"2"', { nodes: ['b'] }, NOW) as { version: number; etag: string }
    assert.deepEqual({ version: later.version, etag: later.etag }, { version: 3, etag: '"3"' })
    assert.equal(database.statements.filter(({ sql }) => sql.startsWith('INSERT INTO repertoires')).length, 1)
  })

  it('rolls back a stale revision without writing a new document', async () => {
    const database = new ScriptedDatabase((sql) => sql.startsWith('SELECT version') ? { rows: [{ version: 4 }] } : {})
    const service = new PostgresRepertoireService(database.pool, new RecordingObjects(), new RecordingJobs())
    await assert.rejects(
      () => service.update('user-a', 'rep', '"3"', {}, NOW),
      (error: unknown) => error instanceof ApiError && error.code === 'revision_conflict',
    )
    assert.equal(database.statements.some(({ sql }) => sql.includes('INSERT INTO repertoire_revisions')), false)
    assert.ok(database.statements.some(({ sql }) => sql === 'ROLLBACK'))
  })

  it('creates, revokes, and resolves exact-digest unlisted shares', async () => {
    const revisionId = '018f2f40-7b1d-7a4e-8b3a-0123456789ab'
    let revokeCount = 1
    const database = new ScriptedDatabase((sql) => {
      if (sql.includes('FROM repertoire_revisions')) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      if (sql.startsWith('UPDATE share_links')) return { rowCount: revokeCount }
      if (sql.includes('resolve_unlisted_share')) return {
        rows: [{ share_id: 'share-1', revision_id: revisionId, document: { root: 'node-a' } }],
      }
      return {}
    })
    const service = new PostgresRepertoireService(database.pool, new RecordingObjects(), new RecordingJobs())

    const share = await service.createShare('user-a', 'rep', { revisionId, expiresAt: null }, NOW)
    assert.equal(share.revisionId, revisionId)
    assert.match(share.token, /^[A-Za-z0-9_-]{43}$/u)
    const insert = database.statements.find(({ sql }) => sql.includes('INSERT INTO share_links'))
    assert.equal(Buffer.isBuffer(insert?.values?.[4]), true)
    assert.equal((insert?.values?.[4] as Buffer).byteLength, 32)
    assert.equal(await service.revokeShare('user-a', share.id, NOW), true)
    revokeCount = 0
    assert.equal(await service.revokeShare('user-a', share.id, NOW), false)
    assert.deepEqual(await service.resolveShare(share.token, NOW), {
      id: 'share-1', revisionId, revision: { root: 'node-a' },
    })
  })

  it('supports expiring shares and fails closed for missing revisions and token digests', async () => {
    let revisionExists = true
    let resolved = true
    const database = new ScriptedDatabase((sql) => {
      if (sql.includes('FROM repertoire_revisions')) return { rowCount: revisionExists ? 1 : 0 }
      if (sql.includes('resolve_unlisted_share')) return { rows: resolved
        ? [{ share_id: 'share', revision_id: 'revision', document: {} }] : [] }
      return {}
    })
    const service = new PostgresRepertoireService(database.pool, new RecordingObjects(), new RecordingJobs())
    await service.createShare('user-a', 'rep', {
      revisionId: '018f2f40-7b1d-7a4e-8b3a-0123456789ab', expiresAt: '2026-08-01T00:00:00Z',
    }, NOW)
    const insert = database.statements.find(({ sql }) => sql.includes('INSERT INTO share_links'))
    assert.equal((insert?.values?.[5] as Date).toISOString(), '2026-08-01T00:00:00.000Z')
    revisionExists = false
    await assert.rejects(
      () => service.createShare('user-a', 'rep', {
        revisionId: '018f2f40-7b1d-7a4e-8b3a-0123456789ab', expiresAt: null,
      }, NOW),
      (error: unknown) => error instanceof ApiError && error.code === 'not_found',
    )
    resolved = false
    assert.equal(await service.resolveShare('opaque-token', NOW), null)
  })
})

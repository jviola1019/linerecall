import { createHash, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { RepertoireService } from '../ports.js'
import type { ObjectStore } from '../infrastructure/ports.js'
import type { TransactionalJobQueue } from '../jobs/durable-queue.js'
import { ApiError } from '../errors.js'
import { uuidV7 } from '../ids.js'

export class PostgresRepertoireService implements RepertoireService {
  constructor(
    private readonly pool: Pool,
    private readonly objects: ObjectStore,
    private readonly jobs: TransactionalJobQueue,
  ) {}

  async createImport(userId: string, input: { name: string; pgn: string; side: 'white' | 'black' }, now: Date): Promise<unknown> {
    const bytes = Buffer.from(input.pgn, 'utf8')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const id = uuidV7(now.getTime())
    const objectKey = `private/imports/${id.replaceAll('-', '')}`
    await this.objects.putPrivateImmutable({ key: objectKey, body: bytes, contentType: 'application/x-chess-pgn', sha256Hex: digest })

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.#setUser(client, userId)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId])
      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM repertoire_import_jobs
         WHERE user_id=$1 AND status IN ('queued','validating','analyzing')`, [userId],
      )
      if (Number(active.rows[0]?.count ?? 0) >= 2) throw new ApiError(409, 'too_many_active_imports', 'At most two import jobs may run at once')
      await client.query(
        `INSERT INTO repertoire_import_jobs
          (user_id,id,display_name,trained_side,status,source_object_key,source_sha256,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'queued',$5,$6,$7,$7)`,
        [userId, id, input.name, input.side, objectKey, digest, now],
      )
      await this.jobs.enqueue(client, { jobId: id, workload: 'pgn-import', objectKey })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      await this.objects.deletePrivate(objectKey).catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    return { id, status: 'queued', name: input.name, side: input.side, submittedAt: now.toISOString() }
  }

  async getImport(userId: string, jobId: string): Promise<unknown | null> {
    return this.#transaction(userId, true, async (client) => {
      const result = await client.query(
        `SELECT id,display_name,trained_side,status,failure_code,created_at,updated_at FROM repertoire_import_jobs
         WHERE user_id=$1 AND id=$2`, [userId, jobId],
      )
      const row = result.rows[0]
      return row ? {
        id: row.id,
        name: row.display_name,
        side: row.trained_side,
        status: row.status,
        failureCode: row.failure_code,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      } : null
    })
  }

  async update(userId: string, repertoireId: string, ifMatch: string, revision: unknown, now: Date): Promise<unknown> {
    return this.#transaction(userId, false, async (client) => {
      const result = await client.query<{ version: number }>(
        'SELECT version FROM repertoires WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, repertoireId],
      )
      const current = result.rows[0]?.version ?? 0
      if (ifMatch !== `"${current}"`) throw new ApiError(412, 'revision_conflict', 'The repertoire changed; reload before saving')
      const version = current + 1
      const revisionId = uuidV7(now.getTime())
      if (current === 0) {
        await client.query(
          'INSERT INTO repertoires (user_id,id,version,current_revision_id,updated_at) VALUES ($1,$2,$3,NULL,$4)',
          [userId, repertoireId, version, now],
        )
      }
      await client.query(
        `INSERT INTO repertoire_revisions (user_id,id,repertoire_id,version,document,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`, [userId, revisionId, repertoireId, version, revision, now],
      )
      await client.query(
        'UPDATE repertoires SET version=$3,current_revision_id=$4,updated_at=$5 WHERE user_id=$1 AND id=$2',
        [userId, repertoireId, version, revisionId, now],
      )
      return { repertoireId, revisionId, version, etag: `"${version}"`, updatedAt: now.toISOString() }
    })
  }

  async createShare(userId: string, repertoireId: string, request: unknown, now: Date): Promise<{ id: string; token: string; revisionId: string }> {
    const input = request as { revisionId: string; expiresAt: string | null }
    return this.#transaction(userId, false, async (client) => {
      const revision = await client.query(
        `SELECT 1 FROM repertoire_revisions WHERE user_id=$1 AND repertoire_id=$2 AND id=$3`,
        [userId, repertoireId, input.revisionId],
      )
      if (revision.rowCount !== 1) throw new ApiError(404, 'not_found', 'Repertoire revision not found')
      const id = uuidV7(now.getTime())
      const token = randomBytes(32).toString('base64url')
      const tokenHash = createHash('sha256').update(token).digest()
      await client.query(
        `INSERT INTO share_links
          (user_id,id,repertoire_id,revision_id,token_sha256,expires_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [userId, id, repertoireId, input.revisionId, tokenHash, input.expiresAt ? new Date(input.expiresAt) : null, now],
      )
      return { id, token, revisionId: input.revisionId }
    })
  }

  async revokeShare(userId: string, shareId: string, now: Date): Promise<boolean> {
    return this.#transaction(userId, false, async (client) => {
      const result = await client.query(
        'UPDATE share_links SET revoked_at=$3 WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL',
        [userId, shareId, now],
      )
      return result.rowCount === 1
    })
  }

  async resolveShare(token: string, now: Date): Promise<unknown | null> {
    const tokenHash = createHash('sha256').update(token).digest()
    const result = await this.pool.query<{ share_id: string; revision_id: string; document: unknown }>(
      'SELECT * FROM resolve_unlisted_share($1,$2)', [tokenHash, now],
    )
    const row = result.rows[0]
    return row ? { id: row.share_id, revisionId: row.revision_id, revision: row.document } : null
  }

  async #setUser(client: PoolClient, userId: string): Promise<void> {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId])
  }

  async #transaction<T>(userId: string, readOnly: boolean, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
      await this.#setUser(client, userId)
      const value = await callback(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

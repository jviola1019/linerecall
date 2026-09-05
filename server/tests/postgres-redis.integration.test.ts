import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { Redis } from 'ioredis'
import { Pool, type PoolClient } from 'pg'
import { RedisRateLimiter } from '../src/adapters/redis-rate-limiter.js'

const enabled = process.env.LINERECALL_CONNECTED_INTEGRATION === '1'
const adminUrl = process.env.LINERECALL_INTEGRATION_ADMIN_DATABASE_URL
const applicationUrl = process.env.LINERECALL_INTEGRATION_APP_DATABASE_URL
const redisUrl = process.env.LINERECALL_INTEGRATION_REDIS_URL

const applicationTables = [
  'review_events',
  'card_states',
  'user_settings',
  'repertoire_import_jobs',
  'repertoires',
  'repertoire_revisions',
  'share_links',
  'external_connections',
  'puzzle_progress',
  'puzzle_attempt_events',
  'lichess_sync_jobs',
  'lichess_imported_game_ids',
  'personal_opening_edge_aggregates',
  'family_coverage_events',
  'family_cycle_events',
  'family_training_cursor_events',
] as const

async function migration(name: string): Promise<string> {
  return readFile(join(process.cwd(), 'migrations', name), 'utf8')
}

async function withUser<T>(pool: Pool, userId: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

test('PostgreSQL 18 forced RLS and Redis limits survive real pooled dependencies', {
  skip: enabled ? false : 'set LINERECALL_CONNECTED_INTEGRATION=1 to run the zero-cost dependency gate',
  timeout: 60_000,
}, async () => {
  assert.ok(adminUrl, 'LINERECALL_INTEGRATION_ADMIN_DATABASE_URL is required')
  assert.ok(applicationUrl, 'LINERECALL_INTEGRATION_APP_DATABASE_URL is required')
  assert.ok(redisUrl, 'LINERECALL_INTEGRATION_REDIS_URL is required')

  const parsedAdminUrl = new URL(adminUrl)
  assert.equal(parsedAdminUrl.protocol, 'postgresql:')
  assert.ok(
    parsedAdminUrl.hostname === '127.0.0.1' || parsedAdminUrl.hostname === 'localhost',
    'the destructive dependency fixture is restricted to loopback PostgreSQL',
  )
  assert.equal(parsedAdminUrl.pathname, '/linerecall_ci')
  const parsedApplicationUrl = new URL(applicationUrl)
  assert.equal(parsedApplicationUrl.hostname, parsedAdminUrl.hostname)
  assert.equal(parsedApplicationUrl.pathname, '/linerecall_ci')
  const parsedRedisUrl = new URL(redisUrl)
  assert.equal(parsedRedisUrl.protocol, 'redis:')
  assert.ok(
    parsedRedisUrl.hostname === '127.0.0.1' || parsedRedisUrl.hostname === 'localhost',
    'the dependency fixture is restricted to loopback Redis',
  )
  assert.ok(parsedRedisUrl.pathname === '' || parsedRedisUrl.pathname === '/' || parsedRedisUrl.pathname === '/0')

  const admin = new Pool({ connectionString: adminUrl, max: 1 })
  let application: Pool | undefined
  let redis: Redis | undefined
  try {
    const version = await admin.query<{ server_version_num: string }>('SHOW server_version_num')
    const versionNumber = Number(version.rows[0]?.server_version_num)
    assert.ok(versionNumber >= 180_000 && versionNumber < 190_000, `expected PostgreSQL 18, received ${versionNumber}`)

    const database = await admin.query<{ current_database: string }>('SELECT current_database()')
    assert.equal(database.rows[0]?.current_database, 'linerecall_ci')

    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await admin.query(`
      DO $roles$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linerecall_app') THEN
          CREATE ROLE linerecall_app LOGIN NOINHERIT NOBYPASSRLS PASSWORD 'integration-app-only';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linerecall_auth') THEN
          CREATE ROLE linerecall_auth LOGIN NOINHERIT NOBYPASSRLS PASSWORD 'integration-auth-only';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linerecall_share_owner') THEN
          CREATE ROLE linerecall_share_owner NOLOGIN NOINHERIT BYPASSRLS;
        END IF;
      END
      $roles$;
    `)

    for (const name of [
      '001_application.sql',
      '004_lichess_personal_analytics.sql',
      '005_puzzle_attempt_evidence.sql',
      '006_family_training_journal.sql',
      '002_roles.example.sql',
      '003_public_share_resolution.sql',
      '007_share_resolver_privileges.sql',
    ]) await admin.query(await migration(name))

    const sharePrivileges = await admin.query(`
      SELECT
        has_schema_privilege('linerecall_share_owner', 'public', 'USAGE') AS schema_usage,
        has_schema_privilege('linerecall_share_owner', 'public', 'CREATE') AS schema_create,
        has_table_privilege('linerecall_share_owner', 'share_links', 'SELECT') AS share_read,
        has_table_privilege('linerecall_share_owner', 'share_links', 'INSERT, UPDATE, DELETE') AS share_write,
        has_table_privilege('linerecall_share_owner', 'user_settings', 'SELECT') AS unrelated_read,
        pg_has_role('linerecall_app', 'linerecall_share_owner', 'MEMBER') AS runtime_membership
    `)
    assert.deepEqual(sharePrivileges.rows, [{
      schema_usage: true, schema_create: false, share_read: true,
      share_write: false, unrelated_read: false, runtime_membership: false,
    }])

    const roles = await admin.query<{
      rolname: string
      rolsuper: boolean
      rolbypassrls: boolean
      rolcanlogin: boolean
    }>(`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
      FROM pg_roles
      WHERE rolname IN ('linerecall_app', 'linerecall_auth', 'linerecall_share_owner')
      ORDER BY rolname
    `)
    assert.deepEqual(roles.rows, [
      { rolname: 'linerecall_app', rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: 'linerecall_auth', rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: 'linerecall_share_owner', rolsuper: false, rolbypassrls: true, rolcanlogin: false },
    ])

    const rls = await admin.query<{
      relname: string
      row_security: boolean
      force_row_security: boolean
      owner_name: string
    }>(`
      SELECT c.relname,
             c.relrowsecurity AS row_security,
             c.relforcerowsecurity AS force_row_security,
             owner.rolname AS owner_name
      FROM pg_class c
      JOIN pg_roles owner ON owner.oid = c.relowner
      WHERE c.relname = ANY($1::text[])
      ORDER BY c.relname
    `, [applicationTables])
    assert.equal(rls.rows.length, applicationTables.length)
    for (const row of rls.rows) {
      assert.equal(row.row_security, true, `${row.relname} must enable RLS`)
      assert.equal(row.force_row_security, true, `${row.relname} must force RLS`)
      assert.notEqual(row.owner_name, 'linerecall_app', `${row.relname} must not be application-role owned`)
    }

    const authPrivileges = await admin.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM information_schema.table_privileges
      WHERE grantee = 'linerecall_auth' AND table_name = ANY($1::text[])
    `, [applicationTables])
    assert.equal(authPrivileges.rows[0]?.count, '0', 'the authentication role must not receive application-table grants')

    await admin.query(`
      INSERT INTO supported_snapshot_versions (version, manifest_sha256, approved_at)
      VALUES ('integration-v1', repeat('a', 64), '2026-08-27T00:00:00Z');
      INSERT INTO snapshot_card_membership (snapshot_version, pack_id, node_id, card_id)
      VALUES ('integration-v1', 'pack_test', 'node_test', 'card_test');
    `)

    application = new Pool({ connectionString: applicationUrl, max: 1 })

    const firstPid = await application.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    await withUser(application, 'user-a', async (client) => {
      await client.query(`
        INSERT INTO user_settings (user_id, version, value)
        VALUES ('user-a', 1, '{"theme":"dark"}'::jsonb)
      `)
      const own = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM user_settings')
      assert.equal(own.rows[0]?.count, '1')
    })
    const secondPid = await application.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    assert.equal(secondPid.rows[0]?.pid, firstPid.rows[0]?.pid, 'test must reuse the same physical pooled connection')

    await withUser(application, 'user-b', async (client) => {
      const other = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM user_settings')
      assert.equal(other.rows[0]?.count, '0', 'a reused connection must not retain the prior tenant')
      await client.query(`
        INSERT INTO user_settings (user_id, version, value)
        VALUES ('user-b', 1, '{"theme":"light"}'::jsonb)
      `)
      await assert.rejects(
        () => client.query(`
          INSERT INTO user_settings (user_id, version, value)
          VALUES ('user-a', 2, '{}'::jsonb)
        `),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
      )
    })

    const unset = await application.query<{ count: string }>('SELECT count(*)::text AS count FROM user_settings')
    assert.equal(unset.rows[0]?.count, '0', 'a query without app.user_id must fail closed')

    const token = Buffer.from('integration-share-token', 'utf8')
    const tokenHash = createHash('sha256').update(token).digest()
    await withUser(application, 'user-a', async (client) => {
      await client.query(`
        INSERT INTO repertoires (user_id, id, version, current_revision_id, updated_at)
        VALUES ('user-a', 'rep_test', 1, NULL, '2026-08-27T00:00:00Z')
      `)
      await client.query(`
        INSERT INTO repertoire_revisions (user_id, id, repertoire_id, version, document, created_at)
        VALUES ('user-a', '0198e8dd-e400-7000-8000-000000000001', 'rep_test', 1,
                '{"name":"Private repertoire"}'::jsonb, '2026-08-27T00:00:00Z')
      `)
      await client.query(`
        UPDATE repertoires
        SET current_revision_id = '0198e8dd-e400-7000-8000-000000000001'
        WHERE user_id = 'user-a' AND id = 'rep_test'
      `)
      await client.query(`
        INSERT INTO share_links
          (user_id, id, repertoire_id, revision_id, token_sha256, created_at)
        VALUES
          ('user-a', '0198e8dd-e400-7000-8000-000000000002', 'rep_test',
           '0198e8dd-e400-7000-8000-000000000001', $1, '2026-08-27T00:00:00Z')
      `, [tokenHash])
    })
    const directPrivateScan = await application.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM repertoire_revisions',
    )
    assert.equal(directPrivateScan.rows[0]?.count, '0')
    const shared = await application.query<{ document: unknown }>(
      'SELECT document FROM resolve_unlisted_share($1, $2)', [tokenHash, new Date('2026-08-28T00:00:00Z')],
    )
    assert.deepEqual(shared.rows, [{ document: { name: 'Private repertoire' } }])
    const miss = await application.query(
      'SELECT document FROM resolve_unlisted_share($1, $2)',
      [createHash('sha256').update('wrong-token').digest(), new Date('2026-08-28T00:00:00Z')],
    )
    assert.equal(miss.rowCount, 0)

    redis = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true })
    await redis.connect()
    await redis.flushdb()
    const limiter = new RedisRateLimiter(redis, 'linerecall:integration')
    const now = new Date('2026-08-27T00:00:00Z')
    const first = await limiter.consume('shared-subject', 2, 60_000, now)
    const second = await limiter.consume('shared-subject', 2, 60_000, now)
    const third = await limiter.consume('shared-subject', 2, 60_000, now)
    assert.deepEqual([first.allowed, second.allowed, third.allowed], [true, true, false])
    assert.deepEqual([first.remaining, second.remaining, third.remaining], [1, 0, 0])
    assert.ok(first.resetAt > now && first.resetAt <= new Date(now.getTime() + 60_000))
  } finally {
    if (redis) await redis.quit().catch(() => undefined)
    if (application) await application.end().catch(() => undefined)
    await admin.end().catch(() => undefined)
  }
})

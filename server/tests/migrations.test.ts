import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

describe('PostgreSQL isolation migrations', () => {
  it('forces fail-closed RLS on every user-owned table', async () => {
    const sql = await readFile(new URL('../migrations/001_application.sql', import.meta.url), 'utf8')
    for (const table of [
      'review_events', 'card_states', 'user_settings', 'repertoire_import_jobs', 'repertoires',
      'repertoire_revisions', 'share_links', 'external_connections', 'puzzle_progress',
      'puzzle_attempt_events',
    ]) assert.match(sql, new RegExp(`'${table}'`))
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/)
    assert.match(sql, /FORCE ROW LEVEL SECURITY/)
    assert.match(sql, /current_setting\(''app\.user_id'', true\)/)
    assert.match(sql, /CREATE TABLE IF NOT EXISTS snapshot_card_membership/)
    assert.match(sql, /CREATE TABLE IF NOT EXISTS snapshot_puzzle_membership/)
    assert.match(sql, /REFERENCES snapshot_card_membership\(snapshot_version, pack_id, node_id, card_id\)/)
  })

  it('exposes only exact-digest unlisted share resolution', async () => {
    const sql = await readFile(new URL('../migrations/003_public_share_resolution.sql', import.meta.url), 'utf8')
    assert.match(sql, /share\.token_sha256 = requested_token_sha256/)
    assert.match(sql, /share\.revoked_at IS NULL/)
    assert.match(sql, /SET search_path = pg_catalog, public/)
    assert.match(sql, /REVOKE ALL .* FROM PUBLIC/)
    assert.match(sql, /GRANT EXECUTE/)
  })

  it('serializes each user projection and conditionally mutates settings', async () => {
    const source = await readFile(new URL('../src/adapters/postgres-sync-store.ts', import.meta.url), 'utf8')
    assert.match(source, /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/)
    assert.match(source, /WHERE user_id=\$1 AND version=\$2/)
    assert.match(source, /ON CONFLICT \(user_id\) DO NOTHING/)
    assert.match(source, /FROM snapshot_card_membership/)
    for (const exported of [
      'repertoire_import_jobs', 'repertoires', 'repertoire_revisions', 'share_links',
      'puzzle_progress', 'external_connections',
    ]) assert.match(source, new RegExp(`FROM ${exported}`))
    assert.doesNotMatch(source, /SELECT .*access_token_ciphertext/)
  })
})

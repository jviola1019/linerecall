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

  it('migrates tactical attempt evidence without inventing historical metrics', async () => {
    const sql = await readFile(new URL('../migrations/005_puzzle_attempt_evidence.sql', import.meta.url), 'utf8')
    for (const field of [
      'abandoned', 'incorrect_attempts', 'used_hint', 'elapsed_ms',
      'clean_solves', 'hints_used', 'incorrect_moves', 'total_elapsed_ms', 'last_elapsed_ms',
    ]) assert.match(sql, new RegExp(field))
    assert.match(sql, /SET abandoned = NOT solved/)
    assert.match(sql, /SET abandoned = attempts - solved/)
    assert.match(sql, /solved \+ abandoned = attempts/)
    assert.match(sql, /elapsed_ms BETWEEN 0 AND 86400000/)
  })

  it('forces tenant isolation and immutable membership on the family journal', async () => {
    const sql = await readFile(new URL('../migrations/006_family_training_journal.sql', import.meta.url), 'utf8')
    for (const table of [
      'snapshot_family_pack_membership', 'snapshot_family_path_membership',
      'family_coverage_events', 'family_cycle_events', 'family_training_cursor_events',
    ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
    for (const table of ['family_coverage_events', 'family_cycle_events', 'family_training_cursor_events']) {
      assert.match(sql, new RegExp(`'${table}'`))
    }
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/)
    assert.match(sql, /FORCE ROW LEVEL SECURITY/)
    assert.match(sql, /current_setting\(''app\.user_id'', true\)/)
    assert.match(sql, /UNIQUE \(user_id, snapshot_version, family_id, pack_id, path_id, coverage_cycle_id\)/)
    assert.match(sql, /UNIQUE \(user_id, snapshot_version, family_id, side, pack_id, version\)/)
    assert.match(sql, /REFERENCES snapshot_family_path_membership/)
    const roles = await readFile(new URL('../migrations/002_roles.example.sql', import.meta.url), 'utf8')
    for (const table of [
      'family_coverage_events', 'family_cycle_events', 'family_training_cursor_events',
      'snapshot_family_pack_membership', 'snapshot_family_path_membership',
    ]) assert.match(roles, new RegExp(table))
  })
})

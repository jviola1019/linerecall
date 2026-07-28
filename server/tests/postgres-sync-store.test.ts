import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { PostgresSyncStore } from '../src/adapters/postgres-sync-store.js'
import type { ProgressSettingsV2, PuzzleAttemptV1, ReviewEventV1 } from '../src/contracts.js'
import { ApiError } from '../src/errors.js'
import type { ObjectStore } from '../src/infrastructure/ports.js'
import { DEVICE_ID, NOW, reviewEvent } from './helpers.js'

type Result = { rows?: unknown[]; rowCount?: number | null }

class ScriptedPool {
  readonly statements: Array<{ sql: string; values: readonly unknown[] | undefined }> = []
  readonly pool: Pool
  released = 0

  constructor(private readonly answer: (sql: string, values: readonly unknown[] | undefined) => Result) {
    const client = {
      query: async (sql: string, values?: readonly unknown[]) => {
        this.statements.push({ sql, values })
        const result = this.answer(sql, values)
        return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 }
      },
      release: () => { this.released += 1 },
    } as unknown as PoolClient
    this.pool = { connect: async () => client } as unknown as Pool
  }
}

const SETTINGS: ProgressSettingsV2 = {
  locale: 'en-US', theme: 'dark', manualPacing: false, reducedMotion: false, boardCoordinates: true,
}

function eventRow(event: ReviewEventV1, overrides: Record<string, unknown> = {}) {
  return {
    event_id: event.eventId,
    device_id: event.deviceId,
    card_id: event.cardId,
    pack_id: event.packId,
    node_id: event.nodeId,
    grade: event.grade,
    occurred_at: new Date(event.occurredAt),
    normalized_occurred_at: new Date(event.occurredAt),
    received_at: NOW,
    local_date: event.localDate,
    time_zone: event.timeZone,
    snapshot_version: event.snapshotVersion,
    corrects_event_id: event.correctsEventId ?? null,
    sync_sequence: '7',
    ...overrides,
  }
}

function cardRow(cardId = 'pack-e4::pos_0123456789abcdef', sequence = '7') {
  return {
    card_id: cardId,
    repetitions: 1,
    interval_days: 1,
    ease_factor: '2.5',
    due_at: new Date('2026-07-15T12:00:00Z'),
    last_reviewed_at: NOW,
    mastery: 20,
    last_event_id: '0198a5c0-1000-7000-8000-000000000002',
    sync_sequence: sequence,
  }
}

function puzzleAttempt(overrides: Partial<PuzzleAttemptV1> = {}): PuzzleAttemptV1 {
  return {
    attemptId: '0198a5c0-1000-7000-8000-000000000010',
    deviceId: DEVICE_ID,
    puzzleId: 'puzzle-001',
    outcome: 'solved',
    incorrectAttempts: 0,
    usedHint: false,
    elapsedMs: 9_000,
    occurredAt: '2026-07-14T11:55:00.000Z',
    snapshotVersion: 'release-2026q2',
    ...overrides,
  }
}

describe('PostgreSQL sync repository', () => {
  it('accepts legal member events, normalizes future clocks, rebuilds cards, and updates settings', async () => {
    const first = reviewEvent()
    const future = reviewEvent({
      eventId: '0198a5c0-1000-7000-8000-000000000003',
      cardId: 'pack-e4::pos_fedcba9876543210',
      nodeId: 'pos_fedcba9876543210',
      occurredAt: '2026-07-14T12:06:00.000Z',
    })
    const inserted: ReturnType<typeof eventRow>[] = []
    const database = new ScriptedPool((sql, values) => {
      if (sql.includes('supported_snapshot_versions')) return { rowCount: 1 }
      if (sql.includes('snapshot_card_membership')) return { rowCount: 1 }
      if (sql.includes('WHERE user_id = $1 AND event_id = $2')) return { rows: [] }
      if (sql.includes('INSERT INTO review_events')) {
        inserted.push(eventRow(values?.[1] === first.eventId ? first : future, {
          occurred_at: values?.[7], normalized_occurred_at: values?.[8], received_at: values?.[9],
        }))
        return { rowCount: 1 }
      }
      if (sql.includes('INSERT INTO user_settings')) return { rowCount: 1 }
      if (sql.includes('FROM review_events WHERE user_id = $1 AND card_id = $2')) {
        return { rows: inserted.filter((row) => row.card_id === values?.[1]) }
      }
      if (sql.includes('INSERT INTO card_states')) return { rowCount: 1 }
      if (sql.includes('FROM card_states WHERE user_id = $1 AND sync_sequence')) {
        return { rows: [cardRow(first.cardId, '7'), cardRow(future.cardId, '8')] }
      }
      if (sql.includes('SELECT version, value FROM user_settings')) return { rows: [{ version: 1, value: SETTINGS }] }
      if (sql.includes('SELECT GREATEST')) return { rows: [{ current: '8' }] }
      return {}
    })
    const store = new PostgresSyncStore(database.pool)
    const response = await store.sync('user-a', {
      deviceId: DEVICE_ID,
      cursor: null,
      events: [first, future],
      settingsMutation: { baseVersion: 0, value: SETTINGS },
    }, NOW)

    assert.deepEqual(response.acceptedEventIds, [first.eventId, future.eventId])
    assert.deepEqual(response.rejectedEvents, [{
      eventId: future.eventId,
      code: 'future_timestamp_normalized',
      message: 'The review time was normalized to server time',
    }])
    assert.equal(response.cards.length, 2)
    assert.equal(response.cards[0]?.easeFactor, 2.5)
    assert.equal(response.nextCursor, '8')
    assert.equal(inserted[0]?.normalized_occurred_at.toISOString(), first.occurredAt)
    assert.equal(inserted[1]?.normalized_occurred_at.toISOString(), NOW.toISOString())
    assert.ok(database.statements.some(({ sql }) => sql.includes('pg_advisory_xact_lock')))
    assert.ok(database.statements.some(({ sql }) => sql === 'COMMIT'))
    assert.equal(database.released, 1)
  })

  it('rejects unsupported snapshots, unknown memberships, and immutable-ID conflicts without rebuilding', async () => {
    const unsupported = reviewEvent({ eventId: '0198a5c0-1000-7000-8000-000000000011', snapshotVersion: 'retired' })
    const unknown = reviewEvent({ eventId: '0198a5c0-1000-7000-8000-000000000012', cardId: 'unknown-card' })
    const matching = reviewEvent({ eventId: '0198a5c0-1000-7000-8000-000000000013' })
    const conflicting = reviewEvent({ eventId: '0198a5c0-1000-7000-8000-000000000014' })
    const database = new ScriptedPool((sql, values) => {
      if (sql.includes('supported_snapshot_versions')) return { rowCount: values?.[0] === 'retired' ? 0 : 1 }
      if (sql.includes('snapshot_card_membership')) return { rowCount: values?.[3] === 'unknown-card' ? 0 : 1 }
      if (sql.includes('WHERE user_id = $1 AND event_id = $2')) {
        const event = values?.[1] === matching.eventId ? matching : conflicting
        return { rows: [eventRow(event, values?.[1] === conflicting.eventId ? { grade: 'again' } : {})] }
      }
      if (sql.includes('FROM card_states WHERE user_id')) return { rows: [] }
      if (sql.includes('SELECT version, value FROM user_settings')) return { rows: [] }
      if (sql.includes('SELECT GREATEST')) return { rows: [{ current: '0' }] }
      return {}
    })
    const response = await new PostgresSyncStore(database.pool).sync('user-a', {
      deviceId: DEVICE_ID, cursor: null, events: [unsupported, unknown, matching, conflicting],
    }, NOW)

    assert.deepEqual(response.acceptedEventIds, [matching.eventId])
    assert.deepEqual(response.rejectedEvents.map(({ code }) => code), [
      'unsupported_snapshot', 'unknown_card_membership', 'conflicting_event_id',
    ])
    assert.equal(database.statements.some(({ sql }) => sql.includes('INSERT INTO card_states')), false)
    assert.deepEqual(response.settings, { version: 0, value: SETTINGS })
  })

  it('accepts only a valid latest correction and rejects stale correction targets', async () => {
    const original = reviewEvent({ eventId: '0198a5c0-1000-7000-8000-000000000020' })
    const valid = reviewEvent({
      eventId: '0198a5c0-1000-7000-8000-000000000021',
      correctsEventId: original.eventId,
      grade: 'hard',
    })
    const invalid = reviewEvent({
      eventId: '0198a5c0-1000-7000-8000-000000000022',
      correctsEventId: '0198a5c0-1000-7000-8000-000000000099',
    })
    const inserted: ReturnType<typeof eventRow>[] = []
    const database = new ScriptedPool((sql, values) => {
      if (sql.includes('supported_snapshot_versions') || sql.includes('snapshot_card_membership')) return { rowCount: 1 }
      if (sql === 'SELECT * FROM review_events WHERE user_id = $1 AND event_id = $2') return { rows: [] }
      if (sql.includes('FROM review_events target')) return values?.[1] === original.eventId
        ? { rows: [{ ...eventRow(original), is_latest: true, is_uncorrected: true }] }
        : { rows: [{ ...eventRow(original), is_latest: false, is_uncorrected: true }] }
      if (sql.includes('INSERT INTO review_events')) { inserted.push(eventRow(valid)); return { rowCount: 1 } }
      if (sql.includes('FROM review_events WHERE user_id = $1 AND card_id = $2')) return { rows: [eventRow(original), ...inserted] }
      if (sql.includes('FROM card_states WHERE user_id')) return { rows: [cardRow()] }
      if (sql.includes('SELECT version, value FROM user_settings')) return { rows: [] }
      if (sql.includes('SELECT GREATEST')) return { rows: [{ current: '9' }] }
      return {}
    })
    const response = await new PostgresSyncStore(database.pool).sync('user-a', {
      deviceId: DEVICE_ID, cursor: null, events: [valid, invalid],
    }, NOW)
    assert.deepEqual(response.acceptedEventIds, [valid.eventId])
    assert.deepEqual(response.rejectedEvents.map(({ code }) => code), ['invalid_correction'])
  })

  it('rolls back an optimistic settings conflict and supports the update branch', async () => {
    for (const changed of [0, 1]) {
      const database = new ScriptedPool((sql) => {
        if (sql.includes('UPDATE user_settings SET')) return { rowCount: changed }
        if (sql.includes('FROM card_states WHERE user_id')) return { rows: [] }
        if (sql.includes('SELECT version, value FROM user_settings')) return { rows: [{ version: 2, value: SETTINGS }] }
        if (sql.includes('SELECT GREATEST')) return { rows: [{ current: '2' }] }
        return {}
      })
      const operation = new PostgresSyncStore(database.pool).sync('user-a', {
        deviceId: DEVICE_ID, cursor: '0', events: [], settingsMutation: { baseVersion: 1, value: SETTINGS },
      }, NOW)
      if (changed === 0) {
        await assert.rejects(operation, (error: unknown) => error instanceof ApiError && error.code === 'settings_version_conflict')
        assert.ok(database.statements.some(({ sql }) => sql === 'ROLLBACK'))
      } else {
        assert.equal((await operation).settings.version, 2)
        assert.ok(database.statements.some(({ sql }) => sql === 'COMMIT'))
      }
    }
  })

  it('bootstraps a bounded page with stable cursor and read-only rollback semantics', async () => {
    let fail = false
    const database = new ScriptedPool((sql) => {
      if (sql.includes('FROM card_states WHERE user_id')) {
        if (fail) throw new Error('database unavailable')
        return { rows: [cardRow('card-a', '4'), cardRow('card-b', '5')] }
      }
      if (sql.includes('SELECT version, value FROM user_settings')) return { rows: [] }
      if (sql.includes('SELECT GREATEST')) return { rows: [{ current: '8' }] }
      return {}
    })
    const store = new PostgresSyncStore(database.pool)
    const page = await store.bootstrap('user-a', 3n, 1, NOW)
    assert.equal(page.cards.length, 1)
    assert.equal(page.hasMore, true)
    assert.equal(page.nextCursor, '4')
    assert.ok(database.statements.some(({ sql }) => sql === 'BEGIN READ ONLY'))
    fail = true
    await assert.rejects(() => store.bootstrap('user-a', 3n, 1, NOW), /database unavailable/)
    assert.ok(database.statements.some(({ sql }) => sql === 'ROLLBACK'))
  })

  it('bootstraps canonical puzzle progress with a bounded stable cursor', async () => {
    let mode: 'page' | 'empty' | 'null-timestamp' | 'failure' = 'page'
    const database = new ScriptedPool((sql) => {
      if (sql.includes('FROM puzzle_progress')) {
        if (mode === 'failure') throw new Error('puzzle bootstrap unavailable')
        if (mode === 'empty') return { rows: [] }
        if (mode === 'null-timestamp') return { rows: [{
          puzzle_id: 'puzzle-003', attempts: 1, solved: 0, abandoned: 1, clean_solves: 0,
          hints_used: 0, incorrect_moves: '0', total_elapsed_ms: '0', last_elapsed_ms: null,
          last_attempt_at: null, sync_sequence: '6',
        }] }
        return { rows: [
          {
            puzzle_id: 'puzzle-001', attempts: 2, solved: 2, abandoned: 0, clean_solves: 1,
            hints_used: 1, incorrect_moves: '1', total_elapsed_ms: '12000', last_elapsed_ms: 5_000,
            last_attempt_at: NOW, sync_sequence: '4',
          },
          {
            puzzle_id: 'puzzle-002', attempts: 1, solved: 0, abandoned: 1, clean_solves: 0,
            hints_used: 0, incorrect_moves: '2', total_elapsed_ms: '0', last_elapsed_ms: null,
            last_attempt_at: NOW, sync_sequence: '5',
          },
        ] }
      }
      return {}
    })
    const store = new PostgresSyncStore(database.pool)
    const page = await store.bootstrapPuzzleProgress('user-a', 3n, 1, NOW)
    assert.equal(page.progress.length, 1)
    assert.equal(page.progress[0]?.puzzleId, 'puzzle-001')
    assert.equal(page.nextCursor, '4')
    assert.equal(page.hasMore, true)
    assert.ok(database.statements.some(({ sql }) => sql === 'BEGIN READ ONLY'))

    mode = 'empty'
    const empty = await store.bootstrapPuzzleProgress('user-a', 4n, 1, NOW)
    assert.deepEqual(empty.progress, [])
    assert.equal(empty.nextCursor, '4')
    assert.equal(empty.hasMore, false)

    mode = 'null-timestamp'
    const nullable = await store.bootstrapPuzzleProgress('user-a', 5n, 1, NOW)
    assert.equal(nullable.progress[0]?.lastAttemptAt, null)
    assert.equal(nullable.progress[0]?.lastElapsedMs, null)

    mode = 'failure'
    await assert.rejects(
      () => store.bootstrapPuzzleProgress('user-a', 5n, 1, NOW),
      /puzzle bootstrap unavailable/u,
    )
    assert.equal(database.statements.at(-1)?.sql, 'ROLLBACK')

    await assert.rejects(
      () => store.bootstrapPuzzleProgress('user-a', -1n, 1, NOW),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_cursor',
    )
  })

  it('keeps puzzle attempts separate, idempotent, membership-bound, and clock-normalized', async () => {
    const unsupported = puzzleAttempt({ attemptId: '0198a5c0-1000-7000-8000-000000000031', snapshotVersion: 'retired' })
    const unknown = puzzleAttempt({ attemptId: '0198a5c0-1000-7000-8000-000000000032', puzzleId: 'missing' })
    const duplicate = puzzleAttempt({
      attemptId: '0198a5c0-1000-7000-8000-000000000033',
      puzzleId: 'puzzle-duplicate',
    })
    delete duplicate.elapsedMs
    const conflict = puzzleAttempt({ attemptId: '0198a5c0-1000-7000-8000-000000000034', puzzleId: 'puzzle-conflict' })
    const future = puzzleAttempt({
      attemptId: '0198a5c0-1000-7000-8000-000000000035',
      puzzleId: 'puzzle-future',
      occurredAt: '2026-07-14T12:06:00.000Z',
    })
    let sequence = 10
    const database = new ScriptedPool((sql, values) => {
      if (sql.includes('supported_snapshot_versions')) return { rowCount: values?.[0] === 'retired' ? 0 : 1 }
      if (sql.includes('snapshot_puzzle_membership')) return { rowCount: values?.[1] === 'missing' ? 0 : 1 }
      if (sql.includes('SELECT * FROM puzzle_attempt_events')) {
        const attemptId = values?.[1]
        if (attemptId === duplicate.attemptId) return { rows: [{
          attempt_id: duplicate.attemptId, device_id: duplicate.deviceId, puzzle_id: duplicate.puzzleId,
          solved: true, abandoned: false, incorrect_attempts: duplicate.incorrectAttempts,
          used_hint: duplicate.usedHint, elapsed_ms: duplicate.elapsedMs ?? null,
          occurred_at: new Date(duplicate.occurredAt), normalized_occurred_at: new Date(duplicate.occurredAt),
          received_at: NOW, snapshot_version: duplicate.snapshotVersion, sync_sequence: '8',
        }] }
        if (attemptId === conflict.attemptId) return { rows: [{
          attempt_id: conflict.attemptId, device_id: conflict.deviceId, puzzle_id: conflict.puzzleId,
          solved: false, abandoned: true, incorrect_attempts: conflict.incorrectAttempts,
          used_hint: conflict.usedHint, elapsed_ms: conflict.elapsedMs ?? null,
          occurred_at: new Date(conflict.occurredAt), normalized_occurred_at: new Date(conflict.occurredAt),
          received_at: NOW, snapshot_version: conflict.snapshotVersion, sync_sequence: '9',
        }] }
        return { rows: [] }
      }
      if (sql.includes('INSERT INTO puzzle_attempt_events')) return { rows: [{ sync_sequence: String(sequence++) }] }
      if (sql.includes('FROM puzzle_progress WHERE')) return { rows: [
        {
          puzzle_id: duplicate.puzzleId, attempts: 2, solved: 2, abandoned: 0, clean_solves: 2,
          hints_used: 0, incorrect_moves: '0', total_elapsed_ms: '18000', last_elapsed_ms: 9_000,
          last_attempt_at: NOW, sync_sequence: '8',
        },
        {
          puzzle_id: future.puzzleId, attempts: 1, solved: 1, abandoned: 0, clean_solves: 1,
          hints_used: 0, incorrect_moves: '0', total_elapsed_ms: '9000', last_elapsed_ms: 9_000,
          last_attempt_at: NOW, sync_sequence: '10',
        },
      ] }
      return {}
    })
    const response = await new PostgresSyncStore(database.pool).syncPuzzleAttempts('user-a', {
      deviceId: DEVICE_ID, attempts: [unsupported, unknown, duplicate, conflict, future],
    }, NOW)

    assert.deepEqual(response.acceptedAttemptIds, [duplicate.attemptId, future.attemptId])
    assert.deepEqual(response.rejectedAttempts.map(({ code }) => code), [
      'unsupported_snapshot', 'unknown_puzzle_membership', 'conflicting_attempt_id', 'future_timestamp_normalized',
    ])
    assert.equal(response.progress.length, 2)
    assert.equal(response.progress[0]?.lastAttemptAt, NOW.toISOString())
    const futureInsert = database.statements.find(({ sql, values }) =>
      sql.includes('INSERT INTO puzzle_attempt_events') && values?.[1] === future.attemptId)
    assert.equal((futureInsert?.values?.[10] as Date).toISOString(), NOW.toISOString())
  })

  it('returns no puzzle projection when every attempt is rejected and rolls back query failures', async () => {
    let fail = false
    const database = new ScriptedPool((sql) => {
      if (fail && sql.includes('supported_snapshot_versions')) throw new Error('puzzle database unavailable')
      if (sql.includes('supported_snapshot_versions')) return { rowCount: 0 }
      return {}
    })
    const store = new PostgresSyncStore(database.pool)
    const response = await store.syncPuzzleAttempts('user-a', {
      deviceId: DEVICE_ID, attempts: [puzzleAttempt({ snapshotVersion: 'retired' })],
    }, NOW)
    assert.deepEqual(response.progress, [])
    assert.equal(database.statements.some(({ sql }) => sql.includes('FROM puzzle_progress')), false)
    fail = true
    await assert.rejects(() => store.syncPuzzleAttempts('user-a', {
      deviceId: DEVICE_ID, attempts: [puzzleAttempt({ snapshotVersion: 'retired' })],
    }, NOW), /puzzle database unavailable/)
    assert.ok(database.statements.some(({ sql }) => sql === 'ROLLBACK'))
  })

  it('exports complete account metadata while excluding provider and storage secrets', async () => {
    const event = reviewEvent()
    const database = new ScriptedPool((sql) => {
      if (sql.includes('FROM review_events WHERE user_id = $1 ORDER BY')) return { rows: [eventRow(event)] }
      if (sql.includes('FROM card_states WHERE user_id = $1 ORDER BY')) return { rows: [cardRow()] }
      if (sql.includes('SELECT version, value FROM user_settings')) return { rows: [{ version: 3, value: SETTINGS }] }
      if (sql.includes('FROM repertoire_import_jobs')) return { rows: [{
        id: 'import-1', display_name: 'White lines', trained_side: 'white', status: 'ready',
        source_sha256: 'a'.repeat(64), failure_code: null, created_at: NOW, updated_at: NOW,
      }] }
      if (sql.includes('FROM repertoires WHERE')) return { rows: [{ id: 'rep', version: 2, current_revision_id: 'revision', updated_at: NOW }] }
      if (sql.includes('FROM repertoire_revisions')) return { rows: [{ id: 'revision', repertoire_id: 'rep', version: 2, document: { nodes: [] }, created_at: NOW }] }
      if (sql.includes('FROM share_links')) return { rows: [{ id: 'share', repertoire_id: 'rep', revision_id: 'revision', expires_at: null, revoked_at: NOW, created_at: NOW }] }
      if (sql.includes('FROM puzzle_progress')) return { rows: [{
        puzzle_id: 'puzzle-1', attempts: 2, solved: 1, abandoned: 1, clean_solves: 1,
        hints_used: 1, incorrect_moves: '3', total_elapsed_ms: '15000', last_elapsed_ms: 7_000,
        last_attempt_at: NOW,
      }] }
      if (sql.includes('FROM puzzle_attempt_events')) return { rows: [{
        attempt_id: 'attempt', device_id: DEVICE_ID, puzzle_id: 'puzzle-1',
        solved: true, abandoned: false, incorrect_attempts: 1, used_hint: true, elapsed_ms: 7_000,
        occurred_at: NOW, normalized_occurred_at: NOW, received_at: NOW,
        snapshot_version: 'release-2026q2', sync_sequence: '12',
      }] }
      if (sql.includes('FROM external_connections')) return { rows: [{
        provider: 'lichess', consented_at: NOW, last_synced_at: NOW, disconnected_at: null,
        sync_cursor_last_move_at: '1784134638000', sync_cursor_game_digest: 'b'.repeat(64),
      }] }
      if (sql.includes('FROM lichess_sync_jobs')) return { rows: [{
        id: '018f1234-5678-7abc-8def-0123456789ab', status: 'succeeded', requested_at: NOW,
        sync_started_at: NOW, started_at: NOW, completed_at: NOW, retry_at: null, attempts: 1,
        processed_records: '20', accepted_games: '18', rejected_records: '2', failure_code: null,
      }] }
      if (sql.includes('FROM lichess_imported_game_ids')) return { rows: [{
        game_id_digest: 'c'.repeat(64), last_move_at: '1784134638000', processed_at: NOW,
      }] }
      if (sql.includes('FROM personal_opening_edge_aggregates')) return { rows: [{
        edge_key: 'd'.repeat(64), from_epd: 'start w KQkq -', uci: 'e2e4', san: 'e4',
        to_epd: 'after b KQkq -', speed: 'rapid', trained_side: 'white', rating_band: '1200-1499',
        opening_eco: 'C20', opening_name: 'King Pawn Game', opening_ply: 1, ply: 1,
        games: '3', wins: '2', draws: '0', losses: '1', first_seen_at: NOW, last_seen_at: NOW,
      }] }
      return {}
    })
    const exported = await new PostgresSyncStore(database.pool).exportAccount('user-a', NOW) as Record<string, unknown>
    assert.equal(exported.schema, 'linerecall-account-export-v4')
    assert.equal((exported.reviewEvents as unknown[]).length, 1)
    assert.equal((exported.cards as unknown[]).length, 1)
    assert.equal((exported.imports as unknown[]).length, 1)
    assert.equal((exported.repertoireRevisions as unknown[]).length, 1)
    assert.equal((exported.puzzleAttempts as unknown[]).length, 1)
    assert.deepEqual((exported.puzzleAttempts as Array<Record<string, unknown>>)[0], {
      attemptId: 'attempt',
      deviceId: DEVICE_ID,
      puzzleId: 'puzzle-1',
      outcome: 'solved',
      incorrectAttempts: 1,
      usedHint: true,
      elapsedMs: 7_000,
      occurredAt: NOW.toISOString(),
      normalizedOccurredAt: NOW.toISOString(),
      receivedAt: NOW.toISOString(),
      snapshotVersion: 'release-2026q2',
      syncSequence: '12',
    })
    assert.equal((exported.lichessSyncJobs as unknown[]).length, 1)
    assert.equal((exported.lichessImportedGames as unknown[]).length, 1)
    assert.equal((exported.personalOpeningEdges as unknown[]).length, 1)
    assert.deepEqual(exported.excludedSecrets, [
      'provider access tokens', 'provider account identifiers', 'share token hashes', 'object-store keys',
    ])
    const serialized = JSON.stringify(exported)
    assert.equal(serialized.includes('access_token'), false)
    assert.equal(serialized.includes('provider_user_id'), false)
    assert.ok(database.statements.some(({ sql }) => sql === 'BEGIN READ ONLY'))
  })

  it('rolls back export failures', async () => {
    const database = new ScriptedPool((sql) => {
      if (sql.includes('FROM card_states WHERE user_id = $1 ORDER BY')) throw new Error('export query failed')
      return { rows: [] }
    })
    await assert.rejects(() => new PostgresSyncStore(database.pool).exportAccount('user-a', NOW), /export query failed/)
    assert.ok(database.statements.some(({ sql }) => sql === 'ROLLBACK'))
  })

  it('exports nullable lifecycle fields without inventing timestamps or cursors', async () => {
    const database = new ScriptedPool((sql) => {
      if (sql.includes('FROM card_states WHERE user_id = $1 ORDER BY')) {
        return { rows: [{ ...cardRow(), last_reviewed_at: null }] }
      }
      if (sql.includes('SELECT version, value FROM user_settings')) return { rows: [{ version: 1, value: SETTINGS }] }
      if (sql.includes('FROM share_links')) return { rows: [{
        id: 'share-active', repertoire_id: 'rep', revision_id: 'revision',
        expires_at: NOW, revoked_at: null, created_at: NOW,
      }] }
      if (sql.includes('FROM puzzle_progress')) return { rows: [{
        puzzle_id: 'puzzle-new', attempts: 0, solved: 0, abandoned: 0, clean_solves: 0,
        hints_used: 0, incorrect_moves: '0', total_elapsed_ms: '0', last_elapsed_ms: null,
        last_attempt_at: null,
      }] }
      if (sql.includes('FROM external_connections')) return { rows: [{
        provider: 'lichess', consented_at: NOW, last_synced_at: null, disconnected_at: NOW,
        sync_cursor_last_move_at: '1784134638000', sync_cursor_game_digest: null,
      }] }
      if (sql.includes('FROM lichess_sync_jobs')) return { rows: [{
        id: '018f1234-5678-7abc-8def-0123456789ab', status: 'queued', requested_at: NOW,
        sync_started_at: NOW, started_at: null, completed_at: null, retry_at: null, attempts: 0,
        processed_records: '0', accepted_games: '0', rejected_records: '0', failure_code: null,
      }] }
      return { rows: [] }
    })
    const exported = await new PostgresSyncStore(database.pool).exportAccount('user-a', NOW) as {
      cards: Array<{ lastReviewedAt: string | null }>
      shares: Array<{ expiresAt: string | null; revokedAt: string | null }>
      puzzleProgress: Array<{ lastAttemptAt: string | null }>
      connections: Array<{ lastSyncedAt: string | null; disconnectedAt: string | null; syncCursor: unknown }>
      lichessSyncJobs: Array<{ startedAt: string | null; completedAt: string | null; retryAt: string | null }>
    }
    assert.equal(exported.cards[0]?.lastReviewedAt, null)
    assert.deepEqual(exported.shares[0], {
      id: 'share-active', repertoireId: 'rep', revisionId: 'revision',
      expiresAt: NOW.toISOString(), revokedAt: null, createdAt: NOW.toISOString(),
    })
    assert.equal(exported.puzzleProgress[0]?.lastAttemptAt, null)
    assert.deepEqual(exported.connections[0], {
      provider: 'lichess', consentedAt: NOW.toISOString(), lastSyncedAt: null,
      disconnectedAt: NOW.toISOString(), syncCursor: null,
    })
    assert.deepEqual(
      {
        startedAt: exported.lichessSyncJobs[0]?.startedAt,
        completedAt: exported.lichessSyncJobs[0]?.completedAt,
        retryAt: exported.lichessSyncJobs[0]?.retryAt,
      },
      { startedAt: null, completedAt: null, retryAt: null },
    )
  })

  it('deletes private imports before tenant rows and fails closed without object storage', async () => {
    const deletedObjects: string[] = []
    const objects: ObjectStore = {
      putPrivateImmutable: async () => undefined,
      deletePrivate: async (key) => { deletedObjects.push(key) },
    }
    const successful = new ScriptedPool((sql) => sql.includes('SELECT source_object_key')
      ? { rows: [{ source_object_key: 'private/imports/one' }, { source_object_key: 'private/imports/two' }] } : {})
    await new PostgresSyncStore(successful.pool, objects).deleteAccount('user-a')
    assert.deepEqual(deletedObjects.sort(), ['private/imports/one', 'private/imports/two'])
    assert.equal(successful.statements.filter(({ sql }) => sql.startsWith('DELETE FROM ')).length, 13)
    assert.ok(successful.statements.some(({ sql }) => sql === 'COMMIT'))

    const blocked = new ScriptedPool((sql) => sql.includes('SELECT source_object_key')
      ? { rows: [{ source_object_key: 'private/imports/one' }] } : {})
    await assert.rejects(
      () => new PostgresSyncStore(blocked.pool).deleteAccount('user-a'),
      (error: unknown) => error instanceof ApiError && error.code === 'private_object_store_unavailable',
    )
    assert.ok(blocked.statements.some(({ sql }) => sql === 'ROLLBACK'))
  })

  it('deletes accounts with no private imports and rolls back object deletion failures', async () => {
    const noImports = new ScriptedPool((sql) => sql.includes('SELECT source_object_key') ? { rows: [] } : {})
    await new PostgresSyncStore(noImports.pool).deleteAccount('user-a')
    assert.ok(noImports.statements.some(({ sql }) => sql === 'COMMIT'))

    const failed = new ScriptedPool((sql) => sql.includes('SELECT source_object_key')
      ? { rows: [{ source_object_key: 'private/imports/fail' }] } : {})
    const objects: ObjectStore = {
      putPrivateImmutable: async () => undefined,
      deletePrivate: async () => { throw new Error('object deletion failed') },
    }
    await assert.rejects(() => new PostgresSyncStore(failed.pool, objects).deleteAccount('user-a'), /object deletion failed/)
    assert.ok(failed.statements.some(({ sql }) => sql === 'ROLLBACK'))
  })
})

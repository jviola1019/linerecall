-- Private connected-account analytics. This migration stores only irreversible
-- game-ID digests and bounded opening aggregates; raw PGN and opponent identity
-- are never persisted.
BEGIN;

ALTER TABLE external_connections
  ADD COLUMN IF NOT EXISTS sync_cursor_last_move_at bigint,
  ADD COLUMN IF NOT EXISTS sync_cursor_game_digest text;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_connections_cursor_pair') THEN
    ALTER TABLE external_connections ADD CONSTRAINT external_connections_cursor_pair CHECK (
      (sync_cursor_last_move_at IS NULL AND sync_cursor_game_digest IS NULL) OR
      (sync_cursor_last_move_at >= 0 AND sync_cursor_game_digest ~ '^[a-f0-9]{64}$')
    );
  END IF;
END $constraints$;

CREATE TABLE IF NOT EXISTS lichess_sync_jobs (
  user_id text NOT NULL,
  id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  requested_at timestamptz NOT NULL,
  sync_started_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  retry_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processed_records bigint NOT NULL DEFAULT 0 CHECK (processed_records >= 0),
  accepted_games bigint NOT NULL DEFAULT 0 CHECK (accepted_games >= 0),
  rejected_records bigint NOT NULL DEFAULT 0 CHECK (rejected_records >= 0),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,64}$'),
  PRIMARY KEY (user_id, id),
  CHECK (sync_started_at <= requested_at),
  CHECK (completed_at IS NULL OR completed_at >= requested_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS lichess_sync_jobs_one_active_per_user
  ON lichess_sync_jobs (user_id)
  WHERE status IN ('queued', 'running', 'retry_wait');
CREATE INDEX IF NOT EXISTS lichess_sync_jobs_recent
  ON lichess_sync_jobs (user_id, requested_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS lichess_imported_game_ids (
  user_id text NOT NULL,
  game_id_digest text NOT NULL CHECK (game_id_digest ~ '^[a-f0-9]{64}$'),
  last_move_at bigint NOT NULL CHECK (last_move_at >= 0),
  processed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, game_id_digest)
);

CREATE TABLE IF NOT EXISTS personal_opening_edge_aggregates (
  user_id text NOT NULL,
  edge_key text NOT NULL CHECK (edge_key ~ '^[a-f0-9]{64}$'),
  from_epd text NOT NULL CHECK (length(from_epd) BETWEEN 1 AND 128),
  uci text NOT NULL CHECK (uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),
  san text NOT NULL CHECK (length(san) BETWEEN 1 AND 32),
  to_epd text NOT NULL CHECK (length(to_epd) BETWEEN 1 AND 128),
  speed text NOT NULL CHECK (speed IN ('blitz', 'rapid', 'classical')),
  trained_side text NOT NULL CHECK (trained_side IN ('white', 'black')),
  rating_band text NOT NULL CHECK (rating_band IN ('<1200', '1200-1499', '1500-1799', '1800-1999', '2000-2199', '2200-2399', '2400+')),
  opening_eco text NOT NULL CHECK (opening_eco ~ '^[A-E][0-9]{2}$'),
  opening_name text NOT NULL CHECK (length(opening_name) BETWEEN 1 AND 128),
  opening_ply integer NOT NULL CHECK (opening_ply BETWEEN 0 AND 60),
  ply integer NOT NULL CHECK (ply BETWEEN 1 AND 30),
  games bigint NOT NULL CHECK (games > 0),
  wins bigint NOT NULL CHECK (wins >= 0),
  draws bigint NOT NULL CHECK (draws >= 0),
  losses bigint NOT NULL CHECK (losses >= 0),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, edge_key),
  CHECK (games = wins + draws + losses),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX IF NOT EXISTS personal_opening_edges_by_opening
  ON personal_opening_edge_aggregates (user_id, opening_eco, trained_side, speed);

DO $policy$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'lichess_sync_jobs', 'lichess_imported_game_ids', 'personal_opening_edge_aggregates'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS isolate_user ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY isolate_user ON %I USING (user_id = current_setting(''app.user_id'', true)) WITH CHECK (user_id = current_setting(''app.user_id'', true))',
      table_name
    );
  END LOOP;
END $policy$;

COMMIT;

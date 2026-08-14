-- Immutable unified-family coverage journal and resumable cursor history.
-- Public membership rows are promoted only with a signed release manifest.
BEGIN;

CREATE TABLE IF NOT EXISTS snapshot_family_pack_membership (
  snapshot_version text NOT NULL REFERENCES supported_snapshot_versions(version),
  family_id text NOT NULL CHECK (family_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  pack_id text NOT NULL CHECK (pack_id ~ '^[a-z0-9][a-z0-9_-]{2,95}$'),
  side text NOT NULL CHECK (side IN ('white', 'black')),
  PRIMARY KEY (snapshot_version, family_id, pack_id),
  UNIQUE (snapshot_version, family_id, pack_id, side)
);

CREATE TABLE IF NOT EXISTS snapshot_family_path_membership (
  snapshot_version text NOT NULL,
  family_id text NOT NULL,
  pack_id text NOT NULL,
  path_id text NOT NULL CHECK (path_id ~ '^path_[a-f0-9]{20}$'),
  PRIMARY KEY (snapshot_version, family_id, pack_id, path_id),
  FOREIGN KEY (snapshot_version, family_id, pack_id)
    REFERENCES snapshot_family_pack_membership(snapshot_version, family_id, pack_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS family_coverage_events (
  user_id text NOT NULL,
  event_id uuid NOT NULL,
  device_id uuid NOT NULL,
  snapshot_version text NOT NULL,
  family_id text NOT NULL,
  pack_id text NOT NULL,
  path_id text NOT NULL,
  coverage_cycle_id text NOT NULL CHECK (coverage_cycle_id ~ '^[a-z0-9][a-z0-9_-]{2,95}::coverage:[0-9]+$'),
  completed_at timestamptz NOT NULL,
  normalized_completed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  sync_sequence bigint NOT NULL DEFAULT nextval('linerecall_sync_sequence'),
  PRIMARY KEY (user_id, event_id),
  UNIQUE (user_id, snapshot_version, family_id, pack_id, path_id, coverage_cycle_id),
  UNIQUE (user_id, sync_sequence),
  FOREIGN KEY (snapshot_version, family_id, pack_id, path_id)
    REFERENCES snapshot_family_path_membership(snapshot_version, family_id, pack_id, path_id)
);
CREATE INDEX IF NOT EXISTS family_coverage_events_page
  ON family_coverage_events (user_id, snapshot_version, family_id, sync_sequence, event_id);

CREATE TABLE IF NOT EXISTS family_cycle_events (
  user_id text NOT NULL,
  event_id uuid NOT NULL,
  device_id uuid NOT NULL,
  snapshot_version text NOT NULL,
  family_id text NOT NULL,
  side text NOT NULL CHECK (side IN ('white', 'black')),
  kind text NOT NULL CHECK (kind IN ('cycle_started', 'pack_bound')),
  generation_id uuid NOT NULL,
  generation_ordinal integer NOT NULL CHECK (generation_ordinal >= 0),
  pack_id text,
  pack_coverage_cycle_id text,
  occurred_at timestamptz NOT NULL,
  normalized_occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  sync_sequence bigint NOT NULL DEFAULT nextval('linerecall_sync_sequence'),
  PRIMARY KEY (user_id, event_id),
  UNIQUE (user_id, sync_sequence),
  CHECK (
    (kind = 'cycle_started' AND pack_id IS NULL AND pack_coverage_cycle_id IS NULL)
    OR
    (kind = 'pack_bound' AND pack_id IS NOT NULL AND pack_coverage_cycle_id IS NOT NULL
      AND pack_coverage_cycle_id ~ '^[a-z0-9][a-z0-9_-]{2,95}::coverage:[0-9]+$')
  ),
  FOREIGN KEY (snapshot_version, family_id, pack_id, side)
    REFERENCES snapshot_family_pack_membership(snapshot_version, family_id, pack_id, side)
);
CREATE UNIQUE INDEX IF NOT EXISTS family_cycle_events_generation_once
  ON family_cycle_events (user_id, snapshot_version, family_id, side, generation_ordinal)
  WHERE kind = 'cycle_started';
CREATE UNIQUE INDEX IF NOT EXISTS family_cycle_events_pack_once
  ON family_cycle_events (user_id, snapshot_version, family_id, side, generation_id, pack_id)
  WHERE kind = 'pack_bound';
CREATE INDEX IF NOT EXISTS family_cycle_events_page
  ON family_cycle_events (user_id, snapshot_version, family_id, side, sync_sequence, event_id);

CREATE TABLE IF NOT EXISTS family_training_cursor_events (
  user_id text NOT NULL,
  mutation_id uuid NOT NULL,
  device_id uuid NOT NULL,
  snapshot_version text NOT NULL,
  family_id text NOT NULL,
  pack_id text NOT NULL,
  side text NOT NULL CHECK (side IN ('white', 'black')),
  coverage_cycle_id text NOT NULL CHECK (coverage_cycle_id ~ '^[a-z0-9][a-z0-9_-]{2,95}::coverage:[0-9]+$'),
  version integer NOT NULL CHECK (version > 0),
  cursor_sha256 text NOT NULL CHECK (cursor_sha256 ~ '^[a-f0-9]{64}$'),
  cursor_document jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  sync_sequence bigint NOT NULL DEFAULT nextval('linerecall_sync_sequence'),
  PRIMARY KEY (user_id, mutation_id),
  UNIQUE (user_id, snapshot_version, family_id, side, pack_id, version),
  UNIQUE (user_id, snapshot_version, family_id, side, pack_id, cursor_sha256),
  UNIQUE (user_id, sync_sequence),
  FOREIGN KEY (snapshot_version, family_id, pack_id, side)
    REFERENCES snapshot_family_pack_membership(snapshot_version, family_id, pack_id, side)
);
CREATE INDEX IF NOT EXISTS family_training_cursor_latest
  ON family_training_cursor_events (user_id, snapshot_version, family_id, side, pack_id, version DESC);
CREATE INDEX IF NOT EXISTS family_training_cursor_by_cycle
  ON family_training_cursor_events (user_id, snapshot_version, family_id, side, pack_id, coverage_cycle_id, version DESC);

DO $policy$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'family_coverage_events', 'family_cycle_events', 'family_training_cursor_events'
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

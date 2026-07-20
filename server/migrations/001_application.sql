-- LineRecall application schema. Better Auth tables are generated separately
-- from the pinned Better Auth CLI and are deliberately not owned by this role.
BEGIN;

CREATE SEQUENCE IF NOT EXISTS linerecall_sync_sequence AS bigint;

CREATE TABLE IF NOT EXISTS supported_snapshot_versions (
  version text PRIMARY KEY CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz NOT NULL,
  retired_at timestamptz
);

CREATE TABLE IF NOT EXISTS snapshot_card_membership (
  snapshot_version text NOT NULL REFERENCES supported_snapshot_versions(version),
  pack_id text NOT NULL CHECK (pack_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  node_id text NOT NULL CHECK (node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  card_id text NOT NULL CHECK (card_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  PRIMARY KEY (snapshot_version, pack_id, node_id, card_id)
);

CREATE TABLE IF NOT EXISTS snapshot_puzzle_membership (
  snapshot_version text NOT NULL REFERENCES supported_snapshot_versions(version),
  puzzle_id text NOT NULL CHECK (puzzle_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  PRIMARY KEY (snapshot_version, puzzle_id)
);

CREATE TABLE IF NOT EXISTS review_events (
  user_id text NOT NULL,
  event_id uuid NOT NULL,
  device_id uuid NOT NULL,
  card_id text NOT NULL CHECK (card_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  pack_id text NOT NULL CHECK (pack_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  node_id text NOT NULL CHECK (node_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  grade text NOT NULL CHECK (grade IN ('again', 'hard', 'good', 'easy')),
  occurred_at timestamptz NOT NULL,
  normalized_occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  local_date date NOT NULL,
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  snapshot_version text NOT NULL REFERENCES supported_snapshot_versions(version),
  corrects_event_id uuid,
  sync_sequence bigint NOT NULL DEFAULT nextval('linerecall_sync_sequence'),
  PRIMARY KEY (user_id, event_id),
  UNIQUE (user_id, sync_sequence),
  FOREIGN KEY (user_id, corrects_event_id) REFERENCES review_events(user_id, event_id),
  FOREIGN KEY (snapshot_version, pack_id, node_id, card_id)
    REFERENCES snapshot_card_membership(snapshot_version, pack_id, node_id, card_id)
);
CREATE INDEX IF NOT EXISTS review_events_card_replay
  ON review_events (user_id, card_id, normalized_occurred_at, received_at, event_id);
CREATE UNIQUE INDEX IF NOT EXISTS review_events_one_correction
  ON review_events (user_id, corrects_event_id) WHERE corrects_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS card_states (
  user_id text NOT NULL,
  card_id text NOT NULL,
  repetitions integer NOT NULL CHECK (repetitions >= 0),
  interval_days integer NOT NULL CHECK (interval_days >= 0),
  ease_factor numeric(6,4) NOT NULL CHECK (ease_factor BETWEEN 1.3 AND 3.5),
  due_at timestamptz NOT NULL,
  last_reviewed_at timestamptz,
  mastery integer NOT NULL CHECK (mastery BETWEEN 0 AND 100),
  last_event_id uuid,
  sync_sequence bigint NOT NULL,
  PRIMARY KEY (user_id, card_id),
  UNIQUE (user_id, sync_sequence),
  FOREIGN KEY (user_id, last_event_id) REFERENCES review_events(user_id, event_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id text PRIMARY KEY,
  version integer NOT NULL CHECK (version >= 0),
  value jsonb NOT NULL,
  sync_sequence bigint NOT NULL DEFAULT nextval('linerecall_sync_sequence'),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE IF NOT EXISTS repertoire_import_jobs (
  user_id text NOT NULL,
  id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
  trained_side text NOT NULL CHECK (trained_side IN ('white', 'black')),
  status text NOT NULL CHECK (status IN ('queued', 'validating', 'analyzing', 'ready', 'failed', 'cancelled')),
  source_object_key text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  failure_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS repertoires (
  user_id text NOT NULL,
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  version integer NOT NULL CHECK (version > 0),
  current_revision_id uuid,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS repertoire_revisions (
  user_id text NOT NULL,
  id uuid NOT NULL,
  repertoire_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, repertoire_id, version),
  FOREIGN KEY (user_id, repertoire_id) REFERENCES repertoires(user_id, id) ON DELETE CASCADE
);
ALTER TABLE repertoires DROP CONSTRAINT IF EXISTS repertoires_current_revision_fk;
ALTER TABLE repertoires ADD CONSTRAINT repertoires_current_revision_fk
  FOREIGN KEY (user_id, current_revision_id) REFERENCES repertoire_revisions(user_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS share_links (
  user_id text NOT NULL,
  id uuid NOT NULL,
  repertoire_id text NOT NULL,
  revision_id uuid NOT NULL,
  token_sha256 bytea NOT NULL CHECK (octet_length(token_sha256) = 32),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (token_sha256),
  FOREIGN KEY (user_id, repertoire_id) REFERENCES repertoires(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, revision_id) REFERENCES repertoire_revisions(user_id, id)
);

CREATE TABLE IF NOT EXISTS external_connections (
  user_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('lichess')),
  provider_user_id_ciphertext bytea NOT NULL,
  access_token_ciphertext bytea NOT NULL,
  token_expires_at timestamptz,
  sync_cursor text,
  consented_at timestamptz NOT NULL,
  last_synced_at timestamptz,
  disconnected_at timestamptz,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS puzzle_progress (
  user_id text NOT NULL,
  puzzle_id text NOT NULL CHECK (puzzle_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  attempts integer NOT NULL CHECK (attempts >= 0),
  solved integer NOT NULL CHECK (solved >= 0 AND solved <= attempts),
  last_attempt_at timestamptz,
  sync_sequence bigint NOT NULL DEFAULT nextval('linerecall_sync_sequence'),
  PRIMARY KEY (user_id, puzzle_id)
);

CREATE TABLE IF NOT EXISTS puzzle_attempt_events (
  user_id text NOT NULL,
  attempt_id uuid NOT NULL,
  device_id uuid NOT NULL,
  puzzle_id text NOT NULL CHECK (puzzle_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  solved boolean NOT NULL,
  occurred_at timestamptz NOT NULL,
  normalized_occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  snapshot_version text NOT NULL,
  sync_sequence bigint NOT NULL DEFAULT nextval('linerecall_sync_sequence'),
  PRIMARY KEY (user_id, attempt_id),
  UNIQUE (user_id, sync_sequence),
  FOREIGN KEY (snapshot_version, puzzle_id)
    REFERENCES snapshot_puzzle_membership(snapshot_version, puzzle_id)
);

-- Fail closed: a missing app.user_id setting evaluates to NULL and cannot
-- satisfy a policy. FORCE prevents a table owner from accidentally bypassing.
DO $policy$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'review_events', 'card_states', 'user_settings', 'repertoire_import_jobs',
    'repertoires', 'repertoire_revisions', 'share_links',
    'external_connections', 'puzzle_progress', 'puzzle_attempt_events'
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

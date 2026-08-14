-- Run as a database administrator after replacing role ownership according to
-- the deployment's secret-manager-generated identities. This file contains no
-- credentials and intentionally does not CREATE LOGIN roles.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

-- Example least-privilege grants. `linerecall_app` must not own tables and
-- must never receive BYPASSRLS. Better Auth should use a separate role limited
-- to its own reviewed tables.
GRANT USAGE ON SCHEMA public TO linerecall_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  review_events, card_states, user_settings, repertoire_import_jobs,
  repertoires, repertoire_revisions, share_links, external_connections,
  puzzle_progress, puzzle_attempt_events, lichess_sync_jobs,
  lichess_imported_game_ids, personal_opening_edge_aggregates,
  family_coverage_events, family_cycle_events, family_training_cursor_events
TO linerecall_app;
GRANT SELECT ON
  supported_snapshot_versions, snapshot_card_membership, snapshot_puzzle_membership,
  snapshot_family_pack_membership, snapshot_family_path_membership
TO linerecall_app;
GRANT USAGE, SELECT ON SEQUENCE linerecall_sync_sequence TO linerecall_app;

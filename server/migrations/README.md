# Database migration safety

- Better Auth owns a separate generated schema/migration history and credential. Do not copy a generated auth migration into this directory without reviewing it against the pinned `better-auth` and passkey versions.
- Apply schema migrations `001`, `004`, `005`, and `006` with an administrative migration role. Apply the reviewed `002_roles.example.sql` grants only after all referenced tables exist, then install the `003` share resolver with its dedicated owner. The numeric filenames preserve repository history; they are not an executable dependency order.
- `linerecall_app` must be `NOINHERIT`, `NOBYPASSRLS`, and must not own protected tables.
- The owner of `resolve_unlisted_share` must be a dedicated `NOLOGIN BYPASSRLS` role. Its fixed SQL, empty user-controlled identifiers, exact 256-bit token digest, empty search path, and execute-only grant are the reviewed anonymous access boundary.
- Test `RESET app.user_id`, connection-pool reuse, two distinct users, function token misses, expired/revoked shares, and role attributes after every migration.
- Never insert a `supported_snapshot_versions` row until the signed catalog release is approved.
- Populate `snapshot_card_membership` from that same approved manifest before exposing the snapshot. Review-event foreign keys and API checks both fail closed when membership is missing.
- Apply `004_lichess_personal_analytics.sql` after the base schema. It adds the monotonic connected-game cursor, durable sync status, irreversible game-ID deduplication, private edge aggregates, and forced RLS. It never stores provider PGN or opponent identity.
- Apply `005_puzzle_attempt_evidence.sql` before enabling tactical sync. It preserves solved/abandoned outcomes, hint use, incorrect attempts, and bounded elapsed time. Historical attempts are migrated conservatively without inventing missing evidence.
- Apply `006_family_training_journal.sql` before enabling connected family practice. In the same approved release transaction, populate `snapshot_family_pack_membership` and `snapshot_family_path_membership` from the signed family manifests; cursor cards continue to bind to `snapshot_card_membership`. The three user journal tables enable and force RLS. Test more than 1,000 paths, stale cursor versions, logical completion duplicates, `RESET app.user_id`, and pooled cross-tenant reuse before staging.

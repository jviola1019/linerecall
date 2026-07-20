# Database migration safety

- Better Auth owns a separate generated schema/migration history and credential. Do not copy a generated auth migration into this directory without reviewing it against the pinned `better-auth` and passkey versions.
- Apply application migrations in numeric order with an administrative migration role.
- `linerecall_app` must be `NOINHERIT`, `NOBYPASSRLS`, and must not own protected tables.
- The owner of `resolve_unlisted_share` must be a dedicated `NOLOGIN BYPASSRLS` role. Its fixed SQL, empty user-controlled identifiers, exact 256-bit token digest, empty search path, and execute-only grant are the reviewed anonymous access boundary.
- Test `RESET app.user_id`, connection-pool reuse, two distinct users, function token misses, expired/revoked shares, and role attributes after every migration.
- Never insert a `supported_snapshot_versions` row until the signed catalog release is approved.
- Populate `snapshot_card_membership` from that same approved manifest before exposing the snapshot. Review-event foreign keys and API checks both fail closed when membership is missing.
- Apply `004_lichess_personal_analytics.sql` after the base schema. It adds the monotonic connected-game cursor, durable sync status, irreversible game-ID deduplication, private edge aggregates, and forced RLS. It never stores provider PGN or opponent identity.

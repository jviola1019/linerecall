# API contract notes

All JSON endpoints are versioned under `/v1`. Mutations require the exact configured `Origin` and an authenticated Secure/HttpOnly/SameSite=Lax session. Validation failures return a bounded list of field paths; user content is never reflected.

Core routes:

- `POST /v1/sync`, `GET /v1/sync/bootstrap`
- `GET /v1/catalog/manifest`, `GET /v1/puzzles`
- `POST /v1/repertoires/imports`, `GET /v1/repertoires/imports/:jobId`
- `PUT /v1/repertoires/:id` with `If-Match`
- `POST /v1/repertoires/:id/shares`, `DELETE /v1/shares/:id`, `GET /v1/shares/:token`
- `GET /v1/account/export`, recent-authenticated `DELETE /v1/account`
- `POST /v1/connections/lichess/start`, `POST /v1/connections/lichess/complete`, `DELETE /v1/connections/lichess`
- Better Auth handler at `/api/auth/*`

The sync correction extension is optional `correctsEventId` on `ReviewEventV1`. It must name the latest original event for the same user/card/pack/node, and that event must not already have a correction. The correction changes the effective grade without changing the original review time.

Every accepted review must match an exact `(snapshotVersion, packId, nodeId, cardId)` row promoted with the signed release. Unknown client-created card identities return `unknown_card_membership` and never enter scheduling projections.

Magic-link requests use two independent limits: 20 per source IP per hour and five per normalized email digest per hour. The email-specific exhausted/error path returns the same generic `{ "status": true }` response as an accepted submission and does not call the mail provider.

Account deletion first revokes every connected provider credential. Any provider/network failure aborts deletion and preserves encrypted credentials and account data for a safe retry; an explicit provider “invalid token” response permits local deletion.

HTTP 429 includes `Retry-After`; all limited routes include `RateLimit-Limit`, `RateLimit-Remaining`, and relative `RateLimit-Reset`. If Redis cannot prove a costly mutation is within policy, the route returns 503 rather than failing open.

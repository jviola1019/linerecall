# LineRecall connected service

This directory is an independently pinned Node 24/Fastify 5 service. It implements the connected API boundary without coupling the offline artifact to network code.

## Implemented

- Strict Zod request contracts, 256 KiB sync limit, 250-event batches, request IDs, CSP/security headers, same-origin mutation enforcement, safe error responses, and redacted operational logging.
- Append-only review events, signed-snapshot card membership enforcement, idempotency/conflict detection, deterministic late-event replay, five-minute future-clock normalization, explicit corrections of only the latest review, server-derived SM-2/mastery, pagination, per-user PostgreSQL serialization, and atomic optimistic settings concurrency.
- Local in-memory adapters and PostgreSQL implementations. Application transactions set `app.user_id`; all user tables enable and force RLS.
- Better Auth configuration for five-minute, hashed, single-use magic links and session-gated passkeys. Every non-magic auth route has an early in-process 120/IP/five-minute backstop with IPv6 `/64` normalization and an authoritative distributed 120/IP/five-minute limit. Magic-link submission uses the distributed limit directly so exhausted/unavailable states retain the same generic success shape; it is further limited to 20/IP/hour and 5/normalized-email/hour, while passkey routes are limited to 30/IP/five minutes. Upstream identity responses cannot overwrite the service-owned rate-limit headers. The production database and auth database use separate credentials.
- Redis atomic distributed limits, fail-closed behavior, immutable/versioned repertoires, asynchronous private PGN staging, 128-bit-plus unlisted tokens stored as SHA-256 only, export, and account deletion orchestration.
- Lichess OAuth Authorization Code + PKCE, one globally leased request, 60-second 429 cooldown, bounded responses, KMS token encryption, and fail-closed token revocation. A dedicated pg-boss worker publishes a short-lived readiness heartbeat, consumes one globally coordinated stream at a time, reconciles exhausted retries, and stops without accepting new work. Disconnect/account deletion retain ciphertext and abort when revocation fails; provider 401 is treated as already invalid.
- AWS S3/KMS, SES, Batch, PostgreSQL, and Redis adapters plus a hardened non-root container.

The default catalog adapter deliberately returns `releaseStatus: unavailable`; it does not invent a release. Replace it with the signed catalog adapter produced by the data release pipeline before staging. Chess.com is intentionally absent pending written authorization and legal review.

## Local verification

```powershell
cd server
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:coverage
npm run build
```

Coverage measures testable domain, security, adapter, and worker-runtime code. The three process-only bootstrap files (`src/index.ts`, the compute dispatcher entrypoint, and the Lichess worker entrypoint) are excluded from the unit metric; their behavior is delegated to covered runtime modules and remains subject to container/staging startup and shutdown checks.

For an intentionally ephemeral local service:

```powershell
$env:NODE_ENV = 'development'
$env:ALLOW_INSECURE_DEV_AUTH = 'true'
$env:AUTH_MODE = 'dev-header'
npm run dev
```

The `x-linerecall-user` development header is accepted only under that explicit non-production configuration. Do not put the development mode behind a public listener or proxy.

`compose.yaml` binds only to loopback and defaults to memory adapters. The optional `dependencies` profile starts PostgreSQL and Redis for manual adapter work; it does not silently activate them. Supply explicit URLs and an approved snapshot row when exercising PostgreSQL sync.

## Production runbook boundaries

1. Generate and review Better Auth migrations using the exact lockfile version. Apply them with the auth migration role, not `linerecall_app`.
2. Apply `migrations/001_application.sql`, then the reviewed role grants and public-share function as an administrator. Verify the function owner is a NOLOGIN `BYPASSRLS` policy-owner role; the runtime role receives only `EXECUTE`.
3. Insert a snapshot version and its complete `snapshot_card_membership` rows in one release transaction only after the signed manifest and data gates pass.
4. Supply all production environment values from Secrets Manager/task configuration. Startup intentionally fails when identity, verified database TLS, Redis, KMS, S3, Batch, Lichess, or contact settings are absent.
5. Use immutable, digest-pinned container images. Run migrations as a separate one-shot task before a blue/green deployment.
6. Validate SES sending identity, frozen WebAuthn RP ID, exact origins/redirects, RLS cross-tenant tests, backup restoration, KMS permissions, and provider revocation in staging.
7. Run `npm run start:lichess-worker` as a separate task with the application database role, verified database CA, `rediss://` endpoint, KMS decrypt permission, and monitored contact User-Agent. Build the dedicated container target with `docker build --target lichess-worker .`; it has no misleading API HTTP health check. The API accepts sync requests only while this task renews its Redis readiness lease.

No cloud resources were deployed and no external provider call was made by the repository tests. Manual accessibility, legal/trademark, production recovery, and live-provider audits remain external release gates.

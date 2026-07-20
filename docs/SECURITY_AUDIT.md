# Security and robustness audit protocol

Current release-security status: **not approved**. Automated static policy,
secret, dependency, license, CSP/artifact, adversarial parser, and local service
tests pass for the 2026-07-20 review candidate with SHA-256
`e13d4fe0d3180a1409dacbec6e454a56791f456ed8f8ac28662c5bcc1fe06507`
and the source snapshot recorded in the generated audit manifest. These results
are engineering evidence only. An independent exact-source security review and
provider-backed connected-staging assessment have not been completed, so no
penetration-test, production-security, privacy, or legal certification claim
is made. Historical candidate hashes remain superseded evidence and must not
be used to approve the current source or artifact.

## Client and artifact boundary

- Treat search, SAN/UCI, PGN, progress JSON, opening names, snapshots, puzzle
  shards, annotations, and URLs as untrusted.
- Enforce the locked size/token/ply/header/annotation limits with strict Zod
  schemas and guarded `chess.js` application.
- Render source and user content as text. Runtime scanning rejects raw-HTML
  sinks, dynamic code/script creation, executable schemes, client secrets,
  telemetry, runtime data-network APIs in the artifact, and browser storage.
- `ProgressRepository` exposes cloud, supported Artifact storage, memory, and
  validated JSON only. The downloaded artifact uses memory plus JSON; it must
  warn before users assume reload durability.
- The final HTML must be self-contained, at most 10 MiB, and protected by an
  exact hash-only CSP. Hosting manifests bind response CSP, MIME, anti-framing,
  referrer, permissions, HTTPS/HSTS, and cache policy to the artifact digest.
- Chessnut SVGs are pinned by SHA-256 and rejected if they contain script,
  event handlers, `foreignObject`, external image/use/anchor references, or
  JavaScript URLs. Pieces are bundled locally and pinned by digest. Typography
  uses the operating-system stack; no remote or embedded font is shipped.

## Connected-service boundary

- Validate every versioned API request and cap body, collection, token, import,
  and pagination sizes before business logic.
- Use parameterized SQL and request transactions with `SET LOCAL app.user_id`.
  Every protected table carries `user_id`, enables and forces RLS, and is owned
  by a role the application cannot use or bypass.
- Derive schedules server-side from append-only, idempotent review events. Do
  not trust client intervals, mastery, tenant IDs, future timestamps, cursors,
  object keys, or optimistic versions.
- Protect cookie sessions with `__Host-`, Secure, HttpOnly, SameSite=Lax,
  rotation after authentication changes, origin/CSRF checks, and recent-auth
  controls for destructive account operations.
- Hash single-use five-minute magic links and unlisted-share tokens. Freeze the
  WebAuthn RP ID before production enrollment.
- Keep Lichess OAuth tokens encrypted server-side; use PKCE S256, exact HTTPS
  redirects, cryptographic state, global serialization, deduplication, and at
  least a 60-second wait after HTTP 429. Tokens never enter application
  JavaScript, browser storage, exports, or logs.
- Apply the documented edge/user/IP limits. If Redis is unavailable, costly
  mutations fail with 503 rather than guessing a distributed limit.
- Prevent SSRF with fixed source allowlists, DNS/IP and redirect revalidation,
  response size/time limits, and no user-selected server fetch URL.
- Use KMS/Secrets Manager, redacted structured telemetry, signed images,
  GitHub OIDC, SBOMs, provenance attestations, encrypted backups, point-in-time
  recovery, and exercised restore procedures.

## Current automated evidence and remaining review

The 2026-07-20 automated reports cover 101 client/server/infrastructure source
or configuration files and 358 secret-scanned repository files. They report
zero recognized credentials, zero high or critical production dependency
vulnerabilities across the offline client, hosted client, and server, 734
allowlisted dependency packages, and an 808-component CycloneDX 1.5 SBOM. All
23 security-critical server modules meet the per-file 90% branch and function
thresholds.

The source snapshot must be regenerated after every documentation or source
change. A stale tree hash, browser report, artifact audit, hosting audit, or
security receipt cannot be edited into a pass. These automated results do not
replace independent review or provider-backed testing.

Provider-backed cross-tenant pooled-connection RLS, WebAuthn/email/OAuth,
Redis/S3/KMS/Batch, workload identity, outage/dead-letter recovery, account
deletion, backup, and restore exercises remain hard staging gates. The durable
Lichess worker is implemented and covered locally but has not passed that
staging campaign.

Local mocks cannot establish live email, WebAuthn, Lichess, Redis, PostgreSQL,
S3, Batch, WAF, KMS, Artifact-storage, or disaster-recovery behavior. Those
remain hard staging gates. A qualified review is still required for privacy,
terms, age handling, support obligations, sharing policy, and all legal claims.

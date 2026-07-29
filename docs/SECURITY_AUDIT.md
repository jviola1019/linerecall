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

## Current source-tree controls and unresolved boundaries

The source tree is ahead of the exact 2026-07-20 candidate. The following are
review-only implementation observations, not a current security approval:

- Family catalog, manifest, graph-shard, pack, path-membership, release, root,
  and content-address references are strict and fail closed. Pack-local card,
  due-set, cursor, and family-cycle identities prevent one pack from silently
  consuming another pack's state.
- Full-family traversal records append-only `cycle_started` and `pack_bound`
  events. Named-branch traversal resolves primary and secondary memberships
  across same-side packs, but its cross-pack coordinator exists only in React
  session state. There is no versioned append-only branch-cycle record from
  which a reload can authenticate and rebuild the exact membership, completed
  set, and next pack. Durable remount behavior remains a release and staging
  blocker.
- Tactical resources validate state and records independently, reject duplicate
  IDs, replay chess moves through guarded logic, and keep puzzle progress
  separate from recall progress. No real shard has passed digest, graph
  association, and per-node Stockfish promotion; synthetic review fixtures
  must never be accepted as puzzle evidence.
- Board annotations accept fixed squares, bounded labels, and fixed semantic
  styles. Arbitrary SVG, HTML, CSS, URLs, and executable content remain outside
  the contract.
- Compact-v3 disposable SQLite working copies apply live page caps and no
  on-disk rollback journal. A full database rolls back and cannot checkpoint or
  promote. The pipeline now confines SQLite pathname reopens to a canonical,
  non-symlink work boundary; POSIX requires effective-user ownership, blocks
  group/world writes and unsafe writable ancestors, and creates private
  `v3/.adapter-working` directories. Durable promotion links and checkpoint
  renames fsync their parent where supported. Windows receives path-identity
  and reparse-point checks, but Node cannot prove NTFS ACL ownership or
  directory-fsync durability; an operator-reviewed private local ACL remains a
  prerequisite. Same-user hostile processes remain outside this offline
  pipeline's threat model. These controls limit failure impact; the cumulative
  game ledger and complete baseline still make full-Q2 capacity unproven.
- `.github/workflows/codeql.yml` is configured for JavaScript/TypeScript with
  SHA-pinned actions, `security-extended` queries, concurrency cancellation,
  and only `contents: read` plus `security-events: write`. Its first run on
  commit `9ec6c6e` completed analysis and reported 19 high-severity findings and
  one medium-severity finding across file-handle races, incomplete HTML-tag
  regular expressions, a missing generic-auth limiter, and a file-derived
  outbound request. The follow-up source replaces check-then-open paths with
  handle-bound validation and atomic file operations, uses a standards HTML
  parser for CSP inspection, rate-limits every auth route, and reconstructs
  archive URLs from a closed compile-time allowlist. No alert is suppressed or
  dismissed. A clean CodeQL result on the pushed follow-up head is required;
  the repository check status, not this narrative, is authoritative.

Current-source artifact, browser, dependency, SBOM, secret, CodeQL, server,
infrastructure, and independent security evidence must be regenerated and
digest-bound. Full promoted opening/puzzle data, durable branch recovery,
manual accessibility, locale/editorial review, legal approval, and connected
staging remain outside the approved boundary.

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

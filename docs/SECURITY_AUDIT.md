# Security and robustness audit protocol

Current status: **not approved**. No independent security review or
provider-backed connected-staging assessment has approved the current source or
candidate. This document describes security boundaries and required evidence;
it does not claim a penetration test, production-security certification,
privacy approval, or legal compliance.

## Evidence policy

No current test count, coverage result, dependency result, CodeQL result,
secret-scan result, artifact hash, or security-review pass is asserted here.
Generated reports are valid only for the exact source snapshot, candidate
SHA-256, configuration, lockfile, manifests, and evidence receipts they name.
Any source, dependency, configuration, data, or documentation change requires
regeneration. A stale report cannot be edited into a pass.

The tracked `audit/templates/evidence/security-manual.json` record remains
`not_run`. `npm run audit:init-evidence` copies missing templates into the
ignored `audit/evidence/` workspace without replacing prior work. A qualified
reviewer must bind the completed security record to the exact hardened
candidate and `audit/generated/connected-source-snapshot.json`. After review,
`npm run release:evidence-receipts -- --write` archives attachments by digest
and refuses stale completed records. Templates, generated reports, and manual
claims remain separate; tracked templates never become approvals.

Synthetic family, engine, Scid, puzzle, auth, RLS, provider, and production-
handoff fixtures are adversarial test inputs only. They are not real corpus
evidence, live-provider evidence, or an independent security assessment.

## Client and artifact boundary

- Treat search, SAN/UCI, PGN, progress JSON, opening names, family manifests,
  graph and puzzle shards, annotations, and URLs as untrusted.
- Enforce versioned strict Zod schemas and locked byte, token, ply, header,
  nesting, collection, annotation, and label limits before business logic.
  Guard every chess operation with `chess.js` and return accessible errors.
- Render source and user content as text. Project policy prohibits
  `dangerouslySetInnerHTML`, `eval`, dynamic scripts, arbitrary SVG/HTML/CSS,
  unsafe URL schemes, client secrets, telemetry, and runtime data-network calls
  in the downloaded artifact.
- Annotations accept only `a1`–`h8` squares, fixed semantic styles, bounded
  labels, and bounded counts. Piece SVGs are pinned, local, and must reject
  script, event handlers, `foreignObject`, external references, and executable
  URLs.
- `ProgressRepository` permits cloud, supported Artifact storage, memory, and
  validated JSON only. The downloaded build uses memory plus JSON and must not
  use `localStorage` or IndexedDB.
- The final HTML must be self-contained, no larger than 10 MiB, and protected
  by an exact hash-only inline CSP. The hosted response contract also binds
  MIME, anti-framing, referrer, permissions, HTTPS/HSTS, and cache headers to
  the artifact digest.
- Corrupt, stale, cross-release, wrongly owned, or digest-mismatched family,
  graph, evidence, and puzzle resources fail closed. A failed resource cannot
  fall back to synthetic or legacy training content.

## Offline data-pipeline boundary

Compact-v3 production data is an untrusted build input even when its source is
approved. The source implementation is intended to enforce these controls,
which still require a current exact-source campaign:

- Reconstruct archive URLs from approved manifests/allowlists; do not accept a
  user-selected server fetch URL. Verify source byte length and digest while
  streaming, and promote nothing after a mismatch.
- Use bounded candidate/exact passes, explicit storage preflight, live SQLite
  page caps, content-addressed checkpoint receipts, no-replace promotion, and
  atomic links/renames. A storage or parser failure must discard provisional
  output.
- Resolve and reopen only canonical non-symlink paths within a private work
  root. POSIX ownership/write checks and Windows reparse/path-identity checks
  reduce pathname replacement risk. Windows ACL ownership and directory-fsync
  durability still require an operator-reviewed private workspace; same-user
  hostile processes remain outside this offline job's threat model.
- Re-hash terminal exact states after closing readers. Family construction must
  replay every checkpoint chain and validate exact table layouts before
  reading evidence.
- Enumerate learner engine candidates before analysis. Final graph construction
  must reproduce that inventory, require one matching Stockfish proof per
  candidate, reject unused/additional proof identity, and emit a separate
  eligible-source-edge inventory.
- Bind Stockfish executable/NNUE/settings hashes, Scid input/report identity,
  puzzle source receipt, family association, proof inventory, family promotion
  index, app manifest, and readiness receipt to one release ID.
- Never ship Stockfish, Scid oracle content, raw corpora, cache databases,
  credentials, personal PGNs, or synthetic fixture evidence.

The current workspace has no complete compact-v3 exact corpus handoff, family
promotion index, real engine/Scid campaign, promoted puzzle shard, production
readiness receipt, or production artifact. Safe pipeline code does not turn
missing evidence into a pass.

## Family-training and puzzle state boundary

- Manifest-first loading verifies family, release, side, pack, root, ECO,
  path-membership, and content-address ownership before exposing totals.
- Stable card, cursor, completion, and generation identities are pack-scoped.
  Full-family generation and pack-binding records are append-only and
  idempotent; collision with different content fails.
- Failed cursor/completion writes remain queued, block advancement, and require
  an explicit accessible retry. Transfer replaces a complete validated memory
  snapshot only after staging succeeds.
- The hosted family adapter sends strict versioned records only to same-origin
  `/v1/family-training/*` endpoints, retains failed records in memory, and
  retries immutable identities. Server memory and PostgreSQL adapters validate
  membership, idempotency, monotonic same-cycle cursor progress, and bounded
  pagination; migration 006 enables and forces RLS on the three family-journal
  tables.
- Portable JSON combines opening, puzzle, and family state only when the active
  family repository supports complete snapshot/replace. Partial family exports
  are rejected rather than presented as a complete portable bundle.
- Cross-pack named-branch state uses immutable generation and pack-cycle
  bindings. Reload reconstruction requires one exact manifest-backed scope and
  fails closed when full-family and named-branch interpretations overlap. The
  contract still requires provider-backed staging before release.
- Puzzle resources validate the complete shard and each record, reject
  duplicate identities, replay all moves legally, and keep progress separate
  from opening recall. No real shard may be enabled without exact proof and
  promotion receipts.

## Connected-service boundary

- Validate every versioned request before business logic and cap bodies,
  collections, imports, events, pagination, tokens, and concurrent jobs.
- Use parameterized SQL and one request transaction with
  `SET LOCAL app.user_id`. Protected tables carry `user_id`, enable and force
  RLS, and are owned by a role the application cannot use or bypass.
- Derive schedules server-side from append-only idempotent review events. Do
  not trust client mastery, intervals, tenant IDs, object keys, timestamps,
  cursors, optimistic versions, or release identity.
- Protect sessions with `__Host-`, Secure, HttpOnly, SameSite=Lax cookies,
  rotation after auth changes, Origin/CSRF checks, recent-auth gates, and
  generic magic-link responses. Magic links and shares are random, hashed,
  single-use/revocable, and time-bounded as specified.
- Freeze the WebAuthn RP ID before enrollment. Keep email, passkey, session,
  OAuth, provider token, and key material out of application JavaScript,
  browser storage, logs, analytics, and exports.
- Lichess OAuth uses PKCE S256, exact HTTPS redirects, cryptographic state, no
  requested scopes, encrypted server-side tokens, bounded ascending NDJSON,
  cursor overlap/deduplication, transactional aggregation, global
  serialization, and a minimum 60-second wait after HTTP 429.
- Prevent SSRF with closed source allowlists, DNS/IP validation, redirect
  revalidation, response byte/time caps, and no user-selected server fetch URL.
- Apply edge/user/IP limits. If Redis cannot safely provide a distributed
  limit, costly mutations return 503; the service must not guess.
- Use KMS/Secrets Manager or equivalent adapters, redacted operational logs,
  workload identity, signed containers/builds, SBOMs, provenance attestations,
  encrypted backups, point-in-time recovery, and exercised restores.

Local mocks cannot establish live PostgreSQL RLS under pooled non-owner
connections, WebAuthn, email, Lichess, Redis, object storage, KMS, batch/jobs,
WAF, Artifact storage, account deletion, backup, or restore behavior. Accounts
and cloud sync remain feature-flagged off in the public static build until the
entire staging campaign passes on a genuinely no-cost host.

## Supply-chain and release boundary

- Dependencies and actions are pinned; CI permissions remain minimal and
  public-runner jobs are bounded by the zero-spend policy.
- Required exact-source automation includes strict type checks, unit/component
  and adversarial suites, per-file critical coverage, SAST/CodeQL, production
  dependency and license scans, secret scanning, CycloneDX SBOM, container and
  IaC scans, CSP/artifact/hosting audits, signed-build verification, and the full
  browser matrix.
- The GitHub CodeQL check on the current pushed commit is authoritative. A
  narrative about an older run, fixed finding, or local scan cannot substitute
  for a clean required check on the release source.
- Evidence files are content-addressed and candidate-bound. The release runner
  rejects missing attachments, absolute/escaping paths, duplicate receipt
  paths, digest mismatch, source-snapshot mismatch, stale candidate hashes, and
  `not_run` or failed hard gates.
- `dist/linerecall.html` and `dist/SHIPPABLE.json` are promoted atomically only
  after all automated and manual gates pass. GitHub Pages deployment is
  disabled because it cannot satisfy the required response-header contract.

## Hard security blockers

1. Complete real compact-v3 broadcast/Q2, Stockfish, Scid, family, and puzzle
   promotion receipts do not exist.
2. Current exact-source automated security, supply-chain, browser, coverage,
   artifact, hosting, and signed-build campaigns have not been asserted here.
3. Independent review of the exact client, API, auth, authorization,
   cryptography, data pipeline, deployment, and recovery source is `not_run`.
4. Provider-backed pooled RLS, auth/OAuth, rate-limit failure, job recovery,
   export/deletion, backup, and restore staging is incomplete.
5. The cloud family-journal source path exists, but provider-backed pooled
   non-owner PostgreSQL staging is incomplete; a supported Artifact
   family-journal adapter and named-branch reload recovery are also incomplete.
6. Manual accessibility, localization/editorial/visual, privacy, trademark,
   age, sharing/moderation, license, and legal reviews remain release blockers.
7. No unresolved high or critical production finding, unapproved license,
   secret, quarantined drill edge, or data discrepancy may remain at release.

AWS and OCI/OpenTofu configurations remain unapplied references. The no-spend
constraint forbids paid security services or infrastructure unless the owner
makes a new written decision. Local source controls and engineering evidence
support a qualified release review; they do not replace it.

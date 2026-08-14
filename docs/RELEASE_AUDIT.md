# LineRecall evidence-complete release audit

Current decision: **not shippable**. No production artifact is approved, and
`dist/linerecall.html` and `dist/SHIPPABLE.json` are absent. This document is an
engineering status record, not an ADA, WCAG, Section 508, privacy, license,
trademark, or security certification.

## Evidence discipline

No automated pass, test count, coverage percentage, browser result, artifact
hash, performance result, or security finding is asserted for the current
working tree in this document. Generated records are valid only for the exact
candidate bytes, source snapshot, configuration, and data receipts named in
those records. A source or documentation change makes an earlier result
historical; editing its narrative cannot make it current.

The current workspace has only a blocked compact-v3 foundation audit under
`data/generated/v3`. It has no family-promotion index, production app manifest,
production-data readiness receipt, promoted tactical shard, or production
artifact. Older candidates and generated audit files may remain as diagnostic
evidence, but none approves the current source.

The repository tracks `not_run` templates under
`audit/templates/evidence/`. They describe required work without claiming a
review occurred. `npm run audit:init-evidence` copies missing templates to the
ignored `audit/evidence/` workspace and never overwrites an existing record.
Qualified reviewers complete records there against one exact hardened
candidate. `npm run release:evidence-receipts -- --write` then archives the
referenced reports by digest and binds completed records to that candidate; it
refuses stale completed evidence. Templates remain `not_run`, while generated
and reviewer evidence remains uncommitted.

`npm run release:audit -- --report-only` may be used to enumerate blockers. A
report-only run deliberately records automated gates as `not_run`, cannot
promote a release, and must leave production outputs absent.

## Source foundations present

The following implementation boundaries exist in source. This list describes
code and schemas, not a passing release campaign:

- Repertoire uses a canonical family catalog; Explore keeps individual ECO
  taxonomy rows. The generated review catalog assigns all 3,790 taxonomy rows
  to 149 primary families. Caro–Kann owns 110 review rows, Sicilian Defence
  388, and Ruy Lopez 234. These are taxonomy/navigation counts, not graph,
  path, sample, or opening-value results.
- The compact-v3 pipeline has bounded candidate and exact passes,
  content-addressed archive receipts, storage preflight, immutable checkpoints,
  and a fail-closed exact-state handoff.
- The family data layer can derive all empirical learner-edge candidates from
  exact states, run a receipt-bound Stockfish campaign, rebuild graphs from the
  same inventory, create eligible-source-edge inventories, run a stratified
  Scid campaign, and assemble fail-closed promotion/readiness inputs.
- Runtime family loading is manifest-first and checks release, family, side,
  pack, root, ECO, path membership, and content-address identity before it
  exposes totals or training.
- Full-family training uses pack-scoped cursors and append-only generation and
  pack-binding events. It can partition more than 1,000 paths without dropping
  the authoritative due set and can continue between manifest-owned packs.
- Named-branch practice can traverse primary and secondary memberships across
  same-side packs. Exact generation-bound pack cursors and manifest memberships
  reconstruct a unique saved branch after remount; an ambiguous full-family or
  overlapping-branch interpretation fails closed rather than guessing.
- The Progress interface can export and atomically replace a versioned portable
  bundle containing opening progress, puzzle progress, and the complete family
  journal when its active repository supports snapshot/replace. Session memory
  implements that transfer boundary.
- The hosted client and connected service implement family-journal sync with
  retryable in-memory queues, strict versioned API contracts, memory and
  PostgreSQL adapters, forced-RLS migration, append-only completion/cycle
  events, and membership-bound cursor snapshots. This has not been exercised
  against a real non-owner PostgreSQL staging deployment.
- The tactical runtime has explicit loading, empty, stale, offline,
  rate-limited, corrupt, error, disabled, and ready states, legal replay,
  separate progress, and no opening-recall fallback.
- The connected service includes a Lichess worker consumer and local service
  boundaries for auth, sync, RLS, jobs, provider rate limits, export, and
  deletion. None has provider-backed production approval.

Fixture suites exist for these contracts, including synthetic family graphs,
engine/Scid evidence, puzzle promotion, board transitions, and production
handoff construction. Those fixtures are deliberately marked synthetic. They
are not corpus results, do not establish an opening's value or depth, and can
never be promoted as release data.

## Data status

### Approved source identities

- Taxonomy: `lichess-org/chess-openings` commit
  `17ee660257de02870636f36248e919f2e01d8e85`, CC0-1.0; 3,790 rows and all
  500 ECO codes.
- Broadcast source: 78 official Lichess broadcast archives through June 2026,
  CC BY-SA 4.0.
- Club cohort: all April–June 2026 Lichess Standard-rated archives, CC0;
  267,333,507 published games and 87,256,474,116 compressed bytes.
- Puzzle source: official Lichess puzzle export, CC0. The approved local source
  receipt records 302,111,223 bytes and SHA-256
  `5503bfaf5534518ffe3c4c3bb0ac1ae82350d117ad1a52947796096b75e6247e`.
- Verification tools: Stockfish 18, GPL-3.0-only, and pinned Scid ECO data,
  GPL-2.0-only, both offline audit tools whose binaries/data do not ship.

The older schema-v2 broadcast diagnostic recorded 1,146,297 records seen,
800,176 accepted, 346,121 rejected, and zero duplicates. It targeted a shallow
taxonomy-era graph. These values are historical diagnostics only; they are not
compact-v3 totals, not Q2 results, and not a production backtest.

The complete compact-v3 broadcast replay and the full Q2 candidate/exact passes
have not produced final receipts. Therefore there are no release-valid
accepted, rejected, deduplicated, edge, sample, path, depth, rating-band, or
time-control totals to report. No number is estimated to fill that gap.

## Data promotion chain

Production content must pass this exact order:

1. Complete and reconcile the broadcast and Q2 compact-v3 exact states.
2. Create the immutable exact-family handoff.
3. Enumerate every reachable empirical learner candidate edge with `N >= 500`.
4. Run Stockfish 18 at the pinned settings for every candidate edge.
5. Rebuild family graphs from the unchanged exact states and proof inventory.
6. Prove graph drill-edge equality with each eligible-source-edge inventory.
7. Run the stratified Scid cross-check and quarantine conflicting content.
8. Ingest, verify, and promote the linked puzzle subset and per-node proofs.
9. Build and audit the family promotion index.
10. Build the production app manifest and production-data readiness receipt.
11. Run all current automated and manual release gates against exact bytes.

The builders fail rather than truncate eligible branches at configured node,
edge, or path safety limits. `N = 100–499` continuations may be visible as
exploratory evidence but are not audited book drill moves. Every eligible
branch remains available; ranking changes order, not visibility. Paths end only
at an evidence terminal, a quarantined/insufficient continuation, or the
absolute ply-100 cap, which must be labeled `depth_capped` when theory could
continue.

The Caro–Kann release regression requires one audited Black family graph across
B10–B19, at least eight drillable paths, the Advance, Exchange, Panov,
Classical, and Two Knights families, and at least one validated Core path with
ten learner decisions. No real promoted Caro–Kann graph currently exists, so no
Core, path-count, depth, or value claim is permitted.

## Hard release blockers

1. **Complete corpora.** The full compact-v3 broadcast and April–June 2026
   Standard candidate/exact passes, digest verification, accounting, resource
   benchmark, and final receipts are incomplete. Safe storage caps prove only
   that a run can fail closed; they do not prove zero-spend capacity or
   completion time.
2. **Family evidence and verification.** No real engine-candidate inventory,
   Stockfish campaign, rebuilt family graph, eligible-edge reconciliation,
   stratified Scid report, or family-promotion index has been promoted.
3. **Puzzles.** The source archive receipt is approved, but production
   ingestion requires complete exact corpora, a release-matched family
   association database, and a real Stockfish campaign. No real candidate
   manifest, proof inventory, promoted shard, or puzzle-promotion receipt
   exists.
4. **Current automated release evidence.** Type checks, unit/component suites,
   the full browser matrix, axe attachments, coverage, performance, offline,
   CSP/artifact, dependency, license, secret, SBOM, CodeQL, and signed-build
   checks must be rerun against the final source and candidate. This document
   does not claim those runs have passed.
5. **Persistence and connected staging.** The cloud family journal and portable
   session-memory bundle are implemented source boundaries, but the supported
   Artifact family-journal adapter is absent and the cloud path has no live
   staging evidence. Append-only review sync, account/auth flows, pooled
   non-owner RLS, Redis, object storage, email, passkeys, OAuth, quotas, failure
   recovery, export/deletion, backup, and restore still require live staging.
   The cross-pack named-branch reload contract is implemented through durable
   generation bindings and fail-closed manifest reconstruction, but it has no
   provider-backed staging evidence yet.
6. **Accessibility.** Qualified NVDA with Chrome and Firefox, VoiceOver with
   Safari on a physical iPhone, TalkBack with Chrome on a physical Android
   device, keyboard, actual zoom, contrast, forced-colors, touch, RTL, and
   announcement evidence remains `not_run`.
7. **Localization, editorial, and visual review.** All seven locale catalogs,
   Arabic RTL, primary product copy, screenshots, responsive layouts, and
   animation baselines require identified human reviewers and exact-candidate
   records.
8. **Security review.** Automated checks do not replace an independent review
   of the exact source/candidate or provider-backed auth, authorization,
   cryptography, deployment, recovery, and abuse boundaries.
9. **Legal approval.** Trademark, accessibility representations, privacy,
   terms, age handling, sharing/moderation, licenses, and subprocessors require
   qualified review. Chess.com-specific functionality remains disabled.

## No-production and no-spend posture

- Review candidates may exist under `build/candidate`; they are never labeled
  production.
- `dist/linerecall.html`, `dist/SHIPPABLE.json`, Pages deployment, production
  accounts, and cloud sync remain disabled.
- GitHub Actions may run bounded fixtures and audits on standard no-cost public
  runners. It does not run the 87.2 GB Q2 ingestion or the full engine campaign.
- AWS and OCI/OpenTofu are unapplied reference configurations. Local validation
  or mocks do not constitute deployment or staging.
- No paid runner, storage, database, compute, API, or host is authorized. A
  billing event of one dollar or more is a stop condition without a new written
  owner decision.

`npm run open` verifies a released artifact and refuses while gates fail.
`npm run open:dev` starts the source application on loopback.
`open-linerecall.ps1 -Candidate` opens a review candidate only when that status
is requested explicitly. None of these paths may bypass a failed release gate.

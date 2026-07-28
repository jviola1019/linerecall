# LineRecall unified-family release audit

Current status: **not shippable**. This document records engineering evidence,
not an ADA, WCAG, Section 508, privacy, license, trademark, or security
certification.

The last retained exact-byte candidate evidence in this document was generated
on 2026-07-20 at 3,433,826 bytes with SHA-256
`e13d4fe0d3180a1409dacbec6e454a56791f456ed8f8ac28662c5bcc1fe06507`.
Its exact-byte artifact audit passes the self-contained, size, offline, CSP,
document, and embedded-snapshot checks. It remains historical review-only
evidence. A later working-tree candidate is not covered by that hash or those
results unless its own generated audit records match its exact bytes.

`dist/linerecall.html` and `dist/SHIPPABLE.json` remain absent. The complete
schema-v3 corpus, production graph, Stockfish/Scid campaign, tactical-puzzle
promotion, connected staging, manual assistive-technology review, localization
review, independent security review, and legal approval have not passed.

The automated evidence below applies only to the final source tree and
candidate hash recorded by the generated audit manifests. Reports bound to
older bytes remain historical evidence and cannot be relabeled as current. The
final report-only release audit is expected to fail closed and must confirm
that no production output exists.

## Source changes after the recorded candidate

The current source tree is ahead of the 2026-07-20 candidate and its retained
evidence. These changes have not been promoted or published:

- Repertoire now uses a validated review catalog with one entry per canonical
  opening family. The generated catalog contains 149 primary families and
  assigns each of the 3,790 taxonomy rows exactly once.
- Caro–Kann (110 rows), Sicilian Defence (388 rows), and Ruy Lopez (234 rows)
  each appear once and own both available learner-side tabs. These are taxonomy
  counts, not audited path totals.
- Family detail and training use hash routes. A promoted graph can advance
  autonomously across every manifest-owned pack and unfinished path for one
  learner side, preserve due cards beyond the bounded 1,000-path session batch,
  admit a legal alternate graph path, and record idempotent family completion
  events.
- Family and side totals are accepted only after every referenced pack passes
  release, root, ECO, and exact path-membership ownership checks. Branch names
  and hierarchy come from the family manifest rather than free-text graph
  labels. Duplicate reviewed labels collapse visually without deleting any
  path.
- A rejected completion write blocks local completion and the next-pack
  transition and exposes an accessible retry. Cursor write/restore boundaries
  are versioned, but durable provider-backed integration still needs staging.
- Puzzles now has a separate nine-state tactical resource and separate,
  idempotent progress. Without a promoted shard it shows an unavailable state;
  it does not substitute opening recall.
- Focused regressions cover family-card uniqueness, side tabs, family and
  training deep links, browser history, mobile-first catalog ordering, and
  tactical-route isolation.

The implementation is documented in
`docs/OPENING_FAMILY_ARCHITECTURE.md`. Because these source changes postdate the
candidate, every old source digest, browser result, screenshot, performance
measurement, coverage report, security review, and manual record must be
regenerated or explicitly revalidated against new candidate bytes. The
historical results below cannot approve this source tree.

## Product and interface in the recorded candidate

- Distinct **Today**, **Repertoire**, **Puzzles**, **Explore**, and
  **Progress** destinations, plus an on-demand **Data & Licenses** view.
- Board-first responsive layouts: desktop rail/board/context panel and mobile
  header, viewport-sized board, status strip, thumb navigation, and accessible
  bottom-sheet evidence.
- Continuous line walks with inferred Good/Hard/Again grades. Six clean moves
  require six chess inputs and no grade-button confirmations; optional manual
  pacing remains available.
- Exact-position book/transposition handling, legal alternatives, unsupported
  deviation correction, and no arbitrary repertoire switching or FEN snapback.
- Search across all 500 ECO codes by name, ECO, SAN/UCI sequence, or bounded
  pasted PGN.
- Pinned Chessnut SVG pieces plus an original movement guide with a source
  ring, route, destination bracket, semantic marker, distinct stroke patterns,
  labels, and textual equivalents. Meaning never relies on color alone.
- Click-click, Pointer Events drag/drop, keyboard roving focus, Enter/Space,
  legal-target announcements, and a non-spatial legal-move picker, all backed
  by `chess.js` legality.
- Opening-recall puzzle sessions and personal board annotations are separate
  from opening mastery. They are visibly identified as repertoire-derived
  positions, not falsely represented as the unprocessed Lichess puzzle corpus.
- Dark/light themes, reduced motion, forced colors, 320 CSS-pixel reflow,
  44-by-44 non-spatial targets, local system typography, and no
  remote images, fonts, telemetry, analytics, or runtime data API.
- Deterministic 160 ms CSS view motion. The draft native View Transition API
  is intentionally not used because current WebKit can expose it while leaving
  an input-blocking transition unresolved.

## Audited embedded data

The source/license manifest predates ingestion and keeps program licensing
separate from CC BY-SA-derived statistics.

- Taxonomy: pinned `lichess-org/chess-openings` commit
  `17ee660257de02870636f36248e919f2e01d8e85`, CC0-1.0; 3,790 rows across
  all 500 ECO codes.
- Broadcast backtest: all 78 official Lichess broadcast archives through June
  2026, CC BY-SA 4.0; 1,146,297 records seen, 800,176 accepted, zero
  duplicates, and 346,121 rejected.
- Exact rejection totals: 19,698 malformed PGNs; 188,097 invalid White
  ratings; 86,372 invalid results; 40,491 invalid Black ratings; 10,523
  non-Standard variants; and 940 non-initial positions. These totals sum to
  346,121 and accepted plus rejected equals records seen.
- Current snapshot: 7,824 normalized positions, 792 taxonomy terminal lines at
  `N>=500`, 1,155 trained-side variants, 1,141 drillable variants, 14
  quarantined variants, 500 checksum-protected ECO partitions, and 751 shared
  evidence shards.
- The current local workspace retains the read-only schema-v2 graph at
  `data/generated/v2/evidence-graph.sqlite` (18,733,826,048 bytes). It is
  ignored, is not committed to the public repository, and is not a
  production-v3 input or release artifact.

These broadcast values are not relabeled as club-player results. The existing
snapshot's Stockfish/Scid metadata remains auditable for that snapshot only;
it cannot clear the planned deeper-pack verification campaign.

The embedded app manifest is `linerecall-app-wire-v2`. The production-data
gate now requires a digest-bound `linerecall-app-wire-v3` manifest whose policy
retains every eligible audited practice branch and has no fixed branch cap.
Therefore the current snapshot is categorically review-only even if its legacy
checks pass; it cannot be promoted by editing manual evidence records.

## Historical 2026-07-20 automated engineering evidence

- Offline-client, hosted-client, and connected-server TypeScript checks pass.
  The source-tree digest is generated after every source or documentation
  change rather than copied into this self-referential document.
- Tests pass: 72 client/component, 105 data/verification, 102 chess/domain, 41
  security-boundary, 7 hosted-client, and 159 connected-server cases.
- Browser matrix: Chromium passes 36 of 36; Firefox passes 32 with four
  intentional Chromium-only capability skips; WebKit passes 32 with the same
  four skips. All three final reports have zero unexpected and zero flaky
  cases. A pre-fix WebKit run exposed a real deferred-download race; the final
  implementation retains the temporary export anchor and object URL for a
  bounded interval, and repeated plus full export/import flows pass in every
  engine.
- Thirteen axe scans per browser cover the five primary destinations, Data &
  Licenses, training, light mode, reduced motion, forced colors, move feedback,
  and the mobile statistics dialog. Each engine reports zero violations. Each
  also reports zero moderate findings and retains 10 serious-impact
  `color-contrast` incomplete results covering 342 nodes. Those incomplete
  results are not passes and remain part of the manual
  accessibility/contrast blocker.
- Critical client/domain coverage passes for all 11 required modules at 93.21%
  aggregate branch and 97.92% aggregate function coverage. Overall merged
  runtime coverage is 82.22% branch, 88.79% function, and 91.28% line. All 23
  security-critical server modules meet the per-file 90% branch and function
  thresholds; connected-server aggregate branch coverage is 94.44%.
- At 4x mobile CPU throttling, the interactive shell is 506.9 ms, first
  contentful paint is 1,108 ms, and CLS is 0.000071. Sampled uncached ECO loads
  are at most 155.1 ms in Chromium, 244 ms in Firefox, and 271 ms in WebKit.
  Move-feedback p95 is 17 ms, 32 ms, and 34 ms respectively. Strict evidence
  validation has a 28.28 ms median.
- Automated security outputs cover 101 source/config files and 358
  secret-scanned files, report no recognized credential and no high or critical
  production dependency vulnerability, allowlist 734 dependency packages, and
  produce an 808-component CycloneDX 1.5 SBOM.
- The exact artifact is 3,433,826 bytes and passes all six artifact checks.
  Offline browsing, drills, included review-only opening positions, statistics,
  session-only behavior, progress export/import, and corrupt-import rejection
  pass against the same candidate in all three browsers.
- Each browser report retains 23 review-only PNG attachments covering routes,
  themes, viewports, training, annotations, deviations, and the 50% piece-glide
  frame. Human visual approval has not been performed and remains a blocker.
- The generated immutable route, security headers, CSP, MIME, cache policy, and
  artifact checksum are regenerated and audited together before the final
  report-only release gate.

These are local automated engineering results, not independent penetration
testing, provider-backed staging, legal certification, localization approval,
or manual accessibility evidence.

## Connected implementation status

The repository contains a deployable React hosted client, Fastify API,
PostgreSQL migrations with forced RLS, Redis/S3/KMS/SES/AWS Batch adapters,
Better Auth configuration, append-only review-event scheduling, immutable
repertoire revisions and shares, account export/deletion boundaries, durable
`pg-boss` import jobs, and provider-neutral OpenTofu modules.

The Lichess connection implements no-scope PKCE S256, exact redirect/state
validation, encrypted server-side tokens, revocation behavior, a mandatory
60-second 429 cooldown, and a bounded NDJSON parser that retains anonymized
opening aggregates through ply 30. A dedicated durable worker now consumes the
scheduled aggregation/cursor jobs with heartbeat, cancellation, retry, and
dead-letter behavior. This has passed local automated tests only; connected-game
analytics are not deployed or represented as production-ready.

## Hard release blockers

1. **Q2 club cohort:** the approved April-June 2026 Lichess Standard corpus is
   87,256,474,116 compressed bytes and 267,333,507 published games. It has not
   been fully processed. The compact-v3 adapter can now stream each exact
   approved archive separately for both passes without retaining source files,
   but no real remote pass or approved complete-broadcast resource benchmark
   has run. Output capacity, runtime, totals, and recommendations remain
   unverified.
2. **Production graph and embedded contract:** no complete schema-v3 readiness
   receipt or `linerecall-app-wire-v3` embedded manifest exists. The current
   shallow/top-three-era v2 snapshot is explicitly rejected for production.
   No promoted v3 Caro-Kann B10-B19 graph exists, so there is no auditable
   real-corpus path count, named-family count, or completion total. Synthetic
   graph fixtures prove autonomous traversal mechanics only. The review
   candidate must not claim or display an "all Caro-Kann variations" count,
   and the Caro-Kann Core label remains blocked. The 149-family review catalog
   is not a substitute for this graph or for source-edge inventory equality.
   The dedicated `release:family-promotion` audit is currently blocked because
   `data/generated/v3/family-promotion-index.json` does not exist. Consequently
   it has validated zero promotable families, packs, paths, eligible edges,
   puzzle shards, and puzzles. Those zeros are an absent-input result, not an
   opening-content statistic.
3. **Puzzle verification:** the downloaded Lichess puzzle archive is
   302,111,223 bytes with locally computed SHA-256
   `5503bfaf5534518ffe3c4c3bb0ac1ae82350d117ad1a52947796096b75e6247e`,
   ETag `"6a44d6af-1201d9f7"`, and Last-Modified
   `Wed, 01 Jul 2026 08:58:23 GMT`. The local receipt was approved by the
   workspace owner on 2026-07-15 and is bound to the exact source and filter
   manifest. Tactical-shard publication remains prohibited because the complete
   compact v3 association graph and per-learner-node Stockfish 18 campaign do
   not exist. The source Puzzles route therefore remains explicitly unavailable.
4. **New verification campaign:** deeper Core-pack Stockfish 18 analysis and
   the stratified Scid audit have not completed against the compact schema-v3
   graph.
5. **Connected operations:** the dedicated Lichess worker, renewable heartbeat,
   cancellation, retry/dead-letter handling, and cursor runner are implemented
   and covered locally. Provider-backed staging has not exercised PostgreSQL/RLS
   pooling, Redis failure, SES magic links, passkeys, OAuth, S3/KMS, Batch/jobs,
   Artifact storage, quotas, migrations, account deletion, backups, or restore.
6. **Infrastructure validation:** the OpenTofu CLI is unavailable locally, so
   the reference infrastructure has not passed `tofu validate` or deployment.
7. **Manual accessibility:** qualified NVDA/Chrome/Firefox,
   VoiceOver/Safari/iOS, TalkBack/Chrome/Android, actual zoom, contrast,
   forced-colors, touch, RTL, and complete keyboard evidence is `not_run`.
8. **Legal/product approval:** trademark, accessibility representations,
   application/data licenses, privacy/terms, age handling, sharing/moderation,
   subprocessors, and seven production locales have not received qualified
   approval. Chess.com functionality remains disabled.

## No-production and no-spend posture

- `dist/linerecall.html`, `dist/SHIPPABLE.json`, GitHub Pages deployment,
  production accounts, and cloud sync remain disabled.
- The public GitHub repository may use standard no-cost runners for bounded
  fixtures, static checks, audits, and candidate bundles only.
- The full Q2 ingestion and engine campaign do not run in GitHub Actions. No
  paid runner, paid object store, paid database, paid compute, metered API, or
  connected production host is authorized.
- AWS and OCI modules remain unapplied reference infrastructure. Local server
  tests do not constitute a production deployment.
- A billing event of one dollar or more is a stop condition unless the owner
  makes a new written decision.

## Fail-closed launcher behavior

- `npm run open` verifies a released artifact and manifest; it refuses while
  release gates fail.
- `npm run open:dev` starts Vite on loopback for development.
- `./open-linerecall.ps1 -Candidate` opens the review candidate explicitly.

No launcher bypasses a failed release gate or labels the candidate production.
The next work is the Q2 ingestion, approved puzzle pipeline, new Stockfish/Scid
campaign, provider-backed worker and connected-staging exercise,
physical/manual accessibility campaign, localization review, independent
security assessment, and qualified legal sign-off.

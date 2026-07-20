# LineRecall release gates

`npm run release:audit` is fail-closed. It removes any prior release HTML and
shippable marker, builds/hardens/audits `build/candidate/linerecall.html`, reads
every required evidence record, and atomically promotes the audited bytes to
`dist/linerecall.html` with `dist/SHIPPABLE.json` only when all gates pass. A
failed run retains the candidate and audit report but leaves both release files
absent.

The authoritative configuration is `config/release-gates.json`; the generated
report is `audit/generated/release-gate.json`, whose contract is
`audit/schemas/release-audit.schema.json`. Source evidence records share the
schema-v2 contract in `audit/schemas/evidence-record.schema.json`; the release
runner additionally enforces the pass preconditions and every receipt digest at
runtime. `--report-only` deliberately records all automated checks as
`not_run` and can never mark a release.

## Automated hard gates

1. TypeScript strict typecheck.
2. A self-contained candidate build (never directly into `dist`).
3. Dedicated instrumented component/UI suite merged conservatively by source
   with the separately measured critical-domain suite. Generated embedded data
   (`src/generated/`) is excluded; all authored runtime source remains in scope.
4. Data and domain tests.
5. A separate production-data contract that requires schema v3, both complete
   corpora, exact two-pass reconciliation through the adaptive ply-100 ceiling,
   all eligible audited practice branches, Stockfish/Scid/puzzle receipts, and
   a digest-bound `linerecall-app-wire-v3` manifest. The historical v2 snapshot
   and any top-three-only selector are categorically review-only.
6. Verbose release-snapshot and compact app-snapshot validation.
7. Candidate CSP injection and exact inline hash verification.
8. A checksum-bound, provider-neutral hosting manifest and audit of exact
   response CSP, anti-framing, MIME, referrer, permissions, HTTPS, and cache
   policies.
9. Playwright browser E2E against the hardened candidate; the browser evidence
   record names retained JSON/HTML/trace output and binds its result to the exact
   candidate SHA-256.
10. Runtime-source policy, credential, production vulnerability, and license
   scans.
11. CycloneDX SBOM generation.
12. Coverage of at least 80% for statements, functions, and branches overall,
   plus at least 90% branch and function coverage in each critical board,
   board-transition, repertoire-graph, deviation, SRS, training-session, and
   persistence module. Connected-server coverage is also checked per file for
   security, auth, provider, sync, scheduling, and storage code; a passing
   aggregate percentage cannot mask an under-tested critical module.
13. Candidate single-file, offline, CSP, document-basics, and 10 MiB checks.

## Required recorded evidence

The evidence templates begin at `not_run`; they must never be changed to `pass`
without dated evidence references, an identified reviewer, and the exact SHA-256
of `build/candidate/linerecall.html`. Evidence for older candidate bytes is a
hard failure and cannot be reused. Every `evidence[]` entry must be an existing
workspace-relative, immutable content-addressed receipt with its own SHA-256.
The release runner verifies the receipt bytes, rejects duplicate paths, and
rejects missing files, digest mismatches, absolute paths, parent traversal, and
paths outside the workspace, so a mutable report or narrative assertion cannot
stand in for retained evidence. `sourcePath` is traceability metadata; the
content-addressed `path` and digest are the release inputs.
A recorded `fail` is likewise dated, reviewed, candidate-bound, and backed by
retained evidence. A `not_run` record keeps its completion, reviewer, and hash
fields null and its `evidence[]` empty; planning fields do not count as results.

Before manual review, run `npm run build:candidate`, `npm run artifact:harden`,
and `npm run artifact:audit`, then record the resulting hardened-candidate hash
in every evidence file. After the exact reports are final and reviewed,
`npm run release:evidence-receipts -- --write` copies them into SHA-256-addressed
receipt directories and upgrades/validates the records; the command refuses to
refresh completed evidence for different candidate bytes. A dry run without
`--write` detects drift. The full audit rebuilds and hardens the candidate from
the same pinned inputs; reproducibility is enforced because any hash difference
invalidates all recorded evidence.

- Browser E2E: required viewports, zoom, mouse/touch/keyboard, all async states,
  offline behavior, focus restoration, and adversarial cases. Record A-E tab
  semantics, bounded active-volume rendering, and reachability/searchability of
  all 500 ECO codes. Record that movable board source squares reserve touch drag
  while non-draggable squares retain vertical pan/pinch, and retain every
  browser-specific touch skip.
- Manual accessibility: NVDA/Chrome/Firefox, VoiceOver/Safari/iOS,
  TalkBack/Android, forced colors, reduced motion, reflow, text spacing,
  contrast incompletes, physical touch pan/drag, actual zoom, and keyboard-only.
  This record remains a hard blocker until completed by qualified reviewers.
- Performance: controlled device/profile measurements for interaction,
  partition load, move-feedback p95, CLS, and final bytes. Store shell/FCP/CLS,
  detailed startup phases, and full-data readiness separately; startup/full-
  ready observations remain visible even when only the defined hard thresholds
  determine pass/fail.
- Persistence and sync: exact-candidate session-memory and JSON transfer,
  pre-hydration mutation protection, scoped streak maps, save warnings, and no
  `localStorage`/IndexedDB access; plus staging cloud and supported Artifact
  storage create/read/update, append-only replay, multi-device ordering,
  migration, quota/rejection/outage behavior, export, and deletion. Local mocks
  are not a substitute for those provider-backed staging cases.
- Manual security: OWASP client-side/adversarial review and real-browser CSP
  confirmation.
- Legal/trademark: qualified review of the provisional LineRecall name,
  licensing representation, WCAG/Section 508/ADA language, support/remediation
  obligations, and release jurisdiction. This record remains a hard blocker
  until a qualified reviewer completes it.

Automated axe reporting must distinguish `violations` from `incomplete`. A pass
requires no serious/critical violations and no serious/critical non-contrast
incompletes. `color-contrast` incompletes remain attached and unresolved until
covered by explicit computed measurements and manual review; a forced-colors
run may disable authored-color analysis only when it retains a separate
computed forced-color probe. Never summarize that state as "zero findings."

Passing engineering evidence is not ADA certification, a legal opinion, or a
guarantee that every user can access the product. Public conformance language
requires qualified review and a maintained feedback/remediation process.

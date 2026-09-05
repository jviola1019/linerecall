# Implementation checkpoint — September 4, 2026

Status: review-only. No real family graph or tactical puzzle shard is promoted.
The public source branch is not a product release. Pages and connected accounts
remain disabled; no paid service is required by this checkpoint.

## Changes and evidence boundaries

- Repertoire keeps a single entry per proposed family. Ready family rows expose
  direct White/Black practice actions; a corrupt or unavailable summary cannot
  be overridden by an older ready resource.
- Training distinguishes moves played, variations practiced, and recall.
  Reveal requires a correction, infers Again for a due move, and schedules its
  repeat. A hint infers Hard. Warm-up moves do not create reviews.
- Same-family progression retains all selected paths and the authoritative due
  set across the 1,000-path batch boundary. The synthetic playthrough suite
  exercises 149 identifiers and 1,192 fixture paths, not 149 real repertoires.
- Duplicate labels at the same hierarchy level select all their routes. Older
  saved branch subsets keep their original obligations. Completion events are
  saved before completed cursor snapshots; restore replays an event if a crash
  interrupted the later cursor write. Truly ambiguous legacy scopes still
  fail visibly rather than guessing which branches the learner selected.
- Tactical puzzle validation binds source, campaign, learner-node proof, shard
  bytes, and family membership. The engine runner processes bounded candidate
  subsets, not the complete downloaded puzzle database in memory.
- Empty puzzle and storage states no longer imply that unavailable training
  or cloud sign-in can be used.
- Tactical board guides say “Solution move,” not “Book move.” A solved tactic
  is not evidence that the move belongs to an opening repertoire.
- The catalog start request survives delayed graph loading and a failed
  transport retry. An unloaded graph is not treated as a completed family.
  Mobile catalog controls retain 44 px targets and fit above navigation at
  320 CSS pixels. These checks use synthetic, checksum-validated resources.
- Browser training screenshots have source-tree and served-file hashes,
  release ID, viewport, theme, and a synthetic-review label. Incomplete axe
  findings remain in the report; automated checks are not manual approval.
- Fastify and both transitive fast-uri versions were updated to patched locked
  releases. The dependency audit, server build, tests, and coverage were rerun.
- Coverage runs serialize Node test files to limit concurrent memory pressure.
  This does not lower the ingestion requirement of 8 GiB available memory or
  its 10 GiB free-disk reserve.
- The per-file 90% coverage gate now includes the family registry, startup
  summary, and durable family journal. A previous pass over the smaller file
  list does not satisfy this expanded family gate.
- Public-runner CI checks synthetic family and puzzle playthroughs in Chromium,
  alongside real PostgreSQL/Redis integration checks. Neither replaces
  production-data validation, connected staging, or assistive-technology review.
- September 5 follow-up: real PostgreSQL 18 testing exposed missing schema
  access for the share resolver owner. Migration `007` grants scoped read
  access and fixes the resolver search path; CI verifies tenant isolation,
  pooled reuse, exact-token lookup, and Redis coordination. The server
  per-file gate now covers 25 modules, including family journal and tactical
  record validators (100% and 95% branch coverage respectively in local tests).
- The September 5 CodeQL scan found two high-severity filesystem-race alerts
  in audit input reads. The follow-up removes the path-check/reopen pattern,
  uses one validated descriptor, and adds replacement, linked-ancestor,
  byte-limit, and POSIX FIFO regression tests. A new remote scan must confirm
  the fix; the earlier failed scan is not an approval.
- Linux browser evidence also caught an overflowing synthetic warning and
  crowded mobile navigation labels at 320 px. Both now reflow without hiding
  text. Board visual reconciliation runs before paint so a rapid reset is
  committed before the next frame's move; a throttled repeated-reset test
  checks both orientations. These fixtures still prove behavior, not real
  opening or tactical quality.

## Local benchmark preparation

All 78 provisional benchmark plans were generated in
`build/data-readiness/compact-v31-plans` from the exact authorized proposal and
observation. Their ingestion-code SHA-256 is
`50cb55f7b85a852995c2e277b54f9e8807d1941e18f2c5c8ac621d82239454bd`.
Approval records remain separate from the executable dependency closure, so a
control-record review does not itself invalidate an unchanged parser benchmark.

Preflight returned the documented exit code **2** with `insufficient-memory`:
4,380,258,304 available bytes against the 8 GiB minimum. The conservative disk
assessment left 83,915,988,992 bytes at peak, above the reserve. No archive was
opened or processed. The readiness report still records 13 blockers; generating
plans is not a benchmark pass or an authorization for Q2 processing.

## Remaining critical path

1. Extend the v3.1 exact projection with reconstructable legal positions,
   position reach, source/cohort/month, trained-side and disjoint rating-band
   outcomes. Preserve canonical totals separately from overlapping sub-bands.
2. Connect the streamed PGN archive adapter and external-merge output to a
   read-only graph evidence reader. The proposed reader interface is not an
   implemented adapter. The present eligibility handoff rejects multi-cell
   inputs and more than 1,000,000 exact rows; those limits must not truncate a
   real corpus or silently turn eligible families into study-only entries.
3. Complete and independently reconcile two clean 78-archive benchmarks, then
   the approved Q2 passes. Do not run either under the memory preflight floor.
   Keep the v2 evidence database unchanged until reconciliation succeeds.
4. Finish the human family ledger and bind every emitted family/side to exact
   source inventories. The majority gate cannot be satisfied by copied fixture
   paths, hand-authored counts, or a synthetic release identifier.
5. Run real Stockfish, Scid, and puzzle campaigns; build and validate every
   retained branch through its evidence-defined terminal. No engine forecast
   may pad a short empirical line.
6. Run connected dependency integration and staging, then qualified
   accessibility, editorial/locale, legal/privacy/trademark, security, and
   recovery reviews on the exact release inputs.

The data reproduction runbook and family-graph document describe the current
v3 predecessor separately from v3.1. A v3.1 receipt cannot be passed to the
SQLite builder as though the two formats were interchangeable.

## Re-run commands

Use the locked dependencies. All output below stays local and review-only.

```powershell
npm run typecheck
npm run test:coverage:domain
npm run test:coverage -- --maxWorkers=1
npm run release:coverage
npm run server:coverage
npm run server:critical-coverage
npm run hosted:test -- --maxWorkers=1
npm run security:dependencies
npm run security:licenses
npm run security:secrets
npm run editorial:copy
npm run localization:audit
npm run build:review
npm run artifact:harden
npm run artifact:audit
npm run test:e2e:review
npm run data:evidence-v31-production-audit
npm run release:audit -- --report-only
```

Freeze source edits while `test:e2e:review` runs. Changed source or served bytes
invalidate that browser receipt. The ordinary candidate browser suite cannot
prove training with unpromoted data; its browse/offline/security checks and the
synthetic training suite must be reported separately.

Machine reports belong in `audit/generated`, not in human-review records.
`release:audit -- --report-only` records automated gates as not run and is
expected to fail while production evidence is absent. It is not a replacement
for a passing full release run. No command here creates an approval, changes
pending reviewer fields, or authorizes `dist/linerecall.html`.

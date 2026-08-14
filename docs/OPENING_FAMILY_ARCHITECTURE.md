# Unified opening-family architecture

Status: the source contracts, loaders, family routes, trainer boundary, and
synthetic fixture suites exist. No current test pass is asserted here. No real
family graph or tactical shard is approved for production.

## Product boundary

Repertoire and Explore serve different purposes:

- **Repertoire** has one entry per canonical opening family. Both learner sides,
  named branches, transpositions, promoted paths, linked tactics, and family
  completion belong inside that entry.
- **Explore** retains every individual ECO taxonomy row for reference and
  ECO/name/SAN/UCI/PGN search.

A secondary family link may help discovery, but it cannot create another
Repertoire card. A taxonomy row must have exactly one primary owner.

## Review-family catalog

`scripts/build/generate-review-family-catalog.ts` builds
`src/generated/review-family-catalog.json` from the pinned taxonomy and legacy
review snapshot. The catalog is a navigation and ownership index. It does not
contain a promoted position graph, path totals, branch coverage, or a claim
about the end of opening theory.

The current generated catalog records:

| Measurement | Review value |
| --- | ---: |
| Primary families | 149 |
| Assigned taxonomy rows | 3,790 |
| Caro–Kann rows | 110 |
| Sicilian Defence rows | 388 |
| Ruy Lopez rows | 234 |

All three regression families have both White and Black review-side records.
Their legacy row lengths and counts remain diagnostic only. In particular, the
review catalog cannot supply an “all variations” total or qualify a family as
Core.

Candidate names are derived at build time from the pinned
`Opening family: Variation` convention and a reviewed override registry.
Overrides cover aliases, renamed systems, ambiguous headings, and the required
Caro–Kann, Sicilian Defence, and Ruy Lopez ECO ownership ranges. Runtime code
never splits display text to recover a family.

Build validation fails when:

- a taxonomy row has no primary family or more than one primary family;
- family IDs or primary path ownership are duplicated;
- an alias is unsafe or collides ambiguously;
- branch parent links contain a cycle;
- Caro–Kann does not own B10–B19, Sicilian Defence B20–B99, or Ruy Lopez
  C60–C99; or
- a checksum reference, release ID, or content-addressed path crosses release
  boundaries.

## Versioned contracts

`src/domain/opening-family.ts` is the canonical runtime boundary.

- `OpeningFamilyManifestV1` binds a family, aliases, ECO ownership, taxonomy
  rows, side-specific packs, branch hierarchy, path memberships, puzzle shards,
  provenance, and release ID.
- `FamilyPackRefV1` points one learner side to a content-addressed graph shard.
- `FamilyBranchV1` provides a reviewed hierarchy without deriving structure
  from display text.
- `FamilyPathMembershipV1` gives each path one primary branch and optional
  secondary discovery links.
- `FamilyTrainingCursorV1` preserves the authoritative due-card set, reviewed
  cards, completed and pending paths, batch index, family, side, release, and
  coverage cycle.
- `FamilyCoverageEventV1` records one append-only path completion.

The smaller `ReviewOpeningFamilyCatalogV1` is deliberately separate. It makes
the family browser useful while every real graph remains unpromoted, but each
entry says `graphStatus: not-promoted`.

`OpeningDataSource` exposes content-addressed operations for the production
boundary:

```text
loadFamilyCatalog()
loadFamilyManifest(familyId)
loadRepertoirePack(packRef)
loadPuzzleShard(shardRef)
```

The embedded schema-v2 adapter fails closed for those operations. It does not
convert a shallow legacy line into a family graph.

## Compact-v3 construction handoff

Production family resources are not inferred from the review catalog. The v3
builder starts at a reviewed legal EPD root and a strict family/side pack spec,
then opens only a content-addressed exact-state handoff for the complete
broadcast and Q2 corpora. It replays checkpoint chains, validates terminal
SQLite hashes and table layouts, and reads the states without mutation.

The pre-engine pass enumerates every reachable empirical learner edge with
`N >= 500` through ply 100. A release-bound Stockfish campaign produces one
proof for every candidate edge. Final graph construction re-runs the empirical
traversal and rejects missing, additional, stale, or mismatched proofs. It emits
the graph and a separate eligible-source-edge inventory; promotion requires
exact equality. `N = 100–499` evidence may remain visible as exploratory but is
not drillable. Hard work limits abort output rather than hiding a tail of
eligible paths.

After graph construction, the Scid campaign samples the promoted principal
lines and records discrepancies/quarantine decisions. Puzzle promotion binds
its own verified records and Stockfish proofs to the same release. Only the
family-promotion index, production app manifest, and production-readiness
receipt may hand these resources to the shipped application. Builders for this
chain exist, but the corresponding production outputs do not.

The promoted runtime resource is manifest-first. One family resource contains
the validated `OpeningFamilyManifestV1` plus a graph resource for every
`FamilyPackRefV1`. A learner side may own more than one pack. The family view
does not select a graph by side alone, discard later packs, or derive ownership
from a graph's display labels.

Before exposing totals or training, runtime validation checks the family and
release IDs, canonical catalog identity, pack ID, learner side, root position,
ECO ownership, and exact equality between manifest path memberships and graph
paths. An extra, missing, corrupt, cross-release, or wrongly owned pack fails
closed. Catalog and family totals are aggregated only when every referenced
pack needed for that scope is ready.

The manifest is also the sole syllabus authority. `FamilyBranchV1` and
`FamilyPathMembershipV1` supply the displayed branch names and hierarchy;
legacy `RepertoirePath.familyTags` cannot rename or reassign a promoted path.
Equal reviewed branch labels collapse into one visible syllabus row with a
route count, while every distinct path ID remains selectable and trainable.

## Routes and screen ownership

The application uses hash routes so deep links work in a hosted app and a
downloaded single HTML file:

```text
#/today
#/repertoire
#/repertoire/:familyId
#/train/:familyId/:side
#/puzzles
#/explore
#/progress
#/data
```

Family IDs accept only the strict canonical identifier syntax. A malformed or
unknown route falls back safely; an unknown family never loads arbitrary
content. Browser Back, Forward, and reload restore route state without
duplicating a family.

The mobile Repertoire view puts family search, side filters, results, and a
primary family action before technical notices. Large catalogs and path lists
render in bounded pages rather than placing an unbounded tree in the DOM.

## Autonomous coverage cycle

Training starts from one promoted family and one learner side:

1. Validate and retain every manifest-owned pack for the selected side.
2. Capture the authoritative due-card set and build an ordered path queue
   without a top-N branch cutoff.
3. Traverse the selected path by legal graph edges.
4. Infer Good for first-try book recall, Hard after a hint or accepted playable
   alternative, and Again after an error or reveal.
5. Persist the first completion of the path once.
6. Show a short, non-blocking completion cue and start the next unfinished
   path.
7. When a pack is complete, continue with the next unfinished pack.
8. Finish only when every eligible path in every pack for the selected side is
   complete.

The family controller sends only a pack's own stable due-card IDs to that pack.
Its cursor namespace includes the pack ID in addition to release, family, and
learner side. This prevents two same-side packs from overwriting one another on
save or restoring the wrong graph after a remount.

Pack-local cursor ordinals are not treated as a family clock. An append-only
family generation explicitly binds each pack to its own coverage-cycle ID, so
one generation may validly contain pack A cycle 7 and pack B cycle 2. Restore
matches completion events through that binding map. Starting a new family cycle
first records a new empty generation; no pack binding or completion leaks in
from the prior generation.

An unbound pack never resumes an unrelated historical cursor. Its prior cursor
is retained for audit, the next pack-local ordinal is selected, and that new
cycle is bound to the active family generation before training begins. If a
process stops after the generation start is saved but before its first pack
binding, restore completes that pending start automatically.

Full-family, named-variation, and single-path runs are distinct. A named
variation contains every manifest path with that primary branch membership;
duplicate display names do not merge different branch IDs or delete routes.
Only a full-family run automatically starts the next pack. A branch-specific
run ends after its assigned routes. Its path events remain in the append-only
history, but they do not inflate the active full-family generation counter
unless their pack cycle is explicitly bound to that generation.

Leaving a bound full-family run for the path chooser preserves its cursor.
Choosing **Start full repertoire** from there is an explicit fresh start: the
controller appends a new family generation before binding a new pack-local
cycle, so the prior binding is never overwritten.

Ranking affects order, not visibility. A 1,000-path in-memory session guard
partitions larger families into bounded batches while keeping the authoritative
due-card set intact. A starvation guard ensures later and less common eligible
paths are not permanently skipped.

An alternate audited move transfers the run only when its legal edge reaches a
known graph node with a real continuation. The new path joins the active
membership, while the original unfinished path remains queued. The board never
snaps back to a predetermined FEN.

Pause, resume, skip-path, pack selection, and manual-pacing controls do not
silently complete a path. Completion events are idempotent, and retries or
remounts cannot increase the count twice. A rejected completion write does not
advance the in-memory count or switch packs; the training view exposes an
accessible error and explicit retry.

Skip remains available at bounded-batch boundaries: the current path is moved
behind all future batches without duplication. Choose variation and Stop drain
the current cursor write queue before clearing or navigating. A failed drain
keeps the board and session visible until the user retries.

## Persistence boundary

Family completion and chess-card scheduling remain separate concerns.
`FamilyCoverageEventV1` is append-only; normal SM-2 review events continue to
derive card schedules. The source includes an in-memory family journal,
versioned cursor save/restore boundaries, append-only family-generation and
pack-binding events, serialized retryable cursor writes, and a strict portable
journal snapshot/replace capability for repositories that support transfer.
The application-level portable JSON bundle atomically combines opening
progress, puzzle progress, and that complete family-journal snapshot. Import
validates and stages every section before replacement and attempts to restore
the prior state if a later write fails.

The hosted client supplies a `CloudFamilyTrainingJournalRepository` backed by
versioned `/v1/family-training/*` endpoints. The memory and PostgreSQL server
adapters enforce append-only event identity, logical completion deduplication,
pack membership, monotonic same-cycle cursor progress, and bounded pagination.
The cloud client retains validated failed writes in memory and retries the same
immutable event or mutation identity when connectivity returns. Server account
export includes the stored family events and cursors; the hosted pending-event
download includes unsynchronized family records.

Those source boundaries are not provider-backed release evidence. The cloud
adapter does not implement portable snapshot replacement, a supported Claude
Artifact family-journal adapter is not present, and pooled non-owner PostgreSQL,
outage, quota, export/deletion, and recovery behavior still require real
staging.

Full-family and named-branch restore use the same durable generation boundary.
Starting a named branch creates a new generation ordinal and stages its first
exact pack-cycle binding before that generation becomes authoritative. Each
later pack is bound to the same generation. On reload, LineRecall loads only
the cursors named by those bindings and compares each cursor's complete path
universe with the release-matched manifest memberships. Exactly one branch
must explain the saved cursors. Full-family/branch ambiguity, overlapping
branch matches, missing cursors, or paths outside the promoted graph fail
closed. Append-only completion events restore `{packId, pathId}` keys, so
remounts preserve the count without double counting and the first unfinished
pack resumes automatically. A focused single-path study does not create or
rebind a family generation.

Provider-backed recovery evidence is still a release requirement; passing the
memory-repository remount tests proves the deterministic contract, not cloud or
Artifact durability.

No implementation may use `localStorage` or IndexedDB as an undeclared
fallback. An unsupported environment remains session-only and must offer an
honest transfer path before production. The session-memory adapter supplies
the validated portable bundle; a storage adapter that cannot snapshot the
complete journal must make that limitation visible instead of exporting a
partial bundle.

Tactical progress is also separate. Puzzle solves, hints, errors, elapsed time,
and abandonment cannot change opening recall mastery.

## Current release posture

The source architecture is not evidence that production repertoire content
exists. Promotion remains blocked by:

- complete broadcast replay and the full April–June 2026 Standard two-pass
  ingestion;
- exact accepted, rejected, deduplicated, edge-inventory, and cohort
  reconciliation;
- a digest-bound schema-v3 family graph with every eligible edge represented;
- Stockfish 18 checks and the stratified Scid discrepancy review;
- promoted, content-addressed tactical shards;
- current browser, performance, security, offline, and corrupt-shard evidence;
- connected staging and recovery tests;
- qualified manual accessibility, localization, editorial, privacy, trademark,
  license, and legal review.

`npm run release:family-promotion` is the dedicated fail-closed content audit.
It requires a bounded `data/generated/v3/family-promotion-index.json`, exact
content receipts for the family catalog, every manifest, provenance document,
pack graph and eligible-edge inventory, every puzzle shard, and release-bound
broadcast, Q2, exact-evidence reconciliation, Stockfish, Scid, and
puzzle-promotion receipts. The reconciliation receipt must bind the final
exact-pass receipt for both corpora to every eligible-inventory source digest.
It also enforces the `all-eligible-audited` policy with a null maximum branch
count.

That promotion index does not exist in the current workspace. A current audit
must therefore block before validating any family, pack, path, eligible-edge,
puzzle-shard, or puzzle count. If a report renders absent-input counts as zero,
those zeros describe missing promotion input, not the review taxonomy and not
a claim that the opening families contain no paths.

The project has a zero-spend constraint. Public CI may run bounded fixtures and
audits on standard no-cost runners, but it does not process the 87.2 GB Q2
corpus, run the engine campaign, deploy Pages, or enable a connected production
service. `dist/linerecall.html` and `dist/SHIPPABLE.json` remain absent until
every hard gate passes.

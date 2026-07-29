# Unified opening-family architecture

Status: implemented in the current source tree and covered by focused contract,
domain, and component tests. It is newer than the recorded review candidate.
No family graph or tactical shard is approved for production.

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
derive card schedules. The current source includes an in-memory family journal,
versioned cursor save/restore boundaries, serialized retryable cursor writes,
and callback boundaries for durable storage. Artifact, cloud, and validated
JSON family-cursor adapters still require release-grade integration and staging
evidence.

No implementation may use `localStorage` or IndexedDB as an undeclared
fallback. An unsupported environment remains session-only and must offer an
honest transfer path before production.

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

That promotion index does not exist in the current workspace. The generated
promotion report is therefore `blocked`, with zero families, packs, paths,
eligible edges, puzzle shards, or puzzles validated for promotion. Those zeros
describe an absent promotion input, not the review taxonomy and not a claim
that the opening families contain no paths.

The project has a zero-spend constraint. Public CI may run bounded fixtures and
audits on standard no-cost runners, but it does not process the 87.2 GB Q2
corpus, run the engine campaign, deploy Pages, or enable a connected production
service. `dist/linerecall.html` and `dist/SHIPPABLE.json` remain absent until
every hard gate passes.

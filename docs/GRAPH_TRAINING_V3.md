# V3 family graph-training boundary

Status: implemented and tested in the current source tree; not included in the
recorded review-only v2 candidate and not backed by a promoted production graph.

The graph trainer accepts only a `linerecall.repertoire-graph.v1` envelope. It
validates the complete `RepertoireGraphDocument` before creating an adapter,
then requires every learner source position to carry its stable
`{packId}::{positionId}` card identity. A legacy `VerifiedLine`, raw object,
invalid graph, mismatched release state, or family/pack mismatch fails closed.

The family layer above the graph is defined in
`docs/OPENING_FAMILY_ARCHITECTURE.md`. One `OpeningFamilyManifestV1` owns all
side-specific packs and `FamilyPathMembershipV1` records for that opening.
Repertoire renders the family once; Explore remains the row-level taxonomy.
`OpeningFamilyView` requires every manifest-owned pack for the selected side,
aggregates its path totals, and mounts one validated pack boundary at a time.

## Session behavior

- For any fully runtime-validated v3 pack, every audited path declared by that pack is returned by the path catalog. Ranking changes order, not visibility.
- A single session state holds at most 1,000 paths as a memory guard.
  Full-family mode partitions a larger pack into bounded batches and starts the
  next batch automatically. The authoritative due-card set remains attached to
  the family cursor, so the guard never hides an eligible audited path or drops
  later-batch due work.
- A completed path advances to the next queued path without a
  grade-confirmation step. The boundary shows the current pack's path ordinal
  and total/completed/remaining counts. The family layer aggregates completion
  across every pack owned by that side.
- Due cards are partitioned by their stable pack prefix before a pack boundary
  is mounted. Same-side sibling packs therefore cannot reject or accidentally
  review one another's cards.
- Selecting a named manifest variation queues every route assigned to that
  branch. Selecting one route remains available as a narrower action, while
  full-repertoire mode remains the only action that advances automatically
  into another pack.
- Finishing a path records it once and leaves the next unfinished path active.
  A retry, remount, or repeated event cannot increase `completed / total`
  twice.
- Finishing every path in one pack during full-repertoire mode mounts and
  starts the next unfinished manifest-owned pack without another confirmation.
  A rejected completion write leaves that pack active, does not increase the
  family count, and exposes an accessible retry.
- Pause and resume preserve the active node and queue. Skip path advances
  without falsely completing the skipped path, including when the current path
  is the last path in a 1,000-path batch.
- Choose variation and Stop first snapshot the current position and drain the
  serialized cursor queue. If persistence fails, training stays mounted and an
  accessible retry is shown.
- Manual pacing pauses opponent replies and path boundaries behind explicit controls without changing inferred grades, warm-up handling, or failed-card repeats.
- Board state is derived only from the active graph node's normalized EPD.
- Learner and opponent transitions apply declared legal edges. Opponent moves are a separate state transition so the interface can finish the learner animation first.
- An alternate audited book edge selects a path containing that exact edge,
  including a path outside the initial bounded selection. The admitted path is
  added to active membership; the original unfinished path stays queued. A
  proven playable edge is accepted only when its exact resulting node has an
  audited continuation. Neither case returns to a predetermined FEN.
- Incorrect, exploratory, quarantined, unsupported, or continuation-less moves keep the current node and require correction.
- Only due or session-repeat learner cards emit inferred review records. Traversed warm-up positions never reschedule.
- Failed due cards are placed at the session end. A clean repeat removes the card from the repeat queue.
- Root resets occur only at explicit path boundaries.
- Each first graph completion emits a strict
  `linerecall.graph-path-completion.v1` record. `App` converts it to an
  idempotent `FamilyCoverageEventV1` keyed by release, family, pack, path, and
  coverage cycle. This does not alter the legacy `ProgressV1` card schema or
  tactical-puzzle progress.
- Cursor history is keyed by release, family, learner side, and graph pack.
  Two same-side packs cannot overwrite or restore one another's cursor. On a
  remount, idempotent coverage events restore the completed count and select
  the first unfinished pack.
- Family-wide restore uses an explicit append-only generation that maps each
  pack to its pack-local cycle ID. It never assumes same-side packs have equal
  ordinals, and a new generation begins with no inherited pack bindings.

Synthetic fixtures prove that autonomous sessions advance through every
supplied path and manifest-owned pack, preserve due cards beyond 1,000 paths,
admit a legal alternate path without FEN snapback, skip and restore across
bounded batches, isolate same-side pack cursors, refuse to exit before a failed
cursor flush is retried, reject cross-release and wrongly owned resources, and
update completion counts idempotently. They do not establish how many real
Caro–Kann or other opening
paths exist. Those counts may be reported only from a promoted, digest-bound
v3 graph built from the completed corpus and verification campaigns.

The generated review-family catalog contains 149 families and all 3,790
taxonomy rows, but no promoted path inventory. Its counts must never be used as
training-path totals.

## Evidence boundary

Tests use a legal, synthetic two-path transposition fixture whose provenance fields explicitly say `synthetic-fixture-not-production-evidence`. The fixture is not embedded in the app snapshot and is not a substitute for backtesting.

The public artifact must keep this feature disabled until all of the following are available:

1. A promoted compact-v3 graph release built from the completed broadcast and April–June 2026 standard-game passes.
2. Per-edge Stockfish 18 checks and quarantine results.
3. Complete source receipts, exact ingestion totals, provenance references, and the Scid discrepancy audit.
4. A passing family-promotion index proving every content-addressed manifest,
   graph, eligible-edge inventory, provenance file, and puzzle shard belongs to
   the same release. The runtime loader and family route are implemented, but
   no production index exists.
5. Provider-backed staging evidence for the versioned
   `FamilyTrainingCursorV1` and `FamilyCoverageEventV1` repositories,
   deterministic grade corrections, retries, and import/export behavior. The
   in-memory journal and cursor queue are fixture-tested only.
6. Mobile/desktop Playwright animation, accessibility, performance, offline, and corrupt-shard evidence against a real promoted graph.

`GraphTrainingBoundary` is mounted only for a selected family and learner side.
The embedded v2 review data supplies no promoted resource. A caller must
provide a separately runtime-validated v3 envelope; the application never
adapts v2 lines into this contract. Until the gates above pass, the boundary
may show disabled, loading, source-error, and corrupt-data states, but it must
not be presented as released training content.

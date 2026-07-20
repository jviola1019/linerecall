# V3 graph-training boundary

Status: implemented and tested as a runtime/domain boundary; not enabled in the review-only v2 candidate.

The graph trainer accepts only a `linerecall.repertoire-graph.v1` envelope. It validates the complete `RepertoireGraphDocument` before creating an adapter, then requires every learner source position to carry its stable `{packId}::{positionId}` card identity. A legacy `VerifiedLine`, raw object, invalid graph, or mismatched release state fails closed.

## Session behavior

- For any fully runtime-validated v3 pack, every audited path declared by that pack is returned by the path catalog. Ranking changes order, not visibility.
- A single session state holds at most 1,000 paths as a memory guard. Full-repertoire mode partitions a larger pack into bounded batches and starts each next batch automatically, so the guard never hides an eligible audited path.
- A completed path advances to the next queued path without a grade-confirmation step. The interface shows the current path ordinal, total/completed/remaining path counts, and completed/total counts for every named family tag.
- Manual pacing pauses opponent replies and path boundaries behind explicit controls without changing inferred grades, warm-up handling, or failed-card repeats.
- Board state is derived only from the active graph node's normalized EPD.
- Learner and opponent transitions apply declared legal edges. Opponent moves are a separate state transition so the interface can finish the learner animation first.
- An alternate audited book edge selects a path containing that exact edge. A proven playable edge is accepted only when its exact resulting node has an audited continuation. Neither case returns to a predetermined FEN.
- Incorrect, exploratory, quarantined, unsupported, or continuation-less moves keep the current node and require correction.
- Only due or session-repeat learner cards emit inferred review records. Traversed warm-up positions never reschedule.
- Failed due cards are placed at the session end. A clean repeat removes the card from the repeat queue.
- Root resets occur only at explicit path boundaries.
- Each first completion emits a strict `linerecall.graph-path-completion.v1` record keyed by release, pack, and path, with family tags, coverage-cycle ID, and an ISO completion time. `App` exposes this through `onGraphPathCompleted` so a v3 progress repository can persist it without altering the legacy `ProgressV1` card schema.

The synthetic fixture proves that autonomous sessions advance through every
supplied path, cross bounded batches, and update path and family completion
counts. It does not establish how many real Caro-Kann or other opening paths
exist. Those counts may be reported only from a promoted, digest-bound v3 graph
built from the completed corpus and verification campaigns.

## Evidence boundary

Tests use a legal, synthetic two-path transposition fixture whose provenance fields explicitly say `synthetic-fixture-not-production-evidence`. The fixture is not embedded in the app snapshot and is not a substitute for backtesting.

The public artifact must keep this feature disabled until all of the following are available:

1. A promoted compact-v3 graph release built from the completed broadcast and April–June 2026 standard-game passes.
2. Per-edge Stockfish 18 checks and quarantine results.
3. Complete source receipts, exact ingestion totals, provenance references, and the Scid discrepancy audit.
4. A content-addressed graph shard loader connected to the app's repertoire catalog.
5. A production repository behind the exposed v3 review and path-completion callbacks, plus deterministic grade corrections.
6. Mobile/desktop Playwright animation, accessibility, performance, offline, and corrupt-shard evidence against a real promoted graph.

`GraphTrainingBoundary` is mounted in Repertoire, but the embedded v2 candidate supplies an explicit disabled resource. A caller must provide a separately runtime-validated v3 envelope; the application never adapts v2 lines into this contract. Until the gates above pass, the boundary may show disabled, loading, source-error, and corrupt-data states, but it must not be presented as released training content.

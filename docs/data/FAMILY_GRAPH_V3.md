# Compact-v3 family graph handoff

This stage does not make an opening recommendation from a family name. It starts from an exact, legal EPD root and reads the final compact-v3 SQLite states for the approved broadcast and Q2 Standard cohorts. All sample counts, W/D/L values, rating bands, time controls, and outgoing moves are recomputed from those states.

## Trust boundary

The build consumes a content-addressed `CompactExactFamilyGraphHandoffV1`. The reader replays every candidate and exact checkpoint link against the approved source manifests, reconciles publisher totals, verifies the terminal SQLite hash and filesystem identity, checks the adapter metadata and table layout, and opens the database read-only. A failed chain, changed file, malformed outcome, illegal edge, or undeclared cohort stops the build.

Family graph construction has two phases:

1. `build-family-engine-candidates-v3.ts` follows every reachable empirical edge with `N >= 500` through ply 100. It emits the exact learner-position candidate inventory used by the Stockfish campaign. Opponent responses are followed from empirical evidence and are not treated as learner engine recommendations.
2. `build-family-graphs-v3.ts` rereads the exact states, reconstructs the same candidate inventory, and requires one matching Stockfish proof for every learner candidate edge. Sound learner moves and every sampled opponent response become drill edges. `N = 100–499` continuations remain visible as exploratory edges. No top-N branch cutoff is applied.

The graph builder enumerates complete root-to-terminal walks, deduplicates nodes only by exact EPD, preserves proven transpositions, and aborts on cycles or configured node, edge, and path limits. It emits a separate eligible-source-edge inventory. Promotion later requires exact equality between that inventory and the drillable graph edges.

## Commands

The handoff command first replays the complete compact-v3 foundation audit,
then writes a no-replace receipt that directly names every checkpoint and both
terminal SQLite states. It cannot create output from an incomplete corpus.

```powershell
npm run data:family-handoff-v3 -- `
  --release-id <approved-release-id>
```

The graph commands require that immutable handoff plus the reviewed pack build
specifications. They do not download data or run Stockfish themselves. Receipt
paths are project-root relative; the exact SQLite artifacts remain relative to
the compact work directory.

```powershell
npx tsx scripts/data/build-family-engine-candidates-v3.ts `
  --receipt-root . `
  --artifact-root data/generated/v3/corpus `
  --input family-engine-candidate-build-input.json

npx tsx scripts/data/build-family-graphs-v3.ts `
  --receipt-root . `
  --artifact-root data/generated/v3/corpus `
  --output-root data/generated/v3/promotion `
  --input family-graph-build-input.json
```

Content-addressed pack resources are reusable after an interrupted run. The discoverable campaign or graph manifest is written only after both exact SQLite files are closed and re-hashed unchanged.

## Current release status

The synthetic Caro–Kann, Sicilian, and Ruy Lopez fixtures exercise contracts and adversarial behavior only. They are not opening evidence and cannot enter a release. No production path count, sample count, engine result, or Scid result is claimed until the full approved corpora and verification campaigns produce their real immutable receipts.

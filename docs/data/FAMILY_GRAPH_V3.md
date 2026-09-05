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

## Compact-v3.1 family handoff

The v3.1 handoff consumes the two deep-audited production corpus receipts,
the pinned taxonomy inventory, and a fully approved editorial ledger. It
replays every taxonomy move legally, hashes normalized EPD roots, and emits
one immutable edge inventory per family/side plus one content-addressed index.
N>=500 edges are retained as book evidence; N100-499 edges remain explicitly
exploratory. Samples are never pooled across corpora, rating systems, or time
controls. All 149 proposals remain review-bound, while the approved ledger's
canonical family count determines how many final families and side records
remain in the index. A side without a qualifying root is marked study-only
with an evidence-derived no-root or insufficient-sample disposition.

```powershell
npm run data:family-handoff-v31 -- `
  --release-id <approved-release-id> `
  --broadcast-corpus-receipt <receipt.json> `
  --q2-corpus-receipt <receipt.json> `
  --editorial-ledger data/manifests/opening-family-editorial.approved.json
```

The command fails closed on altered receipts, incomplete taxonomy ownership,
ambiguous or cyclic roots, duplicate edge ownership, and roots beyond ply 100.

### v3.1 operational boundary and boundedness

`compact-v31-family-handoff.ts` is an evidence handoff and not the production
graph builder. It streams each receipt-named exact-edge NDJSON partition,
verifies its byte digest while reading, and retains at most
`MAX_HANDOFF_EXACT_EDGE_ROWS` (currently 1,000,000) rows in its bounded
source-edge index. A larger corpus fails closed; it is not loaded wholesale
and is not silently truncated. Each edge uses the maximum valid individual
cohort `N` in its corpus, never a sum across cells or corpora. The handoff
walks every legal eligible continuation reachable from each selected root
through absolute ply 100 and emits the complete reachable edge inventory.
Root hints are assertions about the uniquely selected empirical root and do
not grant eligibility.

The existing `build-family-engine-candidates-v3.ts` and
`build-family-graphs-v3.ts` commands still consume the v3 exact SQLite state
handoff and its reviewed v3 specifications. There is no operational adapter
that bridges the v3.1 streamed NDJSON handoff into those SQLite graph-builder
inputs in this release. Consequently, a v3.1 eligibility index or its
synthetic fixtures is not a production graph, does not authorize Stockfish,
and cannot be presented as connected production ingestion.

The proposed provider-neutral read contract is described in
`scripts/data/family-graph-evidence-reader.ts`. A v3 SQLite implementation
can satisfy it because `family-graph-v3-builder.ts` reads `positions`, `edges`,
and `outcomes` (including source/target EPD, SAN, `cohort_id`, month,
`rating_detail`, `min_ply`, and separate position reach and edge move rows).
The v3.1 projection cannot currently satisfy that contract. Its exact row
schema in `scripts/data/compact-v31-production-contracts.ts` contains only
EPD hashes, UCI, one `sampleSize`, and W/D/L cells keyed by rating system,
time control, and rating band. It has no EPD/SAN or node IDs, no month,
`cohort_id`, rating detail, `min_ply`, position-reach rows, or trained-side
dimension. It therefore cannot produce the graph builder's complete
`EvidenceCohortResult` without inventing reach or cohort data, and no v3.1
adapter is provided.

There is a separate eligibility accounting gap: v3.1 currently defines
`sampleSize` as the maximum rating-cell `N`. A valid source/time-control
cohort may have its canonical rating-band counts spread across cells, while
the `<1800` aggregate can overlap its three beginner sub-bands. A future
projection must carry enough cohort/band detail to sum disjoint canonical
bands (and bind trained side) before applying the 100/500 thresholds; neither
cross-corpus pooling nor the current max-cell shortcut is sufficient evidence.
The v3.1 handoff therefore fails closed on multi-cell edge rows until that
richer projection is available; it does not reinterpret them as complete
cohort totals.

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

# LineRecall data sources and license boundary

This document is part of the release audit. Checked-in machine-readable
manifests are authoritative for revisions, file hashes, and approval scope.

## Current status

The only application snapshot currently embedded is a bounded schema-v2
review fixture. Its historical counts are retained below so earlier work can be
audited, but it is not production repertoire evidence. It was built around
shallow taxonomy rows and a top-three-per-ECO engine selection. Neither that
selection nor its 1,141 drillable variants may be used to claim that the
evidence-complete product exists.

A production release requires a new `linerecall-app-wire-v3` graph built from
the complete broadcast corpus and the complete April-June 2026 Standard cohort,
then checked with a new Stockfish and Scid campaign. The graph must retain every
eligible audited branch, continue each path to its evidence-defined terminal or
the absolute ply-100 safety ceiling, and label a path Core only when it contains
at least ten learner move inputs and the required real opponent branching. No
approved v3 corpus result, graph snapshot, or production-data readiness receipt
exists yet.

Current data blockers are concrete:

- the compact-v3 broadcast benchmark and complete 78-archive replay are not
  approved;
- none of the three Q2 Standard archives has been processed;
- no v3 all-branch graph or `linerecall-app-wire-v3` manifest exists;
- the required Caro-Kann B10-B19 family report has not demonstrated eight
  drillable paths, five named families, and Core paths with ten learner inputs;
- no new per-edge Stockfish campaign or graph-level Scid sample is complete;
  and
- the approved puzzle source receipt has not produced an engine-approved,
  graph-associated release shard.

### Live-source recheck on 2026-08-13

The live upstream pages were rechecked without changing any approved input.
The [opening taxonomy repository](https://github.com/lichess-org/chess-openings)
still documents its `Opening family: Variation` convention and CC0 public-domain
dedication. The [Lichess database](https://database.lichess.org/) now includes a
July 2026 broadcast archive and reports 1,186,335 broadcast games in total.
LineRecall intentionally remains pinned to the approved 78-archive cutoff
through June 2026 and its 1,146,297 historical records; July is outside this
release and cannot enter by a silent manifest refresh.

The upstream totals and license notices were checked again on 2026-08-13. The
July broadcast row remains 40,038 games, so the live broadcast total remains
1,186,335; this does not alter the approved through-June cutoff. The live
puzzle page still reports 6,057,356 puzzles, but now says the export
was updated on 2026-08-02 and documents an additional `DailyDate` column. The
approved LineRecall receipt identifies the earlier 302,111,223-byte artifact
last modified on 2026-07-01. That exact receipt remains the only authorized
input. Adopting the newer upstream bytes or schema requires a new local digest,
bounded-parser review, explicit approval, and a fresh promotion campaign.

## Opening taxonomy

- Source: `lichess-org/chess-openings`
- Commit: `17ee660257de02870636f36248e919f2e01d8e85`
- License: CC0-1.0
- Approved use: download, normalize, transform, embed, and redistribute
- Snapshot scope: 3,790 rows covering all 500 base ECO codes A00-E99

The generated taxonomy retains the source file, row, SHA-256, commit, license,
and pull timestamp even though CC0 does not require attribution.

## Required backtest corpora

### Official broadcasts

- Source: official Lichess broadcast database
- Files: all 78 monthly archives from 2020-01 through 2026-06
- License: CC BY-SA 4.0
- Published corpus total: 1,146,297 games and approximately 670 MB compressed
- Approved use: checksum-verified streaming, filtering, aggregation, and
  redistribution of modified statistics under the same license

All 78 compressed archives are locally available and have been checked against
the approved manifest. The schema-v2 run streamed decompression and wrote no
expanded PGN. It recorded the following **historical schema-v2 totals**:

- Records seen: 1,146,297 (exactly the published corpus total)
- Accepted: 800,176
- Deduplicated: 0
- Rejected: 346,121
  - Missing/invalid White Elo: 188,097
  - Invalid result: 86,372
  - Missing/invalid Black Elo: 40,491
  - Malformed/illegal PGN: 19,698
  - Non-Standard variant: 10,523
  - Non-initial position: 940
- Normalized target positions: 7,824
- Taxonomy terminal lines: 3,790
- Lines meeting the terminal-position `N>=500` drill threshold: 792

The accepted, deduplicated, and rejection counts sum to the records-seen total
for that historical run. `data/generated/backtest-validation.json` is its
authoritative record; its accepted backtest SHA-256 is
`18735afcc4177e2bc60b12a5c5bc1008a0983f93df027c8e2f451c7938bbec3d`.

Schema v3 must replay the full broadcast set through the compact, bounded,
two-pass pipeline and reproduce these totals or document and approve every
difference. Passing fixture tests is not a substitute for that replay. The
existing 18.7 GB schema-v2 SQLite graph remains read-only until reconciliation
passes.

### April-June 2026 Standard-rated games

- Source: official Lichess Standard database
- Files: April, May, and June 2026 archives
- License: CC0-1.0
- Published total: 267,333,507 games
- Compressed bytes: 87,256,474,116
- Rating label: Lichess rating (Glicko-2), never merged with broadcast ratings
- Primary time controls: rated Blitz, Rapid, and Classical Standard games

The exact URLs, published SHA-256 values, byte lengths, per-month totals, and
filters are pinned in
`data/manifests/lichess-standard-q2-2026.source.json`. None of the three
archives is present in the Standard cache, and no complete Q2 aggregation has
run. Compact-v3 can now re-download each candidate/exact pass from the exact
manifest-approved HTTPS URL without retaining the compressed source files, but
no real remote pass or approved complete-broadcast resource benchmark has run.
Whether the cumulative bounded outputs fit while preserving the required 10
GiB reserve therefore remains unproven. Q2 sample counts, W/D/L rates, beginner
bands, and production recommendations remain unavailable. They must not be
inferred from the broadcast cohort or replaced with smaller samples.

Both production cohorts retain raw White/Draw/Black counts, trained-side W/D/L,
reach, conditional usage, score, deterministic 95% interval, time-control
class, and `N`. Canonical bands are `<1800`, `1800-1999`, `2000-2199`,
`2200-2399`, and `2400+`; Q2 may additionally split its own `<1800` cohort into
`<1200`, `1200-1499`, and `1500-1799`. A band with `N=0` says “no games,” and
`N<500` is visibly low-sample. These are descriptive historical outcomes, not
causal performance promises.

LineRecall changes the source data by filtering for explicitly Standard games,
valid results, complete numeric ratings, the initial position, legal movetext,
and duplicates; it then aggregates W/D/L counts by normalized position and
rating band. Those modifications and the source links are disclosed in-app.

## Historical schema-v2 engine audit

- Engine: Stockfish 18
- Release commit: `cb3d4ee9b47d0c5aae855b12379378ea1439675c`
- License: GPL-3.0-only
- Use: checksum-verified offline build audit only
- Configuration: Threads=1, Hash=128 MB, MultiPV=5, 250,000 nodes

The executable and NNUE files are not distributed with LineRecall. The report
retains the executable and exported NNUE SHA-256 values:

- Engine binary:
  `9bde420202717ce083412027fbfb8c5c935b537591d712be8a8a8bae92f6e8d6`
- Big NNUE:
  `c288c895ea924429ea9092e3f36b2b3c1f00f2a3a4c759ff7e57e79e3b43e4a7`
- Small NNUE:
  `37f18f62d772f3107e1d6aaca3898c130c3c86f2ab63e6555fbbca20635a899d`

The historical engine input contains 7,560 trained-side variants. Its
top-three-per-ECO ranking selected 582 source lines / 1,155
trained-side variants, covering 4,500 learner decision nodes. That historical
run made 20,400 logical searches: 1,067 unique engine searches and 19,333
shared-cache reuses. It quarantined two variants. Recorded move evidence totals
are 41,383 book, 3,293 playable, 240 inaccuracy, and 22,627 unverified
deviation. In that review dataset, refuted expected moves remain identified as book moves while their
entire variants are quarantined; they are not relabeled as alternatives.

These searches cannot approve new v3 nodes. Production requires a new exact
Stockfish 18 check at every selected learner node in every eligible retained
branch, with the pinned settings and engine/NNUE identities recorded per edge.

## Historical schema-v2 independent ECO audit

- Oracle: Scid `scid.eco`
- Commit: `8ffd1e3a02b9f61b5616e38b18ce932b904e04ff`
- License: GPL-2.0-only
- Use: deterministic stratified audit sample only

No Scid entry, description, or movetext is copied into the shipped snapshot.
Only LineRecall taxonomy identity plus LineRecall's derived discrepancy
classification, quarantine flag, and audit counts are retained.

For the historical review candidate, the pinned oracle SHA-256 is
`acd73837668a0791aa4d1b174fdfe8b19efa361ac2437b45735b397b0e20c4a7`.
Parsing accepted 10,360 entries and rejected none. The deterministic sample was
250 source lines (50 from each ECO volume A-E): 4 exact matches and 246
nonmatches. The 246 nonmatches comprise 240 naming differences and 6 base-ECO
mismatches; there were no missing entries or ambiguous base codes. The compact
audit blob exposes a 246-entry **derived discrepancy index** containing the
LineRecall line ID, LineRecall ECO/name, derived outcome, and quarantine flag.
It does not expose a Scid name, move, or oracle entry.

The six base-ECO-mismatch entries in that index are source-line records. Each
source line has two trained-side variants, so those six records account for 12
quarantined variants. Naming differences remained usable. With the 2 separate
engine quarantines, the snapshot total is 14 quarantined variants.

## Historical schema-v2 snapshot audit

The review snapshot contains all 3,790 browsable taxonomy lines, 1,155 verified
trained-side variants, 1,141 drillable variants, and 14 quarantined variants in
500 ECO partitions. The 14 comprise two engine-quarantined variants plus both
trained-side variants for six Scid base-ECO-mismatch source lines. Its manifest
SHA-256 is
`3231dfe079930d50cdf80a3e2f94e241521e26800a37761055044c6428560dfc`;
all schema, compressed-checksum, move-legality, W/D/L arithmetic, graph,
quarantine-exclusion, provenance, and search-index gates passed.
Its 500 partitions total 64,251,273 compressed bytes.

The retained compact runtime snapshot is wire version 2 with schema
`linerecall-app-wire-v2`, generated at `2026-07-11T07:29:02.362Z`. It retains
the same 3,790 lines and 1,155 trained-side variants across all 500 ECO codes.
The source evidence universe contains 7,824 normalized positions and 650
engine-evidence positions. Across all hydrated runtime partitions, validation
observed 4,081 distinct referenced position-evidence records and all 650 engine
positions.

Wire-v2 separates catalog, audit, line, and evidence data so an ECO selection
does not inflate the entire evidence store:

- The checksum-protected global search/catalog blob is loaded at startup.
- The checksum-protected global audit blob is loaded lazily for the in-app
  Data & Licenses view. It contains the complete audit, license, corpus,
  engine, discrepancy, and provenance records.
- Each of the 500 checksum-protected ECO partitions contains its line and
  variant graph data, exact per-line provenance, engine metadata, and the IDs
  of the evidence shards it requires.
- The evidence store is split into 751 checksum-protected shared shards. A
  selected ECO loads only its own partition and its declared shards; there is
  no global evidence blob in wire-v2. Exact shard-consumer declarations are
  validated against the partition references.

Across all ECO selections, the referenced-evidence maxima are 18 shards,
56,723 compressed bytes, and 140,030 uncompressed bytes. The complete compact
payload -- global blobs, all partitions, and all shards -- is 1,977,759
compressed bytes, or 2,638,616 estimated embedded-base64 bytes. Its current
global blob SHA-256 values are:

- Search/catalog: `da437d0e8d95ca2935b7c294581c31a5748df11aea63849e4fabb077438324ac`
- Audit/provenance: `0b19d7464d6f65b9fe5e007e47462acc0476391f31d0eb9d6ab147ab46558342`

The wire-v2 compact manifest SHA-256 is
`27d8decd0d02c57fd60a19aa2ff76a66667553f0f3004cbd4d1cdf61c88e23c6`.
`data/generated/app-snapshot/validation-report.json`, validated at
`2026-07-13T18:52:12.233Z`, records `result: pass`. It passed blob checksums,
wire schemas, exact shard-consumer references, selected-ECO evidence locality,
all-partition hydration, exact semantic parity with the verbose audit snapshot,
the artifact data budget, and the under-500-ms engineering partition gate.

The historical engineering benchmark measured every ECO three times and used the maximum of
the per-ECO medians. It includes the selected partition and only its referenced
shards, with in-memory SHA-256, gzip decompression, UTF-8/JSON decoding, Zod
validation, and hydration. It excludes filesystem reads and the separate
verbose-audit parity comparison. The final aggregate release run's all-500,
three-sample maximum median was 119.33 ms. Its slowest ECO was E62, whose
tested load comprised its partition plus 15 shards, 52,996 compressed bytes,
and 146,837 uncompressed bytes; maximum hydration was 107.56 ms. Search loaded
in 40.71 ms and the lazy audit blob in 21.85 ms in that run. The immutable
performance-evidence receipt separately retains the prior passing B77 run at
157.68 ms median and 141.69 ms maximum hydration.

An earlier release-audit attempt exposed a D36 median above the 500 ms limit.
The implementation was corrected by memoizing repeated derivations from the
same immutable evidence objects; checksum, Zod schema, locality, hydration,
and semantic-parity validation remain intact. Two additional strict all-500
validation reruns after the correction observed worst per-run ECO medians of
118.23 ms and 189.97 ms, both below the gate. The failed attempt was retained
as diagnostic history and is not presented as passing evidence.
These schema-v2 timings are regression evidence only. Browser/device
performance and a full v3 shard benchmark remain separate exact-candidate
requirements.

## Puzzle source

- Source: official Lichess puzzle database
- License: CC0-1.0
- Publisher-reported total on 2026-07-05: 6,057,356 puzzles
- Approved local archive: 302,111,223 bytes
- Approved local SHA-256:
  `5503bfaf5534518ffe3c4c3bb0ac1ae82350d117ad1a52947796096b75e6247e`

Lichess does not publish a SHA-256 for the puzzle export. The byte length, URL,
ETag, Last-Modified value, retrieval context, locally computed digest, and
owner approval are recorded separately in
`data/manifests/lichess-puzzles.integrity.json`. That approval permits parsing
this exact archive; it does not approve any puzzle for release.

Production puzzles still require legal FEN/UCI replay, the published selection
filters, exact-position or clearly labeled family association to the completed
v3 graph, and a passing Stockfish check at each learner node. No official
opening-linked puzzle shard has completed those gates, so the existing
review-only tactical fixtures must not be described as the Lichess puzzle
product.

## Board-piece source

The twelve pinned Chessnut SVG pieces by Alexis Luengas come from Lichess commit
`3b7f2811bfb0682932f40688fcfb5d5caf7aece3` and are approved only under the
Apache-2.0 exception identified in the pinned Lichess license notice. Every
file has a fixed byte length and SHA-256 in
`data/manifests/chessnut-pieces.source.json`; static checks reject scripts,
event handlers, external references, `foreignObject`, and unapproved files.
No other Lichess artwork or application code is covered by that approval.

Machine manifests and validation reports remain authoritative if this human
summary ever diverges.

## License separation

Application code and third-party package notices are handled independently
from the opening snapshot. Lichess-derived aggregate statistics and their
provenance remain under CC BY-SA 4.0. Stockfish and Scid are non-shipped audit
tools and do not change the application-code license. Q2 Standard and puzzle
sources remain CC0-1.0; the twelve Chessnut assets retain their pinned
Apache-2.0 notice. These separate boundaries must remain visible in the SBOM,
license bundle, and Data & Licenses interface.

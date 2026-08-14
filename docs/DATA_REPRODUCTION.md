# Reproduce the data pipeline

This is the end-to-end path from the approved source manifests to the compact,
self-contained application snapshot. It is intentionally separate from the
fast application build: a full corpus and engine refresh is expensive, uses
network access, and creates new dated provenance records.

The commands in sections 1-4 reproduce the retained schema-v2 review evidence;
they do not produce the evidence-complete product. Production requires the
compact v3 workflow, the full Q2 cohort, every eligible audited branch, new
Stockfish/Scid results, and the puzzle promotion described later in this file.
No production v3 corpus output is currently approved.

## Prerequisites and boundaries

- Node.js 24 or newer and `npm ci`.
- Enough space for the checksum-verified source selected for a run, all bounded
  spill/output files, and the mandatory 10 GiB free-space reserve. The complete
  broadcast set is approximately 670 MB compressed; the three Q2 Standard
  archives total 87,256,474,116 compressed bytes and are not present locally.
  The pipeline streams Zstandard decompression and never writes expanded PGN.
- Local-file ingestion never downloads. Remote mode downloads only when the
  operator explicitly supplies `--input approved-https`; it accepts only the
  canonical manifest URL and applies the validation, cap, timeout,
  peer-address, digest, and atomic-rollback rules documented below.
- A platform supported by `data/manifests/stockfish-18.source.json`, plus `tar`
  for safe archive listing/extraction.
- Expect the full-corpus aggregation and per-node Stockfish searches at 250,000
  nodes to take substantial CPU time. The historical 20,400-search figure is a
  schema-v2 top-three selection count, not a production-v3 estimate. Do not
  substitute partial data for a release run and do not use paid compute or
  storage under the current zero-spend instruction.

The approved manifests must be reviewed before any download:

- `data/manifests/taxonomy.source.json` - CC0-1.0 taxonomy.
- `data/manifests/broadcasts.source.json` - CC BY-SA 4.0 corpus URLs and SHA-256.
- `data/manifests/lichess-standard-q2-2026.source.json` - CC0-1.0 Q2 cohort.
- `data/manifests/lichess-puzzles.source.json` and its separately approved
  integrity receipt - CC0-1.0 puzzles.
- `data/manifests/chessnut-pieces.source.json` - the twelve pinned Apache-2.0
  Chessnut SVG pieces; this is an application-asset input, not chess evidence.
- `data/manifests/stockfish-18.source.json` - GPL-3.0-only offline audit tool.
- `data/manifests/scid.source.json` - GPL-2.0-only audit oracle.

The Stockfish binary, NNUE networks, Scid source data, and broadcast PGNs are
audit inputs and are not embedded in the application.

## 1. Historical schema-v2 taxonomy and broadcast backtest

Run from the repository root:

```text
npm ci
npm run data:taxonomy
npm run data:broadcasts -- download --manifest data/manifests/broadcasts.source.json --archive-dir .cache/linerecall/broadcasts
npm run data:broadcasts -- aggregate --manifest data/manifests/broadcasts.source.json --targets data/generated/taxonomy/broadcast-targets.v1.json --archive-dir .cache/linerecall/broadcasts --output data/generated/broadcast-backtest.json
npm run data:backtest-verify
```

`download` and `aggregate` are deliberately separate. Both verify the pinned
archive sizes and SHA-256 values; aggregation also verifies the complete
78-archive cutoff and reconciles accepted, rejected, and deduplicated totals.
The optional `--workers 1` through `--workers 32` changes parallelism only.
Never use `--months` for a release because it marks the output incomplete.

## 2. Historical schema-v2 Stockfish verification

Build the ranked engine input, provision the pinned binary, and retain the JSON
paths printed by the provision command:

```text
npm run data:engine-input
npm run data:stockfish-provision
```

Then replace `<stockfish-executable>` and `<stockfish-receipt>` with the exact
paths printed above:

```text
npm run data:engine-analyze -- --input data/generated/engine-input.json --output data/generated/engine-analysis.json --engine <stockfish-executable> --receipt <stockfish-receipt>
```

The analyzer rejects the wrong executable/receipt, exports and verifies the
NNUE hashes, and fixes Threads=1, Hash=128 MB, MultiPV=5, and 250,000 nodes.
`--workers` changes only the number of independent Stockfish processes; it does
not change the per-search configuration.

## 3. Historical schema-v2 Scid cross-check

```text
npm run data:crosscheck-input
npm run data:scid-provision
```

Replace `<scid-eco>` with the exact `ecoPath` printed by provisioning:

```text
npm run data:scid-crosscheck -- --input data/generated/scid-input.json --output data/generated/scid-crosscheck.json --scid-eco <scid-eco> --max 250
```

The default deterministic seed is part of the audit algorithm. A release uses
the full maximum sample of 250, stratified as 50 source lines per ECO volume.

## 4. Historical schema-v2 snapshots

Choose and record one ISO-8601 UTC generation timestamp. Reuse it for the
release snapshot invocation so provenance is internally consistent:

```text
npm run data:release -- --generated-at <ISO-8601-UTC-timestamp>
npm run data:app-snapshot
npm run data:verify
npm run data:app-verify
npm run test:data
```

For this historical workflow, the verbose snapshot is its audit source of
truth. The compact snapshot must
hydrate to the same 3,790 browsable lines, verified/quarantined variants,
engine evidence, provenance, and all 500 ECO partitions. Validation fails on
missing provenance, inconsistent totals, illegal moves, corrupt receipts, or a
quarantined variant entering the drill catalog.

The compact validator measures every ECO three times. Each sample performs the
same in-memory checksum, gzip, UTF-8/JSON, Zod, selected-shard locality, and
hydration work used by the audit model; it also verifies exact semantic parity
against the verbose snapshot. Repeated derivations from the same immutable
evidence object may be memoized, but no checksum, schema, locality, hydration,
or semantic check may be removed to meet the 500 ms gate. A retained schema-v2
run measured all 500 ECOs and reported B77 as the slowest median at 157.68 ms,
with a 141.69 ms maximum hydration phase. Those measurements do not establish
v3 shard or device performance.

## 5. Build the candidate

```text
npm run build:candidate
npm run artifact:harden
npm run hosting:manifest
npm run hosting:audit
npm run artifact:audit
```

`build/candidate/linerecall.html` is an audit candidate, not a public release.
After exact-candidate browser, performance, persistence, security, and other
reviewed reports are final, archive them into immutable content-addressed
evidence receipts:

```text
npm run release:evidence-receipts -- --write
npm run release:evidence-receipts
```

The first command refuses to refresh completed records whose candidate hash is
stale. The second is a dry-run drift check. `schema-v2` here names the version
of the immutable evidence-record envelope, not permission to ship an
`app-wire-v2` data snapshot.

Only `npm run release:audit` can promote identical audited bytes to `dist/`, and
it remains fail-closed while any automated/data gate, exact-candidate evidence,
manual assistive-technology review, or qualified legal/trademark review is
incomplete.

## Reproducibility note

The transformations and selection algorithms are deterministic for identical
approved inputs and recorded timestamps. A fresh engine/cross-check run writes
new analysis and pull timestamps by design, so its byte hashes will differ from
a prior dated snapshot even when all chess results are identical. Preserve the
complete generated reports and receipts for any candidate whose hashes are
used as release evidence; never copy an old hash into a newly generated report.

## Historical schema-v2 connected evidence graph

The previous release snapshot counts only the 7,824 taxonomy positions needed
by its linear trainer. It remains valid evidence for that historical candidate,
but it is not a substitute for the connected product's deeper graph.

The v2 pipeline replays every accepted game through absolute ply 30 and writes
exact legal position and outgoing-move transitions to a bounded SQLite store:

```text
npm run data:foundation-audit -- --verify-local-sha
npm run data:evidence-graph -- broadcast --archive-dir .cache/broadcast/archives
npm run data:evidence-graph -- preflight-standard
npm run data:evidence-graph -- status
npm run data:evidence-graph -- export
```

No command downloads a corpus implicitly. Broadcast archives already present
in the workspace are reverified before replay. The three Standard archives
total 87,256,474,116 compressed bytes and must be acquired separately from the
approved URLs in `data/manifests/lichess-standard-q2-2026.source.json`. Partial
or interrupted archives never become evidence. A rerun deletes contributions
from an incomplete archive before replaying it; completed matching archives are
idempotently skipped.

The historical schema-v2 per-archive shard and monolithic merge implementation
remains prohibited from starting Standard ingestion and has no bypass. The
compact schema-v3 replacement now passes fixture-level storage-fault, recovery,
digest, cap, atomicity, deduplication, and remote-stream tests. Those tests do
not authorize a real evidence run. Production processing still requires an
approved complete-broadcast resource benchmark and capacity plan, followed by
both complete Q2 passes and reconciliation of exact accepted, rejected, and
deduplicated totals.

Evidence ingestion concurrency is fixed at one archive worker. A value above
one is rejected so multiple complete SQLite shards cannot consume local
storage in parallel. This restriction also applies to the completed broadcast
graph and must not be relaxed until the replacement storage design is audited.

The graph keeps evidence cohorts separate. Broadcast ratings are not called
Elo, Lichess ratings are explicitly labeled Glicko-2, and an optional Lichess
beginner detail band never changes or double-counts the canonical `<1800`
band. `unknown` broadcast time controls remain auditable raw evidence but are
not a trainable blitz, rapid, or classical cohort.

Standard-archive ingestion requires Lichess's explicit rated Event speed and
accepts only Blitz, Rapid, or Classical. Its clock fallback follows the
upstream `initial + 40 × increment` ranges pinned during the 2026-07-15 audit
to `lichess-org/scalachess` commit `c75c62e02104b836deb497fe4416387dc230f3e4`:
UltraBullet 0–29 seconds, Bullet 30–179, Blitz 180–479, Rapid 480–1499,
Classical 1500–21599, and Correspondence thereafter. The three excluded speed
classes map to `unknown`; they are never promoted into a trainable cohort.

### Compact schema-v3 foundation

Schema v3 is implemented alongside the historical v2 database; it never opens,
converts, or deletes `data/generated/v2/evidence-graph.sqlite`. It defines an
archive-scoped, two-pass process with complete evidence through absolute ply 30
and candidate-filtered adaptive evidence through absolute ply 100:

1. The candidate pass uses a fixed-memory Count-Min sketch cumulatively across
   every approved archive in a cohort. Once an adaptive position or edge may
   have reached `N=100`, its content hash is retained in a capped SQLite index.
   Sketch collisions may retain extra rows, but cannot authorize a false
   negative; saturation or a candidate cap aborts the pass.
2. Only after every candidate archive has produced the final candidate-set
   receipt does the exact pass replay each verified archive. It retains every
   baseline observation and only retained adaptive candidates, recomputes exact
   raw outcomes, and stores EPDs and edges once behind numeric IDs.
3. Each pass is atomic at archive granularity. Candidate-index writes use an
   archive transaction and the cumulative sketch has a deterministic snapshot.
   An interruption restores the preceding snapshot and replays that archive
   from its start; it never seeks into an unverifiable compressed-stream
   location. Only completed receipts with the approved source byte length,
   SHA-256, and chained candidate-state hashes advance the checkpoint.

Before processing release-candidate evidence, create a strict preflight plan
containing enforced byte caps, a corpus-wide `retainedCorpusMaxBytes` cap, and
an explicitly approved receipt from a complete broadcast replay. Then run:

```text
npm run data:evidence-v3-preflight -- --plan <approved-plan.json> --work-dir <existing-work-directory>
```

The command performs no download and no ingestion. It counts the remaining
corpus-retention budget in addition to transient pass storage. Exit status `0`
means the approved benchmark and both classes of hard cap fit while preserving
at least 10 GiB. Status
`2` is an expected fail-closed result for a pending benchmark or insufficient
capacity. Malformed plans, inaccessible paths, or arithmetic/configuration
errors exit `1`. No override flag exists. Reaching a runtime cap invalidates
the incomplete pass even if preflight previously returned `0`.

The command inventories the existing `work-dir/v3` tree before assessment; it
does not assume retained usage is zero. A `ready` result means enforced caps
prevent the next pass from consuming the reserve. It does **not** prove that
the full Q2 workload fits inside those caps or will complete.

No approved benchmark plan or schema-v3 corpus output is currently committed.
The complete broadcast replay and full Q2 processing remain release blockers;
the contracts and fixture results do not claim otherwise.

Archive-level streaming orchestration is implemented in
`scripts/data/compact-v3-orchestrator.ts`. It consumes a caller-supplied stream
and has no URL or filesystem authority of its own:

- It runs the approved hard-cap/free-reserve preflight before opening an input
  stream. The default free-space probe uses the selected work filesystem, and
  an unsafe assessment fails before parser work begins.
- Before any SQLite or shard pathname is opened, the work root is canonicalized
  and verified as a non-symlink directory. POSIX runs require effective-user
  ownership, reject group/world writes, and reject writable non-sticky parent
  directories. The `v3` and `.adapter-working` directories are created with
  mode `0700` and revalidated. This protected boundary contains SQLite's
  unavoidable pathname reopen; a hostile process running as the same operating
  system user remains outside the offline pipeline threat model.
- The processor must consume a fresh compressed stream from byte zero. SHA-256
  and byte length are measured in that same stream; there is no unverified
  input copy or seek-based resume point.
- Final shard bytes pass through a sink capped by
  `atomicPromotionMaxBytes`. A cap, parser, incomplete-consumption, length, or
  digest failure deletes only the uncommitted partial file.
- Every object already present under the schema-v3 work tree is counted against
  `retainedCorpusMaxBytes`. Preflight reserves the unfilled portion of that
  corpus-wide budget, and promotion computes the exact permanent byte delta
  before it renames a shard, receipt, or checkpoint. A cumulative state cannot
  cross the cap even when each individual pass remains below its own cap.
- A verified shard is linked to a content-addressed path. Its canonical
  receipt is then synced and promoted by its own SHA-256. The validated
  checkpoint is replaced last and is the archive-pass commit marker. Parent
  directories are fsynced after durable links and renames where the filesystem
  supports directory fsync.
- Resume verifies the stored receipt and shard bytes rather than trusting the
  checkpoint JSON alone. An interruption before checkpoint replacement
  replays the archive from byte zero and safely reuses matching immutable
  objects. Candidate and exact passes cannot run out of order.
- A corpus-wide lock under the selected work root enforces the manifest's
  concurrency-one policy across every archive and both passes. A lock owned by
  a live process or another host fails closed; a same-host lock whose process
  no longer exists can be recovered. Approved-HTTPS mode also holds its
  separate host-wide lock so different work roots cannot download in parallel.

The orchestration tests are fixture-only and make no network request:

```text
npm run test:data:v3
```

They cover verified promotion, idempotent resume, candidate-before-exact
ordering, parser failure, partial input consumption, checksum mismatch,
free-space refusal, output hard caps, corruption detection, actual legal PGN
replay, cumulative threshold crossings, exact SQLite outcomes, wrapped
broadcast frames, cross-archive deduplication, rollback on a conflicting game
key, retained-state accounting, and refusal before a promotion would cross the
corpus-wide cap. The current fixture suite also exercises live candidate and
exact SQLite page limits inside transactions, `SQLITE_FULL` rollback, absence
of disposable journal/WAL spill, and refusal to checkpoint after a cap failure.
The bounded Windows run contained 36 passing fixture cases and three
platform-capability skips for POSIX ownership, symlink, and permission checks.
Linux CI must execute those three cases. The run was not bound to a release
source snapshot. Passing these tests does **not** approve a corpus benchmark or
produce release evidence.

The archive adapter is `scripts/data/ingest-compact-v3.ts`. It accepts one
archive and one pass from either an exact local file or the archive's exact
manifest-approved HTTPS URL. The plan must hash the exact approved manifest
bytes, contain an approved benchmark proof, and pass the same 10 GiB reserve
and hard-cap assessment used by the orchestration layer. Generate and retain
the connected source snapshot before a measured run. A local-file run is:

On Windows, Node does not expose a portable ACL-owner check or durable directory
fsync. The adapter still rejects a symlink/junction at the selected root,
canonicalizes the path, validates open-handle identity, uses exclusive
owner-mode file creation, and reports directory fsync as unsupported. Place the
work root on a local NTFS directory whose ACL grants modification only to the
operator and trusted administrators; network shares and broadly writable ACLs
are not approved evidence environments.

```text
npm run security:source-snapshot
npm run data:evidence-v3 -- candidate \
  --plan <archive-plan.json> \
  --manifest <approved-source-manifest.json> \
  --archive <local-checksummed-archive.pgn.zst> \
  --work-dir <existing-v3-work-directory> \
  --source-snapshot-sha256 <treeSha256>
```

Run candidate passes in the manifest's canonical month order. The adapter
copies only the preceding committed candidate state, retains a cumulative
Count-Min snapshot and exact game-key ledger, and chains each state SHA-256 in
the next receipt. An exact pass is refused until every candidate archive in
the approved manifest is committed. Exact passes then run in the same order:

```text
npm run data:evidence-v3 -- exact \
  --plan <archive-plan.json> \
  --manifest <approved-source-manifest.json> \
  --archive <local-checksummed-archive.pgn.zst> \
  --work-dir <existing-v3-work-directory> \
  --source-snapshot-sha256 <treeSha256>
```

To avoid retaining the compressed source corpus, replace the `--archive`
argument with `--input approved-https` for each candidate and exact invocation:

```text
npm run data:evidence-v3-remote -- candidate \
  --plan <archive-plan.json> \
  --manifest <approved-source-manifest.json> \
  --input approved-https \
  --work-dir <existing-v3-work-directory> \
  --source-snapshot-sha256 <treeSha256>
```

Remote mode does not create a source archive or a resumable partial download.
It accepts only the canonical HTTPS URL already present in the approved
manifest, rejects credentials/fragments/custom ports, and revalidates every
redirect against that exact URL. It resolves at most 32 addresses, rejects the
entire result when any address is loopback, private, link-local, reserved,
documentation, multicast, mapped, or otherwise non-public, then pins the TLS
connection to the vetted result and verifies the actual peer address. Response
bytes are capped at the approved manifest length. Connect, idle, and overall
timeouts are bounded; redirects are capped at three; response content
transformation is rejected. When an approved ETag or Last-Modified value exists
in the source manifest, the response must match it.

Each successful pass receipt records requested/final URL, redirect count,
retrieval time, ETag, and Last-Modified alongside the independently verified
compressed byte length and SHA-256. Candidate and exact passes each re-download
from byte zero, and their checkpoint receipts are schema-validated against the
same approved archive identity. A short, long, interrupted, timed-out,
rate-limited, header-mismatched, or digest-mismatched response deletes the
uncommitted staging output and cannot advance the checkpoint. There is no
automatic mid-stream retry. A typed retryable failure (including HTTP 429 and
its `Retry-After` value) requires an explicit rerun from byte zero. The adapter
and plan enforce concurrency one; remote mode additionally holds a fail-closed,
stale-owner-checked host-wide lock so separate work directories cannot download
in parallel.

Candidate and exact outputs are cumulative SQLite states. This makes every
checkpoint independently recoverable and makes cross-archive deduplication
auditable, but also means retained immutable states consume storage. Before a
real broadcast replay, the approved benchmark must measure that retained-state
growth, peak resident memory, temporary bytes, runtime, observations, and
accepted/rejected/deduplicated totals under the exact proposed caps. Every
archive invocation recounts the complete schema-v3 tree, subtracts those bytes
from the corpus-retention allowance, and rechecks current free bytes. Existing
cumulative output therefore cannot be mistaken for free future capacity or
silently consume the 10 GiB reserve.

The adapter now applies SQLite `max_page_count` while each disposable working
copy is being written and disables its on-disk rollback journal. The working
copy can therefore fail with `SQLITE_FULL`, be discarded, and leave no
checkpoint before its declared candidate/exact byte cap is exceeded. Durable
standalone SQLite stores retain normal WAL behavior; only hash-before-promotion
adapter copies use the disposable mode.

The candidate working limit is `candidateIndexMaxBytes`. The exact working
limit is the smaller of `exactWorkMaxBytes` and the combined declared baseline
and adaptive shard caps. SQLite rounds enforcement to complete pages; the
configured limit is therefore translated to a conservative page count rather
than treated as permission to cross the byte ceiling.

Completion feasibility remains unproven. Schema v2 of
`compact_adapter_games` stores the source identifier once, then uses 32-byte
binary game identities and 32-byte binary corruption guards with an integer
first-archive ordinal. Inherited databases with the prior text-ledger layout
are rejected instead of being converted silently. This removes avoidable text
and archive-ID duplication, but every later archive still copies and promotes
the complete preceding cumulative database. In addition, ply 0–30 evidence
deliberately bypasses the candidate sketch because the exact pass must retain
complete baseline aggregates. At 267,333,507 published Q2 games, even the
compact binary ledgers, repeated cumulative snapshots, and the far broader
baseline position set can exceed a plan derived only from the 800,176-game
broadcast corpus. No full-Q2 plan may be described as capacity-approved until
the immutable complete-broadcast benchmark receipt proves conservative
ledger/index/position bounds fit with the 10 GiB reserve. Runtime caps make the
current implementation safe to attempt; they do not prove it can finish.

The benchmark chicken-and-egg is handled by a separate, explicit bootstrap
execution purpose. It accepts only the complete approved 78-archive broadcast
corpus, requires every plan to say `benchmark.status: pending`, requires a
clean dedicated work directory, and uses the same parser, digest, hard caps,
retained-state accounting, and 10 GiB reserve as evidence ingestion:

```text
npm run data:evidence-v3-benchmark -- \
  --run-id broadcast-v3-YYYYMMDD \
  --plans-dir <directory-with-78-broadcast-YYYY-MM.json-plans> \
  --manifest data/manifests/broadcasts.source.json \
  --archives-dir <directory-with-78-approved-local-archives> \
  --work-dir <new-empty-dedicated-benchmark-directory> \
  --source-snapshot-sha256 <treeSha256>
```

The bootstrap may also stream both passes without retaining the 78 inputs by
replacing `--archives-dir ...` with `--input approved-https`. This removes only
compressed-input storage; it does not relax the corpus-wide output cap, 10 GiB
free-space reserve, complete-replay requirement, or provisional status.

The command samples process RSS and filesystem free bytes every 250 ms, records
wall time, exact accepted/rejected/deduplicated and observation totals, retained
bytes, peak additional bytes, and both per-accepted-game byte ratios. Its
content-addressed receipt is permanently marked `benchmark-bootstrap`,
`provisional: true`, `approvalStatus: unapproved`, and
`releaseEligible: false`; every underlying pass receipt carries the same
execution-purpose marker. It cannot be resumed into a seemingly complete
measurement: the work directory must be empty, and a partial run requires a
new directory and run ID. A reviewer may separately approve that exact receipt
hash, after which the full replay must run again in `evidence-candidate` mode.

No bootstrap or real remote corpus pass was run for this repository. The
implemented remote adapter removes the requirement to retain all 87.2 GB of Q2
compressed inputs or the complete broadcast input set at once. It does not
remove compute time, bandwidth, cumulative schema-v3 output storage, reviewed
plan, benchmark-approval, Stockfish, Scid, puzzle, or legal release blockers.
Reviewers must still reconcile a complete broadcast replay with the historical
800,176 accepted-game evidence or document every difference before approval.
Fixture tests exercise the policy and atomic failure paths without making a
network request; they are not corpus evidence.

No schema-v3 family graph has been produced from real corpus output. In
particular, no real Caro-Kann path, family, depth, or completion total is
currently available. Any Caro-Kann graph used by tests is synthetic and must
remain labeled non-production evidence.

The synthetic family fixtures now demonstrate two separate mechanics:
full-family cycles bind distinct pack-local coverage cycles through append-only
`cycle_started` and `pack_bound` events, while named-branch sessions traverse
both primary and secondary memberships across same-side packs. An append-only
family-training journal validates and replays cycle generations, pack bindings,
path-completion events, and versioned cursor snapshots, including the exact
next path after a component remount. The in-memory repository remains
session-only, but its complete snapshot is included in the application's strict
portable JSON bundle. A connected cloud adapter, versioned API, memory server
adapter, PostgreSQL adapter, and forced-RLS migration now implement the same
journal boundary. They have not passed provider-backed, pooled non-owner
PostgreSQL staging, and no supported Artifact family-journal adapter exists.
Cross-pack named-branch membership is recorded through immutable generation
and pack-cycle bindings and is reconstructed only when the saved manifest
membership has one unambiguous interpretation. These fixtures do not establish
source-edge inventory equality, sample eligibility, engine soundness, Scid
agreement, or a real path total.

No schema-v3 command opens, converts, deletes, or cleans the read-only 18.7 GB
schema-v2 database.

On 2026-07-29 the local read-only schema-v2 database was compressed in place
with NTFS filesystem compression to reclaim host storage without changing its
logical contents. Its logical length remained 18,733,826,048 bytes, its
allocated storage was reported as 5,659,254,784 bytes, and its SHA-256 was
unchanged before and after the operation:
`6ecd8d5e39d073e8e00398a52cc5c320af46f9fba1c783f62ac7816b5722456b`.
This host-specific operation is not corpus evidence or a capacity approval.
Windows paging growth consumed part of the reclaimed allocation, so the
10 GiB-reserve preflight remains authoritative and the Q2 run remains blocked.

The deterministic repertoire helpers still preserve this **historical v2
selection contract** for regression tests:

- learner moves require `N>=500`, exact engine evidence, and no more than 50
  centipawns of loss;
- opponent replies require `N>=500`, select at most four branches, and aim for
  85% conditional coverage;
- soundness tier precedes empirical depth, coverage, usage, descriptive score
  lower bound, and stable UCI in the rank;
- a transposition exists only when applying the legal move reaches the exact
  recorded normalized EPD; and
- fewer than six learner decisions or two post-root opponent branches remains
  a Primer rather than being padded with an engine forecast.

Those rules do not govern v3 production selection. V3 retains every eligible
audited branch; ranking controls recommendation and session order only. A
normal path continues until no further sampled, legal, engine-approved book
continuation exists, or until ply 100, which must be labeled `depth_capped`
when a continuation remains. Core requires at least ten learner inputs and the
required real opponent branching; shorter valid paths are Primer and are never
padded with an engine forecast. Stockfish and Scid evidence produced for older
schemas cannot approve v3 nodes. The export remains `releaseEligible: false`
until new graph, engine, and independent-source reports exist.

## Opening-linked puzzle ingestion

Lichess does not publish a SHA-256 for its puzzle export. The exact artifact
identified by `data/manifests/lichess-puzzles.source.json` was acquired, and
`data/manifests/lichess-puzzles.integrity.json` records its separately approved
302,111,223-byte receipt and local SHA-256. To reproduce a changed acquisition,
compute a new pending receipt without self-approving it:

```text
npm run data:puzzles -- integrity
```

A reviewer must compare the byte length, ETag, Last-Modified value, source date,
and computed digest, then explicitly approve that exact receipt. Only then may
the bounded streaming parser run:

```text
npm run data:puzzles -- ingest
```

Ingestion validates the exact ten-column CSV header, bounded UTF-8 lines,
unique IDs, legal FEN/UCI replay, metrics, opening tags, and source URL. It
prefers exact post-setup EPD association and otherwise permits only a unique,
most-specific taxonomy tag. Output candidates are always marked
`engineStatus: pending` and `releaseEligible: false`; no missing Stockfish
result is guessed. Source-game URLs are recorded as provenance and never bulk
fetched.

The approved source digest does not make candidates release-ready. Promotion
also requires the completed v3 graph association and Stockfish proof at every
learner node. Neither exists for an official shipped puzzle subset, so no
current puzzle count may be presented as production content.

The tactical UI review harness uses strictly validated synthetic records to
exercise resource states, special moves, forced replies, and separate progress.
It does not write a promotion receipt and is not part of the source-data
evidence chain. Puzzle promotion remains blocked until the approved source
receipt, exact graph association inventory, per-learner-node engine results,
content-addressed shard digest, and release-source snapshot all reconcile.

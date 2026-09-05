# Data source approval manifests

No data source may be downloaded by an ingestion command until its checked-in
manifest has an `approved` decision, an immutable source revision, an explicit
license, and integrity values. Ingestion fails closed when any declared byte
length, SHA-256 digest, row count, or schema constraint differs.

Each input has a separate approval boundary:

- `taxonomy.source.json` approves the pinned Lichess opening-name taxonomy
  under CC0-1.0.
- `taxonomy.inventory.v1.json` embeds the exact five approved TSV byte streams
  and the 3,790 rows re-derived from them. It binds every stable line ID, ECO,
  name, PGN/UCI move sequence, source row/digest, and mechanical 149-family
  proposal owner. Family promotion replays this derivation and rejects an
  unknown, missing, duplicated, altered, or reassigned candidate row.
- `broadcasts.source.json` approves the exact 78 official monthly broadcast
  archives from 2020-01 through 2026-06 under CC BY-SA 4.0. Derived statistics
  retain attribution, a change notice, and share-alike terms. Its historical
  approval pins publisher digests but not response metadata. Compact-v3 plan
  generation therefore remains blocked until a pending observation hashes all
  78 local archives, a pending manifest proposal binds byte lengths and HTTP
  identity to that receipt, and a named reviewer separately approves the exact
  proposal. The observer and proposal commands never edit or self-approve this
  manifest.
- `stockfish-18.source.json` approves checksum-verified Stockfish 18 for
  build-time analysis under GPL-3.0-only. The executable and NNUE networks are
  not shipped.
- `scid.source.json` approves the pinned `scid.eco` file for independent audit
  use under GPL-2.0-only. Oracle entries are not copied into the snapshot.
- `lichess-standard-q2-2026.source.json` approves the exact April-June 2026
  Standard-rated archives under CC0-1.0. The 87.2 GB source corpus is not
  downloaded implicitly, and its Lichess/Glicko-2 bands remain separate from
  broadcast ratings.
- `lichess-puzzles.source.json` approves the CC0 puzzle source identity and
  filters, but deliberately leaves its SHA-256 null. Lichess publishes no
  digest for that export; `npm run data:puzzles -- integrity` creates a
  pending local receipt that must be reviewed and approved before ingestion.
  `lichess-puzzles.integrity.json` records the separately approved 2026-07-15
  receipt for the current 302,111,223-byte archive. It does not clear the
  compact-v3 graph or Stockfish promotion gates.
- `chessnut-pieces.source.json` approves the pinned Apache-2.0 Chessnut SVG set
  with Alexis Luengas attribution. All twelve local SHA-256 values and byte
  lengths are fixed; only those static-scanned files may enter the application.

Generated records retain their source revisions, checksums, licenses, filters,
and pull or analysis timestamps. A changed URL, revision, checksum, license,
scope, or parser requires a new approval decision.

Additional fail-closed review records are checked in separately from source
approval:

- `compact-v31-benchmark.authorization.json` records the workspace owner's
  2026-08-27 permission to benchmark only the exact pending proposal SHA-256
  `c598...57d5` and observation SHA-256 `043b...d56c`. It explicitly does not
  authorize Q2 ingestion, benchmark-result promotion, or release use.
- `compact-v31-benchmark.limits.json` pins the provisional log-structured
  resource envelope: one archive at a time, at least 8 GiB available memory,
  at most 6 GiB worker RSS, no source staging, and at least 10 GiB free disk
  after declared delta, merge, and final-state bounds.
- `compact-v31/bootstrap-inputs.receipt.json` preserves and hashes the exact
  public proposal and observation bytes named by the benchmark authorization,
  so an authorized plan bundle is reproducible from a clean checkout.
- `compact-v31-production.authorization.json` is a pending production decision,
  not permission. Q2 execution, production replay, promotion, and release are
  all false until two clean broadcast benchmarks compare byte-identically and
  a named reviewer approves the measured bounds and exact corpus inputs. It
  also names the exact broadcast proposal and observation receipts that supply
  byte length and HTTP transport identity missing from the historical approved
  broadcast manifest. Those benchmark inputs are not production approval by
  themselves.
- `compact-v31-q2-adaptive-replay.authorization.json` is the separate pending
  decision for adaptive candidate replay from ply 31 through ply 100. It keeps
  the historical ply-30 source receipt immutable and cannot authorize work until
  a named reviewer approves the expanded filtering scope.
- `opening-family-editorial.proposal.json` is a deterministic review worksheet
  for all 149 mechanically proposed families and all 3,790 primary taxonomy
  rows. Every decision is `pending` and `promotionEligible` is false. It is not
  evidence of human chess, taxonomy, trademark, or localization review.

Schema-v2 evidence is built with `npm run data:evidence-graph`. Its SQLite
store is restart-safe at the archive boundary and retains month, source
cohort, time-control class, canonical rating band, optional Lichess beginner
detail band, raw W/D/L, and exact legal EPD-to-EPD edges through ply 30.

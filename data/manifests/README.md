# Data source approval manifests

No data source may be downloaded by an ingestion command until its checked-in
manifest has an `approved` decision, an immutable source revision, an explicit
license, and integrity values. Ingestion fails closed when any declared byte
length, SHA-256 digest, row count, or schema constraint differs.

Each input has a separate approval boundary:

- `taxonomy.source.json` approves the pinned Lichess opening-name taxonomy
  under CC0-1.0.
- `broadcasts.source.json` approves the exact 78 official monthly broadcast
  archives from 2020-01 through 2026-06 under CC BY-SA 4.0. Derived statistics
  retain attribution, a change notice, and share-alike terms.
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

Schema-v2 evidence is built with `npm run data:evidence-graph`. Its SQLite
store is restart-safe at the archive boundary and retains month, source
cohort, time-control class, canonical rating band, optional Lichess beginner
detail band, raw W/D/L, and exact legal EPD-to-EPD edges through ply 30.

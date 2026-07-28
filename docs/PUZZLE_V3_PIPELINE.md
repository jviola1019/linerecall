# Puzzle v3 pipeline

Status: ingestion, runtime-resource, replay, and progress foundations are
implemented in the current source tree; release data has not been produced.

LineRecall treats the Lichess puzzle export as a separate CC0 source. The pinned
source manifest is `data/manifests/lichess-puzzles.source.json`. The publisher
does not provide a SHA-256, so the workspace owner separately approved the local
receipt in `data/manifests/lichess-puzzles.integrity.json`. Ingestion binds the
receipt to the exact URL, byte length, ETag, Last-Modified value, source date,
selection policy, license, computed digest, and approval identity. A changed
field fails closed and requires a new receipt; the tool cannot approve its own
digest.

## Bounded processing contract

`npm run data:puzzles -- ingest` reads the Zstandard archive as an async byte
stream. The RFC-4180 parser supports escaped quotes and quoted line breaks across
chunk boundaries. It retains at most a 16 KiB record and 8 KiB field, permits at
most ten fields, rejects control characters, and aborts malformed UTF-8. Puzzle
IDs are deduplicated in a temporary SQLite index. Candidates are written through
a bounded gzip stream to a partial file and renamed only after completion.

The filter keeps only records with all of the following:

- at least one valid opening tag;
- a legal Standard-chess FEN and complete legal UCI replay;
- one through five learner decisions;
- at least 100 attempts, popularity at least 80, and rating deviation at most
  100;
- an HTTPS source-game URL on `lichess.org`.

Move zero is replayed as the setup move. Odd solution indexes are learner moves;
following even indexes are forced opponent replies. Each learner node records
its exact FEN, normalized EPD, expected UCI/SAN move, forced reply, and whether
the expected move is mate in one. Exact normalized-EPD association wins. A tag
association is accepted only when the most-specific supplied tag resolves to one
unique taxonomy line; the pipeline does not fall back from an ambiguous specific
tag to a broader label.

## Verification and promotion

Candidates are never release eligible. A promoted record must contain one
matching Stockfish 18 proof per learner node with `Threads=1`, `Hash=128`,
`MultiPV=5`, and 250,000 nodes, plus engine, NNUE, settings, analysis-date, and PV
evidence. All proofs must pass and the puzzle must have an exact-position or
unique-family association. Missing, reordered, failed, or unlinked evidence
fails runtime validation.

The shipped domain replays setup and forced replies rather than changing FENs
out of band. On a mate-in-one node, any legal mating move is accepted. Puzzle
attempts use the versioned `PuzzleProgress` namespace and cannot update opening
recall cards or mastery.

## Runtime product boundary

The Puzzles route is reserved for promoted tactical records. The former
one-move repertoire recall activity is not used as a fallback.
`TacticalPuzzleResource` has nine explicit states:

- `disabled`
- `loading`
- `ready`
- `empty`
- `stale`
- `offline`
- `rate-limited`
- `corrupt`
- `error`

Only `ready`, or previously verified records carried by the permitted stale
and offline states, can start a puzzle. Corrupt records are never retained in a
fallback state. Every list is schema-validated as a whole, every record is
validated individually, and a repeated puzzle ID is rejected.

The runtime applies a learner move and each forced opponent reply as separate
board transitions. This preserves legal replay and lets the visual layer finish
one 140–180 ms move before starting the next. Reduced-motion mode applies each
state immediately. Setup moves, promotions, castling, en passant, multiple
forced nodes, and alternative mate-in-one moves remain part of the release test
matrix.

`PuzzleAttemptEventV1` records solved or abandoned outcome, incorrect move
count, hint use, elapsed time, and occurrence time. Application is idempotent
by event ID. `PuzzleProgressV1` tracks attempts, solves, abandonment, clean
solves, hints, incorrect moves, and elapsed time in its own repository. Opening
cards, SM-2 intervals, family coverage, and opening mastery are not modified by
puzzle events.

## Commands

```text
npm run test:data:puzzles:v3
npm run data:puzzles -- integrity --source <archive> --output <new-receipt>
npm run data:puzzles -- ingest
```

The integrity command always emits a pending receipt and uses exclusive file
creation. Do not replace the approved receipt without review.

## Open hard gates

As of 2026-07-28, the approved 302,111,223-byte archive is present and its local
SHA-256 receipt is recorded. No release subset exists because the complete
compact v3 evidence graph (full broadcast plus April–June 2026 standard corpus)
has not been produced, and no Stockfish 18 per-learner-node campaign has run.
Fixtures test contracts only; their hashes and engine fields are deliberately
synthetic and never constitute release evidence. The current Puzzles screen
therefore shows an explicit unavailable state instead of legacy opening recall
or fabricated tactics. These blockers prohibit a production artifact.

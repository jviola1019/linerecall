# Data and software license boundaries

LineRecall code dependencies and derived opening data are audited separately.
The definitive per-source details, pinned revisions, checksums, approvals, and
review triggers are in `data/manifests/`.

The retained `linerecall-app-wire-v2` snapshot is historical review evidence,
not an approved production data component. Public release requires a separately
audited v3 manifest. No license statement below clears an incomplete data,
accessibility, security, privacy, trademark, or legal gate.

## Application code status

LineRecall application source code and original interface SVGs are licensed
under Apache-2.0. Package metadata carries the matching SPDX identifier; the
repository notice is `LICENSE` and the complete terms are retained at
`licenses/Apache-2.0.txt`. This implements the release owner's locked plan, but
it is not a qualified legal opinion or approval to publish a release. It does
not alter the separate CC0 taxonomy or CC BY-SA 4.0 derived-data terms below,
relicense third-party assets or audit-only GPL tools, or clear the provisional
product name.

## Data and tool boundaries

- The Lichess opening taxonomy is CC0-1.0 and retains provenance even though
  attribution is not required.
- Aggregated/backtested Lichess broadcast derivatives are CC BY-SA 4.0. Their
  attribution, transformation notice, source/checksum list, and share-alike
  terms travel with the artifact; see `data/DERIVED-DATA-NOTICE.md`.
- April-June 2026 Lichess Standard-rated archives are CC0-1.0. Their future
  Glicko-2 evidence remains a separate cohort from broadcast ratings. The full
  quarter has not been processed, so no Q2-derived statistics currently ship.
- The official Lichess puzzle database is CC0-1.0. Lichess publishes no puzzle
  archive SHA-256, so the approved local digest receipt binds one exact
  302,111,223-byte archive. That receipt authorizes parsing only; no puzzle may
  ship until v3 association and per-node engine gates pass.
- A production SBOM must record the exact approved compact v3 app-snapshot
  manifest as a shipped data component, separately from upstream source
  manifests and excluded offline audit tools. The current SBOM's v2 component
  is review-candidate history.
- Stockfish 18 (GPL-3.0-only) is an offline build-time analysis tool. Its binary,
  NNUE files, and code must not be included in the artifact.
- Scid `scid.eco` (GPL-2.0-only) is an independent offline audit oracle. Its
  entries/file, opening names, and movetext must not be copied into the
  artifact. The historical v2 review snapshot retains only a LineRecall-derived
  246-entry discrepancy index: LineRecall taxonomy identity, derived comparison
  outcome, and quarantine flag. Its six base-ECO mismatches and 14 total v2
  variant quarantines cannot approve or describe the required v3 graph.
- The twelve Chessnut SVG pieces by Alexis Luengas are Apache-2.0 assets copied
  unmodified from a pinned Lichess commit. Their per-file hashes and restricted
  approval scope are in `data/manifests/chessnut-pieces.source.json`; the full
  license text and attribution are retained under `licenses/` and
  `docs/THIRD_PARTY_NOTICES.md`.
- LineRecall uses local operating-system sans-serif and monospace stacks. It
  does not bundle or request a font file.
- Chess.com data, accounts, branding, and automated integration are outside the
  approved source boundary and remain disabled. Generic user-selected local
  PGN input does not authorize pooling or representing Chess.com data as a
  LineRecall source.

`config/license-policy.json` is a fail-closed technical allowlist, not blanket
legal approval. Any source, revision, dependency, intended use, or distribution
change reopens review.

Development-only browser-test transitive dependencies may use MIT-0 or
CC0-1.0; those identifiers are explicitly allowlisted alongside the other
permissive software licenses. Their presence does not change the shipped
application or the separate CC BY-SA 4.0 status of derived backtest data.

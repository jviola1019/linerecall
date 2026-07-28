# LineRecall

LineRecall is an offline-first chess opening trainer and an optional connected
service. Repertoire is organized by canonical opening family: Caro–Kann,
Sicilian Defence, Ruy Lopez, and every other assigned family appears once, with
both learner sides and all promoted paths nested beneath it. Explore keeps the
3,790 individual ECO taxonomy rows available for historical lookup and
name/move/PGN search.

The source tree includes legal board and non-spatial move input, autonomous
family coverage cycles, deviation evidence, SM-2 scheduling, separate tactical
puzzle progress, JSON progress transfer, and accessible keyboard controls. The
audited Lichess tactical-puzzle product is not yet shipped.

Public source: <https://github.com/jviola1019/linerecall>

## Release status

This repository is under active release-gated development. Any self-contained
HTML under `build/candidate` is a **review candidate**, not a production
release. Exact-byte audit evidence applies only when its recorded SHA-256
matches that candidate; the retained 2026-07-20 evidence does not approve the
newer unified-family source or later working builds.
`dist/linerecall.html` does not exist because the complete schema-v3 corpus,
engine, puzzle, staging, assistive-technology, localization, security-review,
and legal gates have not all passed.

The release process fails closed:

- `build/candidate/linerecall.html` may be inspected as review evidence.
- `dist/linerecall.html` and `dist/SHIPPABLE.json` can be written only by a
  completely passing release audit.
- the Pages review workflow verifies the release ID, byte count, SHA-256, gate
  set, source/data bindings, evidence receipts, and release signature, but has
  no deployment permission or deploy job because Pages cannot apply the
  required response-header contract;
- that workflow is intentionally runnable only at a separately audited release
  ref carrying the explicit production handoff files; it cannot pass on a
  normal development branch and never builds missing evidence itself;
- the launcher refuses to open a review candidate as a released product unless
  `-Candidate` is supplied explicitly.

Current engineering foundations include bounded two-pass schema-v3 ingestion,
content-addressed archive receipts, exact-position repertoire graphs, stable
position/card identities, starvation-free branch rotation, CSP-safe spatial
piece transitions, canonical family contracts, hash-addressable product routes,
a separate tactical-puzzle resource, and a durable Lichess sync worker. These
foundations are covered with fixture and adversarial tests. They do not stand
in for the unfinished full-corpus and manual campaigns.

The generated review-family catalog currently assigns all 3,790 taxonomy rows
to exactly 149 primary families. This is a taxonomy/navigation measurement,
not a repertoire-path count. It includes one Caro–Kann family (110 rows), one
Sicilian Defence family (388 rows), and one Ruy Lopez family (234 rows).
Runtime code validates those assignments; it does not infer families by
splitting display names.

For a promoted v3 family graph, the runtime requires every manifest-owned pack
for the selected side, aggregates totals across those packs, and autonomously
continues from one completed path and pack to the next. Family syllabus labels
come from validated, content-addressed manifest memberships rather than graph
display text; equal labels collapse visually without deleting distinct paths.
Due cards survive bounded batches, and a failed completion write blocks
advancement until an accessible retry succeeds. The embedded v2 review data
deliberately supplies no production family graph, so the interface shows no
fabricated Caro–Kann or other real-corpus path totals.

## Product routes

The single-file build uses hash routes so hosted and downloaded copies share
the same links:

- `#/today` — due work and the next family action;
- `#/repertoire` — one card per canonical family;
- `#/repertoire/:familyId` — both learner sides and family details;
- `#/train/:familyId/:side` — autonomous family training;
- `#/puzzles` — audited tactical puzzles only;
- `#/explore` — all ECO taxonomy rows and search;
- `#/progress` — opening and separately labeled puzzle progress; and
- `#/data` — provenance, licenses, and audit evidence.

If no promoted tactical shard is available, Puzzles shows an explicit
unavailable state. It never substitutes opening recall or synthetic tactics.

## Run the source checks

Requirements: Node.js 24 or newer and npm.

```text
npm ci
npm run typecheck
npm run test:data
npm run test:domain
npm run test:security
npm test
npm run hosted:test
npm run server:coverage
npm run server:critical-coverage
```

This is a core local check set, not the full release gate. CI also type-checks
and builds the hosted client and server, runs dependency, license, secret,
SBOM, editorial, and localization audits, measures critical coverage, and
produces only a review candidate. `npm run test:e2e` defaults to Chromium;
Firefox and WebKit require `LINERECALL_E2E_BROWSER` and separate ports, so one
invocation is not the complete browser matrix.

`npm test`, `npm run test:data`, and `npm run test:coverage` first materialize
checksum-verified review fixtures under `build/review-data` from the committed
embedded snapshot. This makes a clean checkout reproducible without a corpus
download. The fixture is schema-v2 review evidence and cannot satisfy the
schema-v3 production-data gate.

The repository retains a bounded schema-v2 embedded snapshot strictly so a
fresh checkout can run UI tests and build the review application without
downloading a corpus:

```text
npm run build:review
npm run artifact:harden
npm run artifact:audit
```

`npm run build:candidate` is different: it regenerates the embedded payload
from a locally produced, checksum-verified app snapshot. It will fail in a
fresh checkout until the reproducible data pipeline has produced that input.
This is intentional.

Run `npm run release:audit -- --report-only` to produce an honest blocker
report without attempting production promotion. A nonzero exit is expected
while release gates remain open.

`npm run release:family-promotion` audits the separate family-content
promotion index, every referenced graph and eligible-edge inventory, tactical
shards, and release-specific Q2, Stockfish, Scid, and puzzle receipts. It
currently exits nonzero because
`data/generated/v3/family-promotion-index.json` does not exist. No family,
pack, path, eligible-edge, or tactical count is production-promoted.

Development uses `npm run dev`. The downloaded application uses no runtime
CDN, remote font, analytics, telemetry, opening API, API key, Stockfish binary,
or Scid file.

## Data boundaries

- Opening taxonomy: pinned `lichess-org/chess-openings` commit
  `17ee660257de02870636f36248e919f2e01d8e85`, CC0-1.0, 3,790 rows and all
  500 ECO codes.
- Historical broadcast evidence: 78 official Lichess broadcast archives
  through June 2026, CC BY-SA 4.0; 1,146,297 records seen, 800,176 accepted,
  346,121 rejected, and zero duplicates in the recorded run.
- Required club cohort: all April–June 2026 Lichess Standard-rated archives,
  CC0, with 267,333,507 published games and 87,256,474,116 compressed bytes.
  This corpus has not been fully processed.
- Required puzzle source: the official Lichess puzzle database, CC0. Its
  302,111,223-byte local archive and SHA-256 receipt were approved on
  2026-07-15. Candidate ingestion remains blocked on the complete compact v3
  graph and the per-learner-node Stockfish campaign; see
  `docs/PUZZLE_V3_PIPELINE.md`.
- Stockfish 18 (GPL-3.0-only) and Scid ECO data (GPL-2.0-only) are offline audit
  tools. Their binary/data content is not shipped.

Historical rates are descriptive evidence, not promises that a move causes a
win. Broadcast ratings and Lichess Glicko-2 cohorts are never pooled or
relabeled. Code and original interface SVGs are Apache-2.0; derived broadcast
data retains its separate CC BY-SA 4.0 notice.

## Repository map

- Source manifests and exact recorded results: `docs/DATA_SOURCES.md`
- Bounded reproduction and recovery procedure: `docs/DATA_REPRODUCTION.md`
- Bounded tactical-puzzle contracts and blockers: `docs/PUZZLE_V3_PIPELINE.md`
- Canonical family registry, loaders, routes, and persistence boundaries:
  `docs/OPENING_FAMILY_ARCHITECTURE.md`
- Autonomous v3 graph-training contract: `docs/GRAPH_TRAINING_V3.md`
- Current blockers and evidence validity: `docs/RELEASE_AUDIT.md`
- Release gate definitions: `docs/RELEASE_GATES.md`
- Accessibility evidence plan: `docs/ACCESSIBILITY_AUDIT.md`
- Security model: `SECURITY.md` and `docs/SECURITY_AUDIT.md`
- Code/data/tool license boundaries: `docs/LICENSE_BOUNDARIES.md`
- Connected API and worker: `server/`
- Hosted client: `hosted/`
- Provider-neutral reference infrastructure: `infra/`
- No-cost CI and non-deployment policy: `docs/ZERO_SPEND_GITHUB.md`

Engineering evidence supports a release decision. It is not legal
certification and does not replace hands-on NVDA, VoiceOver, TalkBack,
localization, privacy, trademark, or qualified accessibility review.

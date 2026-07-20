# Preliminary name, license, and legal-scope due diligence

Name/license sources checked **2026-07-13 11:52 EDT (15:52 UTC)**;
accessibility evidence context refreshed **2026-07-13 15:10 EDT (19:10 UTC)**.
This is a dated, non-legal research handoff. It is not legal advice, a
trademark clearance opinion, a license opinion, an
accessibility-conformance review, or release evidence.
`audit/evidence/legal-trademark.json` remains `not_run`, and the provisional
LineRecall name remains a hard release blocker.

All product, browser, candidate-hash, count, and source-snapshot observations in
this file are historical observations from the dates shown. They were not
re-run for the current source tree and must not be copied into a current release
record. Current release status is maintained in `docs/RELEASE_AUDIT.md` and the
machine-readable release report.

## Bottom line

- No record was returned by the limited exact, expanded, alternate-spelling,
  or chess-related word searches run in the live USPTO federal database.
  USPTO itself warns that its database cannot give a clear-cut answer and that
  common-law use can matter even without a federal registration.
- A live, paid **ChessRecall** chess-opening trainer and a **RecallChess** chess
  memory-training prototype are material related-market leads. Their names,
  priority, ownership, territories, goods/services, and legal significance
  require qualified counsel review. No conflict or non-conflict conclusion is
  made here.
- The pinned upstream license texts and source bytes were reachable and the
  checked hashes matched the local manifests where a source hash is recorded.
  Application source code and original interface SVGs now carry the locked
  Apache-2.0 project license. Public distribution and all legal representations
  remain release-gated.
- The required manual screen-reader environments were not available in this
  workspace. No assistive technology was simulated and no manual result is
  claimed.

## Preliminary word-name search

### Method and official guidance

The live [USPTO Trademark Search](https://tmsearch.uspto.gov/) field-tag search
was queried on 2026-07-13. Both all-status and `LD:true` live-only counts were
checked. The search deliberately was not narrowed by international class;
[USPTO federal-search guidance](https://www.uspto.gov/trademarks/search/federal-trademark-searching)
warns that related goods/services need not share a class and recommends exact,
expanded, alternate-spelling/pronunciation, and combined-term searches. See
also [USPTO search help](https://tmsearch.uspto.gov/?page=help) and
[why similar marks must be searched](https://www.uspto.gov/trademarks/basics/why-search-similar-trademarks).

| Query entered | All / live results observed | Review note |
| --- | ---: | --- |
| `CM:linerecall` | 0 / 0 | Exact joined word. |
| `CM:"line recall"` | 0 / 0 | Exact spaced phrase. |
| `CM:/.*linerecall.*/` | 0 / 0 | Joined word embedded in a larger mark. |
| `FM:/line.*recall/` | 0 / 0 | Line followed by recall. |
| `FM:/recall.*line/` | 0 / 0 | Reverse order. |
| `FM:/lyne.*recall/ OR FM:/line.*rekall/ OR FM:/line.*recal+/` | 0 / 0 | Limited spelling variants; not a phonetic search opinion. |
| `CM:/.*line.*/ AND CM:/.*recall.*/` | 1 / 0 | One dead, apparently unrelated `RECALLSONLINE. COM` record (serial 75652045); no live record. |
| `CM:chessrecall`, `CM:"chess recall"`, and `FM:/chess.*recall/` | 0 / 0 each | Checks the closest live product name found on the web. |
| `CM:recallchess`, `CM:"recall chess"`, and `FM:/recall.*chess/` | 0 / 0 each | Checks the reverse-order prototype name. |
| `CM:/.*chess.*/ AND CM:/.*recall.*/` | 0 / 0 | Broader combined-mark order-neutral check. |
| `CM:/.*recall.*/ AND GS:/.*chess.*/` | 1 / 0 | One dead, apparently unrelated `TOTAL RECALL 2070` record (serial 75652984); no live record. |

These are transient counts, not a search certificate. They cover word queries
in the U.S. federal database only. USPTO states there is no surefire search
method, outside research may be needed, dead records may still have common-law
significance, and an empty federal search does not guarantee registration.

### Live web and product findings

Searches included `LineRecall`, `Line Recall`, the terms with software/app,
chess, education, opening trainer, and spaced repetition, plus `ChessRecall`,
`Chess Recall`, `RecallChess`, `Opening Recall`, and reverse-word variants.
Search-engine indexing is incomplete and results can change.

| Finding | Observation and preliminary significance |
| --- | --- |
| [ChessRecall website](https://chess-recall.com/) and [Google Play listing](https://play.google.com/store/apps/details?hl=en_US&id=com.vanSoftware.chess_recall) | Live commercial chess-opening trainer from VanSoftware using recall, spaced repetition, Lichess statistics, progress tracking, and offline study. The Play listing showed 1K+ downloads, in-app purchases, and an update on 2026-07-06. This is the most material related-market lead and needs counsel assessment; the empty federal queries do not resolve possible common-law, state, foreign, contractual, or platform rights. |
| [RecallChess forum announcement](https://www.chess.com/forum/view/general/i-built-a-small-chess-memory-trainer) | A 2026-03-26 Chess.com post identifies and links a prototype named RecallChess for memorizing and replaying chess move sequences. It is a close reverse-order name in a related training market. No conclusion is made about current operation, commercial use, priority, ownership, or enforceable rights. |
| [ChessWiz](https://chesswiz.net/) | Recently indexed product copy uses "Line recall practice" descriptively within chess opening practice; it was not observed as the product name. It shows the phrase is already used in this product vocabulary, but this report makes no distinctiveness conclusion. |
| [DIY Bowling Manager](https://play.google.com/store/apps/details?hl=en_US&id=com.diybowler.eddybowling) | An unrelated bowling app uses "Line Recall" as a feature label. Its listing showed an update on 2026-07-05. This is exact-phrase public software use in a different market, not a conflict finding. |
| [InterSystems `LineRecall` parameter](https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=RACS_LineRecall) | Exact joined-token public use for a command-line-recall compatibility parameter, not observed as a consumer product brand. |
| `linerecall.com` | `linerecall.com` and `www.linerecall.com` returned DNS-name-does-not-exist on 2026-07-13 at 15:50 UTC; `chess-recall.com` resolved and served the site above. DNS failure says nothing conclusive about registration, ownership, availability, past use, or trademark rights. |

Not searched comprehensively: U.S. state registries, business-name records,
court/TTAB records, paid common-law databases, every app-store locale, social
handles, historical uses, WIPO and foreign registries, domain-registration
records, unindexed/pending uses, or design marks. A final logo would require a
separate design-code and common-law search. Counsel should re-run searches at
the naming decision, filing, and release dates.

Chess.com account connection, username import, automated game access, pooled
evidence, branding, and derived analytics remain disabled. This preliminary
report does not supply the written authorization or legal approval required to
change that product boundary. User-selected local PGN remains the generic
import path and must not be represented as Chess.com-sourced data.

## Source and license verification

The following confirms source identity and published terms only. It does not
decide copyright ownership, license enforceability, derivative-work status,
attribution sufficiency, or the legal effect of the project's transformations.

| Boundary | Current source check | Local use boundary and remaining issue |
| --- | --- | --- |
| Lichess opening taxonomy | Pinned [commit `17ee660...`](https://github.com/lichess-org/chess-openings/tree/17ee660257de02870636f36248e919f2e01d8e85). The exact [CC0 `COPYING.txt`](https://raw.githubusercontent.com/lichess-org/chess-openings/17ee660257de02870636f36248e919f2e01d8e85/COPYING.txt) fetched as 7,048 bytes and matched manifest SHA-256 `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499`. Official [CC0 legal code](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en). | Manifest permits the pinned taxonomy to be normalized and shipped while retaining provenance. Re-review any commit, file, terms, or distribution change. |
| Lichess broadcasts | The official [database page](https://database.lichess.org/) specifically identifies broadcast games as CC BY-SA 4.0; [broadcast list](https://database.lichess.org/broadcast/list.txt) remains live. This specific broadcast term controls the project boundary even though other Lichess database sections use CC0. Official [CC BY-SA 4.0 legal code](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en). | Local manifest covers 78 archives, 2020-01 through 2026-06; derived statistics retain attribution, transformation notice, source links, and share-alike terms in `data/DERIVED-DATA-NOTICE.md`. Counsel must approve the shipped notice and share-alike treatment. |
| Lichess Standard Q2 2026 | The official [database page](https://database.lichess.org/) states that general database exports are CC0. The pinned manifest covers the exact April, May, and June 2026 Standard-rated archives: 267,333,507 published games and 87,256,474,116 compressed bytes. | The three archives have not been processed in this workspace. No Q2 statistics or beginner/club recommendation may ship or be inferred from other cohorts. A changed month, hash, total, or license reopens review. |
| Lichess puzzles | The official [puzzle database section](https://database.lichess.org/#puzzles) identifies the CC0 source and format. Lichess publishes no puzzle-file SHA-256; the project separately approved one 302,111,223-byte local receipt with SHA-256 `5503bfaf5534518ffe3c4c3bb0ac1ae82350d117ad1a52947796096b75e6247e`. | Digest approval permits parsing that exact archive only. No puzzle is approved for shipping until the completed v3 graph association and per-node Stockfish gates pass. |
| Stockfish 18 | Pinned [release](https://github.com/official-stockfish/Stockfish/releases/tag/sf_18) and [commit `cb3d4ee...`](https://github.com/official-stockfish/Stockfish/tree/cb3d4ee9b47d0c5aae855b12379378ea1439675c). Exact [GPLv3 `Copying.txt`](https://raw.githubusercontent.com/official-stockfish/Stockfish/cb3d4ee9b47d0c5aae855b12379378ea1439675c/Copying.txt) fetched as 35,149 bytes, SHA-256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`. | Audit-only executable/NNUE use; no Stockfish binary, NNUE, or code is intended to ship. Counsel must confirm representations if use or distribution changes. |
| Scid `scid.eco` | Pinned [commit/tree `8ffd1e3...`](https://sourceforge.net/p/scid/code/ci/8ffd1e3a02b9f61b5616e38b18ce932b904e04ff/tree/). Exact [`scid.eco`](https://sourceforge.net/p/scid/code/ci/8ffd1e3a02b9f61b5616e38b18ce932b904e04ff/tree/scid.eco?format=raw) fetched as 1,089,733 bytes and matched manifest SHA-256 `acd73837668a0791aa4d1b174fdfe8b19efa361ac2437b45735b397b0e20c4a7`; pinned [`COPYING`](https://sourceforge.net/p/scid/code/ci/8ffd1e3a02b9f61b5616e38b18ce932b904e04ff/tree/COPYING?format=raw) fetched as 20,483 bytes, SHA-256 `5f4410f5854352d5f6b015080045d785df0354133492af19945807ca139cb7a9`, and identifies GPLv2. | Audit oracle only. No Scid name, movetext, or entry is intended to ship; the output is a 246-entry LineRecall-only discrepancy classification/index. Counsel must assess the file-specific and derived-output boundary. |
| Chessnut pieces | The pinned Lichess `COPYING.md` identifies `public/piece/chessnut` by Alexis Luengas as an Apache-2.0 exception. `data/manifests/chessnut-pieces.source.json` binds the exact twelve SVG files at commit `3b7f2811bfb0682932f40688fcfb5d5caf7aece3` by byte length and SHA-256. | Only those static-scanned piece files are approved. No other Lichess artwork or application code is included in this boundary; attribution and the Apache-2.0 notice must travel with redistribution. |
| Application and npm dependencies | At the audit date, root, hosted-client, and server package metadata used `Apache-2.0`; `LICENSE` identified the covered project work and incorporated the complete text at `licenses/Apache-2.0.txt`. The then-existing generated license evidence predated that change. | The technical allowlist and project-license selection are not legal approval. Qualified review must still approve public distribution terms, notices, and all release claims. |

## Historical exact-candidate automated accessibility context

The metrics in this section describe a superseded candidate and are retained
only to explain what the dated review observed. They do not describe the
current candidate, cannot satisfy an exact-hash gate, and cannot be promoted to
current release evidence.

The dated artifact audit identified a 3,526,385-byte candidate as SHA-256
`0b3cacc7b3ee2bc3922fa3d418ed0e14314ab27865d03fac8b3e478a94debf9b`.
Exact-candidate Playwright reports show 29/29 expected Chrome cases and 25
expected cases in each of WebKit and Firefox. WebKit and Firefox each skip
three Chromium-native touch cases and one CDP-only CPU-throttling case.

Across ten retained axe 4.12.1 state attachments per engine, all 30 attachments
recorded zero violations and no non-contrast incomplete result. Seven
attachments per engine retained a `color-contrast` incomplete rule entry.
These cover 50 nodes in Chrome and 51 nodes in each of Firefox and WebKit and
remain unresolved manual-review items, not WCAG conformance evidence.

This context does not provide hands-on testing with NVDA, VoiceOver, or
TalkBack, does not provide a qualified accessibility or legal opinion, and does
not change `audit/evidence/manual-accessibility.json` or
`audit/evidence/legal-trademark.json` from `not_run`. Although the generated
browser summaries do not embed the candidate hash themselves, the reviewed
`audit/evidence/browser-e2e.json` and `persistence.json` records then bound
them to that exact candidate with `pass` status and immutable,
SHA-256-addressed schema-v2 receipts. This automated
evidence does not clear either manual or qualified-review blocker.

## Current accessibility/legal reference links

These links are routing material for qualified review, not conclusions about
which law applies to LineRecall:

- [WCAG 2.2, current W3C Recommendation](https://www.w3.org/TR/WCAG22/).
- [U.S. Access Board Revised Section 508 Standards](https://www.access-board.gov/ict/),
  which state that Section 508 covers ICT developed, procured, maintained, or
  used by federal agencies.
- [DOJ Guidance on Web Accessibility and the ADA](https://www.ada.gov/resources/web-guidance/),
  an informal guidance page that includes its own nonbinding disclaimer.
- [DOJ Title II web/mobile rule fact sheet](https://www.ada.gov/resources/2024-03-08-web-rule/)
  and the official [2026 interim final rule extending compliance dates](https://www.federalregister.gov/documents/2026/04/20/2026-07663/extension-of-compliance-dates-for-nondiscrimination-on-the-basis-of-disability-accessibility-of-web).
  Applicability depends on the entity and use context and must be assessed by
  counsel; this report makes no ADA Title II, Title III, or Section 508 claim.

## Manual assistive-technology availability

Host inventory was read-only on 2026-07-13. The host is Microsoft Windows 11
Home 64-bit, version 10.0.26200/build 26200. Chrome
`150.0.7871.101` is installed.

| Required environment | What was actually available | Result |
| --- | --- | --- |
| NVDA with current Chrome on Windows | NVDA was absent from Program Files, the checked AppData install paths, `PATH`, running processes, uninstall registry entries, Start Menu shortcuts, and exact `winget` inventory. Chrome was present. | Environment unavailable; no test run. |
| NVDA with current Firefox on Windows | NVDA was absent and no system Firefox installation was found under either Program Files location. | Environment unavailable; no test run. |
| VoiceOver with Safari on a physical iPhone | This was a Windows host; no Apple Mobile Device service/support installation or provided physical iPhone test environment was evidenced. | Required physical environment unavailable; no test run. |
| TalkBack with Chrome on a physical Android device | No `adb` or Android emulator command, related process, connected/provided physical-device environment, or retained reviewer evidence was found. An emulator would not replace the specified physical-device review. | Required physical environment unavailable; no test run. |

Windows Narrator or a simulated screen reader was not used as a substitute.
Keyboard-only, zoom, forced-colors, text-spacing, reduced-motion, orientation,
touch, and visual checks were not performed by this preliminary review and
remain subject to exact-candidate manual evidence.

## Required qualified follow-up

1. Trademark counsel should investigate the ChessRecall and RecallChess leads,
   priority and territories; perform comprehensive federal, state, common-law,
   platform, domain, foreign, and final-logo searches; define goods/services;
   and approve or reject the provisional name in writing.
2. Qualified counsel should review the release owner's Apache-2.0 selection,
   the CC BY-SA notice/share-alike treatment, Scid-derived audit
   boundary, Stockfish audit-only boundary, public claims, jurisdictions, and
   re-review triggers.
3. Qualified accessibility/legal review should decide ADA/Section 508 and
   jurisdictional scope, any public accessibility statement, support and
   feedback channels, remediation obligations, and record retention.
4. Human reviewers must run and record the named screen-reader/device and
   other manual checks against the exact release candidate. This report cannot
   satisfy that release gate.

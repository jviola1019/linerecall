# Explicit implementation assumptions

The following choices are recorded rather than selected silently:

1. LineRecall is a provisional name for a public US-facing product for users
   aged 13 and older. Qualified trademark and age/privacy review are release
   gates.
2. The product has two delivery surfaces: a self-contained offline HTML
   artifact and an optional connected service. The downloaded artifact makes
   no data-network call after load.
3. Progress is isolated behind `ProgressRepository`: cloud sync when signed in,
   Claude personal Artifact storage only where supported, in-memory session
   state otherwise, and strict JSON export/import. `localStorage`, IndexedDB,
   and silent state merging are prohibited.
4. Standard chess is the only supported variant. Canonical SAN/UCI and English
   source notation are used internally.
5. The target interface locales are en-US, es, de, fr, pt-BR, pl, and ar.
   Currently only `en-US` is enabled. `es`, `de`, `fr`, `pt-BR`, `pl`, and `ar`
   remain disabled until complete translated catalogs and qualified language,
   layout, RTL where applicable, and assistive-technology reviews exist.
6. The browser has no runtime Stockfish, secret, client-side provider token,
   behavioral analytics, remote font, CDN library, or direct Lichess data call.
7. Learner repertoire edges require an eligible evidence cohort with at least
   500 games and an exact engine check. Sparse alternatives may be shown but
   are not promoted to audited book moves.
8. Usage and score are descriptive historical evidence. They are not causal
   claims or promises that an opening produces wins.
9. Broadcast ratings and Lichess/Glicko-2 ratings remain separate cohorts. The
   large Q2 2026 Standard corpus must be fully processed before claims based on
   its beginner and club bands are enabled.
10. SM-2 intervals after the six-day step are rounded to whole days. Review
    event timestamps are UTC while streaks use the recorded local calendar day.
11. Engineering targets WCAG 2.2 AA and Section 508 mappings but cannot itself
    certify ADA, Section 508, privacy, trademark, or other legal compliance.
12. No expenditure is authorized. GitHub public standard runners may execute
    bounded CI, but the full Q2 corpus and engine campaign cannot be moved to a
    paid service. OCI and other provider configurations remain unapplied
    references until a verified no-cost capacity and access path exists.
13. Accounts, magic links, passkeys, cloud sync, personal imports, and sharing
    are disabled in the public static build. Local connected-service tests are
    not evidence of a deployed service.
14. Chess.com integration, account import, branding, pooled evidence, and
    derived analytics remain disabled unless separate written authorization
    and qualified review approve a precisely defined use.
15. V3 practice exposes every eligible audited branch. Ranking may order a
    session but may not hide branches. Each path ends only at its evidence
    terminal or the ply-100 safety ceiling; `depth_capped` is shown when valid
    evidence continues. Core requires at least ten learner move inputs and the
    required real opponent branching. Shorter sound paths remain Primer.

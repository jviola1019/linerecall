# Interface terminology and copy review

LineRecall uses plain study language. It does not present an assistant persona,
invent strategy explanations, promise wins, or turn audit terminology into the
main learning interface.

## Learner-facing terms

| Term | Meaning in LineRecall |
| --- | --- |
| Book move | The selected audited repertoire move or a proven transposition. |
| Playable | An independently checked alternative within the configured engine and sample limits. |
| Exploratory | A legal, sampled alternative that does not meet the drill threshold. |
| Inaccuracy | A checked move 51–99 centipawns behind the engine's best move. |
| Mistake | A checked move at least 100 centipawns behind, or a losing forced-mate transition. |
| Unverified | Evidence is insufficient; the move is not called a mistake. |
| Historical score | `(wins + 0.5 × draws) / N` in the named cohort. It is descriptive, not causal. |
| Coverage | The share of observed responses represented by audited graph branches. |
| Core | A path with at least ten learner decisions and the required real opponent branching. |
| Primer | Sound, shorter material that ends before the Core depth requirement. |
| Warm-up | A non-due position traversed to reach a due card; it does not reschedule. |
| Engine forecast | A Stockfish principal variation, not a backtested continuation. |

## Style rules

- Put the action first: “Start review,” “Show why,” and “Practice this path.”
- Keep headings concrete and controls short. Explain technical evidence only in
  the Evidence or Data & Licenses views.
- State cohort, sample, and uncertainty beside a rate. Never say a move causes
  a historical result.
- Use “not available,” “not verified,” or a specific failure. Do not hide a
  network, storage, data, or rate-limit failure behind a spinner.
- Avoid assistant language, promotional superlatives, filler, generated
  strategic prose, and legal-certification claims.
- “Human-reviewed” may appear only after a named reviewer and dated record
  exist. The current release does not make that claim.

`npm run editorial:copy` extracts learner-facing JSX text into
`audit/generated/ui-copy-inventory.json` and enforces length, repetition,
inflated-language, causality, and certification rules. The inventory is an
engineering aid; a named human editorial review remains a release gate.

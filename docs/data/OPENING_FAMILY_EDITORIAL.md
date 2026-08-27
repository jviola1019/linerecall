# Opening-family editorial gate

The runtime must never infer an opening family by splitting display text. The
current Lichess-name-prefix process is useful only for creating a review
worksheet. It proposes 149 families and assigns each of the 3,790 pinned
taxonomy rows once, but it cannot decide whether names such as Accepted,
Declined, Formation, Indian Defense, or `with ...` belong at the top level.

`OpeningFamilyEditorialDecisionV1` records one decision for every proposed
family. A named chess or taxonomy editor must choose keep, merge, split, or
nest; identify all resulting families; cite sources; and provide a dated
rationale. The final family ledger separately records canonical names,
aliases, parent relationships, exact primary taxonomy ownership, and reviewed
historical links. Exact-EPD transpositions remain graph evidence and are not
created from a naming decision.

The checked-in `data/manifests/opening-family-editorial.proposal.json` is
deliberately pending. Production family promotion now requires an immutable
approved ledger receipt and verifies it against every promoted family manifest.
Validation fails for any pending decision, missing or duplicate taxonomy row,
alias collision, missing relationship target, hierarchy cycle, or catalog
disagreement. Caro-Kann, Sicilian Defence, and Ruy Lopez ECO ownership is also
checked whenever those families are part of the promoted catalog.

Synthetic approved ledgers used by tests are labeled fixture-only. They prove
fail-closed schema and promotion behavior and are never editorial evidence.

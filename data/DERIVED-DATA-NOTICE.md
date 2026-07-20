# LineRecall opening snapshot — CC BY-SA 4.0 notice

The backtested position and move statistics in the LineRecall opening snapshot
are modified and aggregated from the official Lichess broadcast database:

https://database.lichess.org/

The source broadcast data is provided under Creative Commons
Attribution-ShareAlike 4.0 International (CC BY-SA 4.0):

https://creativecommons.org/licenses/by-sa/4.0/

Modifications include checksum-verified streaming, validation, filtering,
deduplication, rating-band grouping, position normalization, transposition
merging, and aggregation into raw White/Draw/Black and trained-side
Win/Draw/Loss statistics. Exact archive URLs, SHA-256 values, cutoff date,
filtering rules, and generated timestamps are included in the snapshot
manifest and the application's Data & Licenses view.

The Lichess opening-name taxonomy is separately sourced from the pinned
`lichess-org/chess-openings` repository under CC0-1.0. Stockfish and Scid are
offline audit tools and are not included in the snapshot.

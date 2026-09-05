# LineRecall UI/UX research direction

Reviewed: 2026-08-27

Status: implementation brief, not release evidence or a claim of WCAG/ADA
conformance. The recommendations below are based on the current source tree,
the current synthetic review fixture, and cited public design-system and web
standards documentation. They have not been validated by user research or the
manual assistive-technology reviews required by the release plan.

## Decision

Use one quiet, board-first product language across LineRecall: graphite and
warm-neutral surfaces, a single terracotta action accent, system sans-serif
type, system monospace for notation, thin dividers, restrained radii, and motion
that explains chess state rather than decorates the page.

This is an original LineRecall system. It should not imitate Fable, Claude,
Chess.com, Lichess, or another product. Those references can describe qualities
such as calm hierarchy, progressive disclosure, or quick board interaction;
they are not visual specifications or asset sources.

The research resolves the opening-practice model as follows:

- one canonical family is one repertoire subject; Caro–Kann, Sicilian Defence,
  and Ruy Lopez must not fragment into duplicate cards;
- the learner chooses a side and then a full-family, named-branch, or single-path
  scope inside that family;
- normal full-family practice finishes one evidence-approved path and starts a
  different unfinished path from the same family without a grading stop;
- progress reports both the exact current line (`move n of m`) and the
  durable family total (`variations practiced / available variations`);
- due moves remain scheduling targets while intervening moves are
  visibly treated as context, so continuity does not inflate mastery; and
- tactical puzzles remain a separate route, evidence resource, state machine,
  and mastery record rather than a renamed one-move opening drill.

## Current-state review

The most recent visual evidence reviewed was:

- `audit/generated/review-fixture-mobile-family-training.png` at 390 x 844;
- `audit/generated/review-fixture-family-complete.png` at 1280 x 720; and
- `audit/generated/review-fixture-puzzle-progress.png` at 1280 x 720.

These screenshots are explicitly synthetic review fixtures. The `ui-*.png`
screenshots dated 2026-07-14 show an older serif-led design and must not be used
as current visual baselines. The exact hardened review candidate now also has
an automated 18-image route matrix in
`audit/generated/final-route-screenshots/`: Today, Repertoire, Puzzles,
Explore, Progress, and Data & Licenses at desktop dark, 360px dark, and 390px
light layouts. Those captures are test evidence, not human visual approval.

### What is already working

- The current source uses system sans-serif and system monospace; it no longer
  depends on an embedded display font.
- Dark and light themes share semantic color variables, and the palette is
  appropriately restrained.
- The latest mobile trainer keeps the board, click/touch input, a non-spatial
  move picker, and the four study actions in one viewport.
- Move states already use outline styles and text in addition to hue.
- The board has a semantic grid separated from its visual piece layer, which is
  the correct foundation for stable piece identities and spatial motion.
- The visual direction avoids gradients, glass, glow, stock imagery, and a
  conversational assistant persona.

### Findings and current disposition

1. **Mobile training chrome — corrected in the current source.** The earlier
   390 x 844 fixture put five equal-weight session actions ahead of the board.
   Pause now remains visible while Flip, Skip, Choose variation, and Stop live
   in one keyboard-operable session disclosure. The browser gate keeps the
   board, study dock, equivalent move picker, and bottom navigation from
   overlapping.

2. **Completion composition — corrected for the current scope.** The result is
   now a compact centered region with the exact practiced/total count and only
   the two valid next actions: start a new practice round or choose variations.

3. **Progress density — materially reduced.** First-run progress is compact;
   family coverage and puzzle mastery remain separate; history keeps the table
   surface it needs. A later design-system cleanup can further consolidate the
   metric borders without changing information hierarchy.

4. **Several generations of CSS coexist — partially corrected.** At review time, `styles.css` had
   1,883 lines and 11 media blocks, while board and puzzle styles added 389
   lines and seven more media blocks. The same 900/600 breakpoints recur in
   separate legacy and family-training sections. This is a maintenance signal,
   not a defect by itself, but it explains visible differences in density,
   radius, headings, and route composition. Board and training/puzzle styles
   now have explicit modules and shared tokens, but removing the remaining
   superseded shell rules is still maintenance work rather than a release claim.

5. **Fragmented type weights — corrected.** Earlier CSS used nonstandard
   system-font weights (including 420, 520, 620, 650, 750, and 850) and labels
   as small as 0.6rem. System fonts do not expose the same intermediate weights
   on every platform, so synthesis can change the visual result. Important
   metadata should not depend on 9.6–11px text. Current application CSS uses
   400, 600, and 700 weights and keeps essential labels at 0.75rem or larger.

6. **Control-boundary contrast — corrected in authored themes, pending manual
   review.** A calculation using the
   WCAG relative-luminance formula found the current dark `--border-strong`
   (`#5d5a51`) at 2.15:1 against `--surface-raised` (`#282824`) and the light
   value (`#978f84`) at 2.71:1 against `#f0ece4`. When that border is the visual
   indicator of an input or control, WCAG 2.2 SC 1.4.11 requires 3:1 against
   adjacent colors. The implemented `--border-strong` values are `#77776b`
   (dark) and `#777067` (light), measured at 3.37:1 and 4.04:1 against the
   raised control surfaces. The full component/state matrix still needs named
   manual review.

7. **Visual evidence — automated breadth improved, manual approval still
   open.** The current route matrix, synthetic family/puzzle captures, resource
   states, forced-colors run, reduced-motion run, mobile geometry checks, and
   representative board-motion frame are generated. They do not replace human
   visual approval, Arabic RTL review, or the named assistive-technology gates.

## Research sources and reuse boundaries

Only official documentation and official repositories were used. No paid tool
or paid asset is needed.

| Source | Relevant finding | License / boundary |
| --- | --- | --- |
| [Carbon data table guidance](https://carbondesignsystem.com/components/data-table/usage/) | Tables are for locating and comparing data; expandable rows progressively disclose detail; dense tables should receive the main content width; expected waits should use skeleton states. | [Carbon source is Apache-2.0](https://github.com/carbon-design-system/carbon/blob/main/LICENSE). Do not copy IBM branding, trademarks, or IBM-specific AI treatment. LineRecall needs no Carbon dependency. |
| [Carbon typography strategy](https://carbondesignsystem.com/elements/typography/style-strategies/) | Productive type should dominate focused tasks; expressive type can create hierarchy, but styles should remain consistent inside each task or component. | Use the principle, not IBM Plex or Carbon CSS. LineRecall's locked system-font decision is smaller and safer offline. |
| [USWDS side navigation](https://designsystem.digital.gov/components/side-navigation/) | Show the current location, keep labels short, and simplify when horizontal and vertical navigation coexist. | USWDS is mostly [CC0/public domain with listed exceptions](https://github.com/uswds/uswds#licenses-and-attribution). Do not import its fonts or third-party assets without checking the exception list. |
| [USWDS table](https://designsystem.digital.gov/components/table/) and [card](https://designsystem.digital.gov/components/card/) | A scrollable table is appropriate for dense data; a stacked table can preserve readability at narrow widths. A card should summarize one subject and work as one member of a reorderable collection. | Use semantic patterns only. Family summaries fit cards/rows; empirical comparisons remain tables. |
| [Primer typography](https://primer.style/product/getting-started/foundations/typography/) and [ActionList](https://primer.style/product/components/action-list/) | `rem` type and unitless line height support zoom; hierarchy should not rely primarily on color; a consistent single-column action list can carry title, description, and trailing facts. | [Primer React is MIT](https://github.com/primer/react). Do not copy GitHub trade dress, icons, or code unless separately pinned and attributed. A native LineRecall list is sufficient. |
| [Chessground](https://github.com/lichess-org/chessground) | Its documented interaction inventory confirms useful chess-board behaviors: click and drag, invalid-drop recovery, arrows/circles, fluid sizing, and move/capture animation. | Chessground is GPL-3.0 and its README warns that a combined web work must be GPL. Do not copy or port its code, CSS, assets, or DOM. Use only the high-level behavior checklist with LineRecall's original implementation. Lichess application code is AGPL-3.0 and has the same no-copy boundary. |
| [Lichess Practice](https://lichess.org/practice) and [Blind Mode tutorial](https://lichess.org/page/blind-mode-tutorial) | Practice groups related lessons under one subject and exposes overall progress. The accessibility tutorial documents board-first ordering, square-by-square keyboard navigation, announced legal moves, equivalent typed move input, immediate move/reply announcements, and automatic progression to the next puzzle. | Observe the information and accessibility model only. Do not copy Lichess presentation, application code, board assets, mascot, or wording. |
| [Chess.com Practice help](https://support.chess.com/en/articles/8724749-what-is-practice-on-chess-com) | Opening practice starts from an opening and learner color, then keeps opening play distinct from related lesson material. | Behavioral comparison only. Chess.com trade dress, copy, assets, services, and proprietary implementation are outside the reuse boundary. |
| [ChessTempo opening-trainer manual](https://chesstempo.com/manual/en/manual.html#_opening_training) | The documented trainer separates full-repertoire, selected-branch, review-in-order, and spaced-repetition scopes; tracks context moves separately from targets; carries transposition learning by position; and can continue after a line end unless paused. This validates the need for explicit LineRecall scopes, warm-up cards, exact position identity, and autonomous same-family continuation. | Product research only. Do not copy its interface, terminology wholesale, algorithms, code, data, or visualizations. LineRecall keeps its independently implemented SM-2 and evidence graph contracts. |

The August 27 refresh also checked the current public product flows. Lichess's
opening directory leads with a searchable name tree and rating/time-control
filters rather than promotional copy. Its individual opening pages keep
continuations, examples, and linked puzzles together. ChessTempo documents
separate spaced-repetition and in-order review modes, plus unseen-line ordering
that can move from a main line into its variations. Chess.com's current help
page starts opening practice from an opening and learner color. LineRecall uses
those behavior observations to reinforce its own compact family selector,
Learn/Review split, and board-first flow; it does not reproduce any site's
layout, wording, code, icons, or assets.

The accessibility constraints are primary requirements, not aesthetic
references:

- [WCAG 2.2 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)
  requires non-excepted content to work at 320 CSS pixels. A chessboard and
  data table may need two-dimensional layout, but their surrounding headings,
  search, controls, and explanations still need to reflow.
- [WCAG 2.2 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
  requires a 3:1 contrast ratio for visual information needed to identify
  controls and states.
- [WCAG 2.2 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)
  requires equivalent single-pointer operation without dragging. Click-click
  and the move picker must remain first-class, not hidden fallbacks.
- WCAG's AA minimum target is [24 x 24 CSS pixels, with defined
  exceptions](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
  Keep LineRecall's stricter product target of 44 x 44 CSS pixels for primary
  touch controls.
- The [ARIA grid pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/)
  puts one grid cell in the page tab sequence and uses arrow keys for internal
  movement. That matches the existing roving-focus board direction; actual
  screen-reader behavior remains a manual gate.
- The CSS specifications define [`prefers-reduced-motion`](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-motion)
  and [forced-colors behavior](https://www.w3.org/TR/css-color-adjust-1/#forced-colors-mode).
  The implementation should honor the user's motion preference and use system
  colors in forced-colors mode rather than trying to preserve the authored
  palette everywhere.

## Proposed visual system

### Tokens

Use role-based names and one source of truth. Components should not introduce
raw colors except for a reviewed board/piece compatibility map.

| Group | Tokens |
| --- | --- |
| Surface | `canvas`, `surface-1`, `surface-2`, `surface-selected`, `overlay` |
| Text | `text-primary`, `text-secondary`, `text-tertiary`, `text-on-accent` |
| Border | `border-subtle`, `border-control`, `border-strong`, `focus-ring` |
| Action | `accent`, `accent-hover`, `accent-pressed`, `accent-soft` |
| Evidence | `book`, `playable`, `inaccuracy`, `mistake`, `unverified`, each paired with an icon, word, and stroke/pattern style |
| Board | `board-light`, `board-dark`, `board-coordinate`, `route-expected`, `route-played`, `route-pv`, `route-user` |

Keep the current warm-neutral palette as the starting point. Promote the
control-border correction above, then run automated and manual contrast checks
for every text, icon, border, focus, selected, disabled, hover, and feedback
combination in both themes. `border-subtle` may remain lower contrast only when
it is decorative and not needed to identify a component or state.

Use a 4px spacing basis with a short semantic scale: 4, 8, 12, 16, 24, 32,
48, and 64px. Use 4px, 8px, and 12px corner radii. Reserve fully rounded pills
for compact status tags and binary controls. Use dividers instead of nested
shadows; one `0 1px 2px` elevation is enough for a sheet or floating control.

### Typography

Use the existing operating-system stack. Normalize weights to 400, 600, and
700 so the hierarchy survives platform font differences.

| Role | Recommended style |
| --- | --- |
| Page title | `clamp(1.75rem, 3vw, 2.5rem) / 1.08`, weight 600 |
| Section title | `1.375rem / 1.2`, weight 600 |
| Component title | `1rem / 1.3`, weight 600 |
| Body | `1rem / 1.5`, weight 400, approximately 70ch maximum for prose |
| Label / secondary | `0.875rem / 1.4`, weight 600 or 400 |
| Caption | `0.75rem / 1.35`, weight 600; never the only presentation of important state |
| SAN/UCI/data | system monospace, `0.875rem / 1.45`, tabular numbers where appropriate |

Avoid large editorial display type inside training. The current giant Today
headline can be reduced so the due action, not typography, owns the first
viewport. Use sentence case; keep uppercase to short evidence eyebrows.

### Motion

- Piece moves: 160ms within the locked 140–180ms range, with a restrained
  non-bouncing ease. Captures, castling, promotion, and opponent replies use the
  same timeline model.
- Route/view changes: at most 120–160ms opacity plus 4px translation. Do not
  slide entire pages across the screen.
- Bottom sheets: 160–180ms; current 240ms feels detached from the faster board.
- Start the opponent reply only after the preceding visual transition ends,
  while keeping chess/session state independent from DOM `transitionend`.
- Under reduced motion, set nonessential durations to zero, reveal the final
  state immediately, and keep all announcements and scheduling behavior.
- Never use bounce, shake, pulsing glow, parallax, autoplay decoration, or a
  transition that delays move feedback. Keep the browser test that freezes a
  piece at 50% of travel.

### Forced colors and non-color meaning

Use system colors such as `Canvas`, `CanvasText`, `ButtonText`, `Highlight`, and
`HighlightText` inside `forced-colors: active`. Use `currentColor` for SVG route
strokes and arrowheads. Apply `forced-color-adjust: none` only to the minimum
board/piece region that cannot retain meaning under user-agent adjustment, and
then provide an explicit high-contrast board map.

Every evidence state keeps four cues:

- a word (`Book`, `Playable`, `Inaccuracy`, `Mistake`, `Unverified`);
- a distinct icon;
- a distinct border/route pattern; and
- a live or inline textual explanation.

## Component and route recommendations

### Shared components

- **App shell:** one desktop rail and one mobile bottom navigation generated
  from the same route model. Keep five top-level destinations. Routine
  session-only storage becomes a compact status item in the utility area;
  only a real save failure gets a persistent warning banner.
- **Route header:** eyebrow, title, one-sentence purpose, and at most one primary
  action. This replaces bespoke large headers.
- **Family row/card:** one opening family as one subject, with title, ECO range,
  side availability, completed/total, depth, and one primary action. Use a
  searchable, virtualized single-column list on mobile and a bounded two-column
  collection on wide screens. Do not turn every statistic into a badge.
- **Metric strip:** two to four terse values separated by dividers, not four
  independent elevated cards.
- **Evidence table:** semantic caption and headers, tabular numbers, stable row
  height, sortable columns only where sorting is implemented. On small screens,
  either use a contained horizontal scroller with a clear affordance or a
  tested stacked presentation; never create page-level horizontal overflow.
- **Status mark:** one implementation for book/playable/inaccuracy/mistake/
  unverified across the board, analysis, puzzle, and tables.
- **Resource state:** one implementation for loading, empty, stale, offline,
  rate-limited, corrupt, and error. Use shape-preserving skeletons when the
  destination layout is known; use a compact status panel otherwise.
- **Bottom sheet / side panel:** the same content model renders as the desktop
  analysis panel or mobile sheet. Tabs remain Line, Alternatives, Evidence.
- **Board frame:** one board, coordinate, piece, route, annotation, prompt, and
  move-picker system shared by opening training and tactical puzzles. Puzzle
  CSS must not supply implicit board behavior.

### Training composition

Desktop: compact rail | board workspace | 320–400px contextual panel. Keep the
board at the largest size allowed by viewport height and the remaining width.

Mobile, in order:

1. compact back/title/progress/session menu bar;
2. board;
3. one-line prompt/feedback status;
4. Hint, Lines, Why, Annotate thumb dock; and
5. global bottom navigation.

Keep Pause directly available. Put Flip, Skip path, Choose variation, and Stop
in a labeled session menu; destructive Stop remains text-labeled. The
non-spatial move picker remains reachable beside the board prompt or through a
clearly labeled `Choose move` control, with no drag prerequisite.

The movement guide should stay abstract and quiet: a source ring, 2px route,
destination bracket, and compact semantic marker. Show one expected/hint route
and at most one selected engine PV. More simultaneous arrows reduce the board's
instructional value.

### Route distinctions

- **Today:** due count, one Start/Continue action, recent family, streak, and a
  small tactical payoff. Do not make release/audit prose a peer of the due task.
- **Repertoire:** one family per row/card. Search and side filters precede the
  list. Completion, depth, and evidence availability are visible without
  opening the family.
- **Family detail:** side tabs, compact facts, named-branch action list, and full
  family/branch practice actions. Branch rows carry a short description and
  route count rather than a cloud of chips.
- **Puzzles:** board-first tactical flow and separate mastery. Its empty or
  unavailable state must remain visibly tactical and must never fall back to
  opening recall.
- **Explore:** dense taxonomy search and comparison. Use list/table hierarchy,
  not the Repertoire card layout, so the destinations remain unmistakable.
- **Progress:** one metric strip, due forecast, family coverage, recall history,
  and separate puzzle mastery. JSON transfer and account/storage controls form
  a utilities section below learning data.
- **Data & Licenses:** technical and data-dense by design, with a local contents
  navigation and semantic tables. It should not determine typography density in
  learner routes.

## What not to copy or introduce

- Do not reproduce Fable or Claude layout, transitions, typography, icons, or
  brand cues. Do not reproduce Chess.com or Lichess board treatment.
- Do not copy GPL/AGPL chess UI source, styles, or assets into the Apache-2.0
  application. Behavioral observation is not permission to port code.
- Do not import a full design system. The app's self-contained size, CSP,
  offline behavior, and license boundary favor local semantic components.
- Do not add remote fonts, raster hero art, stock illustration, generated
  imagery, glass, glow, gradients, oversized marketing copy, an AI coach, or a
  chat surface.
- Do not use cards for evidence matrices, badges for prose, icon-only destructive
  actions, color-only status, hover-only controls, drag-only chess input, or
  decorative motion during continuous review.
- Do not mark screenshots approved automatically. A named human must review the
  exact candidate and baseline changes.

## Implementation order and measurable checks

Items 1–4 are materially implemented in the current source. Item 5 remains a
bounded maintenance task. Item 6 now has automated route, state, motion, and
responsive captures; named human visual and assistive-technology review remains
open and prevents a release claim.

1. Consolidate semantic color, type, spacing, radius, elevation, motion, and
   z-index tokens. Add a style rule that rejects raw application colors outside
   the theme and reviewed board/forced-color maps.
2. Replace legacy shell and route-specific header variants with shared shell,
   route-header, navigation, warning, resource-state, and utility components.
3. Recompose graph training and puzzles around the shared board frame; reduce
   mobile pre-board controls and unify the analysis panel/bottom sheet.
4. Replace metric-card grids and badge-heavy evidence with metric strips,
   action lists, definition lists, and semantic tables according to content.
5. Remove superseded CSS after each component migrates. Use one breakpoint map
   and logical properties for RTL.
6. Generate a fresh screenshot matrix for every primary route, theme, required
   viewport, loading/error state, forced colors, reduced motion, RTL, and the
   representative 50% board-motion frame.

The visual gate should verify:

- no page-level horizontal overflow at 320, 360, and 390 CSS pixels or at 200%
  and 400% zoom;
- the board and primary study controls remain usable in one practical mobile
  viewport;
- every primary touch control is at least 44 x 44 CSS pixels;
- every required control/state boundary and focus indicator meets 3:1 against
  adjacent colors, and text meets its applicable WCAG contrast threshold;
- no essential label or state relies on text below 0.75rem;
- keyboard, click-click, move-picker, touch, and drag paths produce equivalent
  results;
- forced colors preserves board coordinates, pieces, current focus, legal
  targets, routes, and status words;
- reduced motion eliminates spatial travel without changing chess state,
  announcements, or session pacing; and
- named NVDA, VoiceOver, TalkBack, localization, editorial, and visual reviewers
  evaluate the exact candidate before any release claim.

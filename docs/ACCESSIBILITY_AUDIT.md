# Accessibility engineering audit protocol

Current status: **manual review not run; no conformance claim**. LineRecall
targets WCAG 2.2 Level AA and includes a Section 508 engineering crosswalk. This
document is not a WCAG conformance statement, Accessibility Conformance Report,
Section 508 certification, ADA opinion, or legal conclusion.

WCAG conformance applies to complete pages and processes. Automated checks,
component tests, accessibility-tree inspection, emulated touch, and source
review are useful evidence but cannot establish conformance or replace
qualified assistive-technology and legal review. The normative product target
is [WCAG 2.2](https://www.w3.org/TR/WCAG22/). The Section 508 mapping uses the
[Revised 508 Standards](https://www.access-board.gov/ict/), under which E205.4
incorporates WCAG 2.0 Level A and AA for covered electronic content. Scoping
Chapter 5, the Web-application exception, Chapter 6, and ADA obligations
requires qualified review.

## Evidence policy

No current test count, axe result, contrast measurement, browser result, or
candidate digest is asserted here. An accessibility result is release evidence
only when it names the exact hardened candidate SHA-256, environment, steps,
reviewer, date, result, and retained content-addressed reports. A source,
configuration, data, or documentation change invalidates earlier approval.

The tracked `audit/templates/evidence/accessibility-manual.json` record must
remain `not_run`. `npm run audit:init-evidence` creates the ignored working
record at `audit/evidence/manual-accessibility.json` without overwriting prior
work. Only a qualified reviewer may complete it. Final attachments are copied
into digest-addressed receipt paths with `npm run release:evidence-receipts --
--write`; generated and manual results are not committed as claims.

Synthetic family, graph, animation, and puzzle fixtures are not real-corpus or
release evidence. They can expose accessibility defects in controls, but they
cannot establish that a production graph, puzzle shard, or complete user
process is accessible.

## Source implementation inventory

The source is designed with these accessibility boundaries. Each still needs a
fresh exact-candidate automated run and the manual matrix below.

- A semantic ARIA chess grid is separate from the absolute visual-piece layer.
  Roving focus, arrow navigation, Enter/Space selection, click-click input,
  Pointer Events, legal-target text, and an equivalent non-spatial move picker
  share `chess.js` legality.
- Autoplay can make the board read-only without removing its navigable position
  semantics. Move, deviation, loading, storage, puzzle, and completion messages
  have status/alert channels.
- Board motion supports normal moves, captures, en passant, castling,
  promotion, queued replies, orientation changes, resets, cancellation, and a
  reduced-motion immediate-update path.
- Family and side choices are native labelled button groups with
  `aria-pressed`; they are not misrepresented as tabs. The A–E ECO volume
  selector is a roving tab set.
- Full-family training exposes progress, pause, skip, retry, stop, and path
  selection without requiring a grade click after every move. Persistence
  failure blocks advancement and remains visible.
- Puzzles have distinct disabled, loading, ready, empty, stale, offline,
  rate-limited, corrupt, and error states, separate mastery, legal forced-reply
  sequencing, and an evidence sheet with focus restoration.
- Dragging is optional. Click-click, keyboard input, and a legal-move picker are
  equivalent actions. Desktop annotations also have touch and keyboard
  controls plus a textual list.
- Layout tokens provide visible focus, dark/light themes, forced-colors rules,
  reduced motion, 320 CSS-pixel reflow, 44-by-44 non-spatial controls, and a
  mobile thumb dock. Board squares use the WCAG spatial-target exception only
  when equivalent non-spatial controls remain available.
- The downloaded artifact prohibits `localStorage` and IndexedDB, uses
  session memory plus validated JSON transfer, and must state its persistence
  limits before users rely on reload durability.

## WCAG and Section 508 engineering crosswalk

This table lists intended implementation coverage, not a pass determination.
Criteria omitted from the table are unevaluated, not automatically inapplicable.

| WCAG 2.2 criterion | LineRecall boundary | Required evidence | Section 508 relationship |
| --- | --- | --- | --- |
| 1.1.1 Non-text Content | Squares expose color, piece, coordinate, selection, and legal-target text; decorative paths are hidden or text-equivalent. | Named AT output for board, pieces, arrows, and puzzle evidence. | E205.4 / WCAG 2.0. |
| 1.3.1 Info and Relationships | Landmarks, headings, labels, grids, tables, dialogs, tabs, pressed groups, and lists use programmatic structure. | Axe plus NVDA, VoiceOver, and TalkBack role/state review. | E205.4 / WCAG 2.0. |
| 1.3.2 Meaningful Sequence | DOM order follows navigation, board, status, analysis, and controls at each breakpoint. | Reading-order and focus-order transcripts. | E205.4 / WCAG 2.0. |
| 1.3.4 Orientation | No portrait/landscape lock is authored. | Physical phone rotation in both mobile AT environments. | WCAG 2.1/2.2 product target. |
| 1.4.1 Use of Color | Book, playable, inaccuracy, mistake, and unverified states also use text, icons, stroke/pattern, and borders. | Theme, forced-colors, and low-vision visual review. | E205.4 / WCAG 2.0. |
| 1.4.3 Contrast | Theme and board tokens define foreground/background pairs. | Complete token/state contrast matrix plus manual inspection; axe incompletes stay unresolved until reviewed. | E205.4 / WCAG 2.0. |
| 1.4.4 Resize Text | Responsive layouts are intended to support 200% and 400% zoom. | Actual browser zoom, keyboard, and AT review. | E205.4 / WCAG 2.0. |
| 1.4.10 Reflow | Primary screens target 320 CSS pixels without page-level two-dimensional scrolling. | All routes, sheets, dialogs, long names, evidence tables, Arabic, and errors at 320 pixels/400% zoom. | WCAG 2.1/2.2 product target. |
| 1.4.11 Non-text Contrast | Focus, selection, board targets, annotations, and state borders have authored indicators. | State-by-state normal and forced-colors review. | WCAG 2.1/2.2 product target. |
| 1.4.12 Text Spacing | Flexible heights and wrapping avoid text clipping. | WCAG text-spacing override on every primary route and dialog. | WCAG 2.1/2.2 product target. |
| 2.1.1 Keyboard | Native controls, roving grid/list focus, move picker, dialogs, training, puzzles, and annotations have keyboard paths. | Complete forward/reverse keyboard transcript. | E205.4 / WCAG 2.0. |
| 2.1.2 No Keyboard Trap | Dialog close/Escape paths and focus restoration are authored. | Keyboard and each named AT across dialogs and bottom sheets. | E205.4 / WCAG 2.0. |
| 2.4.1 Bypass Blocks | A skip link targets a focusable main region. | Exact-candidate activation. | E205.4 / WCAG 2.0. |
| 2.4.3 Focus Order | Roving focus, inert modal backgrounds, and route/dialog restoration are explicit. | Desktop/mobile focus sequence including automatic pack and puzzle transitions. | E205.4 / WCAG 2.0. |
| 2.4.6 Headings and Labels | Screen, form, group, table, and control labels describe purpose. | Accessible-name inventory and human clarity review. | E205.4 / WCAG 2.0. |
| 2.4.7 Focus Visible | `:focus-visible` and board-specific indicators are authored. | Every state/theme, sticky control, annotation, and forced-colors inspection. | E205.4 / WCAG 2.0. |
| 2.4.11 Focus Not Obscured | Sticky/fixed controls use scroll offsets and restoration logic. | Mobile browser chrome, thumb dock, sheets, dialogs, and 400% zoom. | WCAG 2.2 product target. |
| 2.5.1 Pointer Gestures | Drag paths have single-pointer alternatives. | Physical touch plus move-picker/keyboard equivalence. | WCAG 2.1/2.2 product target. |
| 2.5.2 Pointer Cancellation | Moves submit on pointer-up; cancellation clears pending drag state. | Genuine physical/browser cancellation, illegal reversion, and rapid reply checks. | WCAG 2.1/2.2 product target. |
| 2.5.3 Label in Name | Visible action text is included in accessible names. | Speech-input and accessible-name review. | WCAG 2.1/2.2 product target. |
| 2.5.7 Dragging Movements | Chess moves and annotations have non-drag alternatives. | Physical touch, keyboard, and screen-reader operation. | WCAG 2.2 product target. |
| 2.5.8 Target Size | Non-spatial controls target 44 CSS pixels; spatial board squares retain equivalent controls. | Computed geometry at required viewports and physical-device confirmation. | WCAG 2.2 product target. |
| 3.1.1 Language of Page | The active locale is declared on the document. | All enabled locales and Arabic RTL. | E205.4 / WCAG 2.0. |
| 3.2.1–3.2.4 Predictability | Focus/input do not silently start actions; navigation and repeated controls remain consistent. | Complete route, training, puzzle, import, and responsive review. | E205.4 / WCAG 2.0. |
| 3.3.1–3.3.4 Errors | Validation, retry, replacement confirmation, and recovery are text-labelled and guarded. | Malformed PGN/import/data/storage/network cases with AT timing. | E205.4 / WCAG 2.0. |
| 4.1.2 Name, Role, Value | Gridcells, pressed groups, tabs, dialogs, toggles, options, and native controls expose state. | Axe and all three named AT combinations. | E205.4 / WCAG 2.0. |
| 4.1.3 Status Messages | Loading, moves, deviations, grades, save state, path/puzzle completion, and failures use live messages. | Timing, ordering, interruption, and duplicate-announcement review. | WCAG 2.1/2.2 product target. |

## Required automated evidence

The final exact candidate must produce route-by-route axe attachments for
Today, Repertoire, family detail, training, Puzzles, Explore, Progress, Data &
Licenses, dialogs, light/dark, forced colors, reduced motion, mobile, and RTL.
Reports must retain violations and incomplete results. Serious/critical
non-contrast incompletes fail; `color-contrast` incompletes are not passes and
remain attached for measured and manual review.

Browser evidence must cover 360-by-800, 390-by-844, tablet, 1440-by-900, 320
CSS-pixel reflow, actual 200%/400% zoom, text spacing, mouse, keyboard, touch,
offline/error states, focus restoration, full-family and named-branch flows,
real promoted puzzles, and reduced-motion animation. A browser engine's missing
touch capability must be recorded as a limitation, not generalized from
Chromium or replaced with a component test.

## Hard manual blockers

- NVDA with current Chrome and Firefox on Windows.
- VoiceOver with Safari on a current physical iPhone, portrait and landscape.
- TalkBack with Chrome on a current physical Android device.
- Complete keyboard-only navigation, reverse navigation, actual zoom, text
  spacing, forced colors, reduced motion, and contrast review.
- Family side/pack state, full-family restore, named-branch transitions,
  completion/retry, and focus continuity across automatic pack changes.
- Board source/destination meaning, autoplay read-only state, physical pointer
  cancellation, pan/drag compromise, orientation/reset, and non-spatial input.
- Every puzzle resource state, forced reply, special move, alternative mate,
  evidence sheet, abandonment, separate mastery, and mobile dock clearance.
- Human review of all enabled locale catalogs and complete Arabic RTL behavior.
- Qualified WCAG 2.2 AA, Section 508, and ADA scope/mapping review.

Each manual result must retain candidate and source digests, reviewer, date,
OS, browser, AT version, device, exact steps, result, severity, owner,
attachment receipts, and remediation/retest references. Until those records
pass, LineRecall may state only that it targets the standards above.

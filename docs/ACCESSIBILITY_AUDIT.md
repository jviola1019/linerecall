# Accessibility engineering audit protocol

LineRecall targets WCAG 2.2 Level AA. This is an engineering crosswalk and test
protocol, not a WCAG conformance claim, an Accessibility Conformance Report,
Section 508 certification, an ADA opinion, or a legal conclusion. WCAG Level AA
conformance applies to complete pages and processes, so a collection of passing
automated checks cannot establish it. The tracked manual-evidence template at
`audit/templates/evidence/accessibility-manual.json` is `not_run`. Completed
evidence, when independently produced, belongs under the ignored
`audit/evidence/` directory and must be digest-bound by the release gate.

The normative accessibility target is
[WCAG 2.2](https://www.w3.org/TR/WCAG22/). For Section 508, the engineering
crosswalk below uses the
[Revised 508 Standards](https://www.access-board.gov/ict/): E205.4 incorporates
WCAG 2.0 Level A and AA for covered electronic content. WCAG 2.1 and 2.2
additions are useful product requirements but are not separately incorporated
by E205.4. Whether Chapter 5 software provisions or its Web-application
exception apply, and what Chapter 6 support documentation/services are in
scope, requires a qualified Section 508 scoping review. No such review is
recorded.

## Evidence status and interpretation

- "Implemented/source-tested" below means that an implementation and focused
  source, domain, component, or browser test exist. It does not mean the success
  criterion has been satisfied across the complete product.
- Browser, performance, persistence, and security records are valid only for
  the exact candidate SHA-256 stored in each record. The current automated
  browser records are bound to candidate
  `e13d4fe0d3180a1409dacbec6e454a56791f456ed8f8ac28662c5bcc1fe06507`.
  They do not replace the separate manual accessibility record.
- "Manual required" is a hard blocker. It cannot be cleared by axe, computed
  styles, Playwright's accessibility tree, or emulated touch.

## Historical exact-candidate automated observations

The following exact-candidate observations are automated engineering evidence,
not a WCAG conformance determination:

- Chromium passed all 36 expected cases. WebKit and Firefox each passed 32 and
  skipped four: three Chromium-native touch cases and one CDP-only CPU
  throttling case. Equivalent keyboard, click-click, Pointer Events, layout,
  offline, normal-CPU, and session/JSON persistence paths passed.
- Browser storage was never probed. Each engine passed explicit session-only,
  validated JSON transfer, reload, and malformed-import cases.
- The Chromium attachments found no undersized non-spatial controls at 320 by
  800, 360 by 800, 390 by 844, 768 by 1024, or 1440 by 900 CSS pixels. The
  minimum measured board square was 35.5 by 35.5 CSS pixels at 320 pixels
  wide. The 320-pixel text-spacing override reported no visible clipping.
- The Chromium focus-obscuration probe found no blocker for eight representative
  search, ECO, line, board, picker, hint, and statistics controls. The
  dark-square coordinate probe measured eight samples at 5.38:1.

No automated observation supplies the unavailable NVDA, VoiceOver, TalkBack,
physical-device, actual browser zoom, complete RTL, linguistic, or qualified
visual/contrast reviews, and the manual record remains `not_run`.

## Current source-tree observations, not candidate evidence

The mutable source tree is ahead of the exact candidate described above.
Focused component and review-harness checks currently exercise the following
behavior, but they are not digest-bound release records and cannot be combined
with the historical 39 axe attachments:

- The semantic board remains an ARIA grid, including a read-only navigable state
  during autoplay. Stable visual piece identities live in a separate absolute
  layer.
- Review-harness motion checks cover normal moves, captures, castling, en
  passant, promotion, sequential learner/reply movement, orientation changes,
  rapid FEN reset, and reduced motion. A paused midpoint geometry check places
  the moving piece between source and destination, and transition event ordering
  verifies that the reply does not start while the learner transform is active.
- Exact `pointercancel` state cleanup is component-tested. The browser harness
  covers an invalid drag plus keyboard and non-spatial move-picker alternatives;
  it does not claim a genuine browser `pointercancel` dispatch.
- Tactical fixtures exercise all nine visible resource states, special moves,
  alternate mate-in-one handling, evidence focus, and a 320-by-800 thumb dock
  above fixed navigation without horizontal overflow. The fixtures are
  synthetic and are not evidence that a real puzzle shard is accessible.
- Family side and pack choices are labelled native button groups with
  `aria-pressed`. They are intentionally not tabs. The A-E ECO volume selector
  remains a true roving tab set. Named-branch practice can advance across
  same-side packs, but exact branch-cycle recovery after remount is not yet
  durable.

All of these behaviors require regeneration against exact candidate bytes and
manual AT/device review before release.

## Criterion-by-criterion engineering crosswalk

Only criteria with a concrete implementation or a defined LineRecall test are
listed. Criteria omitted from this table have not been evaluated here; omission
must not be interpreted as not applicable or satisfied.

| WCAG 2.2 success criterion | LineRecall implementation in scope | Evidence and remaining work | Section 508 relationship |
| --- | --- | --- | --- |
| 1.1.1 Non-text Content | Decorative glyphs are hidden; board squares expose piece, color, coordinate, selection, and legal-target text. | Component/axe coverage exists; NVDA, VoiceOver, and TalkBack output remains manual. | E205.4 -> WCAG 2.0 SC 1.1.1. |
| 1.3.1 Info and Relationships | Landmarks, headings, labels, tables, grids, listboxes, the A-E ECO tab set, and labelled family side/pack button groups are programmatic. | Component queries and axe cover structure; pressed-state and tab announcements with AT remain manual. | E205.4 -> WCAG 2.0 SC 1.3.1. |
| 1.3.2 Meaningful Sequence | DOM order follows search, ECO selection, line detail, board, feedback, and progress flows. | Keyboard/component tests exist; reading sequence must be checked with each named AT. | E205.4 -> WCAG 2.0 SC 1.3.2. |
| 1.3.4 Orientation | Responsive rules support portrait and landscape without locking orientation. | Viewport/reflow automation exists; physical-device rotation remains manual. | WCAG 2.1/2.2 product target; not separately incorporated by E205.4. |
| 1.4.1 Use of Color | Move classifications use text, icons, borders/patterns, and announcements in addition to color. | Source/component checks exist; forced-colors and low-vision inspection remains manual. | E205.4 -> WCAG 2.0 SC 1.4.1. |
| 1.4.3 Contrast (Minimum) | Dark/light theme tokens and explicit board-coordinate colors are defined. | The current Chrome probe measured eight dark-square coordinate samples at 5.38:1. All three engine runs retain serious color-contrast incompletes, not passes; a complete token/state contrast matrix and manual inspection remain required. | E205.4 -> WCAG 2.0 SC 1.4.3. |
| 1.4.4 Resize Text | Layouts reflow at viewport sizes equivalent to 200% and 400% zoom. | Automated equivalents exist; actual browser zoom with keyboard/AT remains manual. | E205.4 -> WCAG 2.0 SC 1.4.4. |
| 1.4.10 Reflow | The app is bounded to 320 CSS pixels without page-level two-dimensional scrolling; wide tables use named scroll regions. | Browser overflow and 320-pixel cases exist; manual zoom and text-spacing review remains. | WCAG 2.1/2.2 product target; not separately incorporated by E205.4. |
| 1.4.11 Non-text Contrast | Focus, selected state, controls, board targets, and forced-color overrides have authored indicators. | Computed forced-color probes exist; comprehensive state-by-state visual review remains manual. | WCAG 2.1/2.2 product target; not separately incorporated by E205.4. |
| 1.4.12 Text Spacing | Content uses flexible layout/height rules, wrapping ECO names, and no name ellipsis; a 320-pixel test applies the WCAG text-spacing override and checks clipping/overflow. | The current automated 320-pixel case reported no visible clipping; actual browser spacing controls and AT/manual review are still required. | WCAG 2.1/2.2 product target; not separately incorporated by E205.4. |
| 2.1.1 Keyboard | Native controls, roving board/list focus, A-E ECO tab arrow keys, family pressed-button groups, move picker, dialogs, and grading are keyboard operable. | Component and browser keyboard paths exist; a full manual forward/reverse transcript remains required. | E205.4 -> WCAG 2.0 SC 2.1.1. |
| 2.1.2 No Keyboard Trap | Dialogs provide Escape/close paths, contain focus while open, and restore focus. | Automated dialog and breakpoint tests exist; manual AT/keyboard confirmation remains. | E205.4 -> WCAG 2.0 SC 2.1.2. |
| 2.4.1 Bypass Blocks | A skip link targets the focusable main region. | Document and browser checks exist; manual activation remains. | E205.4 -> WCAG 2.0 SC 2.4.1. |
| 2.4.2 Page Titled | The static document has a descriptive title. | Artifact/document audit exists. | E205.4 -> WCAG 2.0 SC 2.4.2. |
| 2.4.3 Focus Order | Roving focus and view/dialog restoration are explicit; background content becomes inert for modal UI. | Component/browser tests exist; complete manual sequence remains required. | E205.4 -> WCAG 2.0 SC 2.4.3. |
| 2.4.6 Headings and Labels | View headings, form labels, group names, table captions, and accessible control names describe purpose. | Component queries and axe coverage exist; AT clarity remains manual. | E205.4 -> WCAG 2.0 SC 2.4.6. |
| 2.4.7 Focus Visible | A high-contrast `:focus-visible` indicator is authored, with board-specific inset focus. | Computed/style and browser checks exist; all themes, forced colors, and sticky-control layouts remain manual. | E205.4 -> WCAG 2.0 SC 2.4.7. |
| 2.4.11 Focus Not Obscured (Minimum) | Authored sticky/fixed controls, dialogs, responsive breakpoints, scroll padding/margins, and focus restoration are exercised by a dedicated browser case. | The current Chrome probe found no blocker for eight representative focus targets; physical mobile browser/AT confirmation remains manual. | WCAG 2.2 product target; not separately incorporated by E205.4. |
| 2.5.1 Pointer Gestures | Dragging is not required: click-click, keyboard, and the legal-move picker provide non-path alternatives. | Component and Chrome touch paths exist; physical iOS/Android use remains manual. | WCAG 2.1/2.2 product target; not separately incorporated by E205.4. |
| 2.5.2 Pointer Cancellation | Drag submission occurs on pointer-up; cancellation clears pending drag state, and click-click is available. | Exact cancellation is component-tested; the browser harness covers invalid drag but not genuine `pointercancel`. Physical touch cancellation remains manual. | WCAG 2.0 has no direct counterpart incorporated by E205.4. |
| 2.5.3 Label in Name | Visible labels such as volume codes, move controls, themes, and grades are included in accessible names. | Component accessible-name queries and axe coverage exist; speech-input review remains manual. | WCAG 2.1/2.2 product target; not separately incorporated by E205.4. |
| 2.5.7 Dragging Movements | Every draggable chess move has click-click, keyboard, and non-spatial picker alternatives. | Chrome native touch-drag and alternative paths exist in source tests; physical-device confirmation remains manual. | WCAG 2.2 product target; not separately incorporated by E205.4. |
| 2.5.8 Target Size (Minimum) | Spatial board squares target at least 24 by 24 CSS pixels; non-spatial controls and equivalent move controls target at least 44 by 44. | Current computed attachments found no undersized non-spatial control at 320, phone, tablet, or desktop sizes; the minimum measured board square was 35.5 CSS pixels. Physical-device confirmation remains manual. | WCAG 2.2 product target; not separately incorporated by E205.4. |
| 3.1.1 Language of Page | The document root declares English. | Artifact/document audit exists. | E205.4 -> WCAG 2.0 SC 3.1.1. |
| 3.2.1 On Focus | Focus movement does not itself start drills, import data, or submit moves. | Component/browser navigation tests exist; manual complete-flow review remains. | E205.4 -> WCAG 2.0 SC 3.2.1. |
| 3.2.2 On Input | Search modes, ECO/variation selection, and move-picker selection have explicit behavior; destructive import requires confirmation. | Component tests exist; manual predictability review remains. | E205.4 -> WCAG 2.0 SC 3.2.2. |
| 3.2.3 Consistent Navigation | The same primary navigation is retained across views. | Component/browser navigation tests exist. | E205.4 -> WCAG 2.0 SC 3.2.3. |
| 3.2.4 Consistent Identification | Repeated controls retain names and purposes across views and responsive layouts. | Component accessible-name checks exist; AT review remains manual. | E205.4 -> WCAG 2.0 SC 3.2.4. |
| 3.3.1 Error Identification | Search, PGN, import, storage, and data errors are text-labelled alerts/statuses. | Domain/component/browser error cases exist; AT timing and duplication remain manual. | E205.4 -> WCAG 2.0 SC 3.3.1. |
| 3.3.2 Labels or Instructions | Search, PGN, move picker, import, hints, and grades have labels/help text. | Component/axe checks exist; manual comprehension review remains. | E205.4 -> WCAG 2.0 SC 3.3.2. |
| 3.3.3 Error Suggestion | Validation messages identify accepted formats/limits; retry and JSON export are offered where recovery is available. | Domain/component/browser recovery cases exist; manual clarity review remains. | E205.4 -> WCAG 2.0 SC 3.3.3. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Validated progress import presents a review/confirm step before replacing user-controlled progress. | Component import-confirmation tests exist; full manual process review remains. | E205.4 -> WCAG 2.0 SC 3.3.4. |
| 4.1.2 Name, Role, Value | Board gridcells, listboxes/options, the ECO tabs/panels, family pressed-button groups, dialogs, toggles, and native controls expose state and value. | The historical strict axe runs recorded zero violations and zero non-contrast incompletes; current-source regeneration and named AT testing remain required. | E205.4 -> WCAG 2.0 SC 4.1.2. |
| 4.1.3 Status Messages | Loading, selection, move feedback, storage, errors, grade, path/branch completion, puzzle state, and completion use live status/alert channels without forced focus. | Component/browser checks exist; announcement timing, ordering, and duplication remain manual. | WCAG 2.1/2.2 product target; not separately incorporated by E205.4. |

## ECO browser rendering and keyboard contract

The 500 ECO codes are split into five semantic A-E tabs of exactly 100 codes.
Only the active volume's list content is mounted, bounding the rendered rail to
100 options while the global search index remains able to find all 500 codes.
This is volume-bounded or coarse virtualization, not pixel-windowed list
virtualization. Arrow keys plus Home/End use roving tab focus; the tab/panel
relationships and all-code reachability have component tests. NVDA, VoiceOver,
and TalkBack tab announcements remain manual blockers.

## Touch-pan compromise

The board and non-draggable squares use `touch-action: pan-y pinch-zoom`, so a
vertical gesture can scroll the page. A square containing a currently movable
piece uses `touch-action: none` so native touch dragging can deliver Pointer
Events. Consequently, a pan that starts on a movable source square is reserved
for chess input. Click-click, keyboard, and the legal-move picker remain
equivalent alternatives.

For the current candidate, Chrome automation verified a native touch pointer
drag, touch taps, and page pan starting on a non-draggable square. Playwright
Firefox and WebKit do not expose a genuine touch device in the current
environment, so each deliberately skips three touch-only cases. The compromise
therefore requires physical VoiceOver/Safari/iOS and
TalkBack/Chrome/Android review; the Chrome evidence must not be generalized to
those platforms.

For the newer source-tree board harness, exact `pointercancel` dispatch remains
component evidence only. Its browser path deliberately verifies invalid-drag
recovery and equivalent keyboard/move-picker operation instead of overstating
the event that Playwright did not produce.

## Axe and contrast evidence policy

The current helper retains every axe JSON attachment and fails serious or
critical violations. It also fails serious or critical `incomplete` results
except `color-contrast`. Contrast incompletes are not passes: they stay in the
attachment for explicit computed-color probes and manual review. The
forced-colors run disables axe's authored-color rule because it does not model
system colors, then separately inspects computed forced-color behavior.

Chromium, Firefox, and WebKit each retain 13 current axe 4.12.1 attachments
covering every primary destination, Data & Licenses, training, light/dark,
mobile statistics, move feedback, forced colors, and reduced motion. All 39
attachments record zero violations. Each engine retains 10 serious-impact
`color-contrast` incomplete rule instances covering 342 nodes. No moderate
finding or non-contrast incomplete result is retained.

This is not "zero findings." Axe reports those contrast nodes as needing review;
the computed coordinate probe covers only its eight samples, not every token,
state, component, or theme. Manual inspection of every contrast incomplete and
the complete visual state matrix remains a hard blocker. These results cannot
establish WCAG conformance.

## Persistence hydration and status accessibility

Training, navigation, settings mutations, and progress writes remain gated
until both the audited opening core and the selected repository have hydrated.
The UI shows a live loading state and does not mount mutable training views
during that window. Browser IndexedDB and `localStorage` are prohibited. The
downloaded artifact visibly uses session memory and provides validated JSON
transfer; cloud and supported Artifact-storage adapters require separate live
staging evidence. Announcement timing, ordering, duplication, save failures,
outage export, and recovery remain manual/provider-backed checks.

## Hard manual blockers

- NVDA with current Chrome and Firefox on Windows: landmarks, A-E tabs and ECO
  filtering, board grid/roving focus, legal targets, picker, feedback, grading,
  dialogs, persistence warnings, errors, and completion.
- VoiceOver with Safari on a current physical iPhone: portrait/landscape,
  rotor, tab/panel announcements, touch exploration, the board pan compromise,
  move alternatives, modal containment/restoration, and JSON transfer.
- TalkBack with Chrome on a current physical Android device: the equivalent
  linear/swipe, explore-by-touch, pan, drill, error, and storage flows.
- Family coverage: side and pack pressed-button announcements, full-family and
  named-branch pack transitions, `completed / total` status, pause/skip/stop,
  error retry, and focus continuity across automatic pack changes.
- Tactical puzzles: every loading/error/offline/rate-limit/corrupt state,
  sequential learner/forced-reply announcements, special moves, evidence-sheet
  focus, mobile dock clearance, abandonment/save state, and separate mastery.
- Board motion: autoplay read-only navigation, source/destination semantics,
  exact physical pointer cancellation, orientation/reset behavior, and the
  reduced-motion alternative.
- Keyboard-only: Tab/Shift+Tab, arrows, Home/End, Enter/Space, Escape, reverse
  order, sticky controls, 200% and 400% actual zoom, and no traps.
- Visual/manual: 320 CSS-pixel reflow, 360 by 800, 390 by 844, tablet, desktop,
  portrait/landscape, dark/light, Windows forced colors, increased text
  spacing, reduced motion, focus visibility, and every contrast incomplete.
- Speech/status: database and progress loading, empty/corrupt/retry, legal and
  illegal moves, deviation, storage/import failure, grade, and completion must
  be timely, concise, ordered, and not duplicated.

For every manual check, retain the exact candidate SHA-256, date, reviewer,
OS/browser/AT versions, device model where applicable, exact steps, result,
evidence path, severity, owner, and remediation/retest reference. Only a
qualified reviewer may change the manual evidence record from `not_run`.

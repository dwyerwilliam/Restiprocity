# Single-field URL editor redesign

Status: implemented 2026-11-05. The single-field editor, compact query-parameter menu, responsive layout, tests, and verification gates below are complete.

## Direction

Replace the compact input and separate expanded textarea with one continuously mounted URL field. It starts at one line, wraps naturally, and grows to five visible lines before scrolling internally. Remove the Expand/Collapse URL editor control. There is one editable value, one selection, and one autocomplete experience.

Keep Method, URL, and Send together in the request header using the existing colors, borders and spacing. Use a readable monospace font for the URL. Method and Send align with its first line and retain stable widths as it grows. Short URLs should look like an ordinary address bar.

## Interaction contract

- Automatically fit the field to rendered content, from one to five lines. Long unbroken and encoded segments wrap without widening the pane. Beyond five lines, scroll vertically inside the field and keep the caret visible.
- Wrapping is visual only. Resizing, focusing, blurring and scrolling never insert newlines, decode escapes, reorder parameters or modify the URL.
- Do not collapse on blur or expand merely because focus moved. Height changes only with content or available width. No resize handle or alternate editing mode initially.
- Preserve native selection, clipboard, undo/redo and navigation. Keep the same editing element mounted during wrapping, autocomplete and preview updates. Do not recreate the old transparent-input/highlight overlay.
- Preserve shorthand conversion and autocomplete in the one field. Place the popup below the field, constrain it to the pane, and give it bounded scrolling. Accepting a suggestion restores the caret after the inserted token and scrolls it into view.
- Enter/Tab accept an open suggestion; Escape dismisses it. Otherwise Tab moves focus, Escape leaves text untouched, and Enter neither inserts a newline nor sends. Do not introduce new send shortcuts. Respect composition input and undo shortcuts.
- Retain the existing newline policy: remove CR/LF introduced by paste/drop, preserving other characters and encoded newlines such as `%0A`. Do not broaden whitespace trimming or normalization. Treat insertion as one undoable edit and preserve selection offsets.
- Continue using the current draft, save-on-blur and send-normalization paths. Send reads the latest draft even when clicked directly from the field. Measuring/wrapping never saves the request.

## Quieter supporting UI

- Keep the resolved example below the field as secondary, read-only information. Retain secret masking and interpolation diagnostics. Its styling must clearly distinguish it from the editable URL.
- Replace query-parameter chips with one compact action, such as `3 URL parameters`, only when relevant. Its menu offers existing per-parameter moves and move-all into Params. Long names truncate with accessible full labels; do not display values in the menu.
- Parameter extraction remains explicit and uses the current URL. Append to existing Params rows with existing parsing semantics. After a move, show a brief result and restore focus predictably.
- At narrow pane widths, place Method/Send in a compact row above the same full-width URL field if needed. Base this on the request pane width, not the whole window. No horizontal page scrolling at 390px.

## Implementation sequence

1. Extract `RequestUrlField` under `src/renderer/components/`: native textarea, one-line minimum, bounded auto-height and wrapping. Measure after value/width changes; use ResizeObserver for pane resizing. Avoid animation during typing and measurement loops.
2. Replace `urlExpanded`, the input, the expand button and `expanded-request-url` in `RequestEditor.tsx`. Adapt existing selection/shorthand/autocomplete handlers to the textarea. Preserve request switching and per-request drafts.
3. Keep autocomplete outside the field's clipping region. Use accessible label `Request URL`, preserve placeholder `Enter request URL`, associate suggestions with the field, and announce the active suggestion.
4. Consolidate parameter extraction into the compact menu, reusing the current parsing/removal/import helpers and persistence path.
5. Retain the existing preview resolver. Update tests that require an input element to locate the URL textbox independent of HTML tag; update AGENTS.md selector guidance.

## Verification

- Replace the expanded-view regression with a single-field test: exactly one URL textbox, no expand control, auto-growth, bounded height, internal scrolling and unchanged URL bytes.
- Exercise short, 10 KB and 100 KB URLs; encoded segments; multiple query parameters; and variable references. Verify edits at the beginning/middle/end, selection, clipboard, CR/LF filtering, undo/redo and caret visibility.
- Exercise autocomplete at a wrapped line and scrolled end with pointer and keyboard. Composition must not prematurely accept suggestions or change unfinished input.
- Verify direct Send, save/reopen, request switching, environment changes and previews preserve drafts. Preview updates must not reset caret, selection or scroll.
- Verify single-parameter and move-all actions, existing Params rows, empty-query state, dismissal and focus restoration.
- Inspect wide and narrow split panes, a 390px viewport, and increased text size: control alignment, popup placement, no page overflow, and usable tabs/response area below the five-line field.
- Run typecheck, rebuild renderer, affected browser suites and full browser gate; run native Electron smoke for send/save and the full build gate before a commit.

## Completion criteria

Short URLs occupy one line; long URLs become readable and editable in that same field. No duplicate textbox or expanded mode remains. Autocomplete works at every height, and sending/persistence/interpolation retain their behavior. Actual results are recorded in HANDOFF.md.

## Verification record

- `npm run typecheck` — passed.
- Focused `tests/e2e/request-editor-persistence.spec.ts` — 25/25 passed.
- Full browser E2E (`npx playwright test --workers=4`) — 152/152 passed.
- Native Electron smoke (`npm run test:electron`) — 19/19 passed with the native-capable runner.
- Full `npm run build` — passed; produced `releases/artifacts/Restiprocity-Setup-0.2.18.exe`, its blockmap, and `latest.yml`.

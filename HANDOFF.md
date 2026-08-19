# HANDOFF — Folder-Scoped Request Creation

> Task memory for the Restiprocity folder-scoped request creation pass. Read this to pick up where we left off.
> Last updated: 2026-08-18

## Objective

Create requests scoped to a folder in the Restiprocity sidebar:
1. Per-folder hover "add request" button (icon-only, appears on row hover).
2. Footer **New Request** button creates inside the currently selected folder when the selection is a group, else at root.
3. Newly created request starts in inline rename immediately, and its ancestor folders auto-open so it is visible.

## Status

- **DONE (code complete, verified)** — all three behaviors implemented.
- Typecheck: ✅ `tsc --noEmit` clean.
- E2E: ✅ 75/75 passed (`npm test`).
- Engine (collection store): ✅ 6/6 collectionStore specs passed (`npm run test:engine -g Collection`).
- Not yet committed (working tree only).

## What changed (this pass)

### Backend — `src/main/stores/collectionStore.ts`
- `createRequest()` now calls new private `attachRequestToParentGroup(request)` after `saveRequestFile`.
- `attachRequestToParentGroup`: no-op if no `parentId` or parent group missing or child already present; otherwise appends the request id to the parent group's `children` via `updateGroup`.
- `duplicate()` / `import()` / `moveRequest()` paths already preserve/manage `parentId` + `children` — untouched.

### Renderer — `src/renderer/components/Sidebar.tsx`
- `TreeNodeProps` + `TreeNode` destructuring gained: `onAddRequestToFolder`, `autoRenameNodeId`, `onAutoRenameConsumed`, `forceOpenGroupIds` (threaded down through recursive child renders and the root `TreeNode`).
- `TreeNode`: `useEffect` fires `startRename(node.id, node.name)` + `onAutoRenameConsumed?.()` when `autoRenameNodeId === node.id`.
- Open-state: `const isForcedOpen = isGroup && (forceOpenGroupIds?.has(node.id) ?? false);` → `effectiveOpen = isForcedOpen || (isGroup && !!filterText) || isOpen`. Chevron, folder icon, and child rendering now key off `effectiveOpen` (was `isOpen`).
- Row div gained `group` class; hover add button rendered only when `isGroup && onAddRequestToFolder`: icon-only `<IconPlus/>`, `aria-label="Add request to {node.name}"`, `hidden group-hover:flex`, `stopPropagation` on click + mousedown.
- `Sidebar` state: `autoRenameNodeId` (string|null) + `forceOpenGroupIds` (ReadonlySet<string>).
- `createAndSelectRequest(request, options?: { autoRename?: boolean })`: resolves `createdId = created?.id ?? request.id`; on `autoRename` walks `nodeMap` ancestors (with a `seen` guard) to add them to `forceOpenGroupIds`, then sets `autoRenameNodeId`.
- `handleCreateRequest`: derives `parentId` from `selectedNodeId` only when the selected node is a group (`'type' in node && node.type === 'group'`); passes `{ autoRename: true }`.
- New `handleAddRequestToFolder(folderId)`: builds a default request with `parentId: folderId`, passes `{ autoRename: true }`.
- New `handleConsumeAutoRename`: clears `autoRenameNodeId`.

## E2E selector guardrails (why the hover button is shaped this way)

- `getByRole('button', { name: 'New' })` is a **substring** match used in `main-page`, `collection-sidebar-fixes`, and `curl-import` specs — the hover button's accessible name is `Add request to {folder}` (no "New"), so it does not collide.
- `getByTitle('New Request')` is used in `main-page.spec.ts` — the hover button has **no `title`** attribute.
- `getByText('New Request', { exact: true })` — the hover button is **icon-only**, no text node.
- `getByTestId('new-request-menu').getByRole('button', { name: 'New Request', exact: true })` — the hover button lives **outside** that testid container.
- `new-request-menu` is asserted to contain **exactly 3** buttons — the hover button is not inside it.

## Pre-existing issues (NOT caused by this work — do not re-attribute)

- **`better-sqlite3` native binding fails to load locally** → `tests/engine/historyStore.responses.spec.ts` (3 tests) fail with a `bindings.js` / "using `npm rebuild` or `npm install`" native-module ABI error at `new Database(...)`. This is a **local Node/Electron ABI mismatch** of the native `better-sqlite3` binary, unrelated to code logic.
  - It is **pre-existing and environmental**, not a regression from this pass. This work touches `collectionStore.ts` (pure filesystem JSON, no SQLite) and `Sidebar.tsx` (React UI) only.
  - All 6 `collectionStore` engine specs pass; the failures are confined to `historyStore` (SQLite). CI gets a fresh `node_modules` and is unaffected.
  - **Do not "fix" this as if it were our bug.** If it blocks local engine runs, the remedy is an environment rebuild (`npm rebuild better-sqlite3`) — a local toolchain action, not a code change. Do not treat it as a gate failure for this feature.

## Relevant files

- `src/renderer/components/Sidebar.tsx` — tree UI, hover add button, auto-rename, ancestor reveal, selected-folder `New Request`.
- `src/main/stores/collectionStore.ts` — backend `parentId` attach on create.
- `src/shared/types/index.ts` — `Request` (`parentId?: Id`, no `type`), `CollectionNode` (`type: 'request'|'group'`, `parentId?`), `RequestGroup`, `Id = string`.
- `tests/e2e/collection-sidebar-fixes.spec.ts` — selector contracts above **plus a new test** ("hover add-request button creates a request inside the group and starts inline rename") that verifies the hover button renders, reveals on hover, creates the request with `parentId = group-1`, starts inline rename, and selects it in the editor.
- `tests/e2e/main-page.spec.ts`, `tests/e2e/curl-import.spec.ts` — selector contracts (unchanged).
- `tests/engine/collectionStore.*.spec.ts` — store coverage (green).
- `tests/engine/historyStore.responses.spec.ts` — the 3 pre-existing native-binding failures (not ours).

## Verification commands

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run build:renderer` (before E2E — see gotcha below) | ✅ fresh `dist/` |
| `npm test` (Playwright E2E) | ✅ 76 passed (incl. the new hover-button verification test) |

## Gotcha — E2E runs against a prebuilt `dist/`, not the dev server

- `playwright.config.ts` `webServer` runs `npm run preview` (Vite preview, port 4173), which serves the **static `dist/` build**, and `reuseExistingServer: true` locally.
- **Source edits to `src/renderer/**` do NOT show up in E2E until you rebuild the renderer.** A stale `dist/` makes new UI (e.g. the hover button) absent from the DOM, so a test fails with "waiting for … button" even though the source is correct and typecheck is green.
- **Rule:** before running `npm test` after any renderer change, run `npm run build:renderer`. If a preview server is already bound to 4173, kill it first so Playwright starts one serving the fresh bundle.
- This is why the first run of the new hover test failed (stale `dist/`); after `npm run build:renderer` it passes. Diagnose with a scoped `page.getByTestId('sidebar-…')` + `locator('button[aria-label=…]')` `.count()` + hover → `isVisible()` before assuming a code bug.

## Conventions / guardrails

- Wait for explicit user approval before committing or pushing (established session pattern). Nothing has been committed for this pass.
- Do not commit, push, or create a PR without an explicit request.
- Rebuild the renderer (`npm run build:renderer`) before `npm test` after any `src/renderer/**` change (see gotcha above).
- The `better-sqlite3` engine failures are pre-existing/environmental — do not attribute to this work, do not delete or skip those tests to force a green gate.

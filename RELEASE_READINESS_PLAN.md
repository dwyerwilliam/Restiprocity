# Release readiness plan

Status: in progress. Decisions D1 to D5 were answered on 2026-11-10 (section 4). M0 started: the OpenAPI work is committed locally as `a8981f5`. Evidence is recorded in 6.1 as each milestone finishes.
Prepared: 2026-11-10 against local commit `d14352d` plus the then-uncommitted OpenAPI import work (18 changed or new paths).

## 1. Executor instructions

Work through the milestones in order. Read `AGENTS.md` and the newest entries in `HANDOFF.md` first, inspect `git status`, and preserve unrelated work. Checkboxes are checkpoints for this plan, not existing capabilities. Update `HANDOFF.md` after each milestone. Do not commit, push, tag, publish, or start a GitHub workflow unless the user asks for that step. Steps marked **User** are theirs to run.

This is a stabilisation pass. Add no features and no dependencies, and refactor only as far as a fix needs. Every fix arrives with a test that failed before it. Section 3 records what was true on 2026-11-10; if the source has moved, re-check a claim before acting on it. If a milestone uncovers a defect that is not listed here, record it in `HANDOFF.md` and in section 9, fix it when it is small and in the same area, and otherwise stop and report.

## 2. Outcome and scope

Outcome: the work built since v0.2.18 ships as one release whose pipeline is green on Windows, macOS and Linux, with the defects in section 3.2 fixed, and with a way to run CI before a tag exists.

Waiting to ship (15 local commits plus the uncommitted OpenAPI import; 112 files, +13,313/−1,427 between v0.2.18 and `d14352d`): OAuth 2.0 client credentials and authorization code with PKCE, binary-safe multipart uploads, Postman, Insomnia and OpenAPI import, native collection export and import, Copy as cURL, the nested environment editor with layered interpolation, NetLog-based timings, history reopen, the growing URL field, and Node 26.13.0.

Included: corrections that make the E2E mocks match the real bridge; the six fixes in 3.2; a TLS test fixture that works on all three systems; a Linux run of the Linux CI jobs before any push; a manual CI trigger; root causes for two intermittent native tests; version bump, release notes, an upgrade check and packaging; the release steps, written down for the user to run.

Deferred: request scripts, code generation, proxy support, a settings screen, folder-level auth, sidebar request search, HAR; encrypted secret storage (`SECRET_STORAGE_SPEC.md`); code signing (`codesigning.md`); removing the legacy `execute()` path; splitting `Sidebar.tsx` and `RequestEditor.tsx`; raising the OpenAPI 100,000-value budget (kept by decision on 2026-11-10); auto-update on macOS and Linux.

## 3. Verified starting point

"Ran" means observed on 2026-11-10 in the built app or in a command's output. "Read" means established from the source only and not reproduced.

### 3.1 State of the work

- `package.json` is still 0.2.18. The last tag is v0.2.18 (2026-09-02). Local `primary` is 15 commits ahead of `origin/primary`, and the OpenAPI import is uncommitted. None of it exists anywhere but this machine. (Ran)
- CI has never run on any of it, because the release workflow starts only on a `v*` tag. (Read)
- Last local verification, from the 2026-11-09 HANDOFF entry: typecheck passed; `test:engine` 380 passed, 10 skipped; `test` 156 passed; `test:electron` 23 passed, 1 opt-in skip. Not run since the OpenAPI corrections: `test:engine:node-abi`, `test:update`, `npm run build`.

### 3.2 Confirmed defects

**R1. Copy as cURL cannot be reached from the sidebar. (Ran)** The menu item renders only when `nodeType === 'request'` (`src/renderer/components/Sidebar.tsx:283`), and `nodeType` is `node.type` (`:395`). `CollectionStore.listAll()` returns requests with no `type` field; only groups carry `type: 'group'`. In the built app with a fresh profile, the context menu for a root request and for a request inside a folder is Rename, Duplicate, Export…, Delete. The sidebar menu is the only entry point for the feature. The comment at `Sidebar.tsx:439-441` already describes this trap for rename.

**R2. The main process never sends `collection:changed`. (Ran)** `setupIpcHandlers({ mainWindow, … })` runs at `src/main/index.ts:90`, before `createWindow()` at `:148`, and `src/main/ipc/handlers.ts:526` copies the value while it is still `null`. Three creates over IPC produced zero events, and the sidebar stayed empty until the window was reloaded. The order was the same at v0.2.18. Consequences (Read): the listener at `Sidebar.tsx:753-759` never fires; `env:changed` (`handlers.ts:721`, `:727`) is never sent and the preload exposes no listener for it; `RequestOperationCoordinator` receives `mainWindow: null`, so the save dialog for downloads gets no parent window (`handlers.ts:342`, `src/main/engine/requestEngine.ts:310`; Ran in M1: `dialog.showSaveDialog` was called with one argument and no window). No stale tree has been seen in normal use, because the sidebar reloads after each of its own mutations.

**R3. Folder edge-drop strips never render, and would do nothing if they did. (Read)** `Sidebar.tsx:483` counts children with `child.type === 'request'`, so `canUseGroupEdgeDrop` (`:484`) is always false with real data and the strips at `:598` and `:621` never appear. They were added in `bfb4e43` to move a request to the first or last place in its folder (the handlers took the first and last child). Since `e0968f8` they call the folder-row handlers, which pass the folder itself as the target; for a request already in that folder `reorderRequest` finds no such sibling and returns without change. Moving to the first or last place works through the upper and lower half of the child rows, so nothing is lost by removing the strips. Correcting the predicate alone would add dead drop zones.

**R4. Unreachable filter code repeats the assumption. (Read)** `filterText` is a `TreeNode` prop that no caller passes, so `Sidebar.tsx:488-506` cannot run. Line 496 checks `child.type === 'request'` again.

**R5. Cancelling a send does not cancel its OAuth token request. (Read)** `applyAuthHeaders` passes `multipart?.signal` to `OAuthService.getAccessToken` (`requestEngine.ts:582`). For a send without a multipart body that is `undefined`, so `cancel()` (`:488-491`) leaves a client-credentials or refresh token request running until the token endpoint answers or the 30-second token timeout ends. `OAuthService` already forwards a signal when it is given one.

**R6. The OAuth identity check and the binding key disagree. (Read)** The check (`src/shared/oauthIdentity.ts`, used at `requestEngine.ts:1216`, at `src/main/oauth/oauthService.ts:141`, and for field errors at `src/renderer/components/RequestEditor.tsx:74`) rejects `{{timestamp}}`, `{{uuid}}` and `{{randomInt}}` in browser-flow identity fields so that the identity does not change on every send (`OAUTH_IMPLEMENTATION_PLAN.md`, line 88). The identity is the binding key (`src/shared/oauth.ts:89-93`). They differ in three places:

- The check covers the whole request URL; the key uses only its origin. `https://api.example.com/items?nonce={{uuid}}` cannot be sent with browser OAuth.
- The check covers disabled authorization-parameter rows; the key ignores them.
- The key includes enabled token parameters; the check does not. A built-in there would change the key on every send (effect not reproduced).

The client secret is in both, even when client authentication is `none`. That is consistent and can stay.

### 3.3 Why the suites did not catch these (Read)

- `tests/e2e/fixtures/mockApi.ts` gives requests a `type: 'request'` that the real store never returns (`MockRequest` at `:24-27`, `createMockRequest` at `:141`, the `collectionUpdate` mock at `:656-658`). Seven specs hand-build typed nodes: `curl-import`, `env-empty-state-create`, `httpbin-requests`, `main-page`, `ntlm-auth`, `request-editor-persistence`, `request-send-error`.
- The mock calls its collection listeners after every mutation (`:499`, `:648-715`) and returns an unsubscribe function (`:731-739`). The real preload returns nothing (`src/preload/index.ts:170-172`) and the event never arrives.
- Left alone: the mocks return `collectionList` as `{ nodes: [...] }` where the real bridge returns an array, and the sidebar accepts both (`Sidebar.tsx:690`). It has not hidden a defect so far; the fallback can go if it ever does.
- No native test opens the sidebar context menu. `tests/electron/existing-behavior.spec.ts` calls the `copyRequestAsCurl` IPC directly (around `:219`).

### 3.4 Release pipeline

- `.github/workflows/build-release.yml` runs only on a `v*` tag push. Jobs: `build` (macOS, Windows, Ubuntu; each runs `npm run test:electron`, Ubuntu under `xvfb-run`), `test`, `updater-unit`, `engine-node-abi`, then `release`, which needs all four and is guarded by `if: startsWith(github.ref, 'refs/tags/')`. Packaging uses `--publish never`, so a run that is not for a tag cannot publish. (Read)
- The TLS fixture is Windows-only. `tests/electron/fixtures/nativeServers.ts:94` tries `pwsh.exe` and `powershell.exe` and throws when neither exists. `existing-behavior.spec.ts:133` and `:206` call it with no platform guard, so both tests will fail in the macOS and Ubuntu `build` jobs and block `release`. (Read; not run on those systems)
- At v0.2.18 the native suite was `native-startup.spec.ts` alone. The other five native specs, and every engine test added since, have never run on macOS or Linux. (Read)
- `playwright.electron.config.ts`: one worker; `retries` is 2 in CI and 0 locally. (Read)
- On 2026-11-09 two native tests failed once each and passed when rerun: "real sends measure connection setup from the NetLog and clean up the log" (`existing-behavior.spec.ts:183`) and one test in `history-reopen.spec.ts` (which one was not recorded). Causes unknown.
- Precedent: the v0.2.17 tag run failed on a test-only problem and the tag was removed.
- `HISTORY_SCHEMA_VERSION` is 2 at v0.2.18 and now, so the upgrade involves no database migration. Request, environment and settings files carry no format version. (Ran)
- This machine (Ran): `core.autocrlf=true` with no `.gitattributes`, so tracked text files are CRLF here and LF in CI; WSL has Ubuntu 22.04.3 without Node or xvfb; Docker 29.9.2 is installed; Git Bash has OpenSSL 3.1.4; `pwsh.exe` is not on PATH; an installed-app profile exists at `%APPDATA%\restiprocity`.

## 4. Decisions for the user

Answered 2026-11-10: the user took the recommended option for every item. Pushing and running the workflow by hand (D5) stay the user's steps; the executor prepares the workflow change and commits it locally, and nothing is pushed.

| # | Decision | Recommended | Alternative |
|---|---|---|---|
| D1 | Local commits | Commit the OpenAPI work first, then one local commit per milestone. `Sidebar.tsx` and `tests/e2e/collection-file-actions.spec.ts` are changed by both, and a Linux clone contains only committed work. | No commits: the executor works on top of the uncommitted tree and M3's Linux run waits. |
| D2 | TLS test fixture | Check in a long-lived self-signed test key and certificate (PEM) and stop generating one at test time. Same behaviour on all three systems, no host tools. Cost: a private key in a public repository. It is trusted by nothing, but a secret scanner may flag it. | Generate at run time with `openssl` off Windows (key stays out of the repo, depends on the host tool). Or skip the two TLS tests off Windows (smallest; leaves TLS untested where the app has never been tested). |
| D3 | `collection:changed` | Remove the dead event: main-process sends, preload method, sidebar listener, and the mock's notifications. Nothing changes in the real app, and the tests stop relying on something that does not happen. | Repair delivery. Every editor edit saves through `collectionUpdate` (`RequestEditor.tsx:419-430`), so each one would then trigger a full collection reload in the sidebar. Measure that on a large imported collection first. |
| D4 | Version | 0.3.0: the first feature release since 0.2.18. | 0.2.19. |
| D5 | CI before the tag | Add `workflow_dispatch` to `build-release.yml`, push `primary`, and run the workflow by hand. This would be the first push since `ac28659`, to a public repository, and it is the only way to test macOS before the tag. | Tag without a prior run and accept that macOS is first tested at tag time. |

## 5. Rules

- A mock may not be kinder than the real `window.api`: same node shapes, same events, same return values. When the two differ, the mock changes.
- Real-app behaviour is proven in `tests/electron`. An E2E test alone does not close a defect in 3.2.
- No test is skipped, and `retries` is not raised, to get a green run. The opt-in system clipboard test keeps its documented skip.
- The Windows working tree stays a Windows, Electron-ABI install. Linux checks run in a separate clone on the Linux filesystem. Never run `npm ci` or a rebuild for another system in this folder.
- The installed profile at `%APPDATA%\restiprocity` is input only: copy it, point `RESTIPROCITY_TEST_USER_DATA` at the copy, delete the copy afterwards, and put none of its contents in `HANDOFF.md`.
- Nothing leaves this machine through the executor: no push, no workflow run, no tag, no release.

## 6. Milestones and evidence

### M0 — Baseline

- [x] D1 is answered (recommended option). `git status` and `git log origin/primary..HEAD` match section 3. The OpenAPI work is committed as `a8981f5`; this plan is committed separately.
- [x] Baseline gates on the starting tree, with counts recorded in 6.1: `typecheck`, `test:engine`, `build:renderer`, `test`, `test:electron`, `test:update`.

### M1 — Make the tests see the real app

Tests only; no application code. Expect failures: they are the evidence.

- [x] `mockApi.ts` returns requests without `type` (`MockRequest`, `createMockRequest`, `collectionUpdate`), and the seven specs in 3.3 build nodes the same way. Record every test that now fails. Predicted: the two Copy as cURL tests in `collection-file-actions.spec.ts` (R1), and possibly "root edge accepts a child request dragged before its group" in `collection-sidebar-fixes.spec.ts` (R3). Any other failure is a new finding; add it to 3.2 as R7 onwards. Result: exactly the two Copy as cURL tests failed; the root-edge test passes because it covers the root level, not the folder strips; no new findings.
- [x] Under the recommended D3, the mock stops notifying collection listeners. Record failures the same way; each one is a flow that does not refresh the sidebar in the real app. Done in `mockApi.ts`, `previewApi.ts` and the inline mocks in `request-editor-persistence.spec.ts` and `collection-sidebar-fixes.spec.ts`. Result: no failures, so no tested flow depends on the event.
- [x] New `tests/electron/sidebar-actions.spec.ts`, failing before M2 (plus `download-dialog-parent.spec.ts` for the R2 consequence). The four tests that prove R1 and R2 carry `test.fail()` so that every commit keeps the gates green; M2 removes the annotations and Playwright fails any run where one starts passing early: a root request and a request inside a folder each offer Copy as cURL, and a folder does not; choosing it writes exactly one expected command through the intercepted main-process clipboard (the technique at `existing-behavior.spec.ts:226-229`); a folder and a request created with the sidebar's own controls appear without a reload.

### M2 — Fix the defects in 3.2

- [ ] R1, R3, R4: the context-menu `nodeType` (`:395`) comes from `isGroup`, so a request is whatever is not a group. Remove the dead edge strips with `canUseGroupEdgeDrop`, `childRequestIds` and the unreachable filter block with the unused `filterText` prop. Remove the `test.fail()` lines from the four tests. Evidence: the M1 native test and the two M1 E2E tests pass; the existing drag and drop E2E tests still pass.
- [ ] R2: stop passing a window into `setupIpcHandlers`. Take the parent window from `event.sender` with `BrowserWindow.fromWebContents`, as `collectionFileActions.ts:43`, `responseFileActions.ts:58` and `handlers.ts:610` already do, and remove `mainWindow` from `IpcDeps` so the null capture cannot come back. Then apply D3. If D3 is "repair", send to the requesting window, make the preload's `onCollectionChanged` return an unsubscribe function, and add a native test that counts events. Evidence: no `mainWindow` left in `handlers.ts`; where a `dialog.showSaveDialog` interception like the one at `existing-behavior.spec.ts:264` can see its first argument, a native test that the download dialog receives a window.
- [ ] R5: the send's own abort signal reaches `getAccessToken` when there is no multipart operation, as `executeNetRequest` and `openNetResponseV2` already do with `multipart?.signal ?? this.abortController?.signal`. Engine test in `tests/engine/requestEngine.auth.spec.ts`: with a token endpoint that never answers, `cancel()` settles the send as cancelled well inside the 30-second token timeout, no resource request is made, no token is cached, and the next send works. Check the legacy `execute()` path, which shares `buildHeaders`; do not widen it.
- [ ] R6: one function defines the OAuth identity inputs, and both `buildOAuthBindingKey` and the built-in check derive from it: the request origin instead of the whole URL, and enabled authorization and token parameter rows. The engine, the service and the editor's field errors all use it. Tests: a built-in in the path or query is accepted for browser OAuth; a built-in in the host, in an enabled authorization parameter and in an enabled token parameter is rejected; a disabled row is ignored; client credentials are unchanged. Binding keys live in memory only, so their exact value may change. Update `OAUTH_IMPLEMENTATION_PLAN.md` where it describes the rule.

### M3 — Native suite on macOS and Linux

- [ ] TLS fixture per D2. For the recommended option: generate once (Git Bash has OpenSSL; prefix the command with `MSYS_NO_PATHCONV=1` so `-subj "/CN=…"` is not rewritten as a path); RSA 2048, SHA-256, subject `CN=api.restiprocity.test`, subject alternative names `api.restiprocity.test` and `tls.restiprocity.test`, validity long enough that it will not expire in practice. Put the two PEM files under `tests/electron/fixtures/tls/` with a short README saying they are test-only and how they were made. `startHttpsFixture()` loads them with `https.createServer({ key, cert })`. Both TLS tests pass on Windows with their assertions unchanged. Update the "Windows-only" note in the `AGENTS.md` test table.
- [ ] Linux run in a clone on the Linux filesystem. WSL Ubuntu 22.04.3 needs Node 26.13.0, xvfb and the Chromium system libraries; Docker is the fallback. Commands are in section 8. Installing system packages needs `sudo`; if it prompts for a password, ask the user to run that one command.
- [ ] Each Linux failure is fixed at its cause (path separators, line endings, dialogs, timing) and rerun. Rerun the Windows gates after any change made for Linux.
- [ ] If Linux cannot be set up locally, say so in 6.1 and carry these checks into M5. Do not mark them done.

### M4 — Intermittent native tests

- [ ] Reproduce with repetition and `retries` 0: `npm run test:electron -- tests/electron/existing-behavior.spec.ts -g "measure connection setup" --repeat-each=30`, and `npm run test:electron -- tests/electron/history-reopen.spec.ts --repeat-each=30`.
- [ ] Write down the root cause of each. For the NetLog test, start from what it assumes: the second send reuses the first send's kept-alive socket, and no `restiprocity-netlog-*` file is left behind. Fix the product if the product is wrong and the test if the assumption is wrong.
- [ ] Evidence: 30 consecutive passes each. If a failure cannot be reproduced in 50 runs, record that and change nothing.

### M5 — CI before tagging (needs D5)

- [ ] `workflow_dispatch:` added under `on:` in `build-release.yml`, with no other change. `release` keeps its tag guard.
- [ ] **User**: push `primary`, then run "Build & Release" on `primary` from the Actions tab or with `gh workflow run "Build & Release" --ref primary`.
- [ ] `build` is green on all three systems; `test`, `updater-unit` and `engine-node-abi` are green; `release` is skipped. Failures are fixed locally, pushed by the user, and rerun.

### M6 — Release candidate

- [ ] Version per D4 in `package.json` and `package-lock.json`. `releases/v<version>.md` in the shape of `releases/v0.2.18.md` (New Features, Fixes, Platform Notes).
- [ ] The notes name what a v0.2.18 user will notice. Confirm each against v0.2.18 before writing it: a variable value that contains `{{other}}` now resolves; cycles, nesting deeper than 64 and oversized values stop a send with an error; requests that use the OAuth password grant stay readable but cannot fetch a token; environment secrets are stored as plain text; new history snapshots omit cookie values; OpenAPI import limits and what it skips; macOS and Linux remain manual downloads, and the Windows installer is unsigned.
- [ ] Upgrade check against a copy of the installed profile: collections, folders and environments load; the active environment is restored; old history entries open; a send works. Compare file hashes of the copy before and after startup and account for every rewritten file.
- [ ] Final gate (section 8) on Windows, including `npm run build`. The installer, blockmap and `latest.yml` carry the new version.
- [ ] **User**, recommended: run "Windows updater QA" (`update-qa.yml`) to prove a packaged update from one build to the next.

### M7 — Release (**User**)

- [ ] Final local commit, push `primary`, and a green CI run on that commit (the M5 procedure).
- [ ] Tag `v<version>` on that commit and push the tag. Watch the run through `release`.
- [ ] The GitHub release has the `.exe`, `.blockmap`, `latest.yml`, `.dmg` and `.AppImage`. An installed 0.2.18 on Windows offers and completes the update.
- [ ] If the tag run fails, stop and decide: fix forward with the next patch version, or remove the tag as with v0.2.17.

## 6.1 Completion evidence

Record per milestone: commands with pass, fail and skip counts; the names of the tests that failed first; what Linux and macOS turned up; links to CI runs.

**M0, 2026-11-10, commit `a8981f5` (OpenAPI) and `e21b76b` (this plan).** Baseline on the committed tree: `typecheck` passed; `test:engine` 380 passed, 10 skipped; `build:renderer` passed; `test` 156 passed; `test:electron` 23 passed, 1 skipped (the opt-in system clipboard test); `test:update` 7 passed. Not run: `test:engine:node-abi`, `build`.

**M1, 2026-11-10.** Realistic mocks: 6 E2E failures at first, of which 4 were a mistake in the new mock (a helper defined outside the function that is serialized into the page) and 2 were the Copy as cURL tests (R1); after the correction only those 2 failed. Native, before any fix: `sidebar-actions` "request rows offer Copy as cURL" failed with the menu `Rename, Duplicate, Export…, Delete` for a root request; `download-dialog-parent` failed with `{ argumentCount: 1, firstIsWindow: false }` (R2); `sidebar-actions` "folders and requests made with the sidebar controls appear, rename, duplicate and delete without a reload" passed, as a guard for D3. Gates for the M1 commit: `typecheck` passed; `test:engine` 380 passed, 10 skipped; `test` 156 passed (including 2 expected failures); `test:electron` 26 passed, 1 skipped (including 2 expected failures).

## 7. Acceptance matrix

| Outcome | Proof |
|---|---|
| A request row offers Copy as cURL in the real app | `tests/electron/sidebar-actions.spec.ts` passes, and failed before M2 |
| The mocks match the real bridge | No `type: 'request'` left in `tests/e2e`; D3 applied to the mock; E2E green |
| A cancelled send stops its token request | Engine test from M2 |
| The OAuth built-in check matches the binding key | Tests from M2 |
| The native suite is not Windows-only | TLS tests pass on Linux locally and on macOS in CI |
| CI can run without a tag | A green manual run with `release` skipped |
| No known intermittent native test | 30 consecutive passes each, or a recorded non-reproduction |
| A v0.2.18 profile survives the upgrade | M6 check recorded in 6.1 |
| Release assets satisfy the updater contract | "Validate release contract" passes in the tag run |

## 8. Commands and final gate order

Focused runs while iterating:

```powershell
npm run build:renderer
npm run test -- tests/e2e/collection-file-actions.spec.ts tests/e2e/collection-sidebar-fixes.spec.ts
npm run test:electron -- tests/electron/sidebar-actions.spec.ts
npm run test:engine -- tests/engine/requestEngine.auth.spec.ts tests/engine/oauthService.spec.ts
```

Final gate on Windows after the last application change:

```powershell
npm run typecheck
npm run test:engine:node-abi
npm run test:update
npm run build:renderer
npm run test
npm run test:electron
npm run build
```

Browser E2E serves the built `dist/`, so build first. `test:engine:node-abi` rebuilds better-sqlite3 for host Node and restores the Electron ABI afterwards; the native run that follows proves the restoration. Close a running copy of the app before it, because the app locks the binding.

Linux, in bash, inside the Linux-side clone:

```bash
npm ci
npx playwright install chromium --with-deps
npm run build:renderer && npm test
npm run test:engine:node-abi
xvfb-run -a npm run test:electron
```

## 9. Completion record and continuation prompt

Record results here or link local evidence: final diff; commands with counts; findings added as R7 onwards; what ran on Linux and macOS; CI run links; the release link. Update the status line only when evidence exists.

Suggested instruction for the implementing model:

> Implement RELEASE_READINESS_PLAN.md from M0 through M4. Read AGENTS.md and HANDOFF.md and inspect the working tree first. In M1 change tests only, and record what fails before touching application code. Use the recommended options in section 4 unless the user has answered otherwise; D1 and D5 are theirs. Stop after M4 with the workflow change for M5 prepared but not pushed, update HANDOFF.md, and report what failed first, what was fixed, what ran on Linux, and what still needs the user. Do not commit, push, tag, publish, or run a GitHub workflow unless asked.

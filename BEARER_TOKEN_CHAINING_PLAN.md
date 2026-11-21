# Bearer token request chaining: work-package plan

Prepared 2026-11-19 against `primary` at `94fc3b6`. Status: approved plan; no package has started.
This document lives on the branch `claude-bearer-token-request-chaining`, in the worktree
`.worktrees/claude-bearer-token-request-chaining` (§12). It is written so that each work package (WP) can go to a smaller
model with only this document, `AGENTS.md`, and the files that package owns.
A second read-only pass checked every file and line claim against the code. The corrections it found are folded in below.

## Context

APIs commonly need a login or token call (a GET or POST) before any other call, and every other request then sends the
returned token as `Authorization: Bearer …`. Today the user has to send the login request, copy the token out of the
body, paste it into an environment variable, and repeat that when it expires. The goal: the token request's response
feeds a variable (`{{api_token}}`). Any request that uses it gets a current value automatically. When the value is older than the
refresh interval (default 3600 s), the app runs the token request again before sending the child.

Decisions the user made (2026-11-19):
- **The link lives on the token request** ("Outputs"). Any request can use `{{api_token}}`.
- **A token is stale** after the configured interval, or sooner when the token response's `expires_in` says so.
- **On HTTP 401** with a cached token, the app fetches a new token and **resends the child once automatically**.
- **Memory only**: fetched values are never written to disk and a restart starts with an empty cache.

What the code gives us (verified):
- Sends resolve variables in the **main process** (`RequestEngine.resolveVariables`, `src/main/engine/requestEngine.ts:1211`)
  through `createVariableContext` (`src/shared/variableContext.ts`). It already supports ordered layers (the last layer wins)
  and sensitivity tracking.
  - `resolveRequestFields` (`src/shared/requestInterpolation.ts:35`) resolves only the fields a send uses.
  - It calls only `context.resolve` and `context.interpolateString`, never `interpolate`.
- `OAuthService` (`src/main/oauth/oauthService.ts`) is the existing pattern for an in-memory token cache: a pending promise
  shared between callers, a generation counter for late results, and tokens kept out of IPC, history and errors.
- **Blocker 1:** `RequestEngine` has one `abortController` field (`requestEngine.ts:212`), used by the V2 path at 239-240,
  402 and 588, 860, 1243, 1247, and by the legacy path at 412-413, 486, 618 and 631. Running the token request through the
  engine during a child send would overwrite it. WP-C fixes this first.
- **Blocker 2:** progress never reaches the window. The coordinator passes `onProgress` as a third argument
  (`src/main/ipc/handlers.ts:445`), but `executeV2(payload, parentWindow)` drops it, and the runtime's `emitProgress`
  does nothing (`requestRuntimeAdapters.ts:191`). WP-C fixes this too. One visible side effect: the in-flight overlay
  starts showing "Receiving response preview…".
- The renderer has **no shared collection tree**. Full `Request` objects live only in Sidebar's local state
  (`Sidebar.tsx:648-687`). Renderer code that needs output names reads `window.api.collectionList()` instead.
- Production uses the `net` transport (`requestRuntimeAdapters.ts:168`). The `fetch` transport is reached only in tests.

Another untracked draft, `REQUEST_CHAINING_PLAN.md`, is in the main checkout. It was written by a different model working on
the same request. This plan is independent of it. Do not merge or edit that file.

---

## 1. Rules for every worker

1. Read `AGENTS.md` first. `HANDOFF.md` is git-ignored and exists only in the main checkout, so record progress in
   §11 of this file instead.
2. Work on your own branch `chaining/wp-<id>`, cut from `claude-bearer-token-request-chaining` after the packages you
   depend on are merged. Commit locally. **Never push**, and do not tag or open PRs; the user does release actions.
3. Edit only the files your package **owns**. If you need a change in a file you don't own, stop and report it instead
   of making it. New test files you create are yours.
4. Treat the contract in §4 as frozen. If something in it is wrong, report it; don't change it on your own.
5. Never put a fetched value in: IPC results, progress events, error messages, logs, history rows, request or
   environment files, renderer `localStorage` drafts, or exports. The only places a value may appear are the outgoing
   request, the main-process cache, and a Copy as cURL the user has confirmed.
6. `tsconfig` covers `src/` only, so test files are **not typechecked**. Many engine tests pass partial fake stores
   (only `getActiveEnvironmentId`/`getEnvironment`). Code you add must tolerate a missing optional store method.
7. Every package leaves `npm run typecheck` and its focused tests passing. Finish with the §10 report.

## 2. Scope

**Included**
- Outputs on a saved request: up to 10 named values taken from a JSON field (RFC 6901 pointer), a response header,
  or the whole body.
- Lazy refresh. Values are fetched when a request that uses them is sent and the cached value is missing or stale.
  The cache is kept per environment and in memory only.
- When an output is used, it resolves anywhere a variable resolves (Bearer token, headers, query, body, URL).
- Resend once after HTTP 401 when the token came from the cache.
- Sending the token request yourself also fills the cache.
- Copy as cURL uses a fresh cached value after the usual confirmation. It never runs the token request.
- An Outputs tab on the request, status and Clear, an "acquiring token" progress phase, and response notes.

**Deferred**
- Chains with more than one hop: a token request may not use another request's output.
- Scheduled or background refresh.
- Tokens persisted to disk.
- JSONPath, and outputs scoped to a folder or an environment.
- Converting Postman scripts.
- Following cross-origin redirects for a request that uses an output.
- Insomnia `{% response %}` conversion is optional WP-I (done; see §11).

## 3. User workflow and acceptance example

1. Create a request **Get session token**: `POST {{auth_base}}/oauth/token` with a JSON body that uses `{{client_secret}}` (a Secret).
2. On its **Outputs** tab:
   - Turn on **Use the response as variables**.
   - Add the row `api_token` ← **JSON field** `/access_token`.
   - Set **Refresh after** to `3600` s.
   - Leave **Expiry field** at its default `/expires_in`.
   - Leave **After HTTP 401, get a new token and resend once** on.
3. On **List orders** and **Create order**, set Auth → Bearer → Token to `{{api_token}}`.
4. Send **List orders**. The overlay reads "Getting token from “Get session token”…". The app runs the token request
   and then sends the child with exactly one `Authorization: Bearer <token>`.
   - **Create order**, sent 3,599 s later, reuses the token.
   - At 3,600 s, or sooner if `expires_in` was shorter, the next send fetches a new token first.
   - An idle hour produces no traffic.
5. If the server revokes the token early, the child gets 401. The app fetches a new token and resends once. The response
   shows "Got HTTP 401, so a new api_token was fetched and the request was sent again."
6. Switching from Staging to Production uses a separate token. After a restart, the first send fetches again.
7. Sending **Get session token** yourself shows its response as usual and notes "Outputs updated: api_token".
   Its body is **not** saved to history, to the request file, or to the renderer's draft storage.

## 4. Frozen contract

```ts
// src/shared/types/index.ts — additions (WP-A)
export type RequestOutputSource =
  | { kind: 'json'; pointer: string }   // RFC 6901 pointer into the JSON body; '' = the whole document
  | { kind: 'header'; name: string }    // response header, case-insensitive, first occurrence
  | { kind: 'body' };                   // whole decoded body text, trimmed
export interface RequestOutputValue { name: string; source: RequestOutputSource }
export interface RequestOutputs {
  enabled: boolean;                 // turning off keeps the definition, so the rows come back when it is turned on again
  values: RequestOutputValue[];     // 1..10 when enabled (0 allowed when disabled); names unique
  refreshAfterSeconds: number;      // integer 1..31_536_000; default 3600
  expiresInPointer: string | null;  // pointer to a seconds value; null = ignore response expiry; default '/expires_in'
  resendOn401: OutputResendOn401;   // 'off' | 'safe-methods' | 'any-method'; default 'safe-methods' (was boolean, see §11 2026-11-20)
}
// interface Request gains:     outputs?: RequestOutputs;

export type TokenErrorCode =
  | 'TOKEN_SOURCE_MISSING'   // outputs providing {{x}} are turned off
  | 'TOKEN_SOURCE_INVALID'   // stored outputs fail validation
  | 'TOKEN_SOURCE_CHAINED'   // a request with outputs uses an output (its own or another's)
  | 'TOKEN_SOURCE_FAILED'    // transport/TLS/timeout while running the token request, or values cleared mid-fetch
  | 'TOKEN_SOURCE_HTTP'      // token request returned a non-2xx status
  | 'TOKEN_SOURCE_NOT_TEXT'  // download, truncated, undecodable or (when a body is needed) empty body
  | 'TOKEN_EXTRACT_FAILED'   // field missing, wrong type, or unsafe value
  | 'TOKEN_NOT_FETCHED';     // Copy as cURL with no fresh cached value

export type ResponseOutputsNoteV2 =
  | { kind: 'updated'; names: string[] }             // manual send of a token request filled the cache
  | { kind: 'not-updated'; message: string }         // manual send; extraction failed or non-2xx
  | { kind: 'resent-after-401'; names: string[] };   // child was resent once with refreshed outputs
// ResponseV2 gains (PersistedResponseV2 inherits): outputsNote?: ResponseOutputsNoteV2; bodyWithheld?: 'outputs';
// ResponseProgressPhaseV2 gains 'acquiring-token' | 'waiting-headers';  ResponseProgressV2 gains tokenSource?: string
// src/renderer/stores/index.ts RequestFlightPhase gains 'acquiring-token' (one line; WP-A)

export interface RequestOutputStatus {
  requestId: Id; environmentId: Id;              // canonical environment the status is for
  state: 'empty' | 'fresh' | 'stale' | 'fetching' | 'failed';
  names: string[];                               // enabled output names; never values
  fetchedAt?: number; refreshAt?: number;        // wall-clock ms
  error?: { code: TokenErrorCode | null; message: string };
}
export interface OutputsStatusPayload { requestId: Id; environmentId?: Id }
export interface OutputsClearPayload { requestId: Id }
```

```ts
// src/shared/requestOutputs.ts — pure helpers, no Node/Electron imports (WP-A)
export const OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;  // matches the `_.name` shorthand charset
export const RESERVED_OUTPUT_NAMES: ReadonlySet<string>;              // timestamp, randomInt, uuid
export const OUTPUT_PLACEHOLDER = 'restiprocity-output-placeholder';  // non-empty, contains no "{{"
export const OUTPUT_LIMITS: { maxValues: 10; minRefreshSeconds: 1; maxRefreshSeconds: 31_536_000; maxValueChars: 65_536 };
export function defaultRequestOutputs(): RequestOutputs;             // api_token ← json /access_token, 3600, '/expires_in', true
export function validateRequestOutputs(value: unknown): { ok: true; outputs: RequestOutputs } | { ok: false; message: string };
export function parseJsonPointer(pointer: string): string[];        // throws OutputDefinitionError; '' → []
export function readJsonPointer(document: unknown, tokens: readonly string[]): unknown; // own props only; undefined if absent
export function siblingPointer(pointer: string, name: string): string;
export function extractOutputValues(
  response: { status: number; headers: Header[]; bodyText: string | null },  // null = no usable text body
  outputs: RequestOutputs,
): { ok: true; values: Record<string, string>; expiresInSeconds?: number } | { ok: false; code: TokenErrorCode; message: string };
export function computeOutputTtlMs(refreshAfterSeconds: number, expiresInSeconds?: number): number;
export function withholdOutputsBody<T extends ResponseV2 | PersistedResponseV2>(response: T, outputs: RequestOutputs): T;
export function enabledOutputNames(request: Pick<Request, 'outputs'>): string[];
```

```ts
// src/main/outputs/requestOutputService.ts — no Electron imports, no timers (WP-D)
export interface OutputBinding { requestId: Id; environmentId: Id | undefined; fingerprint: string;
  names: readonly string[]; refreshAfterSeconds: number }
export interface ProducerResult { values: Record<string, string>; expiresInSeconds?: number }
export interface AcquiredOutputs { values: Readonly<Record<string, string>>; fromCache: boolean; generation: number }
export class RequestOutputService {
  constructor(deps: { clock: { wallNow(): number; monotonicNow(): number }; maxEntries?: number /* 100 */ });
  acquire(b: OutputBinding, o: { signal: AbortSignal; run: (signal: AbortSignal) => Promise<ProducerResult> }): Promise<AcquiredOutputs>;
  peek(b: OutputBinding): AcquiredOutputs | null;              // fresh + same fingerprint only; never calls run
  invalidate(b: OutputBinding, generation: number): void;      // drops the entry only if it still has that generation
  seed(b: OutputBinding, result: ProducerResult): AcquiredOutputs;
  status(b: OutputBinding): RequestOutputStatus;
  clear(requestId: Id): void;    // all environments; in-flight fetch aborted; its waiters reject with TOKEN_SOURCE_FAILED
  clearAll(): void;
}
// src/main/outputs/producerFingerprint.ts (WP-D)
export function computeProducerFingerprint(input: { saved: Request; resolved: Request; environmentId: Id | undefined }): string;
```

```ts
// RequestEngine (WP-C adds the context; WP-E1 adds output support)
export interface ExecutionContext {
  signal: AbortSignal;
  purpose: 'send' | 'token';
  protectCredentialsOnRedirect: false | 'oauth' | 'output';   // 'oauth' wins when both apply (keeps its message)
  onProgress?: (event: RequestProgressEvent) => void;
}
executeV2(payload: IpcRequestPayload, parentWindow?: BaseWindow, onProgress?: (e: RequestProgressEvent) => void): Promise<ResponseV2>;
executeInternal(request: Request, environmentId: Id | undefined, context: ExecutionContext, parentWindow?: BaseWindow): Promise<ResponseV2>; // main-process only, never on IPC
getOutputStatus(requestId: Id, environmentId?: Id): Promise<RequestOutputStatus>;   // WP-E1; reads files, never the network
// RequestProgressEvent (requestRuntimeAdapters.ts) gains tokenSource?: string (WP-C)
```

- **IPC.** Channels `outputs:status` (`OutputsStatusPayload` → `RequestOutputStatus`) and `outputs:clear`
  (`OutputsClearPayload` → `void`), registered through `handle`. Preload adds `window.api.outputsStatus` and `window.api.outputsClear`.
- **CollectionStore additions (WP-B):**
  - `getOutputIndex(): Promise<ReadonlyMap<string, { requestId: Id; enabled: boolean }>>`. Enabled names are unique.
    A disabled name is listed only when no enabled output has that name; the lowest request ID wins.
  - `onRequestRemoved(listener: (id: Id) => void): () => void`.

## 5. Behavior rules

### Precedence and resolution
- Outputs form one variable layer placed **after** the environment layers and **before** built-ins. If an environment
  also defines `api_token`, the fetched value wins and the Outputs tab warns about it. This handles the common migration
  from a hand-pasted `api_token` safely. The layer lists every name in the output index (enabled or disabled), so a
  disabled source is noticed instead of the placeholder being sent as written.
- Output values are **literal**: never scanned for `{{…}}`. They are always **sensitive**, so the URL preview masks them
  and Copy as cURL asks for confirmation.
- A send resolves in **two passes**, using one set of built-ins for both passes and for the resend:
  1. **Discovery.** Resolve with every output set to `OUTPUT_PLACEHOLDER` and observe which keys were used
     (`observeDependencies`). The placeholder is non-empty because whether a field is resolved can depend on the value
     being empty (bearer token, parameter key, api_key). Because only fields that are used get resolved, a disabled header
     or an inactive auth branch never triggers a fetch.
  2. **Acquire, then resolve again.** If a name maps to a disabled entry, fail with `TOKEN_SOURCE_MISSING`. Otherwise
     acquire each token request that was used, in sorted request-ID order, then resolve again with the real values.
- A request with enabled outputs may not use any output, its own included. That is a `TOKEN_SOURCE_CHAINED` error, both
  when it is sent directly and when it runs as a token request.
- **Deleted token request.** Its names leave the index, so `{{api_token}}` becomes an unknown variable and is sent as
  written, like any undefined variable today (`variableContext.ts:74-76`). This is documented, not an error.

### Cache identity and freshness
- The cache key is `(token request ID, canonical environment ID)`. The canonical environment is the one the send named,
  or else the active one.
- `fingerprint` is a SHA-256 over a per-process random salt plus a stable (key-sorted) JSON of three things:
  - the **saved** token request's `method, url, headers, parameters, body, auth, settings, outputs`;
  - the same request **resolved** with fixed built-ins (`timestamp: 0, randomInt: 0, uuid: 00000000-0000-0000-0000-000000000000`);
  - the environment ID.

  So editing the token request, its outputs, or any variable it uses (a password, say) causes a new fetch.
  Unrelated edits keep the cache.
- An entry is fresh when all of these hold:
  - the fingerprint matches;
  - `wallNow >= fetchedWall` (a clock that went backwards means stale);
  - `wallNow - fetchedWall < ttl`;
  - `monotonicNow - fetchedMono < ttl`.

  Equality counts as stale (3600 s is stale; 3599.999 s is fresh).
- `ttl = computeOutputTtlMs(refresh, expiresIn)`. That is
  `min(refresh·1000, expiresIn·1000 − min(30 000, expiresIn·100))`, never below 1000 ms. A missing, non-integer or
  non-positive `expires_in` (a number or a digit string) is ignored, not treated as an error.
- Concurrent requests for the same key share one fetch. A caller's abort detaches only that caller, and the fetch is
  aborted when the last caller leaves.
  - `clear` aborts any in-flight fetch and rejects its waiters with `TOKEN_SOURCE_FAILED`: "Cached values for “X” were
    cleared while fetching. Send again."
  - `clear` and `invalidate` bump the generation, so a late result never fills the cache.
  - A failure stores `lastError` for `status` and nothing else: there is no fallback to an old value.
  - At most 100 entries are kept, evicting the least recently used entry that isn't pending. No timers are used.

### Running the token request
- The token request is the **saved** version, loaded with `CollectionStore.getRequest`, and runs through the same engine
  core as a normal send (`executeInternal`, `purpose: 'token'`). Its TLS, proxy, redirect, cookie, timeout and auth
  settings behave exactly as when you send it yourself. A token-purpose run:
  - starts no NetLog timing capture;
  - emits no progress;
  - never opens a Save dialog: a response classified as a download fails with `TOKEN_SOURCE_NOT_TEXT`;
  - when the request's timeout is `0`, has a 30 s ceiling.
- Extraction requires a 2xx status, otherwise `TOKEN_SOURCE_HTTP` with the message
  `Couldn't get {{api_token}}: "Get session token" returned HTTP 403.`. Then:
  - JSON and body sources need a complete, untruncated text preview. A request with only header sources may return an empty body.
  - Values must be strings, non-empty after trimming, at most 65,536 characters, with no characters U+0000–U+001F or U+007F.
- **Error text.** `TOKEN_*` errors keep **their own** message. Unlike `OAUTH_*` (`requestErrors.ts:36-45`), the message is
  not replaced with generic text. Messages name the output, the token request and the pointer, never a value, a body
  or a resolved URL.
  - A transport failure becomes `TOKEN_SOURCE_FAILED`:
    `Couldn't get {{api_token}}: "Get session token" failed (<kind>, <code>).` Use the error's kind and code, not its
    message, which can contain the token URL.
  - A cancel is rethrown as a plain `AbortError`, so the token request's `RequestFailureError` (which carries its URL)
    never reaches the child.
- No token response is written to history or to `lastResponse`, and none is returned over IPC.

### Children
- Outputs are acquired after discovery and before headers are built. After acquiring, the engine emits `waiting-headers`
  so the overlay stops saying "Getting token…". NetLog capture already starts after headers (`requestEngine.ts:257`).
- A child that used any output gets `protectCredentialsOnRedirect: 'output'` (or `'oauth'`, which takes priority).
  - On `net` (production), redirects are followed only within the same origin and never from HTTPS to HTTP, reusing the
    existing guard (`oauthOrigin` = origin of the request URL, `requestEngine.ts:662, 909`). The block message is
    `Request failed: redirect to <url> was blocked because the request carries a fetched token`.
  - On `fetch` (test-only), redirects are not followed and the 3xx is returned, as OAuth does today.
- **401 resend.** The child is resent once when **all** of these hold:
  - the final status is 401;
  - the child's auth is not `ntlm`;
  - this is the first attempt;
  - at least one token request the child used came **from the cache** in this attempt and its `resendOn401` allows the
    child's method (`safe-methods`: GET, HEAD, OPTIONS; `any-method`: all; `off`: none).

  The resend works like this:
  1. Close the 401 response without reading its body, and finish and discard its timing capture.
  2. `invalidate` those token requests using the generation that was used, then `acquire` them again.
  3. Resolve again with the same built-ins. For multipart, create a **new** `MultipartOperation`, because
     `headersReceived()` cleared the first one's deadline (`multipartOperation.ts:24-32`), and prepare the body again.
  4. Rebuild the headers, open once more, and set `outputsNote: { kind: 'resent-after-401', names }` on the final response.

  If fetching the token again fails, the send fails with that token error. A value fetched fresh in this send that
  still gets 401 is returned as-is (no loop).
- **Manual send of a token request.** Treat `payload.request.outputs` as untrusted and run `validateRequestOutputs`
  first; if it's invalid or off, behave as an ordinary request. The normal path applies (the viewer shows the body).
  - After a 2xx text response, extract and `seed` the cache, using a binding computed from the request object that was
    sent, and set `outputsNote: updated`.
  - When extraction fails, the send still succeeds and the note is `not-updated`.
- **Where a token request's response is withheld.** Three places run `withholdOutputsBody`: an empty preview, any header
  that is an output source dropped, and `bodyWithheld: 'outputs'`.
  - History snapshots (coordinator): when the validated payload outputs are enabled, or when `outputsNote` is `updated` or `not-updated`.
  - `lastResponse` on disk (store).
  - Renderer drafts in `localStorage` (`projectRequestDraft`, `stores/index.ts:199-204`).

  The live response in the viewer keeps its body in memory.
- **Copy as cURL.** `resolveVariables` gets an explicit `'curl'` mode. It runs discovery, then calls `peek` for each
  token request. If the value is fresh, it goes through the existing sensitive confirmation (`handlers.ts:658-669`).
  If not, the copy fails with `TOKEN_NOT_FETCHED`:
  `{{api_token}} hasn't been fetched for this environment yet. Send "Get session token" or a request that uses it, then copy again.`
  The copy never makes a network call.
- The legacy `execute()` path (only characterization tests reach it) refuses a request that uses outputs with
  `TOKEN_SOURCE_FAILED`. It never sends the placeholder.

### Store and portability
- Saves are validated with `validateRequestOutputs`. Enabled names must be unique across the collection; on a clash
  the error is `"api_token" is already an output of "Other request". Choose another name.`
- Duplicating a request copies its outputs with `enabled: false`. Removing a request file fires `onRequestRemoved`.
  There is no group cascade: deleting a folder leaves its request files, which is existing behavior.
- Native export includes `outputs`, without values. Import works like this:
  - `parseRequest` passes the raw value through, and `importBundleUnlocked` validates it.
  - An invalid definition is dropped with a warning.
  - A clash with an existing output, or with another imported one, is imported with `enabled: false` and the warning
    `Outputs on "X" were turned off because {{api_token}} is already provided by "Y".`
- No bundle version change is needed: older versions rebuild requests field by field (`collectionExport.ts:65-92`)
  and silently drop `outputs`.

---

## 6. Integration points (verified)

| File | Today | Change (owner) |
|---|---|---|
| `src/shared/types/index.ts` | shared types; progress phases at l.321 | §4 types (A) |
| `src/shared/variableContext.ts` | layers; `secret` and `confidential` are sensitive (l.102); expand at l.101 | `literal`, `output` is sensitive, `observeDependencies` (A) |
| `src/shared/responseContracts.ts` | all three converters rebuild through `basePersistedResponse` (l.284-303) | pass `outputsNote` and `bodyWithheld` through (A) |
| `src/renderer/stores/index.ts` | `RequestFlightPhase` l.279-288; `projectRequestDraft` l.199-204 (drafts in localStorage) | phase line (A); withhold drafts (G1) |
| `src/main/stores/collectionStore.ts` | create l.116, update l.153 (update-as-create lists fields), delete l.183 and `delete(id)` l.1165, duplicate l.1176, imports l.739-867; the queue can't be re-entered | outputs persistence, index, withheld `lastResponse`, removal hook (B) |
| `src/main/stores/collectionExport.ts` | `parseRequest` rebuilds field by field (l.65-92) | pass raw `outputs` through (B) |
| `src/main/engine/requestEngine.ts` | single `abortController`; `resolveVariables` l.1211; cURL l.495-505; redirect guard l.522/662-668/811/909-915 | execution context (C); outputs (E1); 401 resend and manual send (E2) |
| `src/main/engine/requestRuntimeAdapters.ts` | `RequestProgressEvent` l.104-109; `emitProgress` does nothing | add `tokenSource?` (C) |
| `src/main/engine/requestErrors.ts` | `OAUTH_*` codes get a generic message | `TOKEN_*` maps to `authentication` and keeps its message (E1) |
| `src/main/ipc/handlers.ts` | history save l.464; progress forward l.396-436; history projection l.71-99 and l.262-337 | withholding, explicit progress mapping, `bodyWithheld` projection, `outputs:*` (F) |
| `src/main/stores/historyStore.ts` | `saveSnapshot` l.210, `getEntry` l.316, schema version l.15 | nullable `body_withheld` column (F) |
| `src/preload/index.ts`, `src/main/index.ts` | whitelist; stores l.140-148, engine l.149-151, IPC l.159-166, before-quit l.204 | `outputs:*` methods; service wiring (F) |
| `src/renderer/components/RequestEditor.tsx` | tab union l.335, tabs l.636; `normalizeRequestShape` l.95; save l.413-434 (fire-and-forget); preview l.521; Bearer l.1237 | Outputs tab (G1); preview, autocomplete, Bearer (G2) |
| `src/renderer/components/RequestInFlight.tsx` | `PHASE_LABELS` l.5-15 | `acquiring-token` label (G2) |
| `src/renderer/components/ResponseViewer.tsx` | history notice l.185-191; body l.204 | `outputsNote` and `bodyWithheld` notes (G2) |
| `tests/e2e/fixtures/mockApi.ts` | mocked `window.api` | `outputsStatus`/`outputsClear` (G1, then G2) |
| `tests/electron/fixtures/nativeServers.ts` | loopback HTTP fixture | `/token`, `/protected`, `/revoke` routes (H) |

Reuse:
- the own-property pointer walk in `openapiReferences.ts:23-50`, as a pattern only;
- `isStorableId` for payloads;
- the `handle` wrapper;
- `InterpolatedTextInput` (`RequestEditor.tsx:159`);
- `installMockApi`;
- `launchApp`/`closeApp` and `startHttpFixture`.

**Do not import `src/shared/oauth.ts` into `requestOutputs.ts`.** It imports `node:crypto` (l.1), which would pull Node
into the renderer bundle. Reimplement the small `parseExpiresIn`/`isSafeToken` checks locally.

---

## 7. Work packages

Size: **S** small model, **M** careful mid-size model, **L** strongest model available.

### WP-A: Shared contract and pure helpers (S–M) · depends on nothing
- **Owns:** `src/shared/types/index.ts` (additions), new `src/shared/requestOutputs.ts`, `src/shared/variableContext.ts`,
  `src/shared/responseContracts.ts`, and the single `RequestFlightPhase` line in `src/renderer/stores/index.ts`.
- **Tests:** new `tests/engine/requestOutputs.spec.ts`; extend `variableContext.spec.ts` and `responseContracts.spec.ts`.
- **Steps:**
  1. Add the §4 types.
  2. Implement `requestOutputs.ts`.
     - Pointer rules: `''` or starting with `/`, decode `~1` then `~0`, reject any other `~` escape, array indexes match `^(0|[1-9]\d*)$`.
     - Header lookup is case-insensitive and takes the first occurrence. `body` trims surrounding whitespace.
     - JSON is parsed at most once, and only when needed.
  3. `variableContext.ts`:
     - A `literal?: boolean` item is used verbatim at l.101, with depth 0 and no dependencies.
     - `type === 'output'` is sensitive at l.102.
     - Add `observeDependencies(context, onKeys)`, modelled on `observeSensitivity`. Nested keys are already in `dependencies`.
  4. Add the two fields to `basePersistedResponse`, so they are kept and validated.
- **Done when:**
  - pointer cases pass: `''`, `/a~1b`, `/a~0b`, `/0`, `/01` (rejected), and `__proto__` and inherited properties (absent);
  - a non-2xx status returns `TOKEN_SOURCE_HTTP`, and wrong types and unsafe values return `TOKEN_EXTRACT_FAILED`;
  - `computeOutputTtlMs` gives `(3600)` → 3,600,000; `(3600, 600)` → 570,000; `(3600, 0)` → 3,600,000; a 1000 ms floor;
  - a literal value containing `{{x}}` is not expanded;
  - an output layer placed last beats an environment value;
  - `withholdOutputsBody` empties the preview and drops source headers;
  - `npm run typecheck` passes and the existing variableContext and responseContracts tests are green.

### WP-B: Persistence and portability (M) · depends on A
- **Owns:** `src/main/stores/collectionStore.ts`, `src/main/stores/collectionExport.ts`.
- **Tests:** new `tests/engine/collectionStore.outputs.spec.ts`.
- **Steps:**
  1. Carry `outputs` through create, update (including the update-as-create field list), duplicate (`enabled: false`)
     and import. Validate on every write.
  2. Index: a private `outputIndexUnlocked()` builds lazily from `loadCollectionItems` and is cached. Never call public
     queued methods from inside the queue: it deadlocks (`collectionMutation.ts:27-35`). Update or reset the index in:
     - `createRequestUnlocked`, `updateRequestUnlocked`, `deleteRequestUnlocked`, `delete(id)`, `duplicateUnlocked`;
     - `importBundleUnlocked` and `importUnlocked` (after commit or rollback).

     The public `getOutputIndex()` wraps it in the queue.
  3. When a request with enabled outputs is saved, pass `lastResponse` through `withholdOutputsBody`.
  4. `onRequestRemoved`: fire after a request file is removed (`deleteRequestUnlocked`, `delete(id)`). Do not add a group cascade.
  5. Export includes `outputs`. `parseRequest` passes the raw value through; `importBundleUnlocked` validates it, drops
     invalid definitions with a warning, and turns off clashes with the §5 warning.
- **Done when:**
  - create, update and reload keep the definition, and update-as-create keeps it;
  - a duplicate enabled name is refused, and disabling the other request's output frees it;
  - turning outputs off and on keeps the rows;
  - the index lists disabled names per §4;
  - a duplicate's outputs are off, and a delete fires the listener;
  - `lastResponse` keeps no body;
  - importing a bundle whose request has outputs that clash with an existing request's outputs → imported turned off, with the warning;
  - an invalid definition is dropped with a warning, and a rollback leaves the files byte-identical;
  - all existing `collectionStore.*` tests pass.

### WP-C: Engine execution context (L; behavior must not change) · depends on nothing; start immediately
- **Owns:** `src/main/engine/requestEngine.ts`, `src/main/engine/requestRuntimeAdapters.ts` (`tokenSource?` only).
- **Tests:** new `tests/engine/requestEngine.executionContext.spec.ts`.
- **Steps:**
  1. Move the body of `executeV2` into `executeInternal(request, environmentId, context, parentWindow)`.
     - `executeV2` keeps lines 239 and 402: it creates and clears `this.abortController`.
     - It builds the context: `purpose: 'send'`; `protectCredentialsOnRedirect: auth.type === 'oauth2' ? 'oauth' : false`;
       `onProgress` is the third argument, otherwise `this.runtime.emitProgress`.
     - Inside `executeInternal`, `operationSignal` is `context.signal`, used at today's l.245, 247, 302 and 346. It never
       reads or writes `this.abortController`.
  2. Pass `context` through these private methods so none of them reads the field:
     - `buildHeaders` (538) → `applyAuthHeaders` (563, l.588);
     - `openFetchResponseV2` (800) → `createRequestSignal` (1241);
     - `openNetResponseV2` (842, l.860).

     Legacy `execute()` builds its own context and passes it through `buildFetchOptions` (516) and `executeNetRequest`
     (597, including the field clearing at 631).
  3. Replace the `auth.type === 'oauth2'` redirect conditions (522, 662-668, 811, 909-915) with
     `context.protectCredentialsOnRedirect !== false`. For `'oauth'`, keep today's message byte for byte. For `'output'`,
     use the §5 message.
  4. Route every V2 `emitProgress` through `context.onProgress`.
  5. `purpose: 'token'`: skip `startConnectionTimingCapture`, emit no progress, and make `onDownload` throw
     `code = 'TOKEN_SOURCE_NOT_TEXT'` without calling `showSaveDialog`. Use a 30 s timeout when `settings.timeout === 0`.
- **Done when:**
  - every `requestEngine.*`, `ipcResponseLifecycle`, `oauth*`, `netLogTimings` and `curlExport` suite passes **unchanged**;
  - new tests show:
    - two overlapping `executeInternal` calls abort independently;
    - `cancel()` aborts only the UI operation;
    - `executeV2(…, spy)` delivers `receiving` progress;
    - a token-purpose run never calls `captureConnectionTimings` or `showSaveDialog` and emits no progress;
    - `'output'` protection on net blocks a cross-origin redirect with the new message, and `'oauth'` keeps the old one.

### WP-D: Output cache service (M) · depends on A
- **Owns:** new `src/main/outputs/requestOutputService.ts`, `src/main/outputs/producerFingerprint.ts`.
- **Tests:** new `tests/engine/requestOutputService.spec.ts`.
- **Steps:** implement §4 and §5 ("Cache identity and freshness") with an injected clock: no Electron imports, no timers.
  The salt is `crypto.randomBytes(32)`, created once per module load. Use a key-sorted stable stringify.
- **Done when** fake-clock tests show:
  - fresh at 0 s and 3599.999 s; stale at exactly 3600 s;
  - `expires_in: 600` → stale at 570 s;
  - a wall clock moved backwards → stale; monotonic elapsed time over the TTL with a frozen wall clock → stale;
  - a fingerprint mismatch → fetch again, and the old value is never returned;
  - two callers share one `run`; aborting one leaves the other waiting, and aborting both aborts `run`;
  - `clear` during a fetch → waiters reject with `TOKEN_SOURCE_FAILED` and the late result is discarded;
  - `invalidate` with an old generation does nothing;
  - a failure → `status` is `failed` and the next `acquire` tries again;
  - a cap of 100 entries with least-recently-used eviction;
  - `peek` never calls `run`;
  - the fingerprint is the same for equal input and different when a resolved field, the outputs or the environment changes.

### WP-E1: Engine integration of outputs (L) · depends on A, C, D (B's index is faked in tests)
- **Owns:** `src/main/engine/requestEngine.ts`, `src/main/engine/requestErrors.ts`.
- **Tests:** new `tests/engine/requestEngine.outputs.spec.ts`; extend `curlExport.spec.ts`.
- **Steps:**
  1. Add an optional `outputService` constructor parameter, appended last. No test passes more than 5 arguments today.
     It defaults to a new service using the runtime clock. If `collectionStore.getOutputIndex` isn't a function,
     use an empty index.
  2. Rewrite `resolveVariables` with modes `'send' | 'curl' | 'token'` and the two-pass flow from §5.
     - Add a `prepareBinding(tokenRequest, environmentId)` helper. It resolves the request with fixed built-ins and the
       placeholder layer, refuses chains, and computes the fingerprint.
     - Emit `acquiring-token` (with `tokenSource` and the **child's** `requestId`, which the coordinator filters on,
       `handlers.ts:406`) only when `peek` misses. Emit `waiting-headers` after acquiring.
  3. `runProducer`: call `executeInternal(saved, env, { signal, purpose: 'token', protectCredentialsOnRedirect: saved.auth.type === 'oauth2' ? 'oauth' : false })`,
     then `extractOutputValues`. Map failures to the §4 codes and §5 messages, and rethrow a cancel as a plain `AbortError`.
  4. Children that use outputs get `'output'` protection, unless the auth is OAuth.
  5. Copy as cURL: peek only, and fail with `TOKEN_NOT_FETCHED` when nothing is fresh. The legacy `execute()` refuses
     a request that uses outputs.
  6. Add `getOutputStatus`, built from `prepareBinding` and `service.status`. It makes no network calls.
  7. `requestErrors.ts`: `TOKEN_*` maps to `kind: 'authentication'` and keeps the thrown message. `retryable` is true
     for `TOKEN_SOURCE_FAILED` and `TOKEN_SOURCE_HTTP`.
- **Done when:**
  - on both transports:
    - a cold child send makes 1 token call and 1 child call with exactly one `Authorization: Bearer tok-1`;
    - a second child makes 0 token calls;
    - with a fake clock, a send at 3600 s fetches again;
  - a disabled header that uses `{{api_token}}` causes no token call;
  - an overridden auth header containing a cycle is ignored;
  - token request results: 500 → `TOKEN_SOURCE_HTTP` and 0 child calls; missing field → `TOKEN_EXTRACT_FAILED`;
    outputs off → `TOKEN_SOURCE_MISSING`; uses an output → `TOKEN_SOURCE_CHAINED`; a download → no Save dialog;
  - cancelling during acquisition → `cancelled`, 0 child calls, and no token URL in the error;
  - a cross-origin redirect is blocked on net and returned unfollowed on fetch;
  - Copy as cURL never calls the token request;
  - the existing suites pass with their partial fake stores.

### WP-E2: 401 resend and manual token-request send (L) · depends on E1
- **Owns:** `src/main/engine/requestEngine.ts`.
- **Tests:** extend `tests/engine/requestEngine.outputs.spec.ts`.
- **Steps:** implement the §5 401 resend (a new `MultipartOperation` for multipart) and the validated manual-send seeding.
- **Done when:**
  - a cached token followed by 401 → 1 new token call, 2 child calls in total, and the note `resent-after-401`;
  - a freshly fetched token followed by 401 → no resend;
  - a second 401 after the resend → returned as-is;
  - `resendOn401: false` → no resend;
  - an NTLM child → no resend;
  - a POST resend reuses the same `{{uuid}}`;
  - a multipart resend gets a fresh deadline;
  - when the new token fetch fails after a 401, the send fails with that error;
  - a manual token-request send → `updated` and the cache is seeded, so a child makes 0 token calls;
  - a manual send that returns 403 → `not-updated` and the send succeeds;
  - an invalid `outputs` in the payload → handled as an ordinary request.

### WP-F: IPC, coordinator, history and app wiring (M) · depends on A, D, E1
- **Owns:** `src/main/ipc/handlers.ts`, `src/main/stores/historyStore.ts`, `src/preload/index.ts`, `src/main/index.ts`.
- **Tests:** extend `tests/engine/ipcResponseLifecycle.spec.ts`; add a historyStore test (ABI-aware like the existing ones).
- **Steps:**
  1. `src/main/index.ts`: create one `RequestOutputService` near l.148, pass it as the engine's last argument (l.149-151),
     register `collectionStore.onRequestRemoved(id => service.clear(id))`, and call `service.clearAll()` on before-quit (l.204).
  2. Add `outputs:status` and `outputs:clear` through `handle`. Validate payloads with `isStorableId`. Add them to the
     preload `Channels` and to the api with types.
  3. Coordinator: before `saveSnapshot`, apply the §5 withholding rule.
  4. Map progress explicitly to `{ version, operationId, phase, receivedBytes, declaredSize: totalBytes, tokenSource }`
     instead of spreading it.
  5. History: add a nullable `body_withheld TEXT` column with an idempotent `PRAGMA table_info` check. Do **not** bump
     `HISTORY_SCHEMA_VERSION`, because older builds throw on a newer version. Write it in `saveSnapshot`, read it in
     `getEntry`, and project it through `HistoryProjectionRow` and `projectHistoryEntryForIpc`.
- **Done when:**
  - a fake engine shows a token request's history row with an empty preview and `bodyWithheld` set, and a reopened
    entry carries `bodyWithheld`;
  - bad payloads are refused, and `outputs:clear` calls `service.clear`;
  - `acquiring-token` is forwarded with `tokenSource`;
  - existing coordinator tests pass (`ipcResponseLifecycle.spec.ts:441` uses `toMatchObject`).

### WP-G1: Outputs tab (M) · depends on A
- **Owns:** new `src/renderer/components/RequestOutputsEditor.tsx`; new `src/renderer/hooks/useOutputIndex.ts`;
  in `RequestEditor.tsx`, the tab union (l.335), the tab list (l.636-642) and `normalizeRequestShape` (l.95; keep
  `outputs` as it is, don't default it); `projectRequestDraft` in `src/renderer/stores/index.ts`; `tests/e2e/fixtures/mockApi.ts`.
- **Tests:** new `tests/e2e/request-outputs.spec.ts`.
- **Steps:**
  1. `useOutputIndex()`: read `window.api.collectionList()` on mount and after saves. Return a map of output names to
     `{ requestId, requestName, enabled, refreshAfterSeconds }`. G2 reuses it.
  2. Add an **Outputs** tab between Auth and Settings, with:
     - an on/off toggle (turning it on fills in `defaultRequestOutputs()`);
     - value rows: name, source (JSON field / Response header / Whole body), path or header name, and add/remove;
     - **Refresh after (seconds)** and **Expiry field** (blank means null);
     - **After HTTP 401, get a new token and resend once**.
  3. Keep the form in **local state**. Only valid outputs (`validateRequestOutputs` plus a clash check against
     `useOutputIndex`) are committed to the request, saved with an awaited `window.api.collectionUpdate`, and rolled back
     with the error shown if the store refuses. The existing `saveRequest` is fire-and-forget (l.413-424) and sends the
     whole request on every edit, so invalid outputs must never reach `currentRequest`.
  4. Warn when the active environment chain also defines the name.
  5. Status line from `outputsStatus`, polled every 1 s while the tab is visible and guarded with `typeof … === 'function'`.
     Examples: `Staging: fetched 14:02 · refreshes 15:02`, `Not fetched yet`, `Last fetch failed: HTTP 403`.
     Add a **Clear cached values** button.
  6. `projectRequestDraft`: apply `withholdOutputsBody` to `lastResponse` when the request has enabled outputs.
  7. Test IDs: `request-outputs-tab`, `request-outputs-enabled`, `request-output-name-N`, `request-output-source-N`,
     `request-output-path-N`, `request-outputs-refresh-seconds`, `request-outputs-expires-pointer`,
     `request-outputs-resend-401`, `request-outputs-status`, `request-outputs-clear`, `request-outputs-error`.
- **Done when** E2E tests cover:
  - configure, save, navigate away and come back;
  - a duplicate name error with nothing saved;
  - an invalid pointer or seconds value blocks the save;
  - turning outputs off keeps the rows;
  - the status text and Clear button;
  - a store refusal rolls back;
  - the draft in `localStorage` has no body for a token request;
  - no fetched value ever appears in the DOM.

### WP-G2: Using outputs in other requests (M) · depends on G1
- **Owns:** `RequestEditor.tsx` (except the parts G1 owns), `RequestInFlight.tsx`, `ResponseViewer.tsx`, `response/*` as
  needed, and `mockApi.ts` (additions).
- **Tests:** extend `tests/e2e/request-outputs.spec.ts`.
- **Steps:**
  1. Using `useOutputIndex`, add the output layer (masked, `type: 'output'`, literal, last) to the URL preview (l.521-552)
     and to `collectActiveEnvironmentKeys` (l.22-43), so autocomplete offers output names.
  2. Make the Bearer token field (l.1237) an `InterpolatedTextInput`. When it uses an output, show
     `From “Get session token” · refreshes after 3600 s`.
  3. `RequestInFlight.tsx`: label `acquiring-token` as `Getting token…`, or `Getting token from “<name>”…` when the
     store passes `tokenSource`.
  4. Response notes, shown for **any** response (live, collection-restored or history):
     - updated → `Outputs updated: api_token (kept in memory only)`;
     - not-updated → `Outputs not updated: <message>`;
     - resent-after-401 → `Got HTTP 401, so a new api_token was fetched and the request was sent again.`;
     - `bodyWithheld` → `Body not saved: this request provides outputs, which are kept in memory only.`
- **Done when** E2E tests with mocked results cover:
  - the preview masks an output;
  - autocomplete lists it;
  - the hint text;
  - the progress label;
  - all four notes.

### WP-H: Native end-to-end tests and docs (M) · depends on all of the above
- **Owns:** new `tests/electron/request-outputs.spec.ts`, `tests/electron/fixtures/nativeServers.ts` (new routes only),
  `README.md`, `AGENTS.md`, `FUNCTIONAL_SPEC.md`.
- **Steps:**
  1. Fixture routes, with counters and no value echoed back:
     - `/token` issues `tok-N` with a configurable `expires_in`, and can be told to fail or be slow;
     - `/protected` returns 200 only for the current valid token;
     - `/revoke` invalidates the current token.
  2. Electron spec, using `launchApp`/`closeApp`, isolated userData and seeding through `window.api.collectionCreate`:
     run the §8 matrix plus one real UI pass (configure Outputs in the tab, set a child's Bearer to `{{api_token}}`, click Send).
  3. Docs:
     - README section "Use a token from another request";
     - AGENTS.md: test table rows, a "Verified behavior boundaries" bullet (outputs layer precedence, memory only,
       401 resend once, same-origin redirects, a deleted source leaves the variable unknown), and a Known TODOs update;
     - the FUNCTIONAL_SPEC status.
- **Done when** the §8 matrix and the §9 gates pass on Windows, and the platform and any skipped coverage are recorded in §11.

### WP-I (optional, after B): Insomnia `{% response %}` import (S–M)
- **Owns:** `src/main/stores/insomniaImport.ts`; extend `tests/engine/insomniaImport.spec.ts`.
- **Steps:**
  1. Convert `{% response 'body', '<req>', 'b64::<jsonpath>::46b', 'when-expired', <maxAge> %}` into an output on the
     imported request. Only simple `$.a.b[0]` paths qualify, converted to a pointer. The name is `<request slug>_token`,
     made unique, and the tag is replaced with `{{name}}`.
  2. Anything else keeps today's kept-as-written warning.

## 8. Acceptance matrix (WP-H runs it natively; E1/E2 cover it with fakes)

| Case | Required evidence |
|---|---|
| Cold send | 1 `/token` hit, 1 child hit, header equals `Bearer tok-1` exactly |
| Reuse | a second child within the TTL: 0 new `/token` hits |
| Interval | `refreshAfterSeconds: 2` → after 2.1 s the next child makes a new `/token` hit and sends `tok-2` |
| `expires_in` sooner | refresh 3600 and `expires_in: 2` → refetched after the TTL |
| 401 resend | `/revoke` → next child: `/protected` hit twice, `/token` +1, final 200, note `resent-after-401` |
| Token request fails | `/token` 500 → child `failed` `TOKEN_SOURCE_HTTP`, 0 child hits; the next send recovers |
| Cancel | slow `/token` and Cancel → `cancelled`, 0 child hits |
| Environment switch | Staging and Production each fetch their own token |
| Restart | after restart, the first child fetches again |
| Manual token-request send | note `updated`; the next child makes 0 `/token` hits |
| No leak | the distinctive token appears in no file under the test userData (request JSON, history.db, Local Storage) and in no IPC result or progress event |
| cURL | fresh → confirmation required; stale → `TOKEN_NOT_FETCHED`, 0 network hits |
| Idle | `idle-network.spec.ts` still passes |
| Regression | ordinary `{{var}}` Bearer and OAuth client-credentials requests unchanged |

## 9. Commands and gate order

- Focused runs: `npx playwright test --config=playwright.engine.config.ts tests/engine/<file>` and
  `npx playwright test tests/e2e/<file>`.
- Run `npm run build:renderer` before E2E tests and native tests.
- Integration gates, in order:

```powershell
npm run typecheck
```
```powershell
npm run test:engine
```
```powershell
npm run build:renderer
```
```powershell
npm run test
```
```powershell
npm run test:electron
```
```powershell
npm run test:update
```
```powershell
npm run build
```

`npm run build` can fail inside Documents on this machine (Controlled Folder Access); validate packaging in an
unprotected folder. The three historyStore engine tests skip under the Electron ABI; that is expected (AGENTS.md).

## 10. Assignment order and the worker report

```
Wave 1:  A                      C (independent, long)
Wave 2:  B    D    G1           C continues
Wave 3:  E1 (needs A, C, D; B)  G2 (after G1)
Wave 4:  E2   F (after E1; no shared files with E2)
Wave 5:  H    (I optional any time after B)
```

The integrator merges packages into `claude-bearer-token-request-chaining` in this order and runs
`npm run typecheck` and that package's tests after every merge. Within a wave, no two packages own the same file.
Only three files change hands, each strictly in sequence:
- `requestEngine.ts`: C → E1 → E2;
- `RequestEditor.tsx`: G1 → G2;
- `stores/index.ts`: A → G1.

**Prompt to give a worker:** "Implement WP-<id> from `BEARER_TOKEN_CHAINING_PLAN.md` in this worktree. Read `AGENTS.md`
and §1, §4, §5 and your package. Touch only the files you own. Do not change §4. Commit locally on `chaining/wp-<id>` and do not push.
Finish with the §10 report."

**Report** (append to §11):
- package and branch;
- files changed;
- the exact commands run, with pass/fail counts;
- any "Done when" item not met, and why;
- anything needed from a file you don't own;
- any deviation from §4 or §5.

## 11. Progress log

(Workers append their reports here, newest last.)

### 2026-11-19: WP-A to WP-H implemented in one pass (Windows 11, Node 26.13.0, Electron 39.8.10)

One implementer did all packages in order, committing each on `claude-bearer-token-request-chaining` directly
(A `644df77`, C `c26b1d8`, B `be266c0`, D `11e9fb7`, E1 `b05b20d`, E2 `bd6acfe`, F `47a2704`, G1+G2 `f4bb89f`, H next),
so no `chaining/wp-*` branches exist. WP-I (Insomnia `{% response %}` import) was not done. Nothing is pushed.

**Gates, all passing:**
- `npm run typecheck`: clean.
- `npm run test:engine`: 566 passed, 12 skipped (the ABI-dependent historyStore tests and others that skip as before).
- `npm run build:renderer` then `npm run test`: 174 passed.
- `npm run test:electron`: 35 passed, 2 skipped (keyring branches that skip on Windows); `idle-network.spec.ts` passes.
- `npm run test:update`: 7 passed.
- `npx electron-builder --win --dir` into a folder outside Documents, then `npm run test:packaged` on it: passed (fuses,
  ASAR load, bridge, history database).

**Deviations from §4/§5, all additive:**
- `computeProducerFingerprint` covers the token request **as resolved** plus its outputs and the environment, not the saved
  templates. The window expands `_.name` shorthand before a manual send, so the templates of a manual send and the saved
  request can differ while resolving the same; including them made the seeded cache miss.
- `extractOutputValues` takes an optional third argument, the token request's name, for messages.
- `OUTPUT_LIMITS` has two more fields (`maxPointerChars`, `maxHeaderNameChars`).
- `requestOutputs.ts` also exports `FINGERPRINT_BUILT_INS`, `buildOutputLayer` and `OutputDefinitionError`.
- `TokenSourceError` lives in `src/main/outputs/tokenErrors.ts`.
- `RequestEngine.clearOutputs(requestId)` exists, so the IPC handler needs only the engine.
- A token request's transport failure reports the classified message (for example "TLS certificate verification
  failed"), never the raw one, which can carry its URL.
- The legacy `execute()` fetch path keeps its `auth.type === 'oauth2'` redirect check unchanged; it refuses outputs anyway.
- The native test runs its own counting token server inside `tests/electron/request-outputs.spec.ts` instead of adding
  routes to the shared `nativeServers.ts`.

**Notes:**
- The `body_withheld` history column has no Node-ABI unit test: this worktree's `node_modules` is a junction to the main
  checkout's, so `npm run rebuild:node` would change the binding the main checkout uses. The native suite covers the
  real column (a manual token-request send, then `historyGet` shows `bodyWithheld`).
- `requestEngine.streaming.spec.ts` "separates transport header deadline from collector body idle timeout" failed once
  in a full parallel run and passed alone and in two full reruns. Its `waitFor` gives up after 1,000 `setImmediate`
  turns, which looks load-sensitive.
- `outputs:status` reads the token request and environment files on every call (the tab polls each second while open),
  including decrypting Secrets; there is no network traffic.

### 2026-11-19: WP-I implemented

`{% response %}` tags in an Insomnia import become outputs of the request they read from when that request is in the
same export (`resolveResponseTags` in `src/main/stores/insomniaImport.ts`). Tags are replaced with markers while
converting and resolved once every request is known; each request keeps one output per distinct source, named
`<request slug>_token` (`_2`, `_3` for further sources, `r_` before a leading digit).
- **Sources:** body + simple JSONPath (`$.a.b`, `$['a'][0]`, `$`) becomes a JSON Pointer, body with no filter and `raw`
  become the whole body, and `header` becomes a header output. Base64-encoded filters (`b64::…::46b`) are decoded.
- **Refresh:** `when-expired` keeps its age, `always` becomes 1 s, and `never`/`no-history` become the maximum (fetched once
  per app session). A request's refresh time is the smallest one its tags ask for.
- **Kept as written and reported:** the tag's request is missing from the export, the JSONPath uses anything else, XPath,
  the `url` attribute, or the tag sits in a request that itself provides outputs (one step only). The warning keeps the
  order of names it had before, because names are reserved while converting and shown only for tags that are kept.
- **Deviation from the plan:** the plan's `when-expired` only was widened to all four triggers, because Insomnia's default
  (`never`) is what most exports contain.
- **Gates:** `npm run typecheck` clean; `npm run test:engine` 571 passed, 12 skipped. No renderer or main-process
  wiring changed, so the E2E and native suites were not rerun.

### 2026-11-20: two ideas taken from the Agy implementation

The user had the three implementations (OpenAI, Agy, this one) compared and asked for two of Agy's ideas here.
- **401 resend by method.** `resendOn401` is now `OutputResendOn401` (`'off' | 'safe-methods' | 'any-method'`), default
  `'safe-methods'`: after a 401 with a cached value, only GET, HEAD and OPTIONS are resent unless the user picks any method,
  so a POST body is not sent twice unasked. `allowsResendAfter401` decides. Files from the earlier build hold a boolean,
  read as `true` → `'any-method'` (its old meaning) and `false` → `'off'`; the next save writes the mode. The Insomnia import
  writes `'safe-methods'`. The Outputs tab has a select in place of the checkbox, with a note when any method is chosen.
- **Refresh now.** The Outputs tab runs the saved token request on demand for the selected environment
  (`RequestEngine.refreshOutputs`, IPC `outputs:refresh`; **Cancel** calls `outputs:cancel-refresh`). It drops the cached
  value (even a fresh one), then acquires through `RequestOutputService`, so it joins a fetch a send already started; a
  second click joins the first. Unlike Agy's version it can be cancelled, it is bounded by the token request's timeout
  (30 s when off), and it answers with status metadata only (failures in the status, never thrown). It runs beside sends
  rather than through the one-send coordinator: the shared fetch makes that safe. `RequestOutputService.unwound` lets a
  cancelled refresh wait until a fetch nobody else needs has stopped, so the answer is not "fetching".
- **Correction:** §4 said IPC drops `undefined`. It doesn't: Electron's structured clone keeps the key, as a probe of the
  OpenAI build showed (unchecking its option removed the field on disk). The `enabled` flag is unaffected; only the
  comment was wrong.

## 12. Where the work lives

- Integration branch `claude-bearer-token-request-chaining`, created 2026-11-19 from `primary` at `94fc3b6`.
  Worktree: `.worktrees/claude-bearer-token-request-chaining`, next to the `agy-` and `openai-` worktrees that other
  models made for the same request.
- Package branches `chaining/wp-<id>` are cut from this branch and merged back into it in the §10 order.
- Nothing is pushed. The main checkout is left alone: the other model's `REQUEST_CHAINING_PLAN.md` and its HANDOFF entry stay as they are.

## Verification of the plan itself

- §6 references were read at `94fc3b6`, and a second read-only review checked them claim by claim.
- Each package's "Done when" list can be checked with the commands in §9 alone.
- The end-to-end proof is WP-H's native suite, §8, plus the full gate run in §9.

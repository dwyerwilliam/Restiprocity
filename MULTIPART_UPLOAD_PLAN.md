# Binary-safe multipart uploads — implementation plan

Status: implementation completed 2026-11-07; validation results and environmental limitations are recorded in HANDOFF.md. The sections below preserve the implementation contract.

## Goal and review findings

Complete file upload in `FUNCTIONAL_SPEC.md` §5.1.1 without changing saved multipart rows or unrelated request behavior.

Source inspection confirms:
- `requestEngine.ts` reads file parts as UTF-8 and joins strings. All four callers of `buildBody` need byte-safe handling: legacy fetch/net and v2 fetch/net. Production defaults to net; NTLM and insecure requests also select net.
- `executeV2` builds auth headers before preparing the body. OAuth can therefore contact a token endpoint before discovering a bad upload. The original promise of no network I/O on file failure requires changing that ordering.
- Net starts its timeout and captures the mutable controller after body preparation. Cancel during a read can be missed because `cancel()` clears that controller. Fetch creates its timer before preparation but preparation failure currently bypasses its disposal.
- `requestInterpolation.ts` resolves winning authored header values before body generation. Simply replacing Content-Type later still lets a cyclic, unused value block a send.
- `RequestErrorKind` has no body-preparation error. Ordinary file errors become generic network failures, and the v2 IPC result exposes the friendly message, not raw error details.
- cURL needs explicit rules for empty forms, generated headers and representation limits. Insomnia already imports multipart file paths; its separate raw binary-body warning must remain accurate.

## 1. User-visible contract

- Apply this feature when `body.type === 'multipart'` and method is neither GET nor HEAD. A missing multipart array is treated as an empty array; both serialize an empty multipart body with its closing delimiter. This intentionally regularizes the current missing-array versus empty-array distinction.
- Preserve row order, duplicate keys, enabled flags, untrimmed keys, and post-interpolation `filePath || value` fallback. Skip disabled rows and resolved empty keys before resolving values or accessing files. Keep the existing consumed-field and one-context-per-send interpolation rules.
- Text parts are UTF-8. File parts contain the bytes read from disk, the host-platform basename, and `application/octet-stream`. Empty files are valid. Preserve existing percent escaping of quotes, backslashes, CR and LF in part names/filenames; reject NUL in these part-header values with a body error. NUL in text/file content is valid.
- Paths are interpreted on the machine running Electron. Preserve current relative-path behavior (main-process working directory), but recommend absolute paths in UI help. Do not add shell expansion, file URLs, or cross-platform path rewriting. Empty paths fail. Accept regular files, including symlinks resolving to regular files; reject directories/devices/FIFOs. A path is not proof a file is portable with an exported collection.
- GET/HEAD never prepare multipart data, read files, or apply multipart header overrides. Other body types retain their current behavior.
- No new picker, MIME detection, per-part MIME setting, migration, upload progress UI, streaming upload, or import format is included. Renderer IPC continues to carry paths and text, never file bytes.

## 2. Size and bounded preparation — decided

Use a shared `MULTIPART_MAX_BYTES = 32 * 1024 * 1024` (33,554,432 bytes) constant, consumed by engine and UI. The entire encoded multipart body counts: boundaries, part headers, CRLFs, UTF-8 text and every file occurrence. Exactly the limit succeeds; one byte over fails. A 32 MiB file alone therefore cannot fit after framing.

This is a product limit, not an Electron limit or a measured memory guarantee. One final upload buffer is at most 32 MiB; Chromium may copy it, and request strings/metadata also occupy memory. It is independent of the 1 MiB substituted-string interpolation limit and the existing response-preview limit. Unchanged literal raw bodies remain exempt from this new multipart-only limit. No user-configurable limit in this iteration.

Implement a main-process `multipartBody.ts` preparer:
1. Build a lightweight part description, generate the existing random boundary format, and count framing/text bytes incrementally before encoding or allocating a large buffer. Stop immediately on overflow. Use safe-integer checks for file sizes and totals. Yield to the event loop while processing large text/row sets so cancellation can run.
2. Stat each consumed file and total its size; reject non-regular files, errors or excess size before any payload allocation/read. This first pass is only a preflight, not a trusted file snapshot.
3. Allocate one exact-size, zero-initialized Buffer for the complete body. Fill framing and text without duplicating whole large strings into temporary byte buffers; yield/check the signal during large copies.
4. Open one file at a time, read-only. Stat the opened handle, compare its identity/size/mtime with preflight, then read directly into its allotted body region in chunks no larger than 64 KiB. Loop on short reads. Unexpected EOF, an extra byte beyond the expected size, or a changed final stat fails with `MULTIPART_FILE_CHANGED`; do not silently truncate, resize or retry. Probe at EOF with a separate one-byte buffer, including zero-length files.
5. Close every handle in a finally path. Check cancellation before/after every asynchronous step and before returning the prepared body. Abort must prevent later reads and all transport calls. Release buffer references when the send terminates; do not put upload buffers into history, drafts or IPC.
6. Detect a delimiter collision in encoded part content, including at chunk edges. Fail safely with `MULTIPART_BOUNDARY_COLLISION` and a retry message; a new send generates a new boundary. Never alter payload bytes.

Add narrow filesystem adapter operations: `statUpload(path)`, `openUpload(path)`, and a handle with `stat()`, bounded `readInto(target, offset, length, position)`, and `close()`. Keep existing text `readFile` unchanged. Use established fs open/stat/read APIs available in Electron's Node runtime, not host-Node-only convenience APIs. Fakes must implement the same bounded contract.

Do not use an unrestricted `readFile` followed by a size check: a file growing after stat could already exhaust memory. The preallocated region plus one-byte probe enforces the bound even in that race. Stat checks detect ordinary concurrent changes; they do not provide an atomic filesystem snapshot or prove the absence of same-size edits with indistinguishable metadata. Once preparation succeeds, the in-memory bytes are the snapshot used for that send.

## 3. Ordering, timeout and cancellation — decided

For active multipart sends, use this sequence in both execute entry points:

1. Capture a local operation signal at entry and resolve consumed request fields with one variable context.
2. Start one monotonic deadline after interpolation and immediately before multipart preparation, using `settings.timeout`. A value of zero means no deadline; cancellation still works.
3. Fully prepare and validate the body before `buildHeaders`, OAuth token fetch, NetLog capture or request transport creation. Thus any local preparation failure means zero OAuth and target-network calls.
4. Build auth headers with the same deadline/operation signal, apply generated body headers last, start NetLog after OAuth as today, and open the request using the already prepared body.
5. Keep that same deadline through receipt of final response headers: preparation, token exchange, capture startup, connection, upload and redirects share one budget. Do not reset the full timeout at transport start. Dispose deadline listeners/timers on headers or any failure. In v2, existing response-body idle timeout and cancellation continue afterward; do not convert them into a whole-response deadline. The legacy execute path retains its deadline through response-body completion, preserving its existing overall timeout behavior; only v2 switches to the response-body idle timeout.
6. Check the local signal/deadline before and after awaits and immediately before transport creation/end/fetch. A pre-aborted signal must fail without attaching only a future abort listener. Pass the local signal explicitly rather than re-reading `this.abortController` after an await; old cleanup must not clear a newer operation's controller.
7. Cancellation and timeout race through one terminal-state decision. Preserve the first terminal cause: timeout produces `kind: 'timeout'`, user cancellation produces the existing cancelled result. Abort-induced transport errors must not replace it. No late body/auth result may start networking, update the token cache, or settle a completed operation again.

Use an abort-aware wrapper for pending filesystem/auth/capture promises, with handlers attached for eventual completion/rejection and late handle/capture cleanup. Cancellation should settle at the next event-loop opportunity even if an underlying OS read has not returned; its one pending read may finish into the old buffer and must then close/release resources. Do not claim physical cancellation of an OS syscall or immediate resource release from a hung device. No follow-up reads or networking may occur.

The new multipart deadline includes OAuth and preparation; document that behavior. Keep non-multipart timeout policy unchanged. Ensure the legacy fetch and v2 fetch preparation-failure paths also dispose any timer they create. The prepared body must be built once, not again inside each transport. `buildBody`/transport types become byte-capable (`string | Buffer | null` internally); net receives the Buffer directly, and fetch receives an exact byte view/ArrayBuffer without UTF-8 decoding or backing-buffer offset mistakes.

## 4. Generated headers and interpolation — decided

For active multipart sends, body generation owns these headers, after auth/header precedence:

| Header | Send | Copy as cURL |
| --- | --- | --- |
| Content-Type | Exactly one generated multipart value with the body's boundary | Omit authored value; cURL supplies its boundary, except the explicit empty-form encoding below |
| Content-Length | Omit authored value; transport determines it | Omit authored value; cURL determines it |
| Transfer-Encoding | Omit authored value; transport determines it | Omit authored value; cURL determines it |

Names are matched case-insensitively after name interpolation. Resolve names to determine selection, then exclude these values before value interpolation. A cyclic or secret value that is overridden must not fail sending/export. This also applies when header API-key auth resolves its key to one of these names: skip its unused value and suppress that auth header. Query API keys and all other auth behavior stay unchanged. GET/HEAD preserve existing header behavior.

Use a small shared multipart policy helper for active-body and automatic-header decisions so `requestInterpolation.ts`, engine and `curlExport.ts` cannot diverge. Apply final normalization defensively in send/export even for an already-resolved request. Never rewrite saved rows or drafts.

## 5. cURL fidelity and explicit limits

- Keep the current POSIX-shell contract. Text uses `--form-string` so leading @, < and ;type= stay literal. File parts use quoted `-F` file paths with the existing octet-stream type and an explicit escaped basename filename; preserve row order and duplicate keys. Supply host-platform basenames from the main-process exporter as pure path metadata (no filesystem reads), so cURL and Send agree on filename escaping. Validate both shell quoting and cURL's separate form-argument quoting.
- Export never stats/opens files, exchanges OAuth tokens, or validates file existence/size. Missing files can still be exported. Export does not enforce the aggregate size cap; include a concise multipart warning that cURL does not apply Restiprocity's 32 MiB limit. For forms with file parts, also note that paths are local and files are read when cURL runs. Preserve existing cached-token warnings.
- With zero consumed rows, emit an explicit generated empty-form Content-Type and `--data-raw` containing its matching closing delimiter plus CRLF, represented with bash/zsh ANSI-C quoting to survive Git Bash script line-ending normalization. Do not invent a field or emit a bodyless POST by accident. A fixed valid boundary is sufficient because this form has no payload.
- Preserve percent escaping of part-header names through a shared helper; test names with spaces, quotes, backslashes, CR/LF and Unicode against actual cURL. If a consumed field name contains '=' (ambiguous in name=value form arguments), or a text value/path contains NUL (not representable in a process argument), fail export with an actionable message before touching the clipboard. Send remains supported for '=' names and NUL text. Empty file paths and NUL part-header names fail export too. This is an explicit export limitation, not a silent rewrite.
- Guarantee equivalent parsed fields and file bytes for the supported subset, not identical random boundaries or identical timeouts/cookies. Keep existing known-difference notices. Do not expand or promise cURL-import round-trip fidelity for arbitrary binary forms.

## 6. Errors and UI

Add `'body'` to `RequestErrorKind`, with a typed multipart-preparation error recognized before generic transport classification. Return stable codes: `MULTIPART_TOO_LARGE`, `MULTIPART_INVALID_FIELD`, `MULTIPART_FILE_NOT_FOUND`, `MULTIPART_FILE_UNREADABLE`, `MULTIPART_NOT_REGULAR_FILE`, `MULTIPART_FILE_CHANGED`, and `MULTIPART_BOUNDARY_COLLISION`. Cancellation/timeouts retain their existing kinds. Configuration/file errors are not automatically retryable; changed-file and boundary-collision errors may be retried explicitly.

Friendly messages must survive v2 IPC, e.g. “Multipart row 3: file not found. Check its file path.” and “Multipart body exceeds 32 MiB, including form headers and boundaries.” Use original one-based row indices, never interpolate resolved secret-bearing paths/keys/content into errors or logs. Classify native errno internally. Update all error-kind consumers/fixtures and preserve the typed error in the legacy execute catch. Failed preparation creates no response-history row and leaves the request editable/retryable.

Add visible, accessible help near multipart rows: “Files are read from this computer. Use absolute paths. Maximum encoded form size: 32 MiB. Multipart type and length headers are generated automatically.” Continue using the existing send/error surface; no new dialog or confirmation.

## 7. Implementation work packages

1. Shared policy/limit and body-error contract: `src/shared/multipartPolicy.ts` (new), `src/shared/types/index.ts`, `requestInterpolation.ts`, `src/main/engine/requestErrors.ts`; audit consumers in renderer and IPC. Add selection/error regressions first.
2. Bounded serializer and adapters: `src/main/engine/multipartBody.ts` (new), `requestRuntimeAdapters.ts`, engine fixture filesystem adapters. Test bytes, budgets, file races and cleanup independently of transports.
3. Engine integration: prepare once before OAuth; explicit operation/deadline ownership across all four transport paths; maintain NetLog lifecycle, cookies, redirects and post-header response behavior.
4. cURL and UI: `src/shared/curlExport.ts`, `RequestEditor.tsx`, existing export-result handling. Test real command semantics and clipboard preservation on export failure.
5. Documentation and imports: update README roadmap, functional spec status, AGENTS known TODOs and HANDOFF only after verification. In `insomniaImport.ts`, update the obsolete boundary-header comment and preserve current import filtering; add a regression for an imported explicit stale boundary plus file path. Raw binary-body imports remain unsupported and retain their warning.

## 8. Acceptance matrix and completion gate

| Area | Required evidence |
| --- | --- |
| Byte fidelity | Independent multipart parsing of wire bytes for NUL/invalid UTF-8/all byte values, empty/multiple files, Unicode text, duplicate keys and ordered parts; compare file bytes/hash rather than decoded strings |
| Consumed fields | Disabled/empty-key rows and GET/HEAD do no file operations; nested/interpolated paths and fallback work; unused fallback cycles remain ignored; source requests/drafts remain byte-equivalent |
| Size/memory | Exact 32 MiB encoded total succeeds; +1 byte fails; include multibyte text/framing/repeated file paths; reject oversize before allocation/read; fake growth cannot cause an out-of-region read; one final body allocation, no full-file temporary copies |
| File lifecycle | Missing/unreadable/non-regular file, zero-byte file, short reads, changed preflight/open stat, growth/shrink, close failure, abort during stat/open/read and late completion; handles eventually closed, no unhandled rejections |
| Headers/auth | Mixed case/duplicates/interpolated names, stale boundary/length/transfer encoding, overridden value cycles, API-key header collision and GET/HEAD contrast; invalid file with uncached OAuth makes zero token/target calls |
| Deadlines | Fake-clock tests prove preparation consumes transport budget, zero disables timeout, pre-abort works, first cancel/timeout wins, OAuth honors budget, no late cache/send, next send succeeds; no timer/listener leaks |
| Transport matrix | v2 net/fetch and legacy net/fetch receive exact byte bodies; normal and offset views covered; existing auth/insecure routing, 307/308 replay bytes, redirect limits and cancellation regressions remain green |
| cURL | Execute representative generated commands against a local server (native Windows curl plus POSIX/Git Bash shell where available); compare parsed fields/files, empty form and header policy; unsupported representation preserves clipboard; no file/token I/O during export |
| Native Electron | New `tests/electron/multipart-upload.spec.ts` uses real app + IPC + loopback server, isolated userData and temporary binary files: bytes/boundary, stale headers, empty form, missing-file zero target/token calls and subsequent successful retry. Assert friendly error and no failed response-history row |
| Browser | Existing request-editor persistence suite covers multipart guidance, text/file edits, disabled rows, saved paths and friendly body error/retry using a mocked bridge; this is UI evidence, not native upload proof |
| Import | Imported Insomnia multipart file with explicit boundary sends correctly; native export/import preserves paths/rows; unrelated raw binary import stays warned/unsupported |

Use existing engine adapter seams for deterministic read/timeout races; do not add production test-only IPC hooks. Native default-net proof is mandatory. Exercise the fallback fetch path in engine tests and an isolated Electron harness using the same preparer and real session.fetch; host Node fetch alone is not proof of Electron compatibility. Run cURL semantic fixtures on the advertised POSIX shell; do not treat Windows PowerShell rendering as equivalent. Report unavailable platform/shell checks rather than silently dropping them.

Run focused tests as work packages land. Final checks: `npm run typecheck` → `npm run test:engine:node-abi` (restore Electron binding in its finally) → `npm run build:renderer` → `npm run test` → `npm run test:electron` → `npm run build`. Update HANDOFF with actual counts, artifacts and failures. No commit, PR or release is authorized by this planning review.

## 9. Review evidence and status

The two previously open decisions (size and preparation timeout/cancellation) are resolved above. The implementation and executed acceptance evidence are recorded in HANDOFF.md. The memory cap bounds the prepared buffer; total process memory was not benchmarked.

- Installed Electron is 39.8.10. Its local declarations accept Buffer in ClientRequest.end and RequestInit in session.fetch. The [Electron ClientRequest documentation](https://www.electronjs.org/docs/latest/api/client-request#requestendchunk-encoding-callback) documents byte-buffer submission; it also lists Content-Length and Transfer-Encoding as restricted application headers.
- The [Node filesystem documentation](https://nodejs.org/api/fs.html#filehandlereadbuffer-offset-length-position) describes bounded reads into a caller buffer. Its readFile cancellation caveat is why this plan separates logical cancellation from physical completion of an OS operation.
- The [cURL manual](https://curl.se/docs/manpage.html#--form-string) documents literal form-string values; form options have parsing rules separate from shell quoting.

These references support API choices. The 32 MiB cap, multipart deadline, header override policy and export limits are Restiprocity design decisions.

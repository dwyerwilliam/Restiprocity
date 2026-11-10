# OpenAPI import implementation plan

Status: implemented 2026-11-08; corrected and re-verified 2026-11-09 after review (bearer prefix, dead 3.1 rules, budgets, notes, bodies, paths, coverage). Evidence is in 6.1. The 100,000-value graph budget is kept for now and documented (decided 2026-11-10; see Limits).
Prepared: 2026-11-08 against local commit `d14352d`.

## 1. Executor instructions

Implement this plan in order. Read `AGENTS.md` and the newest entries in `HANDOFF.md` first, inspect `git status`, and preserve unrelated work. Checkboxes below are implementation checkpoints, not existing capabilities. Complete production integration, meaningful tests, documentation, and final gates; a working converter alone does not finish this feature. Update HANDOFF after each milestone with files changed, commands/results, and the next unchecked step. Do not commit, push, tag, or publish unless separately requested.

The product decisions below are settled for this increment. Do not add an import wizard, network resolver, schema validator, dependency, request-model migration, or HTTP serialization engine. If source has changed since planning, adapt the wiring while preserving the contract. Report concrete blockers with evidence; do not mark an unavailable gate passed or remove its coverage.

## 2. Outcome and scope

A user chooses **Import collection from file**, selects an OpenAPI JSON/YAML document, and receives a folder of editable requests plus one separately selectable environment. The existing import notice reports counts, setup needed, and unsupported features. Importing never sends requests, acquires tokens, opens browsers, or reads referenced files. Selecting the imported environment and filling missing values makes supported requests usable through the existing Send flow.

Support OpenAPI **3.0.x and 3.1.x** in JSON/YAML, including same-document JSON Pointer references. This is a bounded conversion of request definitions, not full OpenAPI or JSON Schema conformance. Reject Swagger 2.0, OpenAPI 3.2, and other versions with an actionable version message. Document the precise versions instead of claiming all 3.x.

Included: tag folders; server overrides/defaults; scalar path/header/query parameters; repeated scalar query parameters; JSON/text/form/multipart drafts; basic/bearer/header-or-query API key and supported OAuth configurations; transactional persistence; warnings; browser and native acceptance.

Deferred: OpenAPI export; URL import; external/file reference loading; anchor/dynamic references; server/media/security pickers; response examples/history; callbacks/webhooks as requests; full schema validation/example generation; complex parameter encodings; custom multipart part types; scripts; specification editing/synchronization.

## 3. Verified integration points

| File | Current responsibility | Required change |
| --- | --- | --- |
| src/main/ipc/collectionFileActions.ts | File dialog, 50 MiB input check, JSON-first parsing, YAML CORE_SCHEMA, errors | Add OpenAPI to dialog text/comments; reuse parsing and IPC |
| src/main/stores/collectionStore.ts | Postman/Insomnia conversion, native validation, fresh IDs, mutation locks, rollback | Add OpenAPI conversion before native fallback |
| src/main/stores/collectionExport.ts | CollectionImportError and native bundle validation | Include OpenAPI in unrecognized-format error; retain validation |
| src/main/stores/insomniaImport.ts | ImportedEnvironment and existing conversion shape | Reuse environment type via type-only import; no behavioral change |
| src/shared/types/index.ts | Request/body/auth/group/environment contracts | Use existing types; no migration |
| src/shared/urlVariables.ts | composeRequestUrl encodes query names/values | Read to prevent double encoding; no change planned |
| src/shared/oauth.ts | OAuth validation/helpers | Reuse configuration rules; no token-service change |
| src/renderer/components/Sidebar.tsx | Import action, tree/environment refresh, notice | Reuse UI; change note introduction to "Review import notes:" |
| tests/engine/insomniaImport.spec.ts | Parser/converter/store/rollback patterns | Reference, including CollectionFileOperations fault injection |
| tests/engine/collectionStore.exportImport.spec.ts | Native validation/persistence regressions | Keep passing; extend for shared boundary changes only |
| tests/e2e/collection-file-actions.spec.ts | Mocked import UI | Add OpenAPI success/setup/error scenarios |
| tests/electron/existing-behavior.spec.ts | Real IPC import and dialog interception | Reference patterns; add dedicated OpenAPI spec |

New production files:

- **src/main/stores/openapiImport.ts**: detection, validation, operations, bundle/environment construction, parameter/auth/body mapping, warnings.
- **src/main/stores/openapiReferences.ts**: bounded graph checks and same-document reference resolver.
- **src/main/stores/openapiSamples.ts**: deterministic value selection and bounded schema-to-example helper.

Keep helpers local to main. Use @shared/ for shared imports. Build native bundle objects directly; do not translate through synthetic Insomnia/Postman documents. No new runtime packages.

Public converter: **convertOpenApiDocument(data: unknown): OpenApiConversion | null**. Export OpenApiConversion containing exactly **bundle: CollectionExportBundle**, **environments: ImportedEnvironment[]**, and **warnings: string[]**.

Return null only when no own openapi/swagger marker identifies the input. A recognized invalid/unsupported document throws CollectionImportError. Conversion is synchronous and pure: no filesystem, Electron, network, random IDs, current time, or input mutation. Deterministic synthetic IDs are replaced by the store. The store remains the sole persistence route.

Create one conversion context per call with the root/version, budget counters, reference-stack state, and warning callback. Pass it through helpers; no mutable module globals. The sample helper returns a discriminated value-or-missing result so null/false/empty examples cannot be confused with omission. Keep a resolved node's pointer/ancestor metadata when checking 3.1 schema base URIs.

Use COLLECTION_EXPORT_FORMAT and COLLECTION_EXPORT_VERSION for bundle metadata, exportedAt '', roots ['openapi-root'], and explicit groups/requests arrays. Each group.children lists synthetic child IDs in display order, each node appears exactly once, and no orphan nodes are emitted. The single imported environment has sourceId 'openapi-environment'. Persistence timestamps/IDs/parentId links are assigned by the store.

## 4. Document, references, and resource rules

### Detection and validation

1. Require a plain record root, a string version matching ^3\.(0|1)\.\d+$, an info record with nonempty string title/version, and a paths record. A 3.1 document containing only webhooks/components is outside this request-import scope: report "No supported HTTP operations were found in this OpenAPI document."
2. Preserve native/Postman/Insomnia recognition precedence. Try OpenAPI after existing converters, before parseCollectionExportBundle. Keep format conversion outside the native validator.
3. Validate shapes actually consumed: path items/operations are records; servers/parameters/security/tags have expected container shapes; parameter locations/names, content, scopes, and resolved targets have usable types. Malformed consumed structure fails before mutation; do not silently filter malformed entries.
4. Valid unsupported features produce the warnings/fallbacks below. Missing/broken consumed references are errors. Unsupported operations such as TRACE are skipped with warnings. Zero supported requests means failure, not an empty folder/environment.
5. Treat source keys as data. Use Map, Object.hasOwn, and own-key enumeration. Never use arbitrary names as file paths or unsafe prototype-bearing lookup assignments.

### References

Resolve lazily for path items, parameters, request bodies, examples, security schemes, and sampled schemas. Do not dereference the whole document. Unused components with unsupported references must not block usable operations.

- Support #/... pointers only. URI-decode the fragment once; split and decode pointer tokens (~1 to /, then ~0 to ~). Check each segment with own-property access; arrays accept canonical nonnegative integer indices in range. Reject malformed percent/tilde escapes, missing targets, and wrong target types.
- Consumed external URLs, file paths, file: URIs, #anchor, and bare # fail with operation context and advice to bundle references into the selected file. Never read/fetch them.
- Ordinary Reference Objects follow the target without arbitrary sibling merging. 3.1 summary/description siblings have no stored destination; other behavioral siblings warn and are ignored. Path Item references with sibling operations/parameters/servers are rejected as ambiguous; descriptive siblings may be ignored.
- Parameter/request-body/path-item/security/example reference cycles fail. Recursive **schema expansion** is valid: omit the recursive property/array item and warn. A pure reference loop with no schema to sample is an error. Use active recursion stacks, not a global visited set that rejects shared components.
- A 3.0 schema reference uses the target. For 3.1 schema references, sample annotations (example, examples, default, readOnly, writeOnly, title/description) may override target annotations. Additional assertion/composition siblings make synthesis unsupported: use an explicit enclosing example, otherwise omit the sample and warn. A shallow merge does not implement JSON Schema semantics.
- Consumed 3.1 schemas with $id, $anchor, $dynamicRef, $dynamicAnchor, custom $schema, or a custom root jsonSchemaDialect cannot be synthesized under this subset. Explicit enclosing examples may bypass synthesis; otherwise warn and leave the sample unavailable. Recognize the default OpenAPI 3.1 dialect URI as supported, along with dated OAS 3.1 dialect URIs and the JSON Schema 2020-12 meta-schema, whose semantics are identical for this sampler. Detect base/dialect changes in schema ancestors as well as the sampled node so local pointers are never misresolved under a different base URI.

### Limits (fixed product choices)

Retain the 50 MiB file boundary. Before conversion, walk the parsed OpenAPI graph with an explicit stack. Allow shared acyclic YAML aliases; reject cyclic object graphs. Permit at most 100,000 visited values/edges and 64 nesting levels. Apply these checks only to recognized OpenAPI input.

During conversion permit 10,000 operations, 64 reference hops per chain, 16 sample-expansion levels, 100,000 total sample/resolve visits, 1 MiB UTF-8 per generated body/example, and 16 MiB UTF-8 for serialized bundle plus environments. Check budgets before expansion/appending; do not first materialize an unbounded result. Budget breaches fail before writes. Schema recursion has the omission behavior above; hard budget exhaustion is never successful truncation.

The input check and post-parse budgets do not prove bounded YAML parser memory or total process memory. No parser rewrite/worker-process design is included.

Decision (2026-11-10): keep the 100,000-value graph budget for now. Every object, array, string, number, boolean, and null in the parsed document counts once; keys do not count, and a reused YAML anchor counts once per use without its contents being walked again. This budget, not the 50 MiB file boundary, is the effective size limit: a generated document with 450 operations and 25-field request/response schemas (about 200 values per operation, 2.2 MiB of JSON) imports, and 500 such operations (2.45 MiB) are rejected with a message that states the limit. Large public descriptions have not been measured but will likely exceed it. The count does not bound parser memory, because parsing has already finished, or alias expansion, which the 1 MiB body budget stops. The cycle and 64-level depth checks in the same walk stay regardless of the count. Before raising the budget, import several large real descriptions with it lifted and record their value counts, which budget they reach next, and how long conversion takes. The 100,000 sample/resolve visits are shared by the whole import, so descriptions without authored examples may reach that budget next.

## 5. Mapping contract

### Structure, names, and defaults

- One root folder named info.title.trim(). Create child folders for each first operation tag encountered; untagged requests are direct root children. Multiple tags create one request under the first tag, with a note about omitted memberships. No unused tag folders.
- Traverse paths in source order, methods in fixed order get/post/put/patch/delete/head/options. Metadata is not an operation. TRACE is skipped with a warning; unknown non-extension operation-like keys are reported. Ignore x-* extensions as metadata.
- Request name: first nonempty trimmed summary, then operationId, then METHOD /path. Duplicate names/operation IDs are allowed; IDs are ordinal (openapi-root, openapi-group-1, openapi-request-1), independent of names.
- Populate all Request fields. Defaults: empty headers/parameters, body/auth type none until mapped, settings followRedirect true and timeout 30000, scripts {}, timestamps 0. Never create saved responses or scripts from extensions.
- Paths must start with /. Reject query/fragment/control characters, backslashes, malformed brace templates, and . or .. dot segments (including percent-encoded dot segments). Preserve other ordinary percent escapes.

### Servers and environment

Server precedence follows operation, path, then document. Relative servers are legal in OpenAPI, but a local file supplies no HTTP origin. See the [OpenAPI server definition](https://spec.openapis.org/oas/v3.0.4.html#server-object).

1. Use the nearest **present** servers array and its first element. Empty means default /, not inheritance from another level. Missing all levels also means /. Multiple choices produce a selected-index note. Do not skip a malformed first server to find a convenient later one.
2. Expand server {variables} using string defaults. A used variable without a default fails. If enum exists, require a nonempty string array containing the default. Import the resulting full server URL, not separate server-template variables.
3. Absolute servers must be HTTP/HTTPS without username/password, query, fragment, control characters, backslashes, or unresolved braces. Reject malformed/unsupported absolute URLs.
4. For relative servers use explicit placeholder origin https://example.invalid. /v1 becomes https://example.invalid/v1. v1 is treated as /v1 with a note that the original document base is unknown. Reject dot segments and protocol-relative //host/path. Missing/default / becomes https://example.invalid. Tell the user to edit the imported server variable; never infer an origin from filename/contact metadata.
5. Create exactly one environment named "<title> (OpenAPI)", with no parentSourceId (store attaches it to Core). Each distinct expanded server gets a standard variable openapi_server_1, openapi_server_2, etc., in first-use order; deduplicate by normalized value. Requests use {{openapi_server_N}} plus operation path. Join with one boundary slash while preserving the server base path: /v1 + /pets stays /v1/pets. Do not use new URL('/pets', server) for this join.
6. Leave the active environment unchanged. Include a note to select the new environment and review placeholders. For normalization, remove trailing server-path slashes (including the root slash), preserve interior path segments, and validate with URL parsing without replacing the retained base path. Generated keys start with openapi_, avoiding built-ins/source-name collisions. Re-import creates independent records and environments, never merges into Core or prior imports.

### Parameters and values

Merge path/operation parameters by (in, name); operation wins in the inherited position, new parameters append. Compare header names case-insensitively because the app sends HTTP headers. Duplicates within one level are invalid. Every path template must have a matching required:true path parameter; a declared path parameter without a matching template is also invalid.

Selection is presence-based, preserving 0, false, empty string, and null: parameter/media example; otherwise first inline value among named examples in source order (resolving local Example refs); then schema example; first schema examples item (3.1); schema default; first enum entry; 3.1 const. Never load externalValue examples; warn and continue to the next inline candidate; skip Example Objects without an inline value. Conflicting example/examples is invalid on a Parameter or Media Type object; a 3.1 Schema Object may legally carry both, and example wins. Multiple available named examples produce a selection note. Do not invent parameter values from type alone.

| Location/shape | Output |
| --- | --- |
| Path scalar string/finite number/boolean, simple style | Substitute selected sample with encodeURIComponent exactly once. a/b % becomes a%2Fb%20%25. Source %2F is literal text and becomes %252F. |
| Path missing sample, null/complex sample, unsupported style | Use {{openapi_path_<operationOrdinal>_<parameterOrdinal>}}, create standard value REPLACE_ME, and warn that editing this variable requires a URL-encoded path segment. Never delete the template. |
| Query scalar, default/explicit form, allowReserved absent/false | Raw-value row; composer encodes it. Required enabled, optional disabled. Missing/null becomes empty string; warn for required missing/null. |
| Query scalar array, form with explode:true (including default) | Repeated raw rows in item order. Empty array gives no rows plus note; missing array example gives a disabled empty row plus note to supply values. Required/optional enablement otherwise matches scalar rows. |
| Header scalar, default/explicit simple | One row, required enabled/optional disabled. Missing/null follows scalar-query rules. Reject CR/LF/NUL in names/values. |
| Query object/non-exploded array/other style/content/allowReserved:true | Omit and warn with operation/location/name; no JSON-stringification approximation. |
| Header complex value/other style, or cookie parameter | Omit and warn. |

Parameter content serialization is unsupported at every location: path parameters retain a warned placeholder; other locations are omitted with a warning. Ignore Accept, Content-Type, and Authorization header parameters case-insensitively; body/auth owns them. Keep query rows out of the URL to avoid duplication. Do not modify composeRequestUrl, auth precedence, or interpolation to broaden support. The [parameter definition](https://spec.openapis.org/oas/v3.0.4.html#parameter-object) describes the standard defaults; this table deliberately limits the conversion subset.

Source-authored strings containing Restiprocity {{...}} expressions keep existing interpolation semantics. Detect them before adding generated templates; warn once that these expressions resolve from the selected environment. Do not interpolate during import or invent an escape convention.

### Worked mapping example

Use this as a small independently asserted fixture:

```json
{
  "openapi": "3.0.3",
  "info": { "title": "Pet API", "version": "1" },
  "servers": [{ "url": "https://api.example.test/v1" }],
  "paths": {
    "/pets/{id}": {
      "parameters": [
        { "name": "id", "in": "path", "required": true, "schema": { "type": "string" }, "example": "a/b" }
      ],
      "get": {
        "summary": "Find pet",
        "tags": ["Pets"],
        "parameters": [
          { "name": "tag", "in": "query", "required": true, "schema": { "type": "array", "items": { "type": "string" } }, "example": ["a&b", "c d"] }
        ],
        "responses": { "200": { "description": "OK" } }
      }
    }
  }
}
```

Expected: two folders (Pet API > Pets), one GET request named Find pet, one inactive environment named Pet API (OpenAPI). The environment has standard openapi_server_1 = https://api.example.test/v1. Request URL is {{openapi_server_1}}/pets/a%2Fb. Parameters are two enabled raw rows with key tag and values a&b and c d. Auth/body are none. Existing interpolation plus composeRequestUrl yields **https://api.example.test/v1/pets/a%2Fb?tag=a%26b&tag=c%20d**. The import notice includes environment-selection guidance. No API request occurs during conversion/import.

### Request bodies

Pick one supported media entry: exact application/json; first concrete subtype ending +json; application/x-www-form-urlencoded; multipart/form-data; then first supported text/*, application/xml, or application/javascript. Within each tier use source order. Match case-insensitively before MIME parameters, preserve the selected full type for raw Content-Type. Wildcards/raw binary are unsupported. Report selection when alternatives exist; unsupported-only content yields body none plus warning. GET/HEAD bodies are omitted with a warning because sending ignores them.

| Kind | Mapping |
| --- | --- |
| JSON/+json | Raw JSON, serialize selected explicit value with two-space indentation. A string example is a JSON string, not JSON text to parse again. Otherwise use sampler below. No sample -> empty raw JSON editor plus manual-body note. Add selected Content-Type. |
| Text/XML/JavaScript | Selected scalar (string, number, or boolean) example/default only; no XML generation. Correct raw language xml (application/xml, text/xml), javascript, html, or text; empty plus note otherwise. Add selected Content-Type. |
| URL-encoded form | Selected object example or direct schema object properties -> rows. Scalars and default form/explode scalar arrays supported; arrays repeat keys. Whole-body-example rows enabled; schema rows required enabled/optional disabled. Add application/x-www-form-urlencoded. |
| Multipart | Same text-row rules. File schemas (3.0 format: binary; 3.1 contentMediaType without contentEncoding), including ones reached through $ref, -> file row with value '', filePath '', enabled false regardless of example, and also when a whole-form example omits them; note required files and manual selection. Never use an example filename/URL as a local path. Engine owns Content-Type/boundary. |

Even with a whole-form example, inspect the selected schema's direct property metadata for file types and custom encodings, so a binary example cannot become a text field or upload path. Whole-form examples must be objects. Skip read-only schema-derived fields. Missing scalar samples become empty values with required-field notes. Omit nested objects/arrays, binary URL-encoded fields, binary arrays, unsupported per-property encoding and multipart custom headers/types with precise warnings. Explicit encoding is supported only when equivalent to default scalar/repeated-scalar handling. An all-omitted form stays an empty form editor with a note. Required body/field setup does not introduce new persisted validation fields.

Sampler algorithm in openapiSamples.ts:

1. Prefer explicit values using the precedence above. Copy JSON-compatible data with budget/cycle checks; do not alter examples to satisfy schemas.
2. Otherwise resolve supported local schemas and synthesize simple types: object -> declared properties in order; array -> one generated item; string -> ''; integer/number -> 0; boolean -> false; null-only -> null. Infer object from properties or array from items when type is missing. For 3.1 [T,'null'] prefer sole non-null T; other unions unsupported.
3. Omit readOnly:true properties during synthesis, including referenced property schemas. Include writable optional properties in JSON drafts. Explicit examples stay intact even when read-only fields appear, with a note that examples are copied without validation.
4. allOf/oneOf/anyOf/not, conditionals, tuple schemas, unsupported dialect/base semantics, and boolean schemas without explicit examples have no synthesized value. Use a typed missing result; omit property/item and warn. Empty containers after omissions are allowed with notes.
5. Recursive branches are omitted; budget breaches fail. Formats, constraints, discriminators, additionalProperties, and XML annotations do not fabricate values. Every synthesized body gets a review note: examples may need editing and are not schema-validated.

### Authentication

Effective security is operation security if present, otherwise document security; omission/[] means none. Choose first **fully representable** alternative in source order. {} is a supported anonymous alternative. A combined multi-scheme requirement cannot fit the app's single auth branch: skip the entire alternative. No supported alternative -> auth none plus manual-auth warning. Report selection when alternatives exist. A missing referenced scheme or malformed scopes list fails before writes.

The [security requirement definition](https://spec.openapis.org/oas/v3.1.1.html#security-requirement-object) distinguishes alternatives from combined requirements.

| Scheme | Native configuration |
| --- | --- |
| HTTP basic | Empty username/password; setup note |
| HTTP bearer | Empty token, prefix Bearer; setup note |
| Header/query API key | Scheme name/location, empty value; setup note |
| OAuth2 | Prefer authorizationCode, else clientCredentials. Map endpoints and only effective requirement scopes, space separated. Grant authorization_code/client_credentials; client ID/secret and redirect URI empty for existing editor setup. Client authentication none for auth-code/basic for credentials, with note to review provider requirements. Explain app authorization code uses mandatory PKCE S256. |
| Cookie API key, Digest/other HTTP, OpenID Connect, mutual TLS, implicit/password-only OAuth | Unsupported alternative with warning; no approximation |

Relative OAuth endpoints are unsupported without the source document's HTTP base. Absolute endpoints must pass existing HTTPS-or-literal-loopback validation; invalid endpoints make that alternative unsupported with a note. Import never invokes OAuth actions. Different refreshUrl is unrepresentable and reported. Multiple supported flows produce a choice note. Credential/token extensions are ignored; no acquired tokens are persisted. Do not select all available scopes or invent a callback registration. Non-OAuth role lists are not sent and get a note when nonempty.

### Notes/errors

Use existing warnings:string[] and collection notice. Group by category with at most five affected METHOD /path labels plus remaining count. Cap at 50 categories plus one overflow summary; each note <=1,000 characters. Deterministic plain text. Keep environment-selection/setup guidance first so warning limits cannot hide it. Do not echo example/credential values, entire documents, credential query strings, or referenced file contents.

Always report environment selection; additionally placeholders, synthesized bodies, auth setup, selected alternatives, and unsupported request-affecting fields. Aggregate ignored response schemas/examples/links/callbacks/webhooks into one note when present; do not dereference them or create history. Descriptions/contact/license metadata and arbitrary extensions need no per-field noise.

## 6. Milestones and evidence

Each milestone leaves typecheck and focused tests passing. Mocks from one milestone do not establish completion of a later real-runtime milestone.

### M1 — Recognition, limits, references

- [x] Add openapiReferences.ts and converter entry contract. Implement recognition, structure checks, deterministic pure errors.
- [x] Implement graph traversal, pointer resolution, target checks, chain/cycle handling, budgets.
- [x] Add tests/engine/openapiReferences.spec.ts and initial tests/engine/openapiImport.spec.ts.
- [x] Prove existing parser handles JSON/YAML/BOM; unknown input returns null; unsupported versions fail; shared aliases work/cyclic aliases terminate; escaped pointers work; inherited properties cannot be traversed; used/unused external refs follow distinct policies.

### M2 — Scaffolds, servers, parameters, auth

- [x] Implement folders/order/IDs/defaults, server/environment mapping, parameter overrides/encoding, auth selection.
- [x] Every positive fixture passes native bundle validation. Compare direct expected values, not round-trips through the same converter.
- [x] Cover duplicate names/tags, overrides/empty servers, missing/relative servers, /v1 preservation, defaults, path escaping, optional/repeated query rows, unsupported styles, security:[], anonymous alternative, OR/AND, OAuth scopes/defaults, missing credentials.

### M3 — Bodies and warnings

- [x] Add openapiSamples.ts, sample selection/synthesis, body mapping, warning collector.
- [x] Add tests/engine/openapiSamples.spec.ts and complete converter tests.
- [x] Cover false/zero/empty/null, JSON string examples, local refs, recursion vs reuse, readOnly, 3.1 annotations/dialects, composition warnings, budgets, media selection, GET/HEAD, form repeats, disabled file placeholders.
- [x] Deep-freeze ordinary fixtures to assert no mutation; prove determinism. No source-supplied paths become upload paths. Warnings stay bounded and exclude sentinel secrets from example values.

### M4 — Store, dialog, UI

- [x] Wire converter before native parsing; retain locks, validation, replaceCollectionFiles, ID remapping.
- [x] Update dialog/help/error text for OpenAPI; retain IPC/preload contracts.
- [x] Neutral notice introduction "Review import notes:"; add mocked browser success/setup/failure tests.
- [x] Add tests/engine/openapiStore.spec.ts: import into populated store; repeat import disjoint IDs; preserve prior records/root order/settings; reopening; inactive imported environment.
- [x] Inject environment-install failure after requests land. Compare original file names **and bytes**, including order/settings; no partial folders/requests/environment/temp artifacts. Also prove malformed/limit/reference failures write nothing.
- [x] Existing native/Insomnia/Postman regressions pass.

### M5 — Native acceptance

- [x] Add tests/electron/openapi-import.spec.ts using real _electron.launch, isolated RESTIPROCITY_TEST_USER_DATA, real preload/IPC. Intercept only dialog.showOpenDialog to select fixtures. Own/close test apps/servers; preserve user apps.
- [x] Import 3.0 JSON and 3.1 YAML; assert tree/counts/notes, stored request/environment values, unchanged active environment.
- [x] Select imported environment; edit its server variable to a local fixture; send the **stored imported request**. Independently assert method/path/query/header/body bytes, including non-root base path, reserved path characters, repeated keys, JSON example. Do not replace it with a hand-built equivalent.
- [x] Send imported forms and multipart. Multipart file starts disabled/empty; select fixture file and enable through normal saved request shape before send; assert binary wire bytes. No spec-supplied filename triggers file opening.
- [x] Fixture/token server request count during import is zero. Sentinel external-ref URL is rejected without a hit or persisted changes. Consumed file refs fail, and pure converter has no filesystem resolver capability.
- [x] Cover cancelled dialog, malformed YAML, unsupported version, broken consumed refs, bounded-input failure, unsupported-feature notes via IPC. Seed prior data and compare persistence after rejections.
- [x] Restart with same isolated userData and verify persistence. Browser mocks prove presentation; native tests prove parsing/persistence/send.

### M6 — Docs and completion gates

- [x] Update README feature/usage/roadmap, FUNCTIONAL_SPEC import table/status, AGENTS TODOs/test inventory, HANDOFF. Explain exact versions/subset, environment selection, relative placeholders, local refs, samples, encoding/auth limits, manual files.
- [x] Mark implemented only after M1-M5 and final gates have evidence. Separate platform limitations from passes. No version bump/release.

## 6.1 Completion evidence

- Production integration: openapiImport.ts, openapiReferences.ts, and openapiSamples.ts are wired through the existing collection file dialog and transactional CollectionStore.importBundle path. Imports create fresh request/group/environment IDs and leave the active environment unchanged.
- 2026-11-08 pass: the first record claimed M1-M5 complete, but coverage was 11 engine tests, one mocked UI test, and one native GET send; the four fixture files were unused. A review then reproduced defects that the checkboxes did not catch.
- 2026-11-09 corrections:
  - Bearer auth always uses the Bearer prefix; bearerFormat is documentation only.
  - The converter passes the major.minor version, so the 3.1 rules run. Reference siblings follow the annotation/assertion rule instead of a shallow merge, and $id/$schema boundaries are checked on the target and on enclosing schemas.
  - The example/examples conflict applies only to Parameter and Media Type objects. Example Objects without a value are skipped.
  - Multipart file fields are detected through $ref and 3.1 contentMediaType and always offered. Text/XML bodies use authored scalars only. readOnly is honored through $ref.
  - Media ranking puts exact application/json first and rejects wildcards. Trailing, mixed, and encoded dot segments are rejected in paths and servers. Server base paths are kept as written.
  - Explicit examples are serialized with a 1 MiB stopping serializer, and the 16 MiB output budget is charged while rows and bodies are appended.
  - Notes are grouped by category with five labels and a count. The missing notes (responses, expressions, empty arrays, required fields, auth choice/roles, reference siblings) are now produced.
- Coverage:
  - tests/engine/openapiImport.spec.ts (21 tests): the worked example, all four fixtures through native bundle validation, detection/versions/BOM/YAML aliases, paths, servers, parameters, notes, media ranking, JSON/text/form/multipart bodies, auth alternatives, operation/body/output budgets with at-limit and limit+1 cases, alias expansion bounds, frozen-input determinism, and reference policies.
  - openapiReferences.spec.ts (5) and openapiSamples.spec.ts (9): pointers, hop and graph limits, sample precedence, 3.1 rules, recursion versus reuse, sample budgets, and serializer equivalence.
  - openapiStore.spec.ts (4): a populated store keeps byte-identical files, root order, and settings, and survives reopening; repeat imports are disjoint; rollback is byte-identical; seven failure kinds write nothing.
  - tests/e2e/collection-file-actions.spec.ts: grouped notes, failure display, and cancellation.
  - tests/electron/openapi-import.spec.ts (2 tests): eight rejection cases over real IPC with zero fixture hits and unchanged persistence; 3.0 JSON and 3.1 YAML imports with notes and unchanged active environment; editing the imported server variables; sending stored requests with exact path, query, header, and Bearer bytes, JSON, URL-encoded form, and multipart binary bytes; restart persistence.
- Verification (2026-11-09, after the last change):
  - npm run typecheck passed.
  - npm run test:engine: 380 passed, 10 ABI-aware skips.
  - npm run build:renderer passed.
  - npm run test: 156 passed.
  - npm run test:electron: 23 passed, 1 documented clipboard skip. The first full run had one failure in the unrelated NetLog timing test, which passed 4/4 alone and on the full rerun.
  - Not rerun in this pass: test:engine:node-abi, test:update (unaffected), and the npm run build packaging step.
- No commit, tag, release, or version bump was made.
## 7. Fixtures and acceptance matrix

Author small project-owned fixtures under tests/engine/fixtures/openapi/: basic-3.0.json, bodies-3.1.yaml, references.json, security.json. No real credentials. Generate large/cyclic/boundary cases in tests. Native tests may reuse fixture inputs; expected wire output remains independent.

| Boundary | Required evidence |
| --- | --- |
| Existing formats | Native/Insomnia v4-v5/Postman collection-environment still import |
| Limits | Valid at-limit case accepted, limit+1 rejected, no writes |
| References | Escapes/arrays/missing/wrong type, used vs unused external refs, schema recursion/non-schema cycles/YAML aliases |
| URLs | Precedence/defaults/base path, relative note, braces/dot segments, path and query encoded once |
| Losses | Warnings identify affected requests; TRACE-only input fails zero-operation check |
| Bodies | Falsy/explicit values preserved; independent raw JSON/form/multipart bytes |
| Auth | Inheritance/clear/alternatives/combined requirements/unsupported grants; no token/browser effects |
| Persistence | New IDs/order/environment isolation/reopen/byte-identical rollback |
| UI | Tree/environment refresh, notes, cancellation without error, failure display |
| Runtime | Electron import/send/restart and existing native regressions |

## 8. Commands and final gate order

Use Node 26.13.0 (.node-version) and installed repository tooling. During milestones, run only files already created:

```powershell
npm run typecheck
npm run test:engine -- tests/engine/openapiReferences.spec.ts tests/engine/openapiSamples.spec.ts tests/engine/openapiImport.spec.ts tests/engine/openapiStore.spec.ts
npm run test:engine -- tests/engine/insomniaImport.spec.ts tests/engine/postmanImport.spec.ts tests/engine/collectionStore.exportImport.spec.ts
```

Once integrated:

```powershell
npm run build:renderer
npm run test -- tests/e2e/collection-file-actions.spec.ts
npm run test:electron -- tests/electron/openapi-import.spec.ts
```

Final gates after the last application change:

```powershell
npm run typecheck
npm run test:engine:node-abi
npm run build:renderer
npm run test
npm run test:electron
npm run build
```

test:engine:node-abi rebuilds for host Node, runs strict engine tests, and restores Electron ABI in finally; verify restoration. If a user app locks the binding, use an isolated validation copy with the exact current source/lockfile, install/build there, and record source hashes/commands. Preserve the user's app. Skipped SQLite tests are not strict-engine acceptance.

Browser E2E serves built dist; build:renderer also builds Electron bundles. Identify preview-process ownership before restarting it; use isolated checkout/port for conflicting tasks. Preserve typecheck -> browser -> native -> packaging order. Updater tests are needed only if changes touch their behavior.

Existing system-clipboard coverage remains opt-in; its documented skip proves nothing about OS clipboard behavior. No new OpenAPI tests may be skipped to work around failures. Fix feature failures, report real environmental blockers, and rerun affected gates after fixes. Repeat successful checks only for relevant changes/unresolved concerns.

## 9. Completion record and continuation prompt

Record results here or link local evidence: final diff; commands/pass-fail-skip counts; native wire assertions; rollback result; package result; ABI restoration; limitations. Update status only when evidence exists. Historical HANDOFF counts are not current proof.

Suggested instruction for the implementing model:

> Implement OPENAPI_IMPORT_PLAN.md through M6. Read AGENTS.md and HANDOFF.md and inspect the working tree. Follow the mapping decisions, work milestone by milestone, and run meaningful tests. Continue through store/UI integration and real Electron import-and-send acceptance. Update HANDOFF with evidence and remaining work. Finish all required gates and report genuine blockers precisely. Do not commit, push, or release without a separate request.

Standards references: [OpenAPI 3.0.4](https://spec.openapis.org/oas/v3.0.4.html) and [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html), especially server, parameter, reference, schema, and security definitions. These reference editions are not claimed as newest releases. Resource limits, fallbacks, selection orders, and unsupported subsets here are Restiprocity product decisions. Reference Objects and Schema Objects containing references have different sibling behavior; see the [3.1 Reference Object definition](https://spec.openapis.org/oas/v3.1.1.html#reference-object).

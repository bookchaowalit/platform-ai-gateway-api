# SPEC-002 — Tool calling, image input and JSON-schema output for client bots

Standard: ADR-0004 — TDD + SDD (architecture-docs, `docs/architecture/decisions/ADR-0004-tdd-sdd-standard.md`).

## Document control

| Field | Value |
|---|---|
| Spec ID / version | SPEC-002 / 1.0 |
| Status | approved; implemented on branch `spec/002-tools-vision`, awaiting DoD review and merge |
| Repository / path | bookchaowalit/platform-ai-gateway-api / `specs/002-tools-vision/spec.md` |
| Owner (maker) | Claude Code |
| Reviewer (checker) | Fresh Claude reviewer session (no maker context), plus Codex review at Stop |
| Approver | Owner (bookchaowalit) |
| Requirement links | Owner request 2026-11-07: "one central AI system for client bots; a new AI is a config change" |
| Related docs | `README.md`, `docs/shared-admission.md`, `api/ai_gateway.ts`; the first consumer's own migration plan lives in its private repository |
| Main-only | no: branch `spec/002-tools-vision`, merged locally after review |
| Created / approved | 2026-11-07 / 2026-11-07 (owner) |

## 1. Problem and intent

- **Problem:** `POST /api/ai/generate` accepts only plain-text `system`/`user`/`assistant` messages and returns one text
  `content`. Client bots need three more things: function tools (the model proposes a call and the bot runs it on its
  own ledger), image input (reading photographed documents), and strict JSON-schema output. They also handle
  customer personal data, which the gateway refuses (`privacy_class` `private` returns 403), and the only budget is one
  global monthly ceiling, so one client cannot be capped on its own. So the first client bot calls the provider directly
  with its own key, outside the gateway's budget, rate limit and telemetry.
- **Outcome:** a client bot can run its whole tool-use loop and its photo reading through the gateway. The bot still
  executes every tool itself; the gateway never runs a tool and stays stateless. It can be given a monthly budget of its
  own, and private data is accepted only for routes the owner allow-lists. Every existing text-only caller works as before.
- **Why now:** the first client bot is in production on a direct provider key; every new AI feature or client added
  that way makes the move later harder.

## 2. Scope

| In scope | Out of scope (non-goals) |
|---|---|
| Optional `tools`, `tool_choice`, assistant `tool_calls` and `tool` role messages on `/api/ai/generate` | The gateway executing tools, or keeping conversation state between requests |
| User content parts: `text` and `image` (base64 data URL only) | Fetching remote image URLs (SSRF risk); audio, PDF or video parts (audio stays on the media router) |
| `response_format: {type: "json_schema", json_schema: {name, schema, strict}}` | Streaming responses |
| Per-subject monthly budget (subject = the scoped token's `subject`) | Invoicing clients; the bot keeps its own usage report |
| Owner allow-list for `privacy_class: private` per route and subject | Accepting `restricted` data (still refused) |
| `GET /api/ai/status` advertises `capabilities` | A native Anthropic Messages adapter (separate spec; the adapter stays `openai-compatible`) |
| Telemetry counts (images, tool calls) without content | Moving the first client bot (done in its own repository, see §7 risk 6) |

## 3. Behaviour — scenarios

All tests are `node:test` under `tsx` with a fake `fetch`; no network.

### AC-01 — Text-only requests are unchanged

- **Given** a request with only string `content` messages and no new fields
- **When** it is sent to `generateAi`
- **Then** the provider body and the response are byte-for-byte what they are today (no `tools`, `capabilities` or new keys in the body)
- **And** the existing test suites pass unedited
- **Test:** `tests/ai_gateway.test.ts > "text-only request body is unchanged"` · level: unit

### AC-02 — Tools are forwarded and tool calls come back

- **Given** `tools: [{type:"function", function:{name, description, parameters, strict:true}}]` and a provider reply with `tool_calls` and `content: null`
- **When** the request is generated
- **Then** the provider body carries `tools` (and `tool_choice` when given) unchanged, with `parallel_tool_calls` passed through when given (boolean only)
- **And** the response has `content: null`, `tool_calls: [{id, name, arguments}]` with `arguments` as the raw string from the provider (not guaranteed valid JSON; consumers parse defensively), `finish_reason: "tool_calls"`, `output_trust: "untrusted_model_output"`
- **Test:** `tests/ai_gateway_tools.test.ts > "forwards tools and returns tool calls"` · level: unit

### AC-03 — A tool loop round trip is accepted

- **Given** messages `user`, `assistant` with `tool_calls`, then one `tool` message per call id
- **When** generated
- **Then** they are forwarded in order and the answer is returned
- **And** a `tool` message whose `tool_call_id` matches no earlier assistant call is a 400, as is an assistant call left without its `tool` reply, `tool` messages that do not directly follow their assistant message, or duplicate call ids
- **And** an assistant message with `tool_calls` may have `content: null`; a `tool` message may have empty string content; tool messages count toward the 40-message cap
- **Test:** `tests/ai_gateway_tools.test.ts > "accepts a tool round trip"`, `"rejects an orphan tool message"` · level: unit

### AC-04 — Tool definitions are bounded

- **When** a request has more than 32 tools, a tool name outside `^[A-Za-z0-9_-]{1,64}$`, duplicate names, a `parameters` schema over 16 KB, a non-`function` tool type, or `tool_choice` naming an unknown tool
- **Then** it is a 400 with a fixed message, and the provider is never called
- **Test:** `tests/ai_gateway_tools.test.ts > "rejects invalid tool definitions"` · level: unit

### AC-05 — Image parts are accepted as data URLs only

- **Given** a user message with `content: [{type:"text",text}, {type:"image", data_url:"data:image/jpeg;base64,..."}]`
- **When** generated
- **Then** the provider receives an OpenAI-compatible `image_url` part with the same data URL
- **And** `http(s)://` URLs, media types other than png, jpeg and webp, invalid base64, magic bytes that do not match the declared type, more than 4 images per request, a decoded image over `AI_GATEWAY_MAX_IMAGE_BYTES` (default 1 MB), or decoded images together over `AI_GATEWAY_MAX_TOTAL_IMAGE_BYTES` (default 2.5 MB, so the base64 body fits the 4 MiB body cap) are each a 400; images in `system`, `assistant` or `tool` messages are a 400
- **And** a body over `AI_GATEWAY_MAX_BODY_BYTES` is still a 413
- **And** the forwarded part is exactly `{type:"image_url", image_url:{url:"data:..."}}`
- **Test:** `tests/ai_gateway_vision.test.ts > "forwards a data-url image"`, `"rejects remote and malformed images"`, `tests/ai_gateway_service.test.ts > "images at the total cap fit the max body"` · level: unit + integration

### AC-06 — JSON-schema output

- **Given** `response_format: {type:"json_schema", json_schema:{name, schema, strict:true}}`
- **Then** it is forwarded as given; a schema over 16 KB or a bad `name` is a 400
- **And** a text reply that is not valid JSON is a 502 `invalid_response` (text is never repaired)
- **And** a reply that carries `tool_calls` with `content: null` is exempt from the JSON check (the schema applies to the final answer only)
- **And** the gateway checks only that the final text parses as JSON; matching the schema is the provider's strict mode plus the consumer's own check (strict schemas need `additionalProperties: false`)
- **And** `json_schema` may be combined with `tools`
- **And** a JSON parse failure never echoes model content in the error
- **And** the existing `json_object` rule (a message must ask for JSON) is unchanged
- **Test:** `tests/ai_gateway_tools.test.ts > "forwards json_schema and rejects non-JSON replies"` · level: unit

### AC-07 — Private data only on allow-listed routes

- **Given** `AI_GATEWAY_PRIVATE_ROUTES_JSON = {"<subject>": ["<route>", ...]}` and `AI_GATEWAY_PROVIDER_PRIVATE_DATA_ATTESTED=true`
- **When** a request has `privacy_class: "private"`
- **Then** it is accepted only when the caller's token subject lists that route and the attestation flag is set; otherwise 403 as today
- **And** `restricted` is always 403
- **And** a private request never goes to the fallback model unless `AI_GATEWAY_FALLBACK_PRIVATE_DATA_ATTESTED=true`; without it, a retryable primary failure is returned as is
- **And** the subject reaches `generateAi` as `options.privateRouteSubject`, set by `service.ts` only for a scoped static token with no workspace; a workspace or identity JWT whose `sub` equals an allow-listed key is refused (it is never read from the request body)
- **And** an invalid `AI_GATEWAY_PRIVATE_ROUTES_JSON` makes the gateway refuse every private request (fail closed) and `/api/ai/status` reports the reason
- **Test:** `tests/ai_gateway_privacy.test.ts > "private allowed only for allow-listed subject routes"`, `"private request skips an unattested fallback"` · level: unit

### AC-08 — Per-subject monthly budget

- **Given** `AI_GATEWAY_SUBJECT_BUDGETS_JSON = {"<subject>": <monthly_usd>}` and month-to-date spend for that subject in telemetry
- **When** a reservation would take that subject over its ceiling
- **Then** the request is a 429 `budget_exceeded` and other subjects are unaffected
- **And** the global `LLM_LAB_MONTHLY_BUDGET_USD` guard still applies to everyone
- **And** the subject ceiling is checked against that subject's own spent plus in-flight reserved amount (a per-subject reservation map, not the global `reservationState`); `createAiBudgetGuard` takes the subject
- **And** the budget key is the token `subject`; workspace JWT callers use the same `workspace:subject` key as the rate limiter
- **And** startup refuses `AI_GATEWAY_SUBJECT_BUDGETS_JSON` unless `AI_GATEWAY_ERROR_COST_POLICY=bounded`, so an unknown-cost error row cannot lock a subject out for the month; malformed JSON is a startup problem too
- **And** spend per budget key is read from the existing `metadata.subject` plus `metadata.workspace_id` that `withSubject` already writes (both must match for a workspace key; `workspace_id` absent for a plain token key), so no schema change is needed (an index on `json_extract(metadata_json,'$.subject')` only if the query is slow)
- **Test:** `tests/ai_budget.test.ts > "subject budget denies only that subject"`, `tests/ai_gateway_service.test.ts > "telemetry records subject"` · level: unit + integration (SQLite store)

### AC-09 — No content leaves through telemetry, logs or errors

- **Given** requests with images, tool arguments and tool results
- **Then** telemetry, Sentry events and error messages contain no image bytes, tool arguments, tool outputs or schema text; they hold only counts (`image_count`, `tool_count`, `tool_call_count`) and `has_tools`, `has_images`
- **And** the Sentry scrubber replaces any `data:image/...;base64,` string; request bodies and `extra` are already dropped, and no gateway error message carries tool arguments or outputs (validation messages are fixed text), which the telemetry and Sentry tests check by absence
- **Test:** `tests/ai_gateway_vision.test.ts > "telemetry holds counts only"`, `tests/sentry.test.ts > "scrubs image and tool payloads"` · level: unit

### AC-10 — Provider tool calls are bounded

- **When** the provider returns more than 16 tool calls, a call with arguments over 16 KB, a tool name not in the request, a missing call id, or `finish_reason: "length"` together with `tool_calls` (truncated arguments)
- **Then** the reply is a 502 `invalid_response` and nothing partial is returned
- **Test:** `tests/ai_gateway_tools.test.ts > "rejects unbounded provider tool calls"` · level: unit

### AC-11 — Fallback model with tools and images

- **Given** a fallback model is configured and the primary returns 429 or 5xx
- **Then** the same body, including tools and images, goes to the fallback; budget reservation and telemetry follow the existing two-row rule
- **Test:** `tests/ai_gateway_tools.test.ts > "falls back with tools and images"` · level: unit

### AC-12 — Clients can detect capabilities

- **When** `GET /api/ai/status` is called
- **Then** it returns `capabilities: {tools: true, image_input: true, json_schema: true, private_routes: <count of allow-listed routes for the caller>}` and `limits.max_image_bytes`
- **And** the MCP `ai_gateway.status` tool output passes the new fields through
- **Test:** `tests/ai_gateway_service.test.ts > "status advertises capabilities"`, `tests/ai_gateway_mcp.test.ts` · level: integration

### AC-13 — Image, tool and schema cost is reserved before the call

- **Given** a request with N images
- **Then** the budget reservation adds `N × AI_GATEWAY_IMAGE_TOKEN_ESTIMATE` input tokens (default 1,600) to the byte-based estimate, so a budget cannot be passed by sending images
- **And** the UTF-8 bytes of the serialized `tools`, `tool_choice`, assistant `tool_calls` and `response_format.json_schema` are added to the same estimate and to the `token_budget` pre-check, because the provider bills them as input
- **Test:** `tests/ai_budget.test.ts > "image requests reserve image tokens"`, `"tool and schema bytes count toward the estimate"` · level: unit

## 4. Interfaces and data

| Interface | Change | Contract |
|---|---|---|
| `POST /api/ai/generate` request | changed (additive) | New optional `tools`, `tool_choice` (`auto`, `none`, `required` or `{type:"function",function:{name}}`); `messages[].content` may be a parts array on `user`; `assistant.tool_calls`; role `tool` with `tool_call_id`; `response_format.type` adds `json_schema` |
| Tool call shapes | new | Request `assistant.tool_calls` uses the OpenAI form `[{id, type:"function", function:{name, arguments}}]` and is forwarded unchanged; the response flattens provider calls to `[{id, name, arguments}]`; consumers convert back when they send the next round |
| `POST /api/ai/generate` response | changed (additive) | `content: string \| null`; new `tool_calls: [{id, name, arguments}]`, present only when the request had tools |
| `GET /api/ai/status` | changed (additive) | `capabilities`, `limits.max_image_bytes` |
| Env | new | `AI_GATEWAY_PRIVATE_ROUTES_JSON`, `AI_GATEWAY_PROVIDER_PRIVATE_DATA_ATTESTED`, `AI_GATEWAY_SUBJECT_BUDGETS_JSON`, `AI_GATEWAY_MAX_IMAGE_BYTES`, `AI_GATEWAY_IMAGE_TOKEN_ESTIMATE`; raise `AI_GATEWAY_MAX_BODY_BYTES` to 2–4 MB on the service that takes images |
| Contract id | unchanged | Stays `solo-empire.ai-gateway.v1`: every change is optional and additive |

- **Data model / migration:** none planned. `store.ts` runs the migration SQL on every start, so an `ALTER TABLE ADD
  COLUMN` would fail on restart; per-subject spend uses the `metadata.subject` already stored. If an index turns out to
  be needed it is `CREATE INDEX IF NOT EXISTS` (idempotent), with a test that restarts on an existing database.
- **Backward compatibility:** text-only callers (current internal services and the MCP server) send nothing new and get
  the same body back (AC-01). `content` becomes nullable only for requests that send `tools`.
- **Provider parsing:** `callProvider` today treats non-string `content` as a 502; it changes to accept `content: null` when `tool_calls` are present.
- **Thai language policy:** the gateway still appends its Thai system message, and only to string `system` content. Tool and JSON-schema outputs are not
  affected because field names and JSON are kept as written (already in the policy text).

## 5. Non-functional requirements

| NFR | Target | How it is tested |
|---|---|---|
| Performance | Gateway overhead ≤ 50 ms for a 1 MB image request (validation + base64 check), excluding provider time | Informational timing in `tests/ai_gateway_vision.test.ts` (logged, fails only above 500 ms, so CI is not flaky) |
| Latency budget | A request, including one fallback, finishes within 2 × the timeout that applies to it: `AI_GATEWAY_TIMEOUT_MS`, or `AI_GATEWAY_REASONING_TIMEOUT_MS` when the request sets `reasoning_effort`; consumers with a hard deadline (for example a chat reply token) keep the applicable timeout ≤ 15 s | AC-11 test asserts the second attempt uses the same timeout as the first, for both the plain and the reasoning case |
| Security / privacy | No remote fetch; private data only on allow-listed routes with attestation; no content in telemetry, logs or Sentry; tool calls marked untrusted | AC-05, AC-07, AC-09, AC-10 |
| Reliability / observability | Same timeouts and fallback as text; telemetry counts for images and tools; status reports config errors | AC-11, AC-12 |
| Accessibility / UX | N/A: API only, no UI | — |

## 6. Test plan (TDD)

- **Test levels:** unit for validation, mapping and budget; integration for the HTTP service and SQLite telemetry store. No real provider calls in CI.
- **Test data:** synthetic tool schemas; a generated 1×1 PNG and JPEG and a crafted 1.1 MB image; fake subjects (`client-a`, `client-b`). No real bills, slips or customer names.
- **Coverage:** CI has no coverage gate (node:test under tsx writes no summary; see `ci.yml`). This change adds tests for every scenario and must not delete any.
- **Not test-first (exceptions):** none.

### Red / green log

Red runs are local (`npx tsx --test <file>`), committed before the implementation on this branch. Green is the local
full suite (`npm test`: 138 pass, 1 skipped as before) plus `npm run typecheck` and `npm run build`; the CI run URL is
added when the branch is pushed.

| Scenario | Test | Red: commit / run + failure message | Green: commit / run | Refactor note |
|---|---|---|---|---|
| AC-01 | `tests/ai_gateway_tools.test.ts > "AC-01 text-only request body is unchanged"` | f022bcc · passed on red (guard test: current behaviour) | 2222435 | none |
| AC-02 | `ai_gateway_tools > "AC-02 forwards tools…"`, `"…empty tool_calls list"` | f022bcc · `AssertionError: provider body tools undefined` | 2222435 | none |
| AC-03 (DoD review fix) | `ai_gateway_tools > "AC-03 an assistant tool-call message may omit content…"` | f87cdf7 · `400 content must be null or a string` | see green commit below | none |
| AC-03 | `ai_gateway_tools > "AC-03 …"` (4 tests) | f022bcc · `400 messages[1].content is empty or too large` on a valid round trip; orphan/duplicate cases not rejected for the tool reason | 2222435 | the 40-message cap test passed on red (guard) |
| AC-04 | `ai_gateway_tools > "AC-04 …"` (2 tests) | f022bcc · `Missing expected rejection` (tools ignored) | 2222435 | none |
| AC-05 | `ai_gateway_vision > "AC-05 …"` (3), `ai_gateway_service > "SPEC-002 AC-05 images at the total cap fit the max body"` | 3868f6e · `400 content is empty or too large` instead of image errors | 2222435 (service test 34cd5ee passed on red: green already in place) | none |
| AC-06 | `ai_gateway_tools > "AC-06 …"` (2) | f022bcc · `400 response_format must be text or json_object` | 2222435 | none |
| AC-07 (DoD review fix) | `ai_gateway_service > "SPEC-002 AC-07 private routes apply to scoped tokens only…"` | f87cdf7 · failed with `401 !== 403` (test bug: identity JWT needs one scope and a UUID sub), fixed in the green commit; with the pre-fix code that JWT's sub reached the allow-list and was admitted | see green commit below | none |
| AC-07 | `tests/ai_gateway_privacy.test.ts` (5) | 3a7922d · `403 Hosted AI generation is disabled` for an allow-listed route; fallback called for private data | 74aeb2d | deny cases passed on red (guards) |
| AC-08 (DoD review fix) | `ai_gateway_service > "SPEC-002 AC-08 subject budgets require the bounded error cost policy…"` | f87cdf7 · `no problem reported` | see green commit below | none |
| AC-08 | `ai_budget > "subject budget …"` (4), `ai_gateway_service > "SPEC-002 AC-08 …"` | 34cd5ee · `TS2554 expected 1-2 arguments` / second request 200 instead of 429 | 907c5de | none |
| AC-09 | `ai_gateway_vision > "AC-09 telemetry holds counts only"`, `sentry > "SPEC-002 AC-09 scrubs image and tool payloads"` | 3868f6e · request rejected (no image support); 34cd5ee · `data:image… not scrubbed` | 2222435, 907c5de | none |
| AC-10 | `ai_gateway_tools > "AC-10 …"` (2) | f022bcc · passed on red for the wrong reason (null content → 502); meaningful after green | 2222435 | none |
| AC-11 | `ai_gateway_tools > "AC-11 falls back with tools and images"`, `"…same timeout as the primary…"` | f022bcc · request rejected (no tools/images); timeout test cd8f03f is a characterization test of existing behaviour | 2222435, cd8f03f | none |
| AC-12 | `ai_gateway_service > "SPEC-002 AC-12 status advertises capabilities"`, `ai_gateway_mcp > "SPEC-002 AC-12 …"` | 34cd5ee · `capabilities undefined`; the MCP test first failed on a test bug (wrong JSON level), fixed before green; MCP already passes fields through | 907c5de | none |
| AC-13 | `ai_gateway_vision > "AC-13 …"` (3) | 3868f6e · request rejected (no image/tool support) | 2222435 | none |
| NFR perf | `ai_gateway_vision > "NFR gateway overhead…"` | n/a (informational) · 6.5 ms locally | cd8f03f | none |

## 7. Risks and open questions

| # | Risk or question | Impact | Owner | Resolution / date |
|---|---|---|---|---|
| 1 | Is client personal data (names, amounts, document photos) allowed through this gateway at all? The gateway stores no content, but it is one more processor in the path | Blocks AC-07 and the first consumer | Owner | Allowed by the owner 2026-11-07 (approval reply); still gated per route by AC-07 |
| 2 | Provider data retention: setting `AI_GATEWAY_PROVIDER_PRIVATE_DATA_ATTESTED=true` means the owner has checked the provider account's retention and training settings | Personal-data law exposure | Owner | open |
| 3 | Whose provider key and money pays for a client's calls once they go through the gateway | Billing and budget numbers in `AI_GATEWAY_SUBJECT_BUDGETS_JSON` | Owner | open |
| 4 | The gateway is one Railway replica with SQLite telemetry: if it is down, every client bot on it loses AI | Client outage while the gateway is down | Owner | Consumers keep a direct-provider rollback switch; shared admission (`docs/shared-admission.md`) is the route to more replicas |
| 5 | Providers differ in OpenAI-compatible tool and image support; a fallback model on another provider may reject tools | Fallback fails | Maker | Status reports the configured models; owner picks a fallback that supports tools |
| 7 | The OpenAI-compatible adapter carries no provider reasoning state (reasoning items, thinking blocks) between tool rounds, so tool-loop quality may differ from a native API | Consumer parity | Maker | Consumer evals compare both paths before any switch |
| 6 | Moving the first client bot is a separate change in its private repository (new `gateway` provider next to the direct ones, evals at parity, staging first) | Out of scope here | Maker | Planned in the consumer's private repository |

## 8. Change log

| Version | Date | Change | Scenarios affected | Approved by |
|---|---|---|---|---|
| 0.1 | 2026-11-07 | First draft | all | — |
| 1.1 | 2026-11-07 | DoD review fixes: private routes for scoped tokens only, subject budgets need the bounded error policy, omitted assistant content accepted; AC-09 wording matches what is tested. Not changed: a provider tool call without an id stays a 502 (AC-10 as approved) | AC-03, 07, 08, 09 | Owner approval of 1.0 covers it: tighter, no new scope |
| 1.0 | 2026-11-07 | Owner approved; implemented; red/green log filled | all | Owner |
| 0.2 | 2026-11-07 | Review fixes: subject plumbing, no migration, private fallback, wire shapes, tool/schema/image cost in both checks, total image cap, latency budget, tool-call JSON exemption, leak wording; spend key matches `workspace:subject`, latency budget covers the reasoning timeout | AC-02, 03, 05–11, 13 | — |

## Approval

| Gate | Role | Name / date | Decision | Evidence |
|---|---|---|---|---|
| Spec ready (before code, DoR) | Reviewer (checker) | Fresh Claude reviewer + Codex Stop review / 2026-11-07 | revise → fixed in 0.2 | 6 blocking + 8 non-blocking (Claude), 2 P2 (Codex) |
| Spec ready (before code, DoR) | Approver | Owner / 2026-11-07 | approve | Chat reply "Approve, start TDD" to the question "Approve SPEC-002 and allow client personal data through the gateway?" |
| Implemented (DoD) | Reviewer (checker) | Fresh Claude reviewer / 2026-11-07 | revise → fixed in 1.1 (1 blocking, 4 of 7 non-blocking fixed, rest documented) | review notes in the session; Codex Stop review pending |

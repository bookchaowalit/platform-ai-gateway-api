# SPEC-003 — Per-subject usage report for the shared provider key

Standard: ADR-0004 — TDD + SDD (architecture-docs, `docs/architecture/decisions/ADR-0004-tdd-sdd-standard.md`).

## Document control

| Field | Value |
|---|---|
| Spec ID / version | SPEC-003 / 1.0 |
| Status | implemented on branch `feat/per-subject-usage`, awaiting review and merge; local green: `npm test` 148 pass, 1 skipped (as before), `npm run typecheck` and `npm run build` pass |
| Repository / path | bookchaowalit/platform-ai-gateway-api / `specs/003-subject-usage/spec.md` |
| Owner (maker) | Claude Code |
| Reviewer (checker) | PR review plus Codex review at Stop |
| Approver | Owner (bookchaowalit) |
| Requirement links | Owner decision 2026-11-09: one OpenAI key for every system, usage split per system by gateway token subject |
| Related docs | `README.md`, `specs/002-tools-vision/spec.md` (AC-08 subject budgets), `api/ai_budget.ts` |
| Main-only | no: branch `feat/per-subject-usage`, merged locally after review |
| Created | 2026-11-09 |

## 1. Problem and intent

- **Problem:** since 2026-11-09 every system shares one provider key (the gateway's `AI_GATEWAY_API_KEY`) and one
  $5/month cap (`LLM_LAB_MONTHLY_BUDGET_USD`). The provider dashboard shows one total. `GET /api/ai/status` shows the
  same single total. Each telemetry row already stores the caller's token subject (`metadata.subject`), route, tokens,
  cost and status, but nothing reads it back per subject.
- **Outcome:** the owner can ask the gateway which subject (`production-tools`, `sheet-summaries`, `x-digest`, …) used
  how much of the month and of today, split by route, with error counts. Each other caller can see only its own usage.
- **Not visible here:** systems that call the provider directly with the same key (today: meeting-minutes) never reach
  the gateway, so their usage is not in this report. Moving them behind the gateway is a separate change.

## 2. Scope

| In scope | Out of scope (non-goals) |
|---|---|
| `GET /api/ai/usage?period=YYYY-MM`: per subject and per route, for the month and for today (UTC) | Changing any subject's behaviour, budget or rate limit (including `ev3-web`) |
| Admin view (all subjects) for a scoped static token with the explicit `ai:usage` scope | Granting `ai:usage` to any token (a Railway variable change; owner action) |
| Self view (own subject only) for every other `api:read` caller | A UI, Telegram digest or scheduled report |
| Read-only SQL over the existing `ai_run_telemetry` table | Schema changes or new migrations |

## 3. Behaviour — scenarios

All tests are `node:test` under `tsx`, with an in-memory SQLite telemetry store; no network.

### AC-01 — Aggregates per subject and route

- **Given** telemetry rows for several subjects and routes in one month, including error and budget-denied rows
- **When** the report is built for that month
- **Then** each subject lists `calls`, `success`, `errors` (status `error`), `budget_denied` (status `budget_exceeded`),
  `input_tokens`, `output_tokens`, `total_tokens`, `cost_usd` and `unknown_cost_calls` (provider called, cost `NULL`),
  overall and per route; totals add up across subjects; subjects are ordered by cost, highest first
- **And** rows from other months are not counted; rows without a subject are reported under `subject: null`
- **Test:** `tests/ai_usage.test.ts > "AC-01 aggregates per subject and route for the month"` · level: unit

### AC-02 — Today is reported next to the month

- **Given** rows earlier in the month and rows today (UTC)
- **When** the report is built for the current month
- **Then** `today` holds only today's rows, in the same shape; for a past month `today` is `null`
- **Test:** `tests/ai_usage.test.ts > "AC-02 reports today separately and only for the current month"` · level: unit

### AC-03 — Admin view needs an explicit `ai:usage` scope on a static token

- **Given** a scoped static token with `api:read` and `ai:usage`
- **When** it calls `GET /api/ai/usage`
- **Then** it gets `view: "all"` with every subject and each subject's `cost_share` of the month
- **And** a workspace/identity JWT carrying an `ai:usage` scope gets the self view only (JWT scopes come from other
  systems and never widen visibility); the check is a literal scope match, and `API_TOKENS_JSON` already refuses a `*`
  scope, so no wildcard path exists
- **Test:** `tests/ai_gateway_service.test.ts > "SPEC-003 AC-03 …"` · level: integration

### AC-04 — Every other reader sees only its own subject

- **Given** a token with `api:read` only
- **When** it calls `GET /api/ai/usage`
- **Then** it gets `view: "self"` with only its own subject's rows (and, for JWT callers, only its own workspace)
- **And** a token without `api:read` is refused (401/403 as on `/api/ai/status`)
- **Test:** `tests/ai_gateway_service.test.ts > "SPEC-003 AC-04 …"` · level: integration

### AC-05 — Period is validated

- **When** `period` is missing, the current UTC month is used; when it is not `YYYY-MM` with month 01–12, or is after
  the current month, the answer is 400 `invalid_period`; methods other than GET are 405
- **Test:** `tests/ai_usage.test.ts > "AC-05 …"`, `tests/ai_gateway_service.test.ts > "SPEC-003 AC-05 …"` · level: unit + integration

### AC-06 — No content leaves through the report

- **Given** a generate call whose prompt and output carry marker strings
- **When** the usage report is read
- **Then** the body holds no marker, no prompt, no output, no `run_id`, no `metadata_json` and no provider key: only
  subject, workspace id, route and counters
- **Test:** `tests/ai_gateway_service.test.ts > "SPEC-003 AC-06 …"` · level: integration

## 4. Interfaces and data

| Interface | Change | Contract |
|---|---|---|
| `GET /api/ai/usage` | new | Scope `api:read`; query `period=YYYY-MM` (optional). Response `{contract, report: "ai-gateway.usage.v1", view, period, timezone: "UTC", generated_at, month, today}`, where `month`/`today` are `{from, to, totals, subjects: [{subject, workspace_id, cost_share?, ...counters, routes: [{route, ...counters}]}]}` |
| Scopes | new | `ai:usage` (literal, on a scoped static token without workspace) widens the view to all subjects |
| Env / data model | unchanged | Reads `ai_run_telemetry` only; no migration |

- **Cost:** `cost_usd` is the gateway's own estimate (`estimated_cost_usd`, from the configured rate card), the same
  number the budget guard uses; it is not the provider's invoice.
- **Owner action to use the admin view:** add a token entry with `scopes: ["api:read", "ai:usage"]` to
  `API_TOKENS_JSON` on Railway (hash only), or add `ai:usage` to an owner token. Not done by this change.

## 5. Non-functional requirements

| NFR | Target | How it is tested |
|---|---|---|
| Security / privacy | No content, run ids or raw metadata in the response; cross-subject view only with an explicit static scope (literal match, no wildcard) | AC-03, AC-04, AC-06 |
| Performance | Two grouped queries on the indexed `created_at` range; a month of telemetry at current volume is well under 50 ms | not gated (volume is a few thousand rows a month) |
| Reliability | A store error is 503 `usage_unavailable`, never a partial report | covered by code review; no fault injection test |
| Accessibility / UX | N/A: API only | — |

## 6. Test plan (TDD)

- **Test levels:** unit for the aggregation module (`api/ai_usage.ts`) over an in-memory store; integration for the
  HTTP route through `createAiGatewayService`.
- **Test data:** synthetic subjects and routes, inserted rows with fixed `created_at`; no real usage data.
- **Coverage:** CI has no coverage gate; every scenario has a test.
- **Not test-first (exceptions):** none.

### Red / green log

| Scenario | Test | Red: commit + failure | Green: commit | Refactor note |
|---|---|---|---|---|
| AC-01, 02, 04, 05, 06 (unit) | `tests/ai_usage.test.ts` (5) | ef5eb97 · `ERR_MODULE_NOT_FOUND: Cannot find module '../api/ai_usage.js'` | ae3b00c | the AC-01 share tolerance was widened to 1e-3 because shares are rounded to 4 decimals (test bug, not behaviour) |
| AC-03–06 (integration) | `tests/ai_gateway_service.test.ts > "SPEC-003 …"` (3) | ef5eb97 · `404 !== 200` against the pre-change `service.ts` | ae3b00c | a planned wildcard-token case was dropped: `API_TOKENS_JSON` refuses a `*` scope, so it cannot be configured |

## 7. Risks and open questions

| # | Risk or question | Impact | Owner | Resolution / date |
|---|---|---|---|---|
| 1 | Direct-to-provider callers (meeting-minutes) are invisible to this report | Report under-counts the shared key | Owner | Separate follow-up: route them through the gateway |
| 2 | No token has `ai:usage` yet | Admin view unusable until the owner adds one | Owner | open (Railway `API_TOKENS_JSON`) |
| 3 | "Today" is a UTC day (07:00–07:00 Bangkok), matching the budget month | Owner may expect a Bangkok day | Maker | documented in the response (`timezone: "UTC"`) |

## 8. Change log

| Version | Date | Change | Scenarios affected | Approved by |
|---|---|---|---|---|
| 1.0 | 2026-11-09 | First version; implemented | all | pending owner review on the PR |
| 1.1 | 2026-11-09 | Security review: the report takes an explicit `view` (`admin` or `self` with a non-empty subject) and throws otherwise, so a missing caller can never fall open to the all-subjects view; test `ai_usage > "AC-03 the admin view is never implied…"` | AC-03 | tighter, no new scope |

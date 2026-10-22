# Product

<!-- impeccable:product-schema 1 -->

## Platform

api

## Users

- Owner apps and automations that call a model through one endpoint, each with its own scoped
  bearer token listed (as a SHA-256 hash) in `API_TOKENS_JSON`. Which clients hold tokens today:
  [ต้องยืนยัน] (the rate-limit docs use `ev3-web` as an example subject).
- The owner's agent sessions, through the read-only MCP server `ai-gateway-mcp`
  (`mcp/ai-gateway-mcp.ts`): status, budget and rate-limit tools over `GET /api/ai/status`.

## Product Purpose

One authenticated HTTPS endpoint (`solo-empire.ai-gateway.v1`) that routes model calls, enforces
per-client scopes, rate limits and a monthly budget, and records run telemetry without storing
prompts or outputs. Apps never hold upstream provider keys.

Success: every model call goes through a scoped token, spend stays inside the monthly budget, and
telemetry explains each run (route, model, tokens, cost, latency) with no prompt or output text.

## Positioning

A small, provider-neutral gateway (OpenAI-compatible upstream, primary model plus one fallback per
profile) instead of each app calling providers directly. It owns its routing, budget, rate-limit
and auth rules in `api/` and its telemetry store (SQLite on a Railway volume).

## Operating Context

- Production: `https://api.bookchaowalit.com` (health `/healthz`), Railway project
  `platform-ai-gateway-api`, service `ai-gateway`, always-on (registry `online-systems.yaml`,
  id `ai-gateway`). Deploys from `main` after CI passes (Railway Wait for CI).
- Data: Railway volume at `/data` (`AI_GATEWAY_DB_PATH`, SQLite run telemetry,
  `database/migrations/025_ai_run_telemetry.sql`).
- Secrets live only in Railway variables (`API_TOKENS_JSON`, upstream keys, `SENTRY_DSN`).
- Errors go to Sentry when `SENTRY_DSN` is set (`api/ai-gateway-service/sentry.ts`: tracing off, no
  baggage, events scrubbed). Runbook: solo-empire `operations/runbooks/AI-API-GATEWAY-RUNBOOK.md`.

## Capabilities and Constraints

- `GET|HEAD /healthz` (no auth; 503 when the telemetry store is unavailable).
- `GET /api/ai/status` (scope `api:read`): contract, models, budget, rate limit, service limits.
- `POST /api/ai/generate` (scope `ai:generate`): one model call with route, prompt version,
  messages, profile (`fast|balanced|quality`), privacy class and token budget; Thai is the default
  response language.
- `POST /api/media/route` (scope `ai:generate`): picks a transcription route from
  `platform/media-transcription-routing.json`; it does not transcribe.
- Auth: hosted requests accept only scoped tokens (never the legacy `API_TOKEN` or
  `ALLOW_UNAUTH_DEV`); a config with a raw token, a bad hash, subject, scope or expiry makes every
  request fail closed; the service refuses to start without at least one token hash. `api:write`
  implies `api:read`; expired tokens get 401, missing scope 403.
- Rate limits per subject (`AI_GATEWAY_SUBJECT_LIMITS_JSON`: requests per minute and concurrent
  requests) answer 429; a monthly budget (`AI_GATEWAY_MONTHLY_BUDGET_USD` /
  `LLM_LAB_MONTHLY_BUDGET_USD`) blocks calls once spent, and a missing or broken budget answers 503
  when the budget is required.
- Out of scope: storing prompts or outputs, streaming (upstream calls use `stream: false`), media
  transcription itself, and any generate tool in the MCP server.

## Measures

- Share of `/api/ai/generate` calls answered 200 versus 429, 503 and 5xx (telemetry and Sentry).
- Monthly spend against the budget (`/api/ai/status` budget block).
- Fallback-model use and p95 latency per route (run telemetry).
- `/healthz` uptime (`platform-uptime-worker` target `ai-gateway`).

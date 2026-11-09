# platform-ai-gateway-api
Central AI Gateway (`solo-empire.ai-gateway.v1`): one authenticated HTTPS
endpoint that routes model calls, enforces per-client scopes, rate limits and
budgets, and records run telemetry without storing prompts or outputs.

| | |
|---|---|
| Public URL | https://api.bookchaowalit.com (health: `/healthz`) |
| Host | Railway project `platform-ai-gateway-api`, service `ai-gateway`, always-on |
| Data | Railway volume at `/data` (SQLite telemetry) |
| Registry | solo-empire `repository-catalog/registries/online-systems.yaml` (`ai-gateway`) |
| Runbook | solo-empire `operations/runbooks/AI-API-GATEWAY-RUNBOOK.md` |

Extracted from the solo-empire monorepo (`infra/api/ai-gateway-service` and its
gateway modules) on 2026-10-10. This repository is now the source of truth for
the hosted service.

## Layout

```
api/                     gateway modules (routing, budget, rate limit, auth)
api/ai-gateway-service/  HTTP service, telemetry store, entrypoint, build
database/migrations/     telemetry schema
tests/                   node:test suites, *.test.ts (run with tsx)
Dockerfile, railway.json build and deploy config (repository root is the context)
```

## Develop

```bash
npm install
npm test
npm run build       # also installs api/ai-gateway-service deps (@sentry/node), needed by typecheck
npm run typecheck   # tsc --noEmit, strict, over api/, mcp/ and tests/
```

## Deploy

Railway variables hold every secret (`API_TOKENS_JSON`, upstream keys, `SENTRY_DSN`);
none live in this repository. `SENTRY_DSN` turns on error reporting (unset = off; see
`api/ai-gateway-service/sentry.ts`), with `SENTRY_ENVIRONMENT`.

Deploys (CD, since 2026-10-18): the Railway service is connected to this repository's `main` with
Railway's Wait for CI (`checkSuites`). A merge to `main` deploys only after the CI and security
checks pass; a failing check leaves production on the previous deployment. Roll back by
redeploying an earlier deployment in Railway. `railway up` is no longer used.

After a merge, check the deployment and health:

```bash
curl -fsS https://api.bookchaowalit.com/healthz
```

## MCP server (`ai-gateway-mcp`)

`mcp/ai-gateway-mcp.ts` is the gateway's MCP server (stdio, `@modelcontextprotocol/sdk`). It is read-only: three tools
(`ai_gateway.status`, `ai_gateway.budget`, `ai_gateway.rate_limit`) that each make one `GET /api/ai/status` call (scope
`api:read`) with the caller's own scoped gateway token. There is deliberately no generate or media-route tool (those
spend provider budget). No tool accepts an actor, workspace, tenant, delegation or token argument; inputs are strict, so
unknown arguments are rejected before any HTTP call. Errors are a fixed message from the HTTP status (for example
`403: forbidden`), never upstream text; tokens with whitespace or control characters are refused.

- URL: `EMPIRE_AI_GATEWAY_API` (env, else the owner-only `~/.config/empire-platform/client.env`); https, http only on
  loopback, no credentials, query or fragment.
- Token, first match wins: `EMPIRE_TOKEN`, `EMPIRE_TOKEN_FILE` (mode 600), then the owner's
  `~/.config/solo-empire/production-tools.ai-gateway.token` (mode 600). This is a scoped gateway token, not an Empire
  platform JWT, so the platform automation tokens do not apply here.
- Run: `npm install`, then `npm run mcp` or `node mcp/bin.mjs` (see `.mcp.json`; `bin: ai-gateway-mcp`). It runs through
  `tsx`; the hosted service build and Dockerfile do not use it.
- Tests: `npm test` (`tests/ai_gateway_mcp.test.ts`; fake `fetch`, in-memory MCP client, no network).

## Tools, images and JSON schema (SPEC-002)

`POST /api/ai/generate` also accepts, all optional and additive (text-only callers are unchanged):

- `tools` (1–32 OpenAI-style function tools), `tool_choice`, `parallel_tool_calls`. The gateway forwards them and
  returns `tool_calls: [{id, name, arguments}]` (`content` is `null` on a tool-call turn); the caller runs every tool
  and sends the next round with an assistant `tool_calls` message and one `tool` message per call. The gateway keeps
  no state and never executes a tool. `arguments` is the provider's raw string: parse it defensively.
- User content parts: `[{type:"text",text}, {type:"image",data_url:"data:image/jpeg;base64,..."}]`. PNG, JPEG and
  WebP data URLs only (no remote URLs); at most 4 images.
- `response_format: {type:"json_schema", json_schema:{name, schema, strict}}`. A final text reply must parse as JSON.

Settings (Railway variables):

| Variable | Default | Meaning |
|---|---|---|
| `AI_GATEWAY_MAX_IMAGE_BYTES` / `AI_GATEWAY_MAX_TOTAL_IMAGE_BYTES` | 1 MiB / 2.5 MiB | Decoded size per image and per request. Raise `AI_GATEWAY_MAX_BODY_BYTES` (max 4 MiB) to take images |
| `AI_GATEWAY_IMAGE_TOKEN_ESTIMATE` | 1600 | Input tokens reserved per image for `token_budget` and the budget guard |
| `AI_GATEWAY_PRIVATE_ROUTES_JSON` | unset | `{"<scoped token subject>": ["<route>", ...]}`: routes that may send `privacy_class: "private"`. Only scoped static tokens (`API_TOKENS_JSON`) qualify; workspace and identity JWTs never do. Malformed = every private request refused |
| `AI_GATEWAY_PROVIDER_PRIVATE_DATA_ATTESTED` | off | Owner has checked the provider's retention and training settings; required for any private request |
| `AI_GATEWAY_FALLBACK_PRIVATE_DATA_ATTESTED` | off | Same for the fallback model; without it private requests never fall back |
| `AI_GATEWAY_SUBJECT_BUDGETS_JSON` | unset | `{"<subject or workspace:subject>": <monthly USD>}`: per-caller monthly cap on top of the global budget. Startup refuses it unless `AI_GATEWAY_ERROR_COST_POLICY=bounded` (otherwise one provider error row with an unknown cost would lock that caller out for the month) |

Notes for operators: a failed telemetry write keeps that request's budget reservation (global and subject) until the
process restarts, as the global guard always did. The `response_format` 400 message now also names `json_schema`.

`GET /api/ai/status` reports `capabilities` (tools, image input, json_schema, the caller's private route count and
whether that config parsed) and the image limits.

## Per-subject usage (SPEC-003)

Every system shares one provider key, so usage is split by gateway token subject. `GET /api/ai/usage?period=YYYY-MM`
(scope `api:read`; `period` defaults to the current UTC month) returns, for the month and for today (UTC), per subject
and per route: `calls`, `success`, `errors`, `budget_denied`, `input_tokens`, `output_tokens`, `total_tokens`,
`cost_usd` (the gateway's rate-card estimate, as the budget guard uses) and `unknown_cost_calls`. No prompts, outputs,
run ids or raw metadata are returned.

- A scoped static token with the literal `ai:usage` scope (next to `api:read`) gets `view: "all"` with every subject and
  its `cost_share`. JWT callers never get the all view, whatever scopes they carry.
- Every other caller gets `view: "self"`: its own subject (and workspace) only.
- Systems that call the provider directly with the same key (for example meeting-minutes) are not in this report.

```bash
curl -s -H "Authorization: Bearer $AI_GATEWAY_USAGE_TOKEN" "https://<gateway>/api/ai/usage?period=2026-11"
```

## Staged shared admission

The default production behavior remains unchanged. Explicit workspace JWT and
shared rate/budget admission are available for staged multi-replica verification.
See [configuration, durable-charge semantics and release gates](docs/shared-admission.md).
This code has not activated a new issuer, admission service or production replica.

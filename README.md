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

## Staged shared admission

The default production behavior remains unchanged. Explicit workspace JWT and
shared rate/budget admission are available for staged multi-replica verification.
See [configuration, durable-charge semantics and release gates](docs/shared-admission.md).
This code has not activated a new issuer, admission service or production replica.

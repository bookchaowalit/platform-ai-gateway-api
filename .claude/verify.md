# Verify recipe (platform-ai-gateway-api)

The `verify` skill follows this file. The checks are the ones CI runs.

## Checks

```bash
npm ci
npm --prefix api/ai-gateway-service ci --no-audit --no-fund && npm run typecheck
npm test
npm run build
```

Tests use fake `fetch` and loopback servers. The shared-data integration test skips without
`AI_GATEWAY_TEST_PG_DSN` (a throwaway Postgres only): say whether it ran. No coverage gate.

## End to end

```bash
AI_GATEWAY_DB_PATH=$PWD/.local/ai-gateway.sqlite API_TOKENS_JSON='<hashed test token>' \
  npm --prefix api/ai-gateway-service start
curl -fsS localhost:8080/healthz
```

Then `GET /api/ai/status` with an `api:read` test token, and one request that must be refused (no
token, wrong scope). Never call a generate route with a real provider key.

## Never

- `railway up` from a working tree; `npx wrangler deploy` in `workers/media-worker`.
- `https://api.bookchaowalit.com` generate or media routes with a real token (spends provider budget).
- The shared-admission release preflight; the integration test with anything but a throwaway DB.

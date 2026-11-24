# Verify recipe (platform-ai-gateway-api)

The `verify` skill follows this file. The checks are the ones CI runs.

## Checks

```bash
npm ci
npm --prefix api/ai-gateway-service ci --no-audit --no-fund && npm run typecheck
npm test
npm run build
```

Tests use fake `fetch` and loopback servers. The shared-data integration test runs only with both
`AI_GATEWAY_TEST_DATA_PYTHON` (a Python env with `platform-data` installed) and
`AI_GATEWAY_TEST_PG_DSN` (a throwaway Postgres only); with either missing it skips silently. Use
the command in `docs/shared-admission.md` ("opt-in real platform-data integration test") and say
whether it ran. No coverage gate.

## End to end

After `npm run build`, as one script. The token is random, lives only in this shell, and only its
SHA-256 goes into `API_TOKENS_JSON` (an array of `subject`, `token_hash`, `scopes`; `api/auth.ts`).

```bash
set -eu
mkdir -p .local
TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
HASH=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
export API_TOKENS_JSON="[{\"subject\":\"local-verify\",\"token_hash\":\"$HASH\",\"scopes\":[\"api:read\"]}]"
export AI_GATEWAY_DB_PATH=$PWD/.local/ai-gateway.sqlite PORT=8097 AI_GATEWAY_BIND_HOST=127.0.0.1
node --disable-warning=ExperimentalWarning api/ai-gateway-service/dist/server.mjs & PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 50); do curl -fsS -o /dev/null localhost:8097/healthz 2>/dev/null && break; kill -0 $PID; sleep 0.2; done
curl -fsS localhost:8097/healthz
curl -fsS -o /dev/null -w 'status %{http_code}\n' -H "Authorization: Bearer $TOKEN" localhost:8097/api/ai/status  # 200
curl -s -o /dev/null -w 'no token %{http_code}\n' localhost:8097/api/ai/status                                  # 401
curl -s -o /dev/null -w 'wrong scope %{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' localhost:8097/api/ai/generate                                   # 403
```

Never call a generate route with a real provider key.

## Never

- `railway up` from a working tree; `npx wrangler deploy` in `workers/media-worker`.
- `https://api.bookchaowalit.com` generate or media routes with a real token (spends provider budget).
- The shared-admission release preflight; the integration test with anything but a throwaway DB.

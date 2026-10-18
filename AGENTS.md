# Agent Instructions

- Human-facing replies are in Thai by default; keep code, commands and identifiers as-is.
- Never print, commit or copy secrets. Railway variables are the only secret store.
- Run `npm test` and `npm run build` before committing.
- Merging to `main` deploys production (Railway GitHub source + Wait for CI); verify `/healthz`
  afterwards. Do not `railway up` from a working tree.
- Keep the solo-empire registry entry (`ai-gateway` in
  `repository-catalog/registries/online-systems.yaml`) in sync when the URL,
  host or data store changes.
- `mcp/ai-gateway-mcp.ts` is the read-only MCP server over `GET /api/ai/status`: caller token only, no identity arguments, no generate tool; keep it in step with that endpoint and run `npm test`.

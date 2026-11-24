# Review guide (platform-ai-gateway-api)

The Codex Stop-hook review reads this file from the default branch, never from the change under
review. Owner-written; keep it under 16 KiB.

## What failure looks like here

Treat these as `[P0]`/`[P1]`:

- **Auth fails open**: a raw token, bad hash, bad scope or expiry accepted (`PRODUCT.md`,
  `specs/001-l2-baseline/spec.md` AC-04); `ALLOW_UNAUTH_DEV` reachable.
- **Budget**: a missing or broken budget must answer 503; subject budgets need
  `AI_GATEWAY_ERROR_COST_POLICY=bounded`; media budget reserved before enqueue and settled after
  (`specs/003-media-generation/spec.md` AC-06); media models ship disabled and unpriced.
- **Content leaking**: no prompt or output in telemetry, logs, the queue, Sentry or error bodies
  (`README.md`, spec 003 AC-16).
- **Private data** sent to a route that is not allow-listed or without attestation
  (`specs/002-tools-vision/spec.md` AC-07).
- **Worker routes** accepting any token but exactly scope `ai:media-worker`.
- **MCP** gaining a generate tool or identity arguments (it stays read-only).
- **Registries**: `platform/*.json` routing and price changes are reviewed as money changes.

Merging to `main` deploys production.

## Severity

- `[P0]` spend without a budget, auth bypass, prompt or output content stored or logged, private data to an unapproved route.
- `[P1]` a model route, price or status that is wrong for real callers.
- `[P2]` edge case, or changed behaviour without a test.
- `[P3]` nit. **At most 3 nits.**

## Skip

- `node_modules/`, `api/ai-gateway-service/node_modules/` and `dist/`, both `package-lock.json`,
  `DOCPACK/pdf`, `tests/fixtures/`.

## Evidence

Every finding gives `file:line` and input -> wrong result. No finding without evidence from the diff
or the code it calls. Start the summary with the count, e.g. `2 findings (1 P1, 1 P3)`.

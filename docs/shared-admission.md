# Staged shared AI admission — SHARED-INFRA-2026-10-15

Implemented and locally tested; no production cutover or production scale claim.
The default remains `AI_GATEWAY_ADMISSION_MODE=legacy` with
`AI_GATEWAY_AUTH_PROFILE=scoped`: existing hashed service tokens, local rate
counters, SQLite telemetry and the existing monthly hard ceiling.

The explicit `shared` mode requires `workspace-jwt`. There is no fallback to
legacy auth/admission when this configuration is missing or a dependency fails.
Malformed configuration refuses startup; runtime admission outages return503,
exhaustion429. `/healthz` remains a telemetry-store liveness check. `/readyz`
checks the telemetry store, service JWT validity and bounded data `/readyz`.
These probes do not certify an individual workspace's policies or system
workspace configuration; the release preflight below is required.

## Operator configuration

| Variable | Meaning |
| --- | --- |
| `AI_GATEWAY_AUTH_PROFILE` | `workspace-jwt`; default `scoped` |
| `AI_GATEWAY_ADMISSION_MODE` | `shared`; default `legacy` |
| `AI_GATEWAY_JWT_ISSUER` | Exact staged issuer; no implicit trust cutover |
| `AI_GATEWAY_JWT_PUBLIC_KEY_PEM` | Explicit RSA public verification key, >=2048bits |
| `AI_GATEWAY_SHARED_DATA_URL` | Operator-controlled origin, HTTPS; loopback HTTP only with `NODE_ENV=test` or `development`; no credentials/path/query/fragment |
| `AI_GATEWAY_SHARED_SERVICE_TOKEN` | Explicit short-lived JWT with `scope=quotas:service`, `ws` equal to data's configured system workspace |
| `AI_GATEWAY_SHARED_RATE_POLICY` | Existing caller-workspace request policy |
| `AI_GATEWAY_SHARED_GLOBAL_RATE_POLICY` | Existing system-workspace platform request policy |
| `AI_GATEWAY_SHARED_BUDGET_POLICY` | Existing caller-workspace USD budget policy |
| `AI_GATEWAY_SHARED_GLOBAL_BUDGET_POLICY` | Existing system-workspace platform USD policy |
| `AI_GATEWAY_SHARED_TIMEOUT_MS` | Per-admission HTTP operation deadline;1–10000, default2000 |
| `AI_GATEWAY_SHARED_MAX_INFLIGHT` | Per-replica admission/readiness HTTP bound;1–100, default32 |

Existing provider rates, output limits and monthly hard-ceiling settings still
apply. `AI_GATEWAY_REQUIRE_BUDGET` retains its existing behavior. The global
shared budget policy is the multi-replica authority; the SQLite monthly guard
remains an additional deny gate. Local concurrency/request limits remain
per-replica protection, not shared quota evidence. Existing rate-limit response
headers describe that local guard. Size bounds remain1MiB by default for caller
JSON (configured maximum4MiB),16KiB for admission responses, and bounded small
operator-generated admission request bodies. Redirects and retries are disabled.
No user/service JWT, prompt, response or upstream payload is logged.

### JWT compatibility

Both user and service tokens use RS256, exact configured `iss`, audience string
`platform-api`, UUID `sub` and `ws`, integer `iat`/`exp`, optional integer `nbf`,
and nonempty bounded `jti`. Lifetime is at most3600seconds, no clock tolerance,
no future `iat`, and no expired token. `nbf`, if present, must be within
`[iat,exp)`. Scope comes from the common runtime's space-delimited `scope`
string, never `scopes`, `tenant_id=owner`, wildcard permissions or request
workspace fields. User generation needs `ai:generate`; status/MCP needs
`api:read`. Service scope never substitutes for user scope. Workspace/tenant
headers and top-level workspace body overrides are rejected on generation.
PEM/key rotation and service-token replacement are explicit operator changes;
expired service tokens fail closed. No credential discovery is performed.

### Durable charge behavior

Before generation, the gateway reserves both workspace and platform request
quota via `POST /v1/service/admissions`, then settles that request count to1.
Before **each** provider attempt, it reserves both USD budgets using a distinct
server-generated idempotency key. The configured policy names never come from
request JSON. Headers are the separate service Bearer token and the original
verified caller Bearer token in `X-Workspace-Authorization`.

USD units are micro-USD: reserve `max(1,ceil(unrounded_estimated_usd*1000000))`.
The1microUSD quantum also supports explicit known-free configurations; actual
zero settles to0. Estimates use UTF-8 message bytes plus message overhead and
the enforced output allowance. Primary and fallback rate cards are applied to
their own attempts; settlement uses the provider's reported actual usage,
conservatively rounded up. Existing telemetry retains its historical precision
and error-cost policy. A provider exceeding its declared maximum can create
budget debt; this is a reconciliation incident, never a reason to drop charge.

Unknown usage, provider errors, lost/malformed responses, process crashes and
settlement failures preserve durable reservation charge. This deliberately
includes HTTP errors even where legacy bounded telemetry records zero. No
automatic release occurs, and a reservation TTL does not refund an unknown
charge. A failed settlement returns503 and does not trigger another provider
attempt. A failed primary may use one fallback only after its separate budget
reservation succeeds; the primary's unknown charge remains reserved.

Data's composite operation can conservatively retain a global leg after a
tenant denial or interruption. Operators reconcile such retained reservations
from the data-owned durable mapping and provider evidence; clients must not
infer that a429 or timeout refunded capacity. The gateway generates new
idempotency keys rather than retrying ambiguous admission operations.

## Release preflight (not performed in production)

1. Deploy/migrate platform-data and configure its explicit
   `PLATFORM_SYSTEM_WORKSPACE_ID`; grant the runtime role required RLS access.
2. Provision separate tenant and system rate/USD policies with appropriate
   windows. USD limits must account for existing spend, subscriptions, storage,
   GPU commitments and other consumers before allocating gateway headroom.
   Every gateway replica must share the same platform policies. Coordinate
   monthly policy rollover and any non-gateway spend through that authority.
3. Inject explicit staged issuer/public key and short-lived service token from
   the environment's secret store. Preserve identity's production shadow gate.
4. Verify `/readyz`, then run a synthetic caller through the actual composite
   reservation/settlement path, including policy absence and cross-workspace
   denial. A healthy dependency alone does not prove authorization/policy setup.
5. Verify two replicas under concurrency, actual settlement, outage and crash
   retention, and reconcile all synthetic reservations. Obtain production
   release approval separately. No live provider calls are needed for these gates.

## Verification

`npm test` includes real loopback admission/provider HTTP fixtures, JWT
validation, two independent gateway servers, shared quotas, tenant separation,
unknown-charge retention, fallback, hard-ceiling compatibility, readiness,
response limits, no redirects, bounded deadlines and settlement outages.
`npm run build` builds the hosted bundle; Docker copies the new modules.

The opt-in real platform-data integration test uses its installed Python package
and a disposable PostgreSQL database with a non-superuser/non-BYPASSRLS role:

```bash
AI_GATEWAY_TEST_DATA_PYTHON=/path/to/explicit/venv/bin/python3 \
AI_GATEWAY_TEST_PG_DSN='explicit disposable local admin DSN' npm test
```

No repository or credential path is discovered. The fixture applies data's
migrations, provisions policies through verified JWT HTTP calls, runs two
independent gateways, verifies tenant and platform limits and actual usage
settlement, then drops only its own isolated database/role. The normal suite
reports this case skipped without explicit integration configuration.

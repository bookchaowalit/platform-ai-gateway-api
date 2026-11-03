# 10 — Sequences

## 1. Generate (default scoped + legacy admission)

```mermaid
sequenceDiagram
  autonumber
  participant C as "Client app"
  participant S as "service.ts"
  participant A as "auth.ts"
  participant RL as "ai_rate_limit.ts"
  participant B as "ai_budget.ts"
  participant G as "ai_gateway.ts"
  participant P as "Provider"
  participant DB as "SQLite"
  C->>S: POST /api/ai/generate Bearer token
  S->>A: authenticate(req, "ai:generate")
  A-->>S: subject, scoped
  S->>S: readJsonBody max 1 MiB
  S->>RL: acquire(subject)
  RL-->>S: permit or 429
  S->>B: getAiBudgetStatus, createAiBudgetGuard
  B->>DB: SELECT SUM(estimated_cost_usd) this month
  S->>G: generateAi(body, env, guard)
  G->>B: reserve(estimate)
  G->>P: POST chat completions, stream false
  P-->>G: choices + usage
  G->>DB: record telemetry row
  G-->>S: response + telemetry
  S->>RL: permit.release()
  S-->>C: 200 JSON + X-RateLimit headers
```

## 2. Primary failure then fallback

```mermaid
sequenceDiagram
  autonumber
  participant G as "ai_gateway.ts"
  participant B as "Budget guard"
  participant P as "Provider"
  participant DB as "SQLite"
  G->>B: reserve(primary estimate)
  G->>P: primary model
  P-->>G: 5xx, 429, timeout or network error
  G->>DB: row attempt primary, parent_run_id
  G->>B: release primary, reserve(fallback estimate)
  G->>P: fallback model, once
  P-->>G: success
  G->>DB: row with fallback_used true, primary_error_class
```

## 3. Shared admission (staged, workspace-jwt + shared)

```mermaid
sequenceDiagram
  autonumber
  participant C as "Workspace caller"
  participant S as "Gateway"
  participant D as "platform-data"
  participant P as "Provider"
  C->>S: POST /api/ai/generate Bearer workspace JWT
  S->>S: verify RS256, iss, aud platform-api, ws, scope ai:generate
  S->>D: POST /v1/service/admissions rate units 1
  S->>D: POST /v1/service/admissions/id/settle actual 1
  S->>D: POST /v1/service/admissions budget micro-USD
  S->>P: provider attempt
  P-->>S: usage
  S->>D: settle actual micro-USD
  S-->>C: 200
  Note over S,D: Ambiguous outcome keeps the reservation charged, no retry
```

## 4. Startup

```mermaid
sequenceDiagram
  autonumber
  participant R as "Railway"
  participant E as "entrypoint.sh"
  participant M as "main.ts"
  participant DB as "SQLite /data"
  R->>E: start container as root
  E->>E: chown /data, setpriv to node
  E->>M: node dist/server.mjs
  M->>M: initSentry if SENTRY_DSN
  M->>DB: open, WAL, synchronous FULL, apply 025 migration
  M->>M: serviceConfigurationProblems, exit 1 on any
  M-->>R: listen 0.0.0.0:PORT, healthcheck /healthz
```

Sources: `api/ai-gateway-service/service.ts`, `api/ai_gateway.ts` (`generateAi`, `callProvider`), `api/ai_budget.ts`, `api/ai_rate_limit.ts`, `api/ai_shared_admission.ts`, `api/workspace_auth.ts`, `api/ai-gateway-service/main.ts`, `api/ai-gateway-service/entrypoint.sh`, `api/ai-gateway-service/store.ts`, `railway.json`

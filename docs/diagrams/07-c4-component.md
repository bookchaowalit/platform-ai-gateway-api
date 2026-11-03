# 07 — C4 Component (ai-gateway service)

```mermaid
C4Component
  title Components - ai-gateway service
  Container_Boundary(svc, "ai-gateway service") {
    Component(main, "main.ts", "Entry", "Sentry init, open store, listen, SIGTERM drain 70 s")
    Component(http, "service.ts", "HTTP router", "healthz, readyz, status, generate, media route; body limit; config checks")
    Component(auth, "auth.ts", "Scoped tokens", "SHA-256 hash compare, scopes, expiry")
    Component(wsauth, "workspace_auth.ts", "Workspace JWT", "RS256 via jose, aud platform-api, staged")
    Component(rl, "ai_rate_limit.ts", "Rate limiter", "Per-subject window and concurrency, in process")
    Component(budget, "ai_budget.ts", "Budget guard", "Month-to-date spend plus reservations")
    Component(shared, "ai_shared_admission.ts", "Shared admission", "Reserve and settle at platform-data")
    Component(core, "ai_gateway.ts", "Gateway core", "Validate, Thai policy, provider call, fallback, telemetry event")
    Component(media, "media_router.ts", "Media router", "Registry-driven STT choice")
    Component(store, "store.ts", "Telemetry store", "node:sqlite upsert and ping")
    Component(sentry, "sentry.ts", "Error reporting", "Scrubbed, tracing off")
  }
  ContainerDb(db, "SQLite /data/ai-gateway.sqlite", "node:sqlite")
  System_Ext(llm, "Provider", "OpenAI-compatible")
  Rel(main, http, "createAiGatewayService")
  Rel(http, auth, "authenticate default profile")
  Rel(http, wsauth, "authenticate workspace-jwt profile")
  Rel(http, rl, "acquire and release")
  Rel(http, budget, "createAiBudgetGuard")
  Rel(http, shared, "acquireRate, forCaller")
  Rel(http, core, "generateAi")
  Rel(http, media, "decideMediaRoute")
  Rel(core, llm, "fetch")
  Rel(core, store, "recordTelemetry")
  Rel(budget, db, "SELECT SUM estimated_cost_usd")
  Rel(store, db, "UPSERT")
  Rel(http, sentry, "captureError")
```

Sources: `api/ai-gateway-service/main.ts`, `api/ai-gateway-service/service.ts`, `api/auth.ts`, `api/workspace_auth.ts`, `api/ai_rate_limit.ts`, `api/ai_budget.ts`, `api/ai_shared_admission.ts`, `api/ai_gateway.ts`, `api/media_router.ts`, `api/ai-gateway-service/store.ts`, `api/ai-gateway-service/sentry.ts`

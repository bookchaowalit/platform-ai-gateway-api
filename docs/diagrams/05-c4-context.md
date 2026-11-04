# 05 — C4 Context

```mermaid
C4Context
  title System Context - platform-ai-gateway-api
  Person(owner, "Owner", "Sets Railway variables, uses agent sessions")
  System_Ext(apps, "Owner apps and automations", "Server-side callers with scoped tokens, e.g. sheet-summaries cron")
  System_Ext(agent, "Owner agent session", "Runs ai-gateway-mcp over stdio")
  System(gw, "Central AI Gateway", "solo-empire.ai-gateway.v1 at api.bookchaowalit.com")
  System_Ext(llm, "OpenAI-compatible provider", "AI_GATEWAY_BASE_URL, HTTPS only")
  System_Ext(sentry, "Sentry", "Errors only when SENTRY_DSN is set")
  System_Ext(uptime, "platform-uptime-worker", "Probes /healthz")
  System_Ext(data, "platform-data admissions", "Staged shared admission, off by default")
  System_Ext(idn, "platform-identity", "Issues ai-api RS256 tokens, publishes JWKS")
  Rel(apps, gw, "POST /api/ai/generate, /api/media/route", "HTTPS Bearer")
  Rel(agent, gw, "GET /api/ai/status", "HTTPS Bearer api:read")
  Rel(owner, gw, "Configures via Railway variables")
  Rel(gw, llm, "POST chat completions, stream false", "HTTPS Bearer key")
  Rel(gw, sentry, "Scrubbed error events")
  Rel(uptime, gw, "GET /healthz")
  Rel(gw, data, "POST /v1/service/admissions when shared mode is on", "HTTPS")
  Rel(gw, idn, "GET /.well-known/jwks.json when AUTH_PROFILE is identity", "HTTPS")
```

Sources: `README.md`, `PRODUCT.md`, `api/ai-gateway-service/service.ts`, `api/ai_gateway.ts`, `api/ai-gateway-service/sentry.ts`, `api/ai_shared_admission.ts`, `mcp/ai-gateway-mcp.ts`, `platform-uptime-worker/src/targets.ts` (target `ai-gateway`), ops record: sheet-summaries-cron (2026-11-03), `api/identity_auth.ts` + `docs/identity-tokens.md` (added 2026-11-04 at `efe8fa9`)

## Open questions

- provider จริงใน production คืออะไร (ops record: railway-deploy-approval-gate (2026-11-03) บอกว่าเป็น OpenAI key) และมี fallback model ตั้งไว้หรือไม่: ค่าอยู่ใน Railway variables ไม่อยู่ใน repo
- edge gateway `gateway.bookchaowalit.com` ข้าม ai-gateway (ops record: api-gateway-edge (2026-11-03)) จึงไม่วาดไว้ใน path
- identity profile (ADR-0006, 2026-11-04) เปิดใน production แล้วหรือยัง (`AI_GATEWAY_AUTH_PROFILE` อยู่ใน Railway variables)

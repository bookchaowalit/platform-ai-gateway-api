# 02 — Use cases

actors คือ auth level ที่ code รู้จักจริง: scoped token ที่มี scope `api:read` หรือ `ai:generate` (`api/auth.ts`), workspace JWT (staged, `api/workspace_auth.ts`), service JWT `quotas:service` ที่ gateway ใช้เรียก platform-data, ผู้เรียกที่ไม่ auth (`/healthz`, `/readyz`) และ operator ที่ตั้ง Railway variables

```mermaid
flowchart LR
  APP["Actor: client app with ai:generate token"]
  READER["Actor: reader with api:read token"]
  MCP["Actor: owner agent via ai-gateway-mcp"]
  WS["Actor: workspace JWT caller (staged)"]
  PROBE["Actor: unauthenticated probe (Railway healthcheck, uptime worker)"]
  OPS["Actor: operator (Railway variables)"]
  subgraph GW["platform-ai-gateway-api"]
    UC1(["Generate text with a model"])
    UC2(["Get media transcription route decision"])
    UC3(["Read status, budget and rate limit"])
    UC4(["Check liveness /healthz"])
    UC5(["Check readiness /readyz"])
    UC6(["Configure tokens, models, rate cards, budget"])
    UC7(["Fallback to second model once"])
    UC8(["Enforce budget and rate limit"])
  end
  APP --> UC1
  APP --> UC2
  APP --> UC3
  READER --> UC3
  MCP --> UC3
  WS --> UC1
  WS --> UC3
  PROBE --> UC4
  PROBE --> UC5
  OPS --> UC6
  UC1 -.->|"includes"| UC8
  UC1 -.->|"extends"| UC7
```

หมายเหตุ scope: `api:write` ครอบ `api:read` และ token ที่มี `*` ผ่านทุก scope (`scopeAllows` ใน `api/auth.ts`); `/api/media/route` ใช้ scope `ai:generate` เหมือน generate; MCP server เรียกได้แค่ `GET /api/ai/status` (สาม tool `ai_gateway.status`, `ai_gateway.budget`, `ai_gateway.rate_limit`)

Sources: `api/auth.ts`, `api/workspace_auth.ts`, `api/ai_shared_admission.ts`, `api/ai-gateway-service/service.ts`, `mcp/ai-gateway-mcp.ts`, `railway.json`, `README.md`

## Open questions

- ใครเป็น subject ของ token จริงใน `API_TOKENS_JSON` (เห็นเพียงตัวอย่าง `ev3-web` ใน `api/ai_rate_limit.ts`)

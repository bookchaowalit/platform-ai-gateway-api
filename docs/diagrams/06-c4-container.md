# 06 — C4 Container

```mermaid
C4Container
  title Containers - platform-ai-gateway-api
  System_Ext(apps, "Client apps", "Scoped bearer tokens")
  System_Ext(llm, "OpenAI-compatible provider", "HTTPS")
  System_Ext(sentry, "Sentry", "Errors")
  System_Ext(data, "platform-data", "Staged admissions")
  System_Boundary(rw, "Railway project platform-ai-gateway-api") {
    Container(svc, "ai-gateway service", "Node 22, node:http, esbuild bundle dist/server.mjs", "Routes, auth, rate limit, budget, provider calls")
    ContainerDb(db, "Telemetry store", "SQLite via node:sqlite on volume /data", "ai_run_telemetry, WAL, synchronous FULL")
  }
  System_Boundary(local, "Owner workstation") {
    Container(mcp, "ai-gateway-mcp", "Node + tsx, MCP SDK stdio", "3 read-only tools over /api/ai/status")
  }
  Rel(apps, svc, "HTTPS JSON")
  Rel(mcp, svc, "GET /api/ai/status")
  Rel(svc, db, "upsert run rows, month-to-date SUM for budget")
  Rel(svc, llm, "POST chat completions")
  Rel(svc, sentry, "captureError")
  Rel(svc, data, "reserve and settle when shared mode on")
```

Sources: `Dockerfile`, `railway.json`, `api/ai-gateway-service/main.ts`, `api/ai-gateway-service/store.ts`, `api/ai-gateway-service/package.json`, `mcp/ai-gateway-mcp.ts`, `mcp/bin.mjs`, `.mcp.json`, `README.md`

## Open questions

- commit `723d752` บอกว่ามี Neon project ชื่อ `platform-ai-gateway-api` แต่ code ไม่ได้ใช้ Postgres: Neon project นั้นยังใช้อยู่หรือควรลบ

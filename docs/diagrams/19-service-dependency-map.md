# 19 — Service dependency map

```mermaid
flowchart LR
  subgraph CALLERS["Callers"]
    SS["data-schedules/sheet-summaries cron"]
    OA["Other owner apps (unconfirmed)"]
    MCP["ai-gateway-mcp"]
    UP["platform-uptime-worker"]
  end
  GW["ai-gateway (Railway)"]
  subgraph RUNTIME["Runtime dependencies"]
    SQL[("SQLite volume /data")]
    LLM["OpenAI-compatible provider"]
    SEN["Sentry"]
  end
  subgraph STAGED["Staged, off by default"]
    PD["platform-data admissions"]
    ISS["JWT issuer public key PEM"]
  end
  subgraph BUILD["Build and CI only"]
    NPM["npm: @sentry/node 11.4.0, jose, esbuild 0.28.1, MCP SDK, zod, tsx, typescript"]
    CIW["platform-ci-workflows @87dc5e1"]
    PBC["platform-backend-core @d00e011, platform-data @2441e9e (shared-runtime.yml)"]
  end
  SS -->|"route sheet-summaries, profile fast"| GW
  OA --> GW
  MCP --> GW
  UP -->|"/healthz"| GW
  GW -->|"hard"| SQL
  GW -->|"hard for generate"| LLM
  GW -->|"soft"| SEN
  GW -.-> PD
  GW -.-> ISS
  NPM --> GW
  CIW --> GW
  PBC --> GW
```

ความรุนแรง: SQLite ใช้ไม่ได้ → `/healthz` 503 และ budget unavailable; provider ล่ม → 502/504 (fallback ถ้าตั้ง); Sentry ล่มไม่กระทบ request; ops record: railway-deploy-approval-gate (2026-11-03): OpenAI key ถูก revoke 2026-10-26 16:11 → 10-27 12:00 UTC ทุก call ตอบ 502 `provider_auth`

Sources: `api/ai-gateway-service/service.ts`, `store.ts`, `sentry.ts`, `api/ai_gateway.ts`, `api/ai_shared_admission.ts`, `api/workspace_auth.ts`, `package.json`, `api/ai-gateway-service/package.json`, `.github/workflows/*.yml`, `mcp/ai-gateway-mcp.ts`, `platform-uptime-worker/src/targets.ts`, ops record: sheet-summaries-cron (2026-11-03), ops record: railway-deploy-approval-gate (2026-11-03)

## Open questions

- รายชื่อ caller ทั้งหมดใน production (ต้องดู subject ใน `API_TOKENS_JSON` หรือ telemetry `metadata_json.subject`)

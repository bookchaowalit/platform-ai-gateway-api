# 21 — Incident response

ไม่มี runbook ใน repo นี้; `README.md` ชี้ไป solo-empire `operations/runbooks/AI-API-GATEWAY-RUNBOOK.md` (ไม่ได้อ่านใน pack นี้) flow ด้านล่างประกอบจาก channel ที่มีจริง

```mermaid
flowchart TD
  A1["Uptime worker: /healthz fails twice"] --> TG["Telegram alert book_noti_bot"]
  A2["Sentry error event: 5xx, budget guard, unhandled"] --> SE["Sentry issue"]
  A3["Caller sees 502 provider_* or 429 budget"] --> CL["Caller logs / owner notices"]
  TG --> T["Triage: Railway logs ai_gateway.run, GET /api/ai/status"]
  SE --> T
  CL --> T
  T --> Q{"Cause"}
  Q -->|"provider key or provider outage"| F1["Rotate Railway variable, redeploy"]
  Q -->|"budget exhausted"| F2["Owner raises budget variable or waits for new month"]
  Q -->|"bad deploy"| F3["Redeploy earlier Railway deployment"]
  Q -->|"code bug"| F4["Fix PR -> CI -> Wait for CI deploy"]
  F1 --> V["curl -fsS https://api.bookchaowalit.com/healthz"]
  F2 --> V
  F3 --> V
  F4 --> V
  V --> PM["Postmortem: not defined in repo; ops records are the current log"]
```

ตัวอย่างจริง: ops record: railway-deploy-approval-gate (2026-11-03) — OpenAI key revoked 2026-10-26 16:11 → 10-27 12:00 UTC, ทุก call 502 `provider_auth` (~19 h 49 m); ops record: sheet-summaries-cron (2026-11-03) — deploys skipped ขณะ security CI แดง แก้ด้วย PR #7

Sources: `README.md` (Runbook, Deploy), `AGENTS.md`, `api/ai-gateway-service/service.ts`, `api/ai-gateway-service/sentry.ts`, `platform-uptime-worker/README.md`, ops record: railway-deploy-approval-gate (2026-11-03), ops record: sheet-summaries-cron (2026-11-03)

## Open questions

- Sentry alert rule ของ project นี้ส่งไปที่ไหน
- เนื้อหา `AI-API-GATEWAY-RUNBOOK.md` ใน solo-empire ยังตรงกับ CD ปัจจุบันหรือไม่
- ไม่มี postmortem template/ที่เก็บ

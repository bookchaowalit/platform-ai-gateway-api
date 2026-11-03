# 01 — Business process (As-Is / To-Be)

repo นี้คือ **Central AI Gateway** ที่ deploy จริง (`solo-empire.ai-gateway.v1`, `https://api.bookchaowalit.com`): Node service ตัวเดียวที่รับ model call จาก app/automation ของ owner ผ่าน scoped bearer token, บังคับ privacy class, rate limit และ monthly budget แล้วส่งต่อไปยัง OpenAI-compatible provider และบันทึก telemetry ที่ไม่มี prompt/output ลง SQLite บน Railway volume

## As-Is (จาก code วันนี้, `origin/main` `b8141c9`)

```mermaid
flowchart TD
  A["Client app / automation holds scoped token"] --> B["POST /api/ai/generate"]
  B --> C{"Bearer token hash in API_TOKENS_JSON and scope ai:generate?"}
  C -->|"no"| X1["401 / 403"]
  C -->|"yes"| D["Read JSON body max 1 MiB"]
  D --> E{"Per-subject rate and concurrency OK?"}
  E -->|"no"| X2["429 Retry-After"]
  E -->|"yes"| F{"Monthly budget configured and has headroom?"}
  F -->|"unconfigured"| X3["503 budget_not_configured"]
  F -->|"no headroom"| X4["429 monthly_budget_exceeded"]
  F -->|"yes"| G{"privacy_class public or internal?"}
  G -->|"private or restricted"| X5["403 privacy_class_denied"]
  G -->|"yes"| H["Add Thai-first system policy, call primary model"]
  H --> I{"Retryable failure and fallback model set?"}
  I -->|"yes"| J["Record primary attempt row, reserve again, call fallback once"]
  I -->|"no"| K["Build bounded response"]
  J --> K
  K --> L[("ai_run_telemetry row: tokens, cost, latency, no text")]
  K --> M["200 JSON with usage"]
```

กระบวนการรอง: `POST /api/media/route` เลือก STT provider และ summary profile จาก `platform/media-transcription-routing.json` จาก metadata อย่างเดียว (ไม่ถอดเสียงเอง) และ `GET /api/ai/status` ให้สถานะ config/budget/rate limit ซึ่ง MCP server `ai-gateway-mcp` อ่านแบบ read-only

ลูกค้าที่ยืนยันได้จาก ops record: cron `sheet-summaries` เรียก route `sheet-summaries` profile `fast` และ gateway มี cap $5/เดือน (`LLM_LAB_MONTHLY_BUDGET_USD`) ที่ทุก client ใช้ร่วมกัน (ops record: sheet-summaries-cron (2026-11-03))

Sources: `api/ai-gateway-service/service.ts`, `api/ai_gateway.ts`, `api/auth.ts`, `api/ai_rate_limit.ts`, `api/ai_budget.ts`, `api/media_router.ts`, `api/ai-gateway-service/store.ts`, `README.md`, `PRODUCT.md`

## To-Be (จาก repo docs เท่านั้น)

`docs/shared-admission.md` บรรยายโหมด staged ที่ merge แล้วแต่ **ยังไม่เปิดใน production** (`AI_GATEWAY_AUTH_PROFILE=workspace-jwt` + `AI_GATEWAY_ADMISSION_MODE=shared`): caller ใช้ workspace JWT (RS256, audience `platform-api`) และทั้ง rate และ USD budget ถูก reserve/settle ที่ platform-data ก่อนทุก provider attempt เพื่อรองรับหลาย replica

```mermaid
flowchart TD
  A["Caller with workspace JWT"] --> B["Gateway verifies RS256, iss, aud platform-api, ws, scope"]
  B --> C["Reserve request quota at platform-data, settle to 1"]
  C --> D["Local per-replica limiter and SQLite hard ceiling"]
  D --> E["Reserve workspace and platform USD micro-units"]
  E --> F["Provider attempt"]
  F --> G["Settle actual cost; unknown cost stays reserved"]
```

Sources: `docs/shared-admission.md`, `api/workspace_auth.ts`, `api/ai_shared_admission.ts`

## Open questions

- Release preflight 5 ขั้นใน `docs/shared-admission.md` ยังไม่ทำใน production: จะเปิด shared mode เมื่อไรและใครอนุมัติ
- ops record: book-platforms-status (2026-11-03) บันทึกว่า owner ยังต้องตัดสิน: ย้าย gateway เป็น service `ai` (audience `ai-api` ผ่าน JWKS), always-on vs serverless+Neon, เลิก static token และ cutover; repo นี้ไม่มี spec ของ To-Be นั้น
- client ใดถือ token อยู่บ้างวันนี้ (`PRODUCT.md` ระบุ `[ต้องยืนยัน]`)

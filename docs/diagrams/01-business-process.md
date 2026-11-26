# 01 — Business process (As-Is / To-Be)

repo นี้คือ **Central AI Gateway** ที่ deploy จริง (`solo-empire.ai-gateway.v1`, `https://api.bookchaowalit.com`): Node service ตัวเดียวที่รับ model call จาก app/automation ของ owner, บังคับ auth, privacy class, rate limit และ monthly budget ต่อ subject แล้วส่งต่อไปยัง OpenAI-compatible provider และบันทึก telemetry ที่ไม่มี prompt/output ลง SQLite บน Railway volume ตั้งแต่ SPEC-003 P1a มีงานสร้างภาพผ่าน media worker (Cloudflare) ด้วย แต่ปิดไว้จนกว่าจะตั้ง `AI_GATEWAY_MEDIA_ENABLED`

Last reviewed: 2026-11-26 · commit `ca86f75`

## As-Is (จากโค้ดวันนี้)

```mermaid
flowchart TD
  A["Client app / bot / automation"] --> B["POST /api/ai/generate"]
  B --> C{"Auth profile: scoped static token, workspace JWT or identity JWT, scope ai:generate?"}
  C -->|"no"| X1["401 / 403"]
  C -->|"yes"| R0["Read JSON body, size cap"]
  R0 -->|"too large or invalid"| X0["413 / 400"]
  R0 -->|"ok"| D{"Local per-subject rate and concurrency OK?"}
  D -->|"no"| X2["429 Retry-After"]
  D -->|"yes"| SQ{"Staged shared mode on? Then shared request quota at platform-data"}
  SQ -->|"quota exhausted"| X2b["429 shared quota"]
  SQ -->|"platform-data unavailable"| X2c["503 admission unavailable"]
  SQ -->|"off, or reserved"| B0{"Global budget configured?"}
  B0 -->|"no"| X8["503 budget_not_configured"]
  B0 -->|"yes"| F{"privacy_class"}
  F -->|"public / internal, or private with scoped static token + subject route in AI_GATEWAY_PRIVATE_ROUTES_JSON + provider attestation"| G["Pick model and price: scoped static token whose subject and profile match AI_GATEWAY_SUBJECT_MODELS_JSON, else profile default model at the shared default rate card (JWT callers always default)"]
  F -->|"restricted, or private without all three"| X4["403 privacy_class_denied"]
  G --> E{"Reserve cost for that model in the global budget, and the subject budget where one is set"}
  E -->|"no headroom"| X3["429 budget"]
  E -->|"reserved"| H["Call provider: text, tools, image input, json_schema output"]
  H --> I{"Retryable failure, fallback set, not a subject model, and private allowed on fallback?"}
  I -->|"yes"| J["Record primary attempt row; local reservation released, shared one settled as unknown (stays held); reserve again at fallback price"]
  J -->|"no headroom"| X5["Primary error returned"]
  J -->|"reserved"| J2["Call fallback once"]
  I -->|"no, success"| K["Bounded response"]
  I -->|"no, failure"| XE["Provider error recorded in telemetry, bounded detail returned (e.g. 429 provider_rate_limited, 504)"]
  J2 -->|"success"| K
  J2 -->|"failure"| XE
  K --> L[("ai_run_telemetry: tokens, cost at per-model price, latency, no text")]
  K --> M["200 JSON with usage"]

  A2["Client with media scope"] --> N["POST /api/ai/media/requests"]
  N --> O{"Media enabled and configured?"}
  O -->|"no"| X6["503 media_disabled"]
  O -->|"yes"| PV{"privacy_class public / internal?"}
  PV -->|"private or restricted"| X9["403 privacy_class_refused"]
  PV -->|"yes"| RT{"A model in the registry allowed for this subject?"}
  RT -->|"no"| X10["422 no_route"]
  RT -->|"yes, dry_run"| DR["200 with estimated reservation and routing, no job"]
  RT -->|"yes"| O2{"Headroom in media, global and subject budgets?"}
  O2 -->|"no"| X7["429 budget_exceeded"]
  O2 -->|"yes"| P["Commit reservation and job in SQLite"]
  P --> P2["Try first enqueue to media worker; housekeeping retries if the queue is down"]
  P2 --> P3["202 queued with request id"]
  P2 --> Q["Worker calls openai-image gpt-image-1.5, writes R2, reports back; gateway settles"]
  P3 --> R["Caller polls GET /api/ai/media/requests/:id for status and signed URL"]
```

กระบวนการรอง: `POST /api/media/route` เลือก STT provider และ summary profile จาก `platform/media-transcription-routing.json` (metadata อย่างเดียว) และ `GET /api/ai/status` ให้สถานะ config, budget, rate limit และ media ซึ่ง MCP `ai-gateway-mcp` อ่านแบบ read-only

Sources: `api/ai-gateway-service/service.ts` (routes `/healthz`, `/readyz`, `/api/ai/status`, `/api/ai/generate`, `/api/media/route`), `api/media/http.ts` (`/api/ai/media/requests`, `/api/ai/media/models`), `api/ai_gateway.ts` (subject models, private routes), `api/ai_tools.ts`, `api/workspace_auth.ts`, `api/identity_auth.ts`, `api/ai_budget.ts`, `api/ai_rate_limit.ts`, `api/media/jobs.ts`, commits `cf01ce4` (SPEC-004), `3a09c24` (openai-image)

> ไดอะแกรมนี้เป็นภาพสรุปของกระบวนการ ไม่ได้ครอบทุก error code; โค้ดและเทสใน `api/` คือแหล่งจริง

## To-Be (จาก docs/shared-admission.md, specs/003-media-generation และ ops record)

```mermaid
flowchart TD
  A["Client app / bot / automation"] --> B{"Auth"}
  B -->|"workspace JWT: staged shared mode works today"| L0["Local per-replica rate and concurrency limiter"]
  B -->|"identity JWT: shared mode not supported yet, needs a spec"| Z["Target: identity callers on shared admission"]
  L0 --> C["Reserve request quota at platform-data, shared across replicas"]
  C --> G["Pick model and price for the attempt"]
  G --> D["Reserve local and shared workspace and platform USD for that attempt"]
  D --> H["Provider call; fallback reserves again at its own price"]
  H --> K{"Actual cost known?"}
  K -->|"yes"| S["Settle actual cost"]
  K -->|"no usage or unclear outcome"| U["Reservation stays held, no refund"]
  S --> RPT["Per-subject usage report"]
  A2["Client with media scope"] --> N["Media request"]
  N --> R["Rank image and video models from registry, compare several providers"]
  R --> Q["Worker runs chosen provider, R2, caller polls for signed URL"]
```

Sources: `docs/shared-admission.md` (staged shared mode, merged, not on in production; `service.ts` refuses shared mode unless `AI_GATEWAY_AUTH_PROFILE=workspace-jwt`), `api/ai_shared_admission.ts`, `specs/003-media-generation/spec.md` (multi-provider pipeline, Q1–Q4 open), ops record: book-platforms-status (2026-11-03, move to service `ai`), ops record: openai-single-key (2026-11-09, no per-subject report yet)

## Gap

| ID | As-Is → To-Be | Status | Owner | Evidence |
|---|---|---|---|---|
| G1 | plain text only → tools, image input, json_schema, private routes for client bots | done | claude | `specs/002-tools-vision/spec.md`, `api/ai_tools.ts` |
| G2 | one model per profile → model and price per subject | done | claude | `specs/004-subject-models/spec.md`, commit `cf01ce4` |
| G3 | no media generation → image generation through media worker (P1a) | blocked | owner | `specs/003-media-generation/spec.md` P1a merged; media off until owner answers Q1/Q2 and sets the R2 token |
| G4 | one image provider → ranked multi-provider image and video pipeline (P1b+) | todo | claude | `specs/003-media-generation/spec.md` phases after P1a |
| G5 | local per-replica limits, legacy admission → shared admission at platform-data | decide | owner | `docs/shared-admission.md` release preflight not run in production |
| G6 | static scoped tokens → JWT only, move to service `ai` (audience `ai-api`) | decide | owner | ops record: book-platforms-status (2026-11-03); no spec yet |
| G7 | telemetry per call → per-subject usage report | todo | claude | ops record: openai-single-key (2026-11-09) |
| G8 | shared admission only with workspace JWT → identity JWT callers on shared admission | todo | claude | `api/ai-gateway-service/service.ts` refuses shared mode with `AI_GATEWAY_AUTH_PROFILE=identity`; needs a spec |

## Open questions

- จะเปิด shared admission เมื่อไรและใครอนุมัติ release preflight 5 ขั้น (`docs/shared-admission.md`)
- ย้าย gateway เป็น service `ai` และเลิก static token หรือไม่ (G6) ต้องมี spec ก่อน
- client ใดถือ token อยู่บ้างวันนี้ (`PRODUCT.md` ระบุ `[ต้องยืนยัน]`)

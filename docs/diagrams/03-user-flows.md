# 03 — User flows (per role)

ไม่มี UI: "user" คือ caller ฝั่ง server ทุก flow มาจาก route ใน `api/ai-gateway-service/service.ts` (CORS ไม่เปิดโดยตั้งใจ)

## Client app: generate

```mermaid
flowchart TD
  S["Start"] --> A["POST /api/ai/generate with Bearer token"]
  A --> B{"Content-Type application/json and body under limit?"}
  B -->|"no"| E1["415 or 413, connection closed"]
  B -->|"yes"| C{"JSON valid, route, prompt_version, 1 to 40 messages?"}
  C -->|"no"| E2["400 invalid_request"]
  C -->|"yes"| D["Gateway applies limits, budget, provider call"]
  D --> R1["200: content + usage + X-RateLimit headers"]
  D --> R2["429 rate_limited / concurrency_limited / monthly_budget_exceeded"]
  D --> R3["502 / 504 provider_* error class, no provider body"]
  D --> R4["503 budget_not_configured / budget_unavailable / not_configured"]
```

## Client app: media route

```mermaid
flowchart TD
  A["POST /api/media/route with ai:generate token"] --> B["Metadata only: file_name, folder_path, mime_type, duration_seconds, privacy_class, hints"]
  B --> C{"Content kind and language resolved?"}
  C -->|"routed"| D["stt provider + summary_profile -> gateway_route, prompt_version, profile"]
  C -->|"blocked"| E["status blocked, blocked_reason, needs_review"]
  D --> F["Caller transcribes elsewhere, then calls /api/ai/generate with the given route"]
```

## Owner agent: status via MCP

```mermaid
flowchart LR
  A["Agent calls ai_gateway.budget"] --> B["MCP validates: no arguments allowed"]
  B --> C["Token from EMPIRE_TOKEN, EMPIRE_TOKEN_FILE, or owner token file mode 600"]
  C --> D["GET /api/ai/status with caller bearer"]
  D --> E["Return only the budget block, or fixed error text like 403: forbidden"]
```

## Probe: health

```mermaid
flowchart LR
  A["GET or HEAD /healthz"] --> B{"SQLite SELECT 1 ok?"}
  B -->|"yes"| C["200 status ok"]
  B -->|"no"| D["503 status unavailable"]
```

Sources: `api/ai-gateway-service/service.ts`, `api/ai_gateway.ts` (`validateRequest`), `api/media_router.ts`, `platform/media-transcription-routing.json`, `mcp/ai-gateway-mcp.ts`, `README.md`

## Open questions

- caller ใดใช้ `/api/media/route` ใน production (ops record: meeting-minutes-service ไม่ได้ระบุว่าเรียก gateway)

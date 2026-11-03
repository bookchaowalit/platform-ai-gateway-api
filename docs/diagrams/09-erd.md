# 09 — ERD

ข้อมูลที่ persist มีตารางเดียว `ai_run_telemetry` (SQLite, `database/migrations/025_ai_run_telemetry.sql`) เก็บ scalar metadata ของแต่ละ run ไม่มี prompt/output; `metadata_json` เก็บ key เช่น `subject`, `workspace_id` (staged), `service`, `profile`, `privacy_class`, `fallback_used`, `primary_model`, `primary_error_class`, `error_class`, `error_cost_policy`, `attempt`, `parent_run_id`

```mermaid
erDiagram
  ai_run_telemetry {
    INTEGER id PK "autoincrement"
    TEXT run_id UK "randomUUID per run or attempt"
    TEXT route "NOT NULL, indexed"
    TEXT prompt_version
    TEXT provider "indexed with model"
    TEXT model
    INTEGER input_tokens ">= 0"
    INTEGER output_tokens ">= 0"
    INTEGER total_tokens ">= 0"
    INTEGER token_budget ">= 0"
    REAL latency_ms ">= 0"
    REAL estimated_cost_usd ">= 0, summed for budget"
    BOOLEAN cache_hit "0 or 1"
    TEXT status "success, error, budget_exceeded"
    TEXT metadata_json "content-free JSON"
    TEXT created_at "datetime now, indexed"
  }
  ai_run_telemetry ||--o{ ai_run_telemetry : "parent_run_id in metadata_json (failed primary attempt row)"
```

ข้อมูลอื่นที่ไม่ใช่ตาราง: registry แบบ read-only `platform/media-transcription-routing.json` (bundle เข้า image) และ admission state ของ shared mode อยู่ที่ platform-data (ไม่ใช่ของ repo นี้)

Sources: `database/migrations/025_ai_run_telemetry.sql`, `api/ai-gateway-service/store.ts` (`REQUIRED_COLUMNS`, `UPSERT_SQL`), `api/ai_gateway.ts` (`AiTelemetryEvent`, `failureTelemetry`), `api/ai-gateway-service/service.ts` (`withSubject`), `api/ai_budget.ts` (`querySpend`)

## Open questions

- ไม่มี retention/pruning ของ `ai_run_telemetry` ใน code: ตารางโตไม่จำกัด

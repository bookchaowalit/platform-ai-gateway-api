# ADR-0002 — Railway always-on service with SQLite telemetry on a volume

- Status: accepted (retro-documented)

## Context

budget guard ต้องรู้ spend เดือนนี้ข้าม restart/redeploy และ telemetry ต้องไม่เก็บ prompt/output

## Decision

รันบน Railway (Dockerfile builder, healthcheck `/healthz`, restart ON_FAILURE สูงสุด 10) แบบ always-on และเก็บ `ai_run_telemetry` ใน SQLite ผ่าน `node:sqlite` ที่ `/data/ai-gateway.sqlite` (Railway volume) ด้วย WAL + `synchronous = FULL`; entrypoint ใช้ root แค่ chown volume แล้ว drop เป็น user `node` ด้วย `setpriv`

## Evidence

- `.railway/railway.ts`, `Dockerfile`, `api/ai-gateway-service/entrypoint.sh`
- `api/ai-gateway-service/store.ts` (comment "keeping the file on a persistent volume keeps the cap effective")
- `tests/ai_gateway_service.test.ts` ("monthly budget spend persists across a service restart on the same volume")
- `README.md` (Host, Data)

## Consequences

- single replica: rate limiter อยู่ใน process (`api/ai_rate_limit.ts` เตือนว่า multi-replica ต้องใช้ shared limiter) → ADR-0004
- volume ไม่อยู่ใน platform-db-backup (รองรับเฉพาะ postgres/mysql) ดู 14-backup-dr

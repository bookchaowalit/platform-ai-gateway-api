# ADR-0004 — Staged workspace JWT and durable shared admission (off by default)

- Status: accepted (retro-documented); production activation not done

## Context

หลาย replica จะทำให้ rate limit ใน process และ SQLite budget ต่อ replica ไม่พอ

## Decision

เพิ่ม profile `workspace-jwt` (RS256, exact issuer, audience `platform-api`, lifetime ≤ 3600 s) และ `AI_GATEWAY_ADMISSION_MODE=shared` ที่ reserve/settle rate และ USD micro-units ที่ platform-data `POST /v1/service/admissions` ก่อนทุก provider attempt โดยไม่ release เมื่อผลไม่ชัด; default ยังเป็น `scoped` + `legacy`; shared ต้องคู่กับ workspace-jwt ไม่มี fallback

## Evidence

- `api/workspace_auth.ts`, `api/ai_shared_admission.ts`, `service.ts` (`serviceConfigurationProblems`)
- `docs/shared-admission.md` ("no production cutover")
- `tests/ai_shared_admission_test.ts`, `tests/ai_shared_data_integration_test.ts`, `.github/workflows/shared-runtime.yml`
- merge `b8141c9` (PR #1, merged locally 2026-10-29)

## Consequences

- ต้องทำ release preflight 5 ขั้นก่อนเปิด; SQLite hard ceiling ยังเป็น deny gate ชั้นสอง

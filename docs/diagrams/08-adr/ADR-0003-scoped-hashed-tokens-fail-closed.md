# ADR-0003 — Scoped SHA-256 token hashes, fail closed

- Status: accepted (retro-documented)

## Context

หลาย client ต้องมีสิทธิ์ต่างกัน และ config ไม่ควรเก็บ token ดิบ

## Decision

hosted service รับเฉพาะ scoped token ที่อยู่ใน `API_TOKENS_JSON` เป็น `token_hash` (SHA-256 hex) พร้อม `subject`, `scopes`, `expires_at`; เทียบด้วย `timingSafeEqual`; ปฏิเสธการ start ถ้ามี `API_TOKEN` (legacy full-access) หรือ `ALLOW_UNAUTH_DEV` หรือไม่มี token hash เลย; config ผิดรูป (มี raw `token`/`secret`, hash/subject/scope/expiry ผิด) ทำให้ทุก request 401

## Evidence

- `api/auth.ts` (`parseScopedTokenConfig`, `createScopedTokenAuthenticator`)
- `api/ai-gateway-service/service.ts` (`serviceConfigurationProblems`)
- `tests/auth.test.ts` (SPEC-001 AC-01..AC-06), `tests/ai_gateway_service.test.ts` ("refuses legacy full-access…")

## Consequences

- หมุน token = แก้ Railway variable และ redeploy; token ไม่มี revocation list นอกจากลบ entry/ใช้ `expires_at`

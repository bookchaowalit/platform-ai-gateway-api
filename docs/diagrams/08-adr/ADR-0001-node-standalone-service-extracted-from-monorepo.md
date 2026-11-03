# ADR-0001 — Standalone Node service extracted from the monorepo

- Status: accepted (retro-documented)
- Date of decision: 2026-10-10 (commit `2752b91`)

## Context

gateway เคยอยู่ใน solo-empire monorepo (`infra/api/ai-gateway-service`) และต้องการเป็น boundary เดียวที่ app เรียกโดยไม่ถือ provider key

## Decision

แยกเป็น repo นี้เป็น source of truth ของ hosted service: TypeScript บน Node 22 (`node:http` ไม่มี framework), bundle ด้วย esbuild เป็น `dist/server.mjs`, เปิดเพียง 5 path (`/healthz`, `/readyz`, `/api/ai/status`, `/api/ai/generate`, `/api/media/route`) ไม่เปิด CORS เพราะ caller อยู่ฝั่ง server, upstream เป็น OpenAI-compatible HTTP adapter (`stream: false`)

## Evidence

- `README.md` ("Extracted from the solo-empire monorepo … on 2026-10-10")
- `api/ai-gateway-service/service.ts` (header comment, route table)
- `api/ai-gateway-service/package.json` (esbuild build), `Dockerfile` (`node:22-slim`)
- `api/ai_gateway.ts` (`providerName` default `openai-compatible`)

## Consequences

- dependency น้อย (runtime: `@sentry/node`, `jose`) แต่ต้องดูแล HTTP parsing เอง (body limit, timeouts ใน `service.ts`)
- `store.ts` ยังมี comment ชี้ layout เก่า `infra/...` (หนี้เอกสารเล็กน้อย)

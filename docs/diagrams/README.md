# Core 22 SDLC diagram pack — platform-ai-gateway-api

ชุด diagram 22 รายการตาม SDLC Diagram Catalog v2 (knowledge-base `knowledge/tech/core-cs/sdlc-diagram-catalog.md`) วาดจาก code / config ของ repo นี้ที่ `origin/main` `b8141c9` (อ่านเมื่อ 2026-11-03)

repo นี้คือ **Central AI Gateway ที่ให้บริการจริง** (`solo-empire.ai-gateway.v1`, `https://api.bookchaowalit.com`): Node 22 service ตัวเดียวบน Railway (always-on) กับ SQLite telemetry บน volume `/data`, scoped hashed tokens, per-subject rate limit, monthly budget และ OpenAI-compatible provider พร้อม fallback หนึ่งครั้ง ส่วน workspace JWT + shared admission ผ่าน platform-data ถูก merge แล้วแต่ปิดโดย default ทุกไฟล์มี `Sources:` และ "Open questions"; ข้อมูล hosting ที่ไม่อยู่ใน repo อ้าง `ops record: <stem> (2026-11-03)` หรือ GitHub API (`gh`)

| # | Item | Status | File | Sources read |
|---|---|---|---|---|
| 01 | Business process (As-Is / To-Be) | done | [01-business-process.md](01-business-process.md) | service.ts, ai_gateway.ts, auth.ts, ai_budget.ts, ai_rate_limit.ts, media_router.ts, docs/shared-admission.md, PRODUCT.md |
| 02 | Use cases | done | [02-use-cases.md](02-use-cases.md) | auth.ts, workspace_auth.ts, service.ts, mcp/ai-gateway-mcp.ts, .railway/railway.ts |
| 03 | User flows (server callers; no UI) | done | [03-user-flows.md](03-user-flows.md) | service.ts, ai_gateway.ts, media_router.ts, routing JSON, mcp |
| 04 | Traceability (RTM) | done | [04-traceability.md](04-traceability.md) | PRODUCT.md, SPEC-001, shared-admission.md, api/, tests/, workflows |
| 05 | C4 Context | done | [05-c4-context.md](05-c4-context.md) | README.md, service.ts, sentry.ts, uptime targets.ts, ops record |
| 06 | C4 Container | done | [06-c4-container.md](06-c4-container.md) | Dockerfile, .railway/railway.ts, main.ts, store.ts, mcp |
| 07 | C4 Component | done | [07-c4-component.md](07-c4-component.md) | all `api/` modules |
| 08 | ADRs (6; ADR-0006 added 2026-11-04 at `efe8fa9`) | done | [08-adr/](08-adr/) | README.md, service.ts, auth.ts, store.ts, entrypoint.sh, ci.yml, shared-admission.md, gh deployments |
| 09 | ERD | done | [09-erd.md](09-erd.md) | 025_ai_run_telemetry.sql, store.ts, ai_gateway.ts |
| 10 | Sequences (4) | done | [10-sequences.md](10-sequences.md) | service.ts, ai_gateway.ts, ai_budget.ts, ai_shared_admission.ts, main.ts, entrypoint.sh |
| 11 | State machines | done | [11-state-machines.md](11-state-machines.md) | ai_gateway.ts, ai_budget.ts, ai_shared_admission.ts, media_router.ts |
| 12 | API and integrations | done (+ link to central doc) | [12-api-integration.md](12-api-integration.md) | service.ts, ai_gateway.ts, ai_rate_limit.ts, routing JSON, central-ai-gateway.md |
| 13 | Threat model (DFD + STRIDE) | done | [13-threat-model.md](13-threat-model.md) | auth/workspace_auth, service.ts, sentry.ts, entrypoint.sh, workflows, gh branch protection |
| 14 | Backup / DR | done (gap: no backup found) | [14-backup-dr.md](14-backup-dr.md) | store.ts, ai_budget.ts, product card, platform-db-backup README, ops record |
| 15 | CI/CD pipeline | done | [15-cicd-pipeline.md](15-cicd-pipeline.md) | ci.yml, shared-runtime.yml, .railway/railway.ts, gh run list/view, gh deployments |
| 16 | Deployment | done | [16-deployment.md](16-deployment.md) | README.md, Dockerfile, .railway/railway.ts, sentry.ts, gh deployments |
| 17 | Test coverage matrix | done | [17-test-coverage-matrix.md](17-test-coverage-matrix.md) | tests/*.ts, fixture, package.json, workflows |
| 18 | Git / release workflow | done | [18-git-release-workflow.md](18-git-release-workflow.md) | git log, gh pr list, gh deployments |
| 19 | Service dependency map | done | [19-service-dependency-map.md](19-service-dependency-map.md) | api/, package.json files, workflows, ops records |
| 20 | Observability | done | [20-observability.md](20-observability.md) | main.ts, service.ts, sentry.ts, PRODUCT.md, uptime targets.ts/README |
| 21 | Incident response | done (runbook lives in solo-empire) | [21-incident-response.md](21-incident-response.md) | README.md, AGENTS.md, uptime README, ops records |
| 22 | DORA | done (deploy data since CD 2026-10-18) | [22-dora.md](22-dora.md) | gh deployments + statuses, gh run list, gh pr list, git log |

## ADRs

- [ADR-0001](08-adr/ADR-0001-node-standalone-service-extracted-from-monorepo.md) Standalone Node service แยกจาก monorepo
- [ADR-0002](08-adr/ADR-0002-railway-always-on-with-sqlite-volume.md) Railway always-on + SQLite telemetry บน volume
- [ADR-0003](08-adr/ADR-0003-scoped-hashed-tokens-fail-closed.md) Scoped SHA-256 token hashes, fail closed
- [ADR-0004](08-adr/ADR-0004-staged-workspace-jwt-and-shared-admission.md) Staged workspace JWT + shared admission (ปิดโดย default)
- [ADR-0005](08-adr/ADR-0005-shared-ci-and-railway-wait-for-ci.md) Shared CI v1.1.1 + Railway Wait for CI
- [ADR-0006](08-adr/ADR-0006-identity-profile-platform-identity-jwks.md) Identity profile: platform-identity tokens (aud `ai-api`, JWKS) คู่กับ static tokens

Architecture summary: [`DOCPACK/02-architecture.md`](../../DOCPACK/02-architecture.md); 05 และ 06 อัปเดต 2026-11-04 ให้มี platform-identity

## Related docs (reused, not copied)

- [`PRODUCT.md`](../../PRODUCT.md), [`README.md`](../../README.md), [`docs/shared-admission.md`](../shared-admission.md), [`specs/001-l2-baseline/spec.md`](../../specs/001-l2-baseline/spec.md), [`DOCPACK/00-product-card.md`](../../DOCPACK/00-product-card.md)
- Central: [Central AI Gateway](https://github.com/bookchaowalit/architecture-docs/blob/main/systems/ai-data/central-ai-gateway.md)

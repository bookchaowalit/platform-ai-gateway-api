# ADR-0005 — Shared CI v1.1.1 and Railway Wait for CI as the deploy gate

- Status: accepted (retro-documented)
- Date: CI 2026-10-17 (PR #2), CD 2026-10-18 (PR #6)

## Decision

`ci.yml` เรียก reusable `ci-node.yml` และ `security.yml` จาก `bookchaowalit/platform-ci-workflows` pin SHA `87dc5e1` (v1.1.1) บน GitHub-hosted runners (repo public); Railway service เชื่อม `main` และรอ check suites ก่อน deploy; ไม่ใช้ `railway up` จาก working tree อีก

## Evidence

- `.github/workflows/ci.yml`, `README.md` (Deploy), `AGENTS.md`
- GitHub deployments: `77e8d12` (security CI failed) in_progress → inactive ไม่ success; `a9843e8` success 2026-10-26 (`gh api repos/bookchaowalit/platform-ai-gateway-api/deployments`)
- ops record: sheet-summaries-cron (2026-11-03): "Gateway main deploys were SKIPPED while its security CI failed. Fixed by platform-ai-gateway-api#7"

## Consequences

- ไม่มี branch protection บน `main` (API ตอบ "Branch not protected"); gate จริงคือ Wait for CI
- ไม่มี coverage gate และ lint (comment ใน `ci.yml`)

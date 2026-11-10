# 15 — CI/CD pipeline

สอง workflow; CD ไม่ได้อยู่ใน GitHub Actions แต่เป็น Railway GitHub source + Wait for CI (`README.md` Deploy)

```mermaid
flowchart TD
  T1["push main, pull_request, workflow_dispatch"] --> CI["CI (ci.yml), concurrency ci-ref, cancel in progress"]
  T2["push any branch, pull_request, workflow_dispatch"] --> SR["Shared admission (shared-runtime.yml)"]
  subgraph CI_J["ci.yml jobs (no needs, run in parallel)"]
    GJ["gateway: ci-node.yml @87dc5e1 v1.1.1 -> job node: npm ci, typecheck, npm test require-tests, npm run build"]
    SJ["security: security.yml @87dc5e1 -> gitleaks, semgrep, osv-scanner, trivy-fs HIGH CRITICAL"]
  end
  CI --> GJ
  CI --> SJ
  subgraph SR_J["shared-runtime.yml job gateway, ubuntu-24.04, 15 min"]
    PG["service postgres:16"]
    PY["pip install platform-backend-core @d00e011, platform-data @2441e9e"]
    NT["npm ci, npm test incl. real platform-data integration, npm run build"]
  end
  SR --> PG --> PY --> NT
  GJ --> CHK{"Check suites on main green?"}
  SJ --> CHK
  CHK -->|"yes"| DEP["Railway builds Dockerfile and deploys service ai-gateway"]
  CHK -->|"no"| SKIP["Deployment stays inactive, production keeps previous"]
  DEP --> HC["Railway healthcheck /healthz, timeout 60 s"]
```

หลักฐาน gate: deployment `77e8d12` (CI failure: osv-scanner 1 High, trivy-fs) เป็น `in_progress → inactive` ไม่เคย success; PR #7 (`a9843e8`) แก้แล้ว deploy success 2026-10-26 12:05:57Z

Sources: `.github/workflows/ci.yml`, `.github/workflows/shared-runtime.yml`, `.railway/railway.ts`, `Dockerfile`, `README.md`, `gh run list -R bookchaowalit/platform-ai-gateway-api --branch main`, `gh run view` (failed run of `77e8d12`: jobs `security / osv-scanner` and `security / trivy-fs` failure), `gh api repos/bookchaowalit/platform-ai-gateway-api/deployments` + statuses

## Open questions

- Railway Wait for CI รอ check suite ไหนบ้าง (`Shared admission` ด้วยหรือไม่): ตั้งใน Railway ไม่อยู่ใน repo
- `renovate.json` มีอยู่ แต่ไม่พบ PR จาก Renovate ใน `gh pr list`

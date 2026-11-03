# 18 — Git / release workflow

trunk-based บน `main`: งานส่วนใหญ่มาเป็น PR สั้น ๆ (squash/merge) บางงาน merge ในเครื่องแล้ว push (merge commits `49fa92b`, `a9843e8`, `b8141c9`; PR #1 ถูก close และ merge locally) ไม่มี release tag; release = deployment ของ Railway

```mermaid
gitGraph
  commit id: "2752b91 extract"
  commit id: "f14e440 mcp"
  commit id: "723d752 rename"
  branch ci-adopt
  commit id: "PR2 shared CI"
  checkout main
  merge ci-adopt id: "f286683"
  commit id: "56d04d5 PR3 sentry"
  commit id: "1f23ae5 PR5 deploy"
  branch docs-cd
  commit id: "b64719e"
  checkout main
  merge docs-cd id: "49fa92b deploy"
  commit id: "c4d8b04 strict ts"
  commit id: "77e8d12 CI red, no deploy"
  branch fix-deps
  commit id: "7b676f7"
  checkout main
  merge fix-deps id: "a9843e8 deploy"
  branch shared-admission
  commit id: "1747ea8"
  commit id: "33e2d14"
  checkout main
  merge shared-admission id: "b8141c9 not live"
```

```mermaid
flowchart LR
  A["Branch or direct commit"] --> B["PR optional, no branch protection"]
  B --> C["Merge to main: GitHub or local merge + push"]
  C --> D["ci.yml + shared-runtime.yml on push"]
  D --> E{"Checks green?"}
  E -->|"yes"| F["Railway deploys main"]
  E -->|"no"| G["Deployment inactive"]
  F --> H["curl /healthz (AGENTS.md)"]
  H --> I["Rollback: redeploy earlier Railway deployment"]
```

Sources: `git log origin/main`, `gh pr list -R bookchaowalit/platform-ai-gateway-api --state all`, `gh api …/deployments`, `gh api …/branches/main/protection` (404), `README.md`, `AGENTS.md`

## Open questions

- จะใช้ release tag / CHANGELOG หรือไม่ (ปัจจุบันไม่มี)

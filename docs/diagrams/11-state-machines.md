# 11 — State machines

## Telemetry run status (`ai_run_telemetry.status`)

```mermaid
stateDiagram-v2
  [*] --> requested
  requested --> error: "not_configured, provider failure, invalid response"
  requested --> budget_exceeded: "budget guard denied (cost 0)"
  requested --> success: "provider answered within token_budget"
  requested --> budget_exceeded: "total_tokens over token_budget, content still returned"
  success --> [*]
  error --> [*]
  budget_exceeded --> [*]
```

`requested` ไม่ได้ถูกบันทึก (เป็น state ใน memory) ค่าที่ persist มีแค่ `success | error | budget_exceeded`

## Budget decision (`getAiBudgetStatus().decision`)

```mermaid
stateDiagram-v2
  [*] --> unconfigured: "no monthly budget variable"
  [*] --> unavailable: "cost signal or GPU ledger unreadable"
  [*] --> allow: "within_budget"
  [*] --> deny: "spent + reserved + committed over effective budget"
  allow --> deny: "spend accumulates"
  deny --> allow: "new month period"
```

## Shared admission reservation (staged; state ถือโดย platform-data)

```mermaid
stateDiagram-v2
  [*] --> reserved: "POST /v1/service/admissions"
  reserved --> settled: "settle actual_units"
  reserved --> retained: "unknown usage, crash or settle failure"
  retained --> settled: "operator reconciliation"
  settled --> [*]
```

## Media route decision

```mermaid
stateDiagram-v2
  [*] --> routed: "provider found for kind and language"
  [*] --> blocked: "private or restricted, or no configured provider"
  routed --> [*]
  blocked --> [*]
```

Sources: `api/ai_gateway.ts` (`AiTelemetryEvent.status`, `telemetryForError`), `api/ai_budget.ts` (`decision`, `reason`), `api/ai_shared_admission.ts` (`reserved`, `settled`), `docs/shared-admission.md` (Durable charge behavior), `api/media_router.ts` (`status`)

## Open questions

- state `retained` เป็นชื่อเชิงอธิบายจาก `docs/shared-admission.md` ("preserve durable reservation charge … operator reconciliation") ไม่ใช่ enum ใน code ของ repo นี้

# SPEC-004 — Per-subject model choice and per-model prices

Standard: ADR-0004 — TDD + SDD (architecture-docs, `docs/architecture/decisions/ADR-0004-tdd-sdd-standard.md`).

## Document control

| Field | Value |
|---|---|
| Spec ID / version | SPEC-004 / 1.0 |
| Status | approved (owner chose option A, 2026-11-11); implemented on branch `feat/subject-models` |
| Repository / path | bookchaowalit/platform-ai-gateway-api / `specs/004-subject-models/spec.md` |
| Owner (maker) | Claude Code |
| Reviewer (checker) | Fresh reviewer subagent (no maker context), plus Codex review at Stop |
| Approver | Owner (bookchaowalit) |
| Requirement links | Owner 2026-11-11: "ย้าย meeting-minutes เข้า gateway", option A: change the gateway first |
| Related docs | `README.md`, SPEC-002 (private routes, subject budgets), meeting-minutes `src/meeting_minutes/mom.py` |
| Main-only | no: branch `feat/subject-models`, merged locally after review |
| Created / approved | 2026-11-11 / 2026-11-11 (owner) |

## 1. Problem and intent

- **Problem:** one model per profile serves every caller (production: `gpt-6-luna` on all three profiles), and one
  input/output rate card prices every call. meeting-minutes writes Thai MOM with `gpt-6.1-sol` and calls OpenAI
  directly, outside the gateway's budget, rate limit and telemetry. Moving it would either downgrade its model or change
  the model (and cost) of every other caller, and its spend would be priced at the wrong rate.
- **Outcome:** the owner can give one scoped caller its own model for a profile, with that model's own prices, as a
  Railway variable. Every other caller, and every profile not listed, behaves exactly as before.

## 2. Scope

| In scope | Out of scope (non-goals) |
|---|---|
| `AI_GATEWAY_SUBJECT_MODELS_JSON`: per scoped subject, per profile, a model with its own input/output USD per 1k | Callers choosing a model in the request body |
| Override prices used for the budget reservation, subject budgets, shared admission and telemetry cost | A second provider or base URL (still one OpenAI-compatible upstream) |
| Startup refusal when the variable is malformed | Per-subject fallback models |
| `GET /api/ai/status` shows the caller's own effective models | Showing other subjects' overrides |

## 3. Behaviour

Variable shape:

```json
{"meeting-minutes": {"quality": {"model": "gpt-6.1-sol", "input_usd_per_1k": 0.002, "output_usd_per_1k": 0.008}}}
```

- **AC-01** A request from a scoped static token (`API_TOKENS_JSON`, no workspace) whose subject and profile are listed
  is sent with the listed model. The response and telemetry carry that model; telemetry metadata has
  `subject_model: true`.
- **AC-02** The listed rates replace the global rate card for that call: budget reservation estimate, subject budget,
  shared admission charge and `estimated_cost_usd`.
- **AC-03** Workspace or identity JWT callers never receive an override, even when their `sub` equals a listed subject
  (same rule as SPEC-002 private routes). The subject is never read from the request body.
- **AC-04** Unlisted subjects and unlisted profiles of a listed subject use the global model, fallback and rates unchanged.
- **AC-05** An overridden call has no fallback: a retryable provider error is returned as is, never retried on the
  global fallback model (which would silently change model and price).
- **AC-06** A malformed value (not an object; bad subject, unknown profile, bad model name, missing or negative rate,
  extra keys) makes `serviceConfigurationProblems` report `AI_GATEWAY_SUBJECT_MODELS_JSON is invalid`, so the service
  refuses to start and Railway keeps the previous deployment. If it is ever read at request time while malformed, every
  generate call answers 503 (fail closed), never the global model.
- **AC-07** `GET /api/ai/status` `models` shows the caller's effective model per profile, and `capabilities.subject_models`
  is the number of profiles overridden for that caller (`0` for others). No other subject's entries appear.

## 4. Verification

- Red then green tests in `tests/ai_gateway_subject_models.test.ts` (AC-01..AC-07), plus a service-level startup test.
- `npm test`, `npm run build`, `npm run typecheck`.
- After deploy: `/healthz` 200; a `quality` call with the meeting-minutes token reports `model: gpt-6.1-sol`, and a call
  with another token still reports the global model.

## 5. Rollback

Unset `AI_GATEWAY_SUBJECT_MODELS_JSON` (every caller returns to the global models), or redeploy the previous deployment.

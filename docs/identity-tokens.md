# Identity tokens — `AI_GATEWAY_AUTH_PROFILE=identity`

Owner decision 2026-11-04: this gateway is the Book Platform **ai** service
(`ai-api`), and the `platform-ai` scaffold is retired. Callers move from the
hashed static tokens to platform-identity tokens; both work during the move.

| Variable | Value |
|---|---|
| `AI_GATEWAY_AUTH_PROFILE` | `identity` |
| `AI_GATEWAY_IDENTITY_ISSUER` | `https://identity-api-production-fad1.up.railway.app` (keys from `/.well-known/jwks.json`) |
| `API_TOKENS_JSON` | optional here; existing hashed tokens keep working until they are retired |

A bearer shaped like a JWT is checked only as an identity token (RS256,
audience exactly `ai-api`, the configured issuer, UUID `sub` and `ws`); anything
else is checked as a static token. A failed JWT never falls back to the static
tokens.

| Route | Static token scope | Identity scope (permission) |
|---|---|---|
| `GET /api/ai/status` | `api:read` | `ai:read` (`ai.status:read`) |
| `POST /api/ai/generate`, `POST /api/media/route` | `ai:generate` | `ai:generate` (`ai.generation:write`) |

The workspace of an identity token comes only from its `ws` claim; workspace
headers or body fields are refused with 400, as in the `workspace-jwt` profile.
Shared admission (`AI_GATEWAY_ADMISSION_MODE=shared`) still requires
`workspace-jwt`; this profile keeps the local rate limiter and SQLite budget.

Still open (owner): retiring the static tokens, moving the repository to the
`bookchaowalit-backend` org, and always-on vs serverless (the SQLite telemetry
store needs the volume, so it stays always-on for now).

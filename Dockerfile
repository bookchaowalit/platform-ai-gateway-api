# syntax=docker/dockerfile:1
# Hosted Central AI Gateway (solo-empire.ai-gateway.v1).
#
# Self-contained repository (extracted from solo-empire infra/ on 2026-10-10).
# Build from the repository root:
#   docker build .
# Railway builds the same context with `railway up`.

FROM node:22-slim AS build
WORKDIR /build/api/ai-gateway-service
COPY api/ai-gateway-service/package.json api/ai-gateway-service/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY api/ai_gateway.ts api/ai_budget.ts api/ai_rate_limit.ts api/auth.ts api/media_router.ts api/workspace_auth.ts api/ai_shared_admission.ts /build/api/
COPY platform/media-transcription-routing.json /build/platform/
COPY api/ai-gateway-service/main.ts api/ai-gateway-service/service.ts api/ai-gateway-service/store.ts api/ai-gateway-service/sentry.ts ./
COPY database/migrations/025_ai_run_telemetry.sql /build/database/migrations/
RUN NODE_PATH=/build/api/ai-gateway-service/node_modules npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    AI_GATEWAY_DB_PATH=/data/ai-gateway.sqlite
WORKDIR /app
COPY --from=build /build/api/ai-gateway-service/dist ./dist
COPY api/ai-gateway-service/entrypoint.sh ./entrypoint.sh
# Normalize line endings in case the context was staged from a CRLF checkout.
RUN sed -i 's/\r$//' ./entrypoint.sh \
    && chmod 0755 ./entrypoint.sh \
    && mkdir -p /data \
    && chown node:node /data
EXPOSE 8080
# Starts as root only to take ownership of a freshly mounted volume, then
# drops to the unprivileged `node` user before the server starts.
ENTRYPOINT ["/app/entrypoint.sh"]

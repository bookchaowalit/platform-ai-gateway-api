/**
 * Standalone hosted Central AI Gateway.
 *
 * Exposes only:
 *   GET  /healthz          no auth, no configuration detail
 *   GET  /api/ai/status    scope api:read
 *   POST /api/ai/generate  scope ai:generate
 *   POST /api/media/route  scope ai:generate (metadata-only transcription routing)
 *
 * It reuses the shared gateway modules (contract solo-empire.ai-gateway.v1,
 * Thai-first policy, budget guard, rate limiter) but none of the local
 * infra/api routes. Only scoped hashed tokens from API_TOKENS_JSON are
 * accepted; the legacy full-access API_TOKEN and ALLOW_UNAUTH_DEV are refused
 * at startup. CORS is intentionally not served: callers are server-side.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AI_GATEWAY_CONTRACT, AiGatewayError, generateAi, getAiGatewayStatus, type AiTelemetryEvent } from '../ai_gateway.js';
import { AiBudgetError, createAiBudgetGuard, getAiBudgetStatus } from '../ai_budget.js';
import { aiRateLimitHeaders, createAiRateLimiter, type AiRateLimiter } from '../ai_rate_limit.js';
import { createScopedTokenAuthenticator, type AuthResult } from '../auth.js';
import { decideMediaRoute, MediaRouteError, parseMediaRouteInput } from '../media_router.js';
import { captureError } from './sentry.js';
import type { TelemetryStore } from './store.js';

export const AI_GATEWAY_SERVICE_CONTRACT = 'solo-empire.ai-gateway-service.v1' as const;
export const AI_GATEWAY_SERVICE_VERSION = '0.1.0';

// Defaults for a chat widget behind an app that already enforces per-user
// quotas. All are overridable by environment variables of the same name.
export const SERVICE_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  AI_GATEWAY_MAX_REQUESTS_PER_MINUTE: '120',
  AI_GATEWAY_MAX_CONCURRENT_REQUESTS: '8',
  AI_GATEWAY_TIMEOUT_MS: '30000',
  AI_GATEWAY_ERROR_COST_POLICY: 'bounded',
  // The hosted gateway owns no GPU sessions; point the shared ledger reader at
  // a path that does not exist so it contributes zero.
  LLM_LAB_LEDGER_PATH: '/nonexistent/ai-gateway/gpu-ledger.jsonl',
};

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const SAFE_ID = /^[A-Za-z0-9_.:/-]{1,64}$/;

export type ServiceLogLine = Record<string, string | number | boolean | null>;

export interface AiGatewayServiceOptions {
  env: NodeJS.ProcessEnv;
  store: TelemetryStore;
  log?: (line: ServiceLogLine) => void;
}

export interface AiGatewayService {
  server: Server;
  env: NodeJS.ProcessEnv;
  rateLimiter: AiRateLimiter;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
  }
}

function truthy(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((raw || '').trim().toLowerCase());
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function serviceEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const [name, value] of Object.entries(SERVICE_ENV_DEFAULTS)) {
    if (!env[name] || env[name]!.trim() === '') env[name] = value;
  }
  return env;
}

/** Returns configuration problems by variable name only; never values. */
export function serviceConfigurationProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if ((env.API_TOKEN || '').trim()) {
    problems.push('API_TOKEN (legacy full-access token) must not be set for the hosted AI gateway');
  }
  if (truthy(env.ALLOW_UNAUTH_DEV)) {
    problems.push('ALLOW_UNAUTH_DEV must not be enabled for the hosted AI gateway');
  }
  const auth = createScopedTokenAuthenticator(env.API_TOKENS_JSON);
  if (auth.configurationError) problems.push(`API_TOKENS_JSON is invalid: ${auth.configurationError}`);
  else if (auth.tokenCount === 0) problems.push('API_TOKENS_JSON must contain at least one scoped token hash');
  return problems;
}

function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, baseHeaders(extraHeaders));
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string, code: string, extraHeaders: Record<string, string> = {}): void {
  sendJson(res, status, { contract: AI_GATEWAY_CONTRACT, error: message, code }, extraHeaders);
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (contentType && !contentType.startsWith('application/json')) {
      reject(new HttpError(415, 'Content-Type must be application/json', 'unsupported_media_type'));
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, `Request body too large (max ${maxBytes} bytes)`, 'body_too_large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(new HttpError(413, `Request body too large (max ${maxBytes} bytes)`, 'body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON', 'invalid_json'));
      }
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      reject(new HttpError(400, 'Request body could not be read', 'invalid_body'));
    });
  });
}

function authFailure(res: ServerResponse, auth: AuthResult): void {
  const status = auth.status || 401;
  sendError(
    res,
    status,
    status === 403 ? 'Forbidden' : 'Unauthorized',
    status === 403 ? 'insufficient_scope' : 'unauthorized',
    status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {},
  );
}

function errorCode(error: AiGatewayError): string {
  const errorClass = error.telemetry?.metadata?.error_class;
  if (error.telemetry?.status === 'budget_exceeded') return 'monthly_budget_exceeded';
  // Error classes are fixed identifiers such as timeout, rate_limited,
  // provider_auth, invalid_json or not_configured; never provider text.
  // Provider-side classes get a provider_ prefix so they never collide with
  // the gateway's own limiter codes (rate_limited, concurrency_limited).
  if (typeof errorClass === 'string' && errorClass !== 'provider_error') {
    if (errorClass === 'not_configured' || errorClass.startsWith('provider_')) return errorClass;
    return `provider_${errorClass}`;
  }
  if (error.status === 400) return 'invalid_request';
  if (error.status === 403) return 'privacy_class_denied';
  return 'gateway_error';
}

export function createAiGatewayService(options: AiGatewayServiceOptions): AiGatewayService {
  const env = serviceEnv(options.env);
  const problems = serviceConfigurationProblems(env);
  if (problems.length) throw new Error(`AI gateway service configuration is invalid: ${problems.join('; ')}`);

  const { store } = options;
  const auth = createScopedTokenAuthenticator(env.API_TOKENS_JSON);
  const rateLimiter = createAiRateLimiter(env);
  const maxBodyBytes = boundedInt(env.AI_GATEWAY_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, 1_024, 4 * DEFAULT_MAX_BODY_BYTES);
  const requireBudget = !['0', 'false', 'no', 'off'].includes((env.AI_GATEWAY_REQUIRE_BUDGET || 'true').trim().toLowerCase());
  const log = options.log ?? ((line: ServiceLogLine) => process.stdout.write(`${JSON.stringify(line)}\n`));

  const logRun = (fields: ServiceLogLine, telemetry?: AiTelemetryEvent): void => {
    const metadata = telemetry?.metadata || {};
    log({
      ts: new Date().toISOString(),
      event: 'ai_gateway.run',
      run_id: telemetry?.run_id ?? null,
      route: telemetry && SAFE_ID.test(telemetry.route) ? telemetry.route : null,
      prompt_version: telemetry && telemetry.prompt_version && SAFE_ID.test(telemetry.prompt_version) ? telemetry.prompt_version : null,
      profile: typeof metadata.profile === 'string' ? metadata.profile : null,
      provider: telemetry?.provider ?? null,
      model: telemetry?.model ?? null,
      telemetry_status: telemetry?.status ?? null,
      error_class: typeof metadata.error_class === 'string' ? metadata.error_class : null,
      fallback_used: metadata.fallback_used === true,
      primary_error_class: typeof metadata.primary_error_class === 'string' ? metadata.primary_error_class : null,
      input_tokens: telemetry?.input_tokens ?? null,
      output_tokens: telemetry?.output_tokens ?? null,
      total_tokens: telemetry?.total_tokens ?? null,
      estimated_cost_usd: telemetry?.estimated_cost_usd ?? null,
      latency_ms: telemetry?.latency_ms ?? null,
      ...fields,
    });
  };

  const withSubject = (event: AiTelemetryEvent, subject: string): AiTelemetryEvent => ({
    ...event,
    metadata: { ...event.metadata, subject, service: AI_GATEWAY_SERVICE_CONTRACT },
  });

  async function handleGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const elapsed = () => Number((performance.now() - started).toFixed(3));
    const result = auth.authenticate(req, 'ai:generate');
    if (!result.authorized || result.method !== 'scoped' || !result.subject) {
      logRun({ subject: result.subject, http_status: result.status || 401, code: 'unauthorized', request_ms: elapsed() });
      return authFailure(res, result.authorized ? { ...result, authorized: false, status: 401 } : result);
    }
    const subject = result.subject;

    let body: unknown;
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (error) {
      const httpError = error instanceof HttpError ? error : new HttpError(400, 'Request body could not be read', 'invalid_body');
      logRun({ subject, http_status: httpError.status, code: httpError.code, request_ms: elapsed() });
      return sendError(res, httpError.status, httpError.message, httpError.code, httpError.status === 413 || httpError.status === 415 ? { Connection: 'close' } : {});
    }

    const permit = rateLimiter.acquire(subject);
    if (!permit.allowed) {
      const status = permit.reason === 'configuration_error' ? 503 : 429;
      logRun({ subject, http_status: status, code: permit.reason, request_ms: elapsed() });
      return sendJson(
        res,
        status,
        {
          contract: AI_GATEWAY_CONTRACT,
          error: status === 429 ? 'Too Many Requests' : 'AI gateway rate limiter is unavailable',
          code: permit.reason,
          retry_after_seconds: permit.retryAfterSeconds,
        },
        aiRateLimitHeaders(permit),
      );
    }

    try {
      if (requireBudget && getAiBudgetStatus(store.db, env).decision === 'unconfigured') {
        logRun({ subject, http_status: 503, code: 'budget_not_configured', request_ms: elapsed() });
        return sendError(res, 503, 'AI monthly budget is not configured', 'budget_not_configured');
      }
      let budgetGuard;
      try {
        budgetGuard = createAiBudgetGuard(store.db, env);
      } catch (error) {
        if (error instanceof AiBudgetError) {
          captureError(error);
          logRun({ subject, http_status: 503, code: 'budget_unavailable', request_ms: elapsed() });
          return sendError(res, 503, 'AI monthly budget guard is unavailable', 'budget_unavailable');
        }
        throw error;
      }
      try {
        const generated = await generateAi(body, env, {
          budgetGuard,
          recordTelemetry: (event) => store.record(withSubject(event, subject)),
        });
        logRun({ subject, http_status: 200, code: 'ok', request_ms: elapsed() }, generated.telemetry);
        return sendJson(res, 200, generated.response, aiRateLimitHeaders(permit));
      } catch (error) {
        if (error instanceof AiGatewayError) {
          // Budget denials and configuration failures happen before the
          // provider call and are not persisted by generateAi itself.
          if (error.telemetry && (error.telemetry.estimated_cost_usd === 0 || error.telemetry.provider === null)) {
            store.record(withSubject(error.telemetry, subject));
          }
          const code = errorCode(error);
          if (error.status >= 500) captureError(error); // provider or configuration failure, not a client error
          logRun({ subject, http_status: error.status, code, request_ms: elapsed() }, error.telemetry);
          return sendError(res, error.status, error.message, code);
        }
        if (error instanceof AiBudgetError) {
          captureError(error);
          logRun({ subject, http_status: 503, code: 'budget_unavailable', request_ms: elapsed() });
          return sendError(res, 503, 'AI monthly budget guard is unavailable', 'budget_unavailable');
        }
        throw error;
      }
    } finally {
      permit.release();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method || 'GET';
    let path: string;
    try {
      path = new URL(req.url || '/', 'http://gateway.invalid').pathname;
    } catch {
      return sendError(res, 400, 'Invalid request URL', 'invalid_url');
    }

    if (path === '/healthz') {
      if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'Method Not Allowed', 'method_not_allowed', { Allow: 'GET, HEAD' });
      const ok = store.ping();
      return sendJson(res, ok ? 200 : 503, { status: ok ? 'ok' : 'unavailable' });
    }

    if (path === '/api/ai/status') {
      if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed', 'method_not_allowed', { Allow: 'GET' });
      const result = auth.authenticate(req, 'api:read');
      if (!result.authorized || result.method !== 'scoped') return authFailure(res, result.authorized ? { ...result, authorized: false, status: 401 } : result);
      return sendJson(res, 200, {
        ...getAiGatewayStatus(env),
        budget: getAiBudgetStatus(store.db, env),
        rate_limit: rateLimiter.status(),
        service: {
          contract: AI_GATEWAY_SERVICE_CONTRACT,
          version: AI_GATEWAY_SERVICE_VERSION,
          require_budget: requireBudget,
          max_body_bytes: maxBodyBytes,
          telemetry_store: store.ping() ? 'available' : 'unavailable',
        },
      });
    }

    if (path === '/api/ai/generate') {
      if (method !== 'POST') return sendError(res, 405, 'Method Not Allowed', 'method_not_allowed', { Allow: 'POST' });
      return handleGenerate(req, res);
    }

    if (path === '/api/media/route') {
      if (method !== 'POST') return sendError(res, 405, 'Method Not Allowed', 'method_not_allowed', { Allow: 'POST' });
      return handleMediaRoute(req, res);
    }

    return sendError(res, 404, 'Not Found', 'not_found');
  }

  async function handleMediaRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const result = auth.authenticate(req, 'ai:generate');
    if (!result.authorized || result.method !== 'scoped' || !result.subject) {
      return authFailure(res, result.authorized ? { ...result, authorized: false, status: 401 } : result);
    }
    let body: unknown;
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (error) {
      const httpError = error instanceof HttpError ? error : new HttpError(400, 'Request body could not be read', 'invalid_body');
      return sendError(res, httpError.status, httpError.message, httpError.code, httpError.status === 413 || httpError.status === 415 ? { Connection: 'close' } : {});
    }
    try {
      const decision = decideMediaRoute(parseMediaRouteInput(body), { env });
      log({
        ts: new Date().toISOString(),
        event: 'media_route.decided',
        subject: result.subject,
        status: decision.status,
        content_kind: decision.content_kind.value,
        language: decision.language.value,
        provider: decision.stt?.provider_id ?? null,
        needs_review: decision.needs_review,
      });
      return sendJson(res, 200, decision);
    } catch (error) {
      if (error instanceof MediaRouteError) return sendError(res, 400, error.message, error.code);
      throw error;
    }
  }

  const server = createServer((req, res) => {
    // A 413 response closes the connection so an oversized upload stops.
    res.on('finish', () => {
      if (res.getHeader('Connection') === 'close') req.destroy();
    });
    handle(req, res).catch((error: unknown) => {
      captureError(error);
      log({
        ts: new Date().toISOString(),
        event: 'ai_gateway.unhandled_error',
        error_name: error instanceof Error ? error.name : 'unknown',
      });
      sendError(res, 500, 'Internal Server Error', 'internal_error');
    });
  });
  const timeoutMs = boundedInt(env.AI_GATEWAY_TIMEOUT_MS, 30_000, 1_000, 120_000);
  // Primary + one fallback attempt, plus slack for body upload.
  server.requestTimeout = timeoutMs * 2 + 15_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000;

  return { server, env, rateLimiter };
}

/**
 * SPEC-003 media HTTP surface for the hosted gateway (P1a).
 *
 *   POST /api/ai/media/requests                      ai:image or ai:video (by kind)
 *   GET  /api/ai/media/requests/:id                  ai:image or ai:video, same subject only
 *   GET  /api/ai/media/models                        api:read
 *   POST /internal/media/attempts/:id/lease          ai:media-worker (exact scope, scoped static token)
 *   POST /internal/media/attempts/:id/report         ai:media-worker
 *   POST /internal/media/attempts/:id/heartbeat      ai:media-worker
 *
 * The service hands every request here first; `handle` returns false for paths it does not own.
 * Every response is no-store (the service's base headers). Bodies carry no prompt text except the
 * lease response to the worker.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { aiRateLimitHeaders, createAiRateLimiter, type AiRateLimiter } from '../ai_rate_limit.js';
import type { WorkspaceAuthResult } from '../workspace_auth.js';
import type { AiTelemetryEvent } from '../ai_gateway.js';
import type { DatabaseSync } from 'node:sqlite';
import { parsePayloadKeys, type SignedQueueMessage } from './crypto.js';
import { createMediaJobs, type MediaCaller, type MediaJobs, type MediaResult } from './jobs.js';
import { r2SignerFromEnv } from './r2.js';
import { validateMediaGenerationRegistry, type MediaGenerationRegistry } from './registry.js';
import defaultRegistryJson from '../../platform/media-generation-routing.json' with { type: 'json' };

export const DEFAULT_MEDIA_REGISTRY = defaultRegistryJson as unknown as MediaGenerationRegistry;

export interface MediaHttpDeps {
  env: NodeJS.ProcessEnv;
  db: DatabaseSync;
  record: (event: AiTelemetryEvent) => void;
  registry?: MediaGenerationRegistry;
  authenticate: (req: IncomingMessage, scope: string) => Promise<WorkspaceAuthResult>;
  /** Scoped static tokens only, used for /internal/media/* under every public auth profile. */
  authenticateWorker?: (req: IncomingMessage, scope: string) => Promise<WorkspaceAuthResult>;
  readJson: (req: IncomingMessage, maxBytes: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
  authFailure: (res: ServerResponse, result: WorkspaceAuthResult) => void;
  maxBodyBytes: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (line: Record<string, string | number | boolean | null>) => void;
}

export interface MediaHttp {
  handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean>;
  status(result: WorkspaceAuthResult): Record<string, unknown>;
  jobs: MediaJobs;
  /** Starts the housekeeping timer (0 disables). Returns a stop function. */
  startHousekeeping(intervalMs: number): () => void;
}

const ACCEPTED_METHODS = new Set(['scoped', 'workspace-jwt', 'identity-jwt']);
const REQUEST_PATH = /^\/api\/ai\/media\/requests\/([A-Za-z0-9_-]{1,64})$/;
const INTERNAL_PATH = /^\/internal\/media\/attempts\/([A-Za-z0-9_-]{1,64})\/(lease|report|heartbeat)$/;
const INTERNAL_BODY_BYTES = 64 * 1024;

function limiter(env: NodeJS.ProcessEnv, rpmVar: string, rpmDefault: string, concurrency: string): AiRateLimiter {
  return createAiRateLimiter({
    ...env,
    AI_GATEWAY_MAX_REQUESTS_PER_MINUTE: (env[rpmVar] || '').trim() || rpmDefault,
    AI_GATEWAY_MAX_CONCURRENT_REQUESTS: concurrency,
    AI_GATEWAY_SUBJECT_LIMITS_JSON: '',
  });
}

function hasScope(result: WorkspaceAuthResult, scope: string): boolean {
  return result.authorized && Array.isArray(result.scopes) && result.scopes.includes(scope);
}

export function createMediaHttp(deps: MediaHttpDeps): MediaHttp {
  const { env } = deps;
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const registry = deps.registry ?? DEFAULT_MEDIA_REGISTRY;
  const keys = parsePayloadKeys(env.AI_GATEWAY_MEDIA_PAYLOAD_KEYS_JSON);
  const signer = r2SignerFromEnv(env, now);
  const workerUrl = (env.AI_GATEWAY_MEDIA_WORKER_URL || '').trim().replace(/\/+$/, '');
  const enqueueToken = (env.AI_GATEWAY_MEDIA_WORKER_ENQUEUE_TOKEN || '').trim();

  async function enqueue(message: SignedQueueMessage): Promise<void> {
    if (!workerUrl || !enqueueToken) throw new Error('media worker is not configured');
    const response = await fetchImpl(`${workerUrl}/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${enqueueToken}` },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5_000),
    });
    // Drain the body so the connection can be reused; its content is not needed.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) throw new Error(`media worker enqueue returned ${response.status}`);
  }

  const jobs = createMediaJobs({
    db: deps.db,
    record: deps.record,
    registry,
    env,
    payloadKeys: keys.ok ? keys.keys : undefined,
    queueKey: (env.AI_GATEWAY_MEDIA_QUEUE_KEY || '').trim(),
    now,
    enqueue,
  });

  const createImage = limiter(env, 'AI_GATEWAY_MEDIA_IMAGE_RPM', '20', '8');
  const createVideo = limiter(env, 'AI_GATEWAY_MEDIA_VIDEO_RPM', '4', '4');
  const reads = limiter(env, 'AI_GATEWAY_MEDIA_READ_RPM', '120', '16');
  const internal = limiter(env, 'AI_GATEWAY_MEDIA_INTERNAL_RPM', '600', '32');

  function problems(): string[] {
    const list = [...jobs.problems()];
    if (!signer.ok) list.push(signer.problem);
    // https only: the enqueue token travels with every call (plain http is allowed for loopback tests).
    if (!/^https:\/\/[^\s/]+/.test(workerUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(workerUrl)) {
      list.push('AI_GATEWAY_MEDIA_WORKER_URL is not set (https URL required)');
    }
    if (!enqueueToken) list.push('AI_GATEWAY_MEDIA_WORKER_ENQUEUE_TOKEN is not set');
    if (!keys.ok) list.push(keys.problem);
    return [...new Set(list)];
  }

  const enabledKinds = (kind: 'image' | 'video') => validateMediaGenerationRegistry(registry).problems.length === 0
    && Object.values(registry.models).some((m) => m.kind === kind && m.enabled);

  function send(res: ServerResponse, result: MediaResult, headers: Record<string, string> = {}): void {
    deps.sendJson(res, result.status, result.body, headers);
  }

  function limited(res: ServerResponse, rate: AiRateLimiter, key: string): (() => void) | null {
    const permit = rate.acquire(key);
    if (!permit.allowed) {
      deps.sendJson(res, permit.reason === 'configuration_error' ? 503 : 429, { error: 'rate_limited', retry_after_seconds: permit.retryAfterSeconds }, aiRateLimitHeaders(permit));
      return null;
    }
    return permit.release;
  }

  function callerOf(result: WorkspaceAuthResult): MediaCaller {
    return { subject: result.subject as string, ...(result.workspace ? { workspace: result.workspace } : {}) };
  }

  /** Authenticate a public media caller holding ai:image or ai:video. */
  async function mediaCaller(req: IncomingMessage, res: ServerResponse): Promise<WorkspaceAuthResult | null> {
    let result = await deps.authenticate(req, 'ai:image');
    if (!result.authorized && result.status === 403) result = await deps.authenticate(req, 'ai:video');
    if (!result.authorized || !ACCEPTED_METHODS.has(result.method) || !result.subject) {
      deps.authFailure(res, result.authorized ? { ...result, authorized: false, status: 401 } : result);
      return null;
    }
    return result;
  }

  async function readBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<{ ok: true; body: unknown } | { ok: false }> {
    try {
      return { ok: true, body: await deps.readJson(req, maxBytes) };
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 400;
      deps.sendJson(res, status, { error: (error as { code?: string }).code ?? 'invalid_body' }, status === 413 || status === 415 ? { Connection: 'close' } : {});
      return { ok: false };
    }
  }

  async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const result = await mediaCaller(req, res);
    if (!result) return;
    const parsed = await readBody(req, res, deps.maxBodyBytes);
    if (!parsed.ok) return;
    const kind = (parsed.body as { kind?: unknown } | null)?.kind;
    const scope = kind === 'video' ? 'ai:video' : 'ai:image';
    if (!hasScope(result, scope)) return deps.authFailure(res, { ...result, authorized: false, status: 403 });
    const key = result.workspace ? `${result.workspace}:${result.subject}` : String(result.subject);
    const dryRun = (parsed.body as { dry_run?: unknown } | null)?.dry_run === true;
    // A dry run only prices: it uses the read bucket, not the create quota (AC-07).
    const release = limited(res, dryRun ? reads : kind === 'video' ? createVideo : createImage, key);
    if (!release) return;
    try {
      const outside = problems().filter((p) => !jobs.problems().includes(p));
      if (outside.length) return send(res, { status: 503, body: { error: 'media_disabled', message: 'media generation is not configured' } });
      const idempotencyKey = req.headers['idempotency-key'];
      const created = await jobs.create(callerOf(result), parsed.body, { idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined });
      deps.log?.({ ts: now().toISOString(), event: 'media.request', subject: result.subject, http_status: created.status, code: (created.body as { error?: string }).error ?? 'ok' });
      return send(res, created);
    } finally {
      release();
    }
  }

  async function handleRead(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const result = await mediaCaller(req, res);
    if (!result) return;
    const key = result.workspace ? `${result.workspace}:${result.subject}` : String(result.subject);
    const release = limited(res, reads, key);
    if (!release) return;
    try {
      if (!signer.ok) return send(res, { status: 503, body: { error: 'media_disabled', message: 'media generation is not configured' } });
      const kinds = (['image', 'video'] as const).filter((kind) => hasScope(result, `ai:${kind}`));
      return send(res, await jobs.read(callerOf(result), id, signer.signer, kinds));
    } finally {
      release();
    }
  }

  async function handleModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const result = await deps.authenticate(req, 'api:read');
    if (!result.authorized || !ACCEPTED_METHODS.has(result.method)) return deps.authFailure(res, result.authorized ? { ...result, authorized: false, status: 401 } : result);
    const release = limited(res, reads, result.workspace ? `${result.workspace}:${result.subject}` : String(result.subject ?? 'anonymous'));
    if (!release) return;
    try {
      const providers = new Set((env.AI_GATEWAY_MEDIA_PROVIDERS || '').split(',').map((p) => p.trim()).filter(Boolean));
      const callerKey = result.workspace ? `${result.workspace}:${result.subject}` : String(result.subject ?? '');
      let allowed: string[] | undefined;
      try {
        const parsedAllow = JSON.parse(env.AI_GATEWAY_MEDIA_SUBJECT_MODELS_JSON || '{}') as Record<string, unknown>;
        const entry = Object.hasOwn(parsedAllow, callerKey) ? parsedAllow[callerKey] : undefined;
        allowed = Array.isArray(entry) ? entry.filter((m): m is string => typeof m === 'string') : undefined;
      } catch {
        allowed = [];
      }
      const valid = validateMediaGenerationRegistry(registry).problems.length === 0;
      const models = valid ? Object.entries(registry.models).filter(([, m]) => m.enabled).map(([id, m]) => ({
        id,
        kind: m.kind,
        provider: m.provider,
        capabilities: m.capabilities,
        unit: m.pricing.unit,
        unit_prices_usd: m.pricing.usd,
        cost_source: m.pricing.cost_source,
        prices_checked_at: m.pricing.checked_at,
        available: providers.has(m.provider) && (allowed === undefined || allowed.includes(id)),
      })) : [];
      const profiles = valid ? Object.entries(registry.profiles).map(([id, p]) => ({ id, kind: p.kind, defaults: p.defaults, models: p.models })) : [];
      return deps.sendJson(res, 200, { registry_updated_at: valid ? registry.updated_at : null, models, profiles });
    } finally {
      release();
    }
  }

  async function handleInternal(req: IncomingMessage, res: ServerResponse, id: string, action: string): Promise<void> {
    const result = await (deps.authenticateWorker ?? deps.authenticate)(req, 'ai:media-worker');
    // Exact scope on a scoped static token only: no '*' tokens, no workspace or identity JWTs (AC-02).
    if (!result.authorized || result.method !== 'scoped' || result.workspace || !hasScope(result, 'ai:media-worker')) {
      return deps.authFailure(res, { ...result, authorized: false, status: result.status === 401 ? 401 : 403 });
    }
    const release = limited(res, internal, String(result.subject));
    if (!release) return;
    try {
      const parsed = await readBody(req, res, INTERNAL_BODY_BYTES);
      if (!parsed.ok) return;
      if (action === 'lease') return send(res, await jobs.lease(id, parsed.body));
      if (action === 'report') return send(res, await jobs.report(id, parsed.body));
      return send(res, await jobs.heartbeat(id, parsed.body));
    } finally {
      release();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
    const methodNotAllowed = (allow: string) => deps.sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: allow });
    if (path === '/api/ai/media/requests') {
      if (method !== 'POST') methodNotAllowed('POST');
      else await handleCreate(req, res);
      return true;
    }
    if (path === '/api/ai/media/models') {
      if (method !== 'GET') methodNotAllowed('GET');
      else await handleModels(req, res);
      return true;
    }
    const read = REQUEST_PATH.exec(path);
    if (read) {
      if (method !== 'GET') methodNotAllowed('GET');
      else await handleRead(req, res, read[1]);
      return true;
    }
    const internalMatch = INTERNAL_PATH.exec(path);
    if (internalMatch) {
      if (method !== 'POST') methodNotAllowed('POST');
      else await handleInternal(req, res, internalMatch[1], internalMatch[2]);
      return true;
    }
    if (path.startsWith('/api/ai/media/') || path.startsWith('/internal/media/')) {
      deps.sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    return false;
  }

  function status(result: WorkspaceAuthResult): Record<string, unknown> {
    const list = problems();
    const usable = list.length === 0;
    return {
      capabilities: {
        image: usable && hasScope(result, 'ai:image') && enabledKinds('image'),
        video: usable && hasScope(result, 'ai:video') && enabledKinds('video'),
        compare: false,
        references: false,
      },
      problems: list,
      limits: {
        max_prompt_chars: Number(env.AI_GATEWAY_MEDIA_MAX_PROMPT_CHARS) || 4_000,
        url_ttl_s: signer.ok ? signer.ttlSeconds : null,
        max_active_per_subject: Number(env.AI_GATEWAY_MEDIA_MAX_ACTIVE_PER_SUBJECT) || 4,
      },
    };
  }

  function startHousekeeping(intervalMs: number): () => void {
    if (!(intervalMs > 0)) return () => undefined;
    // One pass at startup: pending sends and expired leases from before a restart do not wait a tick.
    // Runs even while admission is off: open jobs must still time out, reservations close and payloads purge.
    const run = () => {
      jobs.housekeeping().catch((error: unknown) => {
        deps.log?.({ ts: now().toISOString(), event: 'media.housekeeping_failed', error_name: error instanceof Error ? error.name : 'unknown' });
      });
    };
    setImmediate(run);
    const timer = setInterval(run, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  return { handle, status, jobs, startHousekeeping };
}

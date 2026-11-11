/**
 * SPEC-003 media jobs core (P1a): admission, reservations, dispatch, leases, reports, settlement,
 * reads and housekeeping. The gateway is the single writer of job state and money (§3.1).
 *
 * - Reservations are rows of non-terminal attempts (§4.7 rule 1); caps are checked and the rows
 *   inserted in one BEGIN IMMEDIATE transaction.
 * - One ledger row per attempt in ai_run_telemetry, written once at settlement (§4.7 rule 2).
 * - Terminal states are absorbing (rule 3); submit intent is reported before the paid call
 *   (rule 4); leases, slots and heartbeats follow rule 5; one attempt TTL closes the rest (rule 6);
 *   dispatch retries back off (rule 7).
 *
 * Every method returns an HTTP-shaped {status, body} so the service only routes. Bodies never carry
 * prompt text except the decrypted payload in a lease response to the worker.
 */

import type { DatabaseSync } from 'node:sqlite';
import { aiBudgetKey, checkMediaBudget } from '../ai_budget.js';
import type { AiTelemetryEvent } from '../ai_gateway.js';
import {
  canonicalHash,
  openPayload,
  queueMessageSignature,
  randomId,
  refMac,
  sealPayload,
  sha256Hex,
  subjectHash,
  verifyQueueMessage,
  constantTimeEqual,
  PayloadUnavailableError,
  type PayloadKeys,
  type QueueReason,
  type SignedQueueMessage,
} from './crypto.js';
import {
  routeMediaGeneration,
  validateMediaGenerationRegistry,
  type MediaGenerationRegistry,
  type MediaKind,
  type MediaPrivacyClass,
  type MediaRouteRequest,
} from './registry.js';

export interface MediaCaller {
  subject: string;
  workspace?: string;
}

export interface MediaResult {
  status: number;
  body: unknown;
}

export interface MediaJobsDeps {
  db: DatabaseSync;
  record: (event: AiTelemetryEvent) => void;
  registry: MediaGenerationRegistry;
  env: NodeJS.ProcessEnv;
  payloadKeys: PayloadKeys | undefined;
  queueKey: string;
  now: () => Date;
  enqueue: (message: SignedQueueMessage) => Promise<void>;
}

export interface MediaSigner {
  signGetUrl: (objectKey: string) => Promise<{ url: string; expires_at: string }>;
}

export interface MediaJobs {
  /** Problems that keep media off (no values); empty when media is usable. */
  problems(): string[];
  create(caller: MediaCaller, body: unknown, options: { idempotencyKey?: string }): Promise<MediaResult>;
  lease(attemptId: string, body: unknown): Promise<MediaResult>;
  report(attemptId: string, body: unknown): Promise<MediaResult>;
  heartbeat(attemptId: string, body: unknown): Promise<MediaResult>;
  read(caller: MediaCaller, requestId: string, signer: MediaSigner, kinds?: ReadonlyArray<MediaKind>): Promise<MediaResult>;
  housekeeping(): Promise<void>;
}

type AttemptStatus = 'queued' | 'leased' | 'submit_started' | 'submitted' | 'completed' | 'failed' | 'cancelled' | 'expired';

interface AttemptRow {
  id: string;
  request_id: string;
  subject_key: string;
  model_id: string;
  provider_id: string;
  provider_model: string;
  adapter: string;
  status: AttemptStatus;
  dispatch_state: 'pending' | 'sent';
  dispatch_tries: number;
  dispatch_no: string;
  next_dispatch_at: string | null;
  first_leased_at: string | null;
  lease_recoveries: number;
  poll_count: number;
  submit_started_at: string | null;
  lease_id: string | null;
  lease_deadline: string | null;
  lease_started_at: string | null;
  report_seq: number;
  provider_job_ref: string | null;
  units: number;
  unit_price_usd: number;
  cost_source: 'registry' | 'provider';
  cancel_policy: 'free' | 'charged';
  expected_outputs: number;
  reserved_usd: number;
  cost_usd: number | null;
  flags: string;
  lease_history: string;
  cancel_requested_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface RequestRow {
  id: string;
  subject_key: string;
  subject: string;
  workspace_id: string;
  kind: MediaKind;
  mode: 'single' | 'compare';
  profile: string | null;
  prompt_sha256: string;
  route: string;
  status: string;
  reserved_usd: number;
  settled_usd: number;
  request_hash: string;
  created_at: string;
}

const TERMINAL: ReadonlySet<AttemptStatus> = new Set(['completed', 'failed', 'cancelled', 'expired']);
const ERROR_CODES = new Set([
  'content_policy', 'provider_error', 'invalid_input', 'invalid_response', 'budget_exceeded', 'timeout',
  'submit_unknown', 'lease_exhausted', 'dispatch_error', 'payload_unavailable', 'cancelled',
]);
const ALLOWED_FIELDS = new Set([
  'kind', 'mode', 'blind', 'profile', 'models', 'n_models', 'prompt', 'negative_prompt', 'aspect', 'resolution', 'n',
  'seconds', 'audio', 'format', 'references', 'params', 'route', 'privacy_class', 'purpose', 'dry_run', 'expected_reserved_usd',
]);
const FORMATS = new Set(['png', 'jpeg', 'webp']);
const ROUTE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const LEASE_MS = 120_000;
const HEARTBEAT_MAX_MS = 15 * 60_000;
const NO_SLOT_RETRY_MS = 5_000;
const MAX_LEASE_RECOVERIES = 5;
const DISPATCH_WINDOW_MS = 30 * 60_000;
const DISPATCH_BACKOFF_START_MS = 10_000;
const DISPATCH_BACKOFF_MAX_MS = 5 * 60_000;
const PAYLOAD_KEEP_AFTER_DONE_MS = 60 * 60_000;
const PAYLOAD_MAX_AGE_MS = 7 * 24 * 3_600_000;
const IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;
const TTL_MARGIN_MS = 30 * 60_000;

function fail(status: number, error: string, extra: Record<string, unknown> = {}): MediaResult {
  return { status, body: { error, ...extra } };
}

const MESSAGES: Record<string, string> = {
  invalid_request: 'media request is invalid',
  privacy_class_refused: 'private and restricted data are not accepted for media generation',
  media_disabled: 'media generation is not configured',
  no_route: 'no model can serve this request',
  budget_exceeded: 'media budget exceeded',
  too_many_jobs: 'too many active media jobs for this caller',
  idempotency_conflict: 'idempotency key was used with a different request',
  price_changed: 'the reservation differs from the expected amount',
  not_found: 'media request not found',
};

function problem(status: number, error: string, extra: Record<string, unknown> = {}): MediaResult {
  return fail(status, error, { message: MESSAGES[error] ?? error, ...extra });
}

function iso(date: Date | number): string {
  return new Date(date).toISOString();
}

function ms(value: string | null): number {
  return value ? Date.parse(value) : NaN;
}

function money(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ValidRequest extends MediaRouteRequest {
  prompt: string;
  negative_prompt?: string;
  format: 'png' | 'jpeg' | 'webp';
  params: Record<string, unknown>;
  route: string;
  dry_run: boolean;
  expected_reserved_usd?: number;
}

export function createMediaJobs(deps: MediaJobsDeps): MediaJobs {
  const { db, registry, env } = deps;
  const registryProblems = validateMediaGenerationRegistry(registry).problems;
  const providersAvailable = new Set((env.AI_GATEWAY_MEDIA_PROVIDERS || '').split(',').map((p) => p.trim()).filter(Boolean));
  const maxPrompt = intEnv(env.AI_GATEWAY_MEDIA_MAX_PROMPT_CHARS, 4_000, 1, 32_000);
  const maxActive = intEnv(env.AI_GATEWAY_MEDIA_MAX_ACTIVE_PER_SUBJECT, 4, 1, 1_000);
  // Never longer than the bucket's 30-day lifecycle rule, or reads would sign URLs for deleted objects.
  const retentionDays = Math.min(intEnv(env.AI_GATEWAY_MEDIA_RETENTION_DAYS, 30, 1, 3_650), 30);
  const subjectHashKey = (env.AI_GATEWAY_MEDIA_SUBJECT_HASH_KEY || '').trim();
  let subjectModels: Record<string, string[]> | null | 'invalid' = null;
  if ((env.AI_GATEWAY_MEDIA_SUBJECT_MODELS_JSON || '').trim()) {
    try {
      const parsed = JSON.parse(env.AI_GATEWAY_MEDIA_SUBJECT_MODELS_JSON as string) as unknown;
      subjectModels = isObject(parsed) && Object.values(parsed).every((v) => Array.isArray(v) && v.every((m) => typeof m === 'string'))
        ? parsed as Record<string, string[]>
        : 'invalid';
    } catch {
      subjectModels = 'invalid';
    }
  }

  // Only look inside the registry once it passed validation; a malformed one keeps media off.
  const usableModels = registryProblems.length ? [] : Object.entries(registry.models)
    .filter(([, model]) => model.enabled && providersAvailable.has(model.provider) && registry.providers[model.provider]);

  function problems(): string[] {
    const list: string[] = [];
    if (!['1', 'true', 'yes', 'on'].includes((env.AI_GATEWAY_MEDIA_ENABLED || '').trim().toLowerCase())) list.push('AI_GATEWAY_MEDIA_ENABLED is not set');
    const cap = Number(env.AI_GATEWAY_MEDIA_MONTHLY_BUDGET_USD);
    if (!(env.AI_GATEWAY_MEDIA_MONTHLY_BUDGET_USD || '').trim() || !Number.isFinite(cap) || cap < 0) list.push('AI_GATEWAY_MEDIA_MONTHLY_BUDGET_USD is not set');
    if (!deps.payloadKeys) list.push('AI_GATEWAY_MEDIA_PAYLOAD_KEYS_JSON is not usable');
    if (deps.queueKey.length < 32) list.push('AI_GATEWAY_MEDIA_QUEUE_KEY is not set (32+ characters)');
    if (subjectHashKey.length < 16) list.push('AI_GATEWAY_MEDIA_SUBJECT_HASH_KEY is not set');
    if (subjectModels === 'invalid') list.push('AI_GATEWAY_MEDIA_SUBJECT_MODELS_JSON is invalid');
    for (const p of registryProblems) list.push(`registry: ${p}`);
    if (usableModels.length === 0) list.push('no enabled model has an available provider (AI_GATEWAY_MEDIA_PROVIDERS)');
    return list;
  }

  const now = () => deps.now();

  // ---------------------------------------------------------------- validation (AC-03)

  function validate(raw: unknown): { ok: true; request: ValidRequest } | { ok: false; result: MediaResult } {
    const bad = (detail: string) => ({ ok: false as const, result: problem(400, 'invalid_request', { detail }) });
    if (!isObject(raw)) return bad('body must be a JSON object');
    for (const key of Object.keys(raw)) if (!ALLOWED_FIELDS.has(key)) return bad(`unknown field ${key}`);
    const { kind, mode = 'single', profile, models, prompt, negative_prompt, aspect, resolution, n, seconds, format = 'png', params, route, privacy_class, purpose } = raw;
    if (kind !== 'image' && kind !== 'video') return bad('kind must be image or video');
    if (mode !== 'single' && mode !== 'compare') return bad('mode must be single or compare');
    if (mode === 'compare' || raw.blind !== undefined || raw.n_models !== undefined) return bad('compare mode is not available yet');
    if (raw.references !== undefined) return bad('references are not available yet');
    if (raw.audio !== undefined && typeof raw.audio !== 'boolean') return bad('audio must be a boolean');
    if ((profile === undefined) === (models === undefined)) return bad('give exactly one of profile or models');
    if (profile !== undefined && (typeof profile !== 'string' || !registry.profiles[profile])) return bad('profile is unknown');
    if (models !== undefined) {
      if (!Array.isArray(models) || models.length < 1 || models.length > 4 || new Set(models).size !== models.length) return bad('models must list 1 to 4 distinct ids');
      for (const id of models) {
        if (typeof id !== 'string' || !registry.models[id] || !registry.models[id].enabled) return bad('models names an unknown or disabled model');
      }
    }
    if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > maxPrompt) return bad(`prompt must be 1 to ${maxPrompt} characters`);
    if (negative_prompt !== undefined && (typeof negative_prompt !== 'string' || negative_prompt.length > maxPrompt)) return bad('negative_prompt is too long');
    if (privacy_class !== 'public' && privacy_class !== 'internal' && privacy_class !== 'private' && privacy_class !== 'restricted') return bad('privacy_class is invalid');
    if (privacy_class === 'private' || privacy_class === 'restricted') return { ok: false, result: problem(403, 'privacy_class_refused') };
    if (typeof route !== 'string' || !ROUTE.test(route)) return bad('route is invalid');
    if (purpose !== undefined && (typeof purpose !== 'string' || purpose.length > 200)) return bad('purpose is too long');
    if (typeof format !== 'string' || !FORMATS.has(format)) return bad('format must be png, jpeg or webp');
    if (params !== undefined && !isObject(params)) return bad('params must be an object');
    if (raw.dry_run !== undefined && typeof raw.dry_run !== 'boolean') return bad('dry_run must be a boolean');
    const expected = raw.expected_reserved_usd;
    if (expected !== undefined && (typeof expected !== 'number' || !Number.isFinite(expected) || expected < 0)) return bad('expected_reserved_usd must be a number');
    const profileEntry = typeof profile === 'string' ? registry.profiles[profile] : undefined;
    if (profileEntry && profileEntry.kind !== kind) return bad('profile kind does not match');
    const finalAspect = aspect ?? profileEntry?.defaults.aspect;
    if (typeof finalAspect !== 'string') return bad('aspect is required');
    const finalResolution = resolution ?? profileEntry?.defaults.resolution ?? 'standard';
    if (typeof finalResolution !== 'string') return bad('resolution is invalid');
    const finalN = n ?? 1;
    if (kind === 'image' && (!Number.isInteger(finalN) || (finalN as number) < 1)) return bad('n must be a positive integer');
    const finalSeconds = seconds ?? profileEntry?.defaults.seconds;
    if (kind === 'video' && (!Number.isInteger(finalSeconds) || (finalSeconds as number) < 1)) return bad('seconds must be a positive integer');
    // Capability against any candidate, ignoring availability: unsupported parameters are a 400, not a 422.
    const candidateIds = (models as string[] | undefined) ?? profileEntry?.models ?? [];
    const supported = candidateIds.some((id) => {
      const caps = registry.models[id]?.capabilities;
      if (!caps || registry.models[id].kind !== kind) return false;
      if (!caps.aspects.includes(finalAspect) || !caps.resolutions.includes(finalResolution)) return false;
      if (kind === 'image' && (finalN as number) > (caps.max_n ?? 1)) return false;
      if (kind === 'video' && !(caps.seconds ?? []).includes(finalSeconds as number)) return false;
      return true;
    });
    if (!supported) return bad('no candidate model supports these parameters');
    return {
      ok: true,
      request: {
        kind, mode: 'single', profile: profile as string | undefined, models: models as string[] | undefined,
        aspect: finalAspect, resolution: finalResolution, n: kind === 'image' ? finalN as number : undefined,
        seconds: kind === 'video' ? finalSeconds as number : undefined, privacy_class: privacy_class as MediaPrivacyClass,
        prompt, negative_prompt: negative_prompt as string | undefined, format: format as ValidRequest['format'],
        params: (params as Record<string, unknown>) ?? {}, route, dry_run: raw.dry_run === true,
        expected_reserved_usd: expected as number | undefined,
      },
    };
  }

  function paramsAllowed(modelId: string, params: Record<string, unknown>): string | null {
    const allowed = registry.models[modelId].extra_params;
    for (const [key, value] of Object.entries(params)) {
      // Own properties only: names like constructor or __proto__ must not match the prototype.
      const spec = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
      if (!spec || !isObject(spec)) return `params.${key} is not allowed for this model`;
      if (spec.type === 'integer' && !Number.isInteger(value)) return `params.${key} must be an integer`;
      if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `params.${key} must be a number`;
      if (spec.type === 'boolean' && typeof value !== 'boolean') return `params.${key} must be a boolean`;
      if (spec.type === 'string' && (typeof value !== 'string' || (spec.values && !spec.values.includes(value)))) return `params.${key} is not an allowed value`;
      if (typeof value === 'number' && ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max))) return `params.${key} is out of range`;
    }
    return null;
  }

  // ---------------------------------------------------------------- create (AC-06, AC-07)

  const selectRequestByKey = db.prepare('SELECT * FROM media_requests WHERE subject_key = ? AND idempotency_key = ?');
  const countActive = db.prepare(`SELECT COUNT(*) AS n FROM media_attempts WHERE subject_key = ? AND status IN ('queued', 'leased', 'submit_started', 'submitted')`);
  const insertRequest = db.prepare(`INSERT INTO media_requests
    (id, subject_key, subject, workspace_id, kind, mode, blind, profile, route, status, reserved_usd, settled_usd, prompt_sha256, request_hash, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'single', 0, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?)`);
  const insertPayload = db.prepare(`INSERT INTO media_request_payloads (request_id, ciphertext, nonce, key_id, created_at, purge_after) VALUES (?, ?, ?, ?, ?, ?)`);
  const insertAttempt = db.prepare(`INSERT INTO media_attempts
    (id, request_id, subject_key, attempt_no, model_id, provider_id, provider_model, adapter, status, dispatch_state, dispatch_tries, dispatch_no, next_dispatch_at,
     units, unit_price_usd, cost_source, cancel_policy, expected_outputs, reserved_usd, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'queued', 'pending', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function existingResponse(row: RequestRow): MediaResult {
    const attempts = (db.prepare('SELECT COUNT(*) AS n FROM media_attempts WHERE request_id = ?').get(row.id) as { n: number }).n;
    return { status: 200, body: { id: row.id, status: row.status, attempts, reserved_usd: row.reserved_usd, poll_after_ms: 2_000, idempotent_replay: true } };
  }

  async function create(caller: MediaCaller, raw: unknown, options: { idempotencyKey?: string }): Promise<MediaResult> {
    if (problems().length) return problem(503, 'media_disabled');
    const validated = validate(raw);
    if (!validated.ok) return validated.result;
    const request = validated.request;
    if (options.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(options.idempotencyKey)) return problem(400, 'invalid_request', { detail: 'Idempotency-Key is invalid' });
    const subjectKey = aiBudgetKey(caller);
    const budgetCaller = { subject: caller.subject, workspace: caller.workspace };
    // Own properties only: a subject named constructor / __proto__ must not hit the prototype.
    const allowedModels = subjectModels && subjectModels !== 'invalid' && Object.hasOwn(subjectModels, subjectKey) ? subjectModels[subjectKey] : undefined;
    const credentialProviders = new Map(Object.entries(registry.providers).map(([id, p]) => [p.credential_env, id]));
    const routeOnce = (budgetAllows: (usd: number) => boolean) => routeMediaGeneration(registry, request, {
      now: now(),
      hasCredential: (envName) => providersAvailable.has(credentialProviders.get(envName) ?? ''),
      subjectAllowsModel: (id) => allowedModels === undefined || allowedModels.includes(id),
      budgetAllows,
    });
    const callerSkipped = (skipped: Array<{ model_id: string; reason: string }>) =>
      skipped.map((s) => ({ model_id: s.model_id, reason: s.reason === 'no_credential' ? 'unavailable' : s.reason }));

    const requestHash = await canonicalHash({ ...(raw as Record<string, unknown>), dry_run: undefined, expected_reserved_usd: undefined });
    if (request.dry_run) {
      const routed = routeOnce((usd) => checkMediaBudget(db, env, budgetCaller, usd).ok);
      if (routed.selected.length === 0) return problem(422, 'no_route', { routing: { selected: [], skipped: callerSkipped(routed.skipped) } });
      const paramProblem = paramsAllowed(routed.selected[0].model_id, request.params);
      if (paramProblem) return problem(400, 'invalid_request', { detail: paramProblem });
      return { status: 200, body: { dry_run: true, reserved_usd: money(routed.selected.reduce((t, s) => t + s.reserved_usd, 0)), routing: { selected: routed.selected.map((s) => s.model_id), skipped: callerSkipped(routed.skipped) } } };
    }

    const requestId = randomId();
    const resolution = request.resolution ?? 'standard';
    const mappedParams: Record<string, Record<string, unknown>> = {};
    for (const id of request.models ?? registry.profiles[request.profile as string]?.models ?? []) {
      const model = registry.models[id];
      if (model?.param_map.aspect[request.aspect] && model.param_map.resolution[resolution]) {
        mappedParams[id] = { ...model.param_map.aspect[request.aspect], ...model.param_map.resolution[resolution] };
      }
    }
    const sealed = await sealPayload(deps.payloadKeys as PayloadKeys, requestId, {
      prompt: request.prompt, negative_prompt: request.negative_prompt, params: request.params, format: request.format,
      n: request.n, seconds: request.seconds, mapped_params: mappedParams,
    });
    const promptHash = await sha256Hex(request.prompt);
    const at = now();
    const attemptIds: string[] = [];

    db.exec('BEGIN IMMEDIATE');
    let outcome: MediaResult | undefined;
    try {
      if (options.idempotencyKey) {
        const existing = selectRequestByKey.get(subjectKey, options.idempotencyKey) as RequestRow | undefined;
        if (existing) {
          outcome = existing.request_hash === requestHash ? existingResponse(existing) : problem(409, 'idempotency_conflict');
        }
      }
      if (!outcome && (countActive.get(subjectKey) as { n: number }).n >= maxActive) outcome = problem(429, 'too_many_jobs');
      if (!outcome) {
        let budgetReason = '';
        const routed = routeOnce((usd) => {
          const check = checkMediaBudget(db, env, budgetCaller, usd);
          if (!check.ok) budgetReason = check.reason;
          return check.ok;
        });
        if (routed.selected.length === 0) {
          outcome = routed.skipped.some((s) => s.reason === 'budget')
            ? problem(429, 'budget_exceeded', { reason: budgetReason })
            : problem(422, 'no_route', { routing: { selected: [], skipped: callerSkipped(routed.skipped) } });
        } else {
          const paramProblem = paramsAllowed(routed.selected[0].model_id, request.params);
          const reserved = money(routed.selected.reduce((t, s) => t + s.reserved_usd, 0));
          if (paramProblem) outcome = problem(400, 'invalid_request', { detail: paramProblem });
          else if (request.expected_reserved_usd !== undefined && Math.round(request.expected_reserved_usd * 100) !== Math.round(reserved * 100)) {
            outcome = problem(409, 'price_changed', { reserved_usd: reserved });
          } else {
            insertRequest.run(requestId, subjectKey, caller.subject, caller.workspace ?? '', request.kind, request.profile ?? null, request.route,
              reserved, promptHash, requestHash, options.idempotencyKey ?? null, iso(at), iso(at));
            insertPayload.run(requestId, sealed.ciphertext, sealed.nonce, sealed.key_id, iso(at), iso(at.getTime() + PAYLOAD_MAX_AGE_MS));
            for (const pick of routed.selected) {
              const attemptId = randomId();
              attemptIds.push(attemptId);
              const pricing = registry.models[pick.model_id].pricing;
              insertAttempt.run(attemptId, requestId, subjectKey, pick.model_id, pick.provider_id, pick.provider_model,
                registry.providers[pick.provider_id].adapter, randomId(12), iso(at),
                pick.units, pick.unit_price_usd, pricing.cost_source, pricing.cancel_policy,
                request.kind === 'image' ? (request.n ?? 1) : 1, pick.reserved_usd, iso(at), iso(at));
            }
            outcome = {
              status: 202,
              body: { id: requestId, status: 'queued', attempts: attemptIds.length, poll_after_ms: 2_000, reserved_usd: reserved, routing: { selected: routed.selected.map((s) => s.model_id), skipped: callerSkipped(routed.skipped) } },
            };
          }
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (error instanceof Error && /UNIQUE constraint failed: media_requests\.subject_key, media_requests\.idempotency_key/.test(error.message) && options.idempotencyKey) {
        const existing = selectRequestByKey.get(subjectKey, options.idempotencyKey) as RequestRow | undefined;
        if (existing) return existing.request_hash === requestHash ? existingResponse(existing) : problem(409, 'idempotency_conflict');
      }
      throw error;
    }
    if (attemptIds.length) await dispatch(attemptIds);
    return outcome as MediaResult;
  }

  // ---------------------------------------------------------------- dispatch (rule 7)

  const selectAttempt = db.prepare('SELECT * FROM media_attempts WHERE id = ?');
  const markSent = db.prepare(`UPDATE media_attempts SET dispatch_state = 'sent', dispatch_tries = dispatch_tries + 1, next_dispatch_at = NULL, updated_at = ? WHERE id = ? AND dispatch_state = 'pending'`);
  const markRetry = db.prepare('UPDATE media_attempts SET dispatch_tries = dispatch_tries + 1, next_dispatch_at = ?, updated_at = ? WHERE id = ?');

  async function signed(attempt: Pick<AttemptRow, 'id' | 'dispatch_no'>, reason: QueueReason, refMacValue?: string): Promise<SignedQueueMessage> {
    const message = { v: 1 as const, attempt_id: attempt.id, dispatch_no: attempt.dispatch_no, reason, ...(refMacValue ? { ref_mac: refMacValue } : {}) };
    return { ...message, sig: await queueMessageSignature(deps.queueKey, message) };
  }

  async function dispatch(ids: string[]): Promise<void> {
    for (const id of ids) {
      const attempt = selectAttempt.get(id) as AttemptRow | undefined;
      if (!attempt || attempt.dispatch_state !== 'pending' || TERMINAL.has(attempt.status)) continue;
      const at = now();
      try {
        await deps.enqueue(await signed(attempt, 'start'));
        markSent.run(iso(at), id);
      } catch {
        const tries = attempt.dispatch_tries + 1;
        const delay = Math.min(DISPATCH_BACKOFF_START_MS * 2 ** (tries - 1), DISPATCH_BACKOFF_MAX_MS);
        markRetry.run(iso(at.getTime() + delay), iso(at), id);
      }
    }
  }

  // ---------------------------------------------------------------- settlement (rules 2, 3)

  const updateRequestTotals = db.prepare(`UPDATE media_requests SET
      settled_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM media_attempts WHERE request_id = ?),
      status = ?, updated_at = ? WHERE id = ?`);
  const selectRequest = db.prepare('SELECT * FROM media_requests WHERE id = ?');
  const selectAttemptsOfRequest = db.prepare('SELECT * FROM media_attempts WHERE request_id = ? ORDER BY attempt_no, created_at');

  function deriveStatus(attempts: AttemptRow[]): string {
    if (attempts.length === 0) return 'failed';
    const terminal = attempts.filter((a) => TERMINAL.has(a.status));
    const completed = attempts.filter((a) => a.status === 'completed' || a.status === 'expired');
    if (terminal.length === attempts.length) {
      if (completed.length) return 'completed';
      return attempts.every((a) => a.status === 'cancelled') ? 'cancelled' : 'failed';
    }
    if (completed.length) return 'partial';
    return attempts.every((a) => a.status === 'queued') ? 'queued' : 'running';
  }

  function refreshRequest(requestId: string): void {
    const attempts = selectAttemptsOfRequest.all(requestId) as unknown as AttemptRow[];
    updateRequestTotals.run(requestId, deriveStatus(attempts), iso(now()), requestId);
  }

  // lease_id is kept on terminal rows so a late report can still be matched to its lease (rule 3).
  const closeAttempt = db.prepare(`UPDATE media_attempts SET status = ?, error_code = ?, cost_usd = ?, overspend_usd = ?,
      lease_deadline = NULL, lease_started_at = NULL, latency_ms = ?, updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'expired')`);
  let savepointDepth = 0;

  /** Run fn atomically: a SAVEPOINT nests inside an open transaction and works outside one too. */
  function atomically<T>(fn: () => T): T {
    const name = `media_sp_${savepointDepth += 1}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      savepointDepth -= 1;
    }
  }
  const deleteSlot = db.prepare('DELETE FROM media_provider_slots WHERE attempt_id = ?');

  /** Move a non-terminal attempt to a terminal state and write its one ledger row. Returns false when it was already terminal. */
  function settle(attempt: AttemptRow, status: 'completed' | 'failed' | 'cancelled', errorCode: string | null, cost: number, overspend = 0): boolean {
    return atomically(() => settleInside(attempt, status, errorCode, cost, overspend));
  }

  function settleInside(attempt: AttemptRow, status: 'completed' | 'failed' | 'cancelled', errorCode: string | null, cost: number, overspend: number): boolean {
    const at = now();
    const latency = Math.max(0, at.getTime() - ms(attempt.created_at));
    const changed = closeAttempt.run(status, errorCode, money(cost), money(overspend), latency, iso(at), attempt.id);
    if (Number(changed.changes) !== 1) return false;
    deleteSlot.run(attempt.id);
    const request = selectRequest.get(attempt.request_id) as unknown as RequestRow;
    const bytes = (db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM media_assets WHERE attempt_id = ?').get(attempt.id) as { b: number }).b;
    // AC-16 ledger fields: counts and ids only, never prompt text or object keys.
    const metadata: AiTelemetryEvent['metadata'] = {
      subject: request.subject,
      kind: request.kind,
      mode: request.mode,
      profile: request.profile,
      media_route: request.route,
      prompt_sha256: request.prompt_sha256,
      model_id: attempt.model_id,
      provider_id: attempt.provider_id,
      n: request.kind === 'image' ? attempt.expected_outputs : null,
      seconds: request.kind === 'video' ? attempt.units : null,
      units: attempt.units,
      bytes,
      attempt_status: status,
      error_code: errorCode,
    };
    if (request.workspace_id) metadata.workspace_id = request.workspace_id;
    deps.record({
      run_id: `media-${attempt.id}`,
      route: `media.${request.kind}`,
      prompt_version: 'media-v1',
      provider: attempt.provider_id,
      model: attempt.model_id,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      token_budget: 0,
      latency_ms: latency,
      estimated_cost_usd: money(cost),
      cache_hit: false,
      status: status === 'completed' ? 'success' : 'error',
      metadata,
    });
    refreshRequest(attempt.request_id);
    return true;
  }

  function costIfClosedNow(attempt: AttemptRow): number {
    return attempt.submit_started_at ? attempt.reserved_usd : 0;
  }

  // ---------------------------------------------------------------- leases (rule 5, AC-08)

  const countSlots = db.prepare('SELECT COUNT(*) AS n FROM media_provider_slots WHERE provider_id = ? AND deadline > ?');
  const countInFlight = db.prepare(`SELECT COUNT(*) AS n FROM media_attempts WHERE provider_id = ? AND id != ? AND status IN ('leased', 'submit_started', 'submitted')`);
  const countCalls = db.prepare('SELECT COUNT(*) AS n FROM media_provider_calls WHERE provider_id = ? AND called_at > ?');
  const insertCall = db.prepare('INSERT INTO media_provider_calls (provider_id, called_at) VALUES (?, ?)');
  const pruneCalls = db.prepare('DELETE FROM media_provider_calls WHERE called_at < ?');
  const insertSlot = db.prepare('INSERT INTO media_provider_slots (provider_id, lease_id, attempt_id, deadline) VALUES (?, ?, ?, ?)');
  const updateSlotDeadline = db.prepare('UPDATE media_provider_slots SET deadline = ? WHERE attempt_id = ?');
  // lease_history keeps the last 8 lease ids so a late report from a recovered lease can be matched (rule 3).
  const grantLease = db.prepare(`UPDATE media_attempts SET status = ?, lease_id = ?, lease_deadline = ?, lease_started_at = ?, report_seq = 0,
      first_leased_at = COALESCE(first_leased_at, ?), lease_recoveries = ?, poll_count = ?, updated_at = ?, lease_history = ?
      WHERE id = ?`);
  const clearExpiredLease = db.prepare(`UPDATE media_attempts SET status = ?, lease_id = NULL, lease_deadline = NULL, lease_started_at = NULL,
      lease_recoveries = ?, updated_at = ? WHERE id = ? AND lease_id = ?`);
  const selectPayload = db.prepare('SELECT * FROM media_request_payloads WHERE request_id = ?');

  function leaseExpired(attempt: AttemptRow, at: Date): boolean {
    return attempt.lease_id !== null && ms(attempt.lease_deadline) <= at.getTime();
  }

  /**
   * Handle an expired lease on a row (from a lease call or housekeeping). Start leases count as
   * recoveries; poll leases on a submitted attempt do not. Returns the fresh row, or null when the
   * attempt was closed lease_exhausted.
   */
  function recoverExpired(attempt: AttemptRow, at: Date): AttemptRow | null {
    if (!leaseExpired(attempt, at)) return attempt;
    deleteSlot.run(attempt.id);
    const startLease = attempt.status === 'leased' || attempt.status === 'submit_started';
    const recoveries = attempt.lease_recoveries + (startLease ? 1 : 0);
    if (recoveries > MAX_LEASE_RECOVERIES) {
      settle(attempt, 'failed', 'lease_exhausted', costIfClosedNow(attempt));
      return null;
    }
    const nextStatus: AttemptStatus = attempt.status === 'leased' ? 'queued' : attempt.status;
    clearExpiredLease.run(nextStatus, recoveries, iso(at), attempt.id, attempt.lease_id);
    return selectAttempt.get(attempt.id) as unknown as AttemptRow;
  }

  async function lease(attemptId: string, raw: unknown): Promise<MediaResult> {
    if (!isObject(raw)) return fail(400, 'invalid_request');
    const message = { v: 1 as const, attempt_id: attemptId, dispatch_no: raw.dispatch_no, reason: raw.reason, ref_mac: raw.ref_mac, sig: raw.sig };
    if (!(await verifyQueueMessage(deps.queueKey, message as SignedQueueMessage))) return fail(403, 'bad_signature');
    const reason = message.reason as QueueReason;
    const at = now();
    let attempt = selectAttempt.get(attemptId) as AttemptRow | undefined;
    if (!attempt || !constantTimeEqual(attempt.dispatch_no, String(message.dispatch_no))) return fail(403, 'bad_signature');
    if (TERMINAL.has(attempt.status)) return fail(409, attempt.status === 'cancelled' ? 'cancelled' : 'terminal');

    // Everything below is synchronous: one transaction decides the lease.
    const payloadNeeded = reason === 'start' && (attempt.status === 'queued' || attempt.status === 'leased' || attempt.status === 'submit_started');
    // Kill switch: while media is off (or misconfigured) no new provider call may start; polls,
    // webhooks and cancels of jobs already at the provider continue. Nothing is granted, so the
    // worker retries later.
    if (reason === 'start' && problems().length) return problem(503, 'media_disabled');
    if (payloadNeeded && !deps.payloadKeys) return problem(503, 'media_disabled');
    // The model or provider was removed by a later registry deploy: refuse before granting, retry later.
    if (!registry.models[attempt.model_id] || !registry.providers[attempt.provider_id]) return problem(503, 'media_disabled', { detail: 'model is not in the current registry' });
    let refExpected: string | undefined;
    if (reason === 'webhook' && attempt.provider_job_ref) refExpected = await refMac(deps.queueKey, attempt.provider_job_ref);
    const objectPrefix = `${(selectRequest.get(attempt.request_id) as unknown as RequestRow).kind === 'image' ? 'images' : 'videos'}/${await subjectHash(subjectHashKey, attempt.subject_key)}/${at.toISOString().slice(0, 4)}/${at.toISOString().slice(5, 7)}/`;

    let grant: { leaseId: string; deadline: string } | undefined;
    let error: MediaResult | undefined;
    db.exec('BEGIN IMMEDIATE');
    try {
      attempt = selectAttempt.get(attemptId) as unknown as AttemptRow;
      if (TERMINAL.has(attempt.status)) error = fail(409, attempt.status === 'cancelled' ? 'cancelled' : 'terminal');
      if (!error) {
        const recovered = recoverExpired(attempt, at);
        if (!recovered) error = fail(409, 'lease_exhausted');
        else attempt = recovered;
      }
      if (!error && attempt.lease_id) error = fail(409, 'lease_held', { retry_after_ms: Math.max(1_000, ms(attempt.lease_deadline) - at.getTime()) });
      if (!error && attempt.cancel_requested_at && reason !== 'cancel') error = fail(409, 'cancelled');
      if (!error) {
        const provider = registry.providers[attempt.provider_id];
        const startKind = reason === 'start' && (attempt.status === 'queued' || attempt.status === 'submit_started');
        if (reason === 'start' && !startKind) error = fail(409, 'wrong_state');
        if ((reason === 'poll' || reason === 'webhook') && attempt.status !== 'submitted') error = fail(409, 'wrong_state');
        if (reason === 'webhook' && (!refExpected || !constantTimeEqual(refExpected, String(message.ref_mac ?? '')))) error = fail(409, 'ref_mismatch');
        if (reason === 'cancel' && !attempt.cancel_requested_at) error = fail(409, 'wrong_state');
        if (!error && startKind) {
          pruneCalls.run(iso(at.getTime() - 60_000));
          const slots = (countSlots.get(attempt.provider_id, iso(at)) as { n: number }).n;
          const inFlight = (countInFlight.get(attempt.provider_id, attempt.id) as { n: number }).n;
          const calls = (countCalls.get(attempt.provider_id, iso(at.getTime() - 60_000)) as { n: number }).n;
          if (slots >= provider.max_concurrent || inFlight >= provider.max_in_flight || calls >= provider.rpm) {
            error = fail(409, 'no_slot', { retry_after_ms: NO_SLOT_RETRY_MS });
          }
        }
        if (!error) {
          const leaseId = randomId();
          const deadline = iso(at.getTime() + LEASE_MS);
          const nextStatus: AttemptStatus = attempt.status === 'queued' ? 'leased' : attempt.status;
          const polls = attempt.poll_count + (reason === 'poll' || reason === 'webhook' ? 1 : 0);
          const history = [...(JSON.parse(attempt.lease_history || '[]') as string[]), leaseId].slice(-8);
          grantLease.run(nextStatus, leaseId, deadline, iso(at), iso(at), attempt.lease_recoveries, polls, iso(at), JSON.stringify(history), attempt.id);
          if (startKind) {
            insertSlot.run(attempt.provider_id, leaseId, attempt.id, deadline);
            insertCall.run(attempt.provider_id, iso(at));
          }
          grant = { leaseId, deadline };
        }
      }
      db.exec('COMMIT');
    } catch (caught) {
      db.exec('ROLLBACK');
      throw caught;
    }
    if (error || !grant) {
      if (error && (error.body as { error: string }).error !== 'lease_exhausted') refreshRequest(attempt.request_id);
      return error as MediaResult;
    }
    refreshRequest(attempt.request_id);

    const fresh = selectAttempt.get(attemptId) as unknown as AttemptRow;
    const model = registry.models[fresh.model_id];
    const request = selectRequest.get(fresh.request_id) as unknown as RequestRow;
    let payload: Record<string, unknown> | undefined;
    if (payloadNeeded) {
      const row = selectPayload.get(fresh.request_id) as { ciphertext: Uint8Array; nonce: string; key_id: string } | undefined;
      try {
        if (!row) throw new PayloadUnavailableError();
        payload = await openPayload(deps.payloadKeys as PayloadKeys, fresh.request_id, row) as Record<string, unknown>;
      } catch (caught) {
        if (!(caught instanceof PayloadUnavailableError)) throw caught;
        settle(fresh, 'failed', 'payload_unavailable', costIfClosedNow(fresh));
        return fail(409, 'payload_unavailable');
      }
    }
    const mappedByModel = (payload?.mapped_params ?? {}) as Record<string, Record<string, unknown>>;
    const jobPayload = payload ? { prompt: payload.prompt, negative_prompt: payload.negative_prompt, params: payload.params, format: payload.format, n: payload.n, seconds: payload.seconds } : undefined;
    return {
      status: 200,
      body: {
        lease_id: grant.leaseId,
        lease_deadline: grant.deadline,
        attempt: {
          state: fresh.status,
          model_id: fresh.model_id,
          provider_id: fresh.provider_id,
          provider_model: fresh.provider_model || model.provider_model,
          adapter: fresh.adapter || registry.providers[fresh.provider_id].adapter,
          ...(payload ? { mapped_params: mappedByModel[fresh.model_id] ?? {} } : {}),
          kind: request.kind,
          units: fresh.units,
          idempotency_key: fresh.id,
          object_key_prefix: objectPrefix,
          ...(fresh.provider_job_ref && reason !== 'start' ? { provider_job_ref: fresh.provider_job_ref } : {}),
        },
        ...(jobPayload ? { payload: jobPayload } : {}),
      },
    };
  }

  // ---------------------------------------------------------------- reports (rules 3–5)

  const setSubmitStarted = db.prepare(`UPDATE media_attempts SET status = 'submit_started', submit_started_at = COALESCE(submit_started_at, ?), report_seq = ?, updated_at = ? WHERE id = ?`);
  const setSubmitted = db.prepare(`UPDATE media_attempts SET status = 'submitted', provider_job_ref = COALESCE(provider_job_ref, ?), lease_id = NULL,
      lease_deadline = NULL, lease_started_at = NULL, report_seq = 0, updated_at = ? WHERE id = ?`);
  const setSeq = db.prepare('UPDATE media_attempts SET report_seq = ?, updated_at = ? WHERE id = ?');
  const addFlag = db.prepare(`UPDATE media_attempts SET flags = json_insert(flags, '$[#]', ?) WHERE id = ? AND NOT EXISTS (SELECT 1 FROM json_each(flags) WHERE value = ?)`);
  const insertAsset = db.prepare(`INSERT INTO media_assets (id, subject_key, attempt_id, role, state, object_key, media_type, bytes, width, height, seconds, sha256, created_at)
      VALUES (?, ?, ?, 'output', 'ready', ?, ?, ?, ?, ?, ?, ?, ?)`);

  function validAssets(raw: unknown, prefix: string, expected: number): Array<Record<string, unknown>> | string {
    if (!Array.isArray(raw) || raw.length !== expected) return `assets must list exactly ${expected} outputs`;
    if (new Set(raw.map((a) => (isObject(a) ? a.object_key : undefined))).size !== raw.length) return 'asset object keys must be distinct';
    for (const asset of raw) {
      if (!isObject(asset)) return 'asset must be an object';
      if (typeof asset.object_key !== 'string' || !asset.object_key.startsWith(prefix) || !/^[A-Za-z0-9/_.-]{1,256}$/.test(asset.object_key) || asset.object_key.includes('..')) return 'asset object_key is outside the leased prefix';
      if (typeof asset.media_type !== 'string' || !/^(image\/(png|jpeg|webp)|video\/mp4)$/.test(asset.media_type)) return 'asset media_type is invalid';
      if (!Number.isInteger(asset.bytes) || (asset.bytes as number) < 1) return 'asset bytes is invalid';
      if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) return 'asset sha256 is invalid';
    }
    return raw as Array<Record<string, unknown>>;
  }

  async function report(attemptId: string, raw: unknown): Promise<MediaResult> {
    if (!isObject(raw)) return fail(400, 'invalid_request');
    const { lease_id: leaseId, report_seq: seq, state } = raw;
    if (typeof leaseId !== 'string' || !Number.isInteger(seq) || (seq as number) < 1) return fail(400, 'invalid_request');
    const first = selectAttempt.get(attemptId) as AttemptRow | undefined;
    if (!first) return fail(404, 'not_found');
    // All async work happens before the transaction; the decision below re-reads the row and is synchronous.
    const kind = (selectRequest.get(first.request_id) as unknown as RequestRow).kind;
    const prefix = `${kind === 'image' ? 'images' : 'videos'}/${await subjectHash(subjectHashKey, first.subject_key)}/`;
    const at = now();

    db.exec('BEGIN IMMEDIATE');
    let result: MediaResult;
    let refreshId: string | undefined;
    try {
      result = decideReport(attemptId, raw, leaseId, seq as number, state, prefix, at);
      refreshId = first.request_id;
      db.exec('COMMIT');
    } catch (caught) {
      db.exec('ROLLBACK');
      throw caught;
    }
    if (refreshId) refreshRequest(refreshId);
    return result;
  }

  function insertAssets(attempt: AttemptRow, assets: Array<Record<string, unknown>>, at: Date): void {
    for (const asset of assets) {
      insertAsset.run(randomId(), attempt.subject_key, attempt.id, asset.object_key as string, asset.media_type as string, asset.bytes as number,
        Number.isInteger(asset.width) ? asset.width as number : null, Number.isInteger(asset.height) ? asset.height as number : null,
        typeof asset.seconds === 'number' ? asset.seconds : null, asset.sha256 as string, iso(at));
    }
  }

  function decideReport(attemptId: string, raw: Record<string, unknown>, leaseId: string, seq: number, state: unknown, prefix: string, at: Date): MediaResult {
    const attempt = selectAttempt.get(attemptId) as unknown as AttemptRow;
    const leaseMatches = attempt.lease_id !== null && constantTimeEqual(attempt.lease_id, leaseId);
    if (TERMINAL.has(attempt.status)) {
      // Rule 3: absorbing. A completed output from any lease this attempt ever held (lease_history
      // covers leases cleared by recovery), after it was closed timeout/submit_unknown, is kept and
      // linked; cost is never settled again.
      const history = JSON.parse(attempt.lease_history || '[]') as string[];
      if (leaseMatches || history.some((id) => constantTimeEqual(id, leaseId))) {
        addFlag.run('late_report', attempt.id, 'late_report');
        if (state === 'completed' && attempt.status === 'failed' && (attempt.error_code === 'timeout' || attempt.error_code === 'submit_unknown')) {
          const assets = validAssets(raw.assets, prefix, attempt.expected_outputs);
          const already = (db.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE attempt_id = ?').get(attempt.id) as { n: number }).n;
          if (typeof assets !== 'string' && already === 0) insertAssets(attempt, assets, at);
        }
      }
      return fail(409, 'terminal');
    }
    if (leaseMatches && !leaseExpired(attempt, at) && seq === attempt.report_seq && state === 'submit_started' && attempt.status === 'submit_started') {
      // The worker retried a report whose response was lost: already applied, answer as before.
      return { status: 200, body: { ok: true, replay: true } };
    }
    if (!leaseMatches || leaseExpired(attempt, at) || seq <= attempt.report_seq) return fail(409, 'stale_report');
    switch (state) {
      case 'submit_started':
        if (attempt.status !== 'leased') return fail(409, 'wrong_state');
        if (attempt.cancel_requested_at) return fail(409, 'cancelled');
        setSubmitStarted.run(iso(at), seq, iso(at), attempt.id);
        return { status: 200, body: { ok: true } };
      case 'submitted': {
        if (attempt.status !== 'submit_started' && attempt.status !== 'submitted') return fail(409, 'wrong_state');
        const ref = raw.provider_job_ref;
        if (typeof ref !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(ref)) return fail(400, 'invalid_request');
        if (attempt.provider_job_ref && attempt.provider_job_ref !== ref) return fail(409, 'ref_mismatch');
        setSubmitted.run(ref, iso(at), attempt.id);
        deleteSlot.run(attempt.id);
        return { status: 200, body: { ok: true } };
      }
      case 'completed': {
        if (attempt.status !== 'submit_started' && attempt.status !== 'submitted') return fail(409, 'wrong_state');
        const assets = validAssets(raw.assets, prefix, attempt.expected_outputs);
        if (typeof assets === 'string') return fail(400, 'invalid_request', { detail: assets });
        let cost = money(attempt.unit_price_usd * attempt.units);
        let overspend = 0;
        let costMissing = false;
        if (attempt.cost_source === 'provider') {
          const reported = raw.provider_cost_usd;
          if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
            cost = money(reported);
            overspend = Math.max(0, money(cost - attempt.reserved_usd));
          } else {
            // No usable provider cost: settle the whole (2x) reservation, never the lower registry price.
            cost = attempt.reserved_usd;
            costMissing = true;
          }
        }
        insertAssets(attempt, assets, at);
        setSeq.run(seq, iso(at), attempt.id);
        settleInside(attempt, 'completed', null, cost, overspend);
        if (overspend > 0) addFlag.run('overspend', attempt.id, 'overspend');
        if (costMissing) addFlag.run('provider_cost_missing', attempt.id, 'provider_cost_missing');
        return { status: 200, body: { ok: true } };
      }
      case 'failed': {
        const code = raw.error_code;
        if (typeof code !== 'string' || !ERROR_CODES.has(code)) return fail(400, 'invalid_request');
        if (code === 'submit_unknown') addFlag.run('submit_unknown', attempt.id, 'submit_unknown');
        if (raw.provider_charged !== undefined && raw.provider_charged !== false) return fail(400, 'invalid_request');
        // The worker saw the provider refuse the job (an HTTP rejection), so nothing was generated or billed.
        const notCharged = raw.provider_charged === false && code !== 'submit_unknown';
        settleInside(attempt, 'failed', code, notCharged ? 0 : costIfClosedNow(attempt), 0);
        return { status: 200, body: { ok: true } };
      }
      case 'cancelled': {
        if (!attempt.cancel_requested_at) return fail(409, 'wrong_state');
        settleInside(attempt, 'cancelled', 'cancelled', attempt.submit_started_at && attempt.cancel_policy === 'charged' ? attempt.reserved_usd : 0, 0);
        return { status: 200, body: { ok: true } };
      }
      default:
        return fail(400, 'invalid_request');
    }
  }

  const extendLease = db.prepare('UPDATE media_attempts SET lease_deadline = ?, updated_at = ? WHERE id = ? AND lease_id = ?');

  async function heartbeat(attemptId: string, raw: unknown): Promise<MediaResult> {
    if (!isObject(raw) || typeof raw.lease_id !== 'string') return fail(400, 'invalid_request');
    const at = now();
    const attempt = selectAttempt.get(attemptId) as AttemptRow | undefined;
    if (!attempt || TERMINAL.has(attempt.status) || !attempt.lease_id || !constantTimeEqual(attempt.lease_id, raw.lease_id) || leaseExpired(attempt, at)) {
      return fail(409, 'stale_lease');
    }
    const cap = ms(attempt.lease_started_at) + HEARTBEAT_MAX_MS;
    if (at.getTime() >= cap) return fail(409, 'lease_max_reached');
    const deadline = iso(Math.min(at.getTime() + LEASE_MS, cap));
    extendLease.run(deadline, iso(at), attempt.id, attempt.lease_id);
    updateSlotDeadline.run(deadline, attempt.id);
    return { status: 200, body: { lease_deadline: deadline } };
  }

  // ---------------------------------------------------------------- reads (AC-12)

  const selectAssets = db.prepare('SELECT * FROM media_assets WHERE attempt_id = ? ORDER BY created_at, id');

  async function read(caller: MediaCaller, requestId: string, signer: MediaSigner, kinds?: ReadonlyArray<MediaKind>): Promise<MediaResult> {
    const notFound = problem(404, 'not_found');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) return notFound;
    const request = selectRequest.get(requestId) as RequestRow | undefined;
    if (!request || !constantTimeEqual(request.subject_key, aiBudgetKey(caller))) return notFound;
    // The caller's token must carry the scope of this request's kind (same body as not found).
    if (kinds && !kinds.includes(request.kind)) return notFound;
    const at = now();
    const attempts = selectAttemptsOfRequest.all(requestId) as unknown as AttemptRow[];
    const view = [];
    for (const attempt of attempts) {
      const assets = [];
      for (const asset of selectAssets.all(attempt.id) as Array<Record<string, unknown>>) {
        const expired = at.getTime() - ms(String(asset.created_at)) > retentionDays * 86_400_000 || asset.state === 'expired';
        const base = {
          id: asset.id, media_type: asset.media_type, bytes: asset.bytes,
          ...(asset.width !== null ? { width: asset.width } : {}), ...(asset.height !== null ? { height: asset.height } : {}),
          ...(asset.seconds !== null ? { seconds: asset.seconds } : {}),
        };
        if (expired) assets.push({ ...base, state: 'expired' });
        else assets.push({ ...base, state: 'ready', ...(await signer.signGetUrl(String(asset.object_key))) });
      }
      view.push({
        id: attempt.id,
        model: attempt.model_id,
        provider: attempt.provider_id,
        status: attempt.status,
        ...(attempt.error_code ? { error: { code: attempt.error_code } } : {}),
        cost_usd: attempt.cost_usd ?? 0,
        reserved_usd: attempt.reserved_usd,
        assets,
      });
    }
    return {
      status: 200,
      body: {
        id: request.id,
        kind: request.kind,
        mode: request.mode,
        status: deriveStatus(attempts),
        created_at: request.created_at,
        reserved_usd: request.reserved_usd,
        settled_usd: request.settled_usd,
        attempts: view,
        ai_generated: true,
        output_trust: 'untrusted_model_output',
      },
    };
  }

  // ---------------------------------------------------------------- housekeeping (rules 5–7, 9)

  const selectOpen = db.prepare(`SELECT * FROM media_attempts WHERE status IN ('queued', 'leased', 'submit_started', 'submitted')`);
  const purgePayloads = db.prepare(`DELETE FROM media_request_payloads WHERE purge_after <= ? OR request_id IN (
      SELECT r.id FROM media_requests r WHERE r.updated_at <= ?
        AND NOT EXISTS (SELECT 1 FROM media_attempts a WHERE a.request_id = r.id AND a.status IN ('queued', 'leased', 'submit_started', 'submitted')))`);
  const freeIdempotency = db.prepare('UPDATE media_requests SET idempotency_key = NULL WHERE idempotency_key IS NOT NULL AND created_at <= ?');
  const reclaimSlots = db.prepare('DELETE FROM media_provider_slots WHERE deadline <= ?');
  const ROW_RETENTION_MS = 400 * 86_400_000;
  const pruneStatements = [
    `DELETE FROM media_votes WHERE request_id IN (SELECT id FROM media_requests WHERE created_at <= ?1)`,
    `DELETE FROM media_assets WHERE attempt_id IN (SELECT a.id FROM media_attempts a JOIN media_requests r ON r.id = a.request_id WHERE r.created_at <= ?1)`,
    `DELETE FROM media_assets WHERE attempt_id IS NULL AND created_at <= ?1`,
    `DELETE FROM media_request_payloads WHERE request_id IN (SELECT id FROM media_requests WHERE created_at <= ?1)`,
    `DELETE FROM media_attempts WHERE request_id IN (SELECT id FROM media_requests WHERE created_at <= ?1)
       AND status IN ('completed', 'failed', 'cancelled', 'expired')`,
    `DELETE FROM media_requests WHERE created_at <= ?1 AND NOT EXISTS (SELECT 1 FROM media_attempts a WHERE a.request_id = media_requests.id)`,
  ].map((sql) => db.prepare(sql));
  /** §4.4: request, attempt, vote and asset rows are kept 400 days (they hold no content). */
  function pruneOld(cutoff: string): void {
    atomically(() => { for (const statement of pruneStatements) statement.run(cutoff); });
  }
  let running = false;

  async function housekeeping(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const at = now();
      // Cleanup always runs; dispatching new provider work only while media is on (kill switch).
      const admissionOn = problems().length === 0;
      const ttl = Math.max(registry.policy.job_timeout_ms, registry.policy.lease_wait_max_ms) + TTL_MARGIN_MS;
      const due: string[] = [];
      for (const row of selectOpen.all() as unknown as AttemptRow[]) {
        let attempt: AttemptRow | null = row;
        const age = at.getTime() - ms(attempt.created_at);
        if (age >= ttl) {
          settle(attempt, 'failed', 'timeout', costIfClosedNow(attempt));
          continue;
        }
        if (attempt.dispatch_state === 'pending' && attempt.status === 'queued') {
          if (age >= DISPATCH_WINDOW_MS && !attempt.first_leased_at && !attempt.submit_started_at) {
            settle(attempt, 'failed', 'dispatch_error', 0);
            continue;
          }
          // After the window a leased or submit-started attempt follows the lease path, not re-sends (rule 7).
          if (age >= DISPATCH_WINDOW_MS && (attempt.first_leased_at || attempt.submit_started_at)) continue;
          if (ms(attempt.next_dispatch_at) <= at.getTime()) due.push(attempt.id);
          continue;
        }
        if (leaseExpired(attempt, at)) {
          db.exec('BEGIN IMMEDIATE');
          try {
            attempt = recoverExpired(selectAttempt.get(attempt.id) as unknown as AttemptRow, at);
            db.exec('COMMIT');
          } catch (caught) {
            db.exec('ROLLBACK');
            throw caught;
          }
          if (attempt) refreshRequest(attempt.request_id);
        }
      }
      reclaimSlots.run(iso(at));
      if (due.length && admissionOn) await dispatch(due);
      purgePayloads.run(iso(at), iso(at.getTime() - PAYLOAD_KEEP_AFTER_DONE_MS));
      freeIdempotency.run(iso(at.getTime() - IDEMPOTENCY_WINDOW_MS));
      pruneCalls.run(iso(at.getTime() - 60_000));
      pruneOld(iso(at.getTime() - ROW_RETENTION_MS));
    } finally {
      running = false;
    }
  }

  return { problems, create, lease, report, heartbeat, read, housekeeping };
}

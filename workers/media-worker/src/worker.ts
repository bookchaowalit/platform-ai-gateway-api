/**
 * SPEC-003 media-worker (Cloudflare Worker, option A).
 *
 *   POST /enqueue   bearer MEDIA_ENQUEUE_TOKEN; body = a signed queue message from the gateway
 *   GET  /healthz   503 while the DLQ has a backlog (house pattern)
 *   queue ai-media  lease → submit_started → provider → R2 → report (§3.3, §4.7)
 *
 * The worker holds provider credentials (Wrangler secrets) and the R2 bucket binding; the gateway
 * holds job state and money. Prompts arrive only in the lease response and stay in memory for one
 * invocation. Delays that must not count toward the DLQ (no slot, gateway down) are done by sending
 * a replacement message with delaySeconds and acking the original only after that send succeeded.
 */

import { constantTimeEqual, isQueueMessageShape, verifyQueueMessage, type SignedQueueMessage } from '../../../api/media/crypto.js';
import { createOpenAiImagesAdapter } from './openai.js';

export interface QueueLike {
  send(body: unknown, options?: { delaySeconds?: number }): Promise<void>;
  metrics?(): Promise<{ backlogCount: number }>;
}

export interface BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get?(key: string): Promise<{ text(): Promise<string> } | null>;
  delete?(key: string): Promise<void>;
}

/** A completed report that could not be delivered is kept here until a later lease delivers it. */
const pendingReportKey = (attemptId: string) => `pending-reports/${attemptId}.json`;

export interface WorkerEnv {
  MEDIA_QUEUE: QueueLike;
  MEDIA_DLQ?: QueueLike;
  MEDIA_BUCKET: BucketLike;
  GATEWAY_URL: string;
  MEDIA_WORKER_GATEWAY_TOKEN: string;
  MEDIA_ENQUEUE_TOKEN: string;
  MEDIA_QUEUE_KEY: string;
  OPENAI_API_KEY?: string;
}

export interface MessageLike<T> {
  id: string;
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatchLike<T> {
  messages: Array<MessageLike<T>>;
}

export type AdapterErrorCode = 'content_policy' | 'provider_error' | 'invalid_input' | 'invalid_response';

export class AdapterError extends Error {
  /** false when the provider refused the job (nothing generated or billed); undefined when unknown. */
  readonly charged: false | undefined;
  constructor(readonly code: AdapterErrorCode, charged?: boolean) {
    super(`media provider failed: ${code}`);
    this.charged = charged === false ? false : undefined;
  }
}

export interface AdapterJob {
  provider_model: string;
  mapped_params: Record<string, unknown>;
  kind: 'image' | 'video';
  units: number;
  idempotency_key: string;
  payload: { prompt: string; negative_prompt?: string; format?: string; n?: number; seconds?: number; params?: Record<string, unknown> };
}

export interface MediaAdapter {
  /** True when a re-submit with the same idempotency key cannot create a second paid job. */
  supportsIdempotency: boolean;
  submit(job: AdapterJob): Promise<{ kind: 'sync'; outputs: Array<{ bytes: Uint8Array }> }>;
}

export interface QueueDeps {
  fetch?: typeof fetch;
  adapters?: Record<string, MediaAdapter>;
}

interface LeaseResponse {
  lease_id: string;
  attempt: {
    state: string;
    adapter: string;
    provider_model: string;
    mapped_params?: Record<string, unknown>;
    kind: 'image' | 'video';
    units: number;
    idempotency_key: string;
    object_key_prefix: string;
  };
  payload?: AdapterJob['payload'];
}

const DROP_ERRORS = new Set(['terminal', 'cancelled', 'wrong_state', 'lease_exhausted', 'payload_unavailable', 'ref_mismatch', 'bad_signature']);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const HEARTBEAT_MS = 60_000;
const GATEWAY_TIMEOUT_MS = 15_000;
const GATEWAY_DOWN_DELAY_S = 30;
const REPORT_RETRIES = 3;
const REPORT_RETRY_MS = 1_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function bearer(request: Request): string {
  const header = request.headers.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

export async function handleFetch(request: Request, env: WorkerEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/healthz' && request.method === 'GET') {
    // Fail closed: an unreadable backlog is not reported as healthy.
    let backlog: number;
    try {
      if (!env.MEDIA_DLQ?.metrics) throw new Error('no dlq metrics');
      backlog = Number((await env.MEDIA_DLQ.metrics()).backlogCount);
      if (!Number.isFinite(backlog)) throw new Error('bad backlog');
    } catch {
      return json({ ok: false, dlq_backlog: null, reason: 'dlq_check_unavailable' }, 503);
    }
    return json({ ok: backlog === 0, dlq_backlog: backlog }, backlog > 0 ? 503 : 200);
  }
  if (pathname === '/enqueue' && request.method === 'POST') {
    const token = bearer(request);
    if (!env.MEDIA_ENQUEUE_TOKEN || !token || !constantTimeEqual(token, env.MEDIA_ENQUEUE_TOKEN)) return json({ error: 'unauthorized' }, 401);
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > 4_096) return json({ error: 'too_large' }, 413);
      body = JSON.parse(text);
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    if (!isQueueMessageShape(body) || !(await verifyQueueMessage(env.MEDIA_QUEUE_KEY, body))) return json({ error: 'invalid_message' }, 400);
    const message: SignedQueueMessage = {
      v: 1, attempt_id: body.attempt_id, dispatch_no: body.dispatch_no, reason: body.reason,
      ...(body.ref_mac ? { ref_mac: body.ref_mac } : {}), sig: body.sig,
    };
    await env.MEDIA_QUEUE.send(message);
    return json({ ok: true }, 202);
  }
  return json({ error: 'not_found' }, 404);
}

class GatewayDown extends Error {}

function gatewayClient(env: WorkerEnv, fetchImpl: typeof fetch) {
  const base = env.GATEWAY_URL.replace(/\/+$/, '');
  return async (attemptId: string, action: 'lease' | 'report' | 'heartbeat', body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/internal/media/attempts/${encodeURIComponent(attemptId)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.MEDIA_WORKER_GATEWAY_TOKEN}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
    } catch {
      throw new GatewayDown('gateway unreachable');
    }
    // 5xx, 408 and 429 are the gateway (or its limiter) being unavailable; 401/403 on a report/heartbeat
    // after a valid lease mean a token rotation in progress. All are retried later, never dropped.
    if (response.status >= 500 || response.status === 408 || response.status === 429
      || (action !== 'lease' && (response.status === 401 || response.status === 403))) {
      // Fixed line, no body or token: lets an operator see a persistent 401/403 (wrong token) in the logs.
      console.warn(JSON.stringify({ event: 'media.gateway_unavailable', action, status: response.status }));
      throw new GatewayDown(`gateway ${response.status}`);
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = await response.json() as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed };
  };
}

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  png: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
};
const CONTENT_TYPE: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultAdapters(env: WorkerEnv, fetchImpl: typeof fetch): Record<string, MediaAdapter> {
  const adapters: Record<string, MediaAdapter> = {};
  if (env.OPENAI_API_KEY) adapters['openai-images'] = createOpenAiImagesAdapter({ apiKey: env.OPENAI_API_KEY, fetchImpl });
  return adapters;
}

async function processMessage(message: SignedQueueMessage, env: WorkerEnv, deps: Required<QueueDeps>): Promise<'ack' | { delaySeconds: number }> {
  const call = gatewayClient(env, deps.fetch);
  let lease: { status: number; body: Record<string, unknown> };
  try {
    lease = await call(message.attempt_id, 'lease', { reason: message.reason, dispatch_no: message.dispatch_no, sig: message.sig, ...(message.ref_mac ? { ref_mac: message.ref_mac } : {}) });
  } catch (error) {
    if (error instanceof GatewayDown) return { delaySeconds: GATEWAY_DOWN_DELAY_S };
    throw error;
  }
  if (lease.status === 409 && (lease.body.error === 'no_slot' || lease.body.error === 'lease_held')) {
    const retryMs = Number(lease.body.retry_after_ms);
    return { delaySeconds: Math.min(Math.max(Math.ceil((Number.isFinite(retryMs) ? retryMs : 5_000) / 1000), 5), 300) };
  }
  if (lease.status !== 200) {
    // 403 (bad signature) and 409 terminal states: nothing to do for this message.
    if (lease.status === 403 || DROP_ERRORS.has(String(lease.body.error))) return 'ack';
    return { delaySeconds: GATEWAY_DOWN_DELAY_S };
  }

  const granted = lease.body as unknown as LeaseResponse;
  const attempt = granted.attempt;
  let seq = 0;
  // A report after a paid provider call must not be lost to a short gateway blip: retry the same
  // report_seq a few times (the gateway treats a repeat with the same seq as stale, never twice).
  const report = async (body: Record<string, unknown>) => {
    seq += 1;
    const payload = { lease_id: granted.lease_id, report_seq: seq, ...body };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call(message.attempt_id, 'report', payload);
      } catch (error) {
        if (!(error instanceof GatewayDown) || attempt >= REPORT_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, REPORT_RETRY_MS * (attempt + 1)));
      }
    }
  };

  if (message.reason !== 'start') return 'ack'; // poll / webhook / cancel paths are P2
  const adapter = deps.adapters[attempt.adapter];
  if (!adapter || !granted.payload) {
    await report({ state: 'failed', error_code: 'provider_error' });
    return 'ack';
  }
  if (attempt.state === 'submit_started') {
    // A completed report from an earlier invocation that never reached the gateway: deliver it now.
    const pending = await env.MEDIA_BUCKET.get?.(pendingReportKey(message.attempt_id));
    if (pending) {
      const saved = JSON.parse(await pending.text()) as { assets: unknown[] };
      const delivered = await report({ state: 'completed', assets: saved.assets });
      if (delivered.status === 200 || delivered.body.error === 'terminal') await env.MEDIA_BUCKET.delete?.(pendingReportKey(message.attempt_id));
      return 'ack';
    }
  }
  if (attempt.state === 'submit_started' && !adapter.supportsIdempotency) {
    // §4.7 rule 4: the previous worker may already have paid the provider; never submit twice.
    await report({ state: 'failed', error_code: 'submit_unknown' });
    return 'ack';
  }
  if (attempt.state === 'leased') {
    const started = await report({ state: 'submit_started' });
    if (started.status !== 200) return 'ack';
  }

  const heartbeat = setInterval(() => {
    call(message.attempt_id, 'heartbeat', { lease_id: granted.lease_id }).catch(() => undefined);
  }, HEARTBEAT_MS);
  try {
    let outputs: Array<{ bytes: Uint8Array }>;
    try {
      const result = await adapter.submit({
        provider_model: attempt.provider_model,
        mapped_params: attempt.mapped_params ?? {},
        kind: attempt.kind,
        units: attempt.units,
        idempotency_key: attempt.idempotency_key,
        payload: granted.payload,
      });
      outputs = result.outputs;
    } catch (error) {
      const notCharged = error instanceof AdapterError && error.charged === false;
      await report({ state: 'failed', error_code: error instanceof AdapterError ? error.code : 'provider_error', ...(notCharged ? { provider_charged: false } : {}) });
      return 'ack';
    }

    const format = String(granted.payload.format ?? 'png');
    const expected = attempt.kind === 'image' ? Number(granted.payload.n ?? 1) : 1;
    const check = MAGIC[format];
    if (attempt.kind !== 'image' || !check || outputs.length !== expected
      || outputs.some((o) => !(o.bytes instanceof Uint8Array) || o.bytes.length > MAX_IMAGE_BYTES || !check(o.bytes))) {
      await report({ state: 'failed', error_code: 'invalid_response' });
      return 'ack';
    }

    const assets = [];
    try {
      for (let i = 0; i < outputs.length; i += 1) {
        const bytes = outputs[i].bytes;
        const key = `${attempt.object_key_prefix}${message.attempt_id}-${i}.${format === 'jpeg' ? 'jpg' : format}`;
        await env.MEDIA_BUCKET.put(key, bytes, {
          httpMetadata: { contentType: CONTENT_TYPE[format] },
          customMetadata: { ai_generated: 'true', attempt_id: message.attempt_id },
        });
        assets.push({ object_key: key, media_type: CONTENT_TYPE[format], bytes: bytes.length, sha256: await sha256(bytes) });
      }
    } catch {
      // Storage failed after a paid generation: report it (the reservation settles), never re-run the call.
      await report({ state: 'failed', error_code: 'provider_error' });
      return 'ack';
    }
    try {
      await report({ state: 'completed', assets });
    } catch (error) {
      // Keep the result durable before handing the message back: the next lease delivers it (no re-run, no loss).
      if (error instanceof GatewayDown) {
        await env.MEDIA_BUCKET.put(pendingReportKey(message.attempt_id), JSON.stringify({ assets }), { httpMetadata: { contentType: 'application/json' } });
      }
      throw error;
    }
    return 'ack';
  } finally {
    clearInterval(heartbeat);
  }
}

export async function handleQueue(batch: MessageBatchLike<unknown>, env: WorkerEnv, deps: QueueDeps = {}): Promise<void> {
  const fetchImpl = deps.fetch ?? fetch;
  const resolved: Required<QueueDeps> = { fetch: fetchImpl, adapters: deps.adapters ?? defaultAdapters(env, fetchImpl) };
  for (const item of batch.messages) {
    const body = item.body;
    if (!isQueueMessageShape(body) || !(await verifyQueueMessage(env.MEDIA_QUEUE_KEY, body))) {
      item.ack(); // forged or malformed: never retried, never sent to the gateway
      continue;
    }
    try {
      let outcome: 'ack' | { delaySeconds: number };
      try {
        outcome = await processMessage(body, env, resolved);
      } catch (error) {
        // Gateway still down after the report retries: delayed replacement, never a DLQ-counted retry.
        if (!(error instanceof GatewayDown)) throw error;
        outcome = { delaySeconds: GATEWAY_DOWN_DELAY_S };
      }
      if (outcome === 'ack') {
        item.ack();
        continue;
      }
      try {
        await env.MEDIA_QUEUE.send(body, { delaySeconds: outcome.delaySeconds });
        item.ack();
      } catch {
        item.retry({ delaySeconds: outcome.delaySeconds });
      }
    } catch {
      item.retry();
    }
  }
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleFetch(request, env);
  },
  queue(batch: MessageBatchLike<unknown>, env: WorkerEnv): Promise<void> {
    return handleQueue(batch, env);
  },
};

// SPEC-003 P1a media-worker (Cloudflare Worker, option A): enqueue, queue consumer, OpenAI adapter. AC-09, §4.5, §4.7 rules 4/5/8.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queueMessageSignature, type SignedQueueMessage } from '../api/media/crypto.js';
import { createOpenAiImagesAdapter } from '../workers/media-worker/src/openai.js';
import { AdapterError, handleFetch, handleQueue, type MediaAdapter, type WorkerEnv } from '../workers/media-worker/src/worker.js';

const QUEUE_KEY = 'MARKER_queue_key_for_worker_tests_32b';
const ENQUEUE_TOKEN = 'MARKER_enqueue_token_value_1234567890';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PREFIX = 'images/0123456789abcdef0123456789abcdef/2026/11/';

interface Sent { body: unknown; delaySeconds?: number }

function env(overrides: Partial<WorkerEnv> = {}) {
  const sent: Sent[] = [];
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string; meta?: Record<string, string> }>();
  const base: WorkerEnv = {
    MEDIA_QUEUE: { send: async (body, options) => { sent.push({ body, delaySeconds: options?.delaySeconds }); } },
    MEDIA_DLQ: { send: async () => undefined, metrics: async () => ({ backlogCount: 0 }) },
    MEDIA_BUCKET: {
      put: async (key, value, options) => {
        objects.set(key, { bytes: typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer), contentType: options?.httpMetadata?.contentType, meta: options?.customMetadata });
        return {};
      },
    },
    GATEWAY_URL: 'https://gateway.example',
    MEDIA_WORKER_GATEWAY_TOKEN: 'MARKER_worker_gateway_token',
    MEDIA_ENQUEUE_TOKEN: ENQUEUE_TOKEN,
    MEDIA_QUEUE_KEY: QUEUE_KEY,
    OPENAI_API_KEY: 'MARKER_openai_key',
    ...overrides,
  };
  return { env: base, sent, objects };
}

async function signedMessage(reason: SignedQueueMessage['reason'] = 'start'): Promise<SignedQueueMessage> {
  const message = { v: 1 as const, attempt_id: 'att_1', dispatch_no: 'disp_1', reason };
  return { ...message, sig: await queueMessageSignature(QUEUE_KEY, message) };
}

function batch(messages: SignedQueueMessage[]) {
  const acked: number[] = [];
  const retried: number[] = [];
  return {
    acked,
    retried,
    value: {
      messages: messages.map((body, index) => ({
        id: String(index), body, attempts: 1,
        ack: () => { acked.push(index); },
        retry: () => { retried.push(index); },
      })),
    },
  };
}

type Route = (path: string, body: any) => { status: number; body: unknown };

function gateway(route: Route) {
  const calls: Array<{ path: string; body: any; auth: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, body, auth: new Headers(init?.headers).get('authorization') });
    const reply = route(url.pathname, body);
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const leaseBody = (state = 'leased') => ({
  lease_id: 'lease_1',
  lease_deadline: '2026-11-11T10:02:00.000Z',
  attempt: { state, model_id: 'openai-image', provider_id: 'openai', provider_model: 'model-x', adapter: 'fake', mapped_params: { size: '1024x1024' }, kind: 'image', units: 1, idempotency_key: 'att_1', object_key_prefix: PREFIX },
  payload: { prompt: 'a red square', format: 'png', n: 1, params: {} },
});

function fakeAdapter(result: () => Promise<Uint8Array[]>, idempotent = false): MediaAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    supportsIdempotency: idempotent,
    async submit() {
      adapter.calls += 1;
      return { kind: 'sync' as const, outputs: (await result()).map((bytes) => ({ bytes })) };
    },
  };
  return adapter;
}

// ---------------------------------------------------------------- /enqueue and /healthz

test('SPEC-003 worker /enqueue needs the enqueue token and a well-formed signed message', async () => {
  const { env: e, sent } = env();
  const message = await signedMessage();
  const post = (body: unknown, token?: string) => handleFetch(new Request('https://w/enqueue', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }), e);
  assert.equal((await post(message)).status, 401);
  assert.equal((await post(message, 'wrong')).status, 401);
  assert.equal((await post({ ...message, sig: 'x' }, ENQUEUE_TOKEN)).status, 400);
  assert.equal((await post({ ...message, reason: 'nope' }, ENQUEUE_TOKEN)).status, 400);
  assert.equal(sent.length, 0);
  assert.equal((await post(message, ENQUEUE_TOKEN)).status, 202);
  assert.deepEqual(sent, [{ body: message, delaySeconds: undefined }]);
});

test('SPEC-003 worker /healthz is 503 while the DLQ has a backlog', async () => {
  assert.equal((await handleFetch(new Request('https://w/healthz'), env().env)).status, 200);
  const backlog = env({ MEDIA_DLQ: { send: async () => undefined, metrics: async () => ({ backlogCount: 2 }) } }).env;
  assert.equal((await handleFetch(new Request('https://w/healthz'), backlog)).status, 503);
  assert.equal((await handleFetch(new Request('https://w/webhooks/openai/x/y/z', { method: 'POST' }), env().env)).status, 404, 'webhooks are P2');
});

// ---------------------------------------------------------------- queue consumer

test('SPEC-003 AC-09 sync start: lease → submit_started → provider → R2 → completed, then ack', async () => {
  const { env: e, objects } = env();
  let seq = 0;
  const gw = gateway((path, body) => {
    if (path.endsWith('/lease')) return { status: 200, body: leaseBody() };
    if (path.endsWith('/report')) { seq = body.report_seq; return { status: 200, body: { ok: true } }; }
    return { status: 200, body: { lease_deadline: 'later' } };
  });
  const adapter = fakeAdapter(async () => [PNG]);
  const b = batch([await signedMessage()]);
  await handleQueue(b.value, e, { fetch: gw.fetchImpl, adapters: { fake: adapter } });
  assert.deepEqual(b.acked, [0]);
  assert.deepEqual(b.retried, []);
  assert.equal(adapter.calls, 1);
  const reports = gw.calls.filter((c) => c.path.endsWith('/report')).map((c) => c.body);
  assert.deepEqual(reports.map((r) => r.state), ['submit_started', 'completed']);
  assert.deepEqual(reports.map((r) => r.report_seq), [1, 2]);
  assert.equal(seq, 2);
  const [stored] = [...objects.entries()];
  assert.ok(stored[0].startsWith(PREFIX) && stored[0].endsWith('.png'));
  assert.equal(stored[1].contentType, 'image/png');
  assert.equal(stored[1].meta?.ai_generated, 'true');
  const completed = reports[1];
  assert.equal(completed.assets[0].object_key, stored[0]);
  assert.equal(completed.assets[0].bytes, PNG.length);
  assert.match(completed.assets[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(gw.calls.every((c) => c.auth === 'Bearer MARKER_worker_gateway_token'));
  assert.doesNotMatch(JSON.stringify(gw.calls.filter((c) => !c.path.endsWith('/lease'))), /a red square/);
});

test('SPEC-003 §4.5 no_slot and gateway-down are re-sent with a delay and acked (never counted toward the DLQ)', async () => {
  for (const [status, body] of [[409, { error: 'no_slot', retry_after_ms: 5000 }], [503, { error: 'media_disabled' }], [502, {}]] as const) {
    const { env: e, sent } = env();
    const gw = gateway(() => ({ status, body }));
    const b = batch([await signedMessage()]);
    await handleQueue(b.value, e, { fetch: gw.fetchImpl, adapters: {} });
    assert.deepEqual(b.acked, [0], String(status));
    assert.deepEqual(b.retried, []);
    assert.equal(sent.length, 1);
    assert.ok((sent[0].delaySeconds ?? 0) >= 5);
  }
  // Network failure behaves like gateway-down.
  const { env: e, sent } = env();
  const b = batch([await signedMessage()]);
  await handleQueue(b.value, e, { fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch, adapters: {} });
  assert.deepEqual(b.acked, [0]);
  assert.equal(sent.length, 1);
});

test('SPEC-003 §4.5 if the delayed re-send fails the original is retried, not acked', async () => {
  const { env: e } = env({ MEDIA_QUEUE: { send: async () => { throw new Error('queue down'); } } });
  const gw = gateway(() => ({ status: 409, body: { error: 'no_slot', retry_after_ms: 5000 } }));
  const b = batch([await signedMessage()]);
  await handleQueue(b.value, e, { fetch: gw.fetchImpl, adapters: {} });
  assert.deepEqual(b.acked, []);
  assert.deepEqual(b.retried, [0]);
});

test('SPEC-003 terminal, cancelled and bad-signature leases are dropped without a provider call', async () => {
  for (const error of ['terminal', 'cancelled', 'wrong_state', 'lease_exhausted', 'payload_unavailable', 'ref_mismatch']) {
    const { env: e, sent } = env();
    const adapter = fakeAdapter(async () => [PNG]);
    const gw = gateway(() => ({ status: 409, body: { error } }));
    const b = batch([await signedMessage()]);
    await handleQueue(b.value, e, { fetch: gw.fetchImpl, adapters: { fake: adapter } });
    assert.deepEqual(b.acked, [0], error);
    assert.equal(sent.length, 0);
    assert.equal(adapter.calls, 0);
  }
  const { env: e } = env();
  const gw = gateway(() => ({ status: 200, body: leaseBody() }));
  const forged = { ...(await signedMessage()), sig: 'forged' };
  const b = batch([forged]);
  await handleQueue(b.value, e, { fetch: gw.fetchImpl, adapters: {} });
  assert.deepEqual(b.acked, [0]);
  assert.equal(gw.calls.length, 0, 'a forged message never reaches the gateway');
});

test('SPEC-003 §4.7 rule 4 re-lease in submit_started without provider idempotency reports submit_unknown', async () => {
  const { env: e } = env();
  const adapter = fakeAdapter(async () => [PNG], false);
  const gw = gateway((path) => path.endsWith('/lease') ? { status: 200, body: leaseBody('submit_started') } : { status: 200, body: { ok: true } });
  const b = batch([await signedMessage()]);
  await handleQueue(b.value, e, { fetch: gw.fetchImpl, adapters: { fake: adapter } });
  assert.equal(adapter.calls, 0);
  const reports = gw.calls.filter((c) => c.path.endsWith('/report')).map((c) => c.body);
  assert.deepEqual(reports.map((r) => [r.state, r.error_code]), [['failed', 'submit_unknown']]);
  assert.deepEqual(b.acked, [0]);
});

test('SPEC-003 AC-09 provider errors and bad outputs become failed reports with fixed codes', async () => {
  const cases: Array<[() => Promise<Uint8Array[]>, string]> = [
    [async () => { throw new AdapterError('content_policy'); }, 'content_policy'],
    [async () => { throw new AdapterError('provider_error'); }, 'provider_error'],
    [async () => { throw new Error('socket hang up MARKER_detail'); }, 'provider_error'],
    [async () => [Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])], 'invalid_response'],
    [async () => [PNG, PNG], 'invalid_response'],
  ];
  for (const [result, code] of cases) {
    const { env: e, objects } = env();
    const gw = gateway((path) => path.endsWith('/lease') ? { status: 200, body: leaseBody() } : { status: 200, body: { ok: true } });
    const b = batch([await signedMessage()]);
    await handleQueue(b.value, e, { fetch: gw.fetchImpl, adapters: { fake: fakeAdapter(result) } });
    const reports = gw.calls.filter((c) => c.path.endsWith('/report')).map((c) => c.body);
    assert.deepEqual(reports.map((r) => r.state), ['submit_started', 'failed'], code);
    assert.equal(reports[1].error_code, code);
    assert.doesNotMatch(JSON.stringify(reports), /MARKER_detail/);
    assert.equal(objects.size, 0, 'nothing partial is stored');
    assert.deepEqual(b.acked, [0]);
  }
});

test('SPEC-003 unknown adapter fails the attempt before any provider call (provider_error, settled 0)', async () => {
  const { env: e } = env();
  const gw = gateway((path) => path.endsWith('/lease') ? { status: 200, body: leaseBody() } : { status: 200, body: { ok: true } });
  const b = batch([await signedMessage()]);
  await handleQueue(b.value, e, { fetch: gw.fetchImpl, adapters: {} });
  const reports = gw.calls.filter((c) => c.path.endsWith('/report')).map((c) => c.body);
  assert.deepEqual(reports.map((r) => [r.state, r.error_code]), [['failed', 'provider_error']]);
});

// ---------------------------------------------------------------- OpenAI images adapter

test('SPEC-003 OpenAI images adapter maps the request and decodes b64 outputs', async () => {
  const calls: Array<{ url: string; body: any; auth: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString('base64'), revised_prompt: 'x' }] }), { status: 200 });
  }) as typeof fetch;
  const adapter = createOpenAiImagesAdapter({ apiKey: 'MARKER_openai_key', fetchImpl });
  const result = await adapter.submit({
    provider_model: 'model-x', mapped_params: { size: '1024x1024', quality: 'medium' }, kind: 'image', units: 1,
    payload: { prompt: 'a red square', negative_prompt: 'blur', format: 'png', n: 1, params: { background: 'opaque' } }, idempotency_key: 'att_1',
  });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(calls[0].auth, 'Bearer MARKER_openai_key');
  assert.deepEqual(calls[0].body, { model: 'model-x', prompt: 'a red square', n: 1, size: '1024x1024', quality: 'medium', output_format: 'png', background: 'opaque' });
  assert.equal(result.kind, 'sync');
  assert.deepEqual([...result.outputs[0].bytes], [...PNG]);
});

test('SPEC-003 OpenAI images adapter maps errors to fixed codes and never echoes the key or provider text', async () => {
  const cases: Array<[number, unknown, string]> = [
    [400, { error: { code: 'moderation_blocked', message: 'blocked MARKER_provider_text' } }, 'content_policy'],
    [400, { error: { code: 'content_policy_violation', message: 'x' } }, 'content_policy'],
    [400, { error: { code: 'invalid_value', message: 'size' } }, 'invalid_input'],
    [401, { error: { message: 'bad key MARKER_openai_key' } }, 'provider_error'],
    [429, { error: { message: 'slow down' } }, 'provider_error'],
    [500, 'oops', 'provider_error'],
    [200, { data: [] }, 'invalid_response'],
    [200, { data: [{ url: 'https://elsewhere' }] }, 'invalid_response'],
  ];
  for (const [status, body, code] of cases) {
    const adapter = createOpenAiImagesAdapter({
      apiKey: 'MARKER_openai_key',
      fetchImpl: (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch,
    });
    await assert.rejects(
      adapter.submit({ provider_model: 'm', mapped_params: {}, kind: 'image', units: 1, payload: { prompt: 'p', format: 'png', n: 1, params: {} }, idempotency_key: 'a' }),
      (error: unknown) => error instanceof AdapterError && error.code === code && !/MARKER/.test(String((error as Error).message)),
      `${status} ${code}`,
    );
  }
});

test('SPEC-003 a completed report survives a short gateway blip (same report_seq retried)', async () => {
  const { env: e } = env();
  let reportCalls = 0;
  const seqs: number[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/lease')) return new Response(JSON.stringify(leaseBody()), { status: 200 });
    const body = JSON.parse(String(init?.body));
    if (path.endsWith('/report')) {
      reportCalls += 1;
      seqs.push(body.report_seq);
      if (body.state === 'completed' && reportCalls === 2) return new Response('{}', { status: 502 });
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  const b = batch([await signedMessage()]);
  await handleQueue(b.value, e, { fetch: fetchImpl, adapters: { fake: fakeAdapter(async () => [PNG]) } });
  assert.deepEqual(seqs, [1, 2, 2]);
  assert.deepEqual(b.acked, [0]);
});

test('Codex: a gateway outage during the final report sends a delayed replacement instead of burning a retry', async () => {
  const { env: e, sent } = env();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/lease')) return new Response(JSON.stringify(leaseBody()), { status: 200 });
    const body = JSON.parse(String(init?.body));
    if (path.endsWith('/report') && body.state === 'completed') return new Response('{}', { status: 503 });
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  const b = batch([await signedMessage()]);
  await handleQueue(b.value, e, { fetch: fetchImpl, adapters: { fake: fakeAdapter(async () => [PNG]) } });
  assert.deepEqual(b.retried, []);
  assert.deepEqual(b.acked, [0]);
  assert.equal(sent.length, 1);
});

test('Codex: provider rejections are reported as not charged; unknown outcomes are not', async () => {
  for (const [error, charged] of [[new AdapterError('content_policy', false), false], [new AdapterError('provider_error', false), false], [new AdapterError('provider_error'), undefined], [new Error('x'), undefined]] as const) {
    const { env: e } = env();
    const gw = gateway((path) => path.endsWith('/lease') ? { status: 200, body: leaseBody() } : { status: 200, body: { ok: true } });
    const b = batch([await signedMessage()]);
    await handleQueue(b.value, e, { fetch: gw.fetchImpl, adapters: { fake: fakeAdapter(async () => { throw error; }) } });
    const failed = gw.calls.filter((c) => c.path.endsWith('/report')).map((c) => c.body).find((r) => r.state === 'failed');
    assert.equal(failed.provider_charged, charged === false ? false : undefined, String(error));
  }
});

test('Codex: /healthz fails closed when the DLQ backlog cannot be read', async () => {
  const noMetrics = env({ MEDIA_DLQ: { send: async () => undefined } }).env;
  assert.equal((await handleFetch(new Request('https://w/healthz'), noMetrics)).status, 503);
  const noDlq = env({ MEDIA_DLQ: undefined }).env;
  assert.equal((await handleFetch(new Request('https://w/healthz'), noDlq)).status, 503);
});

test('Codex: the OpenAI adapter marks HTTP rejections as not charged and network failures as unknown', async () => {
  const rejected = createOpenAiImagesAdapter({ apiKey: 'k', fetchImpl: (async () => new Response('{"error":{"code":"rate_limit"}}', { status: 429 })) as typeof fetch });
  await assert.rejects(rejected.submit({ provider_model: 'm', mapped_params: {}, kind: 'image', units: 1, payload: { prompt: 'p', format: 'png', n: 1, params: {} }, idempotency_key: 'a' }),
    (error: unknown) => error instanceof AdapterError && error.charged === false);
  const network = createOpenAiImagesAdapter({ apiKey: 'k', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  await assert.rejects(network.submit({ provider_model: 'm', mapped_params: {}, kind: 'image', units: 1, payload: { prompt: 'p', format: 'png', n: 1, params: {} }, idempotency_key: 'a' }),
    (error: unknown) => error instanceof AdapterError && error.charged === undefined);
});

import { mock } from 'node:test';

test('DoD N1 a final report refused with 429/401/403 is retried later, not dropped', async () => {
  for (const status of [429, 401, 403, 408]) {
    const { env: e, sent } = env();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/lease')) return new Response(JSON.stringify(leaseBody()), { status: 200 });
      const reportBody = JSON.parse(String(init?.body));
      if (path.endsWith('/report') && reportBody.state === 'completed') return new Response('{}', { status });
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    const b = batch([await signedMessage()]);
    await handleQueue(b.value, e, { fetch: fetchImpl, adapters: { fake: fakeAdapter(async () => [PNG]) } });
    assert.deepEqual(b.acked, [0], String(status));
    assert.equal(sent.length, 1, `${status}: delayed replacement`);
  }
});

test('DoD B2 an R2 put failure reports failed instead of retrying the paid call', async () => {
  const { env: e } = env({ MEDIA_BUCKET: { put: async () => { throw new Error('r2 down'); } } });
  const gw = gateway((path) => path.endsWith('/lease') ? { status: 200, body: leaseBody() } : { status: 200, body: { ok: true } });
  const b = batch([await signedMessage()]);
  await handleQueue(b.value, e, { fetch: gw.fetchImpl, adapters: { fake: fakeAdapter(async () => [PNG]) } });
  const reports = gw.calls.filter((c) => c.path.endsWith('/report')).map((c) => c.body);
  assert.deepEqual(reports.map((r) => [r.state, r.error_code]), [['submit_started', undefined], ['failed', 'provider_error']]);
  assert.deepEqual(b.retried, []);
});

test('DoD B2 the worker heartbeats every 60 s while the provider call runs', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    const { env: e } = env();
    const gw = gateway((path) => path.endsWith('/lease') ? { status: 200, body: leaseBody() } : { status: 200, body: { ok: true } });
    let finish: (value: Uint8Array[]) => void = () => undefined;
    const slow = fakeAdapter(() => new Promise<Uint8Array[]>((resolve) => { finish = resolve; }));
    const b = batch([await signedMessage()]);
    const running = handleQueue(b.value, e, { fetch: gw.fetchImpl, adapters: { fake: slow } });
    for (let i = 0; i < 200 && slow.calls === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(slow.calls, 1, 'the provider call is running');
    for (let i = 0; i < 3; i += 1) {
      mock.timers.tick(60_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    finish([PNG]);
    await running;
    assert.equal(gw.calls.filter((c) => c.path.endsWith('/heartbeat')).length, 3);
  } finally {
    mock.timers.reset();
  }
});

test('Codex: a completed report lost to an outage is kept in R2 and delivered on the next lease, not closed submit_unknown', async () => {
  const { env: e, sent, objects } = env();
  const bucket = e.MEDIA_BUCKET as unknown as { get?: (key: string) => Promise<unknown>; delete?: (key: string) => Promise<void> };
  bucket.get = async (key: string) => {
    const object = objects.get(key);
    return object ? { text: async () => new TextDecoder().decode(object.bytes) } : null;
  };
  bucket.delete = async (key: string) => { objects.delete(key); };
  let down = true;
  const reports: any[] = [];
  let leases = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/lease')) {
      leases += 1;
      return new Response(JSON.stringify(leases === 1 ? leaseBody() : { ...leaseBody('submit_started'), lease_id: 'lease_2' }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body));
    if (path.endsWith('/report')) {
      if (body.state === 'completed' && down) return new Response('{}', { status: 503 });
      reports.push(body);
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  const adapter = fakeAdapter(async () => [PNG]);
  const first = batch([await signedMessage()]);
  await handleQueue(first.value, e, { fetch: fetchImpl, adapters: { fake: adapter } });
  assert.equal(sent.length, 1, 'delayed replacement');
  assert.ok([...objects.keys()].some((k) => k.startsWith('pending-reports/')), 'pending report kept');
  down = false;
  const second = batch([sent[0].body as SignedQueueMessage]);
  await handleQueue(second.value, e, { fetch: fetchImpl, adapters: { fake: adapter } });
  assert.equal(adapter.calls, 1, 'the provider is not called again');
  const final = reports.at(-1);
  assert.equal(final.state, 'completed');
  assert.equal(final.lease_id, 'lease_2');
  assert.equal(final.assets.length, 1);
  assert.ok(![...objects.keys()].some((k) => k.startsWith('pending-reports/')), 'pending report removed once delivered');
});

function withPendingBucket(e: WorkerEnv, objects: Map<string, { bytes: Uint8Array }>) {
  const bucket = e.MEDIA_BUCKET as unknown as { get?: (key: string) => Promise<unknown>; delete?: (key: string) => Promise<void> };
  bucket.get = async (key: string) => {
    const object = objects.get(key);
    return object ? { text: async () => new TextDecoder().decode(object.bytes) } : null;
  };
  bucket.delete = async (key: string) => { objects.delete(key); };
}

test('Codex: a completed report refused as stale is kept and re-delivered on the next lease', async () => {
  const { env: e, sent, objects } = env();
  withPendingBucket(e, objects);
  let leases = 0;
  const reports: any[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/lease')) {
      leases += 1;
      return new Response(JSON.stringify(leases === 1 ? leaseBody() : { ...leaseBody('submit_started'), lease_id: 'lease_2' }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body));
    if (path.endsWith('/report')) {
      reports.push(body);
      if (body.state === 'completed' && body.lease_id === 'lease_1') return new Response('{"error":"stale_report"}', { status: 409 });
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  const adapter = fakeAdapter(async () => [PNG]);
  const first = batch([await signedMessage()]);
  await handleQueue(first.value, e, { fetch: fetchImpl, adapters: { fake: adapter } });
  assert.deepEqual(first.acked, [0]);
  assert.equal(sent.length, 1, 'handed back with a delay, not dropped');
  const second = batch([sent[0].body as SignedQueueMessage]);
  await handleQueue(second.value, e, { fetch: fetchImpl, adapters: { fake: adapter } });
  assert.equal(adapter.calls, 1);
  assert.deepEqual(reports.at(-1).lease_id, 'lease_2');
  assert.equal(reports.at(-1).state, 'completed');
  assert.ok(![...objects.keys()].some((k) => k.startsWith('pending-reports/')));
});

test('Codex: when the attempt was already closed (terminal), a pending report is sent as a late report with its original lease', async () => {
  const { env: e, objects } = env();
  withPendingBucket(e, objects);
  objects.set('pending-reports/att_1.json', { bytes: new TextEncoder().encode(JSON.stringify({ assets: [{ object_key: `${PREFIX}x.png` }], lease_id: 'lease_old', report_seq: 2 })) });
  const reports: any[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/lease')) return new Response('{"error":"terminal"}', { status: 409 });
    reports.push(JSON.parse(String(init?.body)));
    return new Response('{"error":"terminal"}', { status: 409 });
  }) as typeof fetch;
  const b = batch([await signedMessage()]);
  await handleQueue(b.value, e, { fetch: fetchImpl, adapters: {} });
  assert.deepEqual(b.acked, [0]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].lease_id, 'lease_old');
  assert.equal(reports[0].report_seq, 3);
  assert.equal(reports[0].state, 'completed');
  assert.ok(!objects.has('pending-reports/att_1.json'));
});

// SPEC-003 P1a HTTP surface: AC-01, AC-02, AC-12, AC-18 (catalog/status), AC-19. Real service, fake worker, no network.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createAiGatewayService } from '../api/ai-gateway-service/service.js';
import { loadTelemetryMigration, openTelemetryStore } from '../api/ai-gateway-service/store.js';
import type { SignedQueueMessage } from '../api/media/crypto.js';
import { MEDIA_GENERATION_REGISTRY_SCHEMA, type MediaGenerationRegistry } from '../api/media/registry.js';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const IMAGE_TOKEN = randomBytes(24).toString('base64url');
const GENERATE_TOKEN = randomBytes(24).toString('base64url');
const WORKER_TOKEN = randomBytes(24).toString('base64url');
const READER_TOKEN = randomBytes(24).toString('base64url');
const ENQUEUE_TOKEN = randomBytes(24).toString('base64url');
const PROMPT = 'a red square on white MARKER_HTTP_PROMPT';

const TOKENS_JSON = JSON.stringify([
  { subject: 'portfolio', token_hash: sha256(IMAGE_TOKEN), scopes: ['ai:image', 'api:read'] },
  { subject: 'ev3-web', token_hash: sha256(GENERATE_TOKEN), scopes: ['ai:generate'] },
  { subject: 'media-worker', token_hash: sha256(WORKER_TOKEN), scopes: ['ai:media-worker'] },
  { subject: 'ops-reader', token_hash: sha256(READER_TOKEN), scopes: ['api:read'] },
]);

function registry(): MediaGenerationRegistry {
  return {
    schema_version: MEDIA_GENERATION_REGISTRY_SCHEMA,
    updated_at: '2026-11-11',
    policy: { max_evaluation_age_days: 60, external_privacy_classes: ['public', 'internal'], fallback_depth: 0, lease_wait_max_ms: 1_800_000, job_timeout_ms: 1_800_000 },
    providers: {
      'vendor-a': { adapter: 'fake-sync', credential_env: 'VENDOR_A_KEY', max_concurrent: 2, max_in_flight: 4, rpm: 30, webhook: false, output_hosts: [], privacy_classes: ['public', 'internal'], terms_checked_at: '2026-11-11' },
    },
    models: {
      'a-photo': {
        provider: 'vendor-a', provider_model: 'photo-1', kind: 'image', enabled: true,
        capabilities: { aspects: ['1:1'], resolutions: ['standard'], references: 0, max_n: 4 },
        param_map: { aspect: { '1:1': { size: '1024x1024' } }, resolution: { standard: { quality: 'medium' } } },
        extra_params: {},
        pricing: { unit: 'image', cost_source: 'registry', cancel_policy: 'free', usd: { '1:1|standard': 0.04 }, source: 'https://vendor-a.example/pricing', checked_at: '2026-11-11' },
        own_eval: null,
      },
    },
    profiles: { 'social-photo': { kind: 'image', defaults: { aspect: '1:1', resolution: 'standard' }, models: ['a-photo'] } },
  };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
}

async function fakeWorker() {
  const messages: SignedQueueMessage[] = [];
  const auth: Array<string | undefined> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      auth.push(req.headers.authorization);
      if (req.url === '/enqueue' && req.method === 'POST') messages.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return { url: await listen(server), messages, auth, server };
}

function mediaEnv(workerUrl: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    API_TOKENS_JSON: TOKENS_JSON,
    LLM_LAB_MONTHLY_BUDGET_USD: '50',
    AI_GATEWAY_MEDIA_ENABLED: 'true',
    AI_GATEWAY_MEDIA_PROVIDERS: 'vendor-a',
    AI_GATEWAY_MEDIA_MONTHLY_BUDGET_USD: '5',
    AI_GATEWAY_MEDIA_PAYLOAD_KEYS_JSON: JSON.stringify({ current: 'k1', keys: { k1: Buffer.alloc(32, 9).toString('base64') } }),
    AI_GATEWAY_MEDIA_QUEUE_KEY: 'MARKER_queue_key_for_http_tests_only_32',
    AI_GATEWAY_MEDIA_SUBJECT_HASH_KEY: 'MARKER_subject_hash_key_http',
    AI_GATEWAY_MEDIA_WORKER_URL: workerUrl,
    AI_GATEWAY_MEDIA_WORKER_ENQUEUE_TOKEN: ENQUEUE_TOKEN,
    AI_GATEWAY_MEDIA_R2_ACCOUNT_ID: 'acct123',
    AI_GATEWAY_MEDIA_R2_BUCKET: 'ai-media',
    AI_GATEWAY_MEDIA_R2_ACCESS_KEY_ID: 'MARKER_r2_access',
    AI_GATEWAY_MEDIA_R2_SECRET_ACCESS_KEY: 'MARKER_r2_secret',
    ...extra,
  };
}

async function startGateway(env: NodeJS.ProcessEnv) {
  const store = openTelemetryStore(':memory:', loadTelemetryMigration({}));
  const service = createAiGatewayService({ env, store, log: () => undefined, mediaRegistry: registry(), mediaHousekeepingMs: 0 });
  const url = await listen(service.server);
  return { url, store, stop: async () => { await close(service.server); store.close(); } };
}

const call = (base: string, path: string, token: string | undefined, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const createBody = (extra: Record<string, unknown> = {}) => ({ kind: 'image', mode: 'single', profile: 'social-photo', prompt: PROMPT, route: 'portfolio.hero', privacy_class: 'internal', ...extra });

test('SPEC-003 AC-01 media routes are 503 until configured; existing routes are unchanged', async () => {
  const worker = await fakeWorker();
  const gateway = await startGateway({ API_TOKENS_JSON: TOKENS_JSON, LLM_LAB_MONTHLY_BUDGET_USD: '50' });
  try {
    const created = await call(gateway.url, '/api/ai/media/requests', IMAGE_TOKEN, { body: createBody() });
    assert.equal(created.status, 503);
    assert.equal((await created.json() as { error: string }).error, 'media_disabled');
    const status = await call(gateway.url, '/api/ai/status', READER_TOKEN);
    assert.equal(status.status, 200);
    const media = (await status.json() as { media: { capabilities: { image: boolean } } }).media;
    assert.equal(media.capabilities.image, false);
    assert.equal((await call(gateway.url, '/healthz', undefined)).status, 200);
    assert.equal(worker.messages.length, 0);
  } finally {
    await gateway.stop();
    await close(worker.server);
  }
});

test('SPEC-003 AC-02 scopes: ai:generate cannot use media; public tokens cannot reach worker routes; worker tokens cannot create', async () => {
  const worker = await fakeWorker();
  const gateway = await startGateway(mediaEnv(worker.url));
  try {
    assert.equal((await call(gateway.url, '/api/ai/media/requests', GENERATE_TOKEN, { body: createBody() })).status, 403);
    assert.equal((await call(gateway.url, '/api/ai/media/requests', WORKER_TOKEN, { body: createBody() })).status, 403);
    assert.equal((await call(gateway.url, '/api/ai/media/requests', IMAGE_TOKEN, { body: createBody({ kind: 'video' }) })).status, 403);
    assert.equal((await call(gateway.url, '/api/ai/media/requests', undefined, { body: createBody() })).status, 401);
    assert.equal((await call(gateway.url, '/internal/media/attempts/abc12345/lease', IMAGE_TOKEN, { body: {} })).status, 403);
    assert.equal((await call(gateway.url, '/internal/media/attempts/abc12345/lease', GENERATE_TOKEN, { body: {} })).status, 403);
    assert.equal(worker.messages.length, 0);
  } finally {
    await gateway.stop();
    await close(worker.server);
  }
});

test('SPEC-003 P1a end to end over HTTP: create → enqueue → lease → report → signed read', async () => {
  const worker = await fakeWorker();
  const gateway = await startGateway(mediaEnv(worker.url));
  try {
    const created = await call(gateway.url, '/api/ai/media/requests', IMAGE_TOKEN, { body: createBody(), headers: { 'idempotency-key': 'hero-1' } });
    assert.equal(created.status, 202);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const { id } = await created.json() as { id: string };
    assert.equal(worker.messages.length, 1);
    assert.equal(worker.auth[0], `Bearer ${ENQUEUE_TOKEN}`);
    assert.doesNotMatch(JSON.stringify(worker.messages), /MARKER_HTTP_PROMPT/);

    const again = await call(gateway.url, '/api/ai/media/requests', IMAGE_TOKEN, { body: createBody(), headers: { 'idempotency-key': 'hero-1' } });
    assert.equal((await again.json() as { id: string }).id, id);

    const message = worker.messages[0];
    const leaseResponse = await call(gateway.url, `/internal/media/attempts/${message.attempt_id}/lease`, WORKER_TOKEN, { body: { reason: message.reason, dispatch_no: message.dispatch_no, sig: message.sig } });
    assert.equal(leaseResponse.status, 200);
    const lease = await leaseResponse.json() as { lease_id: string; payload: { prompt: string }; attempt: { object_key_prefix: string } };
    assert.equal(lease.payload.prompt, PROMPT);
    const report = (body: unknown) => call(gateway.url, `/internal/media/attempts/${message.attempt_id}/report`, WORKER_TOKEN, { body });
    assert.equal((await report({ lease_id: lease.lease_id, report_seq: 1, state: 'submit_started' })).status, 200);
    assert.equal((await call(gateway.url, `/internal/media/attempts/${message.attempt_id}/heartbeat`, WORKER_TOKEN, { body: { lease_id: lease.lease_id } })).status, 200);
    assert.equal((await report({
      lease_id: lease.lease_id, report_seq: 2, state: 'completed',
      assets: [{ object_key: `${lease.attempt.object_key_prefix}a.png`, media_type: 'image/png', bytes: 100, width: 1024, height: 1024, sha256: 'b'.repeat(64) }],
    })).status, 200);

    const read = await call(gateway.url, `/api/ai/media/requests/${id}`, IMAGE_TOKEN);
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('cache-control'), 'no-store');
    const view = await read.json() as { status: string; attempts: Array<{ assets: Array<{ url: string }> }> };
    assert.equal(view.status, 'completed');
    const url = new URL(view.attempts[0].assets[0].url);
    assert.equal(url.host, 'acct123.r2.cloudflarestorage.com');
    assert.ok(url.searchParams.get('X-Amz-Signature'));
    assert.doesNotMatch(JSON.stringify(view), /MARKER_r2_secret|MARKER_HTTP_PROMPT/);

    assert.equal((await call(gateway.url, `/api/ai/media/requests/${id}`, READER_TOKEN)).status, 403, 'api:read alone cannot read media requests');
  } finally {
    await gateway.stop();
    await close(worker.server);
  }
});

test('SPEC-003 AC-18 status and models catalog (P1a)', async () => {
  const worker = await fakeWorker();
  const gateway = await startGateway(mediaEnv(worker.url));
  try {
    const status = await (await call(gateway.url, '/api/ai/status', IMAGE_TOKEN)).json() as { media: { capabilities: Record<string, boolean>; problems: string[]; limits: Record<string, unknown> } };
    assert.deepEqual(status.media.capabilities, { image: true, video: false, compare: false, references: false });
    assert.deepEqual(status.media.problems, []);
    assert.equal(status.media.limits.url_ttl_s, 900);
    const readerStatus = await (await call(gateway.url, '/api/ai/status', READER_TOKEN)).json() as { media: { capabilities: Record<string, boolean> } };
    assert.equal(readerStatus.media.capabilities.image, false, 'capability is per token');

    const models = await call(gateway.url, '/api/ai/media/models', READER_TOKEN);
    assert.equal(models.status, 200);
    const catalog = await models.json() as { models: Array<Record<string, unknown>> };
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0].id, 'a-photo');
    assert.equal(catalog.models[0].available, true);
    assert.deepEqual(catalog.models[0].unit_prices_usd, { '1:1|standard': 0.04 });
    assert.doesNotMatch(JSON.stringify(catalog), /VENDOR_A_KEY|credential/);
  } finally {
    await gateway.stop();
    await close(worker.server);
  }
});

test('SPEC-003 AC-19 media create has its own rate limit bucket', async () => {
  const worker = await fakeWorker();
  const gateway = await startGateway(mediaEnv(worker.url, { AI_GATEWAY_MEDIA_IMAGE_RPM: '1' }));
  try {
    assert.equal((await call(gateway.url, '/api/ai/media/requests', IMAGE_TOKEN, { body: createBody() })).status, 202);
    const limited = await call(gateway.url, '/api/ai/media/requests', IMAGE_TOKEN, { body: createBody() });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
    // Reads use a separate bucket.
    const models = await call(gateway.url, '/api/ai/media/models', IMAGE_TOKEN);
    assert.equal(models.status, 200);
  } finally {
    await gateway.stop();
    await close(worker.server);
  }
});

test('SPEC-003 a failing worker enqueue still answers 202 and leaves the attempt pending for housekeeping', async () => {
  const gateway = await startGateway(mediaEnv('http://127.0.0.1:9'));
  try {
    const created = await call(gateway.url, '/api/ai/media/requests', IMAGE_TOKEN, { body: createBody() });
    assert.equal(created.status, 202);
    const row = gateway.store.db.prepare('SELECT dispatch_state FROM media_attempts').get() as { dispatch_state: string };
    assert.equal(row.dispatch_state, 'pending');
  } finally {
    await gateway.stop();
  }
});

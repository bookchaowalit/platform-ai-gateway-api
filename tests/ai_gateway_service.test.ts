import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  createAiGatewayService,
  serviceConfigurationProblems,
  type ServiceLogLine,
} from '../api/ai-gateway-service/service.js';
import { loadTelemetryMigration, openTelemetryStore, type TelemetryStore } from '../api/ai-gateway-service/store.js';

// Synthetic values generated per run; they only exist inside this test.
const UPSTREAM_KEY = `test-upstream-${randomBytes(12).toString('hex')}`;
const GENERATE_TOKEN = randomBytes(24).toString('base64url');
const READ_TOKEN = randomBytes(24).toString('base64url');
const BOTH_TOKEN = randomBytes(24).toString('base64url');
const PROMPT_MARKER = 'PRIVATE-PROMPT-MARKER-7731';
const OUTPUT_MARKER = 'PRIVATE-OUTPUT-MARKER-4412';

// Response.json() is typed as unknown; tests assert on the parsed shape.
const asAny = (value: unknown): any => value;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const TOKENS_JSON = JSON.stringify([
  { subject: 'ev3-web', token_hash: sha256(GENERATE_TOKEN), scopes: ['ai:generate'] },
  { subject: 'ops-reader', token_hash: sha256(READ_TOKEN), scopes: ['api:read'] },
  { subject: 'ev3-full', token_hash: sha256(BOTH_TOKEN), scopes: ['ai:generate', 'api:read'] },
]);

type UpstreamCall = { body: any; authorization: string | undefined };
type UpstreamHandler = (body: any, res: ServerResponse) => void | Promise<void>;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function okCompletion(model: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-synthetic',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: `${OUTPUT_MARKER} ตอบแล้ว` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
    ...overrides,
  };
}

async function startUpstream(handler: UpstreamHandler): Promise<{ url: string; calls: UpstreamCall[]; server: Server }> {
  const calls: UpstreamCall[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push({ body, authorization: req.headers.authorization });
      await handler(body, res);
    });
  });
  const url = await listen(server);
  return { url, calls, server };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function gatewayEnv(upstreamUrl: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    AI_GATEWAY_PROVIDER: 'openai-compatible',
    AI_GATEWAY_PROVIDER_NAME: 'openai',
    AI_GATEWAY_BASE_URL: `${upstreamUrl}/v1`,
    AI_GATEWAY_API_KEY: UPSTREAM_KEY,
    AI_GATEWAY_MODEL: 'gpt-6-luna',
    AI_GATEWAY_INPUT_USD_PER_1K: '0.001',
    AI_GATEWAY_OUTPUT_USD_PER_1K: '0.004',
    AI_GATEWAY_MONTHLY_BUDGET_USD: '5',
    AI_GATEWAY_TOKEN_PARAM: 'max_completion_tokens',
    AI_GATEWAY_SEND_TEMPERATURE: 'false',
    API_TOKENS_JSON: TOKENS_JSON,
    ...overrides,
  };
}

type Harness = {
  url: string;
  logs: ServiceLogLine[];
  store: TelemetryStore;
  stop: () => Promise<void>;
};

async function startGateway(env: NodeJS.ProcessEnv, dbPath = ':memory:'): Promise<Harness> {
  const store = openTelemetryStore(dbPath, loadTelemetryMigration({}));
  const logs: ServiceLogLine[] = [];
  const service = createAiGatewayService({ env, store, log: (line) => logs.push(line) });
  const url = await listen(service.server);
  return {
    url,
    logs,
    store,
    stop: async () => {
      await close(service.server);
      store.close();
    },
  };
}

const baseRequest = {
  route: 'ev3-chat',
  prompt_version: 'ev3-chat-v1',
  profile: 'fast',
  privacy_class: 'internal',
  token_budget: 2048,
  max_output_tokens: 128,
  messages: [{ role: 'user', content: `${PROMPT_MARKER} แนะนำสถานีชาร์จใกล้ฉัน` }],
};

function post(url: string, token: string | null, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/api/ai/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function telemetryRows(store: TelemetryStore): Array<Record<string, any>> {
  return store.db.prepare('SELECT * FROM ai_run_telemetry ORDER BY id').all() as Array<Record<string, any>>;
}

test('service refuses legacy full-access and unauthenticated modes at startup', () => {
  const upstream = 'http://127.0.0.1:9';
  assert.match(serviceConfigurationProblems(gatewayEnv(upstream, { API_TOKEN: 'legacy-value' })).join(';'), /API_TOKEN/);
  assert.match(serviceConfigurationProblems(gatewayEnv(upstream, { ALLOW_UNAUTH_DEV: 'true' })).join(';'), /ALLOW_UNAUTH_DEV/);
  assert.match(serviceConfigurationProblems(gatewayEnv(upstream, { API_TOKENS_JSON: '' })).join(';'), /at least one/);
  assert.match(
    serviceConfigurationProblems(gatewayEnv(upstream, { API_TOKENS_JSON: JSON.stringify([{ subject: 'x', token: 'raw', scopes: ['ai:generate'] }]) })).join(';'),
    /token_hash, not a raw token/,
  );
  const store = openTelemetryStore(':memory:', loadTelemetryMigration({}));
  try {
    assert.throws(
      () => createAiGatewayService({ env: gatewayEnv(upstream, { API_TOKEN: 'legacy-value' }), store, log: () => undefined }),
      (error: unknown) => error instanceof Error && /API_TOKEN/.test(error.message) && !error.message.includes('legacy-value'),
    );
  } finally {
    store.close();
  }
});

test('healthz is unauthenticated and exposes no configuration', async () => {
  const upstream = await startUpstream((_body, res) => json(res, 200, okCompletion('gpt-6-luna')));
  const gateway = await startGateway(gatewayEnv(upstream.url));
  try {
    const response = await fetch(`${gateway.url}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json().then(asAny), { status: 'ok' });
    assert.equal(response.headers.get('access-control-allow-origin'), null);

    const notFound = await fetch(`${gateway.url}/api/finance/v1/accounts`);
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json().then(asAny)).code, 'not_found');
  } finally {
    await gateway.stop();
    await close(upstream.server);
  }
});

test('status and generate enforce scoped tokens and never expose the provider key', async () => {
  const upstream = await startUpstream((_body, res) => json(res, 200, okCompletion('gpt-6-luna')));
  const gateway = await startGateway(gatewayEnv(upstream.url));
  try {
    const missing = await fetch(`${gateway.url}/api/ai/status`);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer');

    const invalid = await fetch(`${gateway.url}/api/ai/status`, { headers: { Authorization: 'Bearer not-a-real-token' } });
    assert.equal(invalid.status, 401);

    const wrongScope = await fetch(`${gateway.url}/api/ai/status`, { headers: { Authorization: `Bearer ${GENERATE_TOKEN}` } });
    assert.equal(wrongScope.status, 403);

    const status = await fetch(`${gateway.url}/api/ai/status`, { headers: { Authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(status.status, 200);
    const text = await status.text();
    assert.ok(!text.includes(UPSTREAM_KEY));
    const body = JSON.parse(text);
    assert.equal(body.configured, true);
    assert.equal(body.models.fast, 'gpt-6-luna');
    assert.equal(body.request_options.token_param, 'max_completion_tokens');
    assert.equal(body.request_options.send_temperature, false);
    assert.equal(body.request_options.error_cost_policy, 'bounded');
    assert.equal(body.rate_limit.max_requests_per_minute, 120);
    assert.equal(body.rate_limit.max_concurrent_requests, 8);
    assert.equal(body.budget.decision, 'allow');
    assert.equal(body.service.contract, 'solo-empire.ai-gateway-service.v1');

    const readOnlyGenerate = await post(gateway.url, READ_TOKEN, baseRequest);
    assert.equal(readOnlyGenerate.status, 403);
    const anonymousGenerate = await post(gateway.url, null, baseRequest);
    assert.equal(anonymousGenerate.status, 401);
    const legacyStyle = await post(gateway.url, 'legacy-value', baseRequest);
    assert.equal(legacyStyle.status, 401);
    assert.equal(upstream.calls.length, 0);
  } finally {
    await gateway.stop();
    await close(upstream.server);
  }
});

test('generate forwards new-model payload options and persists content-free telemetry', async () => {
  const upstream = await startUpstream((_body, res) => json(res, 200, okCompletion('gpt-6-luna', {
    choices: [{ index: 0, message: { role: 'assistant', content: `{"intent":"find_station","note":"${OUTPUT_MARKER}"}` }, finish_reason: 'stop' }],
  })));
  const gateway = await startGateway(gatewayEnv(upstream.url));
  try {
    const response = await post(gateway.url, BOTH_TOKEN, {
      ...baseRequest,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Classify the user intent. Reply with JSON only.' },
        ...baseRequest.messages,
      ],
    });
    assert.equal(response.status, 200);
    const body = await response.json().then(asAny);
    assert.equal(body.contract, 'solo-empire.ai-gateway.v1');
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.fallback_used, false);
    assert.equal(body.output_trust, 'untrusted_model_output');
    assert.equal(JSON.parse(body.content).intent, 'find_station');

    assert.equal(upstream.calls.length, 1);
    const sent = upstream.calls[0].body;
    assert.equal(upstream.calls[0].authorization, `Bearer ${UPSTREAM_KEY}`);
    assert.equal(sent.max_completion_tokens, 128);
    assert.equal(sent.max_tokens, undefined);
    assert.equal(sent.temperature, undefined);
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    assert.match(sent.messages[0].content, /ภาษาไทย/);

    const rows = telemetryRows(gateway.store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'success');
    assert.equal(rows[0].model, 'gpt-6-luna');
    const metadata = JSON.parse(rows[0].metadata_json);
    assert.equal(metadata.subject, 'ev3-full');
    assert.equal(metadata.response_format, 'json_object');
    const persisted = JSON.stringify(rows);
    assert.ok(!persisted.includes(PROMPT_MARKER));
    assert.ok(!persisted.includes(OUTPUT_MARKER));

    const runLogs = gateway.logs.filter((line) => line.event === 'ai_gateway.run');
    assert.equal(runLogs.length, 1);
    assert.equal(runLogs[0].http_status, 200);
    assert.equal(runLogs[0].subject, 'ev3-full');
    assert.equal(runLogs[0].model, 'gpt-6-luna');
    const logged = JSON.stringify(gateway.logs);
    assert.ok(!logged.includes(PROMPT_MARKER) && !logged.includes(OUTPUT_MARKER) && !logged.includes(UPSTREAM_KEY));
    assert.ok(!logged.includes(GENERATE_TOKEN) && !logged.includes(BOTH_TOKEN));
  } finally {
    await gateway.stop();
    await close(upstream.server);
  }
});

test('fallback model answers once after a primary 5xx and records which model answered', async () => {
  const upstream = await startUpstream((body, res) => {
    if (body.model === 'gpt-6-luna') return json(res, 503, { error: { message: `overloaded ${UPSTREAM_KEY}` } });
    return json(res, 200, okCompletion(body.model));
  });
  const gateway = await startGateway(gatewayEnv(upstream.url, { AI_GATEWAY_FALLBACK_MODEL: 'gpt-5-mini' }));
  try {
    const response = await post(gateway.url, GENERATE_TOKEN, baseRequest);
    assert.equal(response.status, 200);
    const body = await response.json().then(asAny);
    assert.equal(body.model, 'gpt-5-mini');
    assert.equal(body.fallback_used, true);
    assert.deepEqual(upstream.calls.map((call) => call.body.model), ['gpt-6-luna', 'gpt-5-mini']);

    const rows = telemetryRows(gateway.store);
    assert.equal(rows.length, 2);
    const primary = rows.find((row) => JSON.parse(row.metadata_json).attempt === 'primary')!;
    const final = rows.find((row) => row.run_id === body.run_id)!;
    assert.equal(primary.model, 'gpt-6-luna');
    assert.equal(primary.status, 'error');
    // Bounded policy: an HTTP rejection generated nothing, so zero spend.
    assert.equal(primary.estimated_cost_usd, 0);
    assert.equal(JSON.parse(primary.metadata_json).parent_run_id, body.run_id);
    assert.equal(final.model, 'gpt-5-mini');
    assert.equal(JSON.parse(final.metadata_json).primary_error_class, 'provider_rejected');
    const runLog = gateway.logs.find((line) => line.event === 'ai_gateway.run')!;
    assert.equal(runLog.fallback_used, true);
    assert.equal(runLog.model, 'gpt-5-mini');
  } finally {
    await gateway.stop();
    await close(upstream.server);
  }
});

test('fallback covers a primary timeout and is used at most once', async () => {
  const upstream = await startUpstream((body, res) => {
    if (body.model === 'gpt-6-luna') return; // hang until the gateway aborts
    return json(res, 429, { error: { message: 'slow down' } });
  });
  const gateway = await startGateway(gatewayEnv(upstream.url, { AI_GATEWAY_FALLBACK_MODEL: 'gpt-5-mini', AI_GATEWAY_TIMEOUT_MS: '1000' }));
  try {
    const response = await post(gateway.url, GENERATE_TOKEN, baseRequest);
    assert.equal(response.status, 429);
    const body = await response.json().then(asAny);
    assert.equal(body.code, 'provider_rate_limited');
    assert.equal(body.error, 'AI provider rate_limited');
    assert.equal(upstream.calls.length, 2);
    const rows = telemetryRows(gateway.store);
    const primary = rows.find((row) => JSON.parse(row.metadata_json).attempt === 'primary')!;
    assert.equal(JSON.parse(primary.metadata_json).error_class, 'timeout');
    // A timeout may have been billed: bounded policy records the reserved estimate.
    assert.ok(primary.estimated_cost_usd > 0);
  } finally {
    await gateway.stop();
    await close(upstream.server);
  }
});

test('provider errors return bounded JSON without provider bodies or keys', async () => {
  const upstream = await startUpstream((_body, res) => json(res, 401, `{"error":"bad key ${UPSTREAM_KEY} provider-secret-body"}`));
  const gateway = await startGateway(gatewayEnv(upstream.url));
  try {
    const response = await post(gateway.url, GENERATE_TOKEN, baseRequest);
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.ok(!text.includes(UPSTREAM_KEY) && !text.includes('provider-secret-body'));
    assert.deepEqual(JSON.parse(text), { contract: 'solo-empire.ai-gateway.v1', error: 'AI provider provider_auth', code: 'provider_auth' });

    const badJson = await post(gateway.url, GENERATE_TOKEN, '{not json');
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json().then(asAny)).code, 'invalid_json');

    const invalid = await post(gateway.url, GENERATE_TOKEN, { ...baseRequest, response_format: { type: 'json_schema' } });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json().then(asAny)).code, 'invalid_request');

    const privateData = await post(gateway.url, GENERATE_TOKEN, { ...baseRequest, privacy_class: 'private' });
    assert.equal(privateData.status, 403);

    const wrongType = await post(gateway.url, GENERATE_TOKEN, JSON.stringify(baseRequest), { 'Content-Type': 'text/plain' });
    assert.equal(wrongType.status, 415);
    const logged = JSON.stringify(gateway.logs);
    assert.ok(!logged.includes(UPSTREAM_KEY) && !logged.includes('provider-secret-body') && !logged.includes(PROMPT_MARKER));
  } finally {
    await gateway.stop();
    await close(upstream.server);
  }
});

test('request body size is limited before parsing', async () => {
  const upstream = await startUpstream((_body, res) => json(res, 200, okCompletion('gpt-6-luna')));
  const gateway = await startGateway(gatewayEnv(upstream.url, { AI_GATEWAY_MAX_BODY_BYTES: '2048' }));
  try {
    const response = await post(gateway.url, GENERATE_TOKEN, { ...baseRequest, messages: [{ role: 'user', content: 'x'.repeat(5_000) }] });
    assert.equal(response.status, 413);
    assert.equal((await response.json().then(asAny)).code, 'body_too_large');
    assert.equal(upstream.calls.length, 0);
  } finally {
    await gateway.stop();
    await close(upstream.server);
  }
});

test('rate limits are env-configurable per subject and return Retry-After', async () => {
  const upstream = await startUpstream((_body, res) => json(res, 200, okCompletion('gpt-6-luna')));
  const gateway = await startGateway(gatewayEnv(upstream.url, {
    AI_GATEWAY_SUBJECT_LIMITS_JSON: JSON.stringify({ 'ev3-web': { max_requests_per_minute: 2, max_concurrent_requests: 1 } }),
  }));
  try {
    assert.equal((await post(gateway.url, GENERATE_TOKEN, baseRequest)).status, 200);
    assert.equal((await post(gateway.url, GENERATE_TOKEN, baseRequest)).status, 200);
    const limited = await post(gateway.url, GENERATE_TOKEN, baseRequest);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await limited.json().then(asAny)).code, 'rate_limited');
    // Another subject keeps the service-wide default (120/min).
    assert.equal((await post(gateway.url, BOTH_TOKEN, baseRequest)).status, 200);
    assert.equal(upstream.calls.length, 3);
  } finally {
    await gateway.stop();
    await close(upstream.server);
  }
});

test('generation fails closed without a monthly budget unless explicitly waived', async () => {
  const upstream = await startUpstream((_body, res) => json(res, 200, okCompletion('gpt-6-luna')));
  const gateway = await startGateway(gatewayEnv(upstream.url, { AI_GATEWAY_MONTHLY_BUDGET_USD: undefined }));
  try {
    const response = await post(gateway.url, GENERATE_TOKEN, baseRequest);
    assert.equal(response.status, 503);
    assert.equal((await response.json().then(asAny)).code, 'budget_not_configured');
    assert.equal(upstream.calls.length, 0);
  } finally {
    await gateway.stop();
    await close(upstream.server);
  }
});

test('monthly budget spend persists across a service restart on the same volume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-gateway-service-'));
  const dbPath = join(dir, 'nested', 'ai-gateway.sqlite');
  const upstream = await startUpstream((body, res) => json(res, 200, okCompletion(body.model, {
    usage: { prompt_tokens: 9_500, completion_tokens: 400, total_tokens: 9_900 },
  })));
  const env = gatewayEnv(upstream.url, {
    AI_GATEWAY_MONTHLY_BUDGET_USD: '1',
    AI_GATEWAY_INPUT_USD_PER_1K: '0.1',
    AI_GATEWAY_OUTPUT_USD_PER_1K: '0.1',
  });
  try {
    const first = await startGateway(env, dbPath);
    const firstResponse = await post(first.url, GENERATE_TOKEN, baseRequest);
    assert.equal(firstResponse.status, 200);
    assert.equal((await firstResponse.json().then(asAny)).estimated_cost_usd, 0.99);
    await first.stop();

    const second = await startGateway(env, dbPath);
    try {
      const status = await (await fetch(`${second.url}/api/ai/status`, { headers: { Authorization: `Bearer ${READ_TOKEN}` } })).json().then(asAny);
      assert.equal(status.budget.spent_usd, 0.99);
      const denied = await post(second.url, GENERATE_TOKEN, baseRequest);
      assert.equal(denied.status, 429);
      assert.equal((await denied.json().then(asAny)).code, 'monthly_budget_exceeded');
      assert.equal(upstream.calls.length, 1);
      const statuses = telemetryRows(second.store).map((row) => row.status);
      assert.deepEqual(statuses, ['budget_exceeded', 'budget_exceeded']);
    } finally {
      await second.stop();
    }
  } finally {
    await close(upstream.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('telemetry migration is idempotent and matches the shared schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-gateway-store-'));
  try {
    const path = join(dir, 'ai-gateway.sqlite');
    openTelemetryStore(path, loadTelemetryMigration({})).close();
    const store = openTelemetryStore(path, loadTelemetryMigration({}));
    try {
      const indexes = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ai_run_telemetry'").all() as Array<{ name: string }>)
        .map((row) => row.name);
      assert.ok(indexes.includes('idx_ai_run_telemetry_created'));
      assert.equal(store.ping(), true);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('token_budget ceiling is env-configurable and real usage overruns still return content', async () => {
  const upstream = await startUpstream((body, res) => json(res, 200, okCompletion(body.model, {
    // Thai text often uses more real tokens than the chars/4 admission estimate.
    usage: { prompt_tokens: 15_000, completion_tokens: 900, total_tokens: 15_900 },
  })));
  const defaults = await startGateway(gatewayEnv(upstream.url));
  const raised = await startGateway(gatewayEnv(upstream.url, { AI_GATEWAY_MAX_TOKEN_BUDGET: '16000' }));
  try {
    const rejected = await post(defaults.url, GENERATE_TOKEN, { ...baseRequest, token_budget: 16_000 });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json().then(asAny)).error, /between 256 and 4096/);

    const status = await (await fetch(`${raised.url}/api/ai/status`, { headers: { Authorization: `Bearer ${READ_TOKEN}` } })).json().then(asAny);
    assert.equal(status.limits.max_token_budget, 16_000);
    assert.equal(status.limits.default_token_budget, 4_096);

    const accepted = await post(raised.url, GENERATE_TOKEN, { ...baseRequest, token_budget: 16_000 });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json().then(asAny)).status, 'success');

    // Provider-reported usage above the request budget is not an error: the
    // answer is returned with status budget_exceeded and its cost is recorded.
    const overrun = await post(raised.url, GENERATE_TOKEN, { ...baseRequest, token_budget: 4_096 });
    assert.equal(overrun.status, 200);
    const body = await overrun.json().then(asAny);
    assert.equal(body.status, 'budget_exceeded');
    assert.ok(body.content.length > 0);
    assert.ok(body.estimated_cost_usd > 0);

    const tooLarge = await post(raised.url, GENERATE_TOKEN, { ...baseRequest, token_budget: 16_001 });
    assert.equal(tooLarge.status, 400);
  } finally {
    await defaults.stop();
    await raised.stop();
    await close(upstream.server);
  }
});

test('client system prompt plus alternating history keeps a valid chat order', async () => {
  const upstream = await startUpstream((body, res) => json(res, 200, okCompletion(body.model)));
  const gateway = await startGateway(gatewayEnv(upstream.url));
  try {
    const response = await post(gateway.url, GENERATE_TOKEN, {
      ...baseRequest,
      messages: [
        { role: 'system', content: 'You are the EV3 assistant.' },
        { role: 'user', content: 'สวัสดี' },
        { role: 'assistant', content: 'สวัสดีครับ' },
        { role: 'user', content: 'สถานีชาร์จใกล้สุดอยู่ไหน' },
      ],
    });
    assert.equal(response.status, 200);
    const sent = upstream.calls[0].body.messages;
    assert.deepEqual(sent.map((message: any) => message.role), ['system', 'user', 'assistant', 'user']);
    assert.match(sent[0].content, /^You are the EV3 assistant\.\n\n/);
    assert.match(sent[0].content, /ภาษาไทย/);
    assert.equal(sent.at(-1).content, 'สถานีชาร์จใกล้สุดอยู่ไหน');
  } finally {
    await gateway.stop();
    await close(upstream.server);
  }
});

function postMediaRoute(url: string, token: string | null, body: unknown) {
  return fetch(`${url}/api/media/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('media route endpoint returns a metadata-only decision and enforces scope', async () => {
  const gateway = await startGateway(gatewayEnv('http://127.0.0.1:9', { SPEECHMATICS_API_KEY: 'synthetic-speechmatics' }));
  try {
    const body = { file_name: 'CuteERP Weekly Meeting-20260701-Meeting Recording.mp4', folder_path: '/Recordings', hints: { language: 'th' } };
    assert.equal((await postMediaRoute(gateway.url, null, body)).status, 401);
    assert.equal((await postMediaRoute(gateway.url, READ_TOKEN, body)).status, 403);

    const response = await postMediaRoute(gateway.url, GENERATE_TOKEN, body);
    assert.equal(response.status, 200);
    const decision = asAny(await response.json());
    assert.equal(decision.contract, 'solo-empire.media-route-decision.v1');
    assert.equal(decision.content_kind.value, 'meeting');
    assert.equal(decision.stt.provider_id, 'speechmatics-enhanced');
    assert.equal(decision.stt.options.diarization, true);
    assert.equal(JSON.stringify(decision).includes('synthetic-speechmatics'), false);
    assert.equal(JSON.stringify(gateway.logs).includes('synthetic-speechmatics'), false);

    const invalid = await postMediaRoute(gateway.url, GENERATE_TOKEN, { file_name: 'a.mp4', mime_type: 'application/pdf' });
    assert.equal(invalid.status, 400);
    assert.equal(asAny(await invalid.json()).code, 'unsupported_media_type');
  } finally {
    await gateway.stop();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createAiGatewayService } from '../api/ai-gateway-service/service.js';
import { loadTelemetryMigration, openTelemetryStore } from '../api/ai-gateway-service/store.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://identity.example.test';
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const actor = randomUUID();
const systemWorkspace = randomUUID();
async function token(ws: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: actor, ws, iss: issuer, aud: 'platform-api', scope: 'ai:generate api:read', iat: now, exp: now + 300, jti: randomUUID(), ...overrides })
    .setProtectedHeader({ alg: 'RS256' }).sign(keys.privateKey);
}
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
const body = { route: 'shared-test', prompt_version: 'v1', messages: [{ role: 'user', content: 'hello' }], max_output_tokens: 128 };

// Stateful loopback HTTP contract fixture. Capacity is keyed by verified caller
// workspace and policy; all gateway clients hit this same authority.
async function fixture() {
  const reservations = new Map<string, any>();
  const consumed = new Map<string, number>();
  const limits = new Map<string, number>();
  const operations: any[] = [];
  let mode = 'ok';
  let providerMode = 'ok';
  let providerCalls = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/readyz') { res.writeHead(mode === 'outage' ? 503 : 200); res.end('{}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.url === '/v1/chat/completions') {
      providerCalls++;
      if (providerMode === 'failure') { res.writeHead(500); res.end('{}'); return; }
      if (providerMode === 'fallback' && input.model === 'primary') { res.writeHead(500); res.end('{}'); return; }
      res.end(JSON.stringify({ model: input.model, choices: [{ message: { content: 'ok' } }], ...(providerMode === 'unknown' ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) }));
      return;
    }
    const caller = String(req.headers['x-workspace-authorization'] || '').slice(7);
    const claims = JSON.parse(Buffer.from(caller.split('.')[1] || '', 'base64url').toString());
    assert.equal(req.headers.authorization, `Bearer ${serviceToken}`);
    operations.push({ path: req.url, body: input, ws: claims.ws });
    if (mode === 'oversized') { res.end(JSON.stringify({ data: 'x'.repeat(20000) })); return; }
    if (mode === 'redirect') { res.writeHead(307, { Location: '/v1/chat/completions' }); res.end(); return; }
    if (mode === 'slow') return;
    if (mode === 'conflict') { res.writeHead(409); res.end('{}'); return; }
    if (mode === 'malformed') { res.end(JSON.stringify({ id: '../path', status: 'reserved' })); return; }
    if (mode === 'outage') { res.writeHead(503); res.end('{}'); return; }
    if (req.url === '/v1/service/admissions') {
      const tenant = `${claims.ws}:${input.policy}`;
      const global = `global:${input.global_policy}`;
      const units = input.units;
      if ([tenant, global].some(key => (consumed.get(key) || 0) + units > (limits.get(key) ?? 1e9))) { res.writeHead(429); res.end('{}'); return; }
      for (const key of [tenant, global]) consumed.set(key, (consumed.get(key) || 0) + units);
      const id = randomUUID();
      reservations.set(id, { tenant, global, units, actual: null });
      if (mode === 'ambiguous') { res.destroy(); return; }
      res.end(JSON.stringify({ id, status: 'reserved', units, expires_at: new Date(Date.now() + 120000).toISOString(), available: 100 }));
    } else {
      const id = req.url!.split('/')[4];
      const reservation = reservations.get(id);
      assert.ok(reservation);
      assert.ok(reservation.tenant.startsWith(`${claims.ws}:`));
      const actual = req.url!.endsWith('/release') ? 0 : input.actual_units;
      if (mode === 'settlement-outage' || (mode === 'budget-settlement-outage' && reservation.tenant.endsWith(':usd'))) { res.writeHead(503); res.end('{}'); return; }
      for (const key of [reservation.tenant, reservation.global]) consumed.set(key, consumed.get(key)! - reservation.units + actual);
      reservation.actual = actual;
      res.end(JSON.stringify({ id, status: 'settled', units: reservation.units, expires_at: new Date(Date.now()+120000).toISOString(), available: 100 }));
    }
  });
  const serviceToken = await token(systemWorkspace, { scope: 'quotas:service' });
  const url = await listen(server);
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test', AI_GATEWAY_ADMISSION_MODE: 'shared', AI_GATEWAY_AUTH_PROFILE: 'workspace-jwt',
    AI_GATEWAY_JWT_PUBLIC_KEY_PEM: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), AI_GATEWAY_JWT_ISSUER: issuer,
    AI_GATEWAY_SHARED_DATA_URL: url, AI_GATEWAY_SHARED_SERVICE_TOKEN: serviceToken,
    AI_GATEWAY_SHARED_RATE_POLICY: 'rate', AI_GATEWAY_SHARED_GLOBAL_RATE_POLICY: 'all-rate',
    AI_GATEWAY_SHARED_BUDGET_POLICY: 'usd', AI_GATEWAY_SHARED_GLOBAL_BUDGET_POLICY: 'all-usd',
    AI_GATEWAY_PROVIDER: 'openai-compatible', AI_GATEWAY_BASE_URL: `${url}/v1`, AI_GATEWAY_API_KEY: 'synthetic-test-only',
    AI_GATEWAY_MODEL: 'primary', AI_GATEWAY_INPUT_USD_PER_1K: '0.001', AI_GATEWAY_OUTPUT_USD_PER_1K: '0.002',
    AI_GATEWAY_MONTHLY_BUDGET_USD: '5',
  };
  const gateways: { server: Server; store: ReturnType<typeof openTelemetryStore> }[] = [];
  async function gateway(overrides: NodeJS.ProcessEnv = {}) {
    const store = openTelemetryStore(':memory:', loadTelemetryMigration({}));
    const service = createAiGatewayService({ env: { ...env, ...overrides }, store, log: () => {} });
    gateways.push({ server: service.server, store });
    return listen(service.server);
  }
  return { env, gateway, operations, reservations, consumed, limits, url,
    providerCalls: () => providerCalls,
    mode: (value: string) => { mode = value; }, providerMode: (value: string) => { providerMode = value; },
    async stop() { for (const g of gateways) { await close(g.server); g.store.close(); } await close(server); },
  };
}
async function post(url: string, caller: string, input = body, headers = {}) {
  return fetch(`${url}/api/ai/generate`, { method: 'POST', headers: { Authorization: `Bearer ${caller}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
}

test('two gateway instances share rate capacity and workspace budgets over HTTP', async () => {
  const f = await fixture();
  try {
    const urls = await Promise.all([f.gateway(), f.gateway()]);
    f.limits.set(`global:all-rate`, 2);
    const caller = await token(workspaceA);
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => post(urls[i % 2], caller)));
    assert.equal(responses.filter(r => r.status === 200).length, 2);
    assert.equal(responses.filter(r => r.status === 429).length, 4);
    assert.equal(f.providerCalls(), 2);
    assert.equal(f.consumed.get(`global:all-rate`), 2);
    assert.equal(f.consumed.get(`${workspaceA}:usd`), 40); // actual 20 microUSD * 2
    f.limits.set('global:all-rate', 100);
    f.limits.set(`${workspaceA}:usd`, 40);
    assert.equal((await post(urls[0], caller)).status, 429);
    assert.equal((await post(urls[1], await token(workspaceB))).status, 200);
    assert.equal(f.providerCalls(), 3);
  } finally { await f.stop(); }
});

test('shared outage and ambiguous reservation deny without any provider call or release', async () => {
  for (const mode of ['outage', 'ambiguous']) {
    const f = await fixture();
    try {
      const url = await f.gateway(); f.mode(mode);
      assert.equal((await post(url, await token(workspaceA))).status, 503);
      assert.equal(f.providerCalls(), 0);
      assert.equal(f.operations.filter(op => op.path.endsWith('/release')).length, 0);
      if (mode === 'ambiguous') assert.equal(f.reservations.size, 1);
    } finally { await f.stop(); }
  }
});

test('workspace JWT verifies strict claims and ignores forged workspace authority', async () => {
  const f = await fixture();
  try {
    const url = await f.gateway();
    for (const invalid of [{ iss: 'https://wrong.example.test' }, { aud: 'wrong' }, { aud: ['platform-api'] }, { ws: 'owner' }, { sub: 'owner' }, { iat: null }, { exp: null }, { exp: 1e20 }, { iat: Math.floor(Date.now()/1000) + 60 }, { nbf: Math.floor(Date.now()/1000) + 60 }, { jti: '' }, { scope: '*' }, { scope: ['ai:generate'] }, { scope: '' }, { scope: 'api:read' }]) {
      const response = await post(url, await token(workspaceA, invalid));
      assert.ok([401, 403].includes(response.status), `invalid claim ${Object.keys(invalid)[0]} accepted: ${response.status}`);
    }
    const response = await post(url, await token(workspaceA), { ...body, workspace_id: workspaceB } as any, { 'X-Workspace-ID': workspaceB });
    assert.equal(response.status, 400);
    assert.equal(f.providerCalls(), 0);
    assert.equal(f.operations.length, 0);
  } finally { await f.stop(); }
});

test('unknown provider usage and ambiguous failure retain budget; fallback reserves separately', async () => {
  for (const mode of ['unknown', 'failure', 'fallback']) {
    const f = await fixture();
    try {
      const url = await f.gateway(mode === 'fallback' ? { AI_GATEWAY_FALLBACK_MODEL: 'secondary', AI_GATEWAY_FALLBACK_INPUT_USD_PER_1K: '0.002', AI_GATEWAY_FALLBACK_OUTPUT_USD_PER_1K: '0.004' } : {});
      f.providerMode(mode);
      const response = await post(url, await token(workspaceA));
      assert.equal(response.status, mode === 'failure' ? 502 : 200);
      const budgetReservations = [...f.reservations.values()].filter(r => r.tenant.endsWith(':usd'));
      assert.equal(budgetReservations.length, mode === 'fallback' ? 2 : 1);
      assert.equal(budgetReservations[0].actual, null);
      if (mode === 'fallback') assert.equal(budgetReservations[1].actual, 40);
      assert.equal(f.operations.filter(op => op.path.endsWith('/release')).length, 0);
    } finally { await f.stop(); }
  }
});

test('local global hard ceiling remains a second deny gate before provider', async () => {
  const f = await fixture();
  try {
    const url = await f.gateway({ AI_GATEWAY_MONTHLY_BUDGET_USD: '0' });
    assert.equal((await post(url, await token(workspaceA))).status, 429);
    assert.equal(f.providerCalls(), 0);
  } finally { await f.stop(); }
});

test('readiness fails closed on expired service JWT or unavailable shared dependency', async () => {
  const f = await fixture();
  try {
    const now = Math.floor(Date.now() / 1000);
    const expired = await token(systemWorkspace, { scope: 'quotas:service', iat: now - 500, exp: now - 1 });
    const url = await f.gateway({ AI_GATEWAY_SHARED_SERVICE_TOKEN: expired });
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
    assert.equal((await post(url, await token(workspaceA))).status, 503);
    const healthy = await f.gateway();
    assert.equal((await fetch(`${healthy}/readyz`)).status, 200);
    f.mode('outage');
    assert.equal((await fetch(`${healthy}/readyz`)).status, 503);
    assert.equal(f.providerCalls(), 0);
  } finally { await f.stop(); }
});

test('settlement outage fails closed and retains known provider charge without fallback', async () => {
  const f = await fixture();
  try {
    const url = await f.gateway({ AI_GATEWAY_FALLBACK_MODEL: 'secondary' });
    f.mode('budget-settlement-outage');
    assert.equal((await post(url, await token(workspaceA))).status, 503);
    assert.equal(f.providerCalls(), 1);
    const budget = [...f.reservations.values()].find(r => r.tenant.endsWith(':usd'));
    assert.equal(budget.actual, null);
    assert.ok(f.consumed.get('global:all-usd')! >= 20);
  } finally { await f.stop(); }
});

test('shared HTTP response bounds, redirects, timeouts and changed keys deny before provider', async () => {
  for (const mode of ['oversized', 'redirect', 'slow', 'conflict', 'malformed']) {
    const f = await fixture();
    try {
      const url = await f.gateway({ AI_GATEWAY_SHARED_TIMEOUT_MS: '50' });
      f.mode(mode);
      assert.equal((await post(url, await token(workspaceA))).status, 503, mode);
      assert.equal(f.providerCalls(), 0);
    } finally { await f.stop(); }
  }
});

test('shared client bounds concurrent admission HTTP operations', async () => {
  const f = await fixture();
  try {
    const url = await f.gateway({ AI_GATEWAY_SHARED_TIMEOUT_MS: '100', AI_GATEWAY_SHARED_MAX_INFLIGHT: '1' });
    f.mode('slow');
    const caller = await token(workspaceA);
    const responses = await Promise.all(Array.from({ length: 4 }, () => post(url, caller)));
    assert.ok(responses.every(r => r.status === 503));
    assert.equal(f.operations.length, 1);
    assert.equal(f.providerCalls(), 0);
  } finally { await f.stop(); }
});

test('unrounded cost settles conservatively; explicitly zero-priced calls reserve a minimum quantum', async () => {
  for (const rate of ['0.0001001', '0']) {
    const f = await fixture();
    try {
      const url = await f.gateway({ AI_GATEWAY_INPUT_USD_PER_1K: rate, AI_GATEWAY_OUTPUT_USD_PER_1K: '0' });
      assert.equal((await post(url, await token(workspaceA))).status, 200);
      const budget = [...f.reservations.values()].find(r => r.tenant.endsWith(':usd'));
      assert.equal(budget.actual, rate === '0' ? 0 : 2);
      assert.ok(budget.units >= 1);
    } finally { await f.stop(); }
  }
});

test('wrong JWT algorithm, signature, expiry and untrusted legacy profile cannot reach shared admission', async () => {
  const f = await fixture();
  try {
    const url = await f.gateway();
    const valid = await token(workspaceA);
    const parts = valid.split('.');
    parts[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url').toString()), ws: workspaceB })).toString('base64url');
    const now = Math.floor(Date.now()/1000);
    const invalid = [parts.join('.'), await token(workspaceA, { iat: now - 300, exp: now - 1 }), await token(workspaceA, { exp: now + 3601 }), await new SignJWT({ ws: workspaceA }).setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode('synthetic-only-signing-secret-32-bytes'))];
    for (const value of invalid) assert.equal((await post(url, value)).status, 401);
    assert.equal(f.operations.length, 0);
    assert.equal(f.providerCalls(), 0);
    const store = openTelemetryStore(':memory:', loadTelemetryMigration({}));
    try {
      assert.throws(() => createAiGatewayService({ env: { ...f.env, AI_GATEWAY_AUTH_PROFILE: 'scoped' }, store, log: () => {} }), /workspace-jwt/);
      assert.throws(() => createAiGatewayService({ env: { ...f.env, AI_GATEWAY_SHARED_BUDGET_POLICY: undefined }, store, log: () => {} }), /Shared admission configuration/);
      assert.throws(() => createAiGatewayService({ env: { ...f.env, NODE_ENV: 'production' }, store, log: () => {} }), /Shared admission configuration/);
    } finally { store.close(); }
  } finally { await f.stop(); }
});

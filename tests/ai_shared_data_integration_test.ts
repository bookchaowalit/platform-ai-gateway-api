import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createAiGatewayService } from '../api/ai-gateway-service/service.js';
import { loadTelemetryMigration, openTelemetryStore } from '../api/ai-gateway-service/store.js';

const enabled = Boolean(process.env.AI_GATEWAY_TEST_DATA_PYTHON && process.env.AI_GATEWAY_TEST_PG_DSN);
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('real platform-data with PostgreSQL admits across independent gateways and enforces platform ceiling', { skip: !enabled, timeout: 30000 }, async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://synthetic.integration.test';
  const system = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const actor = randomUUID();
  const sign = (ws: string, scope: string) => new SignJWT({ ws, scope })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(issuer).setAudience('platform-api')
    .setSubject(actor).setIssuedAt().setExpirationTime('10m').setJti(randomUUID()).sign(key.privateKey);
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const child = spawn(process.env.AI_GATEWAY_TEST_DATA_PYTHON!, ['-u', 'tests/fixtures/shared_data_server.py'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
  });
  // Fixture stderr is never copied: a startup failure is reported without DSNs.
  child.stderr.resume();
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(JSON.stringify({ issuer, public_key: publicKey, system_workspace: system }) + '\n');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local data fixture startup timeout')), 15000);
    lines.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line).url); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Local data fixture failed to start')); });
  });
  let providerCalls = 0;
  const provider = createServer(async (req, res) => {
    for await (const _ of req) { /* bounded test request */ }
    providerCalls++;
    res.end(JSON.stringify({ model: 'fixture', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  const upstream = await listen(provider);
  const gateways: { server: Server; store: ReturnType<typeof openTelemetryStore> }[] = [];
  const callerA = await sign(workspaceA, 'ai:generate quotas:write');
  const callerB = await sign(workspaceB, 'ai:generate quotas:write');
  const serviceToken = await sign(system, 'quotas:service quotas:write');
  async function policy(caller: string, name: string, limit: number) {
    const response = await fetch(`${dataUrl}/v1/quotas/${name}`, { method: 'PUT', headers: { Authorization: `Bearer ${caller}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ limit, window_seconds: 3600 }) });
    assert.equal(response.status, 200);
  }
  async function gateway() {
    const store = openTelemetryStore(':memory:', loadTelemetryMigration({}));
    const service = createAiGatewayService({ store, log: () => {}, env: {
      NODE_ENV: 'test', AI_GATEWAY_ADMISSION_MODE: 'shared', AI_GATEWAY_AUTH_PROFILE: 'workspace-jwt',
      AI_GATEWAY_JWT_PUBLIC_KEY_PEM: publicKey, AI_GATEWAY_JWT_ISSUER: issuer,
      AI_GATEWAY_SHARED_DATA_URL: dataUrl, AI_GATEWAY_SHARED_SERVICE_TOKEN: serviceToken,
      AI_GATEWAY_SHARED_RATE_POLICY: 'rate', AI_GATEWAY_SHARED_GLOBAL_RATE_POLICY: 'rate',
      AI_GATEWAY_SHARED_BUDGET_POLICY: 'usd', AI_GATEWAY_SHARED_GLOBAL_BUDGET_POLICY: 'usd',
      AI_GATEWAY_PROVIDER: 'openai-compatible', AI_GATEWAY_BASE_URL: `${upstream}/v1`, AI_GATEWAY_API_KEY: 'synthetic-fixture',
      AI_GATEWAY_MODEL: 'fixture', AI_GATEWAY_INPUT_USD_PER_1K: '0.001', AI_GATEWAY_OUTPUT_USD_PER_1K: '0.002',
      AI_GATEWAY_MONTHLY_BUDGET_USD: '5',
    } });
    gateways.push({ server: service.server, store });
    return listen(service.server);
  }
  const post = (url: string, caller: string) => fetch(`${url}/api/ai/generate`, { method: 'POST', headers: { Authorization: `Bearer ${caller}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ route: 'integration', prompt_version: 'v1', messages: [{ role: 'user', content: 'hello' }], max_output_tokens: 128 }) });
  try {
    for (const caller of [callerA, callerB, serviceToken]) {
      await policy(caller, 'rate', caller === serviceToken ? 100 : 2);
      await policy(caller, 'usd', 100000);
    }
    const urls = await Promise.all([gateway(), gateway()]);
    assert.equal((await fetch(`${urls[0]}/readyz`)).status, 200);
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => post(urls[i % 2], callerA)));
    assert.equal(responses.filter(r => r.status === 200).length, 2, JSON.stringify(await Promise.all(responses.map(async r => ({status:r.status, body:await r.clone().json()})))));
    assert.equal(responses.filter(r => r.status === 429).length, 4);
    assert.equal(providerCalls, 2);
    // Four definite tenant denials may retain global legs conservatively.
    await policy(serviceToken, 'rate', 7);
    assert.equal((await post(urls[1], callerB)).status, 200);
    assert.equal(providerCalls, 3);
    assert.equal((await post(urls[0], callerB)).status, 429);
    assert.equal(providerCalls, 3);
    // Relax only rate policies; the shared USD ceiling is now authoritative.
    for (const caller of [callerA, callerB, serviceToken]) await policy(caller, 'rate', 100);
    await policy(serviceToken, 'usd', 60); // actual spend 3 * 20 microUSD
    assert.equal((await post(urls[0], callerB)).status, 429);
    assert.equal(providerCalls, 3);
    await policy(serviceToken, 'usd', 100000);
    await policy(callerA, 'usd', 40); // A exhausted; B still has separate budget
    assert.equal((await post(urls[0], callerA)).status, 429);
    assert.equal((await post(urls[1], callerB)).status, 200);
    assert.equal(providerCalls, 4);
  } finally {
    for (const g of gateways) { await close(g.server); g.store.close(); }
    await close(provider);
    lines.close();
    child.stdin.end();
    const code = await exited;
    assert.equal(code, 0, 'Local data fixture shutdown failed');
  }
});

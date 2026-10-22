import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ConfigError, FORBIDDEN_ARGUMENTS, URL_KEY, apiUrl, bearer, cleanToken, createServer, failure,
} from '../mcp/ai-gateway-mcp.js';

// Fake HTTP transport: no network, no gateway.
const TOOLS = ['ai_gateway.budget', 'ai_gateway.rate_limit', 'ai_gateway.status'];
const STATUS = { contract: 'solo-empire.ai-gateway.v1', budget: { spent: 1 }, rate_limit: { limit: 5 }, service: { version: '1' } };

function fake(status = 200, body: unknown = STATUS) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

async function connect(f = fake(), token: () => string = () => 'tok-123') {
  const server = createServer({ baseUrl: 'https://gateway.test', token, fetchImpl: f.fetchImpl });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { isError: Boolean(result.isError), text: JSON.stringify(result.content) };
  } catch (error) {
    return { isError: true, text: String((error as Error).message) };
  }
}

test('tools/list: three read-only tools with strict, empty inputs and no identity arguments', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), []);
    assert.equal(tool.annotations?.readOnlyHint, true);
  }
  assert.deepEqual([...FORBIDDEN_ARGUMENTS].sort(),
    ['actor', 'actor_id', 'authorization', 'delegation', 'owner_id', 'tenant', 'tenant_id', 'token', 'workspace', 'workspace_id']);
});

test('unknown and identity arguments are rejected before any HTTP call', async () => {
  const f = fake();
  const client = await connect(f);
  for (const name of TOOLS) {
    for (const key of ['surprise', ...FORBIDDEN_ARGUMENTS]) {
      const result = await call(client, name, { [key]: 'x' });
      assert.equal(result.isError, true, `${name} ${key}`);
    }
  }
  assert.equal(f.requests.length, 0);
});

test('every call is one GET of /api/ai/status with the callers bearer and nothing else', async () => {
  const f = fake();
  const client = await connect(f);
  for (const name of TOOLS) assert.equal((await call(client, name)).isError, false);
  assert.equal(f.requests.length, 3);
  for (const { url, init } of f.requests) {
    assert.equal(url, 'https://gateway.test/api/ai/status');
    assert.equal(init.method, 'GET');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer tok-123');
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'manual');
  }
});

test('projections: budget and rate_limit return only their part', async () => {
  const client = await connect();
  assert.match((await call(client, 'ai_gateway.budget')).text, /spent/);
  assert.doesNotMatch((await call(client, 'ai_gateway.budget')).text, /rate_limit|limit\\":5/);
  assert.match((await call(client, 'ai_gateway.rate_limit')).text, /limit/);
  assert.match((await call(client, 'ai_gateway.status')).text, /solo-empire.ai-gateway.v1/);
});

test('errors are a fixed message from the status only (secret upstream body is never shown)', async () => {
  const secret = { detail: { error: 'forbidden', secret: 'tok-123 do-not-leak' }, error: { code: 'leak-code' } };
  const expected: Array<[number, string]> = [[400, 'invalid'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'],
    [409, 'conflict'], [422, 'invalid'], [429, 'rate_limited'], [500, 'upstream_error'], [503, 'upstream_error'], [418, 'error']];
  for (const [status, word] of expected) {
    const client = await connect(fake(status, secret));
    const result = await call(client, 'ai_gateway.status');
    assert.equal(result.isError, true);
    assert.ok(result.text.includes(`${status}: ${word}`), result.text);
    assert.doesNotMatch(result.text, /leak|tok-123/);
    assert.equal(failure(status), `${status}: ${word}`);
  }
});

test('a transport failure does not echo the error', async () => {
  const fetchImpl = (async () => { throw new Error('connect failed Authorization: Bearer tok-123'); }) as typeof fetch;
  const client = await connect({ requests: [], fetchImpl });
  const result = await call(client, 'ai_gateway.status');
  assert.ok(result.isError && result.text.includes('503: upstream_error') && !result.text.includes('tok-123'));
});

test('a token with whitespace or control characters is refused without echo and without a request', async () => {
  for (const bad of ['two words-abcdefgh', 'line\nbreak-abcdefgh', 'tab\there-abcdefgh', 'nul\u0000byte-abcdefgh', '   ']) {
    const f = fake();
    const result = await call(await connect(f, () => bad), 'ai_gateway.status');
    assert.ok(result.isError && result.text.includes('401: unauthorized') && !result.text.includes('abcdefgh'));
    assert.equal(f.requests.length, 0);
  }
  assert.throws(() => cleanToken('a b'), ConfigError);
  assert.equal(cleanToken(' ok.token \n'), 'ok.token');
});

test('the URL must be https (http only on loopback) without credentials, query or fragment', () => {
  const empty = mkdtempSync(join(tmpdir(), 'gw-mcp-'));
  try {
    const home = empty;
    assert.equal(apiUrl({ [URL_KEY]: 'https://x.example/' }, home), 'https://x.example');
    assert.equal(apiUrl({ [URL_KEY]: 'http://127.0.0.1:9' }, home), 'http://127.0.0.1:9');
    for (const bad of ['http://example.com', 'https://u:p@x.example', 'https://x.example?a=1', 'https://x.example#f', 'not a url']) {
      assert.throws(() => apiUrl({ [URL_KEY]: bad }, home), ConfigError, bad);
    }
    assert.throws(() => apiUrl({}, home), ConfigError);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('token order and file modes: EMPIRE_TOKEN, EMPIRE_TOKEN_FILE (600), then the owner token file', () => {
  const home = mkdtempSync(join(tmpdir(), 'gw-mcp-'));
  try {
    const file = join(home, 't.token');
    writeFileSync(file, 'from-file-token\n');
    chmodSync(file, 0o644);
    assert.throws(() => bearer({ EMPIRE_TOKEN_FILE: file }, home), ConfigError);
    chmodSync(file, 0o600);
    assert.equal(bearer({ EMPIRE_TOKEN_FILE: file }, home), 'from-file-token');
    assert.equal(bearer({ EMPIRE_TOKEN: 'env-token', EMPIRE_TOKEN_FILE: file }, home), 'env-token');
    assert.throws(() => bearer({}, home), /no token/);
    mkdirSync(join(home, '.config', 'solo-empire'), { recursive: true });
    const owner = join(home, '.config', 'solo-empire', 'production-tools.ai-gateway.token');
    writeFileSync(owner, 'owner-file-token\n');
    chmodSync(owner, 0o600);
    assert.equal(bearer({}, home), 'owner-file-token');
    writeFileSync(file, 'two words\n');
    assert.throws(() => bearer({ EMPIRE_TOKEN_FILE: file }, home), ConfigError);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('validation errors are the fixed text invalid_arguments and echo no argument name or value', async () => {
  const f = fake();
  const client = await connect(f);
  const attempts: Array<[string, Record<string, unknown>]> = [
    ['ai_gateway.status', { UNTRUSTED_MARKER: 'VALUE_MARKER' }],
    ['ai_gateway.budget', { UNTRUSTED_MARKER: { nested: 'VALUE_MARKER' } }],
    ['ai_gateway.rate_limit', { token: 'VALUE_MARKER' }],
  ];
  for (const [name, args] of attempts) {
    let text: string;
    let thrown = false;
    try {
      const result = await client.callTool({ name, arguments: args });
      text = JSON.stringify(result);
      assert.equal(result.isError, true);
    } catch (error) {
      thrown = true;
      text = `${(error as Error).message} ${JSON.stringify(error)}`;
    }
    assert.equal(thrown, false, 'rejection is a tool result, not a protocol error that carries SDK text');
    assert.ok(text.includes('invalid_arguments'), text);
    assert.doesNotMatch(text, /MARKER/);
  }
  const unknown = await client.callTool({ name: 'x.UNTRUSTED_MARKER', arguments: { a: 'VALUE_MARKER' } });
  assert.equal(unknown.isError, true);
  assert.doesNotMatch(JSON.stringify(unknown), /MARKER/);
  assert.equal(f.requests.length, 0);
});

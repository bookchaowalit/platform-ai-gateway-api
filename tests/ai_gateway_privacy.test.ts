// SPEC-002 AC-07: private data only on owner allow-listed routes, never to an unattested fallback.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiGatewayError, generateAi } from '../api/ai_gateway.js';
import { configuredEnv, fakeProvider, providerText } from './fixtures/gateway.js';

const request = {
  route: 'client-a.chat',
  prompt_version: 'chat-v1',
  profile: 'fast',
  privacy_class: 'private',
  token_budget: 1024,
  max_output_tokens: 64,
  messages: [{ role: 'user', content: 'ยอดค้างเท่าไร' }],
};

const allowEnv = (overrides: NodeJS.ProcessEnv = {}) => configuredEnv({
  AI_GATEWAY_PRIVATE_ROUTES_JSON: JSON.stringify({ 'client-a': ['client-a.chat', 'client-a.bill-read'] }),
  AI_GATEWAY_PROVIDER_PRIVATE_DATA_ATTESTED: 'true',
  ...overrides,
});

async function denied(input: unknown, env: NodeJS.ProcessEnv, subject?: string) {
  const provider = fakeProvider(() => providerText('unused'));
  try {
    await assert.rejects(() => generateAi(input, env, { privateRouteSubject: subject }), (error: unknown) => {
      assert.ok(error instanceof AiGatewayError);
      assert.equal(error.status, 403);
      return true;
    });
    assert.equal(provider.bodies.length, 0);
  } finally {
    provider.restore();
  }
}

test('AC-07 private allowed only for allow-listed subject routes', async () => {
  const provider = fakeProvider(() => providerText('ค้าง 8,450 บาท'));
  try {
    const { response, telemetry } = await generateAi(request, allowEnv(), { privateRouteSubject: 'client-a' });
    assert.equal(response.content, 'ค้าง 8,450 บาท');
    assert.equal(telemetry.metadata.privacy_class, 'private');
  } finally {
    provider.restore();
  }
  await denied(request, configuredEnv(), 'client-a');
  await denied(request, allowEnv(), 'client-b');
  await denied(request, allowEnv(), undefined);
  await denied({ ...request, route: 'client-a.other' }, allowEnv(), 'client-a');
  await denied(request, allowEnv({ AI_GATEWAY_PROVIDER_PRIVATE_DATA_ATTESTED: undefined }), 'client-a');
  await denied(request, allowEnv({ AI_GATEWAY_PROVIDER_PRIVATE_DATA_ATTESTED: 'maybe' }), 'client-a');
  await denied({ ...request, privacy_class: 'restricted' }, allowEnv(), 'client-a');
});

test('AC-07 invalid allow-list config refuses every private request', async () => {
  for (const raw of ['{not json', '[]', '{"client-a":"client-a.chat"}', '{"client-a":[1]}', '{"client a":["client-a.chat"]}']) {
    await denied(request, allowEnv({ AI_GATEWAY_PRIVATE_ROUTES_JSON: raw }), 'client-a');
  }
});

test('AC-07 the subject comes from the caller token, not the request body', async () => {
  await denied({ ...request, subject: 'client-a' }, allowEnv(), 'client-b');
});

test('AC-07 internal requests are unaffected by the allow-list', async () => {
  const provider = fakeProvider(() => providerText('ok'));
  try {
    await generateAi({ ...request, privacy_class: 'internal' }, allowEnv({ AI_GATEWAY_PRIVATE_ROUTES_JSON: '{bad' }), { privateRouteSubject: 'client-b' });
    assert.equal(provider.bodies.length, 1);
  } finally {
    provider.restore();
  }
});

test('AC-07 private request skips an unattested fallback', async () => {
  const env = allowEnv({ AI_GATEWAY_FALLBACK_MODEL: 'fallback-model' });
  let provider = fakeProvider(() => new Response('{}', { status: 503 }));
  try {
    await assert.rejects(() => generateAi(request, env, { privateRouteSubject: 'client-a' }), (error: unknown) => error instanceof AiGatewayError && error.status === 502);
    assert.equal(provider.bodies.length, 1, 'no fallback call for private data');
  } finally {
    provider.restore();
  }
  provider = fakeProvider((_body, call) => (call === 0 ? new Response('{}', { status: 503 }) : providerText('ok')));
  try {
    const { response } = await generateAi(request, { ...env, AI_GATEWAY_FALLBACK_PRIVATE_DATA_ATTESTED: 'true' }, { privateRouteSubject: 'client-a' });
    assert.equal(provider.bodies.length, 2);
    assert.equal(response.fallback_used, true);
  } finally {
    provider.restore();
  }
});

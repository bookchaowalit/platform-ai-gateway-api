// SPEC-004: per-subject model choice with per-model prices.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiGatewayError, generateAi, getAiGatewayStatus } from '../api/ai_gateway.js';
import { serviceConfigurationProblems } from '../api/ai-gateway-service/service.js';
import { configuredEnv, fakeProvider, providerText } from './fixtures/gateway.js';

const OVERRIDE = { 'meeting-minutes': { quality: { model: 'sol-model', input_usd_per_1k: 1, output_usd_per_1k: 2 } } };

const request = {
  route: 'meeting-minutes.mom',
  prompt_version: 'mom-v1',
  profile: 'quality',
  token_budget: 4096,
  max_output_tokens: 64,
  messages: [{ role: 'user', content: 'สรุปประชุม' }],
};

const env = (overrides: NodeJS.ProcessEnv = {}) => configuredEnv({
  AI_GATEWAY_SUBJECT_MODELS_JSON: JSON.stringify(OVERRIDE),
  ...overrides,
});

test('AC-01/AC-02 listed subject and profile get the listed model and its prices', async () => {
  const provider = fakeProvider(() => providerText('ok'));
  try {
    const { response, telemetry } = await generateAi(request, env(), { modelSubject: 'meeting-minutes' });
    assert.equal(provider.bodies[0].model, 'sol-model');
    assert.equal(response.model, 'sol-model');
    assert.equal(telemetry.model, 'sol-model');
    assert.equal(telemetry.metadata.subject_model, true);
    // providerText usage: 20 in, 10 out -> (20*1 + 10*2) / 1000
    assert.equal(response.estimated_cost_usd, 0.04);
  } finally {
    provider.restore();
  }
});

test('AC-02 the budget reservation uses the override rates', async () => {
  const provider = fakeProvider(() => providerText('ok'));
  const reserved: Array<number | null> = [];
  try {
    await generateAi(request, env(), {
      modelSubject: 'meeting-minutes',
      budgetGuard: { reserve: async (estimate: number | null) => { reserved.push(estimate); return () => undefined; } } as any,
    });
    const global: Array<number | null> = [];
    await generateAi(request, env(), {
      modelSubject: 'other',
      budgetGuard: { reserve: async (estimate: number | null) => { global.push(estimate); return () => undefined; } } as any,
    });
    assert.ok(reserved[0]! > global[0]! * 50, `override estimate ${reserved[0]} should use rates 100x the global ${global[0]}`);
  } finally {
    provider.restore();
  }
});

test('AC-03/AC-04 other subjects, no subject and unlisted profiles keep the global model and rates', async () => {
  const provider = fakeProvider(() => providerText('ok'));
  try {
    for (const [subject, profile] of [['other', 'quality'], [undefined, 'quality'], ['meeting-minutes', 'fast']] as const) {
      const { response, telemetry } = await generateAi({ ...request, profile }, env(), { modelSubject: subject });
      assert.equal(response.model, 'test-model');
      assert.equal(telemetry.metadata.subject_model, undefined);
      assert.equal(response.estimated_cost_usd, 0.0004);
    }
    // The body cannot pick the subject.
    const { response } = await generateAi({ ...request, subject: 'meeting-minutes' }, env(), { modelSubject: 'other' });
    assert.equal(response.model, 'test-model');
  } finally {
    provider.restore();
  }
});

test('AC-05 an overridden call never falls back to the global fallback model', async () => {
  const provider = fakeProvider(() => new Response('{}', { status: 503 }));
  try {
    await assert.rejects(
      () => generateAi(request, env({ AI_GATEWAY_FALLBACK_MODEL: 'fallback-model' }), { modelSubject: 'meeting-minutes' }),
      (error: unknown) => error instanceof AiGatewayError && error.status === 502,
    );
    assert.equal(provider.bodies.length, 1);
  } finally {
    provider.restore();
  }
});

const BAD_VALUES = [
  '{bad',
  '[]',
  '{"meeting-minutes":[]}',
  '{"bad subject":{"quality":{"model":"m","input_usd_per_1k":1,"output_usd_per_1k":1}}}',
  '{"meeting-minutes":{"best":{"model":"m","input_usd_per_1k":1,"output_usd_per_1k":1}}}',
  '{"meeting-minutes":{"quality":{"model":"bad model","input_usd_per_1k":1,"output_usd_per_1k":1}}}',
  '{"meeting-minutes":{"quality":{"model":"m","output_usd_per_1k":1}}}',
  '{"meeting-minutes":{"quality":{"model":"m","input_usd_per_1k":-1,"output_usd_per_1k":1}}}',
  '{"meeting-minutes":{"quality":{"model":"m","input_usd_per_1k":"1","output_usd_per_1k":1}}}',
  '{"meeting-minutes":{"quality":{"model":"m","input_usd_per_1k":1,"output_usd_per_1k":1,"fallback":"x"}}}',
];

test('AC-06 a malformed value is a startup problem and fails generate closed', async () => {
  for (const raw of BAD_VALUES) {
    const problems = serviceConfigurationProblems(env({ AI_GATEWAY_SUBJECT_MODELS_JSON: raw }));
    assert.ok(problems.includes('AI_GATEWAY_SUBJECT_MODELS_JSON is invalid'), `${raw}: ${problems.join(';')}`);
    const provider = fakeProvider(() => providerText('unused'));
    try {
      await assert.rejects(
        () => generateAi(request, env({ AI_GATEWAY_SUBJECT_MODELS_JSON: raw }), { modelSubject: 'other' }),
        (error: unknown) => error instanceof AiGatewayError && error.status === 503,
      );
      assert.equal(provider.bodies.length, 0);
    } finally {
      provider.restore();
    }
  }
  assert.ok(!serviceConfigurationProblems(env()).includes('AI_GATEWAY_SUBJECT_MODELS_JSON is invalid'));
});

test('AC-07 status shows only the caller\'s own effective models', () => {
  const mine = getAiGatewayStatus(env(), 'meeting-minutes');
  assert.equal(mine.models.quality, 'sol-model');
  assert.equal(mine.models.fast, 'test-model');
  assert.equal(mine.capabilities.subject_models, 1);
  const other = getAiGatewayStatus(env(), 'other');
  assert.equal(other.models.quality, 'test-model');
  assert.equal(other.capabilities.subject_models, 0);
  assert.equal(getAiGatewayStatus(env()).capabilities.subject_models, 0);
});

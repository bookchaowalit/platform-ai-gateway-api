// SPEC-002 AC-05, AC-09 (gateway part), AC-13: image input, content-free telemetry, image and tool cost estimate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiGatewayError, generateAi, type AiTelemetryEvent } from '../api/ai_gateway.js';
import { RECORD_TOOL, configuredEnv, fakeProvider, jpegDataUrl, pngDataUrl, providerText, providerToolCalls } from './fixtures/gateway.js';

const base = {
  route: 'vision-test',
  prompt_version: 'vision-v1',
  profile: 'fast',
  privacy_class: 'internal',
  token_budget: 8192,
  max_output_tokens: 256,
};

function userWith(...parts: unknown[]) {
  return { role: 'user', content: parts };
}
const text = (value: string) => ({ type: 'text', text: value });
const image = (dataUrl: string) => ({ type: 'image', data_url: dataUrl });

async function rejects(input: unknown, env: NodeJS.ProcessEnv, status = 400, pattern?: RegExp) {
  const provider = fakeProvider(() => providerText('unused'));
  try {
    await assert.rejects(() => generateAi(input, env), (error: unknown) => {
      assert.ok(error instanceof AiGatewayError, String(error));
      assert.equal(error.status, status, error.message);
      if (pattern) assert.match(error.message, pattern);
      return true;
    });
    assert.equal(provider.bodies.length, 0);
  } finally {
    provider.restore();
  }
}

test('AC-05 forwards a data-url image', async () => {
  const provider = fakeProvider(() => providerText('{"total":8450}'));
  try {
    const url = pngDataUrl();
    await generateAi({ ...base, messages: [userWith(text('อ่านยอดรวม'), image(url))] }, configuredEnv());
    assert.deepEqual(provider.bodies[0].messages[1], {
      role: 'user',
      content: [{ type: 'text', text: 'อ่านยอดรวม' }, { type: 'image_url', image_url: { url } }],
    });
  } finally {
    provider.restore();
  }
});

test('AC-05 rejects remote and malformed images', async () => {
  const env = configuredEnv();
  const bad = [
    'https://example.test/bill.jpg',
    'http://169.254.169.254/latest',
    'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    'data:image/png;base64,***not-base64***',
    'data:image/png;base64,abc',
    `data:image/png;base64,${Buffer.from('not a png at all').toString('base64')}`,
    jpegDataUrl().replace('image/jpeg', 'image/webp'),
  ];
  for (const url of bad) await rejects({ ...base, messages: [userWith(text('x'), image(url))] }, env, 400, /image/);
  // Unknown part types and empty parts lists.
  await rejects({ ...base, messages: [userWith({ type: 'input_audio', data: 'x' })] }, env);
  await rejects({ ...base, messages: [userWith()] }, env);
  // Images only in user messages.
  await rejects({ ...base, messages: [{ role: 'system', content: [image(pngDataUrl())] }, { role: 'user', content: 'x' }] }, env);
  // Count, per-image and total caps.
  const five = Array.from({ length: 5 }, () => image(pngDataUrl()));
  await rejects({ ...base, messages: [userWith(text('x'), ...five)] }, env, 400, /image/);
  await rejects({ ...base, messages: [userWith(text('x'), image(jpegDataUrl(2048)))] }, configuredEnv({ AI_GATEWAY_MAX_IMAGE_BYTES: '1024' }), 400, /image/);
  await rejects(
    { ...base, messages: [userWith(text('x'), image(jpegDataUrl(1500)), image(jpegDataUrl(1500)))] },
    configuredEnv({ AI_GATEWAY_MAX_IMAGE_BYTES: '2048', AI_GATEWAY_MAX_TOTAL_IMAGE_BYTES: '2500' }),
    400,
    /image/,
  );
});

test('AC-05 image bytes do not count toward the text context limit', async () => {
  const provider = fakeProvider(() => providerText('ok'));
  try {
    await generateAi(
      { ...base, messages: [userWith(text('x'), image(jpegDataUrl(4096)))] },
      configuredEnv({ AI_GATEWAY_MAX_CONTEXT_CHARS: '2048' }),
    );
    assert.equal(provider.bodies.length, 1);
  } finally {
    provider.restore();
  }
});

test('AC-09 telemetry holds counts only', async () => {
  const events: AiTelemetryEvent[] = [];
  const provider = fakeProvider(() => providerToolCalls([{ id: 'c1', name: 'record_bill', arguments: '{"amount":"secret-arg-8450"}' }]));
  try {
    await generateAi(
      {
        ...base,
        messages: [
          userWith(text('secret-user-text'), image(pngDataUrl())),
          { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'record_bill', arguments: '{"amount":"secret-old-arg"}' } }] },
          { role: 'tool', tool_call_id: 'c0', content: 'secret-tool-output' },
        ],
        tools: [RECORD_TOOL],
      },
      configuredEnv(),
      { recordTelemetry: (event) => events.push(event) },
    );
  } finally {
    provider.restore();
  }
  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events[0]);
  for (const secret of ['secret-user-text', 'secret-arg-8450', 'secret-old-arg', 'secret-tool-output', 'base64', 'record_bill', 'amount']) {
    assert.ok(!serialized.includes(secret), `telemetry leaked ${secret}`);
  }
  assert.equal(events[0].metadata.image_count, 1);
  assert.equal(events[0].metadata.tool_count, 1);
  assert.equal(events[0].metadata.tool_call_count, 1);
  assert.equal(events[0].metadata.has_tools, true);
  assert.equal(events[0].metadata.has_images, true);
});

test('AC-13 image requests reserve image tokens', async () => {
  const reservations: Array<number | null> = [];
  const budgetGuard = { reserve: async (estimate: number | null) => { reservations.push(estimate); return () => undefined; } };
  const provider = fakeProvider(() => providerText('ok'));
  try {
    const env = configuredEnv({ AI_GATEWAY_IMAGE_TOKEN_ESTIMATE: '1000' });
    await generateAi({ ...base, messages: [userWith(text('x'))] }, env, { budgetGuard });
    await generateAi({ ...base, messages: [userWith(text('x'), image(pngDataUrl()), image(pngDataUrl()))] }, env, { budgetGuard });
  } finally {
    provider.restore();
  }
  // 2 images × 1000 tokens × 0.01 USD / 1k input = 0.02 USD more than the text-only request.
  assert.ok(Math.abs((reservations[1]! - reservations[0]!) - 0.02) < 1e-9, `got ${reservations}`);
});

test('AC-13 image tokens count toward the token_budget check', async () => {
  const env = configuredEnv({ AI_GATEWAY_IMAGE_TOKEN_ESTIMATE: '2000' });
  await rejects(
    { ...base, token_budget: 4096, messages: [userWith(text('x'), image(pngDataUrl()), image(pngDataUrl()))] },
    env,
    400,
    /token_budget/,
  );
});

test('AC-13 tool and schema bytes count toward the estimate', async () => {
  const reservations: Array<number | null> = [];
  const budgetGuard = { reserve: async (estimate: number | null) => { reservations.push(estimate); return () => undefined; } };
  const bigTool = { ...RECORD_TOOL, function: { ...RECORD_TOOL.function, description: 'd'.repeat(4000) } };
  const provider = fakeProvider(() => providerText('ok'));
  try {
    await generateAi({ ...base, messages: [{ role: 'user', content: 'x' }] }, configuredEnv(), { budgetGuard });
    await generateAi({ ...base, messages: [{ role: 'user', content: 'x' }], tools: [bigTool] }, configuredEnv(), { budgetGuard });
  } finally {
    provider.restore();
  }
  // At least the 4,000 description bytes as input tokens at 0.01 USD / 1k.
  assert.ok(reservations[1]! - reservations[0]! >= 0.04 - 1e-9, `got ${reservations}`);
  await rejects(
    { ...base, token_budget: 1024, messages: [{ role: 'user', content: 'x' }], tools: [bigTool] },
    configuredEnv(),
    400,
    /token_budget/,
  );
});

test('NFR gateway overhead for a 1 MB image stays bounded (informational)', async () => {
  const provider = fakeProvider(() => providerText('ok'));
  try {
    const started = performance.now();
    await generateAi({ ...base, messages: [userWith(text('x'), image(jpegDataUrl(1_000_000)))] }, configuredEnv());
    const ms = performance.now() - started;
    process.stdout.write(`# gateway overhead for a 1 MB image: ${ms.toFixed(1)} ms\n`);
    assert.ok(ms < 500, `overhead ${ms} ms`);
  } finally {
    provider.restore();
  }
});

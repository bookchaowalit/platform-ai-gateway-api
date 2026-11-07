// SPEC-002 AC-01..04, AC-06, AC-10, AC-11: tool calling and JSON-schema output.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiGatewayError, generateAi } from '../api/ai_gateway.js';
import { RECORD_TOOL, configuredEnv, fakeProvider, jpegDataUrl, providerText, providerToolCalls } from './fixtures/gateway.js';

const base = {
  route: 'tools-test',
  prompt_version: 'tools-v1',
  profile: 'fast',
  privacy_class: 'internal',
  token_budget: 4096,
  max_output_tokens: 256,
};

const userTurn = { role: 'user', content: 'บันทึกบิล 8450' };
const assistantCall = {
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'record_bill', arguments: '{"amount":8450}' } }],
};
const toolReply = { role: 'tool', tool_call_id: 'call_1', content: 'recorded' };

async function rejects400(input: unknown, pattern?: RegExp) {
  const provider = fakeProvider(() => providerText('unused'));
  try {
    await assert.rejects(() => generateAi(input, configuredEnv()), (error: unknown) => {
      assert.ok(error instanceof AiGatewayError, String(error));
      assert.equal(error.status, 400, error.message);
      if (pattern) assert.match(error.message, pattern);
      return true;
    });
    assert.equal(provider.bodies.length, 0, 'provider must not be called');
  } finally {
    provider.restore();
  }
}

test('AC-01 text-only request body is unchanged', async () => {
  const provider = fakeProvider(() => providerText('สวัสดี'));
  try {
    const { response } = await generateAi({ ...base, messages: [userTurn] }, configuredEnv());
    assert.deepEqual(Object.keys(provider.bodies[0]).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
    assert.deepEqual(provider.bodies[0].messages[1], userTurn);
    assert.equal(response.content, 'สวัสดี');
    assert.equal('tool_calls' in response, false);
  } finally {
    provider.restore();
  }
});

test('AC-02 forwards tools and returns tool calls', async () => {
  const provider = fakeProvider(() => providerToolCalls([{ id: 'call_1', name: 'record_bill', arguments: '{"amount":8450}' }]));
  try {
    const { response } = await generateAi({
      ...base,
      messages: [userTurn],
      tools: [RECORD_TOOL],
      tool_choice: 'auto',
      parallel_tool_calls: false,
    }, configuredEnv());
    assert.deepEqual(provider.bodies[0].tools, [RECORD_TOOL]);
    assert.equal(provider.bodies[0].tool_choice, 'auto');
    assert.equal(provider.bodies[0].parallel_tool_calls, false);
    assert.equal(response.content, null);
    assert.deepEqual(response.tool_calls, [{ id: 'call_1', name: 'record_bill', arguments: '{"amount":8450}' }]);
    assert.equal(response.finish_reason, 'tool_calls');
    assert.equal(response.output_trust, 'untrusted_model_output');
  } finally {
    provider.restore();
  }
});

test('AC-02 a tools request answered with text returns an empty tool_calls list', async () => {
  const provider = fakeProvider(() => providerText('ยอดค้าง 8,450 บาท'));
  try {
    const { response } = await generateAi({ ...base, messages: [userTurn], tools: [RECORD_TOOL] }, configuredEnv());
    assert.equal(response.content, 'ยอดค้าง 8,450 บาท');
    assert.deepEqual(response.tool_calls, []);
  } finally {
    provider.restore();
  }
});

test('AC-03 accepts a tool round trip', async () => {
  const provider = fakeProvider(() => providerText('บันทึกแล้ว'));
  try {
    const messages = [userTurn, assistantCall, toolReply];
    const { response } = await generateAi({ ...base, messages, tools: [RECORD_TOOL] }, configuredEnv());
    const forwarded = provider.bodies[0].messages;
    assert.equal(forwarded[0].role, 'system');
    assert.deepEqual(forwarded.slice(1), messages);
    assert.equal(response.content, 'บันทึกแล้ว');
  } finally {
    provider.restore();
  }
});

test('AC-03 accepts an empty tool result and an empty assistant text beside tool calls', async () => {
  const provider = fakeProvider(() => providerText('ok'));
  try {
    await generateAi({
      ...base,
      messages: [userTurn, { ...assistantCall, content: '' }, { ...toolReply, content: '' }],
      tools: [RECORD_TOOL],
    }, configuredEnv());
    assert.equal(provider.bodies.length, 1);
  } finally {
    provider.restore();
  }
});

test('AC-03 rejects an orphan tool message', async () => {
  await rejects400({ ...base, messages: [userTurn, toolReply], tools: [RECORD_TOOL] }, /tool_call_id/);
  await rejects400({ ...base, messages: [userTurn, assistantCall, { ...toolReply, tool_call_id: 'call_9' }], tools: [RECORD_TOOL] }, /tool_call_id/);
});

test('AC-03 rejects unanswered, out-of-place and duplicate tool calls', async () => {
  // Assistant call without its tool reply.
  await rejects400({ ...base, messages: [userTurn, assistantCall, { role: 'user', content: 'ต่อ' }], tools: [RECORD_TOOL] }, /tool/);
  // Tool reply separated from its assistant message.
  await rejects400({ ...base, messages: [userTurn, assistantCall, { role: 'user', content: 'x' }, toolReply], tools: [RECORD_TOOL] }, /tool/);
  // Same call answered twice.
  await rejects400({ ...base, messages: [userTurn, assistantCall, toolReply, toolReply], tools: [RECORD_TOOL] }, /tool/);
  // Duplicate call ids in one assistant message.
  const dup = { ...assistantCall, tool_calls: [assistantCall.tool_calls[0], assistantCall.tool_calls[0]] };
  await rejects400({ ...base, messages: [userTurn, dup, toolReply], tools: [RECORD_TOOL] }, /tool/);
  // Tool history without tool definitions.
  await rejects400({ ...base, messages: [userTurn, assistantCall, toolReply] }, /tools/);
  // null content without tool calls.
  await rejects400({ ...base, messages: [userTurn, { role: 'assistant', content: null }, { role: 'user', content: 'x' }] });
});

test('AC-03 tool messages count toward the 40-message cap', async () => {
  const messages: unknown[] = [userTurn];
  for (let i = 0; i < 20; i += 1) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'record_bill', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'ok' });
  }
  await rejects400({ ...base, token_budget: 16384, messages, tools: [RECORD_TOOL] }, /between 1 and 40/);
});

test('AC-04 rejects invalid tool definitions', async () => {
  const many = Array.from({ length: 33 }, (_, i) => ({ ...RECORD_TOOL, function: { ...RECORD_TOOL.function, name: `t${i}` } }));
  const bigSchema = { type: 'object', description: 'x'.repeat(17 * 1024) };
  const cases: unknown[] = [
    many,
    [{ ...RECORD_TOOL, function: { ...RECORD_TOOL.function, name: 'bad name!' } }],
    [RECORD_TOOL, RECORD_TOOL],
    [{ ...RECORD_TOOL, function: { ...RECORD_TOOL.function, parameters: bigSchema } }],
    [{ type: 'web_search' }],
    [{ ...RECORD_TOOL, extra: true }],
    [],
    'record_bill',
  ];
  for (const tools of cases) await rejects400({ ...base, messages: [userTurn], tools });
  await rejects400({ ...base, messages: [userTurn], tools: [RECORD_TOOL], tool_choice: { type: 'function', function: { name: 'other' } } }, /tool_choice/);
  await rejects400({ ...base, messages: [userTurn], tools: [RECORD_TOOL], tool_choice: 'sometimes' }, /tool_choice/);
  await rejects400({ ...base, messages: [userTurn], tool_choice: 'auto' }, /tool_choice/);
  await rejects400({ ...base, messages: [userTurn], tools: [RECORD_TOOL], parallel_tool_calls: 'yes' }, /parallel_tool_calls/);
});

test('AC-04 assistant tool calls must name a defined tool', async () => {
  const other = { ...assistantCall, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'delete_all', arguments: '{}' } }] };
  await rejects400({ ...base, messages: [userTurn, other, toolReply], tools: [RECORD_TOOL] }, /tool/);
});

test('AC-06 forwards json_schema and rejects non-JSON replies', async () => {
  const format = { type: 'json_schema', json_schema: { name: 'bill', strict: true, schema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'], additionalProperties: false } } };
  let provider = fakeProvider(() => providerText('{"total":8450}'));
  try {
    const { response } = await generateAi({ ...base, messages: [userTurn], response_format: format }, configuredEnv());
    assert.deepEqual(provider.bodies[0].response_format, format);
    assert.equal(response.content, '{"total":8450}');
  } finally {
    provider.restore();
  }
  provider = fakeProvider(() => providerText('ยอดรวม 8450 secret-model-text'));
  try {
    await assert.rejects(() => generateAi({ ...base, messages: [userTurn], response_format: format }, configuredEnv()), (error: unknown) => {
      assert.ok(error instanceof AiGatewayError);
      assert.equal(error.status, 502);
      assert.equal(error.telemetry?.metadata.error_class, 'invalid_response');
      assert.doesNotMatch(error.message, /secret-model-text/);
      return true;
    });
  } finally {
    provider.restore();
  }
  await rejects400({ ...base, messages: [userTurn], response_format: { type: 'json_schema', json_schema: { name: 'bad name', schema: {} } } }, /response_format/);
  await rejects400({ ...base, messages: [userTurn], response_format: { type: 'json_schema', json_schema: { name: 'big', schema: { description: 'x'.repeat(17 * 1024) } } } }, /response_format/);
});

test('AC-06 a tool-call reply is exempt from the JSON check and json_schema combines with tools', async () => {
  const format = { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } };
  const provider = fakeProvider(() => providerToolCalls([{ id: 'call_1', name: 'record_bill', arguments: '{"amount":1}' }]));
  try {
    const { response } = await generateAi({ ...base, messages: [userTurn], tools: [RECORD_TOOL], response_format: format }, configuredEnv());
    assert.equal(response.content, null);
    assert.equal(response.tool_calls?.length, 1);
    assert.deepEqual(provider.bodies[0].response_format, format);
  } finally {
    provider.restore();
  }
});

test('AC-10 rejects unbounded provider tool calls', async () => {
  const replies = [
    providerToolCalls(Array.from({ length: 17 }, (_, i) => ({ id: `c${i}`, name: 'record_bill', arguments: '{}' }))),
    providerToolCalls([{ id: 'c1', name: 'record_bill', arguments: 'x'.repeat(17 * 1024) }]),
    providerToolCalls([{ id: 'c1', name: 'delete_all', arguments: '{}' }]),
    providerToolCalls([{ name: 'record_bill', arguments: '{}' }]),
    providerToolCalls([{ id: 'c1', name: 'record_bill', arguments: '{"amount":' }], 'length'),
  ];
  for (const reply of replies) {
    const provider = fakeProvider(() => reply);
    try {
      await assert.rejects(() => generateAi({ ...base, messages: [userTurn], tools: [RECORD_TOOL] }, configuredEnv()), (error: unknown) => {
        assert.ok(error instanceof AiGatewayError);
        assert.equal(error.status, 502);
        assert.equal(error.telemetry?.metadata.error_class, 'invalid_response');
        return true;
      });
    } finally {
      provider.restore();
    }
  }
});

test('AC-10 tool calls returned to a request without tools stay a bounded error', async () => {
  const provider = fakeProvider(() => providerToolCalls([{ id: 'c1', name: 'record_bill', arguments: '{}' }]));
  try {
    await assert.rejects(() => generateAi({ ...base, messages: [userTurn] }, configuredEnv()), (error: unknown) => {
      assert.ok(error instanceof AiGatewayError);
      assert.equal(error.status, 502);
      return true;
    });
  } finally {
    provider.restore();
  }
});

test('AC-11 falls back with tools and images', async () => {
  const provider = fakeProvider((_body, call) => call === 0
    ? new Response('{}', { status: 503 })
    : providerToolCalls([{ id: 'c1', name: 'record_bill', arguments: '{"amount":1}' }]));
  try {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'อ่านบิล' }, { type: 'image', data_url: jpegDataUrl() }] }];
    const { response } = await generateAi(
      { ...base, messages, tools: [RECORD_TOOL] },
      configuredEnv({ AI_GATEWAY_FALLBACK_MODEL: 'fallback-model' }),
    );
    assert.equal(provider.bodies.length, 2);
    assert.equal(provider.bodies[1].model, 'fallback-model');
    assert.deepEqual(provider.bodies[1].tools, provider.bodies[0].tools);
    assert.deepEqual(provider.bodies[1].messages, provider.bodies[0].messages);
    assert.equal(response.fallback_used, true);
    assert.equal(response.tool_calls?.length, 1);
  } finally {
    provider.restore();
  }
});

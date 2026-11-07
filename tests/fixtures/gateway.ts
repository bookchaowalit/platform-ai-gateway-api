// Shared fakes for SPEC-002 tests: a configured gateway env and a provider that records request bodies.

export function configuredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    AI_GATEWAY_PROVIDER: 'openai-compatible',
    AI_GATEWAY_PROVIDER_NAME: 'test-provider',
    AI_GATEWAY_BASE_URL: 'http://127.0.0.1:12345/v1',
    AI_GATEWAY_API_KEY: 'test-key',
    AI_GATEWAY_MODEL: 'test-model',
    AI_GATEWAY_INPUT_USD_PER_1K: '0.01',
    AI_GATEWAY_OUTPUT_USD_PER_1K: '0.02',
    AI_GATEWAY_MAX_TOKEN_BUDGET: '16384',
    ...overrides,
  };
}

export const RECORD_TOOL = {
  type: 'function',
  function: {
    name: 'record_bill',
    description: 'Record a bill amount on the ledger',
    parameters: {
      type: 'object',
      properties: { amount: { type: 'number' } },
      required: ['amount'],
      additionalProperties: false,
    },
    strict: true,
  },
};

export function providerText(content: string | null, extra: Record<string, unknown> = {}, finishReason = 'stop') {
  return {
    choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: finishReason }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
}

export function providerToolCalls(calls: Array<{ id?: string; name: string; arguments: string }>, finishReason = 'tool_calls') {
  return providerText(null, {
    tool_calls: calls.map((call) => ({
      ...(call.id === undefined ? {} : { id: call.id }),
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
  }, finishReason);
}

export interface FakeProvider {
  bodies: any[];
  restore(): void;
}

/** Replace global fetch; `reply` receives the parsed request body and the 0-based call index. */
export function fakeProvider(reply: (body: any, call: number) => unknown | Response): FakeProvider {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    bodies.push(body);
    const result = reply(body, bodies.length - 1);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = original; } };
}

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);
const JPEG_HEADER = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

export function pngDataUrl(): string {
  return `data:image/png;base64,${PNG_1X1.toString('base64')}`;
}

export function jpegDataUrl(bytes = JPEG_HEADER.length): string {
  const buffer = Buffer.alloc(Math.max(bytes, JPEG_HEADER.length));
  JPEG_HEADER.copy(buffer);
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureError,
  initSentry,
  resetSentryForTests,
  scrub,
  scrubEvent,
  type SentrySdk,
} from '../api/ai-gateway-service/sentry.js';

function fakeSdk() {
  const calls = { init: [] as Record<string, unknown>[], tags: {} as Record<string, string>, captured: [] as unknown[] };
  const sdk: SentrySdk = {
    init: (options) => calls.init.push(options),
    setTag: (key, value) => {
      calls.tags[key] = value;
    },
    captureException: (error) => calls.captured.push(error),
    flush: async () => true,
    httpIntegration: (options) => ({ name: 'Http', options }),
  };
  return { sdk, calls };
}

test('no SENTRY_DSN is a no-op and never loads the SDK', async () => {
  resetSentryForTests();
  let loaded = false;
  const enabled = await initSentry({}, async () => {
    loaded = true;
    return fakeSdk().sdk;
  });
  assert.equal(enabled, false);
  assert.equal(loaded, false);
  captureError(new Error('x')); // nothing initialised: must not throw
});

test('SENTRY_DSN initialises errors only, without PII, locals or request bodies', async () => {
  resetSentryForTests();
  const { sdk, calls } = fakeSdk();
  const lines: string[] = [];
  const enabled = await initSentry(
    { SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0', RAILWAY_SERVICE_NAME: 'ai-gateway' },
    async () => sdk,
    (line) => lines.push(line),
  );
  assert.equal(enabled, true);
  const options = calls.init[0];
  assert.equal(options.environment, 'production');
  assert.equal('tracesSampleRate' in options, false);
  assert.equal('tracesSampler' in options, false);
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.includeLocalVariables, false);
  const integrations = (options.integrations as (d: { name: string }[]) => unknown[])([
    { name: 'Console' },
    { name: 'Http' },
    { name: 'OnUncaughtException' },
  ]);
  assert.deepEqual(integrations, [{ name: 'OnUncaughtException' }, { name: 'Http', options: { maxRequestBodySize: 'none' } }]);
  assert.equal(options.enableLogs, false);
  assert.equal((options.beforeBreadcrumb as (c: unknown) => unknown)({ message: 'GET', category: 'console' }), null);
  assert.equal(typeof options.beforeSend, 'function');
  assert.deepEqual(calls.tags, { service: 'ai-gateway' });
  assert.deepEqual(lines, ['sentry: enabled for ai-gateway\n']);
  const error = new Error('boom');
  captureError(error);
  assert.deepEqual(calls.captured, [error]);
  resetSentryForTests();
});

test('scrub removes URL passwords, key=value secrets, bearer tokens and JWTs', () => {
  const jwt = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJvd25lciJ9', 'c2lnbmF0dXJl'].join('.');
  // Assembled at runtime so secret scanners do not read the synthetic URL as a credential.
  const scheme = ['postgres', 'ql://'].join('');
  const url = [scheme, 'gw:', 's3cr%40t', '@db.example.test/gw'].join('');
  const out = scrub(`connect ${url} failed; password=hunter2 Authorization: Bearer abc.def-ghi ${jwt}`);
  for (const secret of ['s3cr%40t', 'hunter2', 'abc.def-ghi', 'eyJhbGciOiJSUzI1NiJ9']) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes(`${scheme}gw:***@db.example.test/gw`));
});

test('scrubEvent keeps only the request method, drops extra and breadcrumb data', () => {
  const out = scrubEvent({
    exception: { values: [{ value: `bad url ${['postgres', '://u:', 'pw', '@h/db'].join('')}` }] },
    request: {
      method: 'POST',
      url: 'https://api.example.test/api/ai/generate?token=t',
      data: '{"prompt":"x"}',
      headers: { authorization: 'Bearer t' },
      cookies: { s: '1' },
      query_string: 'token=t',
    },
    breadcrumbs: [{ message: 'GET with Bearer abc', data: { url: 'https://x?token=t' } }],
    extra: { argv: ['--token', 't'] },
  });
  assert.equal(out.exception.values[0].value, 'bad url postgres://u:***@h/db');
  assert.deepEqual(out.request, { method: 'POST' });
  assert.equal('data' in out.breadcrumbs[0], false);
  assert.ok(!out.breadcrumbs[0].message.includes('abc'));
  assert.equal('extra' in out, false);
});

test('scrubEvent drops the dynamic sampling context', () => {
  const out = scrubEvent({ contexts: { trace: { trace_id: 't', dynamic_sampling_context: { user_id: 'alice' } } } });
  assert.deepEqual(out.contexts.trace, { trace_id: 't' });
});

test('SPEC-002 AC-09 scrubs image and tool payloads', () => {
  const image = `data:image/jpeg;base64,${Buffer.alloc(64, 7).toString('base64')}`;
  assert.equal(scrub(`bad part ${image} end`), 'bad part data:image/***;base64,*** end');
  const event = scrubEvent({
    exception: { values: [{ value: `failed on ${image}` }] },
    request: { method: 'POST', data: { messages: [{ content: image }], tools: [{ name: 'record_bill' }] } },
    extra: { tool_calls: [{ arguments: '{"amount":8450}' }] },
  });
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes('base64,/'), serialized);
  assert.ok(!serialized.includes('record_bill'));
  assert.ok(!serialized.includes('8450'));
});

test('SPEC-003 AC-16 scrubs signed R2/S3 URL query strings', () => {
  const url = 'https://acct.r2.cloudflarestorage.com/ai-media/images/a.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDMARKER%2F20261111%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261111T100000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const out = scrub(`fetch failed for ${url} done`);
  assert.doesNotMatch(out, /AKIDMARKER|0123456789abcdef0123/);
  assert.match(out, /done$/);
  assert.doesNotMatch(scrub('X-Amz-Security-Token=FQoGZXIvYXdzEMARKER&x=1'), /FQoGZXIvYXdzEMARKER/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAiBudgetGuard, getAiBudgetStatus } from '../api/ai_budget.js';
import { AiGatewayError, generateAi } from '../api/ai_gateway.js';

function fakeDatabase(spent = 0, unknown = 0) {
  return {
    prepare: () => ({ get: () => ({ spent, unknown }) }),
  };
}

test('monthly AI guard reserves and releases concurrent request estimates', async () => {
  const db = fakeDatabase(0, 0);
  const env = { LLM_LAB_MONTHLY_BUDGET_USD: '1', LLM_LAB_LEDGER_PATH: '/dev/null/ledger' } as NodeJS.ProcessEnv;
  const guard = createAiBudgetGuard(db, env);
  assert.ok(guard);
  const release = await guard.reserve(0.6);
  assert.equal(getAiBudgetStatus(db, env).active_reserved_usd, 0.6);
  await assert.rejects(() => guard.reserve(0.5), /monthly budget/i);
  release();
  release();
  assert.equal(getAiBudgetStatus(db, env).active_reserved_usd, 0);
});

test('monthly AI guard fails closed for unknown provider cost', async () => {
  const db = fakeDatabase(0, 1);
  const guard = createAiBudgetGuard(db, { LLM_LAB_MONTHLY_BUDGET_USD: '10', LLM_LAB_LEDGER_PATH: '/dev/null/ledger' } as NodeJS.ProcessEnv);
  assert.ok(guard);
  await assert.rejects(() => guard.reserve(0.1), /monthly budget/i);
  assert.equal(getAiBudgetStatus(db, { LLM_LAB_MONTHLY_BUDGET_USD: '10', LLM_LAB_LEDGER_PATH: '/dev/null/ledger' } as NodeJS.ProcessEnv).reason, 'unmetered_api_events');
});

test('monthly AI guard is opt-in when no budget is configured', () => {
  const db = fakeDatabase(0, 0);
  assert.equal(createAiBudgetGuard(db, {} as NodeJS.ProcessEnv), undefined);
  assert.equal(getAiBudgetStatus(db, {}).decision, 'unconfigured');
});

test('fixed subscription commitment reduces the shared monthly headroom', async () => {
  const db = fakeDatabase(0, 0);
  const env = {
    LLM_LAB_MONTHLY_BUDGET_USD: '10',
    AI_SUBSCRIPTION_MONTHLY_USD: '8',
    LLM_LAB_LEDGER_PATH: '/dev/null/ledger',
  } as NodeJS.ProcessEnv;
  const status = getAiBudgetStatus(db, env);
  assert.equal(status.committed_usd, 8);
  assert.equal(status.remaining_usd, 2);
  const guard = createAiBudgetGuard(db, env);
  assert.ok(guard);
  await assert.rejects(() => guard.reserve(3), /monthly budget/i);
});

test('subscription commitment larger than the shared budget fails closed', () => {
  const db = fakeDatabase(0, 0);
  const env = {
    LLM_LAB_MONTHLY_BUDGET_USD: '10',
    AI_SUBSCRIPTION_MONTHLY_USD: '11',
    LLM_LAB_LEDGER_PATH: '/dev/null/ledger',
  } as NodeJS.ProcessEnv;
  const status = getAiBudgetStatus(db, env);
  assert.equal(status.decision, 'deny');
  assert.equal(status.reason, 'subscription_exceeds_monthly_budget');
});

test('storage commitment is reserved before variable spend', async () => {
  const db = fakeDatabase(0, 0);
  const env = {
    LLM_LAB_MONTHLY_BUDGET_USD: '10',
    AI_SUBSCRIPTION_MONTHLY_USD: '3',
    AI_STORAGE_MONTHLY_USD: '2',
    LLM_LAB_LEDGER_PATH: '/dev/null/ledger',
  } as NodeJS.ProcessEnv;
  const status = getAiBudgetStatus(db, env);
  assert.equal(status.committed_usd, 5);
  assert.equal(status.subscription_monthly_usd, 3);
  assert.equal(status.storage_monthly_usd, 2);
  assert.equal(status.remaining_usd, 5);
  const guard = createAiBudgetGuard(db, env);
  assert.ok(guard);
  await assert.rejects(() => guard.reserve(6), /monthly budget/i);
});

test('storage commitment larger than the shared budget fails closed', () => {
  const db = fakeDatabase(0, 0);
  const env = {
    LLM_LAB_MONTHLY_BUDGET_USD: '10',
    AI_STORAGE_MONTHLY_USD: '11',
    LLM_LAB_LEDGER_PATH: '/dev/null/ledger',
  } as NodeJS.ProcessEnv;
  const status = getAiBudgetStatus(db, env);
  assert.equal(status.decision, 'deny');
  assert.equal(status.reason, 'storage_exceeds_monthly_budget');
});

test('simultaneous API reservations admit only the amount that fits', async () => {
  const guard = createAiBudgetGuard(fakeDatabase(), { LLM_LAB_MONTHLY_BUDGET_USD: '1', LLM_LAB_LEDGER_PATH: '/dev/null/absent' })!;
  const results = await Promise.allSettled([guard.reserve(0.6), guard.reserve(0.6)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const r of results) if (r.status === 'fulfilled') r.value();
});

test('gateway denies a request before provider fetch when the monthly cap is spent', async () => {
  const db = fakeDatabase(1, 0);
  const env = {
    AI_GATEWAY_PROVIDER: 'openai-compatible',
    AI_GATEWAY_PROVIDER_NAME: 'test-provider',
    AI_GATEWAY_BASE_URL: 'http://127.0.0.1:12345/v1',
    AI_GATEWAY_MODEL_FAST: 'test-model',
    AI_GATEWAY_MODEL_BALANCED: 'test-model',
    AI_GATEWAY_MODEL_QUALITY: 'test-model',
    AI_GATEWAY_INPUT_USD_PER_1K: '0.01',
    AI_GATEWAY_OUTPUT_USD_PER_1K: '0.02',
    LLM_LAB_MONTHLY_BUDGET_USD: '1',
    LLM_LAB_LEDGER_PATH: '/dev/null/ledger',
    NODE_ENV: 'test',
  } as NodeJS.ProcessEnv;
  const guard = createAiBudgetGuard(db, env);
  assert.ok(guard);
  let providerCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    providerCalled = true;
    return new Response('{}', { status: 200 });
  };
  try {
    await assert.rejects(
      () => generateAi(
        { route: 'coding', prompt_version: 'v1', profile: 'fast', token_budget: 512, max_output_tokens: 64, messages: [{ role: 'user', content: 'write code' }] },
        env,
        { budgetGuard: guard },
      ),
      (error: unknown) => error instanceof AiGatewayError && error.status === 429,
    );
    assert.equal(providerCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('monthly AI guard includes active GPU session reservations from the shared ledger', async () => {
  const tempDir = mkdtempSync('/tmp/ai-budget-');
  const ledgerPath = join(tempDir, 'budget-events.jsonl');
  writeFileSync(ledgerPath, JSON.stringify({
    event: 'session_started',
    session_id: 'gpu-session',
    started_at: new Date().toISOString(),
    gpu_hourly_usd: 0.8,
    gpu_count: 1,
    max_hours: 1,
    reserved_cost_usd: 0.8,
  }) + '\n');
  const db = fakeDatabase(0, 0);
  const env = { LLM_LAB_MONTHLY_BUDGET_USD: '1', LLM_LAB_LEDGER_PATH: ledgerPath } as NodeJS.ProcessEnv;
  try {
    const status = getAiBudgetStatus(db, env);
    assert.ok(Math.abs(status.active_reserved_usd + status.spent_usd! - 0.8) < 1e-6);
    const guard = createAiBudgetGuard(db, env);
    assert.ok(guard);
    await assert.rejects(() => guard.reserve(0.3), /monthly budget/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('GPU costs span months, accrue past reservation, and retain instantaneous charges', () => {
  const dir = mkdtempSync('/tmp/llm-month-');
  const path = join(dir, 'events.jsonl');
  const now = new Date();
  const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const env = { LLM_LAB_MONTHLY_BUDGET_USD: '100000', LLM_LAB_LEDGER_PATH: path };
  const start = { event: 'session_started', session_id: 'gpu', started_at: new Date(month - 3600000).toISOString(), gpu_hourly_usd: 2, gpu_count: 1, max_hours: 2 };
  const stop = { event: 'session_stopped', session_id: 'gpu', stopped_at: new Date(month + 3600000).toISOString(), actual_cost_usd: 4 };
  const write = (...events: object[]) => writeFileSync(path, events.map(e => JSON.stringify(e)).join('\n'));
  try {
    write(start, stop);
    assert.equal(getAiBudgetStatus(fakeDatabase(), env).spent_usd, 2);
    write({ ...start, started_at: stop.stopped_at }, stop);
    assert.equal(getAiBudgetStatus(fakeDatabase(), env).spent_usd, 4);
    write({ ...start, started_at: new Date(Date.now() - 3 * 3600000).toISOString(), max_hours: 1 });
    const status = getAiBudgetStatus(fakeDatabase(), env);
    assert.equal(status.reason, 'gpu_session_overdue');
    assert.equal(status.decision, 'deny');
    assert.ok(status.spent_usd! >= Math.min(6, (Date.now() - month) * 2 / 3600000) - 0.001);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown costs cannot bypass the guard merely by having budget_exceeded status', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE ai_run_telemetry (estimated_cost_usd REAL, provider TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
    db.exec("INSERT INTO ai_run_telemetry (provider, status) VALUES ('test', 'budget_exceeded')");
    const env = { LLM_LAB_MONTHLY_BUDGET_USD: '1', LLM_LAB_LEDGER_PATH: '/dev/null/absent' };
    assert.equal(getAiBudgetStatus(db, env).decision, 'deny');
    db.exec('UPDATE ai_run_telemetry SET estimated_cost_usd = 0');
    assert.equal(getAiBudgetStatus(db, env).decision, 'allow');
  } finally { db.close(); }
});

test('gateway persists telemetry while reservation is still held', async () => {
  const db = fakeDatabase();
  const env = { NODE_ENV: 'test', AI_GATEWAY_PROVIDER: 'openai-compatible', AI_GATEWAY_BASE_URL: 'http://127.0.0.1:12345/v1', AI_GATEWAY_MODEL: 'test', AI_GATEWAY_INPUT_USD_PER_1K: '0.01', AI_GATEWAY_OUTPUT_USD_PER_1K: '0.01', LLM_LAB_MONTHLY_BUDGET_USD: '1', LLM_LAB_LEDGER_PATH: '/dev/null/absent' };
  const original = globalThis.fetch;
  let recorded = false;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
  try {
    await generateAi({ route: 'test', prompt_version: 'v1', max_output_tokens: 16, messages: [{ role: 'user', content: 'test' }] }, env, {
      budgetGuard: createAiBudgetGuard(db, env),
      recordTelemetry: () => {
        recorded = true;
        assert.ok(getAiBudgetStatus(db, env).active_reserved_usd > 0);
      },
    });
    assert.ok(recorded);
    assert.equal(getAiBudgetStatus(db, env).active_reserved_usd, 0);
    await assert.rejects(() => generateAi({ route: 'test', prompt_version: 'v1', max_output_tokens: 16, messages: [{ role: 'user', content: 'test' }] }, env, {
      budgetGuard: createAiBudgetGuard(db, env),
      recordTelemetry: () => { throw new Error('database unavailable'); },
    }), /database unavailable/);
    assert.ok(getAiBudgetStatus(db, env).active_reserved_usd > 0);
  } finally { globalThis.fetch = original; }
});

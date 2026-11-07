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

// ---- SPEC-002 AC-08: per-subject monthly budget -------------------------------------------------
import { loadTelemetryMigration, openTelemetryStore } from '../api/ai-gateway-service/store.js';
import { AiBudgetError } from '../api/ai_budget.js';

function spendStore(rows: Array<{ subject: string; workspace?: string; cost: number | null }>) {
  const store = openTelemetryStore(':memory:', loadTelemetryMigration({}));
  rows.forEach((row, index) => store.record({
    run_id: `seed-${index}`,
    route: 'seed',
    prompt_version: 'seed-v1',
    provider: 'test-provider',
    model: 'test-model',
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    token_budget: 512,
    latency_ms: 1,
    estimated_cost_usd: row.cost,
    cache_hit: false,
    status: 'success',
    metadata: { subject: row.subject, ...(row.workspace ? { workspace_id: row.workspace } : {}) },
  }));
  return store;
}

const LEDGER = { LLM_LAB_LEDGER_PATH: '/dev/null/ledger' };

test('subject budget denies only that subject', async () => {
  const store = spendStore([{ subject: 'client-a', cost: 0.9 }, { subject: 'client-b', cost: 0.9 }]);
  try {
    const env = { ...LEDGER, AI_GATEWAY_SUBJECT_BUDGETS_JSON: JSON.stringify({ 'client-a': 1 }) } as NodeJS.ProcessEnv;
    const guardA = createAiBudgetGuard(store.db, env, { subject: 'client-a' });
    assert.ok(guardA);
    await assert.rejects(() => guardA.reserve(0.2), (error: unknown) => error instanceof AiBudgetError && error.reason === 'request_would_exceed_subject_budget');
    // In-flight reservations count against the subject too.
    const release = await guardA.reserve(0.06);
    await assert.rejects(() => guardA.reserve(0.06), /subject/i);
    release();
    await guardA.reserve(0.06);
    // Another subject without a subject budget and no global budget has no guard at all.
    assert.equal(createAiBudgetGuard(store.db, env, { subject: 'client-b' }), undefined);
  } finally {
    store.close();
  }
});

test('subject budget keys workspace callers by workspace:subject', async () => {
  const store = spendStore([{ subject: 'client-a', workspace: 'w1', cost: 0.9 }]);
  try {
    const env = { ...LEDGER, AI_GATEWAY_SUBJECT_BUDGETS_JSON: JSON.stringify({ 'w1:client-a': 1, 'client-a': 1 }) } as NodeJS.ProcessEnv;
    const workspaceGuard = createAiBudgetGuard(store.db, env, { subject: 'client-a', workspace: 'w1' });
    assert.ok(workspaceGuard);
    await assert.rejects(() => workspaceGuard.reserve(0.2), /subject/i);
    // The plain-token key does not see the workspace rows.
    const plainGuard = createAiBudgetGuard(store.db, env, { subject: 'client-a' });
    assert.ok(plainGuard);
    await plainGuard.reserve(0.2);
    assert.equal(createAiBudgetGuard(store.db, env, { subject: 'client-a', workspace: 'w2' }), undefined);
  } finally {
    store.close();
  }
});

test('the global budget still applies beside a subject budget', async () => {
  const store = spendStore([{ subject: 'client-b', cost: 0.95 }]);
  try {
    const env = { ...LEDGER, LLM_LAB_MONTHLY_BUDGET_USD: '1', AI_GATEWAY_SUBJECT_BUDGETS_JSON: JSON.stringify({ 'client-a': 10 }) } as NodeJS.ProcessEnv;
    const guard = createAiBudgetGuard(store.db, env, { subject: 'client-a' });
    assert.ok(guard);
    await assert.rejects(() => guard.reserve(0.1), /monthly budget exceeded/i);
    // A subject denial releases the global reservation it already took.
    const tight = { ...env, AI_GATEWAY_SUBJECT_BUDGETS_JSON: JSON.stringify({ 'client-a': 0.01 }) } as NodeJS.ProcessEnv;
    const tightGuard = createAiBudgetGuard(store.db, tight, { subject: 'client-a' });
    await assert.rejects(() => tightGuard!.reserve(0.02), /subject/i);
    assert.equal(getAiBudgetStatus(store.db, tight).active_reserved_usd, 0);
  } finally {
    store.close();
  }
});

test('subject budget fails closed on unknown cost and invalid config', async () => {
  const store = spendStore([{ subject: 'client-a', cost: null }]);
  try {
    const env = { ...LEDGER, AI_GATEWAY_SUBJECT_BUDGETS_JSON: JSON.stringify({ 'client-a': 5 }) } as NodeJS.ProcessEnv;
    await assert.rejects(() => createAiBudgetGuard(store.db, env, { subject: 'client-a' })!.reserve(0.01), /subject/i);
    for (const raw of ['{bad', '[]', '{"client-a":-1}', '{"client-a":"5"}', '{"bad key!":1}']) {
      assert.throws(() => createAiBudgetGuard(store.db, { ...LEDGER, AI_GATEWAY_SUBJECT_BUDGETS_JSON: raw } as NodeJS.ProcessEnv, { subject: 'client-a' }),
        (error: unknown) => error instanceof AiBudgetError && error.reason === 'invalid_subject_budget');
    }
  } finally {
    store.close();
  }
});

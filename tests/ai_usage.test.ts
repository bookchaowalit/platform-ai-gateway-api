import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTelemetryMigration, openTelemetryStore, type TelemetryStore } from '../api/ai-gateway-service/store.js';
import { getAiUsageReport, parseUsagePeriod } from '../api/ai_usage.js';

// SPEC-003: per-subject usage report. Synthetic subjects and routes only.
const asAny = (value: unknown): any => value;
let seq = 0;

function insert(store: TelemetryStore, row: {
  subject?: string | null;
  workspace?: string;
  route: string;
  status?: string;
  input?: number;
  output?: number;
  cost?: number | null;
  provider?: string | null;
  at: string;
}): void {
  const metadata: Record<string, unknown> = { prompt_marker_should_never_leak: 'x' };
  if (row.subject) metadata.subject = row.subject;
  if (row.workspace) metadata.workspace_id = row.workspace;
  const input = row.input ?? 0;
  const output = row.output ?? 0;
  store.db.prepare(
    `INSERT INTO ai_run_telemetry
       (run_id, route, provider, model, input_tokens, output_tokens, total_tokens,
        estimated_cost_usd, status, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `run-${++seq}`, row.route, row.provider === undefined ? 'openai' : row.provider, 'gpt-test',
    input, output, input + output, row.cost === undefined ? 0.01 : row.cost,
    row.status ?? 'success', JSON.stringify(metadata), row.at,
  );
}

function fixture(): TelemetryStore {
  const store = openTelemetryStore(':memory:', loadTelemetryMigration({}));
  // Previous month: must not count.
  insert(store, { subject: 'client-a', route: 'chat', input: 999, output: 999, cost: 9, at: '2026-10-31 23:59:59' });
  // Earlier this month.
  insert(store, { subject: 'client-a', route: 'chat', input: 100, output: 10, cost: 0.02, at: '2026-11-02 10:00:00' });
  insert(store, { subject: 'client-a', route: 'summary', input: 50, output: 5, cost: 0.01, at: '2026-11-03 10:00:00' });
  insert(store, { subject: 'client-a', route: 'chat', status: 'error', cost: null, at: '2026-11-04 10:00:00' });
  insert(store, { subject: 'client-b', route: 'digest', input: 400, output: 40, cost: 0.1, at: '2026-11-05 10:00:00' });
  insert(store, { subject: 'client-b', route: 'digest', status: 'budget_exceeded', cost: 0, provider: null, at: '2026-11-05 11:00:00' });
  insert(store, { subject: null, route: 'legacy', input: 1, output: 1, cost: 0.001, at: '2026-11-06 10:00:00' });
  // Today (2026-11-09 UTC).
  insert(store, { subject: 'client-a', route: 'chat', input: 20, output: 2, cost: 0.005, at: '2026-11-09 01:00:00' });
  insert(store, { subject: 'client-b', route: 'digest', status: 'error', cost: 0.002, at: '2026-11-09 02:00:00' });
  // Next month: must not count.
  insert(store, { subject: 'client-b', route: 'digest', cost: 5, at: '2026-12-01 00:00:00' });
  return store;
}

const NOW = new Date('2026-11-09T12:00:00Z');

test('AC-01 aggregates per subject and route for the month', () => {
  const store = fixture();
  try {
    const report = asAny(getAiUsageReport(store.db, { period: '2026-11', now: NOW }));
    assert.equal(report.view, 'all');
    assert.equal(report.period, '2026-11');
    assert.equal(report.timezone, 'UTC');
    const month = report.month;
    assert.equal(month.from, '2026-11-01T00:00:00Z');
    assert.equal(month.to, '2026-12-01T00:00:00Z');
    assert.deepEqual(month.subjects.map((s: any) => s.subject), ['client-b', 'client-a', null]);

    const a = month.subjects.find((s: any) => s.subject === 'client-a');
    assert.equal(a.calls, 4);
    assert.equal(a.success, 3);
    assert.equal(a.errors, 1);
    assert.equal(a.budget_denied, 0);
    assert.equal(a.input_tokens, 170);
    assert.equal(a.output_tokens, 17);
    assert.equal(a.total_tokens, 187);
    assert.equal(a.cost_usd, 0.035);
    assert.equal(a.unknown_cost_calls, 1);
    assert.deepEqual(a.routes.map((r: any) => [r.route, r.calls, r.cost_usd]), [['chat', 3, 0.025], ['summary', 1, 0.01]]);

    const b = month.subjects.find((s: any) => s.subject === 'client-b');
    assert.equal(b.calls, 3);
    assert.equal(b.errors, 1);
    assert.equal(b.budget_denied, 1);
    assert.equal(b.unknown_cost_calls, 0);
    assert.equal(b.cost_usd, 0.102);

    assert.equal(month.totals.calls, 8);
    assert.equal(month.totals.cost_usd, 0.138);
    assert.equal(month.totals.errors, 2);
    // Shares only in the admin view; rounded to 4 decimals, they sum to about 1.
    const shares = month.subjects.reduce((sum: number, s: any) => sum + s.cost_share, 0);
    assert.ok(Math.abs(shares - 1) < 1e-3);
  } finally {
    store.close();
  }
});

test('AC-02 reports today separately and only for the current month', () => {
  const store = fixture();
  try {
    const report = asAny(getAiUsageReport(store.db, { period: '2026-11', now: NOW }));
    assert.equal(report.today.from, '2026-11-09T00:00:00Z');
    assert.equal(report.today.to, '2026-11-10T00:00:00Z');
    assert.equal(report.today.totals.calls, 2);
    assert.deepEqual(report.today.subjects.map((s: any) => [s.subject, s.calls, s.errors]), [['client-a', 1, 0], ['client-b', 1, 1]]);

    const past = asAny(getAiUsageReport(store.db, { period: '2026-10', now: NOW }));
    assert.equal(past.today, null);
    assert.equal(past.month.totals.calls, 1);
    assert.equal(past.month.totals.cost_usd, 9);
  } finally {
    store.close();
  }
});

test('AC-04 self view returns only the caller subject and workspace, without shares', () => {
  const store = fixture();
  insert(store, { subject: 'client-a', workspace: 'ws-1', route: 'chat', cost: 1, at: '2026-11-07 10:00:00' });
  try {
    const report = asAny(getAiUsageReport(store.db, { period: '2026-11', now: NOW, caller: { subject: 'client-a' } }));
    assert.equal(report.view, 'self');
    assert.deepEqual(report.month.subjects.map((s: any) => [s.subject, s.workspace_id]), [['client-a', null]]);
    assert.equal(report.month.totals.calls, 4);
    assert.equal(report.month.subjects[0].cost_share, undefined);

    const ws = asAny(getAiUsageReport(store.db, { period: '2026-11', now: NOW, caller: { subject: 'client-a', workspace: 'ws-1' } }));
    assert.deepEqual(ws.month.subjects.map((s: any) => [s.subject, s.workspace_id, s.calls]), [['client-a', 'ws-1', 1]]);

    const nobody = asAny(getAiUsageReport(store.db, { period: '2026-11', now: NOW, caller: { subject: 'client-z' } }));
    assert.deepEqual(nobody.month.subjects, []);
    assert.equal(nobody.month.totals.calls, 0);
    assert.equal(nobody.month.totals.cost_usd, 0);
  } finally {
    store.close();
  }
});

test('AC-05 period defaults to the current UTC month and rejects malformed or future months', () => {
  assert.equal(parseUsagePeriod(null, NOW), '2026-11');
  assert.equal(parseUsagePeriod('', NOW), '2026-11');
  assert.equal(parseUsagePeriod('2026-01', NOW), '2026-01');
  assert.equal(parseUsagePeriod('2025-12', NOW), '2025-12');
  for (const bad of ['2026-13', '2026-00', '2026-1', '26-11', '2026-11-01', 'now', '2026-12', '2027-01']) {
    assert.equal(parseUsagePeriod(bad, NOW), null, bad);
  }
});

test('AC-06 report rows carry only subject, workspace, route and counters', () => {
  const store = fixture();
  try {
    const text = JSON.stringify(getAiUsageReport(store.db, { period: '2026-11', now: NOW }));
    assert.ok(!text.includes('prompt_marker_should_never_leak'));
    assert.ok(!text.includes('run-'));
    assert.ok(!text.includes('metadata'));
  } finally {
    store.close();
  }
});

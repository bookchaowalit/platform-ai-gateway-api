// SPEC-003 P1a jobs core: AC-03, AC-06, AC-07, AC-08, AC-12, AC-16 and the §4.7 rules.
// In-memory SQLite, fake queue, controllable clock. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTelemetryMigration, openTelemetryStore, type TelemetryStore } from '../api/ai-gateway-service/store.js';
import { createAiBudgetGuard } from '../api/ai_budget.js';
import { parsePayloadKeys, queueMessageSignature, refMac, type SignedQueueMessage } from '../api/media/crypto.js';
import { createMediaJobs, type MediaJobs, type MediaJobsDeps } from '../api/media/jobs.js';
import { MEDIA_GENERATION_REGISTRY_SCHEMA, type MediaGenerationRegistry } from '../api/media/registry.js';

const QUEUE_KEY = 'MARKER_queue_key_for_tests_only_32b';
const PAYLOAD_KEYS = parsePayloadKeys(JSON.stringify({ current: 'k1', keys: { k1: Buffer.alloc(32, 7).toString('base64') } }));
const PROMPT = 'a red square on white MARKER_PROMPT_TEXT';

function registry(): MediaGenerationRegistry {
  return {
    schema_version: MEDIA_GENERATION_REGISTRY_SCHEMA,
    updated_at: '2026-11-11',
    policy: { max_evaluation_age_days: 60, external_privacy_classes: ['public', 'internal'], fallback_depth: 0, lease_wait_max_ms: 1_800_000, job_timeout_ms: 1_800_000 },
    providers: {
      'vendor-a': { adapter: 'fake-sync', credential_env: 'VENDOR_A_KEY', max_concurrent: 1, max_in_flight: 2, rpm: 30, webhook: false, output_hosts: [], privacy_classes: ['public', 'internal'], terms_checked_at: '2026-11-11' },
    },
    models: {
      'a-photo': {
        provider: 'vendor-a', provider_model: 'photo-1', kind: 'image', enabled: true,
        capabilities: { aspects: ['1:1'], resolutions: ['standard'], references: 0, max_n: 4 },
        param_map: { aspect: { '1:1': { size: '1024x1024' } }, resolution: { standard: { quality: 'medium' } } },
        extra_params: { seed: { type: 'integer', min: 0, max: 100 } },
        pricing: { unit: 'image', cost_source: 'registry', cancel_policy: 'free', usd: { '1:1|standard': 0.04 }, source: 'https://vendor-a.example/pricing', checked_at: '2026-11-11' },
        own_eval: null,
      },
    },
    profiles: { 'social-photo': { kind: 'image', defaults: { aspect: '1:1', resolution: 'standard' }, models: ['a-photo'] } },
  };
}

interface Harness {
  jobs: MediaJobs;
  store: TelemetryStore;
  sent: SignedQueueMessage[];
  clock: { now: number };
  failEnqueue: { value: boolean };
  env: NodeJS.ProcessEnv;
}

function harness(env: NodeJS.ProcessEnv = {}, overrides: Partial<MediaJobsDeps> = {}): Harness {
  assert.ok(PAYLOAD_KEYS.ok);
  const store = openTelemetryStore(':memory:', loadTelemetryMigration({}));
  const sent: SignedQueueMessage[] = [];
  const clock = { now: Date.parse('2026-11-11T10:00:00Z') };
  const failEnqueue = { value: false };
  const fullEnv: NodeJS.ProcessEnv = {
    VENDOR_A_KEY: 'MARKER_vendor_key',
    AI_GATEWAY_MEDIA_MONTHLY_BUDGET_USD: '10',
    ...env,
  };
  const jobs = createMediaJobs({
    db: store.db,
    record: (event) => store.record(event),
    registry: registry(),
    env: fullEnv,
    payloadKeys: PAYLOAD_KEYS.keys,
    queueKey: QUEUE_KEY,
    now: () => new Date(clock.now),
    enqueue: async (message) => {
      if (failEnqueue.value) throw new Error('queue down');
      sent.push(message);
    },
    ...overrides,
  });
  return { jobs, store, sent, clock, failEnqueue, env: fullEnv };
}

const caller = { subject: 'client-a' };
const body = (extra: Record<string, unknown> = {}) => ({
  kind: 'image', mode: 'single', profile: 'social-photo', prompt: PROMPT, n: 1, route: 'portfolio.hero', privacy_class: 'internal', ...extra,
});

async function startLease(h: Harness, index = 0) {
  const message = h.sent[index];
  return h.jobs.lease(message.attempt_id, { reason: message.reason, dispatch_no: message.dispatch_no, sig: message.sig });
}

function attemptRow(h: Harness, id: string) {
  return h.store.db.prepare('SELECT * FROM media_attempts WHERE id = ?').get(id) as Record<string, unknown>;
}

// ---------------------------------------------------------------- AC-03

test('SPEC-003 AC-03 rejects invalid requests before anything is written', async () => {
  const h = harness();
  const cases: Array<[Record<string, unknown>, number]> = [
    [body({ prompt: '' }), 400],
    [body({ prompt: 'x'.repeat(4001) }), 400],
    [body({ kind: 'audio' }), 400],
    [body({ mode: 'batch' }), 400],
    [body({ models: ['a-photo'] }), 400],
    [{ ...body(), profile: undefined }, 400],
    [body({ profile: undefined, models: ['ghost'] }), 400],
    [body({ n: 9 }), 400],
    [body({ aspect: '21:9' }), 400],
    [body({ params: { temperature: 1 } }), 400],
    [body({ params: { seed: 101 } }), 400],
    [body({ extra_field: true }), 400],
    [body({ route: 'Bad Route!' }), 400],
    [body({ privacy_class: 'private' }), 403],
    [body({ privacy_class: 'restricted' }), 403],
    [body({ format: 'gif' }), 400],
  ];
  for (const [request, status] of cases) {
    const result = await h.jobs.create(caller, request, {});
    assert.equal(result.status, status, JSON.stringify(request).slice(0, 120));
  }
  assert.equal((h.store.db.prepare('SELECT COUNT(*) AS n FROM media_requests').get() as { n: number }).n, 0);
  assert.equal(h.sent.length, 0);
});

test('SPEC-003 AC-01 media is off until a monthly media cap and an enabled model with a credential exist', async () => {
  const noCap = harness({ AI_GATEWAY_MEDIA_MONTHLY_BUDGET_USD: '' });
  assert.equal((await noCap.jobs.create(caller, body(), {})).status, 503);
  const noKey = harness({ VENDOR_A_KEY: '' });
  const result = await noKey.jobs.create(caller, body(), {});
  assert.equal(result.status, 422);
  assert.equal((result.body as { error: string }).error, 'no_route');
  assert.deepEqual((result.body as { routing: { skipped: unknown[] } }).routing.skipped, [{ model_id: 'a-photo', reason: 'unavailable' }]);
});

// ---------------------------------------------------------------- AC-06 / AC-07

test('SPEC-003 AC-07 create writes request, payload and pending attempt in one go, then dispatches', async () => {
  const h = harness();
  const result = await h.jobs.create(caller, body({ params: { seed: 7 } }), {});
  assert.equal(result.status, 202);
  const created = result.body as { id: string; status: string; reserved_usd: number; attempts: number };
  assert.equal(created.status, 'queued');
  assert.equal(created.reserved_usd, 0.04);
  assert.equal(created.attempts, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].reason, 'start');
  const row = attemptRow(h, h.sent[0].attempt_id);
  assert.equal(row.dispatch_state, 'sent');
  const payload = h.store.db.prepare('SELECT * FROM media_request_payloads WHERE request_id = ?').get(created.id) as { ciphertext: Uint8Array };
  assert.ok(payload && !Buffer.from(payload.ciphertext).toString('utf8').includes('MARKER_PROMPT_TEXT'));
});

test('SPEC-003 AC-07 a failed enqueue leaves the attempt pending and housekeeping re-sends it with backoff', async () => {
  const h = harness();
  h.failEnqueue.value = true;
  const result = await h.jobs.create(caller, body(), {});
  assert.equal(result.status, 202);
  const id = (h.store.db.prepare('SELECT id FROM media_attempts').get() as { id: string }).id;
  assert.equal(attemptRow(h, id).dispatch_state, 'pending');
  h.failEnqueue.value = false;
  await h.jobs.housekeeping();
  assert.equal(h.sent.length, 0, 'backoff: not yet due');
  h.clock.now += 11_000;
  await h.jobs.housekeeping();
  assert.equal(h.sent.length, 1);
  assert.equal(attemptRow(h, id).dispatch_state, 'sent');
});

test('SPEC-003 §4.7 rule 7 dispatch window ends at 0 cost only when never leased', async () => {
  const h = harness();
  h.failEnqueue.value = true;
  await h.jobs.create(caller, body(), {});
  for (let i = 0; i < 12; i += 1) {
    h.clock.now += 5 * 60_000;
    await h.jobs.housekeeping();
  }
  const row = h.store.db.prepare('SELECT status, error_code, cost_usd FROM media_attempts').get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { status: 'failed', error_code: 'dispatch_error', cost_usd: 0 });
});

test('SPEC-003 AC-07 idempotency: same body returns the request, different body 409, freed after 24 h', async () => {
  const h = harness();
  const first = await h.jobs.create(caller, body(), { idempotencyKey: 'key-1' });
  const again = await h.jobs.create(caller, body(), { idempotencyKey: 'key-1' });
  assert.equal((again.body as { id: string }).id, (first.body as { id: string }).id);
  assert.equal(h.sent.length, 1, 'no second dispatch');
  const conflict = await h.jobs.create(caller, body({ prompt: 'other' }), { idempotencyKey: 'key-1' });
  assert.equal(conflict.status, 409);
  assert.equal((conflict.body as { error: string }).error, 'idempotency_conflict');
  h.clock.now += 24 * 3_600_000 + 1;
  await h.jobs.housekeeping();
  const fresh = await h.jobs.create(caller, body(), { idempotencyKey: 'key-1' });
  assert.notEqual((fresh.body as { id: string }).id, (first.body as { id: string }).id);
});

test('SPEC-003 AC-07 dry_run reserves nothing and expected_reserved_usd must match', async () => {
  const h = harness();
  const dry = await h.jobs.create(caller, body({ dry_run: true }), {});
  assert.equal(dry.status, 200);
  assert.equal((dry.body as { reserved_usd: number }).reserved_usd, 0.04);
  assert.equal((h.store.db.prepare('SELECT COUNT(*) AS n FROM media_requests').get() as { n: number }).n, 0);
  assert.equal((await h.jobs.create(caller, body({ expected_reserved_usd: 0.05 }), {})).status, 409);
  assert.equal((await h.jobs.create(caller, body({ expected_reserved_usd: 0.04 }), {})).status, 202);
});

test('SPEC-003 AC-07 per-subject active attempt cap', async () => {
  const h = harness({ AI_GATEWAY_MEDIA_MAX_ACTIVE_PER_SUBJECT: '2' });
  assert.equal((await h.jobs.create(caller, body(), {})).status, 202);
  assert.equal((await h.jobs.create(caller, body(), {})).status, 202);
  const third = await h.jobs.create(caller, body(), {});
  assert.equal(third.status, 429);
  assert.equal((third.body as { error: string }).error, 'too_many_jobs');
  assert.equal((await h.jobs.create({ subject: 'client-b' }, body(), {})).status, 202);
});

test('SPEC-003 AC-06 caps: media cap, subject cap and global cap count open reservations', async () => {
  const media = harness({ AI_GATEWAY_MEDIA_MONTHLY_BUDGET_USD: '0.1' });
  assert.equal((await media.jobs.create(caller, body({ n: 2 }), {})).status, 202);
  const over = await media.jobs.create(caller, body({ n: 1 }), {});
  assert.equal(over.status, 429);
  assert.equal((over.body as { error: string }).error, 'budget_exceeded');

  const subject = harness({ AI_GATEWAY_SUBJECT_BUDGETS_JSON: JSON.stringify({ 'client-a': 0.05 }), AI_GATEWAY_ERROR_COST_POLICY: 'bounded' });
  assert.equal((await subject.jobs.create(caller, body(), {})).status, 202);
  assert.equal((await subject.jobs.create(caller, body(), {})).status, 429);
  assert.equal((await subject.jobs.create({ subject: 'client-b' }, body(), {})).status, 202);

  const global = harness({ LLM_LAB_MONTHLY_BUDGET_USD: '0.05' });
  assert.equal((await global.jobs.create(caller, body(), {})).status, 202);
  assert.equal((await global.jobs.create({ subject: 'client-b' }, body(), {})).status, 429);
});

test('SPEC-003 AC-06 reservations survive a restart (they are rows, not memory)', async () => {
  const h = harness({ AI_GATEWAY_MEDIA_MONTHLY_BUDGET_USD: '0.05' });
  assert.equal((await h.jobs.create(caller, body(), {})).status, 202);
  const restarted = createMediaJobs({
    db: h.store.db, record: (e) => h.store.record(e), registry: registry(), env: h.env, payloadKeys: PAYLOAD_KEYS.ok ? PAYLOAD_KEYS.keys : undefined as never,
    queueKey: QUEUE_KEY, now: () => new Date(h.clock.now), enqueue: async () => undefined,
  });
  assert.equal((await restarted.create(caller, body(), {})).status, 429);
});

test('SPEC-003 AC-06 text admission counts open media reservations (NB1)', async () => {
  const h = harness({ LLM_LAB_MONTHLY_BUDGET_USD: '0.05' });
  assert.equal((await h.jobs.create(caller, body(), {})).status, 202);
  const guard = createAiBudgetGuard(h.store.db, { LLM_LAB_MONTHLY_BUDGET_USD: '0.05' });
  assert.ok(guard);
  await assert.rejects(guard.reserve(0.02), /budget exceeded/);
  const release = await guard.reserve(0.009);
  release();
});

// ---------------------------------------------------------------- AC-08 leases, reports, settlement

test('SPEC-003 AC-08 lease checks the signature and returns the execution context with the payload on start', async () => {
  const h = harness();
  await h.jobs.create(caller, body({ params: { seed: 7 } }), {});
  const message = h.sent[0];
  assert.equal((await h.jobs.lease(message.attempt_id, { ...message, sig: 'bad' })).status, 403);
  assert.equal((await h.jobs.lease(message.attempt_id, { ...message, dispatch_no: 'other' })).status, 403);
  const lease = await startLease(h);
  assert.equal(lease.status, 200);
  const leased = lease.body as { lease_id: string; attempt: Record<string, unknown>; payload: { prompt: string; params: Record<string, unknown> } };
  assert.equal(leased.attempt.provider_model, 'photo-1');
  assert.deepEqual(leased.attempt.mapped_params, { size: '1024x1024', quality: 'medium' });
  assert.equal(leased.attempt.idempotency_key, message.attempt_id);
  assert.equal(leased.payload.prompt, PROMPT);
  assert.deepEqual(leased.payload.params, { seed: 7 });
  const held = await startLease(h);
  assert.equal(held.status, 409);
  assert.equal((held.body as { error: string }).error, 'lease_held');
});

test('SPEC-003 AC-08 provider slots: max_concurrent 1 makes the second start lease wait', async () => {
  const h = harness();
  await h.jobs.create(caller, body(), {});
  await h.jobs.create({ subject: 'client-b' }, body(), {});
  assert.equal((await startLease(h, 0)).status, 200);
  const second = await startLease(h, 1);
  assert.equal(second.status, 409);
  assert.equal((second.body as { error: string }).error, 'no_slot');
  assert.ok((second.body as { retry_after_ms: number }).retry_after_ms > 0);
});

test('SPEC-003 AC-08 sync completion settles once and writes one ledger row', async () => {
  const h = harness();
  const created = await h.jobs.create(caller, body(), {});
  const lease = (await startLease(h)).body as { lease_id: string };
  const id = h.sent[0].attempt_id;
  assert.equal((await h.jobs.report(id, { lease_id: lease.lease_id, report_seq: 1, state: 'submit_started' })).status, 200);
  const done = await h.jobs.report(id, {
    lease_id: lease.lease_id, report_seq: 2, state: 'completed',
    assets: [{ object_key: 'images/x/2026/11/a.png', media_type: 'image/png', bytes: 1234, width: 1024, height: 1024, sha256: 'f'.repeat(64) }],
  });
  assert.equal(done.status, 200);
  const late = await h.jobs.report(id, { lease_id: lease.lease_id, report_seq: 3, state: 'completed', assets: [] });
  assert.equal(late.status, 409);
  const rows = h.store.db.prepare("SELECT route, provider, model, estimated_cost_usd, metadata_json FROM ai_run_telemetry WHERE route LIKE 'media.%'").all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].route, 'media.image');
  assert.equal(rows[0].estimated_cost_usd, 0.04);
  assert.equal(JSON.parse(String(rows[0].metadata_json)).subject, 'client-a');
  assert.doesNotMatch(String(rows[0].metadata_json), /MARKER_PROMPT_TEXT|images\/x/);
  const read = await h.jobs.read(caller, (created.body as { id: string }).id, { signGetUrl: async (key) => ({ url: `https://signed.example/${key}?X-Amz-Signature=abc`, expires_at: 'soon' }) });
  assert.equal(read.status, 200);
  const view = read.body as { status: string; attempts: Array<{ status: string; cost_usd: number; assets: Array<{ url: string }> }>; ai_generated: boolean };
  assert.equal(view.status, 'completed');
  assert.equal(view.ai_generated, true);
  assert.equal(view.attempts[0].cost_usd, 0.04);
  assert.match(view.attempts[0].assets[0].url, /^https:\/\/signed\.example\//);
  // The slot is free again.
  await h.jobs.create({ subject: 'client-b' }, body(), {});
  assert.equal((await startLease(h, 1)).status, 200);
});

test('SPEC-003 §4.7 rule 5 report_seq must grow and match the current lease', async () => {
  const h = harness();
  await h.jobs.create(caller, body(), {});
  const lease = (await startLease(h)).body as { lease_id: string };
  const id = h.sent[0].attempt_id;
  assert.equal((await h.jobs.report(id, { lease_id: lease.lease_id, report_seq: 2, state: 'submit_started' })).status, 200);
  assert.equal((await h.jobs.report(id, { lease_id: lease.lease_id, report_seq: 1, state: 'failed', error_code: 'provider_error' })).status, 409);
  assert.equal((await h.jobs.report(id, { lease_id: 'other', report_seq: 3, state: 'failed', error_code: 'provider_error' })).status, 409);
});

test('SPEC-003 §4.7 rules 4–6 failure before submit settles 0, after submit settles the reservation', async () => {
  const h = harness();
  await h.jobs.create(caller, body(), {});
  await h.jobs.create({ subject: 'client-b' }, body(), {});
  const a = h.sent[0].attempt_id;
  const leaseA = (await startLease(h, 0)).body as { lease_id: string };
  await h.jobs.report(a, { lease_id: leaseA.lease_id, report_seq: 1, state: 'failed', error_code: 'invalid_input' });
  assert.equal(attemptRow(h, a).cost_usd, 0);
  const b = h.sent[1].attempt_id;
  const leaseB = (await startLease(h, 1)).body as { lease_id: string };
  await h.jobs.report(b, { lease_id: leaseB.lease_id, report_seq: 1, state: 'submit_started' });
  await h.jobs.report(b, { lease_id: leaseB.lease_id, report_seq: 2, state: 'failed', error_code: 'provider_error' });
  assert.equal(attemptRow(h, b).cost_usd, 0.04);
});

test('SPEC-003 AC-08 expired start lease: leased goes back to queued; after 5 recoveries lease_exhausted', async () => {
  const h = harness();
  await h.jobs.create(caller, body(), {});
  const id = h.sent[0].attempt_id;
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await startLease(h)).status, 200, `lease ${i}`);
    h.clock.now += 121_000;
    await h.jobs.housekeeping();
  }
  assert.equal(attemptRow(h, id).lease_recoveries, 5);
  assert.equal(attemptRow(h, id).status, 'queued');
  const sixth = await startLease(h);
  assert.equal(sixth.status, 200);
  h.clock.now += 121_000;
  const exhausted = await startLease(h);
  assert.equal(exhausted.status, 409);
  assert.deepEqual({ status: attemptRow(h, id).status, error_code: attemptRow(h, id).error_code, cost_usd: attemptRow(h, id).cost_usd },
    { status: 'failed', error_code: 'lease_exhausted', cost_usd: 0 });
});

test('SPEC-003 §4.7 rule 5 heartbeat extends a lease up to 15 minutes', async () => {
  const h = harness();
  await h.jobs.create(caller, body(), {});
  const id = h.sent[0].attempt_id;
  const lease = (await startLease(h)).body as { lease_id: string };
  for (let i = 0; i < 14; i += 1) {
    h.clock.now += 60_000;
    assert.equal((await h.jobs.heartbeat(id, { lease_id: lease.lease_id })).status, 200, `beat ${i}`);
  }
  h.clock.now += 60_000;
  const capped = await h.jobs.heartbeat(id, { lease_id: lease.lease_id });
  assert.equal(capped.status, 409);
});

test('SPEC-003 AC-08 async: submitted releases the slot, polls take short uncounted leases, webhook needs the ref mac', async () => {
  const h = harness();
  await h.jobs.create(caller, body(), {});
  const id = h.sent[0].attempt_id;
  const lease = (await startLease(h)).body as { lease_id: string };
  await h.jobs.report(id, { lease_id: lease.lease_id, report_seq: 1, state: 'submit_started' });
  await h.jobs.report(id, { lease_id: lease.lease_id, report_seq: 2, state: 'submitted', provider_job_ref: 'job_123' });
  assert.equal(attemptRow(h, id).lease_id, null);
  const dispatchNo = String(attemptRow(h, id).dispatch_no);
  for (let i = 0; i < 40; i += 1) {
    const poll = { v: 1 as const, attempt_id: id, dispatch_no: dispatchNo, reason: 'poll' as const };
    const sig = await queueMessageSignature(QUEUE_KEY, poll);
    const leased = await h.jobs.lease(id, { ...poll, sig });
    assert.equal(leased.status, 200, `poll ${i}`);
    const pollLease = leased.body as { lease_id: string; attempt: { provider_job_ref: string }; payload?: unknown };
    assert.equal(pollLease.attempt.provider_job_ref, 'job_123');
    assert.equal(pollLease.payload, undefined);
    await h.jobs.report(id, { lease_id: pollLease.lease_id, report_seq: 1, state: 'submitted', provider_job_ref: 'job_123' });
    h.clock.now += 45_000;
  }
  assert.equal(attemptRow(h, id).status, 'submitted');
  assert.equal(attemptRow(h, id).lease_recoveries, 0);
  const wrong = { v: 1 as const, attempt_id: id, dispatch_no: dispatchNo, reason: 'webhook' as const, ref_mac: await refMac(QUEUE_KEY, 'job_999') };
  const wrongLease = await h.jobs.lease(id, { ...wrong, sig: await queueMessageSignature(QUEUE_KEY, wrong) });
  assert.equal(wrongLease.status, 409);
  assert.equal((wrongLease.body as { error: string }).error, 'ref_mismatch');
});

test('SPEC-003 §4.7 rule 6 attempt TTL closes a never-reported attempt', async () => {
  const h = harness();
  await h.jobs.create(caller, body(), {});
  const id = h.sent[0].attempt_id;
  const lease = (await startLease(h)).body as { lease_id: string };
  await h.jobs.report(id, { lease_id: lease.lease_id, report_seq: 1, state: 'submit_started' });
  h.clock.now += 61 * 60_000;
  await h.jobs.housekeeping();
  assert.deepEqual({ status: attemptRow(h, id).status, error_code: attemptRow(h, id).error_code, cost_usd: attemptRow(h, id).cost_usd },
    { status: 'failed', error_code: 'timeout', cost_usd: 0.04 });
});

test('SPEC-003 AC-12 reads: other subjects and unknown ids get the same 404; no-store is the caller\'s job', async () => {
  const h = harness();
  const created = await h.jobs.create(caller, body(), {});
  const sign = { signGetUrl: async () => ({ url: 'https://x', expires_at: 'soon' }) };
  const other = await h.jobs.read({ subject: 'client-b' }, (created.body as { id: string }).id, sign);
  const unknown = await h.jobs.read(caller, 'nope', sign);
  assert.equal(other.status, 404);
  assert.deepEqual(other.body, unknown.body);
});

test('SPEC-003 AC-16 nothing stored outside the payload table carries the prompt', async () => {
  const h = harness();
  await h.jobs.create(caller, body(), {});
  const lease = (await startLease(h)).body as { lease_id: string };
  const id = h.sent[0].attempt_id;
  await h.jobs.report(id, { lease_id: lease.lease_id, report_seq: 1, state: 'failed', error_code: 'content_policy' });
  for (const table of ['media_requests', 'media_attempts', 'ai_run_telemetry']) {
    const dump = JSON.stringify(h.store.db.prepare(`SELECT * FROM ${table}`).all());
    assert.doesNotMatch(dump, /MARKER_PROMPT_TEXT|red square/, table);
  }
  assert.doesNotMatch(JSON.stringify(h.sent), /MARKER_PROMPT_TEXT/);
});

test('SPEC-003 §4.7 rule 9 payloads are purged after the request is done', async () => {
  const h = harness();
  await h.jobs.create(caller, body(), {});
  const lease = (await startLease(h)).body as { lease_id: string };
  await h.jobs.report(h.sent[0].attempt_id, { lease_id: lease.lease_id, report_seq: 1, state: 'failed', error_code: 'invalid_input' });
  h.clock.now += 61 * 60_000;
  await h.jobs.housekeeping();
  assert.equal((h.store.db.prepare('SELECT COUNT(*) AS n FROM media_request_payloads').get() as { n: number }).n, 0);
});

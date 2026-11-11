// SPEC-003 §4.4 data model and §4.7 rule 9: ordered idempotent migrations, media tables, secure_delete.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MIGRATION_FILES, loadTelemetryMigration, openTelemetryStore } from '../api/ai-gateway-service/store.js';

const MEDIA_TABLES = [
  'media_requests', 'media_request_payloads', 'media_attempts', 'media_assets', 'media_votes', 'media_provider_slots',
];

function withStore<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'media-store-'));
  try {
    return fn(join(dir, 'ai-gateway.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SPEC-003 §4.4 migrations run in order and include the media migration', () => {
  assert.deepEqual(MIGRATION_FILES, ['025_ai_run_telemetry.sql', '026_media_generation.sql']);
  const sql = loadTelemetryMigration({});
  assert.ok(sql.indexOf('ai_run_telemetry') < sql.indexOf('media_requests'));
  assert.doesNotMatch(sql, /ALTER\s+TABLE/i, 'no ALTER TABLE: migrations re-run on every start');
});

test('SPEC-003 §4.4 media tables exist and a second start on the same file succeeds', () => {
  withStore((path) => {
    openTelemetryStore(path, loadTelemetryMigration({})).close();
    const store = openTelemetryStore(path, loadTelemetryMigration({}));
    try {
      const tables = new Set((store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
      for (const table of MEDIA_TABLES) assert.ok(tables.has(table), `${table} exists`);
      const attemptColumns = new Set((store.db.prepare('PRAGMA table_info(media_attempts)').all() as Array<{ name: string }>).map((r) => r.name));
      for (const column of ['dispatch_state', 'dispatch_no', 'next_dispatch_at', 'first_leased_at', 'lease_recoveries', 'poll_count',
        'submit_started_at', 'lease_id', 'lease_deadline', 'report_seq', 'reserved_usd', 'cost_usd', 'overspend_usd', 'flags',
        'cancel_requested_at', 'provider_job_ref', 'error_code']) {
        assert.ok(attemptColumns.has(column), `media_attempts.${column}`);
      }
    } finally {
      store.close();
    }
  });
});

test('SPEC-003 §4.4 one idempotency key per subject while set, free once NULL', () => {
  withStore((path) => {
    const store = openTelemetryStore(path, loadTelemetryMigration({}));
    try {
      const insert = store.db.prepare(`INSERT INTO media_requests
        (id, subject_key, subject, kind, mode, blind, route, status, reserved_usd, settled_usd, prompt_sha256, request_hash, idempotency_key)
        VALUES (?, 'client-a', 'client-a', 'image', 'single', 0, 'media.image', 'queued', 0.04, 0, 'p', 'h', ?)`);
      insert.run('r1', 'key-1');
      assert.throws(() => insert.run('r2', 'key-1'), /UNIQUE/);
      insert.run('r3', null);
      insert.run('r4', null);
      store.db.prepare("UPDATE media_requests SET idempotency_key = NULL WHERE id = 'r1'").run();
      insert.run('r5', 'key-1');
    } finally {
      store.close();
    }
  });
});

test('SPEC-003 §4.4 payload nonces are unique and human votes default the judge columns', () => {
  withStore((path) => {
    const store = openTelemetryStore(path, loadTelemetryMigration({}));
    try {
      const payload = store.db.prepare(`INSERT INTO media_request_payloads (request_id, ciphertext, nonce, key_id, purge_after)
        VALUES (?, x'00', ?, 'k1', datetime('now', '+7 days'))`);
      payload.run('r1', 'n1');
      assert.throws(() => payload.run('r2', 'n1'), /UNIQUE/);
      const vote = store.db.prepare(`INSERT INTO media_votes (request_id, subject, source, scores_json) VALUES ('r1', 'client-a', 'api', '{}')
        ON CONFLICT (request_id, subject, voter_label, source, judge_attempt_id, judge_id) DO UPDATE SET scores_json = excluded.scores_json`);
      vote.run();
      vote.run();
      assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM media_votes').get() as { n: number }).n, 1);
    } finally {
      store.close();
    }
  });
});

test('SPEC-003 §4.7 rule 9 secure_delete is on for the store connection', () => {
  withStore((path) => {
    const store = openTelemetryStore(path, loadTelemetryMigration({}));
    try {
      assert.equal((store.db.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete, 1);
    } finally {
      store.close();
    }
  });
});

test('SPEC-003 §4.4 the image and the bundle ship every migration file', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY database\/migrations\/ \/build\/database\/migrations\//);
  const build = JSON.parse(readFileSync(new URL('../api/ai-gateway-service/package.json', import.meta.url), 'utf8')).scripts.build as string;
  assert.match(build, /cpSync\('\.\.\/\.\.\/database\/migrations','dist\/migrations'/);
});

test('SPEC-003 §4.4 AI_GATEWAY_MIGRATION_PATH names the telemetry file actually read', async () => {
  const { mkdirSync, writeFileSync, copyFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'media-migrations-'));
  try {
    const source = new URL('../database/migrations/', import.meta.url);
    copyFileSync(new URL('025_ai_run_telemetry.sql', source), join(dir, '025_ai_run_telemetry.sql'));
    copyFileSync(new URL('026_media_generation.sql', source), join(dir, '026_media_generation.sql'));
    mkdirSync(join(dir, 'custom'), { recursive: true });
    writeFileSync(join(dir, 'telemetry-custom.sql'), '-- custom telemetry marker\n' + readFileSync(join(dir, '025_ai_run_telemetry.sql'), 'utf8'));
    const sql = loadTelemetryMigration({ AI_GATEWAY_MIGRATION_PATH: join(dir, 'telemetry-custom.sql') });
    assert.match(sql, /custom telemetry marker/);
    assert.match(sql, /media_requests/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

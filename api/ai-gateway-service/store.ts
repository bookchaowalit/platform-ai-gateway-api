/**
 * Durable, content-free telemetry store for the hosted AI gateway.
 *
 * Uses Node's built-in `node:sqlite` (Node 22.13+) so the container needs no
 * native module. The schema is the shared `ai_run_telemetry` migration; only
 * scalar run metadata is stored, never prompts or generated text. The budget
 * guard reads month-to-date spend from this table, so keeping the file on a
 * persistent volume keeps the cap effective across restarts and redeploys.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AiTelemetryEvent } from '../ai_gateway.js';

export const TELEMETRY_MIGRATION_FILE = '025_ai_run_telemetry.sql';
/** Run in this order on every start; each file is idempotent (CREATE ... IF NOT EXISTS, no ALTER). SPEC-003 §4.4. */
export const MIGRATION_FILES = [TELEMETRY_MIGRATION_FILE, '026_media_generation.sql'] as const;

const REQUIRED_COLUMNS = [
  'run_id', 'route', 'prompt_version', 'provider', 'model', 'input_tokens', 'output_tokens',
  'total_tokens', 'token_budget', 'latency_ms', 'estimated_cost_usd', 'cache_hit', 'status',
  'metadata_json', 'created_at',
];

const UPSERT_SQL = `
  INSERT INTO ai_run_telemetry
    (run_id, route, prompt_version, provider, model, input_tokens,
     output_tokens, total_tokens, token_budget, latency_ms,
     estimated_cost_usd, cache_hit, status, metadata_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id) DO UPDATE SET
    route=excluded.route,
    prompt_version=excluded.prompt_version,
    provider=excluded.provider,
    model=excluded.model,
    input_tokens=excluded.input_tokens,
    output_tokens=excluded.output_tokens,
    total_tokens=excluded.total_tokens,
    token_budget=excluded.token_budget,
    latency_ms=excluded.latency_ms,
    estimated_cost_usd=excluded.estimated_cost_usd,
    cache_hit=excluded.cache_hit,
    status=excluded.status,
    metadata_json=excluded.metadata_json
`;

export interface TelemetryStore {
  /** Database handle consumed by the shared budget guard. */
  readonly db: DatabaseSync;
  record(event: AiTelemetryEvent): void;
  ping(): boolean;
  close(): void;
}

/**
 * Load every migration in MIGRATION_FILES, in order, as one SQL script. Source layout:
 * api/ai-gateway-service → database/migrations. Bundled layout: dist/migrations next to the
 * server bundle. AI_GATEWAY_MIGRATION_PATH (path of the telemetry migration, any name) overrides
 * both: that exact file is read, and the other files come from the same directory.
 */
export function loadTelemetryMigration(env: NodeJS.ProcessEnv = process.env, moduleUrl = import.meta.url): string {
  const here = dirname(fileURLToPath(moduleUrl));
  const override = env.AI_GATEWAY_MIGRATION_PATH?.trim();
  // Each layout: [telemetry file path, directory of the other migration files].
  const layouts: Array<[string, string]> = [
    ...(override ? [[override, dirname(override)] as [string, string]] : []),
    [`${here}/migrations/${TELEMETRY_MIGRATION_FILE}`, `${here}/migrations`],
    [`${here}/../../database/migrations/${TELEMETRY_MIGRATION_FILE}`, `${here}/../../database/migrations`],
  ];
  for (const [telemetryFile, directory] of layouts) {
    const rest = MIGRATION_FILES.slice(1).map((file) => `${directory}/${file}`);
    if (existsSync(telemetryFile) && rest.every((file) => existsSync(file))) {
      return [telemetryFile, ...rest].map((file) => readFileSync(file, 'utf8')).join('\n');
    }
  }
  throw new Error(`migrations ${MIGRATION_FILES.join(', ')} were not found`);
}

export function openTelemetryStore(path: string, migrationSql: string): TelemetryStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    // Spend rows gate the monthly budget, so favor durability over latency.
    db.exec('PRAGMA synchronous = FULL');
    // SPEC-003 §4.7 rule 9: deleted payload ciphertext is overwritten (a connection setting).
    db.exec('PRAGMA secure_delete = ON');
    db.exec(migrationSql);
    const columns = new Set(
      (db.prepare('PRAGMA table_info(ai_run_telemetry)').all() as Array<{ name: string }>).map((row) => row.name),
    );
    const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length) throw new Error(`ai_run_telemetry is missing columns: ${missing.join(', ')}`);
  } catch (error) {
    db.close();
    throw error;
  }

  const upsert = db.prepare(UPSERT_SQL);
  const ping = db.prepare('SELECT 1 AS ok');
  let closed = false;
  return {
    db,
    record(event: AiTelemetryEvent): void {
      upsert.run(
        event.run_id,
        event.route,
        event.prompt_version,
        event.provider,
        event.model,
        event.input_tokens,
        event.output_tokens,
        event.total_tokens,
        event.token_budget,
        event.latency_ms,
        event.estimated_cost_usd,
        event.cache_hit ? 1 : 0,
        event.status,
        JSON.stringify(event.metadata),
      );
    },
    ping(): boolean {
      if (closed) return false;
      try {
        return (ping.get() as { ok?: number } | undefined)?.ok === 1;
      } catch {
        return false;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

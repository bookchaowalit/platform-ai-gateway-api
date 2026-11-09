/**
 * SPEC-003: per-subject usage report over the content-free telemetry table.
 *
 * Every system shares one provider key, so the only split is the gateway token
 * subject each row carries in metadata.subject. The report returns subject,
 * workspace id, route and counters only: never run ids, prompts, outputs or
 * raw metadata. Periods are UTC months, the same window the budget guard uses.
 */

import type { DatabaseSync } from 'node:sqlite';

export const AI_USAGE_REPORT = 'ai-gateway.usage.v1' as const;

/** Literal scope (on a scoped static token) that widens the report to all subjects. */
export const AI_USAGE_ADMIN_SCOPE = 'ai:usage';

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface UsageCounters {
  calls: number;
  success: number;
  errors: number;
  budget_denied: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  unknown_cost_calls: number;
}

export interface UsageRoute extends UsageCounters { route: string }

export interface UsageSubject extends UsageCounters {
  subject: string | null;
  workspace_id: string | null;
  /** Share of the window's cost; admin view only. */
  cost_share?: number;
  routes: UsageRoute[];
}

export interface UsageWindow {
  from: string;
  to: string;
  totals: UsageCounters;
  subjects: UsageSubject[];
}

export interface AiUsageReport {
  report: typeof AI_USAGE_REPORT;
  view: 'all' | 'self';
  period: string;
  timezone: 'UTC';
  generated_at: string;
  month: UsageWindow;
  /** Today (UTC); null when the period is not the current month. */
  today: UsageWindow | null;
}

export interface UsageCaller {
  subject: string;
  workspace?: string;
}

export interface UsageReportOptions {
  period: string;
  now?: Date;
  /** Omitted: admin view of every subject. Given: only this subject (and workspace). */
  caller?: UsageCaller;
}

const pad = (value: number) => String(value).padStart(2, '0');
const monthOf = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
const sqliteTimestamp = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');
const isoSeconds = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;
const round = (value: number, digits = 6) => Number(value.toFixed(digits));

/** `YYYY-MM` not after the current UTC month; empty means the current month; anything else is null. */
export function parseUsagePeriod(raw: string | null | undefined, now = new Date()): string | null {
  if (raw === null || raw === undefined || raw === '') return monthOf(now);
  if (!PERIOD.test(raw)) return null;
  return raw > monthOf(now) ? null : raw;
}

const GROUP_SQL = `
  SELECT json_extract(metadata_json, '$.subject') AS subject,
         json_extract(metadata_json, '$.workspace_id') AS workspace_id,
         route,
         COUNT(*) AS calls,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
         SUM(CASE WHEN status = 'budget_exceeded' THEN 1 ELSE 0 END) AS budget_denied,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(estimated_cost_usd), 0) AS cost_usd,
         SUM(CASE WHEN estimated_cost_usd IS NULL AND provider IS NOT NULL THEN 1 ELSE 0 END) AS unknown_cost_calls
    FROM ai_run_telemetry
   WHERE created_at >= ? AND created_at < ?`;

const SELF_FILTER = `
     AND json_extract(metadata_json, '$.subject') = ?
     AND COALESCE(json_extract(metadata_json, '$.workspace_id'), '') = ?`;

const GROUP_BY = ' GROUP BY 1, 2, 3';

const COUNTER_KEYS: Array<keyof UsageCounters> = [
  'calls', 'success', 'errors', 'budget_denied', 'input_tokens', 'output_tokens', 'total_tokens', 'cost_usd', 'unknown_cost_calls',
];

function emptyCounters(): UsageCounters {
  return { calls: 0, success: 0, errors: 0, budget_denied: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0, unknown_cost_calls: 0 };
}

function addInto(target: UsageCounters, source: UsageCounters): void {
  for (const key of COUNTER_KEYS) target[key] += source[key];
}

function finish<T extends UsageCounters>(counters: T): T {
  counters.cost_usd = round(counters.cost_usd);
  return counters;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function buildWindow(db: DatabaseSync, start: Date, end: Date, caller: UsageCaller | undefined): UsageWindow {
  const sql = GROUP_SQL + (caller ? SELF_FILTER : '') + GROUP_BY;
  const params: string[] = [sqliteTimestamp(start), sqliteTimestamp(end)];
  if (caller) params.push(caller.subject, caller.workspace || '');
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  const subjects = new Map<string, UsageSubject>();
  const totals = emptyCounters();
  for (const row of rows) {
    const counters = emptyCounters();
    for (const key of COUNTER_KEYS) {
      const value = Number(row[key] ?? 0);
      if (!Number.isFinite(value)) throw new Error('non-finite usage row');
      counters[key] = value;
    }
    const subject = textOrNull(row.subject);
    const workspace = textOrNull(row.workspace_id);
    const key = JSON.stringify([subject, workspace]);
    let entry = subjects.get(key);
    if (!entry) {
      entry = { subject, workspace_id: workspace, ...emptyCounters(), routes: [] };
      subjects.set(key, entry);
    }
    addInto(entry, counters);
    addInto(totals, counters);
    entry.routes.push({ route: String(row.route), ...counters });
  }

  const byCost = <T extends UsageCounters>(left: T, right: T) => right.cost_usd - left.cost_usd || right.calls - left.calls;
  const list = [...subjects.values()].sort((left, right) => byCost(left, right)
    || String(left.subject ?? '￿').localeCompare(String(right.subject ?? '￿'))
    || String(left.workspace_id ?? '').localeCompare(String(right.workspace_id ?? '')));
  for (const entry of list) {
    entry.routes.sort((left, right) => byCost(left, right) || left.route.localeCompare(right.route));
    entry.routes.forEach(finish);
    if (!caller) entry.cost_share = totals.cost_usd > 0 ? round(entry.cost_usd / totals.cost_usd, 4) : 0;
    finish(entry);
  }
  return { from: isoSeconds(start), to: isoSeconds(end), totals: finish(totals), subjects: list };
}

/** Throws on a store error; callers answer 503 rather than a partial report. */
export function getAiUsageReport(db: DatabaseSync, options: UsageReportOptions): AiUsageReport {
  const now = options.now ?? new Date();
  const match = PERIOD.exec(options.period);
  if (!match) throw new Error('invalid usage period');
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const monthWindow = buildWindow(db, new Date(Date.UTC(year, month, 1)), new Date(Date.UTC(year, month + 1, 1)), options.caller);
  const isCurrent = options.period === monthOf(now);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  return {
    report: AI_USAGE_REPORT,
    view: options.caller ? 'self' : 'all',
    period: options.period,
    timezone: 'UTC',
    generated_at: now.toISOString(),
    month: monthWindow,
    today: isCurrent ? buildWindow(db, dayStart, dayEnd, options.caller) : null,
  };
}

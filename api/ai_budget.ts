import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Process-local reservation guard for the Central AI Gateway.
 *
 * The guard is opt-in: without LLM_LAB_MONTHLY_BUDGET_USD the existing
 * provider-neutral gateway behavior is unchanged. Once a monthly budget is
 * configured, every request needs a measurable rate card (or the explicit,
 * operator-owned LLM_LAB_ALLOW_UNMETERED_API override) and is checked against
 * fixed human subscription and storage commitments, month-to-date API
 * telemetry, and GPU session reservations before the provider call.
 */

export interface AiBudgetStatus {
  contract: 'solo-empire.llm-lab-budget.v1';
  configured: boolean;
  period: string;
  budget_usd: number | null;
  hard_stop_ratio: number;
  effective_budget_usd: number | null;
  spent_usd: number | null;
  committed_usd: number | null;
  subscription_monthly_usd: number | null;
  storage_monthly_usd: number | null;
  active_reserved_usd: number;
  remaining_usd: number | null;
  unknown_cost_events: number | null;
  decision: 'allow' | 'deny' | 'unavailable' | 'unconfigured';
  reason: string;
}

export class AiBudgetError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = 'AiBudgetError';
    this.reason = reason;
  }
}

export interface AiBudgetGuard {
  reserve(estimatedCostUsd: number | null): Promise<() => void>;
}

type SqliteDatabase = {
  prepare: (sql: string) => { get: (...parameters: any[]) => Record<string, unknown> | undefined };
};

const CONTRACT = 'solo-empire.llm-lab-budget.v1' as const;
const reservationState = new WeakMap<object, number>();
// SPEC-002 AC-08: in-flight reservations per budget key, so concurrent calls of one subject add up.
const subjectReservationState = new WeakMap<object, Map<string, number>>();
const SUBJECT_BUDGET_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;

/** The authenticated caller a subject budget applies to; workspace JWT callers carry a workspace. */
export interface AiBudgetCaller {
  subject: string;
  workspace?: string;
}

/** Same key as the rate limiter: `workspace:subject` for workspace callers, else the subject. */
export function aiBudgetKey(caller: AiBudgetCaller): string {
  return caller.workspace ? `${caller.workspace}:${caller.subject}` : caller.subject;
}
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function parseNumber(raw: string | undefined, fallback: number | null): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseBoolean(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((raw || '').trim().toLowerCase());
}

function periodBounds(now = new Date()): { period: string; start: string; end: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const startDate = new Date(Date.UTC(year, month, 1));
  const endDate = new Date(Date.UTC(year, month + 1, 1));
  const pad = (value: number) => String(value).padStart(2, '0');
  const period = `${year}-${pad(month + 1)}`;
  const sqliteTimestamp = (value: Date) => value.toISOString().slice(0, 19).replace('T', ' ');
  return { period, start: sqliteTimestamp(startDate), end: sqliteTimestamp(endDate) };
}

function config(env: NodeJS.ProcessEnv): {
  budget: number | null;
  ratio: number;
  allowUnmetered: boolean;
  subscriptionMonthlyUsd: number;
  storageMonthlyUsd: number;
} {
  const rawBudget = env.LLM_LAB_MONTHLY_BUDGET_USD || env.AI_GATEWAY_MONTHLY_BUDGET_USD;
  const budget = parseNumber(rawBudget, null);
  const rawSubscription = env.AI_SUBSCRIPTION_MONTHLY_USD || env.LLM_LAB_SUBSCRIPTION_MONTHLY_USD;
  const subscriptionMonthlyUsd = parseNumber(rawSubscription, 0);
  const rawStorage = env.AI_STORAGE_MONTHLY_USD || env.LLM_LAB_STORAGE_MONTHLY_USD;
  const storageMonthlyUsd = parseNumber(rawStorage, 0);
  const ratio = parseNumber(env.LLM_LAB_HARD_STOP_RATIO, 1);
  if (budget !== null && budget < 0) throw new AiBudgetError('LLM lab monthly budget is invalid', 'invalid_budget');
  if (rawBudget && budget === null) throw new AiBudgetError('LLM lab monthly budget is invalid', 'invalid_budget');
  if (subscriptionMonthlyUsd === null || subscriptionMonthlyUsd < 0) throw new AiBudgetError('AI subscription monthly cost is invalid', 'invalid_subscription_cost');
  if (storageMonthlyUsd === null || storageMonthlyUsd < 0) throw new AiBudgetError('AI storage monthly cost is invalid', 'invalid_storage_cost');
  if (ratio === null || ratio <= 0 || ratio > 1) throw new AiBudgetError('LLM lab hard stop ratio is invalid', 'invalid_hard_stop_ratio');
  return {
    budget,
    ratio,
    allowUnmetered: parseBoolean(env.LLM_LAB_ALLOW_UNMETERED_API),
    subscriptionMonthlyUsd,
    storageMonthlyUsd,
  };
}

function querySpend(db: SqliteDatabase, bounds = periodBounds()): { spent: number; unknown: number } {
  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS spent,
              COALESCE(SUM(CASE WHEN estimated_cost_usd IS NULL
                                      AND provider IS NOT NULL
                                THEN 1 ELSE 0 END), 0) AS unknown
         FROM ai_run_telemetry
        WHERE created_at >= ? AND created_at < ?`,
    ).get(bounds.start, bounds.end) || {};
    const spent = Number(row.spent || 0);
    const unknown = Number(row.unknown || 0);
    if (!Number.isFinite(spent) || !Number.isFinite(unknown)) throw new Error('non-finite budget row');
    return { spent, unknown };
  } catch {
    throw new AiBudgetError('AI budget cost signal is unavailable', 'cost_signal_unavailable');
  }
}

function queryGpuLedger(env: NodeJS.ProcessEnv, period: string): { spent: number; reserved: number; unknown: number; status: 'available' | 'unavailable'; overdue?: boolean } {
  const rawPath = env.LLM_LAB_LEDGER_PATH || 'data/generated/llm-lab/budget-events.jsonl';
  const path = rawPath.startsWith('/') ? rawPath : resolve(REPO_ROOT, rawPath);
  if (!existsSync(path)) return { spent: 0, reserved: 0, unknown: 0, status: 'available' };
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return { spent: 0, reserved: 0, unknown: 1, status: 'unavailable' };
  }
  const active = new Map<string, { started: number; rate: number; hours: number }>();
  const seen = new Set<string>();
  const now = Date.now();
  const windowStart = Date.parse(`${period}-01T00:00:00Z`);
  const startDate = new Date(windowStart);
  const windowEnd = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1);
  const overlap = (start: number, end: number) => Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart));
  let spent = 0;
  let unknown = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const id = typeof event.session_id === 'string' ? event.session_id : '';
      if (!id || (event.event !== 'session_started' && event.event !== 'session_stopped')) throw new Error('invalid ledger event');
      if (event.event === 'session_started') {
        const started = Date.parse(String(event.started_at));
        const rate = Number(event.gpu_hourly_usd);
        const count = Number(event.gpu_count);
        const hours = Number(event.max_hours);
        if (!Number.isFinite(started) || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(hours) || hours <= 0 || !Number.isInteger(count) || count < 1 || count > 64 || seen.has(id)) throw new Error('invalid session start');
        seen.add(id);
        active.set(id, { started, rate: rate * count, hours });
      } else {
        const actual = Number(event.actual_cost_usd);
        const stoppedAt = Date.parse(String(event.stopped_at));
        const start = active.get(id);
        if (!start || event.actual_cost_usd == null || !Number.isFinite(actual) || actual < 0 || !Number.isFinite(stoppedAt) || stoppedAt < start.started) throw new Error('invalid session stop');
        const duration = stoppedAt - start.started;
        spent += duration === 0 ? (stoppedAt >= windowStart && stoppedAt < windowEnd ? actual : 0) : actual * overlap(start.started, stoppedAt) / duration;
        active.delete(id);
      }
    } catch {
      unknown += 1;
    }
  }
  let reserved = 0;
  let overdue = false;
  for (const item of active.values()) {
    spent += overlap(item.started, now) * item.rate / 3600000;
    reserved += Math.max(0, item.hours - Math.max(0, now - item.started) / 3600000) * item.rate;
    overdue ||= now >= item.started + item.hours * 3600000;
  }
  return { spent, reserved, overdue, unknown, status: unknown ? 'unavailable' : 'available' };
}

export function getAiBudgetStatus(db: SqliteDatabase, env: NodeJS.ProcessEnv = process.env): AiBudgetStatus {
  const bounds = periodBounds();
  let settings: ReturnType<typeof config>;
  try {
    settings = config(env);
  } catch (error) {
    const reason = error instanceof AiBudgetError ? error.reason : 'invalid_configuration';
    return {
      contract: CONTRACT,
      configured: true,
      period: bounds.period,
      budget_usd: null,
      hard_stop_ratio: 1,
      effective_budget_usd: null,
      spent_usd: null,
      committed_usd: null,
      subscription_monthly_usd: null,
      storage_monthly_usd: null,
      active_reserved_usd: reservationState.get(db as object) || 0,
      remaining_usd: null,
      unknown_cost_events: null,
      decision: 'deny',
      reason,
    };
  }
  if (settings.budget === null) {
    return {
      contract: CONTRACT,
      configured: false,
      period: bounds.period,
      budget_usd: null,
      hard_stop_ratio: settings.ratio,
      effective_budget_usd: null,
      spent_usd: null,
      committed_usd: Number((settings.subscriptionMonthlyUsd + settings.storageMonthlyUsd).toFixed(8)),
      subscription_monthly_usd: settings.subscriptionMonthlyUsd,
      storage_monthly_usd: settings.storageMonthlyUsd,
      active_reserved_usd: reservationState.get(db as object) || 0,
      remaining_usd: null,
      unknown_cost_events: null,
      decision: 'unconfigured',
      reason: 'monthly_budget_not_configured',
    };
  }
  let spend: { spent: number; unknown: number };
  try {
    spend = querySpend(db, bounds);
  } catch (error) {
    return {
      contract: CONTRACT,
      configured: true,
      period: bounds.period,
      budget_usd: settings.budget,
      hard_stop_ratio: settings.ratio,
      effective_budget_usd: Number((settings.budget * settings.ratio).toFixed(8)),
      spent_usd: null,
      committed_usd: Number((settings.subscriptionMonthlyUsd + settings.storageMonthlyUsd).toFixed(8)),
      subscription_monthly_usd: settings.subscriptionMonthlyUsd,
      storage_monthly_usd: settings.storageMonthlyUsd,
      active_reserved_usd: reservationState.get(db as object) || 0,
      remaining_usd: null,
      unknown_cost_events: null,
      decision: 'unavailable',
      reason: error instanceof AiBudgetError ? error.reason : 'cost_signal_unavailable',
    };
  }
  const gpu = queryGpuLedger(env, bounds.period);
  if (gpu.status !== 'available') {
    return {
      contract: CONTRACT,
      configured: true,
      period: bounds.period,
      budget_usd: settings.budget,
      hard_stop_ratio: settings.ratio,
      effective_budget_usd: Number((settings.budget * settings.ratio).toFixed(8)),
      spent_usd: null,
      committed_usd: Number((settings.subscriptionMonthlyUsd + settings.storageMonthlyUsd).toFixed(8)),
      subscription_monthly_usd: settings.subscriptionMonthlyUsd,
      storage_monthly_usd: settings.storageMonthlyUsd,
      active_reserved_usd: reservationState.get(db as object) || 0,
      remaining_usd: null,
      unknown_cost_events: spend.unknown + gpu.unknown,
      decision: 'unavailable',
      reason: 'gpu_cost_signal_unavailable',
    };
  }
  const effective = Number((settings.budget * settings.ratio).toFixed(8));
  const subscriptionCommitted = Number(settings.subscriptionMonthlyUsd.toFixed(8));
  const storageCommitted = Number(settings.storageMonthlyUsd.toFixed(8));
  const committed = Number((subscriptionCommitted + storageCommitted).toFixed(8));
  const active = (reservationState.get(db as object) || 0) + gpu.reserved;
  const totalSpent = spend.spent + gpu.spent;
  const remaining = Number((effective - committed - totalSpent - active).toFixed(8));
  const unknownCostEvents = spend.unknown + gpu.unknown;
  const reason = gpu.overdue ? 'gpu_session_overdue' : committed > effective + 1e-9
    ? subscriptionCommitted > effective + 1e-9
      ? 'subscription_exceeds_monthly_budget'
      : storageCommitted > effective + 1e-9
        ? 'storage_exceeds_monthly_budget'
        : 'fixed_commitments_exceed_monthly_budget'
    : unknownCostEvents > 0 && !settings.allowUnmetered
      ? 'unmetered_api_events'
      : remaining < 0
        ? 'monthly_budget_exceeded'
        : 'within_budget';
  return {
    contract: CONTRACT,
    configured: true,
    period: bounds.period,
    budget_usd: settings.budget,
    hard_stop_ratio: settings.ratio,
    effective_budget_usd: effective,
    spent_usd: Number(totalSpent.toFixed(8)),
    committed_usd: committed,
    subscription_monthly_usd: subscriptionCommitted,
    storage_monthly_usd: storageCommitted,
    active_reserved_usd: Number(active.toFixed(8)),
    remaining_usd: remaining,
    unknown_cost_events: unknownCostEvents,
    decision: reason === 'within_budget' ? 'allow' : 'deny',
    reason,
  };
}

/** AI_GATEWAY_SUBJECT_BUDGETS_JSON: {"<budget key>": monthly USD}. Any malformed value fails closed. */
function subjectBudgets(env: NodeJS.ProcessEnv): Map<string, number> | null {
  const raw = (env.AI_GATEWAY_SUBJECT_BUDGETS_JSON || '').trim();
  if (!raw) return null;
  const invalid = () => new AiBudgetError('AI subject budget configuration is invalid', 'invalid_subject_budget');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const budgets = new Map<string, number>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SUBJECT_BUDGET_KEY.test(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid();
    budgets.set(key, value);
  }
  return budgets;
}

/** Startup check: null when AI_GATEWAY_SUBJECT_BUDGETS_JSON is unset or valid, else a fixed message. */
export function subjectBudgetConfigError(env: NodeJS.ProcessEnv): string | null {
  try { subjectBudgets(env); return null; } catch { return 'AI_GATEWAY_SUBJECT_BUDGETS_JSON is invalid'; }
}

function querySubjectSpend(db: SqliteDatabase, caller: AiBudgetCaller, bounds = periodBounds()): { spent: number; unknown: number } {
  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS spent,
              COALESCE(SUM(CASE WHEN estimated_cost_usd IS NULL
                                      AND provider IS NOT NULL
                                THEN 1 ELSE 0 END), 0) AS unknown
         FROM ai_run_telemetry
        WHERE created_at >= ? AND created_at < ?
          AND json_extract(metadata_json, '$.subject') = ?
          AND COALESCE(json_extract(metadata_json, '$.workspace_id'), '') = ?`,
    ).get(bounds.start, bounds.end, caller.subject, caller.workspace || '') || {};
    const spent = Number(row.spent || 0);
    const unknown = Number(row.unknown || 0);
    if (!Number.isFinite(spent) || !Number.isFinite(unknown)) throw new Error('non-finite budget row');
    return { spent, unknown };
  } catch {
    throw new AiBudgetError('AI subject budget cost signal is unavailable', 'cost_signal_unavailable');
  }
}

function reserveSubject(db: SqliteDatabase, caller: AiBudgetCaller, limit: number, estimatedCostUsd: number | null, allowUnmetered: boolean): () => void {
  if (estimatedCostUsd !== null && (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0)) {
    throw new AiBudgetError('AI request cost estimate is invalid', 'invalid_cost_estimate');
  }
  if (estimatedCostUsd === null && !allowUnmetered) {
    throw new AiBudgetError('AI request has no measurable rate card for the subject budget', 'unmetered_request');
  }
  const spend = querySubjectSpend(db, caller);
  if (spend.unknown > 0 && !allowUnmetered) {
    throw new AiBudgetError('AI subject monthly budget is not available', 'unmetered_api_events');
  }
  const key = aiBudgetKey(caller);
  const reservations = subjectReservationState.get(db as object) ?? new Map<string, number>();
  subjectReservationState.set(db as object, reservations);
  const estimate = estimatedCostUsd || 0;
  const current = reservations.get(key) || 0;
  if (spend.spent + current + estimate > limit + 1e-9) {
    throw new AiBudgetError('AI subject monthly budget exceeded', 'request_would_exceed_subject_budget');
  }
  reservations.set(key, current + estimate);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservations.set(key, Math.max(0, (reservations.get(key) || 0) - estimate));
  };
}

/**
 * Reservation guard for one request. The global monthly budget (when configured) and the caller's
 * own subject budget (when AI_GATEWAY_SUBJECT_BUDGETS_JSON lists its key) must both admit it.
 * Returns undefined when neither applies.
 */
export function createAiBudgetGuard(db: SqliteDatabase, env: NodeJS.ProcessEnv = process.env, caller?: AiBudgetCaller): AiBudgetGuard | undefined {
  const settings = config(env);
  const budgets = subjectBudgets(env);
  const subjectLimit = caller && budgets ? budgets.get(aiBudgetKey(caller)) ?? null : null;
  const globalGuard = createGlobalGuard(db, env, settings);
  if (!globalGuard && subjectLimit === null) return undefined;
  return {
    async reserve(estimatedCostUsd: number | null): Promise<() => void> {
      const releaseGlobal = globalGuard ? await globalGuard.reserve(estimatedCostUsd) : () => undefined;
      if (subjectLimit === null || !caller) return releaseGlobal;
      try {
        const releaseSubject = reserveSubject(db, caller, subjectLimit, estimatedCostUsd, settings.allowUnmetered);
        return () => { releaseSubject(); releaseGlobal(); };
      } catch (error) {
        releaseGlobal();
        throw error;
      }
    },
  };
}

function createGlobalGuard(db: SqliteDatabase, env: NodeJS.ProcessEnv, settings: ReturnType<typeof config>): AiBudgetGuard | undefined {
  if (settings.budget === null) return undefined;
  return {
    async reserve(estimatedCostUsd: number | null): Promise<() => void> {
      if (estimatedCostUsd !== null && (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0)) {
        throw new AiBudgetError('AI request cost estimate is invalid', 'invalid_cost_estimate');
      }
      if (estimatedCostUsd === null && !settings.allowUnmetered) {
        throw new AiBudgetError('AI request has no measurable rate card', 'unmetered_request');
      }
      const status = getAiBudgetStatus(db, env);
      const estimate = estimatedCostUsd || 0;
      const effective = status.effective_budget_usd;
      if (status.decision !== 'allow' || effective === null || status.spent_usd === null) {
        throw new AiBudgetError('AI monthly budget is not available', status.reason);
      }
      if ((status.spent_usd ?? 0) + status.active_reserved_usd + (status.committed_usd ?? 0) + estimate > effective + 1e-9) {
        throw new AiBudgetError('AI monthly budget exceeded', 'request_would_exceed_monthly_budget');
      }
      const current = reservationState.get(db as object) || 0;
      reservationState.set(db as object, current + estimate);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const latest = reservationState.get(db as object) || 0;
        reservationState.set(db as object, Math.max(0, latest - estimate));
      };
    },
  };
}

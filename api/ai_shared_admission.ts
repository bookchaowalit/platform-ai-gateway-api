/** Durable admission authority for staged multi-replica gateways.
 * No retries or releases on ambiguous outcomes: capacity remains charged until
 * operator reconciliation. Data expiry never implies automatic budget release.
 */
import { randomUUID } from 'node:crypto';
import { createWorkspaceJwtAuthenticator } from './workspace_auth.js';

export class SharedAdmissionError extends Error {
  constructor(readonly status: 429 | 503, readonly code: string) {
    super(status === 429 ? 'Shared AI quota exhausted' : 'Shared AI admission unavailable');
    this.name = 'SharedAdmissionError';
  }
}
export interface AiAttemptReservation { settle(actualCostUsd: number | null): Promise<void> }
export interface AiAttemptAdmission { reserve(estimatedCostUsd: number | null): Promise<AiAttemptReservation> }
const POLICY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_RESPONSE = 16384;

function bounded(raw: string | undefined, fallback: number, maximum: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new SharedAdmissionError(503, 'shared_configuration_invalid');
  return value;
}
export function usdMicroUnits(usd: number | null): number {
  if (usd === null || !Number.isFinite(usd) || usd < 0) throw new SharedAdmissionError(503, 'shared_cost_unavailable');
  const units = Math.ceil(usd * 1_000_000);
  if (!Number.isSafeInteger(units)) throw new SharedAdmissionError(503, 'shared_cost_unavailable');
  return units;
}

export function createSharedAdmission(env: NodeJS.ProcessEnv) {
  let base: URL;
  try {
    base = new URL(env.AI_GATEWAY_SHARED_DATA_URL || '');
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && local && ['test', 'development'].includes(env.NODE_ENV || '')))
      || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error();
  } catch { throw new SharedAdmissionError(503, 'shared_configuration_invalid'); }
  const policies = ['RATE_POLICY', 'GLOBAL_RATE_POLICY', 'BUDGET_POLICY', 'GLOBAL_BUDGET_POLICY'].map(name => env[`AI_GATEWAY_SHARED_${name}`] || '');
  if (policies.some(policy => !POLICY.test(policy)) || !env.AI_GATEWAY_SHARED_SERVICE_TOKEN || env.AI_GATEWAY_SHARED_SERVICE_TOKEN.length > 16384) throw new SharedAdmissionError(503, 'shared_configuration_invalid');
  const timeout = bounded(env.AI_GATEWAY_SHARED_TIMEOUT_MS, 2000, 10000);
  const maxInflight = bounded(env.AI_GATEWAY_SHARED_MAX_INFLIGHT, 32, 100);
  const verifier = createWorkspaceJwtAuthenticator(env);
  if (verifier.configurationError) throw new SharedAdmissionError(503, 'shared_configuration_invalid');
  let inflight = 0;
  async function serviceAuthorized(): Promise<boolean> {
    try { await verifier.verifyService(env.AI_GATEWAY_SHARED_SERVICE_TOKEN!); return true; } catch { return false; }
  }
  async function ready(): Promise<boolean> {
    if (inflight >= maxInflight) return false;
    inflight++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      if (!await serviceAuthorized()) return false;
      const response = await fetch(new URL('/readyz', base), { redirect: 'error', signal: controller.signal });
      await response.body?.cancel();
      return response.status === 200;
    } catch { return false; }
    finally { clearTimeout(timer); inflight--; }
  }
  async function request(path: string, body: object, callerAuthorization: string): Promise<Record<string, unknown>> {
    if (inflight >= maxInflight) throw new SharedAdmissionError(503, 'shared_saturated');
    inflight++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      if (!await serviceAuthorized()) throw new SharedAdmissionError(503, 'shared_service_authorization_unavailable');
      const response = await fetch(new URL(path, base), {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_GATEWAY_SHARED_SERVICE_TOKEN}`, 'X-Workspace-Authorization': callerAuthorization },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SharedAdmissionError(response.status === 429 ? 429 : 503, response.status === 429 ? 'shared_quota_exhausted' : 'shared_admission_unavailable');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error(); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch (error) {
      if (error instanceof SharedAdmissionError) throw error;
      throw new SharedAdmissionError(503, 'shared_admission_unavailable');
    } finally { clearTimeout(timer); inflight--; }
  }
  async function reserve(policy: string, globalPolicy: string, units: number, caller: string): Promise<string> {
    const value = await request('/v1/service/admissions', { policy, global_policy: globalPolicy, units, idempotency_key: randomUUID(), ttl_seconds: 120 }, caller);
    if (typeof value.id !== 'string' || !ID.test(value.id) || value.status !== 'reserved' || value.units !== units
      || !Number.isSafeInteger(value.available) || (value.available as number) < 0 || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))
      || Date.parse(value.expires_at) <= Date.now()) throw new SharedAdmissionError(503, 'shared_invalid_response');
    return value.id;
  }
  async function settle(id: string, units: number, actual: number, caller: string): Promise<void> {
    const value = await request(`/v1/service/admissions/${id}/settle`, { actual_units: actual }, caller);
    if (value.id !== id || value.status !== 'settled' || value.units !== units
      || !Number.isSafeInteger(value.available) || (value.available as number) < 0
      || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) throw new SharedAdmissionError(503, 'shared_invalid_response');
  }
  return {
    ready,
    async acquireRate(caller: string): Promise<void> {
      const id = await reserve(policies[0], policies[1], 1, caller);
      await settle(id, 1, 1, caller);
    },
    forCaller(caller: string): AiAttemptAdmission {
      return {
        async reserve(estimatedCostUsd) {
          const units = Math.max(1, usdMicroUnits(estimatedCostUsd));
          const id = await reserve(policies[2], policies[3], units, caller);
          let settled = false;
          return {
            async settle(actualCostUsd) {
              if (settled || actualCostUsd === null) return;
              const actual = usdMicroUnits(actualCostUsd);
              // A provider exceeding the conservative bound is a reconciliation
              // incident. Preserve the known actual charge in durable state.
              await settle(id, units, actual, caller);
              settled = true;
            },
          };
        },
      };
    },
  };
}

/**
 * Error reporting to Sentry (@sentry/node).
 *
 * A no-op unless SENTRY_DSN is set, so tests and local runs never send anything. main.ts calls
 * initSentry() before the server starts; service.ts reports the errors it turns into 500s and
 * main.ts reports startup failures.
 *
 * Nothing sensitive leaves the process: errors only (no traces), no PII, no stack-frame local
 * variables, no request bodies, headers, cookies or query strings, and every message is scrubbed
 * of URL passwords, key=value secrets, bearer tokens and JWTs before it is sent.
 */

type Env = Record<string, string | undefined>;
// biome-ignore lint/suspicious/noExplicitAny: Sentry event payloads are loosely typed JSON
type SentryEvent = Record<string, any>;

/** The part of @sentry/node used here; tests pass a fake. */
export interface SentrySdk {
  init(options: Record<string, unknown>): unknown;
  setTag(key: string, value: string): void;
  captureException(error: unknown): unknown;
  flush(timeoutMs?: number): Promise<boolean>;
  httpIntegration(options: { maxRequestBodySize: 'none' }): unknown;
}

// scheme://user:password@host -> scheme://user:***@host
const URL_USERINFO = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+(?=@)/g;
// key=value / key: value secrets in conninfo strings and similar
const KV_SECRET = /\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*[=:]\s*)\S+/gi;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

export function scrub(text: string): string {
  return text
    .replace(URL_USERINFO, (_match, head: string) => `${head}***`)
    .replace(KV_SECRET, '$1$2***')
    .replace(BEARER, 'Bearer ***')
    .replace(JWT, '***jwt***');
}

export function scrubEvent(event: SentryEvent): SentryEvent {
  for (const exc of event.exception?.values ?? []) {
    if (typeof exc.value === 'string') exc.value = scrub(exc.value);
  }
  if (typeof event.message === 'string') event.message = scrub(event.message);
  const logentry = event.logentry;
  if (logentry && typeof logentry.message === 'string') logentry.message = scrub(logentry.message);
  if (logentry && Array.isArray(logentry.params)) logentry.params = logentry.params.map((p: unknown) => scrub(String(p)));
  const request = event.request;
  if (request && typeof request === 'object') {
    // Keep only the method. URLs can carry personal data (slugs, ids, query strings); headers,
    // cookies and bodies are dropped too.
    event.request = 'method' in request ? { method: request.method } : {};
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (typeof crumb.message === 'string') crumb.message = scrub(crumb.message);
    delete crumb.data;
  }
  delete event.extra;
  // Incoming baggage (user ids, transaction names) lands here; errors don't need it.
  if (event.contexts?.trace) delete event.contexts.trace.dynamic_sampling_context;
  return event;
}

let active: SentrySdk | undefined;

export async function initSentry(
  env: Env = process.env,
  load: () => Promise<SentrySdk> = async () => (await import('@sentry/node')) as unknown as SentrySdk,
  stderr: (line: string) => void = (line) => process.stderr.write(line),
): Promise<boolean> {
  const dsn = (env.SENTRY_DSN || '').trim();
  if (!dsn) return false;
  const sdk = await load();
  sdk.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT || 'production',
    release: env.RAILWAY_GIT_COMMIT_SHA || env.SENTRY_RELEASE || undefined,
    // No tracesSampleRate/tracesSampler at all: tracing stays fully off (with 0, an incoming
    // sentry-trace header could still force a sampled transaction with URL, query and headers).
    sendDefaultPii: false,
    includeLocalVariables: false, // frame locals hold tokens and provider keys
    // Console output is neither an event nor a breadcrumb (free-form log text can carry secrets
    // no pattern recognises); request bodies are never read.
    integrations: (defaults: { name: string }[]) => [
      ...defaults.filter((integration) => integration.name !== 'Console' && integration.name !== 'Http'),
      sdk.httpIntegration({ maxRequestBodySize: 'none' }),
    ],
    enableLogs: false,
    beforeSend: (event: SentryEvent) => scrubEvent(event),
    beforeBreadcrumb: () => null, // no breadcrumbs at all
  });
  const service = (env.RAILWAY_SERVICE_NAME || '').trim();
  if (service) sdk.setTag('service', service);
  active = sdk;
  // stderr, never stdout: stdout carries the JSON request log.
  stderr(`sentry: enabled for ${service || 'unknown service'}\n`);
  return true;
}

/** Report an error a handler catches and turns into a response or exit code. */
export function captureError(error: unknown): void {
  active?.captureException(error);
}

export async function flushSentry(timeoutMs = 5_000): Promise<void> {
  await active?.flush(timeoutMs);
}

/** Test hook: forget the initialised SDK. */
export function resetSentryForTests(): void {
  active = undefined;
}

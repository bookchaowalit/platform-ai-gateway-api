/**
 * Entry point for the hosted AI gateway container (Railway).
 *
 * Binds 0.0.0.0:$PORT, opens the telemetry store on AI_GATEWAY_DB_PATH
 * (a persistent volume in production), applies the shared ai_run_telemetry
 * migration, and refuses to start on unsafe auth configuration.
 */

import { captureError, flushSentry, initSentry } from './sentry.js';
import { AI_GATEWAY_SERVICE_VERSION, createAiGatewayService } from './service.js';
import { loadTelemetryMigration, openTelemetryStore, type TelemetryStore } from './store.js';

function logLine(fields: Record<string, string | number | boolean | null>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...fields })}\n`);
}

const env = process.env;
await initSentry(env);
const port = Number(env.PORT || '8080');
const host = (env.AI_GATEWAY_BIND_HOST || '0.0.0.0').trim();
const dbPath = (env.AI_GATEWAY_DB_PATH || '/data/ai-gateway.sqlite').trim();

let store: TelemetryStore | undefined;
try {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid');
  store = openTelemetryStore(dbPath, loadTelemetryMigration(env));
  const service = createAiGatewayService({ env, store });
  service.server.listen(port, host, () => {
    logLine({
      event: 'ai_gateway.started',
      version: AI_GATEWAY_SERVICE_VERSION,
      host,
      port,
      db_path: dbPath,
    });
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logLine({ event: 'ai_gateway.stopping', signal });
    service.server.close(() => {
      store?.close();
      logLine({ event: 'ai_gateway.stopped' });
      process.exit(0);
    });
    service.server.closeIdleConnections();
    // In-flight provider calls get the configured timeout window to drain.
    setTimeout(() => {
      store?.close();
      process.exit(0);
    }, 70_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} catch (error) {
  store?.close();
  captureError(error);
  await flushSentry();
  logLine({
    event: 'ai_gateway.startup_failed',
    // Messages name variables and paths only; configuration values are never included.
    reason: error instanceof Error ? error.message : 'unknown startup error',
  });
  process.exit(1);
}

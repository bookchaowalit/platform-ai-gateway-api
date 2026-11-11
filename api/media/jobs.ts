// SPEC-003 media jobs core. Red stub: the implementation lands with the green commit.
import type { DatabaseSync } from 'node:sqlite';
import type { AiTelemetryEvent } from '../ai_gateway.js';
import type { PayloadKeys, SignedQueueMessage } from './crypto.js';
import type { MediaGenerationRegistry } from './registry.js';

export interface MediaCaller { subject: string; workspace?: string }
export interface MediaResult { status: number; body: unknown }
export interface MediaJobsDeps {
  db: DatabaseSync;
  record: (event: AiTelemetryEvent) => void;
  registry: MediaGenerationRegistry;
  env: NodeJS.ProcessEnv;
  payloadKeys: PayloadKeys;
  queueKey: string;
  now: () => Date;
  enqueue: (message: SignedQueueMessage) => Promise<void>;
}
export interface MediaJobs {
  create(caller: MediaCaller, body: unknown, options: { idempotencyKey?: string }): Promise<MediaResult>;
  lease(attemptId: string, body: unknown): Promise<MediaResult>;
  report(attemptId: string, body: unknown): Promise<MediaResult>;
  heartbeat(attemptId: string, body: unknown): Promise<MediaResult>;
  read(caller: MediaCaller, requestId: string, signer: { signGetUrl: (objectKey: string) => Promise<{ url: string; expires_at: string }> }): Promise<MediaResult>;
  housekeeping(): Promise<void>;
}
export function createMediaJobs(_deps: MediaJobsDeps): MediaJobs {
  const no = async (): Promise<MediaResult> => ({ status: 501, body: { error: 'not_implemented' } });
  return { create: no, lease: no, report: no, heartbeat: no, read: no, housekeeping: async () => undefined };
}

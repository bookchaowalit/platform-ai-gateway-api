// SPEC-003 OpenAI images adapter. Red stub.
import type { MediaAdapter } from './worker.js';
export function createOpenAiImagesAdapter(_options: { apiKey: string; fetchImpl?: typeof fetch }): MediaAdapter {
  return { supportsIdempotency: false, submit: async () => ({ kind: 'sync', outputs: [] }) };
}

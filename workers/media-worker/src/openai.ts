/**
 * SPEC-003 OpenAI Images adapter (POST /v1/images/generations, base64 outputs).
 *
 * Sends only mapped, allow-listed fields. negative_prompt is not part of this API and is dropped.
 * Errors become fixed AdapterError codes; provider text and the key never leave this function.
 * The Images API has no idempotency key, so supportsIdempotency is false (§4.7 rule 4).
 */

import { AdapterError, type AdapterJob, type MediaAdapter } from './worker.js';

const ENDPOINT = 'https://api.openai.com/v1/images/generations';
const TIMEOUT_MS = 120_000;
const PARAM_KEYS = new Set(['background']);

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createOpenAiImagesAdapter(options: { apiKey: string; fetchImpl?: typeof fetch }): MediaAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    supportsIdempotency: false,
    async submit(job: AdapterJob) {
      if (job.kind !== 'image') throw new AdapterError('invalid_input');
      const body: Record<string, unknown> = {
        model: job.provider_model,
        prompt: job.payload.prompt,
        n: job.payload.n ?? 1,
        ...job.mapped_params,
        output_format: job.payload.format ?? 'png',
      };
      for (const [key, value] of Object.entries(job.payload.params ?? {})) {
        if (PARAM_KEYS.has(key)) body[key] = value;
      }
      let response: Response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new AdapterError('provider_error');
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }
      if (!response.ok) {
        const code = String((parsed as { error?: { code?: unknown } } | undefined)?.error?.code ?? '');
        if (response.status === 400 && /moderation|content_policy|safety/.test(code)) throw new AdapterError('content_policy');
        if (response.status === 400) throw new AdapterError('invalid_input');
        throw new AdapterError('provider_error');
      }
      const data = (parsed as { data?: unknown } | undefined)?.data;
      if (!Array.isArray(data) || data.length === 0) throw new AdapterError('invalid_response');
      const outputs = data.map((item) => {
        const b64 = (item as { b64_json?: unknown }).b64_json;
        if (typeof b64 !== 'string' || b64.length === 0) throw new AdapterError('invalid_response');
        try {
          return { bytes: decodeBase64(b64) };
        } catch {
          throw new AdapterError('invalid_response');
        }
      });
      return { kind: 'sync' as const, outputs };
    },
  };
}

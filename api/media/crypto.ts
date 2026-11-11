/**
 * SPEC-003 crypto helpers shared by the gateway (Node 22) and media-worker (Cloudflare Workers).
 * Web Crypto only, so one file runs in both.
 *
 * - Payload encryption (§4.4): AES-256-GCM, random 96-bit nonce per row, associated data = request id,
 *   keys from AI_GATEWAY_MEDIA_PAYLOAD_KEYS_JSON = {"current": id, "keys": {id: base64(32 bytes)}}.
 * - Queue message signatures (§4.5), webhook URL macs (AC-10), job ref macs: HMAC-SHA256.
 * - Subject hash for object keys and events; canonical request hash for idempotency.
 *
 * Nothing here logs, and no error message carries key material or plaintext.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export class PayloadUnavailableError extends Error {
  readonly code = 'payload_unavailable' as const;
  constructor() {
    super('media payload is unavailable');
  }
}

export interface PayloadKeyRing {
  has(id: string): boolean;
  get(id: string): Promise<CryptoKey> | undefined;
}

export interface PayloadKeys {
  current: string;
  keys: PayloadKeyRing;
}

export type ParsedPayloadKeys = { ok: true; keys: PayloadKeys } | { ok: false; problem: string };

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return new Uint8Array(0);
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Parse the payload key set. Problems name the field, never the key bytes. */
export function parsePayloadKeys(raw: string | undefined): ParsedPayloadKeys {
  if (!raw || !raw.trim()) return { ok: false, problem: 'AI_GATEWAY_MEDIA_PAYLOAD_KEYS_JSON is not set' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problem: 'AI_GATEWAY_MEDIA_PAYLOAD_KEYS_JSON is not valid JSON' };
  }
  const value = parsed as { current?: unknown; keys?: unknown };
  if (typeof value !== 'object' || value === null || typeof value.current !== 'string'
    || typeof value.keys !== 'object' || value.keys === null || Array.isArray(value.keys)) {
    return { ok: false, problem: 'AI_GATEWAY_MEDIA_PAYLOAD_KEYS_JSON must be {current, keys}' };
  }
  const raws = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [id, material] of Object.entries(value.keys as Record<string, unknown>)) {
    const bytes = typeof material === 'string' ? fromBase64(material) : new Uint8Array(0);
    if (!KEY_ID.test(id) || bytes.length !== 32) {
      return { ok: false, problem: 'AI_GATEWAY_MEDIA_PAYLOAD_KEYS_JSON has a key that is not 32 bytes of base64 or a bad key id' };
    }
    raws.set(id, bytes);
  }
  if (!raws.has(value.current)) return { ok: false, problem: 'AI_GATEWAY_MEDIA_PAYLOAD_KEYS_JSON current key id is not in keys' };
  // importKey is async; the ring imports each key on first use so parsing stays synchronous.
  return { ok: true, keys: { current: value.current, keys: new LazyKeyRing(raws) } };
}

/** Imports AES keys on first use (parsePayloadKeys stays synchronous). */
class LazyKeyRing implements PayloadKeyRing {
  private readonly imported = new Map<string, Promise<CryptoKey>>();
  constructor(private readonly raws: Map<string, Uint8Array<ArrayBuffer>>) {}
  has(id: string): boolean {
    return this.raws.has(id);
  }
  get(id: string): Promise<CryptoKey> | undefined {
    const raw = this.raws.get(id);
    if (!raw) return undefined;
    let key = this.imported.get(id);
    if (!key) {
      key = subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      this.imported.set(id, key);
    }
    return key;
  }
}

export interface SealedPayload {
  ciphertext: Uint8Array;
  /** base64url of the 12-byte nonce; unique per row (UNIQUE index). */
  nonce: string;
  key_id: string;
}

async function aesKey(keys: PayloadKeys, id: string): Promise<CryptoKey> {
  const key = keys.keys.get(id);
  if (!key) throw new PayloadUnavailableError();
  return key;
}

export async function sealPayload(keys: PayloadKeys, requestId: string, payload: unknown): Promise<SealedPayload> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keys, keys.current);
  const ciphertext = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(requestId) },
    key,
    encoder.encode(JSON.stringify(payload)),
  ));
  return { ciphertext, nonce: toBase64Url(nonce), key_id: keys.current };
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

/** Throws PayloadUnavailableError for an unknown key id, a wrong request id, or tampered bytes. */
export async function openPayload(keys: PayloadKeys, requestId: string, sealed: SealedPayload): Promise<unknown> {
  const key = await aesKey(keys, sealed.key_id);
  const nonce = fromBase64Url(sealed.nonce);
  if (nonce.length !== 12) throw new PayloadUnavailableError();
  try {
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(requestId) },
      key,
      new Uint8Array(sealed.ciphertext),
    );
    return JSON.parse(decoder.decode(plain));
  } catch {
    throw new PayloadUnavailableError();
  }
}

// ---------------------------------------------------------------- HMAC

const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(secret, key);
  }
  return key;
}

/** HMAC-SHA256 over fields joined with a unit separator, so field boundaries cannot shift. */
async function mac(secret: string, ...fields: string[]): Promise<Uint8Array> {
  return new Uint8Array(await subtle.sign('HMAC', await hmacKey(secret), encoder.encode(fields.join('\u001f'))));
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export type QueueReason = 'start' | 'poll' | 'webhook' | 'cancel';

export interface QueueMessage {
  v: 1;
  attempt_id: string;
  dispatch_no: string;
  reason: QueueReason;
  ref_mac?: string;
}

export interface SignedQueueMessage extends QueueMessage {
  sig: string;
}

export async function queueMessageSignature(secret: string, message: QueueMessage): Promise<string> {
  return toBase64Url(await mac(secret, 'queue', String(message.v), message.attempt_id, message.dispatch_no, message.reason, message.ref_mac ?? ''));
}

export async function verifyQueueMessage(secret: string, message: SignedQueueMessage): Promise<boolean> {
  if (typeof message?.sig !== 'string' || message.sig === '') return false;
  const expected = await queueMessageSignature(secret, message);
  return timingSafeEqual(expected, message.sig);
}

/** `ref_mac` for webhook messages: the job ref itself never enters the queue. */
export async function refMac(secret: string, providerJobRef: string): Promise<string> {
  return toBase64Url(await mac(secret, 'ref', providerJobRef));
}

/** Mac in the webhook URL `/webhooks/:provider/:attempt_id/:dispatch_no/:mac` (AC-10). */
export async function webhookMac(secret: string, attemptId: string, dispatchNo: string): Promise<string> {
  return toBase64Url(await mac(secret, 'webhook', attemptId, dispatchNo));
}

export function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(left, right);
}

/** HMAC of the subject key for object keys and events (§4.5): 128 bits of hex. */
export async function subjectHash(secret: string, subjectKey: string): Promise<string> {
  return toHex((await mac(secret, 'subject', subjectKey)).slice(0, 16));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 hex of the canonical JSON (sorted keys): `request_hash` for idempotency conflicts. */
export async function canonicalHash(value: unknown): Promise<string> {
  return toHex(new Uint8Array(await subtle.digest('SHA-256', encoder.encode(canonical(value)))));
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await subtle.digest('SHA-256', encoder.encode(text))));
}

export function randomId(bytes = 16): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

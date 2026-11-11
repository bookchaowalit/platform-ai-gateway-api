/**
 * SPEC-003 R2 presigner (S3 SigV4 query signing, Web Crypto only).
 *
 * The gateway signs short-lived GET URLs for media_assets; it never reads or writes the objects
 * (the worker does, through its bucket binding). Credentials are an R2 token scoped to the one
 * bucket (§4.6). Problems name variables, never values.
 */

const encoder = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export interface PresignOptions {
  host: string;
  /** Already-encoded absolute path, e.g. `/bucket/images/a.png`. */
  path: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now: Date;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const imported = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return subtle.sign('HMAC', imported, encoder.encode(data));
}

/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodeObjectPath(bucket: string, key: string): string {
  return `/${rfc3986(bucket)}/${key.split('/').map(rfc3986).join('/')}`;
}

export async function presignS3Get(options: PresignOptions): Promise<string> {
  const amzDate = options.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${options.region}/s3/aws4_request`;
  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${options.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(options.expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = query
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = ['GET', options.path, canonicalQuery, `host:${options.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmac(encoder.encode(`AWS4${options.secretAccessKey}`), day);
  const kRegion = await hmac(kDate, options.region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));
  return `https://${options.host}${options.path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export interface MediaUrlSigner {
  signGetUrl: (objectKey: string) => Promise<{ url: string; expires_at: string }>;
}

const ACCOUNT_ID = /^[A-Za-z0-9]{1,64}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function r2SignerFromEnv(env: NodeJS.ProcessEnv, now: () => Date):
  { ok: true; signer: MediaUrlSigner; ttlSeconds: number } | { ok: false; problem: string } {
  const accountId = (env.AI_GATEWAY_MEDIA_R2_ACCOUNT_ID || '').trim();
  const bucket = (env.AI_GATEWAY_MEDIA_R2_BUCKET || '').trim();
  const accessKeyId = (env.AI_GATEWAY_MEDIA_R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (env.AI_GATEWAY_MEDIA_R2_SECRET_ACCESS_KEY || '').trim();
  if (!ACCOUNT_ID.test(accountId)) return { ok: false, problem: 'AI_GATEWAY_MEDIA_R2_ACCOUNT_ID is not set' };
  if (!BUCKET.test(bucket)) return { ok: false, problem: 'AI_GATEWAY_MEDIA_R2_BUCKET is not set' };
  if (!accessKeyId || !secretAccessKey) return { ok: false, problem: 'AI_GATEWAY_MEDIA_R2_ACCESS_KEY_ID / _SECRET_ACCESS_KEY are not set' };
  const rawTtl = Number(env.AI_GATEWAY_MEDIA_URL_TTL_S);
  const ttlSeconds = Number.isInteger(rawTtl) && rawTtl > 0 ? Math.min(Math.max(rawTtl, 60), 3_600) : 900;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  return {
    ok: true,
    ttlSeconds,
    signer: {
      async signGetUrl(objectKey: string) {
        const at = now();
        const url = await presignS3Get({
          host, path: encodeObjectPath(bucket, objectKey), region: 'auto', accessKeyId, secretAccessKey, expiresSeconds: ttlSeconds, now: at,
        });
        return { url, expires_at: new Date(at.getTime() + ttlSeconds * 1000).toISOString() };
      },
    },
  };
}

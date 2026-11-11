// SPEC-003 §4.5 / AC-12: signed GET URLs for R2 (S3 SigV4 query signing, Web Crypto).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presignS3Get, r2SignerFromEnv } from '../api/media/r2.js';

test('SPEC-003 SigV4 query presign matches the AWS documentation vector', async () => {
  // AWS S3 docs, "Authenticating Requests: Using Query Parameters", GET /test.txt, 2013-05-24, 86400 s.
  const url = await presignS3Get({
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    expiresSeconds: 86_400,
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(new URL(url).searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(new URL(url).searchParams.get('X-Amz-Credential'), 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
});

test('SPEC-003 R2 signer: path-style host, encoded key, TTL bounds, fails closed without config', async () => {
  const env = {
    AI_GATEWAY_MEDIA_R2_ACCOUNT_ID: 'acct123',
    AI_GATEWAY_MEDIA_R2_BUCKET: 'ai-media',
    AI_GATEWAY_MEDIA_R2_ACCESS_KEY_ID: 'MARKER_access',
    AI_GATEWAY_MEDIA_R2_SECRET_ACCESS_KEY: 'MARKER_secret',
    AI_GATEWAY_MEDIA_URL_TTL_S: '900',
  };
  const signer = r2SignerFromEnv(env, () => new Date('2026-11-11T10:00:00Z'));
  assert.ok(signer.ok);
  const signed = await signer.signer.signGetUrl('images/abc/2026/11/a b.png');
  const url = new URL(signed.url);
  assert.equal(url.host, 'acct123.r2.cloudflarestorage.com');
  assert.equal(url.pathname, '/ai-media/images/abc/2026/11/a%20b.png');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(signed.expires_at, '2026-11-11T10:15:00.000Z');
  assert.doesNotMatch(signed.url, /MARKER_secret/);
  assert.equal(r2SignerFromEnv({ ...env, AI_GATEWAY_MEDIA_URL_TTL_S: '99999' }, () => new Date()).ok, true, 'TTL is clamped, not rejected');
  const missing = r2SignerFromEnv({ ...env, AI_GATEWAY_MEDIA_R2_SECRET_ACCESS_KEY: '' }, () => new Date());
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.doesNotMatch(missing.problem, /MARKER/);
});

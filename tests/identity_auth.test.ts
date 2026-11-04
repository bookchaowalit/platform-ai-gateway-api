import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { hashApiToken } from '../api/auth.js';
import { createIdentityAuthenticator } from '../api/identity_auth.js';

const ISSUER = 'https://identity.example.test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const keys = createLocalJWKSet({ keys: [jwk] });
const staticToken = ['static', 'local', 'fixture', '0001'].join('-');
const env = {
  AI_GATEWAY_IDENTITY_ISSUER: ISSUER,
  API_TOKENS_JSON: JSON.stringify([{ subject: 'owner-cli', token_hash: hashApiToken(staticToken), scopes: ['api:read', 'ai:generate'] }]),
};
const sub = randomUUID();
const ws = randomUUID();

async function token(claims: Record<string, unknown> = {}, key = privateKey, kid = 'k1') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ws, scope: 'ai:read ai:generate', jti: randomUUID(), ...claims })
    .setProtectedHeader({ alg: 'RS256', kid }).setIssuer(ISSUER).setAudience('ai-api').setSubject(sub)
    .setIssuedAt(now).setExpirationTime(now + 900).sign(key);
}
const req = (t?: string) => ({ headers: t === undefined ? {} : { authorization: `Bearer ${t}` } });

test('an identity token for ai-api is authorized with its person and workspace', async () => {
  const auth = createIdentityAuthenticator(env, { keys });
  const result = await auth.authenticate(req(await token()), 'ai:generate');
  assert.equal(result.authorized, true);
  assert.equal(result.method, 'identity-jwt');
  assert.equal(result.subject, sub);
  assert.equal(result.workspace, ws);
});

test('ai:read satisfies the status route scope api:read', async () => {
  const auth = createIdentityAuthenticator(env, { keys });
  const result = await auth.authenticate(req(await token({ scope: 'ai:read' })), 'api:read');
  assert.equal(result.authorized, true);
});

test('a token without the scope is 403', async () => {
  const auth = createIdentityAuthenticator(env, { keys });
  const result = await auth.authenticate(req(await token({ scope: 'ai:read' })), 'ai:generate');
  assert.equal(result.authorized, false);
  assert.equal(result.status, 403);
});

test('wrong audience, issuer, signing key or an expired token is 401', async () => {
  const auth = createIdentityAuthenticator(env, { keys });
  const now = Math.floor(Date.now() / 1000);
  const bad = [
    await new SignJWT({ ws, scope: 'ai:generate', jti: randomUUID() }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER).setAudience('platform-api').setSubject(sub).setIssuedAt(now).setExpirationTime(now + 900).sign(privateKey),
    await new SignJWT({ ws, scope: 'ai:generate', jti: randomUUID() }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://evil.example.test').setAudience('ai-api').setSubject(sub).setIssuedAt(now).setExpirationTime(now + 900).sign(privateKey),
    await token({}, other.privateKey),
    await new SignJWT({ ws, scope: 'ai:generate', jti: randomUUID() }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER).setAudience('ai-api').setSubject(sub).setIssuedAt(now - 2000).setExpirationTime(now - 1000).sign(privateKey),
    await token({ ws: 'not-a-uuid' }),
  ];
  for (const t of bad) {
    const result = await auth.authenticate(req(t), 'ai:generate');
    assert.equal(result.authorized, false);
    assert.equal(result.status, 401);
  }
});

test('the hashed static tokens keep working next to identity tokens', async () => {
  const auth = createIdentityAuthenticator(env, { keys });
  const result = await auth.authenticate(req(staticToken), 'ai:generate');
  assert.equal(result.authorized, true);
  assert.equal(result.method, 'scoped');
  assert.equal(result.subject, 'owner-cli');
  assert.equal(result.workspace, undefined);
});

test('a missing header is 401', async () => {
  const auth = createIdentityAuthenticator(env, { keys });
  const result = await auth.authenticate(req(), 'ai:generate');
  assert.equal(result.status, 401);
});

test('the issuer must be an https URL', () => {
  assert.ok(createIdentityAuthenticator({ ...env, AI_GATEWAY_IDENTITY_ISSUER: 'http://identity.example.test' }).configurationError);
  assert.ok(createIdentityAuthenticator({ ...env, AI_GATEWAY_IDENTITY_ISSUER: '' }).configurationError);
  assert.equal(createIdentityAuthenticator(env, { keys }).configurationError, null);
});

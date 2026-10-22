import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScopedTokenAuthenticator, hashApiToken, parseScopedTokenConfig } from '../api/auth.js';

// Throwaway tokens built at runtime: only their SHA-256 hashes go into the config, as in production.
const readerToken = ['reader', 'local', 'fixture', '0001'].join('-');
const writerToken = ['writer', 'local', 'fixture', '0002'].join('-');
const expiredToken = ['expired', 'local', 'fixture', '0003'].join('-');

function config(entries: unknown[]): string {
  return JSON.stringify(entries);
}

function request(token?: string) {
  return { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } };
}

const tokens = config([
  { subject: 'dashboard', token_hash: hashApiToken(readerToken), scopes: ['api:read'] },
  { subject: 'owner-cli', token_hash: hashApiToken(writerToken), scopes: ['api:write'] },
  {
    subject: 'old-client',
    token_hash: hashApiToken(expiredToken),
    scopes: ['api:read'],
    expires_at: '2000-01-01T00:00:00Z',
  },
]);

test('a token with the required scope is authorized as its subject', () => {
  const auth = createScopedTokenAuthenticator(tokens);
  const result = auth.authenticate(request(readerToken), 'api:read');
  assert.equal(result.authorized, true);
  assert.equal(result.subject, 'dashboard');
  assert.equal(result.method, 'scoped');
});

test('a read-only token cannot write (403) and a write token may also read', () => {
  const auth = createScopedTokenAuthenticator(tokens);
  const denied = auth.authenticate(request(readerToken), 'api:write');
  assert.equal(denied.authorized, false);
  assert.equal(denied.status, 403);
  assert.equal(denied.error, 'Insufficient scope');
  assert.equal(auth.authenticate(request(writerToken), 'api:read').authorized, true);
});

test('missing, unknown and expired tokens are rejected with 401', () => {
  const auth = createScopedTokenAuthenticator(tokens);
  assert.equal(auth.authenticate(request(), 'api:read').error, 'Missing Authorization header');
  assert.equal(auth.authenticate(request('not-a-known-token'), 'api:read').error, 'Invalid token');
  const expired = auth.authenticate(request(expiredToken), 'api:read');
  assert.equal(expired.status, 401);
  assert.equal(expired.error, 'Token expired');
});

test('a config that stores a raw token is refused and every request fails closed', () => {
  const raw = config([{ subject: 'leaky', token: readerToken, scopes: ['api:read'] }]);
  const parsed = parseScopedTokenConfig(raw);
  assert.deepEqual(parsed.tokens, []);
  assert.match(parsed.error ?? '', /must store token_hash, not a raw token/);
  const auth = createScopedTokenAuthenticator(raw);
  const result = auth.authenticate(request(readerToken), 'api:read');
  assert.equal(result.authorized, false);
  assert.equal(result.error, 'Authentication configuration is invalid');
});

test('invalid subjects, hashes, scopes and expiry dates are configuration errors', () => {
  const hash = hashApiToken(readerToken);
  const cases: Array<[unknown, RegExp]> = [
    [{ subject: ' bad subject', token_hash: hash, scopes: ['api:read'] }, /invalid subject/],
    [{ subject: 'ok', token_hash: 'abc', scopes: ['api:read'] }, /invalid token_hash/],
    [{ subject: 'ok', token_hash: hash, scopes: [] }, /invalid scopes/],
    [{ subject: 'ok', token_hash: hash, scopes: ['API:READ'] }, /invalid scopes/],
    [{ subject: 'ok', token_hash: hash, scopes: ['api:read'], expires_at: 'soon' }, /invalid expires_at/],
  ];
  for (const [entry, message] of cases) {
    const parsed = parseScopedTokenConfig(config([entry]));
    assert.deepEqual(parsed.tokens, []);
    assert.match(parsed.error ?? '', message);
  }
  assert.match(parseScopedTokenConfig('{}').error ?? '', /must be an array/);
});

test('an empty config has no tokens and no error, so the scoped authenticator rejects everyone', () => {
  assert.deepEqual(parseScopedTokenConfig('  '), { tokens: [], error: null });
  const auth = createScopedTokenAuthenticator(undefined);
  assert.equal(auth.tokenCount, 0);
  assert.equal(auth.authenticate(request(readerToken), 'api:read').authorized, false);
});

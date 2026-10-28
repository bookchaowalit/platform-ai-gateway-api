/**
 * Small, provider-neutral bearer authentication boundary.
 *
 * Legacy API_TOKEN remains supported for local compatibility. New callers
 * should use API_TOKENS_JSON with high-entropy token hashes and least-privilege
 * scopes. Raw scoped tokens are never accepted in configuration or persisted.
 */

import { createHash, timingSafeEqual } from 'crypto';

export type AuthResult = {
  authorized: boolean;
  subject: string | null;
  scopes: string[];
  method: 'legacy' | 'scoped' | 'dev' | 'none' | 'workspace-jwt';
  requiredScope?: string;
  status?: 401 | 403;
  error?: string;
};

export type ScopedToken = {
  subject: string;
  tokenHash: string;
  scopes: string[];
  expiresAt: string | null;
};

const API_TOKEN = process.env.API_TOKEN || '';
const SCOPED_TOKEN_CONFIG = process.env.API_TOKENS_JSON?.trim() || '';
const ALLOW_UNAUTH_DEV = process.env.ALLOW_UNAUTH_DEV === 'true';
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SCOPE_PATTERN = /^[a-z][a-z0-9:_-]{1,63}$/;

export interface ScopedTokenConfig {
  tokens: ScopedToken[];
  error: string | null;
}

/**
 * Parse API_TOKENS_JSON without reading process state. Invalid configuration
 * yields no tokens plus an error so callers can fail closed.
 */
export function parseScopedTokenConfig(raw: string | undefined): ScopedTokenConfig {
  const config = raw?.trim() || '';
  if (!config) return { tokens: [], error: null };

  try {
    const parsed: unknown = JSON.parse(config);
    if (!Array.isArray(parsed) || parsed.length > 100) {
      throw new Error('API_TOKENS_JSON must be an array with at most 100 entries');
    }

    const tokens = parsed.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`API_TOKENS_JSON entry ${index} must be an object`);
      }
      const value = entry as Record<string, unknown>;
      if ('token' in value || 'secret' in value) {
        throw new Error(`API_TOKENS_JSON entry ${index} must store token_hash, not a raw token`);
      }

      const subject = typeof value.subject === 'string' ? value.subject.trim() : '';
      const tokenHash = typeof value.token_hash === 'string' ? value.token_hash.trim().toLowerCase() : '';
      const scopes = Array.isArray(value.scopes)
        ? value.scopes.filter((scope): scope is string => typeof scope === 'string').map(scope => scope.trim())
        : [];
      const expiresAt = value.expires_at === undefined || value.expires_at === null
        ? null
        : typeof value.expires_at === 'string' ? value.expires_at : '';

      if (!SUBJECT_PATTERN.test(subject)) throw new Error(`API_TOKENS_JSON entry ${index} has an invalid subject`);
      if (!TOKEN_HASH_PATTERN.test(tokenHash)) throw new Error(`API_TOKENS_JSON entry ${index} has an invalid token_hash`);
      if (scopes.length === 0 || scopes.length > 20 || scopes.some(scope => !SCOPE_PATTERN.test(scope))) {
        throw new Error(`API_TOKENS_JSON entry ${index} has invalid scopes`);
      }
      if (expiresAt !== null && (!expiresAt || Number.isNaN(Date.parse(expiresAt)))) {
        throw new Error(`API_TOKENS_JSON entry ${index} has an invalid expires_at`);
      }

      return { subject, tokenHash, scopes: [...new Set(scopes)], expiresAt };
    });
    return { tokens, error: null };
  } catch (error) {
    return { tokens: [], error: error instanceof Error ? error.message : 'invalid scoped token configuration' };
  }
}

const parsedScopedTokens = parseScopedTokenConfig(SCOPED_TOKEN_CONFIG);
const scopedTokens: ScopedToken[] = parsedScopedTokens.tokens;
const scopedTokenConfigError: string | null = parsedScopedTokens.error;

export function authConfigurationError(): string | null {
  return scopedTokenConfigError;
}

export function authConfigurationPresent(): boolean {
  return Boolean(API_TOKEN || scopedTokens.length);
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function sameHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function scopeAllows(scopes: string[], requiredScope: string): boolean {
  if (scopes.includes('*') || scopes.includes(requiredScope)) return true;
  if (requiredScope === 'api:read' && scopes.includes('api:write')) return true;
  if (requiredScope === 'finance:read' && scopes.includes('finance:write')) return true;
  return false;
}

function failure(
  requiredScope: string,
  status: 401 | 403,
  error: string,
  subject: string | null = null,
  scopes: string[] = [],
  method: AuthResult['method'] = 'none',
): AuthResult {
  return { authorized: false, subject, scopes, method, requiredScope, status, error };
}

export function requireAuth(req: any, requiredScope = 'api:write'): AuthResult {
  if (scopedTokenConfigError) {
    return failure(requiredScope, 401, 'Authentication configuration is invalid');
  }

  const authHeader = typeof req?.headers?.authorization === 'string' ? req.headers.authorization : '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const presentedToken = match?.[1]?.trim() || '';

  if (!presentedToken) {
    if (!API_TOKEN && scopedTokens.length === 0 && ALLOW_UNAUTH_DEV) {
      return { authorized: true, subject: 'local-dev', scopes: ['*'], method: 'dev', requiredScope };
    }
    return failure(requiredScope, 401, 'Missing Authorization header');
  }

  if (API_TOKEN && sameHash(hashApiToken(presentedToken), hashApiToken(API_TOKEN))) {
    return { authorized: true, subject: 'legacy-api-token', scopes: ['*'], method: 'legacy', requiredScope };
  }

  return authenticateScopedToken(scopedTokens, presentedToken, requiredScope);
}

function authenticateScopedToken(tokens: ScopedToken[], presentedToken: string, requiredScope: string): AuthResult {
  const presentedHash = hashApiToken(presentedToken);
  const scoped = tokens.find(token => sameHash(token.tokenHash, presentedHash));
  if (!scoped) return failure(requiredScope, 401, 'Invalid token');
  if (scoped.expiresAt && Date.parse(scoped.expiresAt) <= Date.now()) {
    return failure(requiredScope, 401, 'Token expired', scoped.subject, scoped.scopes, 'scoped');
  }
  if (!scopeAllows(scoped.scopes, requiredScope)) {
    return failure(requiredScope, 403, 'Insufficient scope', scoped.subject, scoped.scopes, 'scoped');
  }

  return {
    authorized: true,
    subject: scoped.subject,
    scopes: scoped.scopes,
    method: 'scoped',
    requiredScope,
  };
}

export interface ScopedTokenAuthenticator {
  configurationError: string | null;
  tokenCount: number;
  authenticate(req: any, requiredScope: string): AuthResult;
}

/**
 * Scoped-only authenticator for standalone services. It never honors the
 * legacy full-access API_TOKEN or ALLOW_UNAUTH_DEV, and it reads only the
 * configuration passed in, so a hosted boundary cannot inherit local shortcuts.
 */
export function createScopedTokenAuthenticator(rawConfig: string | undefined): ScopedTokenAuthenticator {
  const { tokens, error } = parseScopedTokenConfig(rawConfig);
  return {
    configurationError: error,
    tokenCount: tokens.length,
    authenticate(req: any, requiredScope: string): AuthResult {
      if (error) return failure(requiredScope, 401, 'Authentication configuration is invalid');
      const authHeader = typeof req?.headers?.authorization === 'string' ? req.headers.authorization : '';
      const presentedToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
      if (!presentedToken) return failure(requiredScope, 401, 'Missing Authorization header');
      return authenticateScopedToken(tokens, presentedToken, requiredScope);
    },
  };
}

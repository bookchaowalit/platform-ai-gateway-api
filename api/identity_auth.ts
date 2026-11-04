/**
 * Identity profile (owner decision 2026-11-04): platform-identity RS256 tokens for audience
 * ai-api, verified against the issuer's JWKS, next to the hashed static tokens. A bearer that
 * is shaped like a JWT is only ever checked as a JWT; anything else goes to the static tokens.
 */
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { createScopedTokenAuthenticator } from './auth.js';
import type { WorkspaceAuthResult } from './workspace_auth.js';

export const IDENTITY_AUDIENCE = 'ai-api';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
// Identity scope names for the gateway's route scopes (identity has no generic api:read).
const ROUTE_SCOPE: Record<string, string> = { 'api:read': 'ai:read', 'ai:generate': 'ai:generate' };

export interface IdentityAuthenticator {
  configurationError: string | null;
  authenticate(req: any, requiredScope: string): Promise<WorkspaceAuthResult>;
}

export function createIdentityAuthenticator(env: NodeJS.ProcessEnv, options: { keys?: JWTVerifyGetKey } = {}): IdentityAuthenticator {
  const issuer = env.AI_GATEWAY_IDENTITY_ISSUER || '';
  const scoped = createScopedTokenAuthenticator(env.API_TOKENS_JSON);
  let configurationError: string | null = scoped.configurationError ? `API_TOKENS_JSON is invalid: ${scoped.configurationError}` : null;
  let keys = options.keys;
  try {
    const url = new URL(issuer);
    if (url.protocol !== 'https:' || issuer.length > 2048 || issuer !== issuer.trim() || url.search || url.hash) throw new Error();
    keys ??= createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/.well-known/jwks.json`), { cooldownDuration: 30_000, timeoutDuration: 5_000 });
  } catch {
    configurationError = 'AI_GATEWAY_IDENTITY_ISSUER must be the https URL of platform-identity';
  }

  return {
    configurationError,
    async authenticate(req, requiredScope) {
      const denied = (status: 401 | 403): WorkspaceAuthResult => ({ authorized: false, subject: null, scopes: [], method: 'none', status, requiredScope, error: 'Authorization denied' });
      if (configurationError || !keys) return denied(401);
      const authorization = typeof req?.headers?.authorization === 'string' ? req.headers.authorization : '';
      const token = authorization.match(/^Bearer\s+(\S+)$/i)?.[1] || '';
      if (!token) return denied(401);
      if (!JWT_SHAPE.test(token)) return scoped.authenticate(req, requiredScope);
      try {
        if (token.length > 16384 || decodeProtectedHeader(token).crit !== undefined) return denied(401);
        const { payload } = await jwtVerify(token, keys, {
          algorithms: ['RS256'], issuer, audience: IDENTITY_AUDIENCE,
          requiredClaims: ['sub', 'ws', 'iat', 'exp', 'jti'], clockTolerance: 5,
        });
        if (payload.aud !== IDENTITY_AUDIENCE || typeof payload.sub !== 'string' || !UUID.test(payload.sub)
          || typeof payload.ws !== 'string' || !UUID.test(payload.ws)
          || typeof payload.jti !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.jti)
          || (payload.scope !== undefined && (typeof payload.scope !== 'string' || payload.scope.length > 8192))) return denied(401);
        // Same lifetime rules as workspace_auth.ts; identity issues 10-minute tokens.
        const now = Math.floor(Date.now() / 1000);
        for (const claim of ['iat', 'exp', ...(payload.nbf === undefined ? [] : ['nbf'])]) {
          const value = payload[claim];
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return denied(401);
        }
        const iat = payload.iat!, exp = payload.exp!;
        if (iat > now + 5 || exp <= iat || exp - iat > 3600
          || (payload.nbf !== undefined && (payload.nbf < iat || payload.nbf >= exp))) return denied(401);
        const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
        const needed = ROUTE_SCOPE[requiredScope];
        if (!needed || !scopes.includes(needed)) return denied(403);
        return { authorized: true, subject: payload.sub, workspace: payload.ws.toLowerCase(), scopes, method: 'identity-jwt', requiredScope };
      } catch {
        return denied(401);
      }
    },
  };
}

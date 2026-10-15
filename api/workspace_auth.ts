/** Explicit staged workspace JWT profile. Legacy owner tokens never enter it. */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { jwtVerify, type JWTPayload } from 'jose';
import type { AuthResult } from './auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
export type WorkspaceAuthResult = AuthResult & { workspace?: string; authorization?: string };
export interface WorkspaceAuthenticator {
  configurationError: string | null;
  authenticate(req: any, requiredScope: string): Promise<WorkspaceAuthResult>;
  verifyService(token: string): Promise<void>;
}

export function createWorkspaceJwtAuthenticator(env: NodeJS.ProcessEnv): WorkspaceAuthenticator {
  let key: KeyObject | undefined;
  let configurationError: string | null = null;
  const issuer = env.AI_GATEWAY_JWT_ISSUER || '';
  try {
    if (!issuer || issuer.length > 2048 || issuer.trim() !== issuer) throw new Error();
    key = createPublicKey(env.AI_GATEWAY_JWT_PUBLIC_KEY_PEM || '');
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error();
  } catch { configurationError = 'AI_GATEWAY_JWT_ISSUER and AI_GATEWAY_JWT_PUBLIC_KEY_PEM must configure an RS256 verifier'; }

  async function verify(token: string): Promise<JWTPayload> {
    if (!key || configurationError || token.length > 16384) throw new Error('Invalid JWT');
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      algorithms: ['RS256'], issuer, audience: 'platform-api',
      requiredClaims: ['sub', 'ws', 'iat', 'exp', 'jti', 'scope'],
      clockTolerance: 0,
    });
    if (protectedHeader.crit !== undefined) throw new Error('Unsupported JWT header');
    const now = Math.floor(Date.now() / 1000);
    // Exact audience string (arrays and wildcard scopes are not accepted).
    if (payload.aud !== 'platform-api' || typeof payload.sub !== 'string' || !UUID.test(payload.sub)
      || typeof payload.ws !== 'string' || !UUID.test(payload.ws)
      || typeof payload.jti !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.jti)
      || typeof payload.scope !== 'string' || payload.scope.length > 8192
      || payload.scope.split(' ').length > 128 || payload.scope.split(' ').some(scope => !SCOPE.test(scope) || scope === '*')) throw new Error('Invalid JWT claims');
    for (const claim of ['iat', 'exp', ...(payload.nbf === undefined ? [] : ['nbf'])]) {
      const value = payload[claim];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 253402300799) throw new Error('Invalid JWT time');
    }
    if (payload.iat! > now || payload.exp! <= now || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 3600
      || (payload.nbf !== undefined && (payload.nbf < payload.iat! || payload.nbf >= payload.exp!))) throw new Error('Invalid JWT lifetime');
    return payload;
  }

  return {
    configurationError,
    async verifyService(token) {
      const payload = await verify(token);
      if (!(payload.scope as string).split(' ').includes('quotas:service')) throw new Error('Missing service scope');
    },
    async authenticate(req, requiredScope) {
      const authorization = typeof req?.headers?.authorization === 'string' ? req.headers.authorization : '';
      const token = authorization.match(/^Bearer ([A-Za-z0-9_.-]+)$/i)?.[1];
      const denied = (status: 401 | 403): WorkspaceAuthResult => ({ authorized: false, subject: null, scopes: [], method: 'none', status, requiredScope, error: 'Workspace authorization denied' });
      try {
        if (!token) return denied(401);
        const payload = await verify(token);
        const scopes = (payload.scope as string).split(' ');
        if (!scopes.includes(requiredScope)) return denied(403);
        return { authorized: true, subject: payload.sub!, workspace: (payload.ws as string).toLowerCase(), scopes, method: 'workspace-jwt', requiredScope, authorization };
      } catch { return denied(401); }
    },
  };
}

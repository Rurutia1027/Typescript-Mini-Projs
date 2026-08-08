import type { MiddlewareHandler } from 'hono';

export interface AuthContext {
  keyId: string;
  userId: string;
}

export type AuthVariables = { auth: AuthContext };

// key table 
const KEYS: Record<string, AuthContext> = {
  'sk-gw-alice': { keyId: '1', userId: 'alice' },
};

export const requireGatewayKey: MiddlewareHandler<{ Variables: AuthVariables }> = async (
  c, // cache handler insider of the Hono 
  next, // servlet's do filter doFilter -> client -> | layer of filter auth filter 
) => {
  const h = c.req.header('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const key = m?.[1]?.trim();
  if (!key || !KEYS[key]) {
    return c.json({ error: { message: 'unauthorized' } }, 401);
  }
  c.set('auth', KEYS[key]); // cache of hono instance, cache k,v(byte[]) -> mem -> recover -> AuthContext
  await next();
};

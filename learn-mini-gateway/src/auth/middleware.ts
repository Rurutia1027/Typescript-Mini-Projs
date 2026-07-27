import type { MiddlewareHandler } from "hono";

export interface AuthContext {
    keyId: string; 
    userId: string; 
}; 


export type AuthVariables = {auth: AuthContext}; 

const KEYS: Record<string, AuthContext> = {
    'sk-gw-alice': { keyId: '1', userId: 'alice' },
}; 

export const requireGatewayKey: MiddlewareHandler<{Variables: AuthVariables}> = async (c, next) => {
    const h = c.req.header('Authorization') ?? ''; 
    const m = /^Bearer\s+(.+)$/i.exec(h);
    const key = m?.[1]?.trim(); 
    if (!key || !KEYS[key]) {
        return c.json({error: {message: 'unauthorized'}}, 401); 
    }

    c.set('auth', KEYS[key]); 
    await next(); 
}; 
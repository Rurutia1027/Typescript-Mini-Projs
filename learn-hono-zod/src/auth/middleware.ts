/**
 * Bearer auth middleware - mirrors book-llm-gateway auth style: 
 * early return c.json(...) on failure, then c.set('auth', ...) + await next(). 
 * 
 * Uses c.set / c.get (not c.var) - that is the project's convention. 
*/
import type { MiddlewareHandler } from "hono";

export interface AuthContext {
    keyId: string; 
    userId: string; 
    scopes: string[]; 
}

export type AuthVariables = {auth: AuthContext}; 

/** In-memory key table for the mini project (book uses Drizzle + SQLite).  */
const KEY_DB: Record<string, AuthContext> = {
    'sk-gw-alice': {keyId: 'key-1', userId: 'user-1', scopes: ['chat']}, 
    'sk-gw-bob': {keyId: 'key-2', userId: 'user-2', scopes['chat', 'admin']}, 
}; 

export function extractBearerToken(header: string | undefined): string | null {
    if (!header) return null; 
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    return m?.[1]?.trim() || null;
}

export const requireGatewayKey: MiddlewareHandler<{
    Variables: AuthVariables;
}> = async (c, next) => {
    const plaintext = extractBearerToken(c.req.header('Authorization')); 
    if (!plaintext) {
        return c.json({error: {message: 'missing or malformed Authorization header'}}, 
            401, 
        ); 
    } 

    if (!plaintext.startsWith('sk-gw-')) {
        return c.json(
            { error: { message: 'key format invalid; expected prefix sk-gw-' } },
            401,
          );
    }

    const row = KEY_DB[plaintext]; 
    if (!row) {
        return .json({error: {message: 'invalid key'}}, 401); 
    }

    c.set('auth', row); 
    return await next(); 
}; 

export function requireAdminToken(expected: string): MiddlewareHandler {
    return async(c, next) => {
        const token = c.req.header('X-Admin-Token'); 
        // Constant-time-ish compare for teaching (book does the same idea).
        const a = Buffer.from(token); 
        const b = Buffer.from(expected); 

        if (a.length !== b.length || !timingSafeEqual(a, b)) {
            return c.json({error: {message: 'invalid admin token'}}, 401); 
        }
        
        await next(); 
    }; 
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    let out = 0;
    for (let i = 0; i < a.length; i++) out |= a[i]! ^ b[i]!;
    return out === 0;
  }
  
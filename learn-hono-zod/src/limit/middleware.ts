/**
 * Limit middleware patterns from the book: 
 * 1. Read body with c.req.json() in middleware 
 * 2. Hono caches JSON - the handler can call c.req.json() again safely
 * 3. Inject estimated fields via c.set('limit', ...)
 * 
 * Full Zod validation is deferred to the handler (same as book Ch6/Ch7). 
*/

import type { MiddlewareHandler } from "hono";

import type { AuthVariables } from "../auth/middleware.js";
import type { IRChatRequest } from "../types/ir.js";

export interface LimitContext {
    estimatedPromptChars: number; 
    maxTokens: number; 
    // Fake TPM reservation handle for the teaching path 
    reservationId: string; 
}

export type LimitVariables = AuthVariables & { limit: LimitContext }; 
export const rateLimit: MiddlewareHandler<{ Variables: LimitVariables }> = async (c, next) => {
    // Body is consumed here. Downstream handlers must re-read via c.req.json() 
    // (Hono caches the parsed JSON) or use c.get('limit')
    const raw = await c.req.json().catch(() => null); 
    if (!raw || typeof raw != 'object') {
        return c.json({error: {message: 'request body must be JSON'}}, 400);         
    }

    const body = raw as IRChatRequest; 
    if (!body.model || !Array.isArray(body.messages)) {
        return c.json({error: {message: 'model and messages are required'}}, 400); 
    }

    const promptText = body.messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');

    const estimatedPromptChars = promptText.length; 
    const maxTokens = body.max_tokens ?? 256; 

    // Toy limit: reject huge prompts (stands in for TPM check).
    if (estimatedPromptChars + maxTokens > 20_000) {
        return c.json(
            {
                error: {
                    message: 'rate limit exceeded (demo TPM)',
                    type: 'rate_limit_error', 
                }, 
            }, 
            429
        ); 
    }

    // everything goes on ok, we need to transfer current context into next layer 
    // by updating the Hono cache set 
    // set passing parameter value should satisfied with the generic type passing variable 
    // LimitContext ,and key name should be the 'limit' as we declare when we create the variable of LimitVariables
    c.set('limit', {
        estimatedPromptChars, 
        maxTokens, 
        reservationId: 'demo-reservation-id', 
    }); 

    // Call next() to pass control to the next middleware or handler
    // next() is just like the FilterChain that we widely used in the Filter Chain Pattern
    // like in java we do : doFilter(HttpSerRequest ..., HttpServletResponse ..., FilterChain chain)
    // and in the chain we do : chain.doFilter(request, response);
    // but here since our Hono will control it's cache always available for the next middleware or handler
    // so we don't need to call chain.doFilter(request, response);
    // instead we just call next() to pass control to the next middleware or handler     
    await next();   
}
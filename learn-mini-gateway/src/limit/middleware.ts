import type { MiddlewareHandler } from "hono";

import type { AuthVariables } from "../auth/middleware.js"; 
import { estimatePromptTokens } from "../billing/tokenizer.js";
import type { IRChatRequest, IRMessage } from "../types/ir.js";


export interface LimitContext {
    estimatedPromptTokens: number; 
    maxTokens: number; 
    tpmHandles: Array<{key: string; reserved: number}>; 
}


export type AppVariables = AuthVariables & {limit: LimitContext}; 


// threshold for largest token cnts per minute 
const TPM_LIMIT = 5000; 

// bucket for rate limiting 
// key: user id, value: {used: number, exp: number} -- used: current token cnts, exp: expiration timestamp 
const buckets = new Map<string, {used: number, exp: number}>(); 

function bucket(key: string) {
    const now = Date.now(); 
    const b = buckets.get(key);  

    // checkout out whether the fetched record is valid
    // is valid depends on whether b is non-null and b#expiration field is > now 
    if (b && b.exp > now) return b; 

    // otherwise not exist or expired, create a new one insert or overwrite original one via the given key
    // cause TPM M means minute, so expired timestamp = now + 60 * 1000 ms
    const n = {used: 0, exp: now + 60_000}; 

    buckets.set(key, n);    
    return n; 
}


/**
 * TPM settle helpers — Saga-style: reserve → commit | release (compensate).
 *
 * releaseTpm: undo a reservation that should not stay charged on the bucket.
 * Typical callers (NOT "wait out the ban, then return quota"):
 *   1) Partial multi-key reserve rollback: key OK, model/global hits 429
 *      → release already-reserved handles for this request, then return 429.
 *   2) Later pipeline failure after TPM reserved: Zod 400, wallet 402,
 *      upstream error/abort → releaseTpm (+ wallet refund when money was taken).
 *
 * Bucket window expiry (60s) is separate: expired bucket is replaced, not releaseTpm.
 */
export function releaseTpm(handles: LimitContext['tpmHandles']) {
    for (const h of handles) {
        const b = bucket(h.key); 
        if (b) b.used = Math.max(0, b.used - h.reserved);  
    }
}

/**
 * commitTpm: success-path settle after upstream finishes (pair with wallet postConsume).
 *
 * Adjusts bucket.used by delta = (actual - reserved):
 *   - actual < reserved → delta < 0 → return over-reserved TPM quota
 *   - actual > reserved → delta > 0 → charge the under-estimated extra
 *   - actual == reserved → no change
 *
 * Call this on finalize success. Do NOT use releaseTpm for over-reserve;
 * commit already handles the refund via a negative delta.
 */
export function commitTpm(handles: LimitContext['tpmHandles'], actual: number) {
    for (const h of handles) {
        const b = buckets.get(h.key); 
        if (!b) continue; 
        // b.used <- max(0, b.used + (100 - 90))  -- actual > reserved; delta > 0
        // b.used <- max(0, b.used + (100 - 120)) -- actual < reserved; delta < 0
        b.used = Math.max(0, b.used + (actual - h.reserved)); 
    }
}


export const rateLimit: MiddlewareHandler<{Variables: AppVariables}> = async (c, next) => {
    const raw = (await c.req.json()).catch(() => null);  
    if (!raw?.model || !Array.isArray(raw.messages)) {
        return c.json({error: {message: 'model/messages required'}}, 400); 
    } 

    const auth = c.get('auth'); 
    const maxTokens = raw.max_tokens ?? 128; 
    // here we interrupt each request body's inner message & model name
    // and based on the message content + request wanna used model name, 
    // we can estimate the prompt token number  
    const estimatedPromptTokens = estimatePromptTokens(raw.messages, raw.model); 
    const need = estimatedPromptTokens + maxTokens; 

    const keys = [`key: ${auth.keyId}`, `model:${raw.model}`, 'global']; 
    const tpmHandles :LimitContext['tpmHandles'] = []; 

    for (const key of keys) {
        const b = bucket(key); 
        if (b.used + need > TPM_LIMIT) {
            releaseTpm(tpmHandles); 
            return c.json({error: {message: `TPM exceeded on ${key}`}}, 429); 
        }
        b.used += need; 
        tpmHandles.push({key, reserved: need});  
    }
    c.set('limit', {estimatedPromptTokens, maxTokens, tpmHandles}); 
    await next(); 
}; 
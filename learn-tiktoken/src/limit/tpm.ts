/**
 * TPM reserve / commit / release (TPM) - same three-phase idea as money (Ch6), 
 * orthogonal axis (429 vs 402). 
 * 
 * Uses a fixed 60s rolling bucket (book's TPM choice), sliding window. 
*/
export interface TpmHandle {
    limitKey: string; 
    reservedTokens: number; 
    bucketId: number; 
} 

interface Bucket {
    id: number; 
    used: number; 
    expiresAt: number; 
}

const LIMIT = 2_000; 
const buckets = new Map<string, Bucket>(); 

function currentBucket(limitKey: string): Bucket {
    const now = Date.now(); 
    const existing = buckets.get(limitKey);  
    if (existing && existing.expiresAt > now) {
        return existing; 
    }

    const b: Bucket = {id: now, used: 0, expiresAt: now + 60_000}; 
    buckets.set(limitKey, b); 
    return b; 
}

export function reserveTpm(limitKey: string, tokens: number): TpmHandle | null {
    const b = currentBucket(limitKey); 
    
    if (b.used + tokens > LIMIT) {
        return null; 
    }

    b.used += tokens; 
    return {limitKey, reservedTokens: tokens, bucketId: b.id}; 
}

export function commitTpm(handle: TpmHandle, actualTokens: number): void {
    const b = buckets.get(handle.limitKey); 
    if (!b || b.id !== handle.bucketId) return; 
    b.used += actualTokens - handle.reservedTokens;  
    if (b.used < 0) b.used = 0; 
}

export function releaseTpm(handle: TpmHandle): void {
    const b = buckets.get(handle.limitKey); 
    if (!b || b.id !== handle.bucketId) return; 
    b.used -= handle.reservedTokens; 
    if (b.used < 0) b.used = 0; 
}

/**
 * Demo helper for partial multi-dimension rollback. 
*/
export function releaseAll(handles: TpmHandle[]): void {
    for (const h of handles) releaseTpm(h); 
}

export function peekTpm(limitKey: string): {
    used: number; 
    limit: number; 
} {
    const b = currentBucket(limitKey); 
    return { used: b.used, limit: LIMIT }; 
}
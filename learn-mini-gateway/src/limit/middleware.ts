import type { MiddlewareHandler } from 'hono';

import type { AuthVariables } from '../auth/middleware.js';
import { estimatePromptTokens } from '../billing/tokenizer.js';
import type { IRChatRequest } from '../types/ir.js';

export interface LimitContext {
  estimatedPromptTokens: number;
  maxTokens: number; // max completion tokens  
  tpmHandles: Array<{ key: string; reserved: number }>;
}

export type AppVariables = AuthVariables & { limit: LimitContext };
// {auth: AuthContext, limit: LimitContext } -> hono internal cache -> {'auth' -> AuthContext, 'limit' -> LimitContext}
// hono interal cache support two types
// kv -> {'auth' -> AuthContext)} cache handler fetch hono internal cache c.set('auth', {xxx}: AuthContext), c.get('auth') -> AuthContext 
// kv -> {'limit' -> LimitContext} cache handler fetch hono internal cache c.set('limit', {xxx}: LimitContext), c.get('limit') -> LimitContext 
export const TPM_LIMIT = 5000;
const buckets = new Map<string, { used: number; exp: number }>();

/** Test helper — clears fixed-window TPM buckets. */
export function resetTpmForTests() {
  buckets.clear();
}

// getOrDefault(key, new {user:0, exp: now + 60_000})
function bucket(key: string) {
  const now = Date.now();
  const b = buckets.get(key);
  if (b && b.exp > now) return b; 
  const n = { used: 0, exp: now + 60_000 };
  buckets.set(key, n);
  return n;
}

// - refund -> release token -> refund token -> TPM , refund money -> balance/
export function releaseTpm(handles: LimitContext['tpmHandles']) {
  for (const h of handles) {
    const b = buckets.get(h.key);
    if (b) b.used = Math.max(0, b.used - h.reserved);
  }
}

// - postConsume
export function commitTpm(handles: LimitContext['tpmHandles'], actual: number) {
  for (const h of handles) {
    const b = buckets.get(h.key);
    if (!b) continue;
    b.used = Math.max(0, b.used + (actual - h.reserved));
  }
}

export const rateLimit: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  const raw = (await c.req.json().catch(() => null)) as IRChatRequest | null;
  if (!raw?.model || !Array.isArray(raw.messages)) {
    return c.json({ error: { message: 'model/messages required' } }, 400);
  }

  const auth = c.get('auth');
  const maxTokens = raw.max_tokens ?? 128;
  const estimatedPromptTokens = estimatePromptTokens(raw.messages, raw.model);
  const need = estimatedPromptTokens + maxTokens;

  const keys = [`key:${auth.keyId}`, `model:${raw.model}`, 'global'];
  const tpmHandles: LimitContext['tpmHandles'] = [];

  for (const key of keys) {
    const b = bucket(key);
    if (b.used + need > TPM_LIMIT) {
      releaseTpm(tpmHandles);
      return c.json({ error: { message: `TPM exceeded on ${key}` } }, 429);
    }
    b.used += need;
    tpmHandles.push({ key, reserved: need });
  }

  c.set('limit', { estimatedPromptTokens, maxTokens, tpmHandles });
  await next();
};

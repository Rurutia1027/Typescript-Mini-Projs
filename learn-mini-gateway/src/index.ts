/**
 * Vertical slice combining Hono + Zod + tiktoken money/TPM + SSE finalize.
 * Maps to book examples/07 main path (simplified, in-memory).
 */

import { serve } from '@hono/node-server'; 
import { Hono } from 'hono'; 

import { requireGatewayKey } from './auth/middleware.js';
import { InsufficientBalanceError, getBalance, postConsume, preConsume, refund } from './billing/wallet.js';
import { commitTpm, rateLimit, releaseTpm, type AppVariables } from './limit/middleware.js';
import { proxySSE } from './streaming/sse-proxy.js';
import { IRChatRequestSchema } from './types/ir.js';

const UPSTREAM = process.env.UPSTREAM_URL ?? 'http://127.0.0.1:3198/v1/chat/completions';
const PORT = Number(process.env.PORT ?? 3104);

const app = new Hono<{Variables: AppVariables}>;

app.get('/health', (c) => c.json({ok: true})); 
app.get('/wallet/:userId', (c) => c.json({balance: getBalance(c.req.param('userId'))})); 

app.post('/v1/chat/completions', requireGatewayKey, rateLimit, async(c) => {
    const auth = c.get('auth'); 
    const limit = c.get('limit'); 

    // Second JSON read - Hono cache hit. 
    const raw = await c.req.json().catch(() => null);  
    const parsed = IRChatRequestSchema.safeParse(raw); 
    if (!parsed.success) {
        releaseTpm(limit.tpmHandles); 
        return c.json({error: {message: 'invalid', detail: parsed.error.format()}}, 400); 
    }

    const ir = {...parsed.data, stream: true, stream_options: {include_usage: true}}; 


    let reservationId: string; 
    let estimatedPromptTokens: number; 

    try {
        const r = preConsume(auth.userId, ir.model, ir.messages, limit.maxTokens); 
        reservationId = r.reservation.id; 
        estimatedPromptTokens = r.estimatePromptTokens;  
    } catch (e) {
        releaseTpm(limit.tpmHandles); 
        if (e instanceof InsufficientBalanceError) {
            return c.json({error: {message: e.message, type: 'insufficient_quota'}}, 402); 
        }
        throw e; 
    }

    return proxySSE({
        upstreamUrl: UPSTREAM, 
        body: ir,
        fallbackPromptTokens: estimatedPromptTokens,  
        heartbeatMs: 4000, 
        onFinalize: async (info) => {
            if (info.upstreamFailed && info.completionTokens === 0) {
                refund(reservationId); 
                releaseTpm(limit.tpmHandles); 
                return; 
            }

            // cancelled or success -> settle waht we got (book: finalized | canceled | partial)
            postConsume(reservationId, info.promptTokens, info.completionTokens); 
            commitTpm(limit.tpmHandles, info.promptTokens + info.completionTokens); 
            console.log('[settle]', {
                userId: auth.userId, 
                aborted: info.abortedByClient, 
                usage: { p: info.promptTokens, c: info.completionTokens}, 
                balance: getBalance(auth.userId), 
            }); 
        }, 
    }); 
}); 

serve({fetch: app.fetch, port: PORT}, (info) => {
    console.log(`learn-mini-gateway http://localhost:${info.port}`);
    console.log('Start upstream: npm run upstream');
}); 
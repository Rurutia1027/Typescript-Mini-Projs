/**
 * Tiny HTTP surface: estimate + reserve money + TPM, then settle or refund. 
*/
import { serve} from '@hono/node-server'; 
import { Hono } from 'hono';
import { z } from 'zod'; 

import {
    getBalance, 
    InsufficientBalanceError, 
    postConsume, 
    preConsume, 
    refund
} from './billing/calculator.js'; 

import { estimateCompletionTokens, estimatePromptTokens } from './billing/tokenizer.js';
import { commitTpm, peekTpm, releaseTpm, reserveTpm } from './limit/tpm.js';
import { ca } from 'zod/v4/locales';

const BodySchema = z.object({
    userId: z.string().default('alice'), 
    model: z.string().default('gpt-4o-mini'), 
    messages: z
        .array(
            z.object({
                role: z.string(),
                content: z.union([z.string(), z.array(z.any()), z.null()]), 
            }), 
        ).min(1), 
    max_tokens: z.number().int().positive().default(64), 
    // if true, simulate upstream failure -> refund + release TPM 
    fail: z.boolean().optional(), 
    // fake assistant text used for completion estimate when success 
    assistant_text: z.string().optional(), 
}); 

const app = new Hono(); 

app.get('/health', (c) => c.json({ok: true})); 

app.get('/wallet/:userId', (c) => {
    const userId = c.req.param('userId'); 
    return c.json({
        userId, 
        balanceMicro: getBalance(userId), 
        tpm: peekTpm(`key:${userId}`), 
    }); 
}); 

app.post('/v1/estimate', async (c) => {
    const parsed = BodySchema.safeParse(await c.req.json().catch(() => null)); 
    if (!parsed.success) {
        return c.json({error: parsed.error.format()}, 400); 
    }
    const {model, messages, max_tokens} = parsed.data; 
    const prompt = estimatePromptTokens(messages, model); 
    return c.json({
        model, 
        estimated_prompt_tokens: prompt, 
        estimated_completion_tokens: max_tokens, 
        estimated_total_tokens: prompt + max_tokens, 
    }); 
}); 


app.post('/v1/chat', async (c) => {
    const parsed = BodySchema.safeParse(await c.req.json().catch(() => null)); 
    if (!parsed.success) {
        return c.json({error: parsed.error.format()}, 400); 
    }

    const {userId, model, messages, max_tokens, fail, assistant_text} = parsed.data;  
    const estPrompt = estimatePromptTokens(messages, model); 
    const limitKey = `key:${userId}`; 


    // Dimension 1: TPM 
    const tpm = reserveTpm(limitKey, estPrompt + max_tokens); 
    if (!tpm) {
        return c.json({error: {message: 'TPM exceeded', type: 'rate_limit_error'}}, 429); 
    }

    // Dimension 2: money 
    let reservation; 
    try {
        reservation = preConsume({userId, model, messages, maxTokens: max_tokens});  
    } catch (e) {
        releaseTpm(tpm); 
        if (e instanceof InsufficientBalanceError) {
            return c.json({error: {message: e.message, type: 'insufficient_quota'}}, 402); 
        }
        throw e; 
    }

    if (fail) {
        refund(reservation.id); 
        releaseTpm(tpm); 
        return c.json({error: {message: 'upstream failed; refuneded'}}, 502); 
    }

    const text = assistant_text ?? 'Hello from learn-tiktoken.';
    const actualCompletion = estimateCompletionTokens(text, model);
    const actualPrompt = estPrompt;

    postConsume(reservation.id, actualPrompt, actualCompletion);
    commitTpm(tpm, actualPrompt + actualCompletion);

    return c.json({
        content: text,
        usage: {
        prompt_tokens: actualPrompt,
        completion_tokens: actualCompletion,
        total_tokens: actualPrompt + actualCompletion,
        },
        wallet_balance_micro: getBalance(userId),
        tpm: peekTpm(limitKey),
        reservation_id: reservation.id,
  });
}); 



const port = Number(process.env.PORT ?? 3102); 
serve({fetch: app.fetch, port}, (info) => {
    console.log(`learn-tiktoken on http://localhost:${info.port}`);
    console.log('Also try: npm run demo');
}); 
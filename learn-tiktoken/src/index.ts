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


const port = Number(process.env.PORT ?? 3102); 
serve({fetch: app.fetch, port}, (info) => {
    console.log(`learn-tiktoken on http://localhost:${info.port}`);
    console.log('Also try: npm run demo');
}); 
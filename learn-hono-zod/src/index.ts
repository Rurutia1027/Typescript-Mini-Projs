/**
 * Entry: typed Variables, middleware chain, Zod at the boundary,
 * mix of c.json and native Response (passthrough style).
 *
 * Intentionally NO app.onError — errors are handled in the handler,
 * matching book-llm-gateway examples/06–07.
 */

import { serve } from '@hono/node-server'; 
import { Hono } from 'hono';  

import { createAdminRouter } from './admin/routes.js';  
import { requireGatewayKey, type AuthVariables } from './auth/middleware.js';   
import { loadEnv } from './config/env.js'; 
import {rateLimit, type LimitVariables } from './limit/middleware.js'; 
import { IRChatRequestSchema, type IRChatRequest } from './types/ir.js'; 

const env = loadEnv();  

type AppVariables = LimitVariables; 

// Hono(root)
// request /admin => server  -> /admin/health => server -> 
const app = new Hono<{Variables: AppVariables }>(); 

// /heathh -> server 
app.get('/health', (c) => c.json({ok: true})); 

// mount filter  check request header contains admin token by checking 
// admin token loaded from Vault or AWS Secure Manger,  k8s configmap 

// sub-hono instance 
// -> /admin/*
// tree struct 
// root node 
// -> path -> /admin -> sub-node -> /health ; /keys 
// invoke function of sub-node -> /admin/health -> server -> 

// mount operation mount a new tree node (maybe with multiple sub-branches)
app.route('/admin', createAdminRouter(env.ADMIN_TOKEN)); 


//  client -> post requst of http 
// - path (/v1/chat/completions) 
// - request body 
// - request header 

// request -> (filters 
// - filter authentcation token is valid , db scan , user id, key id scan data load user metadata -> context c.set('auth', AuthContext)
// -  filter filter of rate limit request (messages -> line of string -> how tokens of prompt and complet tokens number
// total token number compare userId-> bucket<sliding window> (total tokens: TPM) )
// request promotp complet -> 100 tokens, userId -> account -> 1000 tokens 
// bucket userId  rate limiter every minute user 90 tokens / per minute -> TPM 
// authentication filter -> success -> rate limiter estimate tokens -> resource 

// update TPM values holded in side of the LimitContext  

// encpoint -> post 
app.post('/v1/chat/completions', requireGatewayKey, rateLimit, async (c) => {
    // here context -> AuthContext 
    // conxt limit -> LimitContext 
    const auth = c.get('auth');  
    const limit = c.get('limit'); 

    // second body read - hits Hono's JSON cache (same pattern as the book)
    const raw = await c.req.json().catch(() => null); 
    const parsed = IRChatRequestSchema.safeParse(raw); 

    if (!parsed.success) {
        return c.json(
            {
                error: {
                    message: 'invalid request',
                    detail: parsed.error.format(), 
                }, 
            }, 
            400, 
        ); 
    }



    const ir: IRChatRequest = parsed.data; 

    // Demonstrate "upstream error passthrough" with native Response 
    // (book uses this for non-2xx upstream / SSE). Avoid Hono streamSSE here. 
    if (ir.model === 'fail-upstream') {
        return new Response(JSON.stringify({error: {message: 'upstream error'}}), {
            status: 502, 
            headers: {'Content-Type': 'application/json'}, 
        })
    }

    // here we are just mock response message that satisfy the OpenAI API response schema
    return c.json({
        id: 'chatcmpl-demo',
        object: 'chat.completion', 
        created: Math.floor(Date.now() / 1000), 
        model: ir.model, 
        choices: [
            {
                index: 0, 
                message: {
                    role: 'assistant', 
                    content: `Hello ${auth.userId}. You reserved ${limit.reservationId}.`, 
                }, 
                finish_reason: 'stop', 
            }, 
        ], 
        usage: {
            prompt_tokens: Math.ceil(limit.estimatedPromptChars/ 4), 
            completion_tokens: 12, 
            total_tokens: Math.ceil(limit.estimatedPromptChars/ 4) + 12, 
        }, 
        // Echo passthrough fields to learners see .passthrough() working. 
        // here passthrough only cares the pattern match fields value validation 
        // coming response json body contains not pattern matched fields will not be validated
        echo_extra: (ir as Record<string, unknown>).custom_vendor_field ?? null, 
    })
}); 

serve({ fetch: app.fetch, port: env.PORT}, (info) => {
    console.log(`learn-hono-zod listening on http://localhost:${info.port}`); 
    console.log(`Try: curl -H "Authorization: Bearer sk-gw-alice" ...`); 
})

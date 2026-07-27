/**
 * Demo gateway: 
 * - POST /v1/chat/completions -> SSE proxy (book style)
*/

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { proxySSE } from './streaming/sse-proxy.js';

const UPSTREAM = process.env.UPSTREAM_URL ?? 'http://127.0.0.1:3199/v1/chat/completions';
const PORT = Number(process.env.PORT ?? 3103);

const app = new Hono();
const finalizeLog: unknown[] = [];

app.get('/health', (c) => c.json({ ok: true, upstream: UPSTREAM }));

app.get('/finalizes', (c) => c.json({ events: finalizeLog.slice(-20) }));

app.post('/v1/chat/completions', async (c) => {
    const body = await c.req.json().catch(() => null); 

    // no response received 
    if (!body) return c.json({ error: 'Invalid JSON body' }, 400);  

    // suppose we recv response contains lots of fields, we only keep body field as an object instance
    // and add an extra field stream: true to the object instance  
    const ir = {... (body as object), stream: true}; 

    // here we orgnaizing {} object and inner fields to invoke the proxySSE function 
    return proxySSE({
        upstreamUrl: UPSTREAM,  
        body: ir, 
        heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 3000), 

        // this func is for anything wrong happend inside of the proxySSE invocation 
        // then invoke this callback function, pass the function as the last parameter of ProxyOptions 
        onFinalize: async (result) => {
            finalizeLog.push(result);
            console.log('[finalize]', result);
        },
    }); 
}); 

serve({fetch: app.fetch, port: PORT}, (info) => {
    console.log(`learn-sse gateway http://localhost:${info.port}`);
    console.log(`Start upstream first: npm run upstream`);
});
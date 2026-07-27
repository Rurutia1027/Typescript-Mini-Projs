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

serve({fetch: app.fetch, port: PORT}, (info) => {
    console.log(`learn-sse gateway http://localhost:${info.port}`);
    console.log(`Start upstream first: npm run upstream`);
});
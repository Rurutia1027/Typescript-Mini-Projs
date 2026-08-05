/**
 * Demo gateway:
 *  - POST /v1/chat/completions → SSE proxy (book style)
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { proxySSE } from './streaming/sse-proxy.js';

const UPSTREAM = process.env.UPSTREAM_URL ?? 'http://127.0.0.1:3199/v1/chat/completions';
const PORT = Number(process.env.PORT ?? 3103);

const app = new Hono();
const finalizeLog: unknown[] = []; // OOM 

app.get('/health', (c) => c.json({ ok: true, upstream: UPSTREAM }));

app.get('/finalizes', (c) => c.json({ events: finalizeLog.slice(-20) }));

app.post('/v1/chat/completions', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'JSON body required' }, 400);

  // stream: true <- attached message field from our proxy 
  const ir = { ...(body as object), stream: true };

  return proxySSE({
    upstreamUrl: UPSTREAM,
    body: ir,
    heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 3000),
    onFinalize: async (result) => {
      // tracing stack , error stack 
      finalizeLog.push({ at: new Date().toISOString(), ...result });
      console.log('[onFinalize]', result);// result-> ProxyResult {}
    },
  });
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`learn-sse gateway http://localhost:${info.port}`);
  console.log(`Start upstream first: npm run upstream`);
});

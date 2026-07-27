/**
 * Vertical slice combining Hono + Zod + tiktoken money/TPM + SSE finalize.
 * Maps to book examples/07 main path (simplified, in-memory).
 */

import { serve } from '@hono/node-server'; 
import { Hono } from 'hono'; 

const UPSTREAM = process.env.UPSTREAM_URL ?? 'http://127.0.0.1:3198/v1/chat/completions';
const PORT = Number(process.env.PORT ?? 3104);

const app = new Hono(); 

serve({fetch: app.fetch, port: PORT}, (info) => {
    console.log(`learn-mini-gateway http://localhost:${info.port}`);
    console.log('Start upstream: npm run upstream');
}); 
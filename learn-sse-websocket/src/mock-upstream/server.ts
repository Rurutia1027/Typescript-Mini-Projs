/**
 * Fake OpenAI-style SSE upstream for local demos. 
 * Run: npm run upstream (port 3199)
*/

import { serve } from '@hono/node-server'; 
import { Hono } from 'hono'; 

const app = new Hono(); 

app.post('/v1/chat/completions', async (c) => {
    const body = await c.req.json(); 
    const stream = Boolean((body as {stream?: boolean}).stream); 

    // post body is plain text, echo if provided, otherwise default message
    const text = 
        typeof (body as {echo?: string}) === 'string' 
        ? (body as {echo: string}).echo 
        : 'Hello from mock upstream streaming tokens slowly.'; 
    
    if (!stream) {
        return c.json({
            id: 'chatcmpl-mock',
            choices: [{message: {role: 'assistant', content: text}, finish_reason: 'stop'}], 
            usage: {
                prompt_tokens: 10, 
                completion_tokens: 8, total_tokens: 18, 
            }, 
        }); 
    }

    // post body is JSON, stream the text with a delay between words

    const words = text.split(/(\s+)/).filter(Boolean);
    const encoder = new TextEncoder();

    const rs = new ReadableStream<Uint8Array>({
        async start(controller) {
            // Optional long silence so learners can observe heartbeats from the proxy. 
            const delayMs = Number((body as {delay_ms?: number}).delay_ms ?? 80); 
            for (const w of words) {
                const chunk = {
                    id: 'chatcmpl-mock',
                    object: 'chat.completion.chunk',
                    choices: [{index: 0, delta: {content: w}, finish_reason: null}], 
                }; 
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                await new Promise(resolve => setTimeout(resolve, delayMs)); 
            }

            const usageChunk = {
                id: 'chatcmpl-mock', 
                object: 'chat.completion.chunk',
                choices: [{index: 0, delta: {}, finish_reason: 'stop'}],  
                usage: {prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length}, 
            }; 

            controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`)); 
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`)); 
            controller.close(); 
        }, 
    }); 

    return new Response(rs, {
        headers: {
            'Content-Type': 'text/event-stream; charset=UTF-8', 
            'Cache-Control': 'no-cache', 
            Connection: 'keep-alive', 
        }, 
    });             
}); 

const port = Number(process.env.UPSTREAM_PORT ?? 3199); 
serve({fetch: app.fetch, port}, (info) => {
    console.log(`mock upstream SSE on http://localhost:${info.port}`); 
}); 
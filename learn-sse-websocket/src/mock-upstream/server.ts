/**
 * Fake OpenAI-style SSE upstream for local demos. 
 * Run: npm run upstream (port 3199)
*/

import { serve } from '@hono/node-server'; 
import { Hono } from 'hono'; 

const app = new Hono(); 

app.post('/v1/chat/completions', async (c) => {
    const body = await c.req.json(); 

    // try to extract stream(true | false) from recv json body
    // stream: true|false is required field, should be exist in the json body
    // extract field and then convert into boolean (true/false)
    const stream = Boolean((body as {stream?: boolean}).stream); 

    // try to extract echo field's value from recv json body
    // if no echo field detected, then assign default string to text 
    const text = 
        typeof (body as {echo?: string}) === 'string' 
        ? (body as {echo: string}).echo 
        : 'Hello from mock upstream streaming tokens slowly.'; 
    
    // no stream required, directly response normal http response 
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

    // otherwise, prepare to return response in SSE mode 
    // split received message string into small franctions by space 
    const words = text.split(/(\s+)/).filter(Boolean);
    const encoder = new TextEncoder();


    // here we create an instance of ReadableStream inner Uint8Array means each element is a [0...255] array of bytes 
    const rs = new ReadableStream<Uint8Array>({
        async start(controller) {
            // controller is used to delivery chunks converted item to http connection channel 
            const delayMs = Number((body as {delay_ms?: number}).delay_ms ?? 80); 

            // here we iterate each fractions that coming from split by space of the recv message body 
            for (const w of words) {
                // here we wrap each element into a chunk by adding extra metadata info 
                const chunk = {
                    id: 'chatcmpl-mock',
                    object: 'chat.completion.chunk',
                    // data fraction is embedded in delta: {content: ${data fraction}}
                    choices: [{index: 0, delta: {content: w}, finish_reason: null}], 
                }; 


                // commit chunk to http connection channel  
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));

                // here we add a delay between each chunk to simulate the slow streaming process 
                await new Promise(resolve => setTimeout(resolve, delayMs)); 
            }

            // here we add a final chunk to indicate the completion of the streaming process 
            const usageChunk = {
                id: 'chatcmpl-mock', 
                object: 'chat.completion.chunk',
                choices: [{index: 0, delta: {}, finish_reason: 'stop'}],  
                usage: {prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length}, 
            }; 

            // here we add a final chunk to indicate the completion of the stream process 
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`)); 

            // here we add a final chunk to indicate the completion of the stream process 
            // everytime client side receives this signal, client will finishing parsing the stream response  
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`)); 

            // connection between server side & client side will be terminate here 
            controller.close(); 
        }, 
    }); 

    return new Response(rs, {
        headers: {
            // here we set the content type to text/event-stream; charset=UTF-8
            // this is the standard format for SSE response
            'Content-Type': 'text/event-stream; charset=UTF-8', 
            // here we set the cache control to no-cache
            // this is the standard way to prevent caching of the response
            'Cache-Control': 'no-cache', 
            // here we set the connection to keep-alive
            // this is the standard way to keep the connection open for the streaming process
            // connection will be terminated when client side receives [DONE] signal, 
            Connection: 'keep-alive', 
        }, 
    });             
}); 

const port = Number(process.env.UPSTREAM_PORT ?? 3199); 
serve({fetch: app.fetch, port}, (info) => {
    console.log(`mock upstream SSE on http://localhost:${info.port}`); 
}); 
const SSE_DONE = 'data: [DONE]\n\n';
const SSE_HEARTBEAT = ': keepalive\n\n';

export interface FinalizeInfo {
    promptTokens: number; 
    completionTokens: number; 
    abortedByClient: boolean; 
    upstreamFailed: boolean; 
}

export async function proxySSE(opts: {
    upstreamUrl: string; 
    body: unknown; 
    fallbackPromptTokens: number; 
    heartbeatMs?: number; 
    onFinalize: (info: FinalizeInfo) => void | Promise<void>; 
}): Promise<Response> {
    const upstreamCtrl = new AbortController();  
    let clientAborted = false; 
    let completionText = ''; 
    let promptTokens = opts.fallbackPromptTokens;  
    let completionTokens = 0;  
    let upstreamUsage = false; 
    
    let upstreamResp: Response; 


    try {
        // 1. send request to upstream server 
        upstreamResp = await fetch(opts.upstreamUrl, {
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify(opts.body), 
            signal: upstreamCtrl.signal, 
        }); 
    } catch {

        // send request to upstream server failed, 
        // rollback the tokens and notify the client  
        await opts.onFinalize({
            promptTokens,  
            completionTokens, 
            abortedByClient: clientAborted, 
            upstreamFailed: true,  
        }); 

        return new Response(JSON.stringify({error: 'upstream unreachable'}), {
            status: 502, 
            headers: {'Content-Type': 'application/json'}, 
        })
    }

   
    // 2. if recv upstream response body is empty or status not ok 
    // rollback the tokens and notify the client   
    if (!upstreamResp.ok || !upstreamResp.body) {
        await opts.onFinalize({
            promptTokens, 
            completionTokens,
            abortedByClient: false, 
            upstreamFailed: true, 
        }); 

        return new Response(await upstreamResp.text(), {
            status: upstreamResp.status, 
            headers: {'Content-Type': 'application/json'}, 
        }); 
    }

     // 3. receive & parse response from upstream server 
     const reader = upstreamResp.body.getReader(); 
     const decoder = new TextDecoder(); 

     const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const enc = new TextEncoder(); 
            let buf = '';
            let done = false; 

            const hb = setInterval(() => {
                try {
                    controller.enqueue(enc.encode(SSE_HEARTBEAT)); 
                } catch {
                    // closed 
                }
            }, opts.heartbeatMs ?? 5000); 

            const finish = async (failed: boolean) => {
                if (done) return; 
                done = true; 
                clearInterval(hb); 
                if (!upstreamUsage) {
                    // Local fallback when upstream omitted usage (book uses tiktoken; here ~4 chars/token).
                    // Keep 0 when nothing was generated so finalize can refund cleanly.
                    completionTokens = Math.ceil(completionText.length / 4);
                }

                await opts.onFinalize({
                    promptTokens,
                    completionTokens,
                    abortedByClient: clientAborted,
                    upstreamFailed: failed, 
                }); 
            }; 

            try {
                while (true) {
                    const {value, done: rd} = await reader.read(); 
                    if (rd) break; 
                    buf += decoder.decode(value, {stream: true}); 
                    let idx; 

                    while ((idx = buf.indexOf('\n\n')) !== -1) {
                        const block = buf.slice(0, idx); 
                        buf = buf.slice(idx + 2); 
                        for (const line of block.split('\n')) {
                            if (line.startsWith(':') || !line.startsWith('data:')) {
                                // no data as suffix , skip 
                                continue; 
                            }
                            // when we got here, it means current line is kind of: "data:xxxxxx"
                            // data content need skip 5 characters 'data:' to retrieve 
                            const data = line.slice(5).trim();  
                            if (data === '[DONE]') {
                                // this is the terminiation signal semantic 
                                if (!clientAborted) {
                                    controller.enqueue(enc.encode(SSE_DONE)); 
                                }
                                await finish(false); 
                                controller.close(); 
                                return; 
                            }

                            try {
                                const json = JSON.parse(data) as {
                                    choices?: Array<{delta?: {content?: string}}>, 
                                    usage?: {prompt_tokens?: number; completion_tokens?: number;}; 
                                }; 

                                const piece = json.choices?.[0]?.delta?.content; 
                                if (piece) {
                                    completionText += piece;  
                                }

                                if (json.usage) {
                                    upstreamUsage = true; 
                                    promptTokens = json.usage.prompt_tokens ?? promptTokens; 
                                    completionTokens = json.usage.completion_tokens ?? completionTokens; 
                                }
                            } catch {}
                            controller.enqueue(enc.encode(`data: ${data}\n\n`)); 
                        }
                    }
                }

                if (!clientAborted) controller.enqueue(enc.encode(SSE_DONE)); 
                await finish(false); 
                controller.close(); 
            } catch {
                await finish(!clientAborted); 
                try {
                    controller.close(); 
                } catch {
                    /***/
                }
            }
        }, cancel() {
            clientAborted = true;
            upstreamCtrl.abort(); 
            void reader.cancel(); 
        }, 
     }); 

    return new Response(stream, {
        status: 200, 
        headers: {
            'Content-Type': 'text/event-stream', 
            'Cache-Control': 'no-cache', 
            'Connection': 'keep-alive', 
            'X-Accel-Buffering': 'no', 
            'Transfer-Encoding': 'chunked', 
            'Access-Control-Allow-Origin': '*', 
            'Access-Control-Allow-Methods': 'POST, OPTIONS', 
            'Access-Control-Allow-Headers': 'Content-Type', 
            'Access-Control-Max-Age': '86400', 
        }
    }); 
}
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

        }, cancel() {
            clientAborted: true; 
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
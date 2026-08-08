const SSE_DONE = 'data: [DONE]\n\n';
const SSE_HEARTBEAT = ': keepalive\n\n';

export interface FinalizeInfo {
  promptTokens: number; // input token 
  completionTokens: number; // output token 
  abortedByClient: boolean; // 
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
    upstreamResp = await fetch(opts.upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body),
      signal: upstreamCtrl.signal,
    });
  } catch {
    await opts.onFinalize({
      promptTokens,
      completionTokens: 0,
      abortedByClient: clientAborted,
      upstreamFailed: true,
    }); // rollback operation  
    return new Response(JSON.stringify({ error: 'upstream unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!upstreamResp.ok || !upstreamResp.body) {
    await opts.onFinalize({
      promptTokens,
      completionTokens: 0,
      abortedByClient: false,
      upstreamFailed: true,
    }); // rollback operation  / compensate operation 
    return new Response(await upstreamResp.text(), {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const reader = upstreamResp.body.getReader();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let buf = '';
      let done = false;

      // closure ; hook; callback
      const hb = setInterval(() => {
        try {
          controller.enqueue(enc.encode(SSE_HEARTBEAT));
        } catch {
          /* closed */
        }
      }, opts.heartbeatMs ?? 5000);

      const finish = async (failed: boolean) => {
        if (done) return;
        done = true;
        clearInterval(hb);
        if (!upstreamUsage) {
          // Local fallback estimate of completion text length ≈ tokens/4ish — book uses tiktoken.
          completionTokens = Math.max(1, Math.ceil(completionText.length / 4));
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
          const { value, done: rd } = await reader.read();
          if (rd) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of block.split('\n')) {
              if (line.startsWith(':') || !line.startsWith('data:')) continue;
              const data = line.slice(5).trimStart();
              if (data === '[DONE]') {
                if (!clientAborted) controller.enqueue(enc.encode(SSE_DONE));
                await finish(false);
                controller.close();
                return;
              }
              try {
                const json = JSON.parse(data) as {
                  choices?: Array<{ delta?: { content?: string } }>;
                  usage?: { prompt_tokens?: number; completion_tokens?: number };
                };
                const piece = json.choices?.[0]?.delta?.content;
                if (piece) completionText += piece;
                if (json.usage) {
                  upstreamUsage = true;
                  promptTokens = json.usage.prompt_tokens ?? promptTokens;
                  completionTokens = json.usage.completion_tokens ?? completionTokens;
                }
              } catch {
                /* ignore */
              }
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
          /* */
        }
      }
    },
    cancel() {
      clientAborted = true;
      upstreamCtrl.abort();
      void reader.cancel();
    },
  });

  /// server -> client (big) -> (heartbeat) -> client
  // client -> server still keep using the traditional way of http 
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=UTF-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

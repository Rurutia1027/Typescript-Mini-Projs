/**
 * Gateway-style SSE proxy:
 * - AbortController on upstream fetch
 * - ReadableStream.cancel → reverse abort
 * - Heartbeat comments every N ms
 * - Parse \n\n frames + data: lines
 * - onFinalize for billing/TPM settle (caller-owned)
 *
 * Do NOT use Hono streamSSE (Node adapter abort pitfall — see book Ch7).
 */
import {
  encodeSseData,
  extractDataLines,
  splitSseEvents,
  SSE_DONE,
  SSE_HEARTBEAT,
} from './sse-format.js';

export interface ProxyResult {
  chunks: number;
  abortedByClient: boolean;
  upstreamFailed: boolean;
  durationMs: number;
  lastText: string;
}

export interface ProxyOptions {
  upstreamUrl: string;
  body: unknown;
  headers?: Record<string, string>;
  heartbeatMs?: number;
  onFinalize: (result: ProxyResult) => void | Promise<void>;
}

export async function proxySSE(opts: ProxyOptions): Promise<Response> {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const upstreamCtrl = new AbortController();
  let clientAborted = false;
  let chunks = 0;
  let lastText = '';
  const start = Date.now();

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(opts.upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(opts.body),
      signal: upstreamCtrl.signal,
    });
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    await opts.onFinalize({
      chunks: 0,
      abortedByClient: aborted,
      upstreamFailed: !aborted,
      durationMs: Date.now() - start,
      lastText: '',
    });
    return new Response(JSON.stringify({ error: 'upstream unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!upstreamResp.ok || !upstreamResp.body) {
    const text = await upstreamResp.text();
    await opts.onFinalize({
      chunks: 0,
      abortedByClient: false,
      upstreamFailed: true,
      durationMs: Date.now() - start,
      lastText: '',
    });
    return new Response(text, {
      status: upstreamResp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const reader = upstreamResp.body.getReader();
  const decoder = new TextDecoder();

  const downstream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let buffer = '';
      let finalized = false;

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(SSE_HEARTBEAT));
        } catch {
          /* closed */
        }
      }, heartbeatMs);

      const finalize = async (aborted: boolean, failed: boolean) => {
        if (finalized) return;
        finalized = true;
        clearInterval(heartbeat);
        await opts.onFinalize({
          chunks,
          abortedByClient: aborted,
          upstreamFailed: failed,
          durationMs: Date.now() - start,
          lastText,
        });
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = splitSseEvents(buffer);
          buffer = rest;

          for (const block of events) {
            for (const data of extractDataLines(block)) {
              if (data === '[DONE]') {
                if (!clientAborted) controller.enqueue(enc.encode(SSE_DONE));
                await finalize(clientAborted, false);
                controller.close();
                return;
              }
              let parsed: unknown;
              try {
                parsed = JSON.parse(data);
                const json = parsed as {
                  choices?: Array<{ delta?: { content?: string } }>;
                };
                const piece = json.choices?.[0]?.delta?.content ?? '';
                lastText += piece;
              } catch {
                // Ignore non-JSON data lines from upstream.
                continue;
              }
              chunks += 1;
              controller.enqueue(enc.encode(encodeSseData(parsed)));
            }
          }
        }

        if (!clientAborted) controller.enqueue(enc.encode(SSE_DONE));
        await finalize(clientAborted, false);
        controller.close();
      } catch (err) {
        await finalize(clientAborted, !clientAborted);
        try {
          controller.error(err);
        } catch {
          /* ignore */
        }
      }
    },
    cancel() {
      clientAborted = true;
      upstreamCtrl.abort();
      reader.cancel().catch(() => undefined);
    },
  });

  return new Response(downstream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=UTF-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

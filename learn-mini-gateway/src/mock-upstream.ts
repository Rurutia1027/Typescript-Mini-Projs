import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { pathToFileURL } from 'node:url';

export function createUpstreamApp() {
  const app = new Hono();

  app.post('/v1/chat/completions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const text =
      typeof (body as { echo?: string }).echo === 'string'
        ? (body as { echo: string }).echo
        : 'Mini gateway mock reply with several words.';
    const delay = Number((body as { delay_ms?: number }).delay_ms ?? 60);
    const words = text.split(/(\s+)/).filter(Boolean);
    const enc = new TextEncoder();

    const rs = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const w of words) {
          const chunk = {
            id: 'chatcmpl-mini',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: w }, finish_reason: null }],
          };
          controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          await new Promise((r) => setTimeout(r, delay));
        }
        const usage = {
          id: 'chatcmpl-mini',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: words.length,
            total_tokens: 12 + words.length,
          },
        };
        controller.enqueue(enc.encode(`data: ${JSON.stringify(usage)}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(rs, {
      headers: {
        'Content-Type': 'text/event-stream; charset=UTF-8',
        'Cache-Control': 'no-cache',
      },
    });
  });

  return app;
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.UPSTREAM_PORT ?? 3198);
  serve({ fetch: createUpstreamApp().fetch, port }, () => {
    console.log(`mini mock upstream :${port}`);
  });
}

/**
 * Hono app factory — kept separate from listen() so tests can boot on ephemeral ports.
 */
import { Hono } from 'hono';

import { requireGatewayKey } from './auth/middleware.js';
import { InsufficientBalanceError, getBalance, postConsume, preConsume, refund } from './billing/wallet.js';
import { commitTpm, rateLimit, releaseTpm, type AppVariables } from './limit/middleware.js';
import { proxySSE } from './streaming/sse-proxy.js';
import { IRChatRequestSchema } from './types/ir.js';

export function createApp(opts: { upstreamUrl: string }) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/wallet/:userId', (c) => c.json({ balance: getBalance(c.req.param('userId')) }));

  app.post('/v1/chat/completions', requireGatewayKey, rateLimit, async (c) => {
    const auth = c.get('auth'); // AuthContext
    const limit = c.get('limit'); // LimitContext

    // Second JSON read — Hono cache hit.
    const raw = await c.req.json().catch(() => null);
    const parsed = IRChatRequestSchema.safeParse(raw);
    if (!parsed.success) {
      releaseTpm(limit.tpmHandles); // compensate operation
      return c.json({ error: { message: 'invalid', detail: parsed.error.format() } }, 400);
    }

    const ir = { ...parsed.data, stream: true, stream_options: { include_usage: true } };

    let reservationId: string;
    let estimatedPromptTokens: number;
    try {
      const r = preConsume(auth.userId, ir.model, ir.messages, limit.maxTokens); // frozen money(micro-dollar)
      reservationId = r.reservation.id;
      estimatedPromptTokens = r.estimatedPromptTokens;
    } catch (e) {
      releaseTpm(limit.tpmHandles);
      if (e instanceof InsufficientBalanceError) {
        return c.json({ error: { message: e.message, type: 'insufficient_quota' } }, 402);
      }
      throw e;
    }

    return proxySSE({
      upstreamUrl: opts.upstreamUrl,
      body: { ...ir, echo: (ir as { echo?: string }).echo },
      fallbackPromptTokens: estimatedPromptTokens,
      heartbeatMs: 4000,
      onFinalize: async (info) => {
        if (info.upstreamFailed && info.completionTokens === 0) {
          refund(reservationId); /// user balance account
          releaseTpm(limit.tpmHandles); // release occupation of the tokens record updated inside of the bucket
          return;
        }
        // canceled or success → settle what we got (book: finalized | canceled | partial)
        postConsume(reservationId, info.promptTokens, info.completionTokens);
        commitTpm(limit.tpmHandles, info.promptTokens + info.completionTokens);
        console.log('[settle]', {
          userId: auth.userId,
          aborted: info.abortedByClient,
          usage: { p: info.promptTokens, c: info.completionTokens },
          balance: getBalance(auth.userId),
        });
      },
    });
  });

  return app;
}

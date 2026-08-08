/**
 * Integration tests: real HTTP upstream + gateway on ephemeral ports.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { serve } from '@hono/node-server';

import { createApp } from '../src/app.js';
import { resetWalletForTests, setBalanceForTests } from '../src/billing/wallet.js';
import { resetTpmForTests, TPM_LIMIT } from '../src/limit/middleware.js';
import { createUpstreamApp } from '../src/mock-upstream.js';

function listen(fetchHandler: Parameters<typeof serve>[0]['fetch']) {
  return new Promise<{ server: Server; base: string }>((resolve, reject) => {
    const server = serve({ fetch: fetchHandler, port: 0 }, (info) => {
      resolve({
        server: server as unknown as Server,
        base: `http://127.0.0.1:${info.port}`,
      });
    });
    server.on('error', reject);
  });
}

const AUTH = { Authorization: 'Bearer sk-gw-alice', 'Content-Type': 'application/json' };

describe('learn-mini-gateway integration', () => {
  let upstream: Awaited<ReturnType<typeof listen>>;
  let gateway: Awaited<ReturnType<typeof listen>>;

  before(async () => {
    upstream = await listen(createUpstreamApp().fetch);
    gateway = await listen(
      createApp({ upstreamUrl: `${upstream.base}/v1/chat/completions` }).fetch,
    );
  });

  after(async () => {
    await Promise.all([
      new Promise<void>((r) => upstream.server.close(() => r())),
      new Promise<void>((r) => gateway.server.close(() => r())),
    ]);
  });

  beforeEach(() => {
    resetWalletForTests();
    resetTpmForTests();
  });

  test('GET /health', async () => {
    const res = await fetch(`${gateway.base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test('401 unauthorized', async () => {
    const res = await fetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer bad-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 401);
  });

  test('400 missing model/messages', async () => {
    const res = await fetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ model: 'gpt-4o-mini' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /model\/messages/);
  });

  test('429 TPM exceeded', async () => {
    const res = await fetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: TPM_LIMIT,
      }),
    });
    assert.equal(res.status, 429);
  });

  test('402 insufficient wallet', async () => {
    // Keep need under TPM_LIMIT so rate-limit passes; wallet rejects.
    setBalanceForTests('alice', 10);
    const res = await fetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 128,
      }),
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: { type: string } };
    assert.equal(body.error.type, 'insufficient_quota');
  });

  test('200 SSE happy path settles wallet', async () => {
    const before = (await (await fetch(`${gateway.base}/wallet/alice`)).json()) as {
      balance: number;
    };

    const res = await fetch(`${gateway.base}/v1/chat/completions`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        echo: 'one two',
        max_tokens: 64,
        delay_ms: 5,
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const text = await res.text();
    assert.match(text, /data: \[DONE\]/);
    assert.match(text, /"content":"one"/);

    const after = (await (await fetch(`${gateway.base}/wallet/alice`)).json()) as {
      balance: number;
    };
    assert.ok(
      after.balance < before.balance,
      `expected balance drop: ${before.balance} → ${after.balance}`,
    );
  });

  test('502 upstream unreachable refunds', async () => {
    const lonely = await listen(
      createApp({ upstreamUrl: 'http://127.0.0.1:1/v1/chat/completions' }).fetch,
    );
    try {
      const before = (await (await fetch(`${lonely.base}/wallet/alice`)).json()) as {
        balance: number;
      };
      const res = await fetch(`${lonely.base}/v1/chat/completions`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 32,
        }),
      });
      assert.equal(res.status, 502);
      const after = (await (await fetch(`${lonely.base}/wallet/alice`)).json()) as {
        balance: number;
      };
      assert.equal(after.balance, before.balance);
    } finally {
      await new Promise<void>((r) => lonely.server.close(() => r()));
    }
  });
});

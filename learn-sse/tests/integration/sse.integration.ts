import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';

const UPSTREAM_PORT = 33199;
const GATEWAY_PORT = 33103;
const UPSTREAM_URL = `http://127.0.0.1:${UPSTREAM_PORT}/v1/chat/completions`;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startProcess(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  return child;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      // Retry until timeout.
    }
    await sleep(150);
  }
  throw new Error(`Health check timed out for ${url}`);
}

async function readSseResponse(resp: Response): Promise<string> {
  assert(resp.body, 'expected streaming body');
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function runHappyPath(): Promise<void> {
  const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      echo: 'Streaming one word at a time',
      delay_ms: 40,
    }),
  });
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('content-type')?.startsWith('text/event-stream'), true);
  const body = await readSseResponse(resp);
  assert.match(body, /data: \[DONE\]/);
  assert.match(body, /"content":"Streaming"/);
}

async function runInvalidJsonPath(): Promise<void> {
  const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not-json',
  });
  assert.equal(resp.status, 400);
  const payload = (await resp.json()) as { error?: string };
  assert.equal(payload.error, 'JSON body required');
}

async function runAbortPath(): Promise<void> {
  const ac = new AbortController();
  const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      echo: 'one two three four five six seven eight nine ten',
      delay_ms: 200,
    }),
    signal: ac.signal,
  });
  assert.equal(resp.status, 200);
  assert(resp.body, 'expected stream body for abort path');

  const reader = resp.body.getReader();
  await reader.read();
  await sleep(150);
  ac.abort();
  await reader.cancel().catch(() => undefined);

  let abortedSeen = false;
  for (let i = 0; i < 15; i += 1) {
    const finalizeResp = await fetch(`${GATEWAY_URL}/finalizes`);
    const payload = (await finalizeResp.json()) as {
      events: Array<{ abortedByClient?: boolean }>;
    };
    abortedSeen = payload.events.some((event) => event.abortedByClient === true);
    if (abortedSeen) break;
    await sleep(120);
  }
  assert.equal(abortedSeen, true, 'expected abortedByClient=true in finalize events');
}

async function main(): Promise<void> {
  const upstream = startProcess('node', ['node_modules/.bin/tsx', 'src/mock-upstream/server.ts'], {
    UPSTREAM_PORT: String(UPSTREAM_PORT),
  });
  const gateway = startProcess('node', ['node_modules/.bin/tsx', 'src/index.ts'], {
    PORT: String(GATEWAY_PORT),
    UPSTREAM_URL,
  });

  const shutdown = () => {
    upstream.kill('SIGTERM');
    gateway.kill('SIGTERM');
  };
  process.on('exit', shutdown);
  process.on('SIGINT', () => {
    shutdown();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(143);
  });

  try {
    await waitForHealth(`${GATEWAY_URL}/health`, 10_000);
    await runHappyPath();
    await runInvalidJsonPath();
    await runAbortPath();
    console.log('Integration tests passed: happy path + 2 unhappy paths.');
  } finally {
    shutdown();
  }
}

await main();

# learn-mini-gateway

Thin **vertical slice** that combines the patterns from:

| Sibling project | Role here |
|-----------------|-----------|
| `learn-hono-zod` | Typed Variables, auth + limit middleware, Zod IR, body cache |
| `learn-tiktoken` | Prompt estimate, money preConsume, multi-key TPM reserve |
| `learn-sse-websocket` | Native SSE proxy, heartbeat, reverse cancel, `onFinalize` settle |

This is intentionally smaller than `book-llm-gateway`, but the **control flow
matches** chapters 5–7.

## Flow

```
Bearer auth
   → TPM reserve (key / model / global)     // 429 + rollback
   → Zod safeParse                          // 400 + release TPM
   → money preConsume                       // 402 + release TPM
   → proxySSE (ReadableStream, not streamSSE)
        cancel → AbortController → upstream stop
        heartbeat : keepalive
        onFinalize → postConsume + commitTpm
                  or refund + releaseTpm
```

## Quick start

```bash
cd learn-mini-gateway
npm install

# Terminal A
npm run upstream

# Terminal B
npm run start   # or: npm run dev
```

If you see `EADDRINUSE` on `:3104` / `:3198`, something is already bound to those
ports (often a leftover from a previous run). Stop it, or override:

```bash
UPSTREAM_PORT=3298 npm run upstream
PORT=3204 UPSTREAM_URL=http://127.0.0.1:3298/v1/chat/completions npm run start
```

Automated checks:

```bash
npm run typecheck
npm test
```

## Scenario curls

Assume gateway on `http://localhost:3104` and upstream already running.

### 1) Health

```bash
curl -s http://localhost:3104/health
# {"ok":true}
```

### 2) Wallet balance

```bash
curl -s http://localhost:3104/wallet/alice
# {"balance":1000000}
```

### 3) Happy path — SSE chat (stream until `[DONE]`)

```bash
curl -N http://localhost:3104/v1/chat/completions \
  -H 'Authorization: Bearer sk-gw-alice' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"hi"}],
    "echo": "Combined Hono Zod tiktoken SSE",
    "max_tokens": 64
  }'
```

Then confirm balance dropped:

```bash
curl -s http://localhost:3104/wallet/alice
```

### 4) 401 — bad API key

```bash
curl -s http://localhost:3104/v1/chat/completions \
  -H 'Authorization: Bearer sk-bad' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
# {"error":{"message":"unauthorized"}}
```

### 5) 400 — missing messages

```bash
curl -s http://localhost:3104/v1/chat/completions \
  -H 'Authorization: Bearer sk-gw-alice' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini"}'
# {"error":{"message":"model/messages required"}}
```

### 6) 429 — TPM exceeded (`need = prompt + max_tokens` > 5000)

```bash
curl -s http://localhost:3104/v1/chat/completions \
  -H 'Authorization: Bearer sk-gw-alice' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"hi"}],
    "max_tokens": 5000
  }'
# {"error":{"message":"TPM exceeded on key:1"}}
```

### 7) Client abort mid-stream

Start a slow stream, then Ctrl+C; gateway logs should show `[settle]` with `aborted: true`:

```bash
curl -N http://localhost:3104/v1/chat/completions \
  -H 'Authorization: Bearer sk-gw-alice' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"hi"}],
    "echo": "one two three four five six seven eight",
    "delay_ms": 400,
    "max_tokens": 64
  }'
# Ctrl+C after a few chunks
```

### 8) 502 — upstream down

Stop the upstream process, then:

```bash
curl -s http://localhost:3104/v1/chat/completions \
  -H 'Authorization: Bearer sk-gw-alice' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'
# {"error":"upstream unreachable"}  (HTTP 502); wallet refunded
```

## Pattern map → book

| This file | Book |
|-----------|------|
| `src/app.ts` | Ch7 stream branch (app factory) |
| `src/index.ts` | listen / env wiring |
| `src/auth/middleware.ts` | Ch4 auth |
| `src/types/ir.ts` | Ch2/3 IR + passthrough |
| `src/limit/middleware.ts` | Ch6 multi-dimension TPM + rollback |
| `src/billing/tokenizer.ts` | Ch5 `js-tiktoken/lite` |
| `src/billing/wallet.ts` | Ch5 pre/post/refund |
| `src/streaming/sse-proxy.ts` | Ch7 sse-proxy |
| `test/integration.test.ts` | end-to-end HTTP scenarios |

## What was deliberately omitted

- SQLite / Drizzle  
- Anthropic event normalizer (see book Ch3)  
- Channel failover (Ch8)  
- Real provider keys  

Learn those in the book after these four mini projects feel natural.

## Suggested study order

1. `learn-hono-zod`  
2. `learn-tiktoken`  
3. `learn-sse-websocket` (read the SSE vs WebSocket section fully)  
4. `learn-mini-gateway` (this repo)  
5. Return to `book-llm-gateway` examples 03 → 07

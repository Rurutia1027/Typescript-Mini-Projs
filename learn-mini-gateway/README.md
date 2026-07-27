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
cd /Users/emma/LLM/learn-mini-gateway
npm install

# Terminal A
npm run upstream

# Terminal B
npm run dev
```

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

```bash
curl -s http://localhost:3104/wallet/alice | jq
```

Abort mid-stream with Ctrl+C, then check the gateway logs for `[settle]` with
`aborted: true`.

## Pattern map → book

| This file | Book |
|-----------|------|
| `src/auth/middleware.ts` | Ch4 auth |
| `src/types/ir.ts` | Ch2/3 IR + passthrough |
| `src/limit/middleware.ts` | Ch6 multi-dimension TPM + rollback |
| `src/billing/tokenizer.ts` | Ch5 `js-tiktoken/lite` |
| `src/billing/wallet.ts` | Ch5 pre/post/refund |
| `src/streaming/sse-proxy.ts` | Ch7 sse-proxy |
| `src/index.ts` | Ch7 `index.ts` stream branch |

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

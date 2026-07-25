# learn-hono-zod

Small teaching project that mirrors how **Hono** and **Zod** are used in
[`book-llm-gateway`](../book-llm-gateway) (especially chapters 2–4, 6–7, 12).

No database, no real LLM calls — focus on the request spine.

## What this covers (checklist)

### Hono

| Pattern | Where in this repo | Book counterpart |
|--------|--------------------|------------------|
| `new Hono<{ Variables: ... }>()` typed context | `src/index.ts` | `examples/07/.../index.ts` |
| Middleware: early `return c.json(...)`, then `c.set` + `await next()` | `src/auth/middleware.ts` | `auth/middleware.ts` |
| `c.set` / `c.get` (not `c.var`) | auth + limit | same |
| Intersected variable types (`AuthVariables & { limit }`) | `src/limit/middleware.ts` | `LimitVariables` |
| Body read in middleware; handler re-reads via Hono JSON cache | limit → handler | Ch6/Ch7 note on `c.req.json()` |
| `app.route('/admin', subApp)` + `app.use('*', adminAuth)` | `src/admin/routes.ts` | admin router |
| Route chain: `app.post(path, mw1, mw2, handler)` | `src/index.ts` | main chat route |
| Mix `c.json` and `new Response` for passthrough | fail-upstream branch | upstream error / SSE |
| Explicitly avoid `streamSSE` | docs + Response style | Ch7 `sse-proxy.ts` |
| Handler-local errors (no `app.onError`) | handler | Ch6–7 style |
| `serve({ fetch: app.fetch, port })` | `src/index.ts` | `@hono/node-server` |

// todo write an article about: diff of streaming (flink/spark) and websocket and event driven and sse what's the diff and relationshi 
// and does sse has any relationship with the event driven system ? will sse associated with global distributed transaction ? 

### Zod

| Pattern | Where | Book counterpart |
|--------|-------|------------------|
| IR schema + `.passthrough()` | `src/types/ir.ts` | `types/ir.ts` |
| Nested passthrough (`stream_options`) | same | same |
| `z.infer<>` exported types | same | same |
| Boundary `safeParse` + `error.format()` → 400 | chat + admin | main path + admin |
| Per-route inline admin schemas | `src/admin/routes.ts` | admin routes |
| Env `safeParse(process.env)` + exit on fail | `src/config/env.ts` | Ch12 `config/env.ts` |

## Quick start

```bash
cd /Users/emma/LLM/learn-hono-zod
npm install
npm run dev
```


## Quick start

```bash
cd /Users/emma/LLM/learn-hono-zod
npm install
npm run dev
```

### Chat (auth + limit + Zod)

```bash
curl -s http://localhost:3101/v1/chat/completions \
  -H 'Authorization: Bearer sk-gw-alice' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"hi"}],
    "custom_vendor_field": "survives-passthrough"
  }' | jq
```

### Validation error

```bash
curl -s http://localhost:3101/v1/chat/completions \
  -H 'Authorization: Bearer sk-gw-alice' \
  -H 'Content-Type: application/json' \
  -d '{"model":"","messages":[]}' | jq
```

### Admin sub-app

```bash
curl -s http://localhost:3101/admin/keys \
  -H 'X-Admin-Token: dev-admin-token-change-me' \
  -H 'Content-Type: application/json' \
  -d '{"userId":"carol","scopes":["chat"]}' | jq
```

### Native Response passthrough

```bash
curl -si http://localhost:3101/v1/chat/completions \
  -H 'Authorization: Bearer sk-gw-alice' \
  -H 'Content-Type: application/json' \
  -d '{"model":"fail-upstream","messages":[{"role":"user","content":"x"}]}'
```

## Mental model

```
Client
  │  Authorization: Bearer sk-gw-...
  ▼
requireGatewayKey  ──► c.set('auth', ...)
  │
  ▼
rateLimit          ──► c.req.json() once, c.set('limit', ...)
  │
  ▼
handler            ──► c.req.json() again (cache hit)
                   ──► IRChatRequestSchema.safeParse
                   ──► c.json(...)  or  new Response(...)
```

## Why not `streamSSE`?

In the book (Ch7), Hono's `streamSSE` helper can misfire abort on
`@hono/node-server`. Streaming is taught in **learn-sse-websocket** and
**learn-mini-gateway** with native `ReadableStream` + `new Response`.

## Next

1. `../learn-tiktoken` — real token estimates + reserve/commit/release  
2. `../learn-sse-websocket` — SSE wire format, reverse cancel, SSE vs WebSocket  
3. `../learn-mini-gateway` — thin vertical slice combining all three
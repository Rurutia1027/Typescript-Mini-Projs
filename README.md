# LMM gateway learning labs | [![CI](https://github.com/Rurutia1027/Typescript-Mini-Projs/actions/workflows/ci.yml/badge.svg)](https://github.com/Rurutia1027/Typescript-Mini-Projs/actions/workflows/ci.yml)

Four small sibling projects next to [`book-llm-gateway`](https://github.com/diguike/book-llm-gateway). They isolate the libraries and runtime patterns that matter most in that book, with **English docs** and runnable demos. 

| Directory | Focus | Default port |
|-----------|--------|--------------|
| [`learn-hono-zod`](./learn-hono-zod) | Hono middleware Variables, body cache, admin sub-app, Zod IR + env | `3101` |
| [`learn-tiktoken`](./learn-tiktoken) | `js-tiktoken`, money preConsume, TPM reserve/commit/release | `3102` |
| [`learn-sse`](./learn-sse) | SSE proxy, reverse cancel, heartbeats, **SSE vs WebSocket deep dive** | `3103` (+ upstream `3199`) |
| [`learn-mini-gateway`](./learn-mini-gateway) | Vertical slice combining all of the above | `3104` (+ upstream `3198`) |


## Study for 

```
learn-hono-zod  →  learn-tiktoken  →  learn-sse  →  learn-mini-gateway
                                                              ↓
                                                    book-llm-gateway Ch3 / Ch7
```


## Shared stack versions (aligned with the book)

- `hono` ^4.6 
- `@hono/node-server` ^1.13
- `zod` ^3.24
- Node >= 20


## Not covered here (stay in the book)

Anthropic protocol translation, Drizzle/SQLite, channel failover, Stripe/wallet
concurrency, production observability dashboard.

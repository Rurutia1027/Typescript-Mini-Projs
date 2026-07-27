# learn-sse-websocket

Hands-on SSE proxy matching `book-llm-gateway` Ch7, plus a **detailed SSE vs
WebSocket** guide and a tiny WS echo for contrast.

## Quick start

```bash
cd /Users/emma/LLM/learn-sse-websocket
npm install

# Terminal A — fake OpenAI-style SSE upstream
npm run upstream

# Terminal B — gateway proxy
npm run dev
```

### Stream through the proxy

```bash
curl -N http://localhost:3103/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"echo":"Streaming one word at a time","delay_ms":120}'
```

You should see:

- `data: {...delta...}` frames  
- occasional `: keepalive` comment lines (heartbeat; default every 3s in this demo)  
- final `data: [DONE]`

### Inspect finalize callbacks (billing hook)

```bash
curl -s http://localhost:3103/finalizes | jq
```

### Abort mid-stream (reverse cancel)

```bash
# Start a slow stream, then Ctrl+C after ~1s
curl -N http://localhost:3103/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"echo":"one two three four five six seven eight nine ten","delay_ms":400}'
```

Then check `/finalizes` — `abortedByClient` should be `true`. The proxy's
`ReadableStream.cancel` aborted the upstream `fetch` via `AbortController`.

### WebSocket echo (contrast)

```bash
npx wscat -c ws://localhost:3103/ws-echo
# type any text; server echoes JSON
```

---

# Server-Sent Events vs WebSocket (deep dive)

## 1. What problem do they solve?

Both move **live data** without polling (`setInterval` + `GET /status`).

| Need | Typical fit |
|------|-------------|
| Server pushes updates; client rarely talks back | **SSE** |
| Both sides send continuously (chat, games, collab cursors) | **WebSocket** |
| LLM token streaming (one POST, then a stream of tokens) | **SSE** (industry default) |

LLM gateways almost always use SSE because the traffic shape is:

```
Client ──POST /v1/chat/completions──► Gateway ──POST stream:true──► Provider
Client ◄──── text/event-stream ────── Gateway ◄──── text/event-stream ── Provider
```

The client does **not** need a bidirectional socket to send more messages on the
same connection while tokens flow. A normal HTTP request body + SSE response is
enough. Auth, rate limits, and billing stay ordinary HTTP middleware.

## 2. What is SSE?

**Server-Sent Events** are part of the [HTML Living Standard](https://html.spec.whatwg.org/multipage/server-sent-events.html).

- Transport: **plain HTTP** response that stays open  
- MIME type: `text/event-stream`  
- Direction: **server → client only**  
- Encoding: UTF-8 text frames  

### Wire format (the part you must memorize)

Events are separated by a **blank line** (`\n\n`):

```text
: keepalive

data: {"choices":[{"delta":{"content":"Hello"}}]}

event: error
data: {"message":"boom"}
id: 42
data: next

data: [DONE]

```

Field meanings:

| Line | Meaning |
|------|---------|
| `data: ...` | Payload (multiple `data:` lines join with `\n`) |
| `event: name` | Named event (browser `EventSource` dispatches that name) |
| `id: ...` | Last-Event-ID for resume after reconnect |
| `retry: ms` | Reconnect delay hint |
| `: comment` | Ignored by clients; used as **heartbeat** |

OpenAI-compatible APIs usually send unnamed events with JSON in `data:`, and
end with `data: [DONE]`.

### Browser API vs gateway reality

Browsers ship `EventSource`:

```js
const es = new EventSource('/events');
es.onmessage = (e) => console.log(e.data);
```

Limits that matter for LLM apps:

- **GET only** (no JSON POST body)  
- Hard to set `Authorization: Bearer ...`  
- Auto-reconnect (often unwanted for a single chat completion)

So gateways and serious clients use **`fetch` + `ReadableStream`** and parse
`data:` lines themselves — same wire format, different client API.

This repo (and the book) do exactly that.

## 3. What is WebSocket?

**WebSocket** (RFC 6455) upgrades HTTP to a **persistent bidirectional**
channel.

```
Client ── GET Upgrade: websocket ──► Server
Client ◄──── 101 Switching Protocols ────
Client ◄────────── frames both ways ──────────► Server
```

- Binary + text frames  
- Either side can send anytime  
- No built-in auto-reconnect (you implement it)  
- Different load-balancer / proxy story than HTTP streaming  

Great for chat rooms, multiplayer, collaborative editing. Overkill for “stream
tokens from one completion request.”

## 4. Side-by-side comparison

| | **SSE** | **WebSocket** |
|--|---------|----------------|
| Direction | Server → client | Full duplex |
| Protocol | HTTP response body | Upgraded WS protocol |
| Framing | `data:` text lines | WS frames (text/binary) |
| Browser helper | `EventSource` | `WebSocket` |
| Reconnect | Built into EventSource | DIY |
| Auth / middleware | Normal HTTP (cookies, Bearer, Hono mw) | Must design on connect / first message |
| Proxies / CDNs | Usually friendly (`X-Accel-Buffering: no`) | Need WS support |
| Binary | No (base64 if needed) | Yes |
| HTTP/2 multiplexing | Multiple streams on one conn | One WS = one TCP (classic) |
| LLM streaming | **Default** (OpenAI, Anthropic, …) | Rare |
| Typical failure mode | Idle timeout / buffering | Sticky sessions, LB config |

## 5. Why LLM providers picked SSE

1. **One-way data after the request** — tokens only flow down.  
2. **Works with existing HTTP tooling** — curl `-N`, middleware, API gateways.  
3. **Cancel maps cleanly** — abort the HTTP request / stream cancel.  
4. **CDN / edge friendly** — many platforms treat streaming HTTP as first-class.  
5. **Simple mental model** — same route as non-stream JSON, plus `stream: true`.

Anthropic is **not** “SSE-only proprietary.” Anthropic uses the **same SSE
transport** with a **richer event schema** (`message_start`,
`content_block_delta`, …). The hard part in the book is the **event state
machine**, not inventing SSE.

## 6. Patterns implemented here (book Ch7 mapping)

| Pattern | File | Notes |
|--------|------|-------|
| Native `ReadableStream` + `new Response` | `src/streaming/sse-proxy.ts` | Avoid Hono `streamSSE` on Node |
| `AbortController` on upstream `fetch` | same | Reverse cancel |
| `cancel()` → `upstreamCtrl.abort()` | same | Client Ctrl+C stops provider burn |
| Heartbeat `: keepalive\n\n` | `SSE_HEARTBEAT` | Keeps Nginx/LB from idle-cutting |
| Split on `\n\n`, skip `:`, parse `data:` | `sse-format.ts` | Wire parser |
| Re-encode OpenAI chunks + `[DONE]` | proxy loop | Downstream contract |
| `onFinalize` for settle/refund | proxy options | Billing stays outside proxy |
| Headers: `text/event-stream`, `X-Accel-Buffering: no` | Response | Production proxy hint |

### Reverse cancel (critical for money)

```
Client closes curl
   → Node cancels downstream ReadableStream
   → cancel() runs
   → AbortController.abort()
   → upstream fetch aborts
   → provider stops generating
   → onFinalize({ abortedByClient: true })
   → caller refunds / partial-settles (see learn-tiktoken + learn-mini-gateway)
```

Without reverse cancel, users can disconnect while the gateway keeps paying for
tokens.

### Heartbeats

Reasoning models can stay silent for 30s+. Proxies with `proxy_read_timeout=60s`
will kill idle connections. Comment lines are traffic without affecting parsers.

## 7. When to choose which

**Choose SSE when:**

- Notifications, dashboards, progress, logs, **LLM tokens**  
- You want HTTP middleware / auth / billing unchanged  
- Client → server traffic is occasional (separate POSTs are fine)

**Choose WebSocket when:**

- Chat with typing indicators both ways on one socket  
- Games / collaborative cursors / CRDT sync  
- You need binary frames or very high bidirectional frequency  

**Hybrid (common):** SSE or HTTP for LLM stream; WebSocket for product
realtime (presence, inbox). Do not force one protocol for every feature.

## 8. Official / excellent references

### Specs & MDN

- [MDN — Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)  
- [MDN — EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)  
- [WHATWG HTML — Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)  
- [MDN — WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)  
- [RFC 6455 — The WebSocket Protocol](https://datatracker.ietf.org/doc/html/rfc6455)

### Practical articles

- [web.dev — Stream updates with SSE](https://web.dev/articles/eventsource-basics)  
- [Vercel — WebSocket vs SSE](https://vercel.com/i/websocket-vs-server-sent-events)  
- [freeCodeCamp — SSE vs WebSockets](https://www.freecodecamp.org/news/server-sent-events-vs-websockets/)  
- [OpenAI — Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)

### Video

- [OpenAI Streaming with SSE (Node + React)](https://www.youtube.com/watch?v=C2Bu7XSNR-Q) — closest to gateway shape  

### In this monorepo family

- Book chapter: `book-llm-gateway/book/07-stream-is-broken/README.md`  
- Code: `book-llm-gateway/examples/07-stream-is-broken/src/streaming/sse-proxy.ts`

## 9. Next

Wire SSE finalize into real token settle: **`../learn-mini-gateway`**.

# From Browser Push to Flink: SSE, WebSocket, Events, and Real-Time Streams

*How live data moves from a server to a screen — and how that same idea scales into event-driven systems and Apache Flink.*

---

## Why “real-time” keeps showing up

Modern products rarely wait for a full page refresh. Chat tokens appear word by word. Dashboards update as metrics change. Fraud scores recompute as payments land. Under the hood, these experiences share one idea: **don’t poll — push or react when something happens.**

That idea shows up at three layers:

| Layer | Typical tech | Job |
|-------|--------------|-----|
| **Browser / API edge** | SSE, WebSocket | Deliver live updates to clients |
| **Application architecture** | Event-driven design | Decouple producers from consumers |
| **Data platform** | Kafka + Flink (etc.) | Process unbounded streams at scale |

This article walks those layers from the simplest (SSE) to the heaviest (Flink), and clarifies when each belongs.

---

## What is SSE?

**Server-Sent Events (SSE)** are a standard way for a server to push a continuous stream of text events over a normal HTTP response.

- **MIME type:** `text/event-stream`
- **Direction:** server → client only
- **Encoding:** UTF-8 text frames separated by blank lines (`\n\n`)
- **Browser helper:** `EventSource` (GET only; auto-reconnect)

A minimal wire sample:

```text
: keepalive

data: {"choices":[{"delta":{"content":"Hello"}}]}

data: [DONE]

```

Useful fields:

| Field | Role |
|-------|------|
| `data:` | Payload (multiple `data:` lines join with `\n`) |
| `event:` | Named event type |
| `id:` | Last-Event-ID for resume after reconnect |
| `retry:` | Hint for reconnect delay |
| `: comment` | Ignored by clients; often used as a **heartbeat** |

### Why LLM APIs love SSE

Token streaming is almost always **one request, then a long one-way response**:

```text
Client ──POST /v1/chat/completions──► Gateway ──stream:true──► Provider
Client ◄──── text/event-stream ────── Gateway ◄── text/event-stream ──
```

You don’t need a bidirectional socket while tokens flow. Auth, rate limits, and billing stay ordinary HTTP middleware. Cancel maps cleanly: abort the HTTP request and stop burning upstream tokens.

> **Note:** Browsers’ `EventSource` is GET-only and awkward with `Authorization` headers. Production LLM clients usually use `fetch` + `ReadableStream` and parse `data:` lines themselves — same wire format, better control.

---

## SSE vs WebSocket

**WebSocket** upgrades HTTP into a persistent **full-duplex** channel (RFC 6455). After `101 Switching Protocols`, either side can send text or binary frames anytime.

| | **SSE** | **WebSocket** |
|--|---------|----------------|
| Direction | Server → client | Full duplex |
| Protocol | Long-lived HTTP response | Upgraded WS protocol |
| Framing | `data:` text lines | WS frames (text/binary) |
| Browser API | `EventSource` | `WebSocket` |
| Reconnect | Built into EventSource | You implement it |
| Auth / middleware | Normal HTTP | Design on connect / first message |
| Proxies / CDNs | Usually friendly | Need explicit WS support |
| Binary | No (base64 if needed) | Yes |
| LLM token streaming | Industry default | Rare |
| Typical fit | Feeds, progress, logs, LLM streams | Chat rooms, games, collab cursors |

**Rule of thumb**

- Choose **SSE** when the client mostly *listens* (notifications, dashboards, LLM tokens).
- Choose **WebSocket** when both sides *talk continuously* on one connection.
- **Hybrid is normal:** SSE/HTTP for LLM streams; WebSocket for presence, inbox, or collaborative editing.

SSE is not “WebSocket lite.” It’s a different contract: reuse HTTP end-to-end when one-way push is enough.

---

## Event-driven architecture: the same idea, one level up

SSE and WebSocket move events to a **UI**. Event-driven architecture (EDA) moves events between **services**.

### Core idea

Instead of Service A calling Service B synchronously and waiting:

```text
OrderService ──RPC──► Inventory ──RPC──► Billing ──RPC──► Email
```

Producers emit **facts** (“what happened”), and consumers react independently:

```text
OrderPlaced ──► Kafka / Event Bus ──► Inventory updater
                                 ──► Billing
                                 ──► Email
                                 ──► Analytics
```

### Why teams adopt it

1. **Loose coupling** — producers don’t know every consumer.
2. **Scale independently** — add a new consumer without redeploying the producer.
3. **Temporal decoupling** — consumers can lag and catch up.
4. **Auditability** — the event log becomes a history of business facts.

### Mental bridge from SSE

| At the edge | In the backend |
|-------------|----------------|
| `data: {...}` frames | Domain events (`OrderPlaced`, `TokenGenerated`) |
| Heartbeat comments | Keepalive / lag monitoring |
| Client reconnect + `Last-Event-ID` | Consumer offsets / checkpoints |
| One stream per browser tab | Many partitions / consumer groups |

An SSE feed is often just the **last mile** of an event-driven system: Flink (or another processor) derives a signal, an API service turns it into `text/event-stream`, and the browser paints it.

---

## Apache Flink: real-time stream processing

If Kafka (or similar) is the **nervous system** that carries events, **Apache Flink** is a common **brain** that continuously computes over them.

### What Flink is for

Flink processes **unbounded streams** — data with no planned end — with:

- **Event-time** semantics (when the event actually happened, not when it arrived)
- **Watermarks** to reason about late data
- **Windows** (tumbling, sliding, session) for aggregations
- **Stateful operators** with checkpoints for fault tolerance
- Exactly-once (or at-least-once) delivery into sinks, depending on configuration

Typical jobs:

- Sliding window counts (“orders per SKU in the last 5 minutes”)
- Fraud / anomaly scoring as payments arrive
- Join clickstream with user profiles in near real time
- Maintain materialized views that power live dashboards

### A tiny Flink-shaped sketch

```text
Source (Kafka: payments)
   → map / filter
   → keyBy(userId)
   → window(TumblingEventTimeWindows.of(5 min))
   → aggregate(sum, count, riskScore)
   → sink (Kafka / DB / alert topic)
```

Downstream, an API can subscribe to the alert topic and **SSE-push** high-risk users to an ops console — same “something happened → push update” story, now at data-platform scale.

### Flink vs “just push SSE from the app”

| Concern | App-level SSE/WS | Flink (+ event bus) |
|---------|------------------|---------------------|
| Volume | Per connection / request | Millions of events/sec class |
| State | In-process / Redis ad hoc | Managed keyed state + checkpoints |
| Time | Wall-clock timeouts | Event time + watermarks |
| Fan-out | One client or a few services | Many jobs, many sinks |
| Replay | Rarely | First-class (reprocess from offsets) |

Use Flink when the **business logic over the stream** is the product (aggregations, CEP, joins, late data). Use SSE/WS when you need to **deliver results to humans or browsers**.

---

## Putting the stack together

A concrete end-to-end picture:

```text
Devices / APIs
    │  produce events
    ▼
Kafka (or Pulsar, Kinesis, …)
    │
    ▼
Flink job  ──► enriched / aggregated topics
    │
    ▼
Realtime API service
    │  SSE  → ops dashboard, LLM token UI
    │  WS   → multiplayer / chat room
    ▼
Browsers & mobile clients
```

**Design checklist**

1. **Is traffic one-way after a request?** Prefer SSE (or streaming HTTP).
2. **Do both sides chatter on one connection?** Prefer WebSocket.
3. **Do many services need the same fact?** Emit domain events; don’t hard-wire RPCs forever.
4. **Do you need windowed, stateful, replayable compute?** Put Flink (or equivalent) on the bus — don’t reinvent it inside a Node process that also serves SSE.

---

## Takeaways

- **SSE** is HTTP-native, one-way push — perfect for LLM tokens, progress, and live feeds.
- **WebSocket** is bidirectional and protocol-upgraded — perfect when both sides talk continuously.
- **Event-driven architecture** applies the same “react to facts” idea between services.
- **Flink** turns those facts into continuous, stateful, event-time computations at scale.
- The best systems pick the right tool **per layer**, not one protocol for everything.

---

## Further reading

- [MDN — Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [WHATWG — Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [RFC 6455 — The WebSocket Protocol](https://datatracker.ietf.org/doc/html/rfc6455)
- [Apache Flink documentation](https://flink.apache.org/what-is-flink/flink-architecture/)
- [OpenAI — Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)

*Hands-on SSE proxy and WebSocket echo for this topic live in this repo — see the project README.*

# From Browser Push to Flink: SSE, WebSocket, Events, and Real-Time Streams 


**How live data moves from a server to a screen - and how that same idea scales into event-driven systems and Apache Flink.**


---

## Why "real-time" keeps showing up

Modern products rarely wait for a full page refresh. Chat tokens appear word by word. Dashboards update as metrics change. Fraud scores recompute as payments land. Under the hood, these experiences share one idea: **don't poll - push or react when something happes.** 


That idea shows up at three layers: 

| Layer | Typical tech | Job |
|-------|--------------|-----|
| **Browser / API edge** | SSE, WebSocket | Deliver live updates to clients |
| **Application architecture** | Event-driven design | Decouple producers from consumers |
| **Data platform** | Kafka + Flink (etc.) | Process unbounded streams at scale |


This article walks those layers from the simplest (SSE) to the heaviest (Flink), and clarifies when each belongs. 

---

## What is SSE ?

**Server-Sent Events (SSE)** are a standard way for a server to push a continuous stream of text events over a normal HTTP response. 

- **MIME type:** `text/event-stream` 
- **Direction:** server --> client only 
- **Encoding:** UTF-8 text frames separated by blank lines (`\n\n`)
- **Browser helper:** `EventSource` (GET only; auto-reconnect). 


A minimal wire sample: 

```text
: keepalive 

data: {"choices": [{"delta": {"content": "Hello"}}]}

data: [DONE]
```

Useful fields: 

| Field | Role |
|-------|------|
| `data:` | Payload (multiple `data:` lines join with `\n`) |
| `event:` | Named event type |
| `id:` | Last-Event-ID for resume after reconnect |
| `retry:` | Hint for reconnect delay |
| `: comment` | Ignored by clients; often used a **heartbeat** |


### Why LLM APIs love SSE 

Token streaming is almost always **one request, then a long one-way respoinse**:

```text 
Client -- POST /v1/chat/completions --> 
Gateway -- stream:true --> Provider 

Client <-- text/event-stream -- Gateway <-- text/event-stream --
```


You don't need a bidirectional socket while tokens flow. Auth, rate limits, and billing stay ordinary HTTP middleware. 
Cancel maps cleanly: abort the HTTP request and stop burning upstream tokens. 


> **Note:** Browsers' `EventSource` is GET-only and awkward with `Authorization` headers. Production LLM clients usually use `fetch` + `ReadableStream` and parse `data:` lines themselves - same wire format, better control. 


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


SSE is not **WebSocket lite." It's a different contract: reuse HTTP end-to-end when one-way push is enough. 


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


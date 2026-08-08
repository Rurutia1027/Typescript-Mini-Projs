# Mini LLM Gateway — System Design Interview Doc

> Scope: this repo only (`learn-mini-gateway`). A thin vertical slice: Bearer auth → multi-key TPM → money pre-consume → SSE proxy → settle. No failover, no durable DB, no multi-provider routing.

---

## 1. Problem Statement

Design a small **LLM API gateway** that sits between clients and an upstream chat-completions provider. Clients call an OpenAI-style endpoint; the gateway authenticates, rate-limits by tokens, reserves wallet balance, streams SSE from upstream, then settles billing and TPM on stream end (including client abort).

---

## 2. Functional Requirements

| # | Requirement | In this project |
|---|-------------|-----------------|
| F1 | Authenticate API keys (`Authorization: Bearer …`) | Hardcoded key map → `{ keyId, userId }` |
| F2 | Accept OpenAI-compatible chat request (`model`, `messages`, optional `max_tokens`) | Zod IR schema + passthrough |
| F3 | Enforce **TPM** (tokens per minute) on key / model / global | In-memory fixed-window buckets, reserve-then-adjust |
| F4 | Pre-charge wallet by estimated cost; settle or refund after stream | `preConsume` / `postConsume` / `refund` |
| F5 | Proxy **SSE** stream to client; force `stream: true` + `include_usage` | `proxySSE` ReadableStream |
| F6 | On client disconnect, abort upstream and still settle | `cancel` → `AbortController` → `onFinalize` |
| F7 | Health check + wallet balance read | `GET /health`, `GET /wallet/:userId` |

**Out of scope (deliberately omitted):** SQLite, Anthropic normalizer, channel failover, real provider keys, non-stream JSON responses.

---

## 3. Non-Functional Requirements

| Category | Target (interview framing, matched to this toy) |
|----------|--------------------------------------------------|
| Latency | Auth + TPM + preConsume are O(1) in-memory; streaming latency dominated by upstream |
| Correctness | No double-charge: reservation status machine `reserved → finalized \| refunded` |
| Fairness / isolation | TPM checked on three dimensions so one key/model cannot starve the whole node (within single-process limits) |
| Availability | Single process; no HA. Upstream failure → 502 + refund + TPM release |
| Consistency | Strong within one Node process; **not** multi-instance safe (Maps) |
| Observability | Console `[settle]` log with usage + balance |

---

## 4. Traffic Estimation & Data Storage

Interview-style back-of-envelope, scaled to what this gateway *models*:

### 4.1 Traffic

Assumptions (illustrative):

- 100 active keys, average 1 req / key / min peak → **~100 QPS peak** for chat (streaming, long-lived)
- Avg prompt ~1K tokens, avg completion ~500 tokens → **~150K tokens / min** through the process
- Project TPM cap: **5 000 tokens / min** per bucket key (`key:` / `model:` / `global`) — intentionally tiny for demos

At interview scale you would say: gateway QPS is low compared to token throughput; bottleneck is **upstream LLM + open SSE connections**, not JSON parse.

Connection memory (rough):

- One streaming request ≈ one upstream fetch + one client ReadableStream
- ~1–2 MB stack/buffers per concurrent stream (order-of-magnitude) → 1 000 concurrent streams ≈ few GB RAM → plan connection limits before CPU

### 4.2 Storage

This project stores everything **in memory**:

| Store | Shape | Size estimate |
|-------|--------|---------------|
| API keys | `Record<key, {keyId,userId}>` | ~100 B / key → negligible |
| Wallet balances | `Map<userId, number>` | ~50 B / user |
| Reservations | `Map<id, Reservation>` | ~100–200 B / in-flight (+ uncleared finalized if not GC’d) |
| TPM buckets | `Map<key, {used, exp}>` | ~3 keys / request × ~80 B → tiny; expire every 60s |

**If we persisted** (not in repo, for interview completeness):

- Balance row: ~64 B × 1M users ≈ **64 MB**
- Reservation / ledger row: ~128 B × 10M requests / day ≈ **1.3 GB / day** (append-only ledger; TTL or archive)

For this mini project: **0 durable storage**; restart loses balances and TPM state.

---

## 5. API Design

### 5.1 `GET /health`

```json
{ "ok": true }
```

### 5.2 `GET /wallet/:userId`

```json
{ "balance": 1000000 }
```

Demo only — no auth on this path.

### 5.3 `POST /v1/chat/completions`

**Headers**

- `Authorization: Bearer <gateway_key>` (required)
- `Content-Type: application/json`

**Request body (IR subset)**

```json
{
  "model": "gpt-4o-mini",
  "messages": [{ "role": "user", "content": "hi" }],
  "max_tokens": 64,
  "echo": "optional passthrough for mock upstream"
}
```

Gateway **forces** `stream: true` and `stream_options.include_usage: true` before proxying.

**Success:** `200` `text/event-stream` — OpenAI-style chunks, heartbeat `: keepalive`, terminal `data: [DONE]`.

**Errors**

| Status | When |
|--------|------|
| 401 | Missing / unknown Bearer key |
| 400 | Invalid `model`/`messages` (limit middleware) or Zod fail |
| 429 | TPM exceeded on `key:` / `model:` / `global` |
| 402 | Insufficient wallet for estimated cost |
| 502 | Upstream unreachable |

---

## 6. Database Design

**Actual implementation:** no database — three in-memory structures that map cleanly to tables in an interview.

### 6.1 Logical schema (what the Maps represent)

```text
api_keys
  key_hash PK | key_id | user_id

wallets
  user_id PK | balance

reservations
  id PK | user_id | reserved_amount | status (reserved|finalized|refunded) | created_at

tpm_buckets          -- optional Redis in prod
  bucket_key PK | used | window_expires_at
```

### 6.2 Reservation lifecycle

```text
preConsume  → status=reserved, balance -= estimated
postConsume → status=finalized, balance += (reserved - actual)
refund      → status=refunded,  balance += reserved
```

Idempotent guards: only act when `status === 'reserved'`.

### 6.3 Pricing model (demo)

```text
cost = prompt_tokens * 10 + completion_tokens * 30
```

(Units are toy “money”; rates are static.)

---

## 7. High-Level Architecture

```text
┌────────┐   Bearer    ┌──────────────────────────────────────────────┐
│ Client │ ──────────► │              Mini Gateway (Hono)             │
└────────┘             │  auth → TPM reserve → Zod → wallet preConsume │
                       │              │                               │
                       │              ▼                               │
                       │         proxySSE (ReadableStream)            │
                       │    heartbeat + parse usage + reverse cancel  │
                       │              │                               │
                       │              ▼ onFinalize                    │
                       │    postConsume/commitTpm  or  refund/release │
                       └──────────────────┬───────────────────────────┘
                                          │ HTTP POST stream
                                          ▼
                               ┌────────────────────┐
                               │ Mock Upstream :3198 │
                               │ word-by-word SSE    │
                               └────────────────────┘
```

**Process layout (local):**

1. `npm run upstream` — mock provider on `:3198`
2. `npm run dev` — gateway on `:3104`

---

## 8. Detailed Component Design

### 8.1 Auth (`src/auth/middleware.ts`)

- Parse `Bearer` token; lookup static `KEYS`.
- On success set Hono `Variables.auth = { keyId, userId }`.
- Fail closed → **401**.

### 8.2 Rate limit / TPM (`src/limit/middleware.ts`)

- Estimate prompt tokens (tiktoken) + `max_tokens` (default 128) = **reservation size**.
- Three buckets: `key:{keyId}`, `model:{model}`, `global`; each limit **5000 / 60s** fixed window.
- **Reserve** on all three; if any fails → release already reserved → **429**.
- After stream: `commitTpm(handles, actual)` adjusts `used` by `(actual - reserved)`; failure path uses `releaseTpm`.

### 8.3 IR validation (`src/types/ir.ts` + handler)

- Zod schemas with `.passthrough()` so unknown fields (e.g. `echo`) reach upstream.
- Limit middleware does a first cheap check; handler `safeParse`s again (Hono body cache).
- Zod fail → `releaseTpm` → **400**.

### 8.4 Billing (`src/billing/wallet.ts` + `tokenizer.ts`)

- `estimatePromptTokens`: js-tiktoken lite, model → encoding (`cl100k_base` / `o200k_base`).
- `preConsume`: estimate cost with `max_tokens` as completion ceiling; deduct; create reservation.
- Insufficient → `releaseTpm` → **402**.
- `postConsume` / `refund` settle on finalize.

### 8.5 SSE proxy (`src/streaming/sse-proxy.ts`)

- `fetch` upstream with shared `AbortController`.
- Pipe SSE to client; parse `delta.content` for fallback token estimate; prefer upstream `usage` when present.
- Heartbeat every ~4s (`: keepalive`).
- Client `cancel` → abort upstream + cancel reader → `onFinalize` with `abortedByClient`.
- Upstream dead / non-OK → finalize as failed → gateway refunds + releases TPM.

### 8.6 Request settle policy (`src/index.ts`)

| Outcome | Money | TPM |
|---------|-------|-----|
| Upstream failed & 0 completion tokens | `refund` | `releaseTpm` |
| Success or client abort (partial OK) | `postConsume` with observed usage | `commitTpm` with actual tokens |

---

## 9. Trade-off Discussion

| Decision | Why | Trade-off |
|----------|-----|-----------|
| **In-memory Maps** | Fast to learn control flow | Lost on restart; not multi-instance |
| **Reserve TPM before money** | Fail cheap on rate limit before wallet work | Invalid body after TPM reserve needs explicit `releaseTpm` |
| **Pre-consume max_tokens cost** | Prevents overspend under concurrency | Over-reserves; user sees temporary balance dip until settle |
| **Force stream + include_usage** | One code path; accurate settle | No non-stream JSON API in this slice |
| **Native ReadableStream proxy** (not framework `streamSSE` helper) | Full control of cancel / heartbeat / finalize | More code to maintain |
| **Fixed-window TPM** | Simple demo | Burst at window edge; Redis token-bucket would be fairer in prod |
| **Three-dimension TPM** | Isolates noisy keys/models | All share one process memory; global bucket is a single choke point |
| **Mock upstream** | Deterministic SSE for learning | Not production provider semantics |

---

## 10. Failure Scenario Discussion

| Scenario | Behavior in this project |
|----------|---------------------------|
| Bad / missing API key | **401**, no TPM/money touched |
| TPM exceeded | **429**, rollback partial TPM reserves |
| Invalid JSON / Zod fail | **400**, `releaseTpm` |
| Wallet too low | **402**, `releaseTpm` |
| Upstream unreachable | **502**, `refund` + `releaseTpm` |
| Upstream HTTP error body | Pass status/body through; treat as failed settle → refund path when completion=0 |
| Client Ctrl+C mid-stream | Abort upstream; `postConsume` on tokens seen so far; `commitTpm`; log `aborted: true` |
| Upstream sends no `usage` | Fallback: estimate completion from accumulated text length |
| Process crash mid-stream | In-memory reservation stuck; balance already deducted — **demo limitation** (prod: TTL reclaim / ledger reconcile) |
| Second gateway instance | Separate Maps → **double TPM / double spend possible** — needs Redis + DB for horizontal scale |

---

## 11. End-to-End Happy Path (interview narrative)

1. Client `POST /v1/chat/completions` with `Bearer sk-gw-alice`.
2. Auth binds `userId=alice`.
3. TPM reserves `estPrompt + max_tokens` on key/model/global.
4. Zod validates IR; wallet pre-consumes estimated cost.
5. Gateway opens SSE to mock upstream; relays chunks + heartbeats.
6. Stream ends with usage (or fallback estimate).
7. `onFinalize` → `postConsume` + `commitTpm`; balance reflects actual tokens.

Abort path: step 5 cancel → step 7 still runs with partial usage.

---

## 12. Mapping to Source

| Component | File |
|-----------|------|
| Entry + settle policy | `src/index.ts` |
| Auth | `src/auth/middleware.ts` |
| TPM | `src/limit/middleware.ts` |
| Wallet | `src/billing/wallet.ts` |
| Tokenizer | `src/billing/tokenizer.ts` |
| IR | `src/types/ir.ts` |
| SSE proxy | `src/streaming/sse-proxy.ts` |
| Mock provider | `src/mock-upstream.ts` |

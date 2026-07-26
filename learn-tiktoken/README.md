# learn-tiktoken

Teaching project for **js-tiktoken** and the **two-phase reserve** patterns used
in `book-llm-gateway` (Ch5 billing + Ch6 TPM).

**Concepts:** [What is tiktoken, how it works, TPM & glossary](docs/tiktoken-basics.md)

## Why local tokenization?

Before calling the upstream LLM you do not have `usage` yet. The gateway must:

1. **Estimate** prompt tokens (and use `max_tokens` as a completion ceiling)
2. **Reserve** money (402 if short) and/or TPM (429 if short)
3. Call upstream
4. **Settle** with real usage (`commit`) or **refund/release** on failure

Local estimate vs upstream usage often differs by ~1–3%. Settlement fixes that.

## Patterns covered

| Pattern | File | Book |
|--------|------|------|
| `js-tiktoken/lite` + `ranks/cl100k_base` + `o200k_base` | `src/billing/tokenizer.ts` | `billing/tokenizer.ts` |
| Encoder `Map` cache | same | same |
| `getEncodingNameForModel` + regex fallback | `pickEncoding` | same |
| `estimatePromptTokens` (+4/msg, multimodal stub) | same | same |
| `estimateCompletionTokens` | same | streaming counter feed |
| Money `preConsume` / `postConsume` / `refund` | `src/billing/calculator.ts` | Ch5 calculator |
| TPM `reserve` / `commit` / `release` (60s bucket) | `src/limit/tpm.ts` | Ch6 `tpm-reservation` |
| Orthogonal axes: 402 money vs 429 TPM | `src/index.ts` | Ch6 README |
| Rollback TPM if money reserve fails | `src/index.ts` | limit middleware |

## Quick start

```bash
cd /Users/emma/LLM/learn-tiktoken
npm install
npm run demo          # no HTTP
npm run dev           # HTTP on :3102
```

### Estimate only

```bash
curl -s http://localhost:3102/v1/estimate \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello world"}]}' | jq
```

### Full reserve → settle

```bash
curl -s http://localhost:3102/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "userId":"alice",
    "messages":[{"role":"user","content":"hi"}],
    "max_tokens":32,
    "assistant_text":"Hi there!"
  }' | jq
```

### Failure path (refund + release)

```bash
curl -s http://localhost:3102/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"x"}],"fail":true}' | jq
```

### Wallet / TPM peek

```bash
curl -s http://localhost:3102/wallet/alice | jq
```

## Two axes (do not merge them)

```
                 estimated_prompt + max_tokens
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
        reserve TPM                  preConsume $
         (429)                        (402)
              │                           │
              └─────────────┬─────────────┘
                            ▼
                     call upstream
                            │
              ┌─────────────┴─────────────┐
         success                      failure
              │                           │
        commit TPM                   release TPM
        postConsume $                refund $
```

In the full book these share middleware/handler wiring with auth and SSE
finalize (`onFinalize`). See **learn-mini-gateway**.

## Encoding notes

| Models | Encoding |
|--------|----------|
| gpt-4o / o1 / o3 family | `o200k_base` |
| gpt-4 / gpt-3.5 / Claude fallback | `cl100k_base` |

Claude has no public tokenizer; the book estimates with cl100k and corrects via
upstream `usage` in `postConsume`. 
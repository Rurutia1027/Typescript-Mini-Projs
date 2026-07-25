# Understanding tiktoken 

A short guide to what tiktoken is, how it works, and the terms you will see in this project (and in LLM gateways generally).

---

## What is a token?

LLMs do not read text as characters or words. They read **tokens** -- small pieces of text that the model was trained on. 

Examples (approximate with `cl100k_base`): 

| Text | Rough token count |
|------|-------------------|
| `hello` | 1 |
| `tokenization` | 2–3 |
| `你好` | often 1–2 per character |
| A short English sentence | ~1 token per ~4 characters |


Tokens are the unit of:

- **Context length** - how much the model can see (e.g., 128k tokens) 
- **Billing** - you pay per input/output token
- **Rate limits** - providers cap how many tokens you may use per minute


---

## What is tiktoken?

**tiktoken** is OpenAI's fast BPE (Byte Pair Encoding) tokenizer library. It turns a string into a list of token IDs (and back), 
using the same encoding the OpenAI models use. 

In this repo we use **js-tiktoken** (the JavaScript port), specifically `js-tiktoken/lite` plus rank files - so it runs in Node/Workers without native bindings. 


```ts 
enc.encode("Hello world") // -> [9906, 1917] (example IDs)
enc.decode([9906, 1917]) // -> "Hello world
```

Why gateways care: **before** the upstream API returns `usage`, you still need a token count to reserve money and TPM. 
Local tiktoken is that estimate. 


---

## How tokenization works (BPE, short version)

1. Text is converted to bytes (UTF-8)
2. An **encoding** (vocabulary + merge rules) repeatedly merges common byte pairs into larger tokens. 
3. The result is a sequence of interger **token IDs**. 

Different model families use different encodings: 

| Encoding | Typical models |
|----------|----------------|
| `cl100k_base` | gpt-4, gpt-3.5, many Claude fallbacks |
| `o200k_base` | gpt-4o, o1, o3 family |


Picking the wrong encoding still "works," but your **estimate** drifts further from upstream `usage`. 
Settlement (see below) corrects the money/TPM after the fact. 

See `src/billing/tokenizer.ts` - `pickEncoding`, `estimatePromptTokens`. 

---

## Prompt estimate vs raw encode 

Chat APIs do not only tokenize message text. There is also **chat formatting overhead** (role markers, message wrappers). 
This project follows the OpenAI cookbook-styel estimate: 

- `+4` tokens per message 
- encode `role` + `content`
- `+2` tokens at the end 
- mutimodal: text parts encoded; non-text parts use a stub (e.g. 85 for an image)

So `estimatePromptTokens(messages)` !=  `encode(JSON.stringfy(messages)).length`. 
The estimate is intentionally closer to what the chat API will count. 

Local estimate vs real upstream usage often differs by ~1-3%. That is expected. 

---


## Input tokens vs output tokens 

These are the two halves of almost every LLM bill and rate-limit check. 
Same "token" unit, different roles - and usually **different prices**. 

| Name you will see | Also called | What it is | In this repo |
|-------------------|-------------|------------|--------------|
| **Input tokens** | prompt tokens | Tokens you **send** (messages + chat format overhead) | `estimatePromptTokens` → `prompt_tokens` |
| **Output tokens** | completion tokens | Tokens the model **generates** | `estimateCompletionTokens` / `max_tokens` → `completion_tokens` |


Here is the OpenAI-style `usage` uses the *older* names: 

```json 
{
  "prompt_tokens": 42,
  "completion_tokens": 15,
  "total_tokens": 57
}
```

Newer Responses APIs often say `input_tokens` / `output_tokens`. Same idea. 

### Why split them? 

1. **Pricing** - output is typically more expensive than input. This project's toy rates (`calculator.ts`): 
- prompt: **10** micro per token 
- completion: **30** micro per token 

2. **When you know the count** 
- input can be estimated **before** the call (you already have the messages). 
- output length is unknown until generation finishes; before that you only have a **ceiling**: `max_tokens`. 


3. **Reservation math** - gateways reserve the worest case: 

```
reserved ≈ estimated_input + max_tokens 
         = estimated_prompt + estimated_completion_cap  
```


After success, settle with real `prompt_tokens + completion_tokens`.


## How this shows up in source 

```
messages ──estimatePromptTokens──► input  (known-ish)
max_tokens ───────────────────────► output ceiling (unknown yet)
assistant text ──estimateCompletionTokens──► actual output (after / fake upstream)
```


- `/v1/estimate` returns `estimated_prompt_tokens`, `estimated_completion_cap`, and their sum for reserve. 
- `/v1/chat` reserves TPM/money on that sum, then settles with `usage.prompt_tokens` + `usage.completion_tokens`. 

**tiktoken itself does not care** about "input vs output" - `encode()` just counts tokens for a string. The **gateway** labels one count as input (your messages) and another as output (the reply / `max_tokens`). 


---

## Anthropic tokens, "chunks," and GPU 
### Are Anthropic tokens "based on chunks"?

**No -- not in the streaming sense.** Claude still bills and limits on **tokens** (vocabulary pieces from Anthropic's own tokenizer), 
same conceptual role as OpenAI's tokens. 

What trips people up: the word **chunk** means several different things. 

| “Chunk” people say | What it actually is | Same as a token? |
|--------------------|---------------------|------------------|
| Streaming / SSE chunk (`text_delta`, `content_block_delta`) | Network/API delivery slice of text JSON | **No.** One event may hold many tokens, one token, or even a **partial** fragment. Anthropic batches deltas arbitrarily. |
| RAG / document chunk | A slice of a PDF or repo you embed and retrieve | **No.** Those are app-level text windows; each chunk is later tokenized into many tokens. |
| Informal “token ≈ chunk of text” | Loose English for “a piece of the string” | Casual only — not the API unit. |


So:

- **Token** = model's atomic text unit (billing / TPM / context).
- **Stream chunk** = how the HTTP stream dribbles text to your client. 
- Counting stream events != counting tokens. Use `usage` (for Anthropic's token-count API). 


### OpenAI: chunk vs token (shallow)
Same split applies to OpenAI Chat Completions / Responses streaming. 

- **Tokens** -- what tiktoken counts; what shows up in `usage.prompt_tokens` / `completion_tokens` (or `input_tokens` / `output_tokens`). Billing and TPM use this. 

- **Chunk** -- one SSE frame in the stream, e.g., a line of `data: {"choices": [{"delta": {"content": "Hello"}}]}` (Chat Completions) or a Responses API stream event. Your client often does `for await (const chunk of stream)`. 

Rules of thumb: 

1. A chunk's `delta.content` is **text**, not a token ID list. 
2. One chunk may be one token's text, several tokens, or (rarely) an awkward fragment - do **not** treat `number of chunks ≈ completion_tokens`. 
3. When the stream ends, trust **`usage`** (or count the full assembled string with tiktoken if you only need an estimate). 

```
OpenAI GPU / model  →  emits tokens
OpenAI HTTP stream  →  batches those into chunks (SSE events)
Your app            →  concatenates chunk text; settles on usage / tiktoken
```

So in OpenAI docs/SDK code, "chunk" almost always means **stream packet**, not "one token."


### Antropic vs OpenAI tokenizers 

| | OpenAI | Anthropic (Claude) |
|--|--------|---------------------|
| Public tokenizer | Yes (`tiktoken`, encodings like `cl100k_base` / `o200k_base`) | **No** public vocab for current Claude 3+ models |
| Local exact count | `encode().length` | Not reliably available client-side |
| Practical gateway approach | Local estimate with tiktoken | Estimate with a proxy (this book uses `cl100k_base`) **or** call Anthropic’s count API; **always settle** on upstream `usage` |

Rough ballpark for Claude is still ~4 characters / token in English, but **boundaries differ** from GPT — never assume 1:1 with tiktoken.


### Why GPUs care about tokens (light hardware picture)

You do not need CUDA to follow billing, but tokens map onto hardware in a useful way: 

```
text → tokens → GPU tensors (matrices of numbers)
```


1. **Weights live in VRAM**

The model’s parameters (billions of floats) sit in GPU memory. Bigger model → more VRAM just to load it. This cost is mostly fixed per model, no


2. **Each request also needs working memory** 
For a Transformer, attention needs a **KV cache**: stored keys/values for tokens already seen so the model does not recompute everything every step.  
**Longer context (more input tokens) → larger KV cache → more VRAM / HBM.**  
That is one reason long-context requests are expensive and rate-limited.

3. **Generation is sequential** 
Output tokens are usually produced **one (or a small group) at a time**. Each new token runs another forward pass using the KV cache. So **more output tokens ≈ more compute time** on the GPU — which is why output often costs more than input.

4. **Batching** 
Serving stacks pack many users’ token sequences onto one GPU (continuous batching). Throughput is measured in tokens/sec; your **TPM** limit is the product/API reflection of shared capacity, not a magical cloud meter unrelated to silicon.


5. **Where "chunk" fits on the wire**
The GPU/scheduler thinks in **tokens** (and batches of sequences). Your laptop receives **stream chunks** for UX. 
Those layers are deliberately decoupled. 


Mental model: 

```
[GPU]  tokens in  →  matmuls + KV cache  →  tokens out
         ▲                                    │
         │              usage counts          │
[API]  input_tokens / output_tokens  ◄────────┘
         ▲
[HTTP] stream chunks (text deltas)  ←── not 1:1 with tokens
```


Just remember: **Tokens are the model/hardware unit; chunks are usually the transport or app unit.**







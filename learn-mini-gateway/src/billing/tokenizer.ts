import { Tiktoken, getEncodingNameForModel, type TiktokenEncoding } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import o200k_base from 'js-tiktoken/ranks/o200k_base';

import type { IRMessage } from '../types/ir.js';

const ENCODERS = new Map<TiktokenEncoding, Tiktoken>();

function getEncoder(name: TiktokenEncoding): Tiktoken {
  let enc = ENCODERS.get(name);
  if (enc) return enc;
  enc = new Tiktoken(name === 'o200k_base' ? o200k_base : cl100k_base);
  ENCODERS.set(name, enc);
  return enc;
}

function pickEncoding(model: string): TiktokenEncoding {
  try {
    return getEncodingNameForModel(model as never);
  } catch {
    if (/^(o1|o3|gpt-4o|gpt-5)/.test(model)) return 'o200k_base';
    return 'cl100k_base';
  }
}

export function estimatePromptTokens(messages: IRMessage[], model: string): number {
  const enc = getEncoder(pickEncoding(model));
  let tokens = 0;
  for (const m of messages) {
    tokens += 4 + enc.encode(m.role).length;
    if (typeof m.content === 'string') tokens += enc.encode(m.content).length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content as Array<{ type?: string; text?: string }>) {
        tokens += p?.type === 'text' && p.text ? enc.encode(p.text).length : 85;
      }
    }
  }
  return tokens + 2;
}

export function estimateCompletionTokens(text: string, model: string): number {
  if (!text) return 0;
  return getEncoder(pickEncoding(model)).encode(text).length;
}

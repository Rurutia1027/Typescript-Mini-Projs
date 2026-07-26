// Same tokenizer approach as book-llm-gateway billing/tokenizer.ts
// - js-tiktoken/lite + rank modules (Workers-friendly, no native binding)
// - encoder Map cache
// - getEncodingNameForModel + regex fallback
// - estimatePromptTokens / estimateCompletionTokens


import { Tiktoken, getEncodingNameForModel, type TiktokenEncoding } from 'js-tiktoken/lite'; 
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import o200k_base from 'js-tiktoken/ranks/o200k_base';  

export interface Msg {
    role: string; 
    content: string | Array<{type?: string; text?: string}> | null; 
}


const ENCODERS = new Map<TiktokenEncoding, Tiktoken>(); 

function getEncoder(name: TiktokenEncoding): Tiktoken {
    let enc = ENCODERS.get(name); 
    if (enc) return enc; 
    const ranks = name === 'o200k_base' ? o200k_base : cl100k_base;  
    enc = new Tiktoken(ranks); 
    ENCODERS.set(name, enc); 
    return enc; 
}

export function pickEncoding(model: string): TiktokenEncoding {
    try {
        return getEncodingNameForModel(model as never); 
    } catch {
        if (/^(o1|o3|gpt-4o|gpt-5)/.test(model)) return 'o200k_base';
        return 'cl100k_base';
    }
}

/** OpenAI cookbook-style prompt estimate (same as the book).*/
export function estimatePromptTokens(messages: Msg[], model: string): number {
    const enc = getEncoder(pickEncoding(model)); 
    let tokens = 0; 
    for (const m of messages) {
        tokens += 4; 
        tokens += enc.encode(m.role).length; 
        const c = m.content; 
        if (typeof c === 'string') {
            tokens += enc.encode(c).length; 
        } else if (Array.isArray(c)) {
            for (const part of c) {
                // content is an array is the feature that antropic supports 
                if (part?.type === 'text' && typeof part.text === 'string') {
                    tokens += enc.encode(part.text).length; 
                } else {
                    tokens += 85; // image stub 
                }
            }
        } 
        tokens += 2; // extra token buffers 
        return tokens; 
    }
}

export function estimateCompletionTokens(text: string, model: string): number {
    if (!text) return 0; 
    return getEncoder(pickEncoding(model)).encode(text).length; 
}
/**
 * Input/Output token estimation for billing purposes. 
 * Input Token ~ Prompt Token depends on {model & role type <user | assistant | tool>} and prompt text content parsed by the tiktoken funcs 
 * Output Token ~ Completion Token depends on {model & text content} 
*/  

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

// estimate input token number 
export function estimatePromptTokens(messages: IRMessage[], model: string): number {
    const enc = getEncoder(pickEncoding(model));  
    let tokens = 0; 
    for (const msg of messages) {
        tokens += 4 + enc.encode(msg.role).length; 
        if (typeof msg.content === 'string') tokens += enc.encode(msg.content).length;  
        else if (Array.isArray(msg.content)) {
            for (const m of msg.content as Array<{type?:string; text?: string}>) {
                tokens += m?.type === 'text' && m?.text ? enc.encode(m.text).length : 85; 
            }
        }
    }
    return tokens + 2; 
}

// estimate output token number 
export function estimateCompletionTokens(text: string, model: string): number {
    if (!text) return 0; 
    return getEncoder(pickEncoding(model)).encode(text).length; 
}
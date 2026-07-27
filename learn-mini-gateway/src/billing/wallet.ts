/**
 * Provides money - token transformation based on the formular: 
 * Token Cost = (Input Token + Output Token) * (Input Token Price + Output Token Price)
 * 
 * Input Token Price ~ model.info.input_token_price
 * Output Token Price ~ model.info.output_token_price
 * 
 * Input Token ~ Prompt Token depends on {model & role type <user | assistant | tool>} and prompt text content parsed by the tiktoken funcs 
 * Output Token ~ Completion Token depends on {model & text content} 
 * 
 * Input Token Price ~ model.info.input_token_price
 * Output Token Price ~ model.info.output_token_price
 * 
 * Cost = (Input Token + Output Token) * (Input Token Price + Output Token Price)
 * 
 * Model Price = 
 * 1 USD = 1000 Tokens 
 * 1 Token = 0.001 USD  
*/

import { estimatePromptTokens } from "./tokenizer.js";
import type { IRMessage } from "../types/ir.js";

export class InsufficientBalanceError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'InsufficientBalanceError';
    }
  }

interface Reservation {
    id: string; 
    userId: string; 
    reserved: number; 
    status: 'reserved' | 'finalized' | 'refunded';  
}

// balance: user id -> balance amount (seed demo users; units = money after price())
const balance = new Map<string, number>([
    ['alice', 5_000_000],
]);

// reservations: reservation id -> reservation 
const reservations = new Map<string, Reservation>(); 

/**
 * Demo pricing constants (intentionally static for learning only). 
 * Unit choice: 
 * - Most LLM vendors publish prices as "money per 1K tokens". 
 * - So we keep rates in the same unit: RATE_PER_1K_TOKENS. 
 * 
 * Cost formula: 
 * - cost = (promptTokens * PROMPT_RATE_PER_1K_TOKENS + 
 *          completionTokens * COMPLETION_RATE_PER_1K_TOKENS) 
 *          / TOKEN_PRICE_DENOMINATOR
 * - TOKEN_PRICE_DENOMINATOR = 1000 means "convert per-1K price to per-1-token price" for better accuracy and precision.
 * 
 * About these demo values: 
 * - `10` and `30` are example rates, not official real-world prices. 
 * - They represent "money units per 1K tokens" in this toy project. 
 * 
 * Production note: 
 * - Real projects usually do NOT hardcode rates. 
 * - Rates often change by model/tier/region/time window and may include discounts, taxes, minimum charges, or blended formulas. 
 * - Typical production approach:
 *    1) pull latest rates from a pricing service/API.
 *    2) cache with TTL + fallback, 
 *    3) version formulas for auditability.
*/
const TOKEN_PRICE_DENOMINATOR = 1_000;
const PROMPT_RATE_PER_1K_TOKENS = 10;
const COMPLETION_RATE_PER_1K_TOKENS = 30;

// price formula: promptTokens * promptUnitPrice + completionTokens * completionUnitPrice
const price = (promptTokens: number, completionTokens: number) =>
  (promptTokens * PROMPT_RATE_PER_1K_TOKENS +
    completionTokens * COMPLETION_RATE_PER_1K_TOKENS) /
  TOKEN_PRICE_DENOMINATOR;

export function preConsume(userId: string, model: string, messages: IRMessage[], maxTokens: number) {
    const estP = estimatePromptTokens(messages, model); 
    const cost = price(estP, maxTokens); 
    const bal = balance.get(userId) ?? 0; 
    if (bal < cost) {
        throw new InsufficientBalanceError(`Insufficient balance for user ${userId}`);          
    }

    balance.set(userId, bal - cost); 
    const id = `r_${Date.now()}`; 
    const res: Reservation = {id, userId, reserved: cost, status: 'reserved'}; 
    reservations.set(id, res); 
    return {reservation: res, estimatePromptTokens: estP}; 
}


// id: reservation id ${r_Date.now()}
// prompt: input token number 
// completion: output token number (ususally parsed from upstream AI server response -- real completion tokens number)
export function postConsume(id: string, prompt: number, completion: number) {
    const res = reservations.get(id); 
    if (!res) {
        throw new Error(`Reservation ${id} not found`);   
    }

    // actual cost = (prompt + completion) * (input token price + output token price)
    const actual = price(prompt, completion); 
    balance.set(res.userId, (balance.get(res.userId) ?? 0) + (res.reserved - actual)); 
    res.status = 'finalized'; 
}


export function refund(id: string) {
    const res = reservations.get(id); 
    if (!res || res.status !== 'reserved') return; 
    balance.set(res.userId, (balance.get(res.userId) ?? 0) + res.reserved); 
    res.status = 'refunded'; 
    reservations.delete(id); 
}


export function getBalance(userId: string) {
    return balance.get(userId) ?? 0;  
}
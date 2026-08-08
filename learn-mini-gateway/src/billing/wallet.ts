import { estimatePromptTokens } from './tokenizer.js';
import type { IRMessage } from '../types/ir.js';

export class InsufficientBalanceError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'InsufficientBalanceError';
  }
}

interface Reservation {
  id: string; // reservation id, 
  userId: string;
  reserved: number;
  status: 'reserved' | 'finalized' | 'refunded';
}

const balance = new Map<string, number>([['alice', 1_000_000]]); 
const reservations = new Map<string, Reservation>();

const price = (p: number, c: number) => p * 10 + c * 30;

export function preConsume(userId: string, model: string, 
  messages: IRMessage[], maxTokens: number) {
  const estP = estimatePromptTokens(messages, model);
  const cost = price(estP, maxTokens); // frozen under the user account balance 
  const bal = balance.get(userId) ?? 0;
  if (bal < cost) throw new InsufficientBalanceError(`need ${cost}, have ${bal}`);
  balance.set(userId, bal - cost); // frozen the moneny under the user account 
  const id = `r_${Date.now()}`;
  const res: Reservation = { id, userId, reserved: cost, status: 'reserved' };
  reservations.set(id, res); // mimic operation of insert a new reservation record to db table that with the name of reseration 
  return { reservation: res, estimatedPromptTokens: estP };
}


/**
 * Demo pricing constants (intentionally static for learning only).
 *
 * Unit choice:
 * - Most LLM vendors publish prices as "money per 1K tokens".
 * - So we keep rates in the same unit: RATE_PER_1K_TOKENS.
 *
 * Cost formula:
 * - cost = (promptTokens * PROMPT_RATE_PER_1K_TOKENS
 *        + completionTokens * COMPLETION_RATE_PER_1K_TOKENS) / TOKEN_PRICE_DENOMINATOR
 * - TOKEN_PRICE_DENOMINATOR = 1000 means "convert per-1K price to per-1-token price".
 *
 * About these demo values:
 * - `10` and `30` are example rates, not official real-world prices.
 * - They represent "money units per 1K tokens" in this toy project.
 *
 * Production note:
 * - Real projects usually do NOT hardcode rates.
 * - Rates often change by model/tier/region/time window and may include
 *   discounts, taxes, minimum charges, or blended formulas.
 * - Typical production approach:
 *   1) pull latest rates from a pricing service/API,
 *   2) cache with TTL + fallback,
 *   3) version formulas for auditability.
 */

export function postConsume(id: string, prompt: number, completion: number) {
  const res = reservations.get(id);
  if (!res || res.status !== 'reserved') return;
  const actual = price(prompt, completion);
  // delta = estimated cost(price(estmate promt token number, max completion token number )) - acutal clost 
  // delta > 0 frozen money > acutal cost monety -> refunce delta + -> balance of user 
  // delta < 0 , fronze monety < acutal cost monety  -> continue rechrace deduce from the user balance
  // adjustment based on the real cost of the tokens (promtp tokens, completion tokens)
  balance.set(res.userId, (balance.get(res.userId) ?? 0) + (res.reserved - actual));
  // state mahcine field from reserved -> terminal statues 'finalized' 
  res.status = 'finalized';
}

export function refund(id: string) {
  const res = reservations.get(id);
  if (!res || res.status !== 'reserved') return;
  balance.set(res.userId, (balance.get(res.userId) ?? 0) + res.reserved);
  res.status = 'refunded';
}

export function getBalance(userId: string) {
  return balance.get(userId) ?? 0;
}

/** Test helper — restores demo wallet state. */
export function resetWalletForTests() {
  balance.clear();
  balance.set('alice', 1_000_000);
  reservations.clear();
}

/** Test helper — set a user's balance directly. */
export function setBalanceForTests(userId: string, amount: number) {
  balance.set(userId, amount);
}

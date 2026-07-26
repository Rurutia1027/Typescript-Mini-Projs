/**
 * Money preConsume / postConsume / refund - isomorpic to book Ch5 but all operations in-memory (no SQLite). 
 * 
 * Flow: 
 * estimate prompt + max_tokens 
 * - reserve balance (optimistic)
 * - call "upstream"
 * - settle with actual usage (or refund on failure)
*/

import { estimatePromptTokens } from "./tokenizer.js";

export class InsufficientBalanceError extends Error {
    constructor(message: string) {
        super(message); 
        this.name = 'InsufficientBalanceError'; 
    }
}

export class UserCannotFoundInWallet extends Error {
    constructor(message: string) {
        super(message); 
        this.name = 'UserCannotFoundInWallet'; 
    }
}

export interface Wallet {
    userId: string; 
    // Micro-units (e.g., 1_000_000 = $1)
    balance: number; 
}

export interface Reservation {
    id: string; 
    userId: string; 
    reservedMicro: number; 
    estimatedPromptTokens: number; 
    estimatedCompletionTokens: number; 
    status: 'reserved' | 'finalized' | 'refunded'; 
}

/** Toy price: 10 micro per prompt token, 30 micro per completion token. */
export function quoteMicro(promptTokens: number, completionTokens: number): number {
    return promptTokens * 10 + completionTokens * 30; 
}


// memory hold wallets, in tutorial we use sqlite instead 
// key: username, value: user info + user balance (available micro money)
const wallets = new Map<string, Wallet>([
    ['alice', {userId: 'alice', balance: 5_000_000}], // $5 
]); 

// memory hold reservation records, 
// key: reserve#id, value contxt for reservation records 
const reservations =  new Map<string, Reservation>(); 

export function getBalance(userId: string): number {
    return wallets.get(userId)?.balance ?? 0; 
}

export function preConsume(opts: {
    userId: string; 
    model: string; 
    messages: Msg[]; 
    maxTokens: number; 
}): Reservation {
    const estimatedPromptTokens = estimatePromptTokens(opts.messages, opts.model); 
    const estimatedCompletionTokens = opts.maxTokens; 

    // here we calculate the reserved value in micro unit 
    // by providing the estimated prmpot tokens number, and the estimated completion token number 
    const reservedMicro = quoteMicro(estimatedPromptTokens, estimatedCompletionTokens);
    
    const wallet = wallets.get(opts.userId); 
    // not wallet record can be found from memory kv store 
    if (!wallet) {
        throw new InsufficientBalanceError('unknow user'); 
    }

    // Optimistic debit (book use UPDATE ... WHERE balance >= ? RETURNING)
    if (wallet.balance < reservedMicro) {
        throw new InsufficientBalanceError(
            `need ${reservedMicro} micro, but only have ${wallet.balance}`, 
        ); 
    }
    wallet.balance -= reservedMicro; 

    const res: Reservation = {
        id: `rsv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, 
        userId: opts.userId, 
        reservedMicro, 
        estimatedPromptTokens, 
        estimatedCompletionTokens, 
        status: 'reserved', 
    }; 

    reservations.set(res.id, res); 
    return res; 
}

export function postConsume(
    reservationId: string, 
    actualPrompt: number, 
    actualCompletion: number, 
): Reservation {
    const res = reservations.get(reservationId); 
    if (!res || res.status != 'reserved') {
        throw new Error('invalid reservation'); 
    }

    const actualMicro = quoteMicro(actualPrompt, actualCompletion);  
    const wallet = wallets.get(res.userId);  
    const delta = res.reservedMicro - actualMicro; 

    if (!wallet) {
        throw new UserCannotFoundInWallet('unknow user'); 
    }

    // Positive delta -> refund over-reserve; negative -> charge more. 
    wallet.balance += delta; 
    res.status = 'finalized'; 
    return res; 
}

export function refund(reservationId: string): void {
    const res = reservations.get(reservationId); 
    if (!res || res.status !== 'reserved') return; 
    const wallet = wallets.get(res.userId); 

    if (!wallet) {
        throw new UserCannotFoundInWallet('unknow user'); 
    }

    wallet.balance += res.reservedMicro; 
    res.status = 'refunded'; 
}
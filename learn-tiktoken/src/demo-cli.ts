// CLI demo without HTTP  - run: npm run demo 

import { estimateCompletionTokens, estimatePromptTokens, pickEncoding } from "./billing/tokenizer.js";
import {
    getBalance, 
    postConsume, 
    preConsume, 
    refund, 
    InsufficientBalanceError, 
} from './billing/calculator.js'; 
import { commitTpm, peekTpm, releaseTpm, reserveTpm } from "./limit/tpm.js";

const model = 'gpt-4o-mini'; 
const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Explain tokens in one short sentence.' },
]; 

console.log('encoding', pickEncoding(model)); 
console.log('prompt estimate', estimatePromptTokens(messages, model)); 


const userId = 'alice'; 
console.log('balance before: ', getBalance(userId)); 

const tpmKey = `key:${userId}`; 
const maxTokens = 64; 
const estPromptTokenCnt = estimatePromptTokens(messages, model); 
const tpm = reserveTpm(tpmKey, estPromptTokenCnt + maxTokens); 
if (!tpm) {
    console.error('TPM denied'); 
    process.exit(1); 
}

let reservation; 
try {
    reservation = preConsume({userId, model, messages, maxTokens}); 
} catch (e) {
    if (e instanceof InsufficientBalanceError) {
        console.error('402', e.message); 
        releaseTpm(tpm); 
        process.exit(1);  
    }
    throw e; 
}

console.log('reserved:', reservation); 
console.log('balance after preConsume:', getBalance(userId)); 
console.log('tpm after reserve: ', peekTpm(tpmKey)); 


// Simulate upstream success with actual usage different from estimate. 
const fakeCompletion = 'Tokens are pieces of text models bill and process.'; 
const actualCompletion = estimateCompletionTokens(fakeCompletion, model); 
const actualPrompt = estPromptTokenCnt; // pretend upstream matched local estimate token cnt 

postConsume(reservation.id, actualPrompt, actualCompletion); 
commitTpm(tpm, actualPrompt + actualCompletion); 


console.log('actual completion tokens:', actualCompletion); 
console.log('balance after postConsume:', getBalance(userId)); 
console.log('tpm after commit: ', peekTpm(tpmKey)); 



// Second path: refund demo  
const tpm2 = reserveTpm(tpmKey, estPromptTokenCnt + maxTokens);  
if (!tpm2) {
    console.error('TPM denied on refund demo'); 
    process.exit(1); 
}
const r2 = preConsume({userId, model, messages, maxTokens: 10}); 
refund(r2.id); 
releaseTpm(tpm2); 
console.log('after refund demo balance: ', getBalance(userId)); 

// SSE wire helpers - same constants/names as book event-normalizer.ts 

// those are the contracts between server side & client side for SSE streaming protocol  
export const SSE_DONE = 'data: [DONE]\n\n'; 
export const SSE_HEARTBEAT = ': keepalive\n\n'; 

export function encodeSseData(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`;     
}

// split a buffer into complet SSE events (separated by blank line).
// this is good, this is a very classical SSE manipulate function
export function splitSseEvents(buffer: string): { events: string[]; rest: string} {
    const events: string[] = []; 
    let start = 0; 
    while (true) {
        const idx = buffer.indexOf('\n\n', start); 
        if (idx === -1) break; 
        // here we slice the buffer to get the event string and add it to the events array 
        events.push(buffer.slice(start, idx + 2)); 
        start = idx + 2; 
    }

    // return value contains the parsed value -- events array and the rest of the buffer 
    return {events, rest: buffer.slice(start)}; 
}

// extract data: lines from one SSE event block; skip comment lines 
export function extractDataLines(eventBlock: string): string [] {
    const out: string [] = []; 
    for (const line of eventBlock.split('\n')) {
        if (line.startsWith(':')) continue;  // heartbeat / comment 
        if (line.startsWith('data:')) {
            out.push(line.slice(5).trimStart()); 
        }
    }
    return out; 
}
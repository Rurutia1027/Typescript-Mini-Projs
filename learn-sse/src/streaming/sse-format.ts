/**
 * SSE wire helpers — same constants/names as book event-normalizer.ts
 */
export const SSE_DONE = 'data: [DONE]\n\n';
export const SSE_HEARTBEAT = ': keepalive\n\n';

export function encodeSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Split a buffer into complete SSE events (separated by blank line). */
// start         |
//  buffer     {(start) hello world (idx)\n\n(start)hello world\n\n} <- append  
// buffer -> hello world -> events[0]
// referece -> decode <- {} <- {  hello world \n\nhello w|}  <- network (netwokr msg) 
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf('\n\n', start);
    if (idx === -1) break;
    events.push(buffer.slice(start, idx));
    start = idx + 2;
  }

  return { events, rest: buffer.slice(start) };
}

/** Extract data: lines from one SSE event block; skip comment lines. */
export function extractDataLines(eventBlock: string): string[] {
  const out: string[] = [];
  for (const line of eventBlock.split('\n')) {
    if (line.startsWith(':')) continue; // heartbeat / comment
    if (line.startsWith('data:')) {
      out.push(line.slice(5).trimStart());
    }
  }
  return out;
}

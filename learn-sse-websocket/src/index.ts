/**
 * Demo gateway: 
 * - POST /v1/chat/completions -> SSE proxy (book style)
 * - WS /ws-echo -> tiny WebSocket echo (contrast)
*/

import { createServer } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import { Hono } from 'hono'; 
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer } from 'ws'; 

const UPSTREAM = process.env.UPSTREAM_URL ?? 'http://127.0.0.1:3199/v1/chat/completions';
const PORT = Number(process.env.PORT ?? 3103);

const app = new Hono(); 
const finalizeLog: unknown[] = []; 

const listener = getRequestListener(app.fetch); 
const server = createServer((req, res) => {
    void listener(req as unknown as Http2ServerRequest, 
        res as unknown as Http2ServerResponse, ); 
}); 

const wss = new WebSocketServer({ server, path: '/ws-echo'}); 
wss.on('connection', (socket) => {
    socket.send(JSON.stringify({type: 'hello', note: 'bidirectional WebSocket echo'})); 
    socket.on('message', (data) => {
        socket.send(JSON.stringify({type: 'echo', data: data.toString()})); 
    }); 
}); 

server.listen(PORT, () => {
    console.log(`learn-sse-websocket gatewa http://localhost:${PORT}`); 
    console.log(`Start upstream first: npm run upstream`); 
    console.log(`WebSocket echo: ws://localhost:${PORT}/ws-echo`); 
}); 
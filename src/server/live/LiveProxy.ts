import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { config } from '../config.js';

const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export class LiveProxy {
  private server = new WebSocketServer({ noServer: true });
  constructor() { this.server.on('connection', (client) => this.connect(client)); }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) { this.server.handleUpgrade(request, socket, head, (client) => this.server.emit('connection', client, request)); }

  private connect(client: WebSocket) {
    if (!config.geminiKey) { client.close(1011, 'GEMINI_API_KEY is not configured'); return; }
    const upstream = new WebSocket(`${ENDPOINT}?key=${encodeURIComponent(config.geminiKey)}`);
    const queued: Array<{ data: Buffer; binary: boolean }> = [];
    let ready = false; let setupSeen = false;
    upstream.on('open', () => { ready = true; for (const item of queued) upstream.send(item.data, { binary: item.binary }); queued.length = 0; });
    upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
    upstream.on('close', (code, reason) => { if (client.readyState === WebSocket.OPEN) client.close(code, reason.toString()); });
    upstream.on('error', (error) => { if (client.readyState === WebSocket.OPEN) client.close(1011, `Gemini upstream error: ${error.message}`); });
    client.on('message', (data, binary) => {
      let payload = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
      if (!binary && !setupSeen) {
        try {
          const message = JSON.parse(payload.toString());
          if (message.setup) { message.setup.model = config.liveModel.startsWith('models/') ? config.liveModel : `models/${config.liveModel}`; payload = Buffer.from(JSON.stringify(message)); setupSeen = true; }
        } catch { /* Gemini will report malformed setup */ }
      }
      if (ready && upstream.readyState === WebSocket.OPEN) upstream.send(payload, { binary }); else queued.push({ data: payload, binary });
    });
    client.on('close', () => { if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(); });
    client.on('error', () => upstream.close());
  }
}

import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleSocketClose, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import type { SocketLike } from './sessions';

function wrap(ws: WebSocket): SocketLike {
  return {
    send: (data, cb) => ws.send(data, cb),
    close: (code, reason) => ws.close(code, reason),
  };
}

/** Accept ConversationRelay upgrades on /conversation only; the token from the query is checked at setup. */
export function attachWebSocketServer(server: Server, deps: AdapterDeps): WebSocketServer {
  // 64 KiB is far above any ConversationRelay message; larger payloads are closed with 1009 by ws.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/conversation') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, token));
  });
  wss.on('connection', (ws: WebSocket, token: string | null) => {
    const ctx = newConnectionContext(token);
    const sock = wrap(ws);
    ws.on('message', (data) => {
      void handleSocketMessage(deps, sock, ctx, data.toString());
    });
    ws.on('close', () => {
      void handleSocketClose(deps, ctx);
    });
    ws.on('error', (err) => deps.log(`${ctx.callSid ?? 'unknown'}: socket error ${err.message}`));
  });
  return wss;
}

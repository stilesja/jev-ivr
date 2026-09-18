import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleSocketClose, handleSocketMessage, newConnectionContext, type AdapterDeps } from './adapter';
import type { SocketLike } from './sessions';

/** A connection that has not identified itself with a setup message by now is not ConversationRelay. */
export const SETUP_TIMEOUT_MS = 10_000;

/** Tokens are minted as 16 random bytes in hex; anything else never had a chance of verifying. */
const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

function wrap(ws: WebSocket): SocketLike {
  return {
    send: (data, cb) => ws.send(data, cb),
    close: (code, reason) => ws.close(code, reason),
  };
}

/** Accept ConversationRelay upgrades on /conversation only; the token from the query is checked at setup. */
export function attachWebSocketServer(server: Server, deps: AdapterDeps, setupTimeoutMs: number = SETUP_TIMEOUT_MS): WebSocketServer {
  // 64 KiB is far above any ConversationRelay message; larger payloads are closed with 1009 by ws.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const onConnection = (ws: WebSocket, token: string): void => {
    const sock = wrap(ws);
    const ctx = newConnectionContext(token, sock);
    // Twilio sends setup immediately; a socket that never does is holding a session slot for nothing.
    const deadline = setTimeout(() => {
      deps.log('connection closed: no setup within the deadline');
      ws.close(1008, 'setup timeout');
    }, setupTimeoutMs);
    deadline.unref();
    ws.on('message', (data) => {
      void handleSocketMessage(deps, sock, ctx, data.toString()).catch((err: unknown) =>
        deps.log(`${ctx.callSid ?? 'unknown'}: message handler failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      void handleSocketClose(deps, ctx).catch((err: unknown) =>
        deps.log(`${ctx.callSid ?? 'unknown'}: close handler failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    ws.on('error', (err) => deps.log(`${ctx.callSid ?? 'unknown'}: socket error ${err.message}`));
  };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/conversation') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    // A malformed token can never verify, so refuse before spending a socket on it.
    if (!token || !TOKEN_SHAPE.test(token)) {
      deps.log('upgrade refused: missing or malformed token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, token));
  });

  return wss;
}

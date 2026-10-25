import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { appLogger } from "#observability/logger.ts";
import {
  decrementWebSocketConnections,
  incrementWebSocketConnections,
} from "#observability/metrics.ts";
import { isNodeUpgradePath } from "#platform/bun/nodeServer.ts";
import type { Platform } from "#platform/platform.ts";
import {
  acceptRealtimeConnection,
  type RealtimeConnection,
} from "#realtime/websocket.ts";

export interface RealtimeWebSocketServer {
  close(): void;
}

/**
 * How long a connection may go without a frame before it is dropped, and how
 * often the sweep looks. Clients ping every 25s, so silence this long is three
 * missed rounds — a connection that died without a close frame, holding its
 * Yjs rooms and presence entries.
 */
const CONNECTION_IDLE_TIMEOUT_MS = 90_000;
const IDLE_SWEEP_INTERVAL_MS = 30_000;

function toBuffer(rawMessage: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(rawMessage)) return Buffer.concat(rawMessage);
  return Buffer.isBuffer(rawMessage) ? rawMessage : Buffer.from(rawMessage);
}

/** Attaches the realtime collaboration endpoint to the HTTP server. */
export function attachRealtimeWebSocketServer(
  platform: Platform,
  server: Server,
): RealtimeWebSocketServer {
  const websocketServer = new WebSocketServer({ noServer: true });
  const lastSeenAt = new WeakMap<object, number>();

  const idleSweep = setInterval(() => {
    const deadline = Date.now() - CONNECTION_IDLE_TIMEOUT_MS;
    for (const client of websocketServer.clients) {
      if ((lastSeenAt.get(client) ?? 0) > deadline) continue;
      client.terminate();
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref?.();

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/events\/([^/]+)$/);
    if (!match) {
      // The node endpoint listens on the same event and handles its own path.
      if (!isNodeUpgradePath(url.pathname)) socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      incrementWebSocketConnections();
      websocket.once("close", decrementWebSocketConnections);
      lastSeenAt.set(websocket, Date.now());
      websocket.on("message", () => lastSeenAt.set(websocket, Date.now()));
      // Listening before authentication, so a socket that closes meanwhile
      // still releases what the accepted connection subscribed to.
      let connection: RealtimeConnection | null = null;
      let closed = false;
      websocket.on("close", () => {
        closed = true;
        connection?.close();
      });
      acceptRealtimeConnection(
        platform,
        websocket,
        request.headers as unknown as Headers,
        match[1],
      )
        .then((accepted) => {
          if (!accepted) return;
          if (closed) {
            accepted.close();
            return;
          }
          connection = accepted;
          websocket.on("message", (rawMessage: Buffer | ArrayBuffer | Buffer[]) => {
            void accepted.message(toBuffer(rawMessage));
          });
        })
        .catch((error: unknown) => {
          appLogger.warn("Could not accept a realtime connection", {
            error,
            spaceId: match[1],
          });
          websocket.close();
        });
    });
  });

  return {
    close(): void {
      clearInterval(idleSweep);
      websocketServer.close();
      for (const client of websocketServer.clients) {
        try {
          client.close();
        } catch (error) {
          appLogger.warn("Failed to close WebSocket client", { error });
        }
      }
    },
  };
}

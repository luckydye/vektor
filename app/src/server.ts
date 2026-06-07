import "./observability/bootstrap.ts";
import type { IncomingMessage } from "node:http";
import type { dev } from "astro";
import express from "express";
import { type WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import { apiRouter } from "./api/server/router.ts";
import { auth } from "./auth.ts";
import { config, isTrustProxyEnabled } from "./config.ts";
import { verifyDocumentRole, verifySpaceRole } from "./db/api.ts";
import { publishSyncEvents, subscribeToSyncEvents } from "./db/ws.ts";
import { startCronScheduler, stopCronScheduler } from "./jobs/cronScheduler.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "./noAuth.ts";
import { appLogger } from "./observability/logger.ts";
import { createEmbeddedClientAssetMiddleware } from "./utils/clientAssets.ts";
import {
  isDocumentRealtimeTopic,
  type PresenceEnvelope,
  type PresenceJoinPayload,
  type PresenceLeavePayload,
  type PresenceUpdatePayload,
  realtimeTopics,
  WsMsgType,
  wsDecode,
  wsDecodeJson,
  wsDecodeYjsUpdate,
  wsEncode,
  wsEncodeYjsUpdate,
} from "./utils/realtime.ts";
import { getRoom, loadYDoc, type YRoom, yRooms } from "./utils/yjsRooms.ts";

function broadcastPresence(room: YRoom, sender: any, type: WsMsgType, payload: object) {
  const frame = wsEncode(type, payload);
  for (const client of room.clients) {
    if (client === sender || client.readyState !== 1) {
      continue;
    }
    client.send(frame);
  }
}

const app = express();

// Only honor X-Forwarded-* headers when an operator confirms a trusted reverse
// proxy sits in front of the app — otherwise clients can spoof their IP/proto.
if (isTrustProxyEnabled()) {
  app.set("trust proxy", true);
}

const realtimeWebSocketServer = new WebSocketServer({ noServer: true });
const getWss = () => realtimeWebSocketServer;

// Logging
app.use((req: any, res: any, next: any) => {
  const startTime = Date.now();
  req.time = new Date(startTime).toString();
  appLogger.info("HTTP request", {
    method: req.method,
    host: req.hostname,
    path: req.path,
    time: req.time,
  });

  res.on("finish", () => {
    const durationMs = Date.now() - startTime;
    const attributes = {
      method: req.method,
      host: req.hostname,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
    };
    if (res.statusCode >= 500) {
      appLogger.error("HTTP response", attributes);
      return;
    }
    if (res.statusCode >= 400) {
      appLogger.warn("HTTP response", attributes);
      return;
    }
    appLogger.info("HTTP response", attributes);
  });

  res.on("close", () => {
    if (res.writableEnded) {
      return;
    }
    appLogger.warn("HTTP connection closed before response completed", {
      method: req.method,
      host: req.hostname,
      path: req.path,
    });
  });

  next();
});

const realtimeSpaceTopics = new Set<string>([
  realtimeTopics.acl,
  realtimeTopics.categories,
  realtimeTopics.categoryDocuments,
  realtimeTopics.documentTree,
  realtimeTopics.documents,
  realtimeTopics.properties,
]);

async function authorizeRealtimeTopic(
  spaceId: string,
  userId: string,
  topic: string,
): Promise<boolean> {
  if (realtimeSpaceTopics.has(topic)) {
    return true;
  }

  if (isDocumentRealtimeTopic(topic)) {
    await verifyDocumentRole(spaceId, topic.slice("document:".length), userId, "viewer");
    return true;
  }

  return false;
}

async function handleRealtimeWebSocket(
  websocket: WebSocket,
  request: IncomingMessage,
  spaceId: string,
) {
  let userId: string;

  if (isNoAuthMode()) {
    userId = LOCAL_USER_ID;
  } else {
    const session = await auth.api.getSession({
      headers: request.headers as any,
    });

    if (!session?.user?.id) {
      websocket.send(wsEncode(WsMsgType.Error, { message: "Unauthorized" }));
      websocket.close();
      return;
    }

    try {
      await verifySpaceRole(spaceId, session.user.id, "viewer");
    } catch {
      websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
      websocket.close();
      return;
    }

    userId = session.user.id;
  }

  const subscriptions = new Set<string>();
  const yjsRooms = new Set<string>();
  const joinedPresence = new Map<string, Set<string>>();
  const off = subscribeToSyncEvents((event) => {
    if (event.spaceId !== spaceId) return;

    const matchedEvents = event.events.filter(({ topic }) => subscriptions.has(topic));
    if (matchedEvents.length === 0) return;

    websocket.send(
      wsEncode(WsMsgType.Event, {
        topics: matchedEvents.map(({ topic }) => topic),
        events: matchedEvents,
        timestamp: event.timestamp,
      }),
    );
  });

  websocket.on("message", async (rawMessage: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const messageBuffer = Array.isArray(rawMessage)
        ? Buffer.concat(rawMessage)
        : Buffer.isBuffer(rawMessage)
          ? rawMessage
          : Buffer.from(rawMessage);
      const { type, payload } = wsDecode(messageBuffer);

      if (type === WsMsgType.YjsUpdate) {
        const { documentId, update } = wsDecodeYjsUpdate(payload);
        const roomKey = `${spaceId}:${documentId}`;
        const room = yRooms.get(roomKey);
        if (!room?.doc) return;

        Y.applyUpdate(room.doc, update, websocket);

        const frame = wsEncodeYjsUpdate(documentId, update);
        for (const client of room.clients) {
          if (client !== websocket && client.readyState === 1) {
            client.send(frame);
          }
        }
        return;
      }

      if (type === WsMsgType.YjsJoin) {
        const { documentId } = wsDecodeJson<{ documentId: string }>(payload);
        try {
          await verifyDocumentRole(spaceId, documentId, userId, "editor");
        } catch {
          websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
          return;
        }

        const roomKey = `${spaceId}:${documentId}`;
        const room = getRoom(spaceId, documentId);
        if (!room.doc) {
          room.doc = await loadYDoc(spaceId, documentId);
        }

        room.clients.add(websocket);
        yjsRooms.add(roomKey);

        websocket.send(wsEncodeYjsUpdate(documentId, Y.encodeStateAsUpdate(room.doc)));
        return;
      }

      if (type === WsMsgType.PresenceJoin) {
        const join = wsDecodeJson<PresenceJoinPayload>(payload);
        try {
          await verifyDocumentRole(spaceId, join.room, userId, "viewer");
        } catch {
          websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
          return;
        }

        const roomKey = `${spaceId}:${join.room}`;
        const room = getRoom(spaceId, join.room);
        room.clients.add(websocket);
        const presence: PresenceEnvelope = {
          room: join.room,
          clientId: join.clientId,
          user: join.user,
          state: join.state ?? null,
          updatedAt: new Date().toISOString(),
        };
        room.presences.set(join.clientId, presence);

        const roomPresence = joinedPresence.get(roomKey) ?? new Set<string>();
        roomPresence.add(join.clientId);
        joinedPresence.set(roomKey, roomPresence);

        websocket.send(
          wsEncode(WsMsgType.PresenceSnapshot, {
            room: join.room,
            presences: [...room.presences.values()],
          }),
        );
        broadcastPresence(room, websocket, WsMsgType.PresenceUpdate, {
          presence,
        });
        return;
      }

      if (type === WsMsgType.PresenceUpdate) {
        const update = wsDecodeJson<PresenceUpdatePayload>(payload);
        try {
          await verifyDocumentRole(spaceId, update.room, userId, "viewer");
        } catch {
          websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
          return;
        }

        const room = yRooms.get(`${spaceId}:${update.room}`);
        const existingPresence = room?.presences.get(update.clientId);
        if (!room || !existingPresence) {
          return;
        }

        const presence: PresenceEnvelope = {
          ...existingPresence,
          state: update.state,
          updatedAt: new Date().toISOString(),
        };
        room.presences.set(update.clientId, presence);
        broadcastPresence(room, websocket, WsMsgType.PresenceUpdate, {
          presence,
        });
        return;
      }

      if (type === WsMsgType.PresenceLeave) {
        const leave = wsDecodeJson<PresenceLeavePayload>(payload);
        const roomKey = `${spaceId}:${leave.room}`;
        const room = yRooms.get(roomKey);
        if (!room) {
          return;
        }
        room.presences.delete(leave.clientId);
        joinedPresence.get(roomKey)?.delete(leave.clientId);
        broadcastPresence(room, websocket, WsMsgType.PresenceLeave, {
          room: leave.room,
          clientId: leave.clientId,
          timestamp: new Date().toISOString(),
        });

        if (room.clients.size === 0 && room.presences.size === 0) {
          yRooms.delete(roomKey);
        }
        return;
      }

      if (type !== WsMsgType.Subscribe && type !== WsMsgType.Unsubscribe) {
        throw new Error("Unsupported message type");
      }

      const { topics } = wsDecodeJson<{ topics: string[] }>(payload);
      const authorizedTopics = new Set<string>();
      for (const topic of topics) {
        if (await authorizeRealtimeTopic(spaceId, userId, topic)) {
          authorizedTopics.add(topic);
        }
      }

      if (authorizedTopics.size !== topics.length) {
        websocket.send(
          wsEncode(WsMsgType.Error, {
            message: "One or more realtime topics are forbidden",
          }),
        );
      }

      if (type === WsMsgType.Subscribe) {
        for (const topic of authorizedTopics) subscriptions.add(topic);
      } else {
        for (const topic of authorizedTopics) subscriptions.delete(topic);
      }
    } catch (error) {
      appLogger.warn("Failed to handle realtime message", { error, spaceId });
      websocket.send(wsEncode(WsMsgType.Error, { message: "Invalid message" }));
    }
  });

  websocket.on("close", () => {
    off();

    for (const roomKey of yjsRooms) {
      const room = yRooms.get(roomKey);
      if (!room) continue;
      room.clients.delete(websocket);
      if (room.clients.size === 0 && room.presences.size === 0) {
        yRooms.delete(roomKey);
      }
    }

    for (const [roomKey, clientIds] of joinedPresence.entries()) {
      const room = yRooms.get(roomKey);
      if (!room) {
        continue;
      }

      for (const clientId of clientIds) {
        room.presences.delete(clientId);
        broadcastPresence(room, websocket, WsMsgType.PresenceLeave, {
          room: roomKey.slice(spaceId.length + 1),
          clientId,
          timestamp: new Date().toISOString(),
        });
      }

      room.clients.delete(websocket);
      if (room.clients.size === 0 && room.presences.size === 0) {
        yRooms.delete(roomKey);
      }
    }

    appLogger.info("Realtime WebSocket connection closed", { spaceId });
  });
}

// Serve the API directly from Express so it can operate without the Astro
// frontend. Mounted before express.json so handlers receive the raw request
// body (JSON, multipart, binary uploads, MCP, …).
app.use(apiRouter);

app.use(
  express.json({
    limit: "100mb",
    type: (req: any) => {
      // Skip express.json for MCP routes — they parse the body themselves
      if (req.url?.includes("/mcp")) return false;
      const ct = req.headers["content-type"] ?? "";
      return ct.includes("application/json");
    },
  }),
);
app.post("/sync", (req: any, res: any) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  publishSyncEvents(events);
  res.status(200).end();
});

// The Astro frontend is optional: set VEKTOR_API_ONLY=1 to run a headless API
// server (no client assets, no Astro dev server, no SSR handler).
const apiOnly = config().API_ONLY === "1" || config().API_ONLY === "true";

let devServer: Awaited<ReturnType<typeof dev>> | undefined;

if (!apiOnly) {
  if (import.meta.env.DEV) {
    app.use("/", express.static("dist/client/", { maxAge: 3_600_000 }));
  } else {
    const { embeddedClientAssets } = await import("../generated/client-assets.ts");
    app.use("/", createEmbeddedClientAssetMiddleware(embeddedClientAssets));
  }

  if (import.meta.env.DEV) {
    const { dev } = await import("astro");

    devServer = await dev({
      root: "./",
      logLevel: "error",
      server: {
        host: true,
      },
    });
  } else {
    import("../dist/server/entry.mjs").then(({ handler }) => {
      app.use(handler);
    });
  }
} else {
  appLogger.info("Starting in API-only mode (Astro frontend disabled)");
}

const runtimeArgv = globalThis.process?.argv ?? [];
const portArgIndex = runtimeArgv.findIndex((arg) => arg === "--port");
const portArg =
  portArgIndex >= 0
    ? runtimeArgv[portArgIndex + 1]
    : runtimeArgv.find((arg) => arg.startsWith("--port="))?.slice("--port=".length);
const port = Number.parseInt(portArg ?? "8080", 10);
const host = config().SERVER_HOST ?? "0.0.0.0";
const server = app.listen(port, host, () => {
  appLogger.info("Server listening", { host, port });
});

startCronScheduler();

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/events\/([^/]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }

  realtimeWebSocketServer.handleUpgrade(request, socket, head, (websocket) => {
    void handleRealtimeWebSocket(websocket, request, match[1]);
  });
});

let isShuttingDown = false;
let forcedShutdownTimer: ReturnType<typeof setTimeout> | undefined;

async function shutdown(reason: string, exitCode = 0) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  appLogger.info("Shutdown initiated", { reason, exitCode });

  stopCronScheduler();

  forcedShutdownTimer = setTimeout(() => {
    appLogger.error("Forced shutdown timeout reached", { reason, timeoutMs: 10_000 });
    process.exit(1);
  }, 10_000);
  forcedShutdownTimer.unref();

  if (devServer) {
    await devServer.stop();
  }

  try {
    realtimeWebSocketServer.close();
    for (const client of getWss().clients) {
      try {
        client.close();
      } catch (error) {
        appLogger.warn("Failed to close WebSocket client", { error });
      }
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    if (forcedShutdownTimer) {
      clearTimeout(forcedShutdownTimer);
    }
    appLogger.info("Shutdown completed", { reason });
    process.exit(exitCode);
  } catch (error) {
    appLogger.error("Shutdown failed", { reason, error });
    process.exit(1);
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT", 0);
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM", 0);
});

process.once("uncaughtException", (error) => {
  appLogger.error("Uncaught exception", { error });
  void shutdown("uncaughtException", 1);
});

process.once("unhandledRejection", (reason) => {
  appLogger.error("Unhandled rejection", { reason });
  void shutdown("unhandledRejection", 1);
});

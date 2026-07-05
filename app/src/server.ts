import "./observability/bootstrap.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { dev } from "astro";
import { Hono } from "hono";
import { type WebSocket, WebSocketServer } from "ws";
import * as Y from "yjs";
import { sendWebResponse } from "./api/server/adapter.ts";
import { apiRouter } from "./api/server/router.ts";
import { auth } from "./auth.ts";
import { config, isTrustProxyEnabled } from "./config.ts";
import { verifyDocumentRole, verifySpaceRole } from "./db/api.ts";
import { subscribeToSyncEvents } from "./db/ws.ts";
import { startCronScheduler, stopCronScheduler } from "./jobs/cronScheduler.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "./noAuth.ts";
import { appLogger } from "./observability/logger.ts";
import {
  createEmbeddedClientAssetMiddleware,
  createFileSystemClientAssetMiddleware,
} from "./utils/clientAssets.ts";
import { APP_CSP } from "./utils/csp.ts";
import {
  isDocumentRealtimeTopic,
  isWorkflowRunRealtimeTopic,
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
import {
  getRoom,
  loadYDoc,
  persistYRoomDraft,
  scheduleYRoomDraftPersist,
  type YRoom,
  yRooms,
} from "./utils/yjsRooms.ts";

type Bindings = {
  incoming: IncomingMessage;
  outgoing: ServerResponse;
};

type AstroMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void | Promise<void>;

function broadcastPresence(
  room: YRoom,
  sender: WebSocket,
  type: WsMsgType,
  payload: object,
) {
  const frame = wsEncode(type, payload);
  for (const client of room.clients) {
    if (client === sender || client.readyState !== 1) {
      continue;
    }
    client.send(frame);
  }
}

const app = new Hono<{ Bindings: Bindings }>();

const realtimeWebSocketServer = new WebSocketServer({ noServer: true });
const getWss = () => realtimeWebSocketServer;

app.use("*", async (c, next) => {
  const res = c.env.outgoing;
  if (!res.headersSent && !res.hasHeader("Content-Security-Policy")) {
    res.setHeader("Content-Security-Policy", APP_CSP);
  }
  await next();
});

// Logging
app.use("*", async (c, next) => {
  const req = c.env.incoming as IncomingMessage & { time?: string };
  const res = c.env.outgoing;
  const startTime = Date.now();
  req.time = new Date(startTime).toString();
  appLogger.info("HTTP request", {
    method: req.method,
    host: c.req.header("host") ?? req.headers.host,
    path: c.req.path,
    time: req.time,
  });

  res.on("finish", () => {
    const durationMs = Date.now() - startTime;
    const attributes = {
      method: req.method,
      host: c.req.header("host") ?? req.headers.host,
      path: c.req.path,
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
      host: c.req.header("host") ?? req.headers.host,
      path: c.req.path,
    });
  });

  await next();
});

const realtimeSpaceTopics = new Set<string>([
  realtimeTopics.acl,
  realtimeTopics.categories,
  realtimeTopics.categoryDocuments,
  realtimeTopics.documentTree,
  realtimeTopics.documents,
  realtimeTopics.properties,
  realtimeTopics.workflowRuns,
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

  // Per-run topics are pure change signals; the run data itself is fetched via
  // the ACL-checked run endpoints. The connection is already space-viewer authed.
  if (isWorkflowRunRealtimeTopic(topic)) {
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
      headers: request.headers as unknown as Headers,
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
  // Rooms this connection may mutate (editor role). Viewers can join to receive
  // state but may not send updates.
  const yjsEditableRooms = new Set<string>();
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
        // Only editors may mutate the room. Viewers receive state on join but
        // their updates are dropped (a read-only client should never produce
        // them anyway).
        if (!yjsEditableRooms.has(roomKey)) return;
        const room = yRooms.get(roomKey);
        if (!room?.doc) return;

        Y.applyUpdate(room.doc, update, websocket);
        scheduleYRoomDraftPersist(roomKey);

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
        // Editors get read+write; viewers may still join to receive state
        // (the room is the single source of truth for rendering). Anyone
        // without view access is rejected.
        let canEdit = false;
        try {
          await verifyDocumentRole(spaceId, documentId, userId, "editor");
          canEdit = true;
        } catch {
          try {
            await verifyDocumentRole(spaceId, documentId, userId, "viewer");
          } catch {
            websocket.send(wsEncode(WsMsgType.Error, { message: "Forbidden" }));
            return;
          }
        }

        const roomKey = `${spaceId}:${documentId}`;
        const room = getRoom(spaceId, documentId);
        if (!room.doc) {
          room.doc = await loadYDoc(spaceId, documentId);
        }

        room.clients.add(websocket);
        yjsRooms.add(roomKey);
        if (canEdit) yjsEditableRooms.add(roomKey);

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
      void persistYRoomDraft(roomKey);
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

function buildHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function requestUrl(req: IncomingMessage): string {
  const socketEncrypted = (req.socket as { encrypted?: boolean })?.encrypted;
  const forwardedProto = isTrustProxyEnabled()
    ? req.headers["x-forwarded-proto"]
    : undefined;
  const proto =
    (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
      ?.split(",")[0]
      ?.trim() || (socketEncrypted ? "https" : "http");
  const host = req.headers.host ?? "localhost";
  return `${proto}://${host}${req.url ?? "/"}`;
}

function createHonoRequest(req: IncomingMessage): Request {
  const method = (req.method ?? "GET").toUpperCase();
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: buildHeaders(req),
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = req as unknown as BodyInit;
    init.duplex = "half";
  }

  return new Request(requestUrl(req), init);
}

function isApiPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/.well-known/caldav" ||
    pathname === "/.well-known/vektor"
  );
}

function shouldRunAstroFallback(
  response: Response,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!astroHandler || response.status !== 404 || res.headersSent || res.writableEnded) {
    return false;
  }
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  return !isApiPath(pathname);
}

async function runAstroHandler(
  handler: AstroMiddleware,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    Promise.resolve(handler(req, res, done)).then(() => {
      if (!settled) resolve();
    }, reject);
  });
}

// Serve the API directly from Hono so it can operate without the Astro
// frontend. The API adapter reads the raw Node request body itself so JSON,
// multipart, binary uploads, and CalDAV requests keep their original bytes.
app.use("*", apiRouter);

// The Astro frontend is optional: set VEKTOR_API_ONLY=1 to run a headless API
// server (no client assets, no Astro dev server, no SSR handler).
const apiOnly = config().API_ONLY === "1" || config().API_ONLY === "true";

let devServer: Awaited<ReturnType<typeof dev>> | undefined;
let astroHandler: AstroMiddleware | undefined;

if (!apiOnly) {
  if (import.meta.env.DEV) {
    app.use("*", createFileSystemClientAssetMiddleware("dist/client"));
  } else {
    const { embeddedClientAssets } = await import("#generated/client-assets.ts");
    app.use("*", createEmbeddedClientAssetMiddleware(embeddedClientAssets));
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
    const { handler } = await import("#dist/server/entry.mjs");
    astroHandler = handler as AstroMiddleware;
  }
} else {
  appLogger.info("Starting in API-only mode (Astro frontend disabled)");
}

const runtimeArgv = globalThis.process?.argv ?? [];
const portArgIndex = runtimeArgv.indexOf("--port");
const portArg =
  portArgIndex >= 0
    ? runtimeArgv[portArgIndex + 1]
    : runtimeArgv.find((arg) => arg.startsWith("--port="))?.slice("--port=".length);
const port = Number.parseInt(portArg ?? "8080", 10);
const host = config().SERVER_HOST ?? "0.0.0.0";
const server = createServer(async (req, res) => {
  try {
    const response = await app.fetch(createHonoRequest(req), {
      incoming: req,
      outgoing: res,
    });

    if (shouldRunAstroFallback(response, req, res)) {
      await runAstroHandler(astroHandler as AstroMiddleware, req, res);
      if (!res.writableEnded) {
        await sendWebResponse(res, new Response(null, { status: 404 }));
      }
      return;
    }

    if (!res.writableEnded) {
      await sendWebResponse(res, response);
    }
  } catch (error) {
    appLogger.error("Unhandled HTTP server error", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent && !res.writableEnded) {
      await sendWebResponse(
        res,
        Response.json({ error: "Internal server error" }, { status: 500 }),
      );
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(port, host, () => {
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

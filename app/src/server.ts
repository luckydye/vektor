import "./observability/bootstrap.ts";
import express from "express";
import expressWebsockets from "express-ws";
import { appLogger } from "./observability/logger.ts";

import { auth } from "./auth.ts";
import { verifyDocumentRole, verifySpaceRole } from "./db/api.ts";
import { publishSyncEvents, subscribeToSyncEvents } from "./db/ws.ts";
import {
  isDocumentRealtimeTopic,
  realtimeTopics,
  type PresenceEnvelope,
  type PresenceJoinPayload,
  type PresenceLeavePayload,
  type PresenceUpdatePayload,
  WsMsgType,
  wsEncode,
  wsEncodeYjsUpdate,
  wsDecode,
  wsDecodeJson,
  wsDecodeYjsUpdate,
} from "./utils/realtime.ts";

import * as Y from "yjs";
import { prosemirrorToYDoc } from "y-prosemirror";
import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { generateJSON } from "@tiptap/html";
import { contentExtensions } from "./editor/extensions.ts";
import { getDocument } from "./db/documents.ts";

import type { dev } from "astro";

interface YRoom {
  doc?: Y.Doc;
  clients: Set<any>;
  presences: Map<string, PresenceEnvelope>;
}

const yRooms = new Map<string, YRoom>();

async function loadYDoc(spaceId: string, documentId: string): Promise<Y.Doc> {
  const dbDoc = await getDocument(spaceId, documentId);
  if (!dbDoc?.content) return new Y.Doc();

  const extensions = contentExtensions(spaceId, documentId);
  const json = generateJSON(dbDoc.content, extensions);
  const schema = getSchema(extensions);
  const pmDoc = Node.fromJSON(schema, json);
  return prosemirrorToYDoc(pmDoc, "default");
}

function getRoom(spaceId: string, documentId: string): YRoom {
  const roomKey = `${spaceId}:${documentId}`;
  let room = yRooms.get(roomKey);
  if (!room) {
    room = {
      clients: new Set(),
      presences: new Map(),
    };
    yRooms.set(roomKey, room);
  }
  return room;
}

function broadcastPresence(room: YRoom, sender: any, type: WsMsgType, payload: object) {
  const frame = wsEncode(type, payload);
  for (const client of room.clients) {
    if (client === sender || client.readyState !== 1) {
      continue;
    }
    client.send(frame);
  }
}

const { app, getWss } = expressWebsockets(express());

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

app.use(express.json({ limit: "100mb" }));
app.post("/sync", (req: any, res: any) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  publishSyncEvents(events);
  res.status(200).end();
});

app.ws("/events/:spaceId", async (websocket: any, request: any) => {
  const spaceId = request.params.spaceId;
  const session = await auth.api.getSession({
    headers: request.headers as any,
  });

  if (!spaceId || !session?.user?.id) {
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

  const subscriptions = new Set<string>();
  const yjsRooms = new Set<string>();
  const joinedPresence = new Map<string, Set<string>>();
  const off = subscribeToSyncEvents((event) => {
    if (event.spaceId !== spaceId) return;

    const matchedEvents = event.events.filter(({ topic }) => subscriptions.has(topic));
    if (matchedEvents.length === 0) return;

    websocket.send(wsEncode(WsMsgType.Event, {
      topics: matchedEvents.map(({ topic }) => topic),
      events: matchedEvents,
      timestamp: event.timestamp,
    }));
  });

  websocket.on("message", async (rawMessage: Buffer) => {
    try {
      const { type, payload } = wsDecode(rawMessage);

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
          await verifyDocumentRole(spaceId, documentId, session.user.id, "editor");
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
          await verifyDocumentRole(spaceId, join.room, session.user.id, "viewer");
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

        websocket.send(wsEncode(WsMsgType.PresenceSnapshot, {
          room: join.room,
          presences: [...room.presences.values()],
        }));
        broadcastPresence(room, websocket, WsMsgType.PresenceUpdate, {
          presence,
        });
        return;
      }

      if (type === WsMsgType.PresenceUpdate) {
        const update = wsDecodeJson<PresenceUpdatePayload>(payload);
        try {
          await verifyDocumentRole(spaceId, update.room, session.user.id, "viewer");
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
        if (await authorizeRealtimeTopic(spaceId, session.user.id, topic)) {
          authorizedTopics.add(topic);
        }
      }

      if (authorizedTopics.size !== topics.length) {
        websocket.send(wsEncode(WsMsgType.Error, { message: "One or more realtime topics are forbidden" }));
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
});

// TODO: we could bundle client asssets into a zip and load them into memory on init,
//  which could be bundled into single executable.
app.use("/", express.static("dist/client/", { maxAge: 3_600_000 }));

let devServer: Awaited<ReturnType<typeof dev>> | undefined;

if (import.meta.env.DEV) {
  const { dev } = await import("astro");

  devServer = await dev({
    root: "./",
    logLevel: "error",
    server: {
      host: true
    }
  });
} else {
  import("../dist/server/entry.mjs").then(({ handler }) => {
    app.use(handler);
  });
}

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const server = app.listen(port, () => {
  appLogger.info("Server listening", { port });
});

let isShuttingDown = false;
let forcedShutdownTimer: ReturnType<typeof setTimeout> | undefined;

async function shutdown(reason: string, exitCode = 0) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  appLogger.info("Shutdown initiated", { reason, exitCode });

  forcedShutdownTimer = setTimeout(() => {
    appLogger.error("Forced shutdown timeout reached", { reason, timeoutMs: 10_000 });
    process.exit(1);
  }, 10_000);
  forcedShutdownTimer.unref();

  if (devServer) {
    await devServer.stop();
  }

  try {
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

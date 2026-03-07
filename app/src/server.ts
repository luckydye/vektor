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
  doc: Y.Doc;
  clients: Set<{ ws: any; documentId: string }>;
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
        if (!room) return;

        Y.applyUpdate(room.doc, update, websocket);

        const frame = wsEncodeYjsUpdate(documentId, update);
        for (const client of room.clients) {
          if (client.ws !== websocket && client.ws.readyState === 1) {
            client.ws.send(frame);
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
        let room = yRooms.get(roomKey);
        if (!room) {
          const doc = await loadYDoc(spaceId, documentId);
          room = { doc, clients: new Set() };
          yRooms.set(roomKey, room);
        }

        room.clients.add({ ws: websocket, documentId });
        yjsRooms.add(roomKey);

        websocket.send(wsEncodeYjsUpdate(documentId, Y.encodeStateAsUpdate(room.doc)));
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
      for (const client of room.clients) {
        if (client.ws === websocket) {
          room.clients.delete(client);
          break;
        }
      }
      if (room.clients.size === 0) {
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

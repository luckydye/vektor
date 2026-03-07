import "./observability/bootstrap.ts";
import express from "express";
import expressWebsockets from "express-ws";
import { appLogger } from "./observability/logger.ts";

import { getDocument } from "./db/documents.ts";
import { auth } from "./auth.ts";
import { verifyDocumentRole, verifySpaceRole } from "./db/api.ts";
import { subscribeToSyncEvents } from "./db/ws.ts";
import {
  isDocumentRealtimeTopic,
  realtimeTopics,
  type RealtimeClientMessage,
  type RealtimeServerMessage,
} from "./utils/realtime.ts";

import { Hocuspocus } from "@hocuspocus/server";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { contentExtensions } from "./editor/extensions.ts";
import { generateJSON } from "@tiptap/html";
import { Canvas } from "./canvas/Canvas.ts";

import type { dev } from "astro";

const hocuspocus = new Hocuspocus({
  async onAuthenticate(data) {
    const headers = data.requestHeaders;
    const documentName = data.documentName;

    // Parse documentName format: "spaceId:documentId"
    const [spaceId, documentId] = documentName.split(":");

    if (!spaceId || !documentId) {
      throw new Error("Invalid document name format. Expected 'spaceId:documentId'");
    }

    // Get user session from request headers
    const session = await auth.api.getSession({
      headers: headers as any,
    });

    if (!session?.user) {
      throw new Error("Unauthorized: No valid session found");
    }

    // Return user data for connection context
    return {
      userId: session.user.id,
      spaceId,
      documentId,
    };
  },

  async onLoadDocument(data) {
    const { context } = data;
    const { spaceId, userId, documentId } = context;

    // Verify user has at least editor access to the document
    try {
      await verifyDocumentRole(spaceId, documentId, userId, "editor");
    } catch (error) {
      if (error instanceof Response) {
        const errorData = await error.json();
        throw new Error(`Forbidden: ${errorData.error || "Access denied"}`);
      }
      throw new Error("Failed to verify document access");
    }

    const doc = await getDocument(spaceId, documentId);

    if (doc?.type === "canvas") {
      return Canvas.fromString(doc.content || "").doc;
    } else {
      const extensions = contentExtensions(spaceId, documentId);

      const json = generateJSON(doc?.content || "", extensions);
      const ydoc = TiptapTransformer.toYdoc(
        // the actual JSON
        json,
        // the `field` you’re using in Tiptap. If you don’t know what that is, use 'default'.
        "default",
        // The Tiptap extensions you’re using. Those are important to create a valid schema.
        extensions,
      );

      return ydoc;
    }
  },
});

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

function sendRealtimeMessage(
  websocket: { send: (payload: string) => void },
  message: RealtimeServerMessage,
) {
  websocket.send(JSON.stringify(message));
}

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

app.ws("/collaboration", (websocket: any, request: any) => {
  const context = {};
  hocuspocus.handleConnection(websocket, request, context);
});

app.use(express.json({ limit: "100mb" }));
app.ws("/events/:spaceId", async (websocket: any, request: any) => {
  const spaceId = request.params.spaceId;
  const session = await auth.api.getSession({
    headers: request.headers as any,
  });

  if (!spaceId || !session?.user?.id) {
    sendRealtimeMessage(websocket, {
      type: "error",
      message: "Unauthorized",
    });
    websocket.close();
    return;
  }

  try {
    await verifySpaceRole(spaceId, session.user.id, "viewer");
  } catch {
    sendRealtimeMessage(websocket, {
      type: "error",
      message: "Forbidden",
    });
    websocket.close();
    return;
  }

  const subscriptions = new Set<string>();
  const off = subscribeToSyncEvents((event) => {
    if (event.spaceId !== spaceId) {
      return;
    }

    const topics = event.topics.filter((topic) => subscriptions.has(topic));
    if (topics.length === 0) {
      return;
    }

    sendRealtimeMessage(websocket, {
      type: "event",
      topics,
      timestamp: event.timestamp,
    });
  });

  websocket.on("message", async (rawMessage: unknown) => {
    try {
      const message = JSON.parse(String(rawMessage)) as RealtimeClientMessage;
      if (message.type !== "subscribe" && message.type !== "unsubscribe") {
        throw new Error("Unsupported realtime message");
      }

      const authorizedTopics = new Set<string>();
      for (const topic of message.topics) {
        if (await authorizeRealtimeTopic(spaceId, session.user.id, topic)) {
          authorizedTopics.add(topic);
        }
      }

      if (authorizedTopics.size !== message.topics.length) {
        sendRealtimeMessage(websocket, {
          type: "error",
          message: "One or more realtime topics are forbidden",
        });
      }

      if (message.type === "subscribe") {
        for (const topic of authorizedTopics) {
          subscriptions.add(topic);
        }
        return;
      }

      for (const topic of authorizedTopics) {
        subscriptions.delete(topic);
      }
    } catch (error) {
      appLogger.warn("Failed to handle realtime message", { error, spaceId });
      sendRealtimeMessage(websocket, {
        type: "error",
        message: "Invalid realtime message",
      });
    }
  });

  websocket.on("close", () => {
    off();
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

    hocuspocus.closeConnections();

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

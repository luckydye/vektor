import "./observability/bootstrap.ts";
import express from "express";
import expressWebsockets from "express-ws";
import { appLogger } from "./observability/logger.ts";

import { getDocument } from "./db/documents.ts";
import { auth } from "./auth.ts";
import { verifyDocumentRole } from "./db/api.ts";

import { Hocuspocus } from "@hocuspocus/server";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { contentExtensions } from "./editor/extensions.ts";
import { generateJSON } from "@tiptap/html";
import { Canvas } from "./canvas/Canvas.ts";

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
app.use((req, res, next) => {
  req.time = new Date(Date.now()).toString();
  appLogger.info("HTTP request", {
    method: req.method,
    host: req.hostname,
    path: req.path,
    time: req.time,
  });
  next();
});

const connections = new Map<string, Set<any>>();

function sync(onSyncEvent: (ev: any) => () => void) {
  return (ws, request) => {
    const spaceId = request.params.space;

    if (!connections.has(spaceId)) {
      connections.set(spaceId, new Set());
    }

    const spaceConnections = connections.get(spaceId);
    if (!spaceConnections) {
      throw new Error("Space connections dont exist");
    }

    spaceConnections.add(ws);

    ws.on("message", (msg) => {
      ws.send(msg);
    });

    const off = onSyncEvent((ev) => {
      ws.send(JSON.stringify({ scope: ev }));
    });

    ws.on("close", () => {
      off();
      spaceConnections.delete(ws);
      appLogger.info("WebSocket connection closed", { spaceId });
    });
  };
}

app.ws("/collaboration", (websocket, request) => {
  const context = {};
  hocuspocus.handleConnection(websocket, request, context);
});

const syncCallbacks = new Set();
const syncCallback = (callback) => {
  syncCallbacks.add(callback);
  return () => {
    syncCallbacks.delete(callback);
  };
};

app.use(express.json({ limit: "100mb" }));
app.post("/sync", async (req, res, next) => {
  const scopes = Array.isArray(req.body) ? req.body : [req.body];
  for (const scope of scopes) {
    for (const callback of syncCallbacks) {
      callback(scope);
    }
  }
  res.status(200).end();
});

app.ws("/sync/:space", sync(syncCallback));

// TODO: we could bundle client asssets into a zip and load them into memory on init,
//  which could be bundled into single executable.
app.use("/", express.static("dist/client/", { maxAge: 3_600_000 }));

import("../dist/server/entry.mjs").then(({ handler }) => {
  app.use(handler);
});

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

  try {
    getWss().clients.forEach((client) => {
      try {
        client.close();
      } catch (error) {
        appLogger.warn("Failed to close WebSocket client", { error });
      }
    });

    await hocuspocus.destroy();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
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

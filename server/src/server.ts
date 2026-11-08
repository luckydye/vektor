import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Hono } from "hono";
import { createEmbeddedClientAssetMiddleware } from "#platform/bun/clientAssets.ts";
import { createBunPlatform } from "#platform/bun/index.ts";
import { attachNodeWebSocketServer } from "#platform/bun/nodeServer.ts";
import { attachRealtimeWebSocketServer } from "#platform/bun/realtimeServer.ts";
import { stopSerializationPool } from "#platform/bun/serializationPool.ts";
import type { Platform } from "#platform/platform.ts";
import { stopAgentWorker } from "./agent/agent.ts";
import { apiRoutes } from "./api/routes.ts";
import { sendWebResponse } from "./api/server/response.ts";
import { createApiRouter, isApiPath } from "./api/server/router.ts";
import type { ApiBindings } from "./api/server/types.ts";
import { config, isTrustProxyEnabled } from "./config.ts";
import { listActiveSpaceIds } from "./db/auth/spaceIndex.ts";
import { initializeDatabases } from "./db/client/db.ts";
import { openSpaceStore } from "./db/client/store.ts";
import { failInterruptedAIChatTurns } from "./db/space/aiChatSessions.ts";
import { migrateCanvases } from "./db/space/canvasMigration.ts";
import { purgeExpiredSpaces } from "./db/space/spaces.ts";
import { startDiscordBots, stopDiscordBots } from "./integrations/discordBot.ts";
import { isEmailDeliveryAvailable } from "./notifications/email.ts";
import { appLogger } from "./observability/logger.ts";
import {
  METRICS_CONTENT_TYPE,
  recordHttpRequest,
  renderPrometheusMetrics,
  startMetricsMonitor,
} from "./observability/metrics.ts";
import { flushAllCanvasRooms, startCanvasRoomSweep } from "./realtime/canvasRooms.ts";
import { startYRoomSweep } from "./realtime/yjsRooms.ts";
import { APP_CSP } from "./utils/csp.ts";
import { every } from "./utils/every.ts";
import type { DevWeb } from "./web/dev.ts";
import { createWebRuntime } from "./web/runtime.ts";
import { registerWebRoutes } from "./web/routes.ts";

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
  const siteUrl = config().SITE_URL;
  if (siteUrl) {
    try {
      return `${new URL(siteUrl).origin}${req.url ?? "/"}`;
    } catch {
      // Fall through to the request-derived origin for invalid configuration.
    }
  }

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

/**
 * Where Vite serves source modules from in development. Checked ahead of the API
 * test because a repository URL is `/<space>/git/...`, which `/src/git/graph.ts`
 * would otherwise be taken for.
 */
const VITE_MODULE_PATH = /^\/(?:src|node_modules|@id|@fs|@vite)\//;

/**
 * How often deleted spaces past their retention window are reclaimed. A space
 * that waited 30 days can wait another hour.
 */
const SPACE_RETENTION_SWEEP_MS = 60 * 60 * 1000;

function purgeExpiredSpacesLogged(platform: Platform): void {
  void purgeExpiredSpaces(platform, new Date()).then(
    (purged) => {
      if (purged.length > 0) {
        appLogger.info("Reclaimed deleted spaces", { spaces: purged.length });
      }
    },
    (error) => appLogger.error("Space retention sweep failed", { error }),
  );
}

/** Log `req` now and its response once it finishes or the client drops it. */
function logRequest(req: IncomingMessage, res: ServerResponse): void {
  const startTime = Date.now();
  const request = {
    method: req.method,
    host: req.headers.host,
    path: new URL(req.url ?? "/", "http://localhost").pathname,
  };
  recordHttpRequest();
  appLogger.info("HTTP request", { ...request, time: new Date(startTime).toString() });

  res.on("finish", () => {
    const attributes = {
      ...request,
      statusCode: res.statusCode,
      durationMs: Date.now() - startTime,
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
    if (res.writableEnded) return;
    appLogger.warn("HTTP connection closed before response completed", request);
  });
}

// A client that disconnects mid-response (e.g. navigating away while the SSR
// stream is still being written) surfaces as an `aborted` / `ECONNRESET` error
// on the Node request socket, which can reach the process as an unhandled
// rejection. It is a benign network condition, not a server
// bug, so it must NOT take the whole process (and every live WebSocket) down.
// Genuine errors still crash so we notice real issues.
function isBenignConnectionError(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) {
    return false;
  }
  const code = (reason as { code?: unknown }).code;
  const message = (reason as { message?: unknown }).message;
  return (
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "EPIPE" ||
    message === "aborted"
  );
}

/**
 * Serve the API, the frontend and the realtime endpoint on `platform`, which
 * everything below that touches a database, a blob or a timer is handed.
 */
export async function startServer(platform: Platform): Promise<void> {
  // Not strict: `/docs/` and `/login/` are the pages, not a space slug.
  const app = new Hono<ApiBindings>({ strict: false });

  // Database schema preparation and local-file reconciliation must complete
  // before requests or background workers can observe the space index.
  await initializeDatabases(platform);

  // Agent turns live in process memory, so one a previous process left running
  // has no agent behind it. Before listening: afterwards a turn may be live.
  for (const spaceId of await listActiveSpaceIds(platform)) {
    await failInterruptedAIChatTurns(await openSpaceStore(platform, spaceId));
  }

  // Before listening: no canvas is served from its JSON snapshot any more.
  await migrateCanvases(platform);

  // From source the route files may have changed since the last build, so the
  // OpenAPI document is regenerated; a compiled binary has no `scripts/` and embeds it.
  const generateOpenApiScript = join(import.meta.dir, "../scripts/generate-openapi.ts");
  if (existsSync(generateOpenApiScript)) {
    // A computed specifier, so `bun build --compile` leaves the doc tooling out.
    const { generateOpenApiModule } = await import(generateOpenApiScript);
    await generateOpenApiModule();
  }

  // Operational metrics in Prometheus exposition format. Kept outside the API
  // router so it is reachable even in API-only deployments and without auth.
  app.get("/metrics", async (c) =>
    c.body(await renderPrometheusMetrics(platform), 200, {
      "Content-Type": METRICS_CONTENT_TYPE,
    }),
  );

  // Serve the API directly from Hono so it can operate without the web
  // frontend. Hono retains ownership of request bodies for JSON, multipart,
  // and binary uploads.
  app.use(
    "*",
    createApiRouter(
      platform,
      platform.git ? [...apiRoutes, ...platform.git.routes] : apiRoutes,
    ),
  );

  // The web frontend is optional: set VEKTOR_API_ONLY=1 to run a headless API
  // server (no client assets, no page rendering).
  const apiOnly = config().API_ONLY === "1" || config().API_ONLY === "true";

  let devWeb: DevWeb | undefined;

  if (!apiOnly) {
    if (import.meta.env.DEV) {
      // Vite serves the browser modules and public files itself, ahead of Hono.
      const { startDevWeb } = await import("./web/dev.ts");
      devWeb = await startDevWeb();
      registerWebRoutes(app, createWebRuntime(devWeb.source));
    } else {
      const { embeddedClientAssets } = await import("#generated/client-assets.ts");
      app.use("*", createEmbeddedClientAssetMiddleware(embeddedClientAssets));
      const { createProductionSource } = await import("./web/production.ts");
      registerWebRoutes(app, createWebRuntime(await createProductionSource()));
    }
  } else {
    appLogger.info("Starting in API-only mode (web frontend disabled)");
  }

  const runtimeArgv = globalThis.process?.argv ?? [];
  const portArgIndex = runtimeArgv.indexOf("--port");
  const portArg =
    portArgIndex >= 0
      ? runtimeArgv[portArgIndex + 1]
      : runtimeArgv.find((arg) => arg.startsWith("--port="))?.slice("--port=".length);
  const port = Number.parseInt(portArg ?? "8080", 10);
  const host = config().SERVER_HOST ?? "0.0.0.0";
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Security-Policy", APP_CSP);
    logRequest(req, res);
    try {
      const response = await app.fetch(createHonoRequest(req), {
        clientAddress: req.socket.remoteAddress ?? null,
      });

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
  };
  const server = createServer((req, res) => {
    // A malformed request target must not throw out of this callback: it is
    // outside any handler, so it would take the whole process down.
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      void handleRequest(req, res);
      return;
    }
    if (!devWeb || (isApiPath(pathname) && !VITE_MODULE_PATH.test(pathname))) {
      void handleRequest(req, res);
      return;
    }
    // Vite answers its own module and public-file requests, and passes
    // everything else on. The API never goes through it: its CORS handling
    // would answer API preflights.
    devWeb.middleware(req, res, (error?: unknown) => {
      if (error) {
        appLogger.error("Dev server middleware failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.statusCode = 500;
        res.end();
        return;
      }
      void handleRequest(req, res);
    });
  });

  const realtimeWebSocketServer = attachRealtimeWebSocketServer(platform, server);
  const nodeWebSocketServer = attachNodeWebSocketServer(platform, server);

  server.listen(port, host, () => {
    appLogger.info("Server listening", { host, port });
  });

  // Each space's pass arms its own next wake from what it finds due.
  for (const spaceId of await listActiveSpaceIds(platform)) {
    platform.spaceHost.at(spaceId, new Date());
  }
  if (!isEmailDeliveryAvailable(platform)) {
    appLogger.warn(
      "Email notification delivery is disabled; configure VEKTOR_EMAIL_FROM and VEKTOR_SMTP_HOST",
    );
  }
  startDiscordBots(platform);
  const stopMetricsMonitor = startMetricsMonitor();
  const stopYRoomSweep = startYRoomSweep();
  const stopCanvasRoomSweep = startCanvasRoomSweep(platform);
  purgeExpiredSpacesLogged(platform);
  const stopRetentionSweep = every(SPACE_RETENTION_SWEEP_MS, () =>
    purgeExpiredSpacesLogged(platform),
  );

  let isShuttingDown = false;
  let forcedShutdownTimer: ReturnType<typeof setTimeout> | undefined;

  async function shutdown(reason: string, exitCode = 0) {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    appLogger.info("Shutdown initiated", { reason, exitCode });

    stopMetricsMonitor();
    stopYRoomSweep();
    stopCanvasRoomSweep();
    stopRetentionSweep();
    stopDiscordBots();
    stopSerializationPool();
    stopAgentWorker(platform);

    forcedShutdownTimer = setTimeout(() => {
      appLogger.error("Forced shutdown timeout reached", { reason, timeoutMs: 10_000 });
      process.exit(1);
    }, 10_000);
    forcedShutdownTimer.unref();

    if (devWeb) {
      await devWeb.stop();
    }

    try {
      realtimeWebSocketServer.close();
      nodeWebSocketServer.close();
      // Clients see records before they are durable; a graceful stop keeps them.
      await flushAllCanvasRooms(platform);

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
      await appLogger.flush();
      process.exit(exitCode);
    } catch (error) {
      appLogger.error("Shutdown failed", { reason, error });
      await appLogger.flush();
      process.exit(1);
    }
  }

  process.once("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });

  process.on("uncaughtException", (error) => {
    if (isBenignConnectionError(error)) {
      appLogger.warn("Ignoring benign connection error (uncaughtException)", { error });
      return;
    }
    appLogger.error("Uncaught exception", { error });
    void shutdown("uncaughtException", 1);
  });

  process.on("unhandledRejection", (reason) => {
    if (isBenignConnectionError(reason)) {
      appLogger.warn("Ignoring benign connection error (unhandledRejection)", { reason });
      return;
    }
    appLogger.error("Unhandled rejection", { reason });
    void shutdown("unhandledRejection", 1);
  });
}

if (import.meta.main) {
  await startServer(createBunPlatform());
}

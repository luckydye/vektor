import "./observability/bootstrap.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { dev } from "astro";
import { Hono } from "hono";
import { sendWebResponse } from "./api/server/response.ts";
import { apiRouter } from "./api/server/router.ts";
import type { ApiBindings } from "./api/server/types.ts";
import { config, isTrustProxyEnabled } from "./config.ts";
import { startCronScheduler, stopCronScheduler } from "./jobs/cronScheduler.ts";
import {
  startEmailNotificationWorker,
  stopEmailNotificationWorker,
} from "./notifications/worker.ts";
import { appLogger } from "./observability/logger.ts";
import { attachRealtimeWebSocketServer } from "./realtime/websocket.ts";
import {
  createEmbeddedClientAssetMiddleware,
  createFileSystemClientAssetMiddleware,
} from "./utils/clientAssets.ts";
import { APP_CSP } from "./utils/csp.ts";

type AstroMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void | Promise<void>;

const app = new Hono<ApiBindings>();

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
// frontend. Hono retains ownership of request bodies for JSON, multipart,
// binary uploads, and CalDAV requests.
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

const realtimeWebSocketServer = attachRealtimeWebSocketServer(server);

server.listen(port, host, () => {
  appLogger.info("Server listening", { host, port });
});

startCronScheduler();
startEmailNotificationWorker();

let isShuttingDown = false;
let forcedShutdownTimer: ReturnType<typeof setTimeout> | undefined;

async function shutdown(reason: string, exitCode = 0) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  appLogger.info("Shutdown initiated", { reason, exitCode });

  stopCronScheduler();
  stopEmailNotificationWorker();

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

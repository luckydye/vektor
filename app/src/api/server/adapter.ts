import type { IncomingMessage, ServerResponse } from "node:http";
import { auth } from "#auth";
import { config, getPublicEnv, isTrustProxyEnabled } from "../../config.ts";
import { isNoAuthMode, LOCAL_SESSION, LOCAL_USER } from "../../noAuth.ts";
import type { ApiContext } from "./types.ts";

/**
 * Hard cap on buffered request bodies. The whole body is read into memory
 * before the handler runs, so an unbounded read is a trivial memory-exhaustion
 * DoS. Default leaves headroom for the largest legitimate payload (250MB
 * user uploads); override via WIKI_MAX_REQUEST_BYTES.
 */
function maxRequestBytes(): number {
  const raw = Number.parseInt(config().MAX_REQUEST_BYTES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 256 * 1024 * 1024;
}

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "PayloadTooLargeError";
  }
}

/** Read the raw request body for methods that may carry one. */
function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return Promise.resolve(undefined);
  }

  const limit = maxRequestBytes();

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) {
        req.destroy();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      resolve(body.length > 0 ? body : undefined);
    });
    req.on("error", reject);
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

/** Canonical public origin (proto + host) from WIKI_SITE_URL, when configured. */
function configuredOrigin(): string | null {
  const siteUrl = config().SITE_URL;
  if (!siteUrl) return null;
  try {
    return new URL(siteUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Best-effort client IP. Without a trusted proxy this is always the socket
 * address — a spoofed `X-Forwarded-For` must not let clients pick their own
 * identity (e.g. to rotate rate-limit buckets).
 */
function clientIp(req: IncomingMessage): string {
  const socketIp = req.socket?.remoteAddress ?? "";
  if (!isTrustProxyEnabled()) return socketIp;
  const forwardedFor = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwardedFor)
    ? forwardedFor[forwardedFor.length - 1]
    : forwardedFor;
  // Rightmost entry is the one appended by our own (trusted) proxy hop.
  const last = raw?.split(",").pop()?.trim();
  return last || socketIp;
}

function requestUrl(req: IncomingMessage): string {
  // Prefer the configured canonical origin: the Host header (and, without a
  // trusted proxy, X-Forwarded-Proto) is attacker-controlled and must not
  // poison absolute URLs derived from the request (OAuth callbacks, links).
  const origin = configuredOrigin();
  if (origin) {
    return `${origin}${req.url ?? "/"}`;
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

/**
 * Build a Web `Request` and an `ApiContext` from an incoming Node request,
 * populating `locals` the same way the Astro middleware did.
 */
export async function buildApiContext(
  req: IncomingMessage,
  params: Record<string, string | undefined>,
): Promise<ApiContext> {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  req.on("aborted", abort);

  const body = await readRequestBody(req);
  const url = requestUrl(req);
  const headers = buildHeaders(req);
  // Pin the client identity: better-auth keys its rate limiter on
  // x-forwarded-for, which clients can spoof to rotate buckets. Overwrite it
  // with the socket address (or the trusted proxy hop, see clientIp).
  const ip = clientIp(req);
  if (ip) {
    headers.set("x-forwarded-for", ip);
  } else {
    headers.delete("x-forwarded-for");
  }
  const request = new Request(url, {
    method: req.method,
    headers,
    body,
    signal: controller.signal,
  });

  const locals: App.Locals = {
    user: null,
    session: null,
    publicEnv: getPublicEnv(),
  };

  if (isNoAuthMode()) {
    locals.user = LOCAL_USER as App.Locals["user"];
    locals.session = LOCAL_SESSION as App.Locals["session"];
  } else {
    const authed = await auth.api.getSession({ headers: request.headers });
    if (authed) {
      locals.user = authed.user;
      locals.session = authed.session;
    }
  }

  return {
    request,
    params,
    url: new URL(url),
    locals,
  };
}

/** Write a Web `Response` produced by a route handler to the Node response. */
export async function sendWebResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  if (res.headersSent) return;

  const setCookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  if (setCookies.length > 0) {
    res.setHeader("set-cookie", setCookies);
  }

  res.statusCode = response.status;

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  const onClose = () => reader.cancel().catch(() => {});
  res.on("close", onClose);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const ok = res.write(Buffer.from(value));
        if (!ok) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    }
  } finally {
    res.off("close", onClose);
    res.end();
  }
}

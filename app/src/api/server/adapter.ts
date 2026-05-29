import type { IncomingMessage, ServerResponse } from "node:http";
import { auth } from "#auth";
import { isNoAuthMode, LOCAL_USER, LOCAL_SESSION } from "../../noAuth.ts";
import type { ApiContext } from "./types.ts";

const PUBLIC_ENV_KEYS = [
  "WIKI_FEATURE_CANVAS",
  "WIKI_SITE_URL",
  "WIKI_API_URL",
  "WIKI_COLLABORATION_HOST",
  "WIKI_DEFAULT_SPACE",
  "OAUTH_PROVIDER_ID",
  "VEKTOR_NO_AUTH",
] as const;

function buildPublicEnv(): App.PublicEnv {
  const env: Record<string, string | undefined> = {};
  for (const key of PUBLIC_ENV_KEYS) {
    env[key] = process.env[key];
  }
  return env as App.PublicEnv;
}

/** Read the raw request body for methods that may carry one. */
function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
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

function requestUrl(req: IncomingMessage): string {
  const socketEncrypted = (req.socket as { encrypted?: boolean })?.encrypted;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto =
    (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(",")[0]?.trim() ||
    (socketEncrypted ? "https" : "http");
  const host = req.headers.host ?? "localhost";
  return `${proto}://${host}${req.url ?? "/"}`;
}

/**
 * Build a Web `Request` and an `ApiContext` from an incoming Express request,
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
  req.on("close", abort);

  const body = await readRequestBody(req);
  const url = requestUrl(req);
  const request = new Request(url, {
    method: req.method,
    headers: buildHeaders(req),
    body,
    signal: controller.signal,
  });

  const locals: App.Locals = {
    user: null,
    session: null,
    publicEnv: buildPublicEnv(),
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

/** Write a Web `Response` produced by a route handler to the Express response. */
export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
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

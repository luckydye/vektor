import type { MiddlewareHandler } from "hono";

export type EmbeddedClientAssets = Map<string, string>;

/** Files under `/assets/` are named by content hash, so they never change. */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

async function fileResponse(
  filePath: string,
  method: string,
  cacheControl = "public, max-age=3600",
): Promise<Response> {
  const file = Bun.file(filePath);
  const headers = new Headers({
    "Cache-Control": cacheControl,
    "Content-Type": file.type || "application/octet-stream",
  });

  if (method === "HEAD") {
    headers.set("Content-Length", String(file.size));
    return new Response(null, { status: 200, headers });
  }

  return new Response(file, { status: 200, headers });
}

export function createEmbeddedClientAssetMiddleware(
  embeddedClientAssets: EmbeddedClientAssets,
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await next();
      return;
    }

    const assetPath = embeddedClientAssets.get(c.req.path);
    if (!assetPath) {
      await next();
      return;
    }

    return fileResponse(
      assetPath,
      c.req.method,
      c.req.path.startsWith("/assets/") ? IMMUTABLE_CACHE_CONTROL : undefined,
    );
  };
}

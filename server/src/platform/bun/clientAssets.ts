import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";

export type EmbeddedClientAssets = Map<string, string>;

function requestPathToFile(root: string, requestPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  if (decodedPath.includes("\0")) {
    return null;
  }

  const rootPath = resolve(root);
  const filePath = resolve(
    rootPath,
    `.${decodedPath === "/" ? "/index.html" : decodedPath}`,
  );
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${sep}`)) {
    return null;
  }
  return filePath;
}

async function existingFilePath(filePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      return filePath;
    }
    if (fileStat.isDirectory()) {
      const indexPath = resolve(filePath, "index.html");
      const indexStat = await stat(indexPath);
      return indexStat.isFile() ? indexPath : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function fileResponse(filePath: string, method: string): Promise<Response> {
  const file = Bun.file(filePath);
  const headers = new Headers({
    "Cache-Control": "public, max-age=3600",
    "Content-Type": file.type || "application/octet-stream",
  });

  if (method === "HEAD") {
    headers.set("Content-Length", String(file.size));
    return new Response(null, { status: 200, headers });
  }

  return new Response(file, { status: 200, headers });
}

export function createFileSystemClientAssetMiddleware(root: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await next();
      return;
    }

    const filePath = requestPathToFile(root, c.req.path);
    const assetPath = filePath ? await existingFilePath(filePath) : null;
    if (!assetPath) {
      await next();
      return;
    }

    return fileResponse(assetPath, c.req.method);
  };
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

    return fileResponse(assetPath, c.req.method);
  };
}

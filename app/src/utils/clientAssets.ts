import type { NextFunction, Request, Response } from "express";

export type EmbeddedClientAssets = Map<string, string>;

export function createEmbeddedClientAssetMiddleware(
  embeddedClientAssets: EmbeddedClientAssets,
) {
  return async function embeddedClientAssetMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    const assetPath = embeddedClientAssets.get(req.path);
    if (!assetPath) {
      next();
      return;
    }

    const file = Bun.file(assetPath);
    res.status(200);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Type", file.type || "application/octet-stream");

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const body = Buffer.from(await file.arrayBuffer());
    res.setHeader("Content-Length", String(body.byteLength));
    res.end(body);
  };
}

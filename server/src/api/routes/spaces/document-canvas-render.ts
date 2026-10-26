import { Permission } from "#acl/permissions.ts";
import { badRequestResponse, notFoundResponse, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { canvasRequest } from "#api/routes/spaces/document-canvas.ts";
import { describeCanvas } from "#canvas/agent/format.ts";
import { sceneShapes, sceneStrokes } from "#canvas/agent/model.ts";
import { encodePng } from "#canvas/raster/rasterizer.ts";
import { renderScene } from "#canvas/raster/scene.ts";
import { serverFonts } from "#canvas/raster/text.ts";

const MAX_SIDE = 2000;

/**
 * Render a canvas region as PNG
 *
 * Draws a frame (`frame=<id>`), a world region (`x, y, w, h`), or everything,
 * at `scale` (fitted to 1600×1200 when omitted). `ids=true` tags each element
 * with its id.
 *
 * @tag Documents
 * @jobToken
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { snapshot } = await canvasRequest(context, Permission.VIEWER);
    const query = new URL(context.req.url).searchParams;
    const faces = await serverFonts();
    const shapes = sceneShapes(snapshot, faces);
    const number = (key: string) => {
      const value = query.get(key);
      if (value === null) return undefined;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw badRequestResponse(`${key} must be a number`);
      return parsed;
    };
    let region: { x: number; y: number; width: number; height: number };
    const frameId = query.get("frame");
    if (frameId) {
      const frame = shapes.find((shape) => shape.id === frameId);
      if (!frame) throw notFoundResponse(`Element ${frameId}`);
      region = { x: frame.frame.x, y: frame.frame.y, width: frame.frame.width, height: frame.frame.height };
    } else if (number("w") !== undefined) {
      region = { x: number("x") ?? 0, y: number("y") ?? 0, width: number("w") ?? 0, height: number("h") ?? 0 };
    } else {
      const bounds = describeCanvas(snapshot, faces).bounds ?? { x: 0, y: 0, w: 800, h: 600 };
      // Room above for frame titles, which sit outside their frame.
      region = { x: bounds.x - 40, y: bounds.y - 60, width: bounds.w + 80, height: bounds.h + 100 };
    }
    if (region.width <= 0 || region.height <= 0) throw badRequestResponse("The region is empty");
    const scale = Math.min(
      number("scale") ?? Math.min(1, 1600 / region.width, 1200 / region.height),
      MAX_SIDE / region.width,
      MAX_SIDE / region.height,
    );
    const raster = await renderScene({
      shapes,
      strokes: sceneStrokes(snapshot),
      region,
      scale,
      ids: query.get("ids") === "true",
    });
    const png = encodePng(raster);
    return new Response(png as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.byteLength),
        "X-Canvas-Scale": String(Math.round(scale * 1000) / 1000),
        "X-Canvas-Region": `${Math.round(region.x)},${Math.round(region.y)},${Math.round(region.width)},${Math.round(region.height)}`,
      },
    });
  }, "Failed to render canvas");

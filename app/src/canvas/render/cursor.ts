const CURSOR_PATH =
  "M5.1 4.8a1.2 1.2 0 0 1 1.53-1.54l20.4 8.28a1.2 1.2 0 0 1-.14 2.26l-7.81 2.01a2.4 2.4 0 0 0-1.72 1.72l-2.01 7.81a1.2 1.2 0 0 1-2.26.14z";

const cache = new Map<string, string>();

/**
 * A `cursor` value drawing the collaborator pointer in a given colour.
 *
 * Rasterised to a data URL because CSS cannot tint a cursor image, and cached
 * by colour: this runs on every pointer colour change, and re-rasterising per
 * frame during a drag is visible.
 *
 * Extracted from `Canvas.vue` (plan section 6). The cache lives with the
 * function rather than in the component, so it survives a host swap.
 */
export function makeCanvasCursor(color: string): string {
  if (typeof document === "undefined") return "default";

  const cached = cache.get(color);
  if (cached) return cached;

  const size = 18;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return "default";
  context.scale(0.56, 0.56);

  const path = new Path2D(CURSOR_PATH);

  context.shadowColor = "rgba(15, 23, 42, 0.25)";
  context.shadowBlur = 2;
  context.shadowOffsetY = 1;
  context.fillStyle = color;
  context.fill(path);
  context.shadowColor = "transparent";
  context.lineWidth = 1.8;
  context.strokeStyle = "white";
  context.lineJoin = "round";
  context.stroke(path);

  const result = `url("${canvas.toDataURL()}") 3 3, default`;
  cache.set(color, result);
  return result;
}

/**
 * Generates a CSS cursor string for the brush mask tool.
 *
 * The cursor is a circle rendered onto an offscreen canvas and returned as
 * a data-URL hotspot cursor:
 *   url("data:image/png;base64,...") <hotX> <hotY>, none
 *
 * Usage:
 *   const cursor = makeBrushCursor(brushRadius, screenPixelsPerImagePixel);
 *   element.style.cursor = cursor;
 *
 * The CSS cursor spec caps usable bitmap sizes at 128×128 on most platforms,
 * so the rendered size is clamped accordingly.
 */
export function makeBrushCursor(brushRadius: number, screenScale: number): string {
  const MAX_CURSOR = 128;
  const screenDiameter = brushRadius * 2 * screenScale;
  // +4 gives room for the stroke to not clip at the edge, but total must stay within MAX_CURSOR
  const size = Math.min(MAX_CURSOR, Math.max(6, Math.round(screenDiameter) + 4));
  const hotspot = Math.floor(size / 2);
  const r = Math.max(2, size / 2 - 2);

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "none";

  // Outer dark ring (improves visibility on bright backgrounds)
  ctx.beginPath();
  ctx.arc(hotspot, hotspot, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
  ctx.lineWidth = 3;
  ctx.stroke();

  // Inner white ring
  ctx.beginPath();
  ctx.arc(hotspot, hotspot, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Centre dot
  ctx.beginPath();
  ctx.arc(hotspot, hotspot, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fill();

  return `url("${canvas.toDataURL()}") ${hotspot} ${hotspot}, none`;
}

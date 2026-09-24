/**
 * Painting for the alignment guides `core/snapping.ts` computes.
 *
 * Split from the maths so `core/` never touches a rendering context: the same
 * guides are consumed by hit-feedback and by the ink overlay, and only the
 * latter needs a canvas.
 */
import type { ScreenSize, SnapGuide, WorldTransform } from "#canvas/runtime/geometry.ts";

interface DrawSnapGuideOptions {
  color?: string;
  lineWidth?: number;
  dash?: number[];
}

export function drawSnapGuides(
  ctx: CanvasRenderingContext2D,
  guides: readonly SnapGuide[],
  transform: WorldTransform,
  screen: ScreenSize,
  options: DrawSnapGuideOptions = {},
): void {
  if (guides.length === 0) return;

  ctx.save();
  ctx.strokeStyle = options.color ?? "rgba(96, 165, 250, 0.8)";
  ctx.lineWidth = options.lineWidth ?? 1;
  ctx.setLineDash(options.dash ?? [4, 4]);

  for (const guide of guides) {
    ctx.beginPath();
    if (guide.axis === "x") {
      const x = guide.value * transform.scale + transform.dx;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, screen.height);
    } else {
      const y = guide.value * transform.scale + transform.dy;
      ctx.moveTo(0, y);
      ctx.lineTo(screen.width, y);
    }
    ctx.stroke();
  }

  ctx.restore();
}

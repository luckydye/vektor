/** Painting for the alignment guides `runtime/geometry.ts` computes. */
import { drawLine } from "#canvas/render/primitives.ts";
import { type CanvasGpu, parseColor } from "#canvas/render/webgl.ts";
import type { SnapGuide } from "#canvas/runtime/geometry.ts";

export function drawSnapGuides(
  gpu: CanvasGpu,
  guides: readonly SnapGuide[],
  color: string,
) {
  const { transform, screen } = gpu.view;
  const rgba = parseColor(color);
  for (const guide of guides) {
    if (guide.axis === "x") {
      const x = guide.value * transform.scale + transform.dx;
      drawLine(gpu, { x, y: 0 }, { x, y: screen.height }, { color: rgba, dash: 4 });
    } else {
      const y = guide.value * transform.scale + transform.dy;
      drawLine(gpu, { x: 0, y }, { x: screen.width, y }, { color: rgba, dash: 4 });
    }
  }
}
